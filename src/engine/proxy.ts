/**
 * 預覽代理檔：關鍵影格很稀（> 1 秒）或解析度很高的影片，在背景產生一份
 * 短邊 540px、每 0.5 秒一個關鍵影格的 H.264 副本，只給時間軸預覽 / 素材預覽用（跳轉快很多）。
 * 匯出、AI 去背、追蹤、素材分析一律用原檔。代理檔存在 IndexedDB（proxy 物件庫），重開專案直接用。
 */
import { create } from 'zustand';
import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import { useStore, type Media } from '../store';
import { usePrefs } from '../prefs';
import { keyframeInfo } from './matteDecode';
import type { ProxyOut } from './proxyWorker';

// 存檔模組用到時才載入（渲染器會 import 這裡；測試環境不能連帶載入專案存檔）
const db = () => import('./project');
const deleteProxyBlob = (id: string) => db().then((d) => d.deleteProxyBlob(id));

const SHORT_SIDE = 540;
const KEY_EVERY = 0.5;
/** 關鍵影格間隔超過這麼久才需要代理檔 */
const MAX_KEY_GAP = 1;

/** 代理檔的網址（素材 id → blob URL）與產生進度（0..1） */
export const useProxy = create<{ urls: Record<string, string>; progress: Record<string, number> }>(() => ({ urls: {}, progress: {} }));

/** 預覽要用的網址：有代理檔（而且設定沒關）就用代理檔 */
export function previewUrl(m: Media): string {
  if (!usePrefs.getState().proxy) return m.url;
  return useProxy.getState().urls[m.id] ?? m.url;
}

/** 這支影片要不要代理檔、用哪種方法產生：拆得開（MP4 / MOV）就看關鍵影格間隔與解析度，交給 Worker；拆不開的格式（MKV…）一律要，用播放器抓畫面 */
async function proxyKind(m: Media): Promise<'worker' | 'play' | null> {
  try {
    const info = await keyframeInfo(m.url);
    return info.maxGap > MAX_KEY_GAP || Math.min(m.width, m.height) > 1080 ? 'worker' : null;
  } catch {
    return 'play';
  }
}

// ───────────── Worker（MP4 / MOV） ─────────────

/** Worker 池：每個 Worker 一次做一支；同時做幾支看 CPU 核心數（軟體解碼 + 軟體編碼吃 CPU，多支同時做總速度跟著變快） */
const PARALLEL = Math.max(1, Math.min(4, Math.floor((navigator.hardwareConcurrency || 4) / 4)));
const idle: Worker[] = [];
const workers: Worker[] = [];
const jobs = new Map<string, { res: (b: Blob | null) => void; prog: (f: number) => void }>();
function takeWorker(): Worker {
  const ready = idle.pop();
  if (ready) return ready;
  const w = new Worker(new URL('./proxyWorker.ts', import.meta.url), { type: 'module' });
  w.onmessage = (e: MessageEvent<ProxyOut>) => {
    const d = e.data;
    const j = jobs.get(d.id);
    if (!j) return;
    if (d.type === 'progress') j.prog(d.f);
    else {
      jobs.delete(d.id);
      if (d.type === 'fail' && d.err !== 'cancelled') console.warn('proxy failed', d.err);
      idle.push(w);
      j.res(d.type === 'done' ? d.blob : null);
    }
  };
  workers.push(w);
  return w;
}
function buildInWorker(m: Media, alive: () => boolean, onProgress: (f: number) => void): Promise<Blob | null> {
  const { w, h } = size(m);
  const worker = takeWorker();
  return new Promise((res) => {
    jobs.set(m.id, { res, prog: onProgress });
    worker.postMessage({ type: 'build', id: m.id, url: m.url, w, h });
    // 素材被移除 / 換檔 / 關掉代理檔：叫 Worker 放棄
    const watch = setInterval(() => {
      if (!jobs.has(m.id)) return clearInterval(watch);
      if (!alive()) { clearInterval(watch); worker.postMessage({ type: 'cancel', id: m.id }); }
    }, 500);
  });
}

function size(m: Media) {
  const k = Math.min(1, SHORT_SIDE / Math.max(1, Math.min(m.width, m.height)));
  const even = (x: number) => Math.max(2, Math.round((x * k) / 2) * 2);
  return { w: even(m.width), h: even(m.height) };
}

