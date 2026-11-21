import type { Clip, Tracks } from '../store';
import { fxLevel } from './tracks';

/**
 * 特效方塊的「觸發」：方塊裡每遇到一個觸發點（節拍 / 剪接點）就從頭再播一次。
 * 渲染時只換掉特效內時間（local）與長度，模組程式碼、關鍵影格都照「從這次觸發開始算」。
 */

/** 每幾拍觸發一次：0.5 = 每半拍、4 = 每小節（以重拍對齊） */
export type BeatEvery = 0.5 | 1 | 2 | 4;
/** cut：tracks = 看哪幾條影片軌的剪接點（沒有 = 這條特效軌下面的所有影片軌） */
export type FxTrigger = { kind: 'beat'; every: BeatEvery } | { kind: 'cut'; tracks?: number[] };

/** 剪接點觸發看哪幾條影片軌 */
export function cutTracks(fx: { track: number; trigger?: FxTrigger }, tracks: Tracks): number[] {
  if (fx.trigger?.kind === 'cut' && fx.trigger.tracks) return fx.trigger.tracks.filter((i) => i < tracks.video.length);
  const lv = fxLevel(tracks, fx.track);
  return tracks.video.map((_, i) => i).filter((i) => i < lv);
}

/** 這幾條影片軌的剪接點（片段開頭；adjacent = 只算前面緊貼著片段的），排序過 */
export function cutPoints(clips: Clip[], idx: number[], adjacent = false): number[] {
  const set = new Set<number>();
  for (const i of idx) {
    const list = clips.filter((c) => c.track === i);
    for (const c of list) if (!adjacent || list.some((p) => p !== c && Math.abs(p.start + p.duration - c.start) <= 0.01)) set.add(c.start);
  }
  return [...set].sort((a, b) => a - b);
}

/** 節拍時間的來源（UI 那邊依專案的音訊算好，含「節拍提前」）；引擎不直接碰 UI 的設定 */
let beatSource: (every: BeatEvery) => number[] = () => [];
export function setBeatSource(fn: (every: BeatEvery) => number[]) {
  beatSource = fn;
}
export const triggerBeats = (every: BeatEvery) => beatSource(every);

/** 已排序的時間點裡，第一個 >= t 的位置 */
function lowerBound(pts: number[], t: number) {
  let lo = 0, hi = pts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pts[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const EPS = 1e-4;

/**
 * 方塊 [start, end) 裡，時間 t 落在哪一次觸發：回傳這次觸發的開始與長度（到下一次觸發或方塊結尾）。
 * 方塊開頭本身一定是一次觸發。pts 要排序過。
 */
export function triggerWindow(pts: number[], start: number, end: number, t: number): { t0: number; d: number } {
  // t 之前（含）最後一個觸發點
  const i = lowerBound(pts, t + EPS) - 1;
  const t0 = i >= 0 && pts[i] > start + EPS ? pts[i] : start;
  const j = lowerBound(pts, t0 + EPS);
  const t1 = j < pts.length && pts[j] < end - EPS ? pts[j] : end;
  return { t0, d: Math.max(1e-3, t1 - t0) };
}

/** 方塊裡所有的觸發點（含開頭；時間軸上畫細線用） */
export function triggerMarks(pts: number[], start: number, end: number): number[] {
  const out: number[] = [];
  for (let i = lowerBound(pts, start + EPS); i < pts.length && pts[i] < end - EPS; i++) out.push(pts[i]);
  return out;
}
