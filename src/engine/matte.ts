/**
 * AI 去背（U²-Netp）：每個素材預先逐格算好遮罩並快取（記憶體 + IndexedDB），
 * 預覽 / 匯出時直接拿最接近的那一格。推論在 matteWorker.ts 裡跑。
 */
import { create } from 'zustand';
import { useStore, type AnimItem, type Clip, type Media, type Module } from '../store';
import { clipSource } from './remap';
import type { MatteReq, MatteRes } from './matteWorker';
import { hasKeyIn, insertKey, pickFrame, snapFps, toKey } from './matteIndex';
import { decodeRange } from './matteDecode';
import { Need, clipStill } from './jobNeed';
import { animImage, animImageReady, frameIndexAt } from './animImage';

export const MATTE_SIZE = 320;
/** 偵測不到影片影格率時的預設 */
const FALLBACK_FPS = 30;
/**
 * IndexedDB 存檔格式版本：舊版資料直接丟掉重算。
 * v5：每一格都算（v3 的 60fps 影片隔格算，播放時一半的格子遮罩慢一格）；
 *     影格率改用 seek 量（v4 用播放量，頁面忙時 60fps 會被量成 30fps）。
 * v6：不再用猜的時間戳記當 key、也不會把前一格誤認成這一格（v5 在有 B 幀的影片上約一成的格子標錯 / 漏掉）。
 * v7：影格率改取最接近的常見值（v6 會把 30 當成 29.97、24 當成 23.976，後段一直對不到格子而卡住）。
 *     v6 的遮罩本身是對的（key 是實際的時間戳記），保留下來，只重新量影格率。
 */
const STORE_VERSION = 7;
const MODEL_URL = `${import.meta.env.BASE_URL}models/u2netp.onnx`;

/**
 * 遮罩用那一格實際的時間戳記當 key（matteIndex.ts 的 toKey），keys 保持排序。
 * fps / step 只用來決定要去抓哪些時間點（隔格算）與查詢時的容許範圍。圖片只有 key 0。
 */
interface Entry {
  frames: Map<number, Uint8Array>;
  keys: number[];
  loaded: Promise<void>;
  dirty: boolean;
  fps: number | null;
  /** 格子的起點（秒，第一格的時間戳記除以一格長度的餘數） */
  off: number;
  /** 存檔的影格率可能是舊版量錯的：下次算的時候重新量 */
  redetect: boolean;
  step: number;
}
const cache = new Map<string, Entry>();

/** 介面用：每個素材的計算進度 */
/** ver：遮罩影格有增加就 +1（時間軸的進度條依它重算哪些地方已經好了） */
export const useMatte = create<{ jobs: Record<string, { done: number; total: number }>; errors: Record<string, string>; ep: string; ver: number }>(() => ({ jobs: {}, errors: {}, ep: '', ver: 0 }));
const bump = () => useMatte.setState({ ver: useMatte.getState().ver + 1 });

// ───────────── IndexedDB ─────────────