async function pickConfig(w: number, h: number, fps: number): Promise<VideoEncoderConfig | null> {
  for (const codec of ['avc1.4d401f', 'avc1.4d4028', 'avc1.42e01f', 'avc1.640028']) {
    // 軟體編碼：這台測試機（Windows）的硬體編碼器只要同時有解碼器在跑，輸出幾格就卡住；540p 軟體編碼也夠快（每秒 100+ 格）
    const c: VideoEncoderConfig = { codec, width: w, height: h, bitrate: 2_500_000, framerate: fps, hardwareAcceleration: 'prefer-software' };
    if ((await VideoEncoder.isConfigSupported(c)).supported) return c;
  }
  return null;
}

/** 拆不開的格式：在主執行緒用播放器抓畫面、編碼（要 <video>，不能放 Worker） */
async function buildByPlay(m: Media, alive: () => boolean, onProgress: (f: number) => void): Promise<Blob | null> {
  if (typeof VideoEncoder === 'undefined') return null;
  const { w, h } = size(m);
  const canvas = new OffscreenCanvas(w, h);
  const g = canvas.getContext('2d')!;
  const target = new ArrayBufferTarget();
  let muxer: Muxer<ArrayBufferTarget> | null = null;
  let enc: VideoEncoder | null = null;
  let encError: Error | null = null;
  let lastKey = -Infinity;
  let fps = 30;
  const setup = async (rate: number) => {
    fps = Math.max(1, Math.min(120, Math.round(rate)));
    const cfg = await pickConfig(w, h, fps);
    if (!cfg) throw new Error('no encoder');
    muxer = new Muxer({ target, video: { codec: 'avc', width: w, height: h, frameRate: fps }, fastStart: 'in-memory', firstTimestampBehavior: 'offset' });
    enc = new VideoEncoder({
      output: (chunk, meta) => {
        try {
          const data = new Uint8Array(chunk.byteLength);
          chunk.copyTo(data);
          const d = chunk.duration && chunk.duration > 0 ? chunk.duration : Math.round(1e6 / fps);
          muxer!.addVideoChunkRaw(data, chunk.type, chunk.timestamp, d, meta);
        } catch (e) {
          encError = e instanceof Error ? e : new Error(String(e));
        }
      },
      error: (e) => (encError = e),
    });
    enc.configure(cfg);
  };
  let first = true;
  const encode = async (pts: number, src: CanvasImageSource, dur: number) => {
    if (first) { first = false; pts = 0; } // MP4 從 0 開始
    g.drawImage(src, 0, 0, w, h);
    const f = new VideoFrame(canvas, { timestamp: Math.round(pts * 1e6), duration: Math.round(dur * 1e6) });
    const key = pts - lastKey >= KEY_EVERY - 1e-3;
    if (key) lastKey = pts;
    enc!.encode(f, { keyFrame: key });
    f.close();
    for (let k = 0; enc!.encodeQueueSize > 30 && !encError && k < 50; k++) await new Promise<void>((r) => { enc!.addEventListener('dequeue', () => r(), { once: true }); setTimeout(r, 20); });
    if (encError) throw encError;
  };
  try {
    await buildByPlayback(m, alive, onProgress, setup, encode);
    if (!alive() || !enc || !muxer) return null;
    await (enc as VideoEncoder).flush();
    if (encError) throw encError;
    (muxer as Muxer<ArrayBufferTarget>).finalize();
    return new Blob([target.buffer], { type: 'video/mp4' });
  } finally {
    const e = enc as VideoEncoder | null;
    if (e && e.state !== 'closed') e.close();
  }
}

type RvfcVideo = HTMLVideoElement & { requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number };

/** 拆不開的格式（MKV…）：用播放器 2 倍速播一遍，每次畫面更新抓一格（60Hz 畫面 ≈ 30 fps 的代理檔） */
async function buildByPlayback(
  m: Media, alive: () => boolean, onProgress: (f: number) => void,
  setup: (fps: number) => Promise<void>, encode: (pts: number, src: CanvasImageSource, dur: number) => Promise<void>,
) {
  const v = document.createElement('video') as RvfcVideo;
  if (!v.requestVideoFrameCallback) throw new Error('no rVFC');
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  v.src = m.url;
  try {
    await new Promise<void>((res, rej) => {
      v.onloadeddata = () => res();
      v.onerror = () => rej(new Error('load failed'));
    });
    await setup(30);
    const dur = v.duration || m.duration;
    let last = -1;
    let busy: Promise<void> = Promise.resolve();
    await new Promise<void>((res, rej) => {
      const tick = (_n: number, meta: { mediaTime: number }) => {
        if (!alive()) return res();
        const t = meta.mediaTime;
        if (t > last + 1e-3) {
          const step = last < 0 ? 1 / 30 : t - last;
          last = t;
          busy = busy.then(() => encode(t, v, step)).catch(rej);
          onProgress(Math.min(1, t / dur));
        }
        if (v.ended) return void busy.then(res, rej);
        v.requestVideoFrameCallback!(tick);
      };
      v.onended = () => void busy.then(res, rej);
      v.requestVideoFrameCallback!(tick);
      v.playbackRate = 2;
      // 被暫停（例如瀏覽器省電）就接著播；素材被移除就放棄
      const watch = setInterval(() => {
        if (!alive()) return (clearInterval(watch), res());
        if (v.paused && !v.ended) void v.play().catch(() => {});
      }, 500);
      void v.play().catch((e) => (clearInterval(watch), rej(e)));
      v.addEventListener('ended', () => clearInterval(watch), { once: true });
    });
    await busy;
  } finally {
    v.pause();
    v.removeAttribute('src');
    v.load();
  }
}

