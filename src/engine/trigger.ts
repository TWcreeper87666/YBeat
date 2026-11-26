import type { Clip, Tracks } from '../store';
import { fxLevel } from './tracks';

/**
 * 特效方塊的「觸發」：方塊裡每遇到一個觸發點（節拍 / 剪接點）就從頭再播一次。
 * 渲染時只換掉特效內時間（local）與長度，模組程式碼、關鍵影格都照「從這次觸發開始算」。
 */

/** 每幾拍觸發一次：0.5 = 每半拍、4 = 每小節（以重拍對齊） */
export type BeatEvery = 0.5 | 1 | 2 | 4;
/**
 * cut：tracks = 看哪幾條影片軌的剪接點（沒有 = 這條特效軌下面的所有影片軌）。
 * chance：只在挑中的觸發點播（0..1，沒有 = 每個都播）；seed 決定挑哪些，同一個 seed 每次都挑一樣的。
 * extend：衝擊特效（@hit）不截在 @duration，一路延伸到下一次觸發前。
 * scatter：每次觸發把「中心」類的參數（@follow 的 point）換到隨機位置；值 = 離畫面邊緣的距離（0..0.45），位置也由 seed 決定。
 * hits：手動排的觸發（方塊內時間，已排序、不重疊）；每個 Hit 播多長就是多長，不用 chance / extend。
 */
interface TriggerOpts { chance?: number; seed?: number; extend?: true; scatter?: number }
export type FxTrigger =
  | ({ kind: 'beat'; every: BeatEvery } & TriggerOpts)
  | ({ kind: 'cut'; tracks?: number[] } & TriggerOpts)
  | ({ kind: 'hits'; hits: Hit[] } & TriggerOpts);

/** 換觸發方式時要留下的選項（機率、延伸、隨機位置） */
export function triggerOpts(t?: FxTrigger): TriggerOpts {
  if (!t) return {};
  const { chance, seed, extend, scatter } = t;
  return Object.fromEntries(Object.entries({ chance, seed, extend, scatter }).filter(([, v]) => v !== undefined));
}

/** 新的 seed（第一次設機率 / 隨機位置時給，之後固定） */
export const newSeed = () => (Math.random() * 2 ** 31) >>> 0;

