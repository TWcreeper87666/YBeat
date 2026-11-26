/**
 * 自訂目標追蹤（VitTrack）：使用者在某一格框住一個東西（錨點），從錨點一格一格往後、往前追。
 * - 多個錨點：每個錨點往後追到下一個錨點；第一個錨點往前追到範圍開頭。
 * - 結果以「一個錨點往一個方向追」為單位（run）存在 IndexedDB，key = 素材 id + 錨點內容 + 方向。
 *   往後追的結果跟追到哪裡停無關，所以加了新的錨點時，其他錨點的結果都直接沿用，只要從新錨點開始追。
 * - 平滑、內插、查詢用 faceTrack.ts 的 smoothTrack / trackAt。
 */
import { create } from 'zustand';
import type { Clip, Media, Module } from '../store';
import type { Anchor } from './follow';
import { decodeRange } from './matteDecode';
import { animFrameAt, animImage, animImageReady, type AnimImage } from './animImage';
import { smoothTrack, trackAt, type TrackPoint } from './faceTrack';
import { clipSource } from './remap';
import { SCORE_THR, fromPx, toPx, type PxBox } from './vitTrack';
import type { TrackReq, TrackRes } from './trackWorker';
import { Need, clipStill, sourceRange } from './jobNeed';

/** 每秒最多追幾格（追蹤要連續：格子太稀，快的東西一格跑太遠就追不到） */
export const TRACK_FPS = 30;
/** 追蹤用的畫面長邊 */
const LONG = 640;
/** 往前追時一次解碼多長（解碼器只能往後解：一段一段解完再倒著跑） */
const BACK_CHUNK = 2;
const STORE_VERSION = 2;
const MODEL_URL = `${import.meta.env.BASE_URL}models/object_tracking_vittrack_2023sep.onnx`;

/** 一個錨點往一個方向追的結果 */
interface Run {
  pts: Map<number, TrackPoint>;
  /** 已經追到哪裡（素材時間；往後 = 最晚、往前 = 最早）；null = 還沒追 */
  reach: number | null;
  /** 追到 reach 時追蹤器的框（畫面像素）：停下來之後從這裡接著追 */
  last: PxBox | null;
  loaded: Promise<void>;
  dirty: boolean;
  track: TrackPoint[] | null;
}
const runs = new Map<string, Run>();

/** 介面用：進度、錯誤（key = trackKey）；ver = 有新結果就 +1 */
export const useBoxTracks = create<{ jobs: Record<string, { done: number; total: number }>; errors: Record<string, string>; ver: number }>(() => ({ jobs: {}, errors: {}, ver: 0 }));
const bump = () => useBoxTracks.setState({ ver: useBoxTracks.getState().ver + 1 });

const slot = (t: number) => Math.round(t * TRACK_FPS);

/** 錨點排序（素材時間） */
export const sortAnchors = (a: Anchor[]) => [...a].sort((x, y) => x.t - y.t);

const hash = (s: string) => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
};
const anchorSig = (a: Anchor) => [a.t.toFixed(3), ...a.box.map((v) => v.toFixed(4))].join(',');

/** 一組錨點的 key（進度 / 錯誤用）：素材 + 錨點內容 */
export function trackKey(mediaId: string, anchors: Anchor[]): string {
  return `${mediaId}|${hash(sortAnchors(anchors).map(anchorSig).join(';'))}`;
}
const runKey = (mediaId: string, a: Anchor, dir: 1 | -1) => `${mediaId}|${hash(anchorSig(a))}|${dir > 0 ? 'f' : 'b'}`;

// ───────────── IndexedDB ─────────────