let dbp: Promise<IDBDatabase> | null = null;
function db() {
  dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open('ybeat-matte', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('frames');
    r.onsuccess = () => {
      const d = r.result;
      // 清除所有資料要刪掉這個資料庫：讓出連線
      d.onversionchange = () => { d.close(); dbp = null; };
      res(d);
    };
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function idb<T>(mode: IDBTransactionMode, fn: (os: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((res, rej) => {
    const req = fn(d.transaction('frames', mode).objectStore('frames'));
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

function entry(mediaId: string): Entry {
  let e = cache.get(mediaId);
  if (!e) {
    const frames = new Map<number, Uint8Array>();
    const keys: number[] = [];
    const ent: Entry = {
      frames,
      keys,
      dirty: false,
      fps: null,
      off: 0,
      redetect: false,
      step: 1,
      loaded: idb<{ v?: number; fps?: number; off?: number; step?: number; idx: number[]; data: Blob } | undefined>('readonly', (os) => os.get(mediaId))
        .then(async (rec) => {
          if (!rec) return;
          const keep = rec.v === STORE_VERSION || rec.v === 6;
          if (!keep || !rec.fps) {
            idb('readwrite', (os) => os.delete(mediaId)).catch(() => {});
            return;
          }
          ent.fps = rec.fps;
          ent.redetect = rec.v !== STORE_VERSION;
          ent.off = rec.off ?? 0;
          ent.step = rec.step ?? 1;
          const buf = new Uint8Array(await rec.data.arrayBuffer());
          const n = MATTE_SIZE * MATTE_SIZE;
          rec.idx.forEach((i, k) => {
            if (frames.has(i)) return;
            frames.set(i, buf.slice(k * n, (k + 1) * n));
            insertKey(keys, i);
          });
          bump();
        })
        .catch(() => {}),
    };
    e = ent;
    cache.set(mediaId, e);
  }
  return e;
}

async function persist(mediaId: string) {
  const e = cache.get(mediaId);
  if (!e || !e.dirty) return;
  e.dirty = false;
  const idx = [...e.frames.keys()].sort((a, b) => a - b);
  const data = new Blob(idx.map((i) => e.frames.get(i)! as BlobPart));
  await idb('readwrite', (os) => os.put({ v: STORE_VERSION, fps: e.fps, off: e.off, step: e.step, idx, data }, mediaId)).catch((err) => console.warn('matte save failed', err));
}

/** 示範圖（素材庫試看用，不在專案裡）：直接給遮罩，不跑模型、不存檔 */
export function seedMatte(mediaId: string, data: Uint8Array) {
  const e = entry(mediaId);
  if (e.frames.has(0)) return;
  e.frames.set(0, data);
  insertKey(e.keys, 0);
  bump();
}

/** 素材被刪除 / 替換時清掉快取 */
export function dropMatte(mediaId: string) {
  cache.delete(mediaId);
  idb('readwrite', (os) => os.delete(mediaId)).catch(() => {});
}

// ───────────── Worker ─────────────

let worker: Worker | null = null;
let seq = 0;
const waiting = new Map<number, { res: (m: Uint8Array) => void; rej: (e: Error) => void }>();
function infer(rgba: Uint8ClampedArray): Promise<Uint8Array> {
  if (!worker) {
    worker = new Worker(new URL('./matteWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<MatteRes>) => {
      const w = waiting.get(e.data.id);
      if (!w) return;
      waiting.delete(e.data.id);
      if ('error' in e.data) w.rej(new Error(e.data.error));
      else {
        if (useMatte.getState().ep !== e.data.ep) useMatte.setState({ ep: e.data.ep });
        w.res(e.data.mask);
      }
    };
  }
  const id = ++seq;
  return new Promise((res, rej) => {
    waiting.set(id, { res, rej });
    worker!.postMessage({ id, rgba, modelUrl: MODEL_URL } satisfies MatteReq, [rgba.buffer]);
  });
}

// ───────────── 取影格 ─────────────

const canvas = () => {
  const c = new OffscreenCanvas(MATTE_SIZE, MATTE_SIZE);
  return c.getContext('2d', { willReadFrequently: true })!;
};
function grab(g: OffscreenCanvasRenderingContext2D, src: CanvasImageSource) {
  g.clearRect(0, 0, MATTE_SIZE, MATTE_SIZE);
  // 跟 rembg 一樣直接拉成正方形（不保持比例），遮罩畫回去時再拉回原比例
  g.drawImage(src, 0, 0, MATTE_SIZE, MATTE_SIZE);
  return g.getImageData(0, 0, MATTE_SIZE, MATTE_SIZE).data;
}

type RVFCVideo = HTMLVideoElement & { requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number };

/**
 * 等畫面真的換成 seek 的那一格（seek 完成後 drawImage 有時還是舊的那格）。
 * accept：時間戳記不對的（seek 之前就在排隊的舊影格）不算，繼續等下一格。逾時 = null（不要用猜的）。
 */
function nextFrame(v: RVFCVideo, timeout: number, accept: (mt: number) => boolean): Promise<number | null> {
  if (!v.requestVideoFrameCallback) return Promise.resolve(null);
  return new Promise((res) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      res(null);
    }, timeout);
    const cb = (_: number, meta: { mediaTime: number }) => {
      if (done) return;
      if (!accept(meta.mediaTime)) {
        v.requestVideoFrameCallback!(cb);
        return;
      }
      done = true;
      clearTimeout(timer);
      res(meta.mediaTime);
    };
    v.requestVideoFrameCallback!(cb);
  });
}

/**
 * seek 到 t，等畫面真的換好；回傳那一格的時間戳記（等不到 = null）。
 * t 對準某一格的正中間時，那一格的時間戳記在 t 前面不到一格；前一格（差 1.5 格）不收，
 * 不然 seek 還沒換好就會把舊畫面當成這一格（有 B 幀的影片 seek 比較慢，很常發生）。
 */
async function seek(v: RVFCVideo, t: number, frameDur: number): Promise<number | null> {
  const frame = nextFrame(v, 1200, (mt) => mt <= t + 0.002 && t - mt < frameDur * 0.95);
  await new Promise<void>((res) => {
    const done = () => {
      v.removeEventListener('seeked', done);
      clearTimeout(timer);
      res();
    };
    const timer = setTimeout(done, 5000);
    v.addEventListener('seeked', done);
    v.currentTime = t;
  });
  return frame;
}

/**
 * 量影格率與格子的起點（第一格不一定在 0 秒）：
 * seek 到某處拿到那一格的時間戳記 p1，再 seek 到 p1 前一點點拿到前一格 p0，p1 − p0 就是一格的長度。
 * 不用播放來量：頁面忙的時候播放會掉格，60fps 會被量成 30fps。量不到就用預設。
 */
async function detectFps(v: RVFCVideo, duration: number): Promise<{ fps: number; off: number }> {
  if (!v.requestVideoFrameCallback) return { fps: FALLBACK_FPS, off: 0 };
  const LOOSE = 0.3; // 還不知道一格多長：先用寬鬆的容許範圍
  const gaps: number[] = [];
  const pts: number[] = [];
  for (const f of [0.3, 0.5, 0.7]) {
    const p = Math.max(0.05, duration * f);
    const p1 = await seek(v, p, LOOSE);
    if (p1 === null || p1 < 0.002) continue;
    const p0 = await seek(v, p1 - 0.0005, LOOSE);
    if (p0 === null || p0 >= p1) continue;
    gaps.push(p1 - p0);
    pts.push(p1, p0);
  }
  if (!gaps.length) return { fps: FALLBACK_FPS, off: 0 };
  const raw = 1 / Math.min(...gaps);
  const fps = snapFps(raw);
  // 格子起點 = 實際影格時間戳記除以一格長度的餘數（取中位數）
  const fd = 1 / fps;
  const rems = pts.map((t) => ((t % fd) + fd) % fd).sort((a, b) => a - b);
  let off = rems[Math.floor(rems.length / 2)] ?? 0;
  if (off > fd * 0.9) off = 0;
  return { fps, off };
}

// ───────────── 工作佇列（一次只跑一個素材） ─────────────

interface Job { mediaId: string; idx: number[]; promise: Promise<void>; need: Need }
const jobs = new Map<string, Job>();
let chain: Promise<void> = Promise.resolve();

function setProgress(mediaId: string, done: number, total: number | null) {
  const j = { ...useMatte.getState().jobs };
  if (total === null) delete j[mediaId];
  else j[mediaId] = { done, total };
  useMatte.setState({ jobs: j });
}

/** 算完：存檔、清掉錯誤狀態 */
async function finish(mediaId: string) {
  const e = cache.get(mediaId);
  if (e) e.dirty = true;
  await persist(mediaId);
  const errs = { ...useMatte.getState().errors };
  delete errs[mediaId];
  useMatte.setState({ errors: errs });
}

/** 用 WebCodecs 依序解碼片段用到的範圍，每一格推論一次（已經有的跳過） */
async function runDecode(media: Media, e: Entry, times: number[], live: () => boolean) {
  let from = Infinity, to = -Infinity;
  for (const t of times) {
    if (t < from) from = t;
    if (t > to) to = t;
  }
  let n = 0, total = 0;
  await decodeRange({
    url: media.url,
    from,
    to,
    size: MATTE_SIZE,
    skip: (pts) => hasKeyIn(e.keys, toKey(pts) - 10, toKey(pts) + 11),
    onInfo: (info) => {
      e.fps = snapFps(info.fps);
      e.off = 0;
      e.step = 1;
      e.redetect = false;
      total = info.total;
      if (total) setProgress(media.id, 0, total);
    },
    onFrame: async (pts, rgba) => {
      const key = toKey(pts);
      if (!e.frames.has(key)) {
        e.frames.set(key, await infer(rgba));
        insertKey(e.keys, key);
        e.dirty = true;
        bump();
      }
      setProgress(media.id, ++n, total);
      if (n % 48 === 0) await persist(media.id);
    },
    alive: () => cache.has(media.id) && live(),
  });
}

/** live = 還有人需要（沒人需要就停下來，已經算好的存起來） */
async function runJob(media: Media, times: number[], live: () => boolean) {
  const e = entry(media.id);
  if (media.kind !== 'image' && media.kind !== 'video') return;
  // 動態圖片（GIF…）：每一格各算一張（key = 第幾格）；靜態圖片只有第 0 格
  const anim = media.kind === 'image' ? await animImageReady(media) : null;
  if (media.kind === 'image' && (anim ? anim.frames : [0]).every((_, i) => e.frames.has(i))) return;
  const g = canvas();
  let v: RVFCVideo | null = null;
  try {
    if (media.kind === 'image' && anim) {
      const n = anim.frames.length;
      for (let i = 0; i < n; i++) {
        if (!live()) break;
        setProgress(media.id, i, n);
        if (e.frames.has(i)) continue;
        e.frames.set(i, await infer(grab(g, anim.frames[i])));
        insertKey(e.keys, i);
        e.dirty = true;
        bump();
        if (i % 24 === 23) await persist(media.id);
      }
    } else if (media.kind === 'image') {
      setProgress(media.id, 0, 1);
      const img = new Image();
      img.src = media.url;
      await img.decode();
      e.frames.set(0, await infer(grab(g, img)));
      insertKey(e.keys, 0);
      bump();
    } else {
      // 優先：直接解碼影片檔（不受頁面在不在前景影響、時間戳記是檔案裡的實際值）
      let decoded = false;
      try {
        await runDecode(media, e, times, live);
        decoded = true;
      } catch (err) {
        console.warn('matte: WebCodecs decode failed, falling back to seeking', err);
      }
      if (decoded) return finish(media.id);
      const vid: RVFCVideo = document.createElement('video');
      v = vid;
      vid.muted = true;
      vid.preload = 'auto';
      vid.playsInline = true;
      vid.src = media.url;
      await new Promise<void>((res, rej) => {
        const timer = setTimeout(() => rej(new Error('video load timeout')), 20000);
        vid.onloadeddata = () => {
          clearTimeout(timer);
          res();
        };
        vid.onerror = () => {
          clearTimeout(timer);
          rej(new Error('video load failed'));
        };
      });
      if (!e.fps || e.redetect) {
        e.redetect = false;
        const d = await detectFps(vid, media.duration || 1);
        e.fps = d.fps;
        e.off = d.off;
        e.step = 1; // 每一格都算：隔格算的話播放時一半的格子遮罩會慢一格
      }
      const fps = e.fps, step = e.step;
      // 第一格的時間戳記不一定是 0（例如 0.02 秒）：格子從那裡開始對齊，seek 才會落在每格的正中間
      const off = e.off;
      const noRvfc = !vid.requestVideoFrameCallback;
      // 要抓的格子（照片段內時間的順序、去掉重複；隔格算的對齊到 step）
      const cells: number[] = [];
      const seen = new Set<number>();
      for (const t of times) {
        let k = Math.max(0, Math.floor((t - off) * fps + 1e-3));
        k -= k % step;
        if (seen.has(k)) continue;
        seen.add(k);
        cells.push(k);
      }
      const missing = () => cells.filter((k) => !hasKeyIn(e.keys, toKey(off + k / fps) - 10, toKey(off + (k + step) / fps) - 10));
      let todo = missing();
      if (!todo.length) return;
      const total = todo.length;
      setProgress(media.id, 0, total);
      const last = Math.max(0, (media.duration || 0) - 0.5 / fps);
      let n = 0;
      // 第一輪全部跑；沒抓到的格子（seek 逾時）再補一輪
      for (let pass = 0; pass < 2 && todo.length; pass++) {
        for (const k of todo) {
          if (!cache.has(media.id)) return; // 中途被清掉
          if (!live()) return void (await persist(media.id)); // 沒人需要了
          // 對準這一格的正中間，再用畫面真正出來的那一格的時間戳記當 key
          const target = Math.min(off + (k + 0.5) / fps, last);
          let pts = await seek(vid, target, 1 / fps);
          if (pts === null && !noRvfc) pts = await seek(vid, Math.min(target + 0.1 / fps, last), 1 / fps);
          // 瀏覽器完全不支援 rVFC 才用推算的時間；有支援但等不到 = 這格先跳過，下一輪再補（寧可沒有也不要標錯）
          const at = pts ?? (noRvfc ? off + k / fps : null);
          if (at !== null) {
            const key = toKey(at);
            if (!e.frames.has(key)) {
              e.frames.set(key, await infer(grab(g, vid)));
              insertKey(e.keys, key);
              e.dirty = true;
              bump();
            }
          }
          if (pass === 0) setProgress(media.id, ++n, total);
          if (n % 48 === 0) await persist(media.id);
        }
        todo = missing();
      }
    }
    await finish(media.id);
  } catch (err) {
    console.warn('matte failed', err);
    useMatte.setState({ errors: { ...useMatte.getState().errors, [media.id]: String((err as Error)?.message ?? err) } });
  } finally {
    if (v) {
      v.pause();
      v.removeAttribute('src');
      v.load();
    }
    setProgress(media.id, 0, null);
  }
}

/** 這個片段會用到的素材時間（照片段內時間的順序，每秒取 60 點；實際算哪幾格等知道影格率再決定） */
export function matteFrames(clip: Clip, media: Media, modules: Map<string, Module>): number[] {
  if (media.kind === 'image') return [0];
  const out: number[] = [];
  const steps = Math.max(2, Math.ceil(clip.duration * 60));
  for (let k = 0; k <= steps; k++) out.push(+clipSource(clip, (k / steps) * clip.duration, media, modules).src.toFixed(4));
  return out;
}

/** 確保這些時間點的遮罩都算好了（已經在算的會接著等） */
export function ensureMatte(media: Media, times: number[], by?: { id: string; still: () => boolean }): Promise<void> {
  const e = entry(media.id);
  const prev = jobs.get(media.id);
  const key = times.join(',');
  if (prev && prev.idx.join(',') === key) {
    prev.need.add(by?.id, by?.still);
    return prev.promise;
  }
  const need = new Need();
  need.add(by?.id, by?.still);
  const live = () => need.live();
  const promise = (chain = chain.then(async () => {
    await e.loaded;
    if (live()) await runJob(media, times, live);
    // 停下來了（片段刪掉 / 修剪 / 關掉）：之後再要求（例如復原）要重新排，接著算還沒好的格子
    if (!live()) for (const [k, v] of requested) if (v.startsWith(`${media.id}|`)) requested.delete(k);
  }));
  const job = { mediaId: media.id, idx: times, promise, need };
  jobs.set(media.id, job);
  promise.finally(() => jobs.get(media.id) === job && jobs.delete(media.id));
  return promise;
}

/**
 * 預覽 / 匯出：t = 畫面上那一格的素材時間（播放中是 rVFC 給的時間戳記，暫停 / 匯出是 seek 的時間）→ 那一格的遮罩。
 * 規則跟瀏覽器選畫面一樣：時間戳記 ≤ t 的最後一格（matteIndex.ts 的 pickFrame）。
 */
export function matteAt(media: Media, t: number): { idx: number; data: Uint8Array } | null {
  const e = entry(media.id);
  if (media.kind === 'image') {
    // 動態圖片：照時間找第幾格（跟畫面同一個算法，會循環）
    const a = animImage(media);
    const idx = a ? frameIndexAt(a.starts, a.total, t) : 0;
    const d = e.frames.get(idx);
    return d ? { idx, data: d } : null;
  }
  if (!e.fps) return null;
  const k = pickFrame(e.keys, t, 1 / e.fps, e.step);
  if (k === null) return null;
  return { idx: k, data: e.frames.get(k)! };
}

/** 匯出前：所有開了 AI 去背的片段都要算完 */
export async function prepareMattes(clips: Clip[], media: Map<string, Media>, modules: Map<string, Module>) {
  for (const c of clips) {
    if (!c.aiMatte) continue;
    const m = media.get(c.mediaId);
    if (!m || m.missing || (m.kind !== 'video' && m.kind !== 'image')) continue;
    await ensureMatte(m, matteFrames(c, m, modules));
  }
}

/** 匯出前：動畫要用到的那幾格（去背的圖片位置、拿來當遮罩輪廓的）先算好遮罩 */
export async function prepareAnimMattes(anims: AnimItem[], media: Map<string, Media>) {
  for (const a of anims) {
    const masks = new Set(a.layers.flatMap((l) => (l.mask ? [l.mask.slotId] : [])));
    for (const s of a.slots) {
      if (!s.mediaId || (s.cutout?.mode !== 'auto' && !masks.has(s.id))) continue;
      const m = media.get(s.mediaId);
      if (!m || m.missing || (m.kind !== 'video' && m.kind !== 'image')) continue;
      await ensureMatte(m, [m.kind === 'image' ? 0 : +s.sourceTime.toFixed(4)]);
    }
  }
}

/** 預覽：片段開了 AI 去背但遮罩還沒好 → 背景開始算（片段範圍 / 速度沒變就不重複排） */
const requested = new Map<string, string>();
export function requestMatte(clip: Clip, media: Media, modules: Map<string, Module>) {
  const key = `${media.id}|${clip.in}|${clip.duration}|${clip.rate}|${JSON.stringify(clip.remap)}`;
  if (requested.get(clip.id) === key) return;
  requested.set(clip.id, key);
  // 動畫的圖層（id = anim:<動畫>:<圖片位置>:<圖層>）不在時間軸上：只用那一格（定格），動畫還用著這張就繼續算
  if (clip.id.startsWith('anim:')) {
    const [, animId, slotId] = clip.id.split(':');
    const still = () => !!useStore.getState().anims.find((a) => a.id === animId)?.slots.some((s) => s.id === slotId && s.mediaId === media.id && Math.abs(s.sourceTime - clip.in) < 1e-6);
    void ensureMatte(media, [media.kind === 'image' ? 0 : +clip.in.toFixed(4)], { id: clip.id, still });
    return;
  }
  void ensureMatte(media, matteFrames(clip, media, modules), { id: clip.id, still: clipStill(clip, (c) => !!c.aiMatte) });
}

/**
 * 片段每一段的遮罩好了沒（跟預覽用同一個查法：matteAt，含 ±3 格的容許）。
 * 回傳 n 格，1 = 這段播放時已經有遮罩。
 */
export function matteCoverage(clip: Clip, media: Media, modules: Map<string, Module>, n: number): Uint8Array {
  const out = new Uint8Array(n);
  if (media.kind === 'image') {
    // 動態圖片：片段內時間 = 圖片的時間（循環）
    if (!animImage(media)) return out.fill(matteAt(media, 0) ? 1 : 0);
    for (let k = 0; k < n; k++) out[k] = matteAt(media, ((k + 0.5) / n) * clip.duration) ? 1 : 0;
    return out;
  }
  for (let k = 0; k < n; k++) {
    const { src } = clipSource(clip, ((k + 0.5) / n) * clip.duration, media, modules);
    out[k] = matteAt(media, src) ? 1 : 0;
  }
  return out;
}
