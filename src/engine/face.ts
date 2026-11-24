/**
 * 臉部偵測（YuNet）：每個素材在背景每秒取樣 SAMPLE_FPS 格，結果存在 IndexedDB（不進專案檔）。
 * 查詢時挑出要跟的那張臉、平滑、內插（faceTrack.ts）。
 */
import { create } from 'zustand';
import type { Clip, Media, Module } from '../store';
import { decodeRange } from './matteDecode';
import { animFrameAt, animImage, animImageReady, type AnimImage } from './animImage';
import { bridgeTrack, findGaps, padBox, pickTrack, smoothTrack, trackAt, type Face, type FaceSample, type Gap, type TrackPoint } from './faceTrack';
import type { FaceReq, FaceRes } from './faceWorker';
import { Need, clipStill, sourceRange } from './jobNeed';
import { TRACK_FPS, ensureBoxTrack, runPoints, trackKey, useBoxTracks } from './boxTrack';
import type { Anchor } from './follow';

/** 每秒取樣幾格（臉的移動是平滑的，中間內插） */
export const SAMPLE_FPS = 10;
/** 模型的輸入固定是 640 × 640：素材保持比例畫在左上角（長邊 640），其他補黑 */
const INPUT = 640;
const STORE_VERSION = 1;
const MODEL_URL = `${import.meta.env.BASE_URL}models/face_detection_yunet_2023mar.onnx`;

interface Entry {
  /** 取樣格（round(t × SAMPLE_FPS)）→ 那一格偵測到的臉 */
  samples: Map<number, FaceSample>;
  loaded: Promise<void>;
  dirty: boolean;
  /** 平滑後的軌跡（samples、補的點變了就重算） */
  track: TrackPoint[] | null;
  /** 臉追丟的空洞，用 VitTrack 補（key = 方向 + 起點；結果在 boxTrack 的快取，這裡只記要補哪些） */
  bridges: Map<string, Gap>;
}
const cache = new Map<string, Entry>();

/** 介面用：計算進度、錯誤；ver = 有新的偵測結果就 +1 */
export const useFaces = create<{ jobs: Record<string, { done: number; total: number }>; errors: Record<string, string>; ver: number }>(() => ({ jobs: {}, errors: {}, ver: 0 }));
const bump = () => useFaces.setState({ ver: useFaces.getState().ver + 1 });

// 補空洞的追蹤有新結果：有補空洞的素材軌跡要重算
useBoxTracks.subscribe((s, p) => {
  if (s.ver === p.ver) return;
  let any = false;
  for (const e of cache.values()) if (e.bridges.size) (e.track = null), (any = true);
  if (any) bump();
});

// ───────────── IndexedDB ─────────────