const hash32 = (a: number, b: number) => {
  let h = (Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b, 0xc2b2ae35)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

/** 隨機位置：第 n 次觸發的點（畫面座標 0..1，y 向下），離邊緣至少 margin */
export function scatterPoint(seed: number, n: number, margin: number): [number, number] {
  const m = Math.min(0.5, Math.max(0, margin));
  return [m + (1 - 2 * m) * hash32(seed, n * 2), m + (1 - 2 * m) * hash32(seed, n * 2 + 1)];
}

/** 有設機率（< 1） */
export const hasChance = (t?: FxTrigger): t is FxTrigger & { chance: number } => t?.chance !== undefined && t.chance < 1;

/** 觸發點的雜湊鍵：節拍用拍號（不受節拍提前影響）、剪接點用時間（改了別的片段也不會變） */
const pointKey = (t: FxTrigger, pts: number[], i: number) => (t.kind === 'beat' ? i : Math.round(pts[i] * 1000));

/** 這個觸發點有沒有被挑中（0..1 的雜湊 < chance） */
export function picked(t: FxTrigger, pts: number[], i: number): boolean {
  if (!hasChance(t)) return true;
  return hash32(t.seed ?? 0, pointKey(t, pts, i)) < t.chance;
}

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

/**
 * 有機率的觸發：t 落在哪一次挑中的觸發；沒挑中的觸發點到下一個觸發點之間不作用（null）。
 * 每次最長到下一個原本的觸發點，跳過的點不會讓特效播得比較慢。方塊開頭不算觸發點。
 */
export function chanceWindow(trigger: FxTrigger, pts: number[], start: number, end: number, t: number): { t0: number; d: number } | null {
  const i = lowerBound(pts, t + EPS) - 1;
  if (i < 0 || pts[i] < start - EPS || !picked(trigger, pts, i)) return null;
  const t1 = Math.min(i + 1 < pts.length ? pts[i + 1] : end, end);
  return t < t1 ? { t0: pts[i], d: Math.max(1e-3, t1 - pts[i]) } : null;
}

/**
 * 衝擊特效（@hit）的一次觸發最長播 len 秒（模組的 @duration），播完就停到下一次觸發；
 * 拍子比 len 短就照拍子。不然每拍觸發的 Shake 會一路晃到下一拍、失去衝擊感。
 */
export function hitWindow(w: { t0: number; d: number } | null, t: number, len: number): { t0: number; d: number } | null {
  if (!w || !(len > 0) || w.d <= len) return w;
  return t - w.t0 < len ? { t0: w.t0, d: len } : null;
}

/**
 * 這是方塊裡第幾次觸發（0 起算；shader 的 u_trigger）。t0 = 這次觸發的開始（triggerWindow / chanceWindow 的結果）。
 * 一般觸發：方塊開頭 = 0，之後每個觸發點 +1；有機率：從方塊開頭（含）起算的第幾個觸發點，沒挑中的也算。
 */
export function triggerIndex(trigger: FxTrigger | undefined, pts: number[], start: number, t0: number): number {
  if (hasChance(trigger)) return Math.max(0, lowerBound(pts, t0 - EPS) - lowerBound(pts, start - EPS));
  if (t0 <= start + EPS) return 0;
  return Math.max(0, lowerBound(pts, t0 - EPS) - lowerBound(pts, start + EPS)) + 1;
}

/** 片段特效的第幾次播放（0 起算）；t0 = fxWindow 的結果（片段內時間） */
export function timingIndex(timing: FxTiming | undefined, t0: number, start = 0): number {
  if (!timing) return 0;
  if (timing.kind === 'hits') return timing.hits.filter((h) => h.t < t0 - EPS).length;
  const pts = triggerBeats(timing.every);
  return Math.max(0, lowerBound(pts, start + t0 - EPS) - lowerBound(pts, start - EPS));
}

/**
 * 目前的觸發展開成手動的 Hit（方塊內時間；切到「手動」時用）：每個觸發點一個，長度到下一個觸發點；
 * 衝擊特效（hitLen > 0）最長 hitLen，除非設了延伸。pts = 這個觸發的觸發點（beat / cut）。
 */
export function manualHits(trigger: FxTrigger | undefined, pts: number[], start: number, len: number, hitLen = 0): Hit[] {
  if (!trigger) return [{ t: 0, d: len }];
  if (trigger.kind === 'hits') return trigger.hits;
  const end = start + len;
  const chance = hasChance(trigger);
  const marks = triggerMarks(pts, start, end, trigger);
  if (!chance && !marks.some((m) => Math.abs(m - start) < EPS)) marks.unshift(start);
  const out: Hit[] = [];
  for (const m of marks) {
    const w = chance ? chanceWindow(trigger, pts, start, end, m) : triggerWindow(pts, start, end, m);
    if (!w) continue;
    const d = hitLen > 0 && !trigger.extend ? Math.min(w.d, hitLen) : w.d;
    out.push({ t: Math.max(0, m - start), d: Math.max(HIT_MIN, d) });
  }
  return normalizeHits(out, len);
}

/** 方塊裡所有的觸發點（含開頭；有機率 = 只有挑中的；時間軸上畫細線用） */
export function triggerMarks(pts: number[], start: number, end: number, trigger?: FxTrigger): number[] {
  const out: number[] = [];
  const chance = hasChance(trigger);
  for (let i = lowerBound(pts, (chance ? start - EPS : start + EPS)); i < pts.length && pts[i] < end - EPS; i++) if (!chance || picked(trigger, pts, i)) out.push(pts[i]);
  return out;
}

// ───────────── 片段特效的時間範圍 ─────────────

/** 特效的一次播放（片段內時間，秒） */
export interface Hit { t: number; d: number }

/** 片段特效什麼時候作用（沒有 = 整段） */
export type FxTiming =
  | { kind: 'hits'; hits: Hit[] } // 手動：已排序、不重疊
  | { kind: 'beat'; every: BeatEvery; d: number }; // 自動：片段範圍內每 N 拍播一次

/** Hit 的最短長度 */
export const HIT_MIN = 1 / 30;

/**
 * 這一格特效從哪開始、多長（片段內時間）；null = 不作用（整個特效跳過）。
 * start = 片段在時間軸上的開頭（beat 要把節拍換成片段內時間）。
 */
export function fxWindow(timing: FxTiming | undefined, local: number, len: number, start = 0): { t0: number; d: number } | null {
  if (!timing) return { t0: 0, d: len };
  if (timing.kind === 'hits') {
    const h = timing.hits;
    // 最後一個 t <= local 的 Hit
    let lo = 0, hi = h.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (h[mid].t <= local + EPS) lo = mid + 1;
      else hi = mid;
    }
    const x = h[lo - 1];
    return x && local < x.t + x.d ? { t0: x.t, d: Math.max(1e-3, x.d) } : null;
  }
  const pts = triggerBeats(timing.every);
  const i = lowerBound(pts, start + local + EPS) - 1;
  if (i < 0 || pts[i] < start - EPS) return null;
  const t0 = pts[i] - start;
  return local < t0 + timing.d ? { t0, d: Math.max(1e-3, timing.d) } : null;
}