let dbp: Promise<IDBDatabase> | null = null;
function db() {
  dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open('ybeat-track', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('tracks');
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
    const req = fn(d.transaction('tracks', mode).objectStore('tracks'));
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

function run(key: string): Run {
  let r = runs.get(key);
  if (r) return r;
  const ent: Run = {
    pts: new Map(),
    reach: null,
    last: null,
    dirty: false,
    track: null,
    loaded: idb<{ v: number; reach: number | null; last?: PxBox | null; pts: TrackPoint[] } | undefined>('readonly', (os) => os.get(key))
      .then((rec) => {
        if (!rec) return;
        if (rec.v !== STORE_VERSION) return void idb('readwrite', (os) => os.delete(key)).catch(() => {});
        for (const p of rec.pts) if (!ent.pts.has(slot(p.t))) ent.pts.set(slot(p.t), p);
        ent.reach = rec.reach;
        ent.last = rec.last ?? null;
        ent.track = null;
        bump();
      })
      .catch(() => {}),
  };
  runs.set(key, ent);
  return ent;
}

async function persist(key: string) {
  const r = runs.get(key);
  if (!r?.dirty) return;
  r.dirty = false;
  await idb('readwrite', (os) => os.put({ v: STORE_VERSION, reach: r.reach, last: r.last, pts: [...r.pts.values()] }, key)).catch((err) => console.warn('track save failed', err));
}

/** 素材被刪除 / 替換時清掉這個素材所有的追蹤結果 */
export function dropBoxTracks(mediaId: string) {
  for (const k of [...runs.keys()]) if (k.startsWith(`${mediaId}|`)) runs.delete(k);
  idb('readwrite', (os) => os.delete(IDBKeyRange.bound(`${mediaId}|`, `${mediaId}|￿`))).catch(() => {});
}

// ───────────── Worker ─────────────

let worker: Worker | null = null;
let seq = 0;
const waiting = new Map<number, { res: (r: { box?: PxBox; score?: number }) => void; rej: (e: Error) => void }>();
function call(q: Omit<TrackReq, 'id' | 'modelUrl'>): Promise<{ box?: PxBox; score?: number }> {
  if (!worker) {
    worker = new Worker(new URL('./trackWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<TrackRes>) => {
      const w = waiting.get(e.data.id);
      if (!w) return;
      waiting.delete(e.data.id);
      if ('error' in e.data) w.rej(new Error(e.data.error));
      else w.res(e.data);
    };
  }
  const id = ++seq;
  return new Promise((res, rej) => {
    waiting.set(id, { res, rej });
    worker!.postMessage({ ...q, id, modelUrl: MODEL_URL } as TrackReq, [q.rgba.buffer]);
  });
}

// ───────────── 取得畫面 ─────────────

type Size = { w: number; h: number };
const frameSize = (m: { width: number; height: number }): Size => {
  const k = LONG / Math.max(m.width || 1, m.height || 1);
  return { w: Math.max(16, Math.round((m.width || 1) * k)), h: Math.max(16, Math.round((m.height || 1) * k)) };
};
type OnFrame = (t: number, rgba: Uint8ClampedArray) => Promise<void>;

/**
 * 依序（dir = 1 往後、−1 往前）拿到 from..to 範圍內的畫面（每秒最多 TRACK_FPS 格）。
 * 先直接解碼檔案（MP4），不行就用 <video> 一格一格 seek。
 */
async function walk(media: Media, sz: Size, from: number, to: number, dir: 1 | -1, alive: () => boolean, onFrame: OnFrame) {
  if (media.kind === 'image') {
    const anim = await animImageReady(media);
    if (!anim) return;
    const g = new OffscreenCanvas(sz.w, sz.h).getContext('2d', { willReadFrequently: true })!;
    for (const k of steps(from, to, dir)) {
      if (!alive()) return;
      g.clearRect(0, 0, sz.w, sz.h);
      g.drawImage(animFrameAt(anim, k / TRACK_FPS).image, 0, 0, sz.w, sz.h);
      await onFrame(k / TRACK_FPS, g.getImageData(0, 0, sz.w, sz.h).data);
    }
    return;
  }
  const taken = new Set<number>();
  const once: OnFrame = async (t, rgba) => {
    const k = slot(t);
    if (taken.has(k)) return;
    taken.add(k);
    await onFrame(t, rgba);
  };
  try {
    await decodeWalk(media, sz, from, to, dir, alive, taken, once);
  } catch (err) {
    console.warn('track: WebCodecs decode failed, falling back to seeking', err);
    await seekWalk(media, sz, from, to, dir, alive, taken, once);
  }
}

/** 取樣格（整數，k / TRACK_FPS 秒），依方向排好 */
function steps(from: number, to: number, dir: 1 | -1): number[] {
  const out: number[] = [];
  for (let k = Math.ceil(from * TRACK_FPS - 1e-6); k <= Math.floor(to * TRACK_FPS + 1e-6); k++) out.push(k);
  return dir === 1 ? out : out.reverse();
}

async function decodeWalk(media: Media, sz: Size, from: number, to: number, dir: 1 | -1, alive: () => boolean, taken: Set<number>, onFrame: OnFrame) {
  const base = { url: media.url, size: sz.w, box: { w: sz.w, h: sz.h, dw: sz.w, dh: sz.h }, onInfo: () => {}, alive };
  if (dir === 1) {
    await decodeRange({ ...base, from, to, skip: (pts) => taken.has(slot(pts)), onFrame });
    return;
  }
  // 往前：一段一段解碼存起來，再倒著處理
  let hi = to;
  while (hi > from - 1e-6 && alive()) {
    const lo = Math.max(from, hi - BACK_CHUNK);
    const buf: { t: number; rgba: Uint8ClampedArray }[] = [];
    const seen = new Set<number>();
    await decodeRange({
      ...base,
      from: lo,
      to: hi,
      skip: (pts) => taken.has(slot(pts)) || seen.has(slot(pts)),
      onFrame: async (t, rgba) => {
        seen.add(slot(t));
        buf.push({ t, rgba });
      },
    });
    buf.sort((a, b) => b.t - a.t);
    for (const f of buf) await onFrame(f.t, f.rgba);
    if (lo <= from + 1e-6) break;
    hi = lo - 0.5 / TRACK_FPS;
  }
}

async function seekWalk(media: Media, sz: Size, from: number, to: number, dir: 1 | -1, alive: () => boolean, taken: Set<number>, onFrame: OnFrame) {
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
    const g = new OffscreenCanvas(sz.w, sz.h).getContext('2d', { willReadFrequently: true })!;
    const last = Math.max(0, (v.duration || media.duration || 0) - 0.02);
    for (const k of steps(from, to, dir)) {
      if (!alive()) return;
      if (taken.has(k)) continue;
      const t = Math.min(k / TRACK_FPS, last);
      await new Promise<void>((res) => {
        const done = () => (v.removeEventListener('seeked', done), clearTimeout(timer), res());
        const timer = setTimeout(done, 3000);
        v.addEventListener('seeked', done);
        v.currentTime = t;
      });
      const rv = v as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number };
      if (rv.requestVideoFrameCallback) await new Promise<void>((res) => { const tm = setTimeout(res, 200); rv.requestVideoFrameCallback!(() => (clearTimeout(tm), res())); });
      g.drawImage(v, 0, 0, sz.w, sz.h);
      await onFrame(k / TRACK_FPS, g.getImageData(0, 0, sz.w, sz.h).data);
    }
  } finally {
    v.pause();
    v.removeAttribute('src');
    v.load();
  }
}

// ───────────── 追蹤 ─────────────

/** 錨點分成要追的段落：第一個錨點往前到 lo；每個錨點往後到下一個錨點（最後一個到 hi） */
export function segments(anchors: Anchor[], lo: number, hi: number): { a: Anchor; from: number; to: number; dir: 1 | -1 }[] {
  const as = sortAnchors(anchors);
  const out: { a: Anchor; from: number; to: number; dir: 1 | -1 }[] = [];
  if (!as.length) return out;
  if (lo < as[0].t) out.push({ a: as[0], from: lo, to: as[0].t, dir: -1 });
  as.forEach((a, i) => {
    const end = Math.min(hi, i + 1 < as.length ? as[i + 1].t - 0.5 / TRACK_FPS : hi);
    if (end > a.t && (i + 1 >= as.length || as[i + 1].t > lo)) out.push({ a, from: a.t, to: end, dir: 1 });
  });
  return out;
}

const jobs = new Map<string, { promise: Promise<void>; need: Need }>();
let chain: Promise<void> = Promise.resolve();

function setProgress(key: string, done: number, total: number | null) {
  const j = { ...useBoxTracks.getState().jobs };
  if (total === null) delete j[key];
  else j[key] = { done, total };
  useBoxTracks.setState({ jobs: j });
}

type Seg = ReturnType<typeof segments>[number];
const HALF = 0.5 / TRACK_FPS;
/** 這個 run 已經追到段落的另一端了 */
const covers = (r: Run, g: Seg) => r.reach !== null && (g.dir > 0 ? r.reach >= g.to - HALF : r.reach <= g.from + HALF);

/** live = 還有人需要（沒人需要就停下來，追到哪裡、追蹤器的框都存起來，下次接著追） */
async function runJob(media: Media, anchors: Anchor[], from: number, to: number, live: () => boolean) {
  const key = trackKey(media.id, anchors);
  const todo: { g: Seg; rk: string; r: Run }[] = [];
  for (const g of segments(anchors, from, to)) {
    const rk = runKey(media.id, g.a, g.dir);
    const r = run(rk);
    await r.loaded;
    if (!covers(r, g)) todo.push({ g, rk, r });
  }
  if (!todo.length) return;
  // 進度只算還沒追的部分（接著追的從 reach 開始）
  const left = (x: { g: Seg; r: Run }) => (x.r.reach !== null && x.r.last ? (x.g.dir > 0 ? x.g.to - x.r.reach : x.r.reach - x.g.from) : x.g.to - x.g.from);
  const total = Math.max(1, Math.round(todo.reduce((s, x) => s + Math.max(0, left(x)), 0) * TRACK_FPS));
  const sz = frameSize(media);
  let n = 0;
  setProgress(key, 0, total);
  try {
    for (const { g, rk, r } of todo) {
      const alive = () => runs.get(rk) === r && live();
      let box: PxBox | null = null;
      let from = g.from, to = g.to;
      // 之前停在半路：用錨點那一格重建模板（跟第一次追時用的同一格），再從停下的地方、停下時的框接著追
      if (r.reach !== null && r.last) {
        let got = false;
        const near = 1 / TRACK_FPS;
        await walk(media, sz, g.dir > 0 ? g.a.t : g.a.t - near, g.dir > 0 ? g.a.t + near : g.a.t, g.dir, alive, async (_t, rgba) => {
          if (got) return;
          got = true;
          await call({ op: 'init', tid: rk, rgba, w: sz.w, h: sz.h, box: toPx(g.a.box, sz.w, sz.h) });
        });
        if (!alive()) return void (await persist(rk));
        if (got) {
          box = r.last;
          if (g.dir > 0) from = r.reach + 0.75 / TRACK_FPS;
          else to = r.reach - 0.75 / TRACK_FPS;
        }
      }
      // 從錨點重新追（之前追的比較短：前面的結果一樣，覆蓋過去就好）
      if (!box) r.reach = null;
      if (from <= to) await walk(media, sz, from, to, g.dir, alive, async (t, rgba) => {
        if (!box) {
          // 第一格 = 錨點那一格：做模板，框就是使用者框的
          box = toPx(g.a.box, sz.w, sz.h);
          await call({ op: 'init', tid: rk, rgba, w: sz.w, h: sz.h, box });
          r.pts.set(slot(t), { t: g.a.t, x: g.a.box[0], y: g.a.box[1], w: g.a.box[2], h: g.a.box[3] });
        } else {
          const res = await call({ op: 'update', tid: rk, rgba, w: sz.w, h: sz.h, box });
          // 分數太低 = 這格追丟（框不動、不記錄，之後有可能再追回來）
          if (res.box && (res.score ?? 0) >= SCORE_THR) {
            box = res.box;
            const [x, y, w, h] = fromPx(box, sz.w, sz.h);
            r.pts.set(slot(t), { t: +t.toFixed(4), x, y, w, h });
          } else r.pts.delete(slot(t));
        }
        r.reach = r.reach === null ? t : g.dir > 0 ? Math.max(r.reach, t) : Math.min(r.reach, t);
        r.last = box;
        r.track = null;
        r.dirty = true;
        bump();
        setProgress(key, ++n, Math.max(total, n));
        if (n % 60 === 0) await persist(rk);
      });
      if (!alive()) return void (await persist(rk));
      // 走完了（素材結尾之後沒有畫面也算追到）
      r.reach = g.dir > 0 ? Math.max(r.reach ?? g.to, g.to) : Math.min(r.reach ?? g.from, g.from);
      r.dirty = true;
      bump();
      await persist(rk);
    }
    const errs = { ...useBoxTracks.getState().errors };
    delete errs[key];
    useBoxTracks.setState({ errors: errs });
  } catch (err) {
    console.warn('tracking failed', err);
    useBoxTracks.setState({ errors: { ...useBoxTracks.getState().errors, [key]: String((err as Error)?.message ?? err) } });
  } finally {
    setProgress(key, 0, null);
  }
}

/** 確保素材 from..to 都追過（同一份錨點 / 範圍不重複排） */
export function ensureBoxTrack(media: Media, anchors: Anchor[], from: number, to: number, by?: { id: string; still: () => boolean }): Promise<void> {
  if (!anchors.length || (media.kind === 'image' && !animImage(media))) return Promise.resolve();
  const key = `${trackKey(media.id, anchors)}|${from.toFixed(2)}|${to.toFixed(2)}`;
  const prev = jobs.get(key);
  if (prev) {
    prev.need.add(by?.id, by?.still);
    return prev.promise;
  }
  const need = new Need();
  need.add(by?.id, by?.still);
  const live = () => need.live();
  const promise = (chain = chain.then(async () => {
    if (live()) await runJob(media, anchors, from, to, live);
    // 停下來了：之後再要求（例如復原）要重新排，從停下的地方接著追
    if (!live() && jobs.get(key)?.need === need) jobs.delete(key);
  }));
  jobs.set(key, { promise, need });
  return promise;
}

/** 動態圖片：整段動畫都追；影片：片段用到的範圍 */
function rangeOf(clip: Clip, media: Media, modules: Map<string, Module>) {
  const a = media.kind === 'image' ? animImage(media) : null;
  return a ? { from: 0, to: a.total } : sourceRange(clip, media, modules);
}

/** 預覽：還沒追的範圍 → 背景開始算；失敗過的不自動重試 */
export function requestBoxTrack(clip: Clip, media: Media, anchors: Anchor[], modules: Map<string, Module>) {
  if (media.missing || (media.kind !== 'video' && media.kind !== 'image') || !anchors.length) return;
  if (useBoxTracks.getState().errors[trackKey(media.id, anchors)]) return;
  const r = rangeOf(clip, media, modules);
  const key = trackKey(media.id, anchors);
  const still = clipStill(clip, (c) => c.subject?.kind === 'box' && trackKey(media.id, c.subject.anchors) === key);
  void ensureBoxTrack(media, anchors, r.from, r.to, { id: clip.id, still });
}

/** 匯出前：把片段用到的範圍追完 */
export function prepareBoxTrack(clip: Clip, media: Media, anchors: Anchor[], modules: Map<string, Module>) {
  const r = rangeOf(clip, media, modules);
  return ensureBoxTrack(media, anchors, r.from, r.to);
}

/** 重試：清掉錯誤再排一次 */
export function retryBoxTrack(clip: Clip, media: Media, anchors: Anchor[], modules: Map<string, Module>) {
  const key = trackKey(media.id, anchors);
  const errs = { ...useBoxTracks.getState().errors };
  delete errs[key];
  useBoxTracks.setState({ errors: errs });
  for (const k of [...jobs.keys()]) if (k.startsWith(`${key}|`)) jobs.delete(k);
  requestBoxTrack(clip, media, anchors, modules);
}

/** 素材時間 t 落在哪個段落（錨點範圍外的往前 / 往後延伸） */
function segAt(media: Media, anchors: Anchor[], t: number): { g: Seg; r: Run } | null {
  const segs = segments(anchors, -Infinity, Infinity);
  const g = segs.find((x) => t >= x.from - HALF && t <= x.to + HALF);
  return g ? { g, r: run(runKey(media.id, g.a, g.dir)) } : null;
}

/** 素材時間：動態圖片依動畫長度循環 */
function mediaTime(media: Media, t: number): number {
  const a = media.kind === 'image' ? animImage(media) : null;
  return a ? loopTime(a, t) : t;
}

/**
 * 素材時間 t 的目標框（素材畫面 0..1）；還沒追到 / 追丟 = null。
 * 靜態圖片：最後一個錨點的框；動態圖片依動畫長度循環。
 */
export function boxAt(media: Media, anchors: Anchor[], t: number): TrackPoint | null {
  if (!anchors.length) return null;
  if (media.kind === 'image' && !animImage(media)) {
    const b = sortAnchors(anchors).at(-1)!.box;
    return { t, x: b[0], y: b[1], w: b[2], h: b[3] };
  }
  t = mediaTime(media, t);
  const s = segAt(media, anchors, t);
  if (!s || s.r.reach === null) return null;
  // 還沒追到的地方不要拿最後一格頂著
  if (s.g.dir > 0 ? t > s.r.reach + HALF : t < s.r.reach - HALF) return null;
  s.r.track ??= smoothTrack([...s.r.pts.values()].sort((p, q) => p.t - q.t), 0.04);
  return trackAt(s.r.track, t);
}

/** 一個錨點往一個方向追到的點（還沒平滑、照時間排；還沒載入 = 空，載入後 ver 會變） */
export function runPoints(mediaId: string, a: Anchor, dir: 1 | -1): TrackPoint[] {
  return [...run(runKey(mediaId, a, dir)).pts.values()].sort((p, q) => p.t - q.t);
}

/** 素材時間 t 追過了沒（不管有沒有追到目標）：時間軸進度條用 */
export function boxDone(media: Media, anchors: Anchor[], t: number): boolean {
  if (!anchors.length) return false;
  if (media.kind === 'image' && !animImage(media)) return true;
  t = mediaTime(media, t);
  const s = segAt(media, anchors, t);
  if (!s || s.r.reach === null) return false;
  return s.g.dir > 0 ? t <= s.r.reach + HALF && t >= s.g.from - HALF : t >= s.r.reach - HALF && t <= s.g.to + HALF;
}

/** 片段每一段追過了沒（n 格，1 = 好了） */
export function boxCoverage(clip: Clip, media: Media, anchors: Anchor[], modules: Map<string, Module>, n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    const local = ((k + 0.5) / n) * clip.duration;
    out[k] = boxDone(media, anchors, media.kind === 'image' ? local : clipSource(clip, local, media, modules).src) ? 1 : 0;
  }
  return out;
}

function loopTime(a: AnimImage, t: number) {
  const x = ((t % a.total) + a.total) % a.total;
  return Math.min(x, Math.floor(a.total * TRACK_FPS - 1e-6) / TRACK_FPS);
}