let dbp: Promise<IDBDatabase> | null = null;
function db() {
  dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open('ybeat-face', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('tracks');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function idb<T>(mode: IDBTransactionMode, fn: (os: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((res, rej) => {
    const req = fn(d.transaction('tracks', mode).objectStore('tracks'));
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

function entry(mediaId: string): Entry {
  let e = cache.get(mediaId);
  if (e) return e;
  const ent: Entry = {
    samples: new Map(),
    dirty: false,
    track: null,
    bridges: new Map(),
    loaded: idb<{ v: number; samples: FaceSample[] } | undefined>('readonly', (os) => os.get(mediaId))
      .then((rec) => {
        if (!rec) return;
        if (rec.v !== STORE_VERSION) return void idb('readwrite', (os) => os.delete(mediaId)).catch(() => {});
        for (const s of rec.samples) if (!ent.samples.has(slot(s.t))) ent.samples.set(slot(s.t), s);
        ent.track = null;
        bump();
      })
      .catch(() => {}),
  };
  cache.set(mediaId, ent);
  return ent;
}

const slot = (t: number) => Math.round(t * SAMPLE_FPS);

async function persist(mediaId: string) {
  const e = cache.get(mediaId);
  if (!e?.dirty) return;
  e.dirty = false;
  await idb('readwrite', (os) => os.put({ v: STORE_VERSION, samples: [...e.samples.values()] }, mediaId)).catch((err) => console.warn('face save failed', err));
}

/** 素材被刪除 / 替換時清掉 */
export function dropFaces(mediaId: string) {
  cache.delete(mediaId);
  idb('readwrite', (os) => os.delete(mediaId)).catch(() => {});
}

// ───────────── Worker ─────────────

let worker: Worker | null = null;
let seq = 0;
const waiting = new Map<number, { res: (f: Face[]) => void; rej: (e: Error) => void }>();
function infer(rgba: Uint8ClampedArray, inW: number, inH: number, imgW: number, imgH: number): Promise<Face[]> {
  if (!worker) {
    worker = new Worker(new URL('./faceWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<FaceRes>) => {
      const w = waiting.get(e.data.id);
      if (!w) return;
      waiting.delete(e.data.id);
      if ('error' in e.data) w.rej(new Error(e.data.error));
      else w.res(e.data.faces);
    };
  }
  const id = ++seq;
  return new Promise((res, rej) => {
    waiting.set(id, { res, rej });
    worker!.postMessage({ id, rgba, inW, inH, imgW, imgH, modelUrl: MODEL_URL } satisfies FaceReq, [rgba.buffer]);
  });
}

/** 單張畫面偵測臉（不進快取；自動剪輯分析素材時找有人的畫面用）；w × h = 畫面大小 */
export function detectFaces(src: CanvasImageSource, w: number, h: number): Promise<Face[]> {
  const box = inputBox(w, h);
  const g = new OffscreenCanvas(box.w, box.h).getContext('2d', { willReadFrequently: true })!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, box.w, box.h);
  g.drawImage(src, 0, 0, box.dw, box.dh);
  return infer(g.getImageData(0, 0, box.w, box.h).data, box.w, box.h, box.dw, box.dh);
}

/** 偵測用的畫布：INPUT × INPUT，素材保持比例畫在左上角 dw × dh */
export function inputBox(w: number, h: number) {
  const k = INPUT / Math.max(w || 1, h || 1);
  return { w: INPUT, h: INPUT, dw: Math.max(1, Math.round((w || 1) * k)), dh: Math.max(1, Math.round((h || 1) * k)) };
}

// ───────────── 工作佇列（一次一個素材） ─────────────

const jobs = new Map<string, { promise: Promise<void>; need: Need }>();
let chain: Promise<void> = Promise.resolve();

function setProgress(mediaId: string, done: number, total: number | null) {
  const j = { ...useFaces.getState().jobs };
  if (total === null) delete j[mediaId];
  else j[mediaId] = { done, total };
  useFaces.setState({ jobs: j });
}

function add(e: Entry, t: number, faces: Face[]) {
  e.samples.set(slot(t), { t: +t.toFixed(4), faces });
  e.track = null;
  e.dirty = true;
  bump();
}

/** live = 還有人需要（沒人需要就停下來，已經算好的存起來） */
async function runJob(media: Media, from: number, to: number, live: () => boolean) {
  const e = entry(media.id);
  await e.loaded;
  const box = inputBox(media.width, media.height);
  try {
    if (media.kind === 'image') {
      const g = new OffscreenCanvas(box.w, box.h).getContext('2d', { willReadFrequently: true })!;
      const grab = (src: CanvasImageSource) => {
        g.fillStyle = '#000';
        g.fillRect(0, 0, box.w, box.h);
        g.drawImage(src, 0, 0, box.dw, box.dh);
        return g.getImageData(0, 0, box.w, box.h).data;
      };
      const anim = await animImageReady(media);
      if (anim) {
        // 動態圖片（GIF…）：整段動畫每秒取樣 SAMPLE_FPS 格（時間 = 動畫內時間，查詢時會循環）
        const todo: number[] = [];
        for (let k = 0; k / SAMPLE_FPS < anim.total; k++) if (!e.samples.has(k)) todo.push(k);
        setProgress(media.id, 0, todo.length);
        let n = 0;
        for (const k of todo) {
          if (!cache.has(media.id) || !live()) break;
          add(e, k / SAMPLE_FPS, await infer(grab(animFrameAt(anim, k / SAMPLE_FPS).image), box.w, box.h, box.dw, box.dh));
          setProgress(media.id, ++n, todo.length);
        }
      } else {
        if (e.samples.has(0)) return;
        setProgress(media.id, 0, 1);
        const img = new Image();
        img.src = media.url;
        await img.decode();
        add(e, 0, await infer(grab(img), box.w, box.h, box.dw, box.dh));
      }
    } else if (media.kind === 'video') {
      // 優先直接解碼檔案（快、不受分頁在不在前景影響）；只支援 MP4，其他格式（WebM…）改用 <video> 一格一格 seek
      try {
        await decodeVideo(media, e, box, from, to, live);
      } catch (err) {
        console.warn('face: WebCodecs decode failed, falling back to seeking', err);
        await seekVideo(media, e, box, from, to, live);
      }
    } else return;
    await persist(media.id);
    const errs = { ...useFaces.getState().errors };
    delete errs[media.id];
    useFaces.setState({ errors: errs });
  } catch (err) {
    console.warn('face detection failed', err);
    useFaces.setState({ errors: { ...useFaces.getState().errors, [media.id]: String((err as Error)?.message ?? err) } });
  } finally {
    setProgress(media.id, 0, null);
  }
}

type Box = ReturnType<typeof inputBox>;

async function decodeVideo(media: Media, e: Entry, box: Box, from: number, to: number, live: () => boolean) {
  let n = 0, total = 0;
  // 已經算過的取樣格、這次已經拿到的格子都跳過（同一個取樣格只算第一格）
  const taken = new Set<number>();
  await decodeRange({
    url: media.url,
    from,
    to,
    size: box.w,
    box,
    skip: (pts) => e.samples.has(slot(pts)) || taken.has(slot(pts)),
    onInfo: (info) => {
      total = Math.max(1, Math.ceil(Math.min(info.total, (to - from) * SAMPLE_FPS + 1)));
      setProgress(media.id, 0, total);
    },
    onFrame: async (pts, rgba) => {
      const k = slot(pts);
      if (taken.has(k) || e.samples.has(k)) return;
      taken.add(k);
      add(e, pts, await infer(rgba, box.w, box.h, box.dw, box.dh));
      setProgress(media.id, ++n, Math.max(total, n));
      if (n % 50 === 0) await persist(media.id);
    },
    alive: () => cache.has(media.id) && live(),
  });
}

/** 備用：<video> seek 到每個取樣時間（臉的位置不用精確到哪一格，seek 完畫面換好就拿） */
async function seekVideo(media: Media, e: Entry, box: Box, from: number, to: number, live: () => boolean) {
  const todo: number[] = [];
  for (let k = Math.ceil(from * SAMPLE_FPS); k / SAMPLE_FPS <= to + 1e-6; k++) if (!e.samples.has(k)) todo.push(k);
  if (!todo.length) return;
  const v = document.createElement('video');
  v.muted = true;
  v.preload = 'auto';
  v.playsInline = true;
  v.src = media.url;
  try {
    await new Promise<void>((res, rej) => {
      const timer = setTimeout(() => rej(new Error('video load timeout')), 20000);
      v.onloadeddata = () => (clearTimeout(timer), res());
      v.onerror = () => (clearTimeout(timer), rej(new Error('video load failed')));
    });
    const g = new OffscreenCanvas(box.w, box.h).getContext('2d', { willReadFrequently: true })!;
    const last = Math.max(0, (v.duration || media.duration || 0) - 0.05);
    setProgress(media.id, 0, todo.length);
    let n = 0;
    for (const k of todo) {
      if (!cache.has(media.id) || !live()) return;
      const t = Math.min(k / SAMPLE_FPS, last);
      await new Promise<void>((res) => {
        const done = () => (v.removeEventListener('seeked', done), clearTimeout(timer), res());
        const timer = setTimeout(done, 3000);
        v.addEventListener('seeked', done);
        v.currentTime = t;
      });
      // seeked 之後畫面不一定已經換好：有 rVFC 就等下一次繪製（最多 200ms）
      const rv = v as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number };
      if (rv.requestVideoFrameCallback) await new Promise<void>((res) => { const tm = setTimeout(res, 200); rv.requestVideoFrameCallback!(() => (clearTimeout(tm), res())); });
      g.fillStyle = '#000';
      g.fillRect(0, 0, box.w, box.h);
      g.drawImage(v, 0, 0, box.dw, box.dh);
      add(e, k / SAMPLE_FPS, await infer(g.getImageData(0, 0, box.w, box.h).data, box.w, box.h, box.dw, box.dh));
      setProgress(media.id, ++n, todo.length);
      if (n % 50 === 0) await persist(media.id);
    }
  } finally {
    v.pause();
    v.removeAttribute('src');
    v.load();
  }
}

/** 確保素材 from..to（素材時間）的臉都偵測過（已經在算的同一段會接著等） */
export function ensureFaces(media: Media, from: number, to: number, by?: { id: string; still: () => boolean }): Promise<void> {
  const key = `${media.id}|${from.toFixed(2)}|${to.toFixed(2)}`;
  const prev = jobs.get(key);
  if (prev) {
    prev.need.add(by?.id, by?.still);
    return prev.promise;
  }
  const need = new Need();
  need.add(by?.id, by?.still);
  const live = () => need.live();
  const promise = (chain = chain.then(async () => {
    if (live()) await runJob(media, from, to, live);
    if (live() && media.kind === 'video') await bridgeGaps(media, from, to, live);
    // 停下來了：之後再要求（例如復原）要重新排，接著算還沒好的格子
    if (!live() && jobs.get(key)?.need === need) jobs.delete(key);
  }));
  jobs.set(key, { promise, need });
  return promise;
}

/** 空洞給 VitTrack 的錨點：追蹤從那張臉（放大到含整個頭）開始 */
const gapAnchor = (g: Gap): Anchor => ({ t: g.seed.t, box: padBox(g.seed) });
const gapKey = (g: Gap) => `${g.dir}|${g.seed.t.toFixed(4)}`;

/**
 * 側臉、低頭、背對鏡頭時 YuNet 抓不到臉：from..to 裡的空洞從旁邊那張臉開始用 VitTrack 追過去補起來。
 * 追蹤結果存在 boxTrack 的快取（run），進度顯示在臉部追蹤的進度上。
 */
async function bridgeGaps(media: Media, from: number, to: number, live: () => boolean) {
  const e = entry(media.id);
  const gaps = findGaps(pickTrack([...e.samples.values()]), from, to);
  if (!gaps.length) return;
  for (const g of gaps) e.bridges.set(gapKey(g), g);
  e.track = null;
  bump();
  const len = (g: Gap) => Math.round((g.to - g.from) * TRACK_FPS);
  const total = Math.max(1, gaps.reduce((s, g) => s + len(g), 0));
  let base = 0;
  try {
    for (const g of gaps) {
      if (!cache.has(media.id) || !live()) return;
      const a = gapAnchor(g);
      const k = trackKey(media.id, [a]);
      const off = useBoxTracks.subscribe((s) => {
        const j = s.jobs[k];
        if (j) setProgress(media.id, Math.min(total, base + j.done), total);
      });
      try {
        await ensureBoxTrack(media, [a], g.from, g.to, { id: `face|${media.id}`, still: live });
      } finally {
        off();
      }
      base += len(g);
    }
  } finally {
    setProgress(media.id, 0, null);
  }
}

/** 片段實際用到的素材時間範圍 */
export const faceRange = sourceRange;

/** 預覽：這個片段用到的素材範圍還沒偵測 → 背景開始算（同一個範圍不重複排） */
export function requestFaces(clip: Clip, media: Media, modules: Map<string, Module>) {
  if (media.missing || (media.kind !== 'video' && media.kind !== 'image')) return;
  if (useFaces.getState().errors[media.id]) return;
  const r = faceRange(clip, media, modules);
  void ensureFaces(media, r.from, r.to, { id: clip.id, still: clipStill(clip, (c) => c.subject?.kind === 'face') });
}

/**
 * 素材時間 t 要跟的那張臉（素材畫面 0..1）；還沒偵測 / 沒有臉 = null。
 * 圖片：t 是片段內時間；動態圖片依動畫長度循環，靜態圖片一律是那一張。
 */
export function faceAt(media: Media, t: number): TrackPoint | null {
  const e = entry(media.id);
  if (!e.samples.size) return null;
  if (!e.track) {
    const picked = pickTrack([...e.samples.values()]);
    const bridges = [...e.bridges.values()].map((g) => ({ gap: g, pts: runPoints(media.id, gapAnchor(g), g.dir) }));
    e.track = smoothTrack(bridges.length ? bridgeTrack(picked, bridges) : picked);
  }
  if (media.kind === 'image') {
    const a = animImage(media);
    return trackAt(e.track, a ? frameTime(a, t) : 0);
  }
  return trackAt(e.track, t);
}

/** 動態圖片：片段內時間 → 動畫內時間（循環；對到那一格的取樣，免得跨過循環點時內插到別的格子） */
function frameTime(a: AnimImage, t: number) {
  const x = ((t % a.total) + a.total) % a.total;
  return Math.min(x, Math.floor(a.total * SAMPLE_FPS - 1e-6) / SAMPLE_FPS);
}

/** 素材時間 t 偵測過了沒（不管有沒有臉）：時間軸進度條用 */
export function faceDone(media: Media, t: number): boolean {
  const e = entry(media.id);
  if (media.kind === 'image') {
    const a = animImage(media);
    return e.samples.has(a ? slot(frameTime(a, t)) : 0);
  }
  return e.samples.has(slot(t));
}
