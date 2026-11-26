/**
 * 倒播 / 極慢速預覽的影格快取：<video> 往回 seek 很慢（每次都要從關鍵影格重新解碼），
 * 所以把會倒播的那一小段素材先用 WebCodecs 解成小張影格放在記憶體，預覽時直接拿。
 * 只給預覽用（匯出照舊精準 seek，畫質不受影響）。全部影片共用一個上限，最久沒用的先丟。
 */
import type { Media } from '../store';
import { decodeFrames } from './matteDecode';

/** 快取影格的高度上限（預覽畫面不大，夠用就好；倒播的那一下看不出差別） */
const MAX_H = 360;
/** 全部影片合計最多用多少記憶體（每個鏡頭都倒播時要放得下很多段） */
const MAX_BYTES = 420 * 1024 * 1024;
/** 同時解幾段（太多段一起解，每段都來不及；照要求的順序，近的先） */
const PARALLEL = 2;

interface Frame { pts: number; bm: ImageBitmap; used: number; bytes: number }
interface Entry { frames: Frame[]; fps: number; done: [number, number][]; jobs: Map<string, Promise<void>> }
const cache = new Map<string, Entry>();
let tick = 0;
let total = 0;
let running = 0;
const queue: (() => void)[] = [];
/** 排隊：輪到了才開始解 */
function slot<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((res, rej) => {
    const go = () => {
      running++;
      fn().then(res, rej).finally(() => { running--; queue.shift()?.(); });
    };
    if (running < PARALLEL) go();
    else queue.push(go);
  });
}

const entry = (id: string) => {
  let e = cache.get(id);
  if (!e) cache.set(id, (e = { frames: [], fps: 30, done: [], jobs: new Map() }));
  return e;
};

/** 超過上限：丟掉最久沒用的影格 */
function evict() {
  if (total <= MAX_BYTES) return;
  const all: { e: Entry; f: Frame }[] = [];
  for (const e of cache.values()) for (const f of e.frames) all.push({ e, f });
  all.sort((a, b) => a.f.used - b.f.used);
  for (const { e, f } of all) {
    if (total <= MAX_BYTES) break;
    f.bm.close();
    e.frames.splice(e.frames.indexOf(f), 1);
    // 這一段不完整了，下次要重解
    e.done = e.done.filter(([a, b]) => !(f.pts >= a && f.pts <= b));
    total -= f.bytes;
  }
}

/** 素材時間 src 附近的快取影格（半格以內）；沒有 = null */
export function reverseFrameAt(media: Media, src: number): { pts: number; bm: ImageBitmap } | null {
  const e = cache.get(media.id);
  if (!e || !e.frames.length) return null;
  const fs = e.frames;
  let lo = 0, hi = fs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (fs[mid].pts < src) lo = mid + 1;
    else hi = mid;
  }
  const near = [fs[lo - 1], fs[lo]].filter(Boolean).sort((a, b) => Math.abs(a.pts - src) - Math.abs(b.pts - src))[0];
  if (!near || Math.abs(near.pts - src) > 0.75 / e.fps) return null;
  near.used = ++tick;
  return near;
}

/** 確保 a..b（素材秒數）都在快取裡；已經有 / 正在解就不重複 */
export function ensureReverseFrames(media: Media, a: number, b: number): Promise<void> {
  const e = entry(media.id);
  if (e.done.some(([x, y]) => x <= a + 1e-3 && y >= b - 1e-3)) {
    // 還會用到：標成最近用過，超過上限時先丟別的（不然還沒播到的影格會先被丟，播到時只好退回 <video>）
    const t = ++tick;
    for (const f of e.frames) if (f.pts >= a - 0.05 && f.pts <= b + 0.05) f.used = t;
    return Promise.resolve();
  }
  const key = `${a.toFixed(2)}-${b.toFixed(2)}`;
  const running = e.jobs.get(key);
  if (running) return running;
  const scale = Math.min(1, MAX_H / Math.max(1, media.height || MAX_H));
  const w = Math.max(2, Math.round((media.width || 16) * scale)), h = Math.max(2, Math.round((media.height || 9) * scale));
  const pending: Promise<void>[] = [];
  const job = slot(() => decodeFrames({
    url: media.url, from: a, to: b, alive: () => cache.get(media.id) === e,
    onFrame: (pts, frame) => {
      // WebGL 對 ImageBitmap 不套 UNPACK_FLIP_Y（會上下顛倒）：跟 scrubCache 一樣先翻好
      pending.push(createImageBitmap(frame, { resizeWidth: w, resizeHeight: h, resizeQuality: 'medium', imageOrientation: 'flipY' }).then((bm) => {
        if (e.frames.some((f) => Math.abs(f.pts - pts) < 1e-4)) return bm.close();
        // 依時間插入：解碼途中預覽就會來查（二分搜尋），陣列要一直保持排序
        let i = e.frames.length;
        while (i > 0 && e.frames[i - 1].pts > pts) i--;
        e.frames.splice(i, 0, { pts, bm, used: ++tick, bytes: w * h * 4 });
        total += w * h * 4;
      }).finally(() => frame.close()));
    },
  })).then(async (fps) => {
    await Promise.all(pending);
    e.fps = fps;
    e.done.push([a, b]);
    evict();
  }).catch(() => {
    // 解不了（不支援的編碼等）：預覽照舊用 <video> seek
  }).finally(() => e.jobs.delete(key));
  e.jobs.set(key, job);
  return job;
}

/** 素材換掉 / 刪除時清掉（目前只在測試與重新整理時用到） */
export function clearReverseFrames(id?: string) {
  for (const [k, e] of cache) {
    if (id && k !== id) continue;
    for (const f of e.frames) f.bm.close();
    total -= e.frames.reduce((s, f) => s + f.bytes, 0);
    cache.delete(k);
  }
}