// ───────────── 排程：同時最多 PARALLEL 支 ─────────────

/** 已經判斷過不需要代理檔的素材 */
const skip = new Set<string>();
const running = new Set<string>();

function pump() {
  if (!usePrefs.getState().proxy) return;
  while (running.size < PARALLEL) {
    const s = useStore.getState();
    const urls = useProxy.getState().urls;
    const todo = s.media.filter((m) => m.kind === 'video' && !m.missing && !m.color && !urls[m.id] && !skip.has(m.id) && !running.has(m.id));
    if (!todo.length) return;
    // 時間軸上用到的先做
    const used = new Set(s.clips.map((c) => c.mediaId));
    const next = todo.find((m) => used.has(m.id)) ?? todo[0];
    running.add(next.id);
    void one(next).finally(() => {
      running.delete(next.id);
      setTimeout(pump, 0);
    });
  }
}

async function one(next: Media) {
  const id = next.id, url = next.url;
  const alive = () => useStore.getState().media.some((m) => m.id === id && m.url === url) && usePrefs.getState().proxy;
  const setProg = (f: number | null) => useProxy.setState((p) => {
    const progress = { ...p.progress };
    if (f === null) delete progress[id];
    else progress[id] = f;
    return { progress };
  });
  try {
    // 之前產生過：直接載入
    const saved = await db().then((d) => d.loadProxyBlob(id)).catch(() => undefined);
    if (saved) {
      useProxy.setState((p) => ({ urls: { ...p.urls, [id]: URL.createObjectURL(saved) } }));
      return;
    }
    const kind = await proxyKind(next);
    if (!kind) {
      skip.add(id);
      return;
    }
    setProg(0);
    const blob = kind === 'worker' ? await buildInWorker(next, alive, (f) => setProg(f)) : await buildByPlay(next, alive, (f) => setProg(f));
    if (blob && alive()) {
      await db().then((d) => d.saveProxyBlob(id, blob)).catch(() => {});
      useProxy.setState((p) => ({ urls: { ...p.urls, [id]: URL.createObjectURL(blob) } }));
    } else skip.add(id);
  } catch (e) {
    console.warn('proxy failed', next.name, e);
    skip.add(id);
  } finally {
    setProg(null);
  }
}

/** 素材移除 / 換檔：放掉代理檔 */
function prune() {
  const media = useStore.getState().media;
  const live = new Map(media.map((m) => [m.id, m.url]));
  const { urls } = useProxy.getState();
  let changed = false;
  const next: Record<string, string> = {};
  for (const [id, u] of Object.entries(urls)) {
    if (live.has(id)) next[id] = u;
    else {
      URL.revokeObjectURL(u);
      void deleteProxyBlob(id);
      changed = true;
    }
  }
  if (changed) useProxy.setState({ urls: next });
}

let urlOf = new Map<string, string>();
/** 開始在背景產生 / 載入代理檔（App 啟動時呼叫一次） */
export function startProxies() {
  const check = () => {
    const media = useStore.getState().media;
    // 素材換了檔（重新連結 / 替換）：舊的代理檔作廢
    for (const m of media) {
      const old = urlOf.get(m.id);
      if (old !== undefined && old !== m.url) {
        const u = useProxy.getState().urls[m.id];
        if (u) URL.revokeObjectURL(u);
        useProxy.setState((p) => { const urls = { ...p.urls }; delete urls[m.id]; return { urls }; });
        void deleteProxyBlob(m.id);
        skip.delete(m.id);
      }
    }
    urlOf = new Map(media.map((m) => [m.id, m.url]));
    prune();
    pump();
  };
  useStore.subscribe((s, p) => { if (s.media !== p.media) check(); });
  usePrefs.subscribe((s, p) => { if (s.proxy !== p.proxy) check(); });
  check();
}