/** beat 規則展開成片段內的 Hit（轉成手動、屬性面板畫方塊用）；長度不超過下一拍（片段結尾不截：截了最後一次會播得比較快） */
export function beatHits(every: BeatEvery, d: number, start: number, len: number): Hit[] {
  const pts = triggerBeats(every);
  const out: Hit[] = [];
  for (let i = lowerBound(pts, start - EPS); i < pts.length && pts[i] < start + len - EPS; i++) {
    const t = Math.max(0, pts[i] - start);
    const next = i + 1 < pts.length ? pts[i + 1] - start : Infinity;
    out.push({ t, d: Math.max(HIT_MIN, Math.min(d, next - t)) });
  }
  return out;
}

/** 依 t 排序、去掉片段外的，重疊的把前一個截短到下一個開頭（拖曳、貼上後整理用） */
export function normalizeHits(hits: Hit[], len: number): Hit[] {
  const s = hits.map((h) => ({ t: Math.max(0, h.t), d: Math.max(HIT_MIN, h.d) })).filter((h) => h.t < len - EPS).sort((a, b) => a.t - b.t);
  const out: Hit[] = [];
  for (const h of s) {
    const prev = out[out.length - 1];
    if (prev && h.t < prev.t + HIT_MIN) continue; // 跟前一個同一個位置：丟掉
    if (prev && prev.t + prev.d > h.t) prev.d = h.t - prev.t;
    out.push(h);
  }
  return out;
}

/** 在 local 切開：Hit 分到兩段，後段改成從 0 算；跨切點的那個留在前段（長度不變，畫面跟切開前一樣；後段不重播） */
export function splitTiming(timing: FxTiming | undefined, local: number): [FxTiming | undefined, FxTiming | undefined] {
  if (!timing || timing.kind === 'beat') return [timing, timing];
  const a: Hit[] = [], b: Hit[] = [];
  for (const h of timing.hits) {
    if (h.t < local - EPS) a.push(h);
    else b.push({ t: h.t - local, d: h.d });
  }
  return [{ kind: 'hits', hits: a }, { kind: 'hits', hits: b }];
}

/**
 * 加入新的 Hit，跟現有的重疊就覆蓋（跟時間軸的覆蓋一樣）：
 * 被整個蓋住的刪掉、蓋到尾巴的截短、蓋到開頭的從新的結尾開始（結尾不變）、整個包住新的那個拆成前後兩段。
 */
export function overwriteHits(base: Hit[], add: Hit[], len: number): Hit[] {
  let cur = base.map((h) => ({ t: h.t, e: h.t + h.d }));
  const news = add.map((h) => ({ t: Math.max(0, h.t), e: Math.max(0, h.t) + Math.max(HIT_MIN, h.d) })).filter((h) => h.t < len - EPS);
  for (const n of news) {
    const next: { t: number; e: number }[] = [];
    for (const h of cur) {
      if (h.e <= n.t + EPS || h.t >= n.e - EPS) next.push(h); // 沒碰到
      else {
        if (h.t < n.t - EPS) next.push({ t: h.t, e: n.t }); // 前段留下
        if (h.e > n.e + EPS) next.push({ t: n.e, e: h.e }); // 後段留下
      }
    }
    cur = [...next, n];
  }
  return cur
    .filter((h) => h.e - h.t >= HIT_MIN - EPS)
    .sort((a, b) => a.t - b.t)
    .map((h) => ({ t: h.t, d: h.e - h.t }));
}
