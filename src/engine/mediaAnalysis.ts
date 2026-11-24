/** RGBA 轉成 0..1 灰階。 */
export function grayOf(rgba: ArrayLike<number>, w: number, h: number): Float32Array {
  const gray = new Float32Array(w * h);
  for (let i = 0; i < gray.length; i++) {
    const p = i * 4;
    gray[i] = (0.2126 * rgba[p] + 0.7152 * rgba[p + 1] + 0.0722 * rgba[p + 2]) / 255;
  }
  return gray;
}

export function frameStats(gray: Float32Array, w: number, h: number, prev?: Float32Array): { luma: number; sharp: number; diff: number } {
  const n = Math.min(gray.length, w * h);
  if (!n) return { luma: 0, sharp: 0, diff: 0 };
  let luma = 0, diff = 0;
  for (let i = 0; i < n; i++) {
    luma += gray[i];
    if (prev && i < prev.length) diff += Math.abs(gray[i] - prev[i]);
  }
  let sum = 0, sumSq = 0, count = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const lap = gray[i - 1] + gray[i + 1] + gray[i - w] + gray[i + w] - 4 * gray[i];
    sum += lap;
    sumSq += lap * lap;
    count++;
  }
  return { luma: luma / n, sharp: count ? Math.max(0, sumSq / count - (sum / count) ** 2) : 0, diff: prev ? diff / n : 0 };
}

export interface FrameSample { t: number; luma: number; sharp: number; diff: number }
/** 一格畫面裡最大的那張臉（素材畫面 0..1：中心、高度） */
export interface FaceBox { x: number; y: number; h: number }
/**
 * people：每個取樣點畫面裡有沒有人（0..1，臉越大越高）；faces：那一格最大的臉（沒有 = null）。
 * 沒偵測 = 沒有這兩個欄位。
 */
export interface MediaInfo { step: number; duration: number; motion: number[]; quality: number[]; cuts: number[]; people?: number[]; faces?: (FaceBox | null)[] }

/** 最大的那張臉 */
export function bestFace(faces: { x: number; y: number; h: number }[]): FaceBox | null {
  let best: FaceBox | null = null;
  for (const f of faces) if (!best || f.h > best.h) best = { x: f.x, y: f.y, h: f.h };
  return best;
}

/** t0..t1 裡臉的平均位置與大小（只算有臉的格；範圍裡沒有取樣點 = 最近那格）；沒有臉 = null */
export function faceIn(info: MediaInfo, t0: number, t1: number): FaceBox | null {
  const f = info.faces;
  if (!f?.length) return null;
  let x = 0, y = 0, h = 0, n = 0, any = false;
  for (let i = 0; i < f.length; i++) {
    const t = i * info.step;
    if (t < t0 || t >= t1) continue;
    any = true;
    const b = f[i];
    if (b) { x += b.x; y += b.y; h += b.h; n++; }
  }
  if (!any) return f[Math.min(f.length - 1, Math.max(0, Math.round((t0 + t1) / (2 * info.step))))] ?? null;
  return n ? { x: x / n, y: y / n, h: h / n } : null;
}

/** 一格畫面的「有人」分數：最大那張臉的高度佔畫面 25% 以上 = 1 */
export function peopleScore(faces: { h: number }[]): number {
  return clamp01(Math.max(0, ...faces.map((f) => f.h)) / 0.25);
}

/** t0..t1 平均有多少人（沒偵測 = 0） */
export function peopleIn(info: MediaInfo, t0: number, t1: number): number {
  const p = info.people;
  if (!p?.length) return 0;
  let sum = 0, n = 0;
  for (let i = 0; i < p.length; i++) {
    const t = i * info.step;
    if (t >= t0 && t < t1) { sum += p[i]; n++; }
  }
  return n ? sum / n : p[Math.min(p.length - 1, Math.max(0, Math.round((t0 + t1) / (2 * info.step))))];
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const median = (values: number[]): number => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return (sorted[(sorted.length - 1) >> 1] + sorted[sorted.length >> 1]) / 2;
};

export function analyzeSamples(samples: FrameSample[], duration: number): MediaInfo {
  const gaps = samples.slice(1).map((s, i) => s.t - samples[i].t).filter((gap) => gap > 0);
  const step = median(gaps) || duration || 1;
  const sharps = samples.map((s) => Math.max(0, s.sharp)).sort((a, b) => a - b);
  const p90 = sharps.length ? sharps[Math.ceil(sharps.length * 0.9) - 1] : 0;
  const cuts: number[] = [];
  const motion = samples.map((s) => clamp01(s.diff / 0.08));
  for (let i = 0; i < samples.length; i++) {
    const before = samples.slice(Math.max(0, i - 3), i).map((s) => s.diff);
    const after = samples.slice(i + 1, i + 4).map((s) => s.diff);
    if (samples[i].diff > 0.18 && samples[i].diff > 4 * Math.max(median(before), median(after))) {
      cuts.push(samples[i].t);
    }
  }
  for (const cut of cuts) {
    const i = samples.findIndex((s) => s.t === cut);
    motion[i] = ((motion[i - 1] ?? 0) + (motion[i + 1] ?? 0)) / 2;
  }
  const quality = samples.map((s) => {
    const exposure = clamp01(Math.min(s.luma / 0.1, (1 - s.luma) / 0.08));
    const clarity = p90 > 0 ? 0.25 + 0.75 * clamp01(s.sharp / p90) : 1;
    return exposure * clarity;
  });
  return { step, duration, motion, quality, cuts };
}

function windowScore(info: MediaInfo, t0: number, t1: number, wantMotion: number, checkCuts: boolean): number {
  if (checkCuts && info.cuts.some((cut) => t0 < cut + 0.1 && t1 > cut - 0.1)) return -Infinity;
  let quality = 0, motion = 0, count = 0;
  for (let i = 0; i < info.quality.length; i++) {
    const t = i * info.step;
    if (t >= t0 && t < t1) {
      quality += info.quality[i];
      motion += info.motion[i] ?? 0;
      count++;
    }
  }
  if (!count && info.quality.length) {
    const i = Math.min(info.quality.length - 1, Math.max(0, Math.round((t0 + t1) / (2 * info.step))));
    quality = info.quality[i];
    motion = info.motion[i] ?? 0;
    count = 1;
  }
  // 盡量挑有人的畫面
  return (count ? quality / count : 0) - Math.abs((count ? motion / count : 0) - wantMotion) * 0.6 + peopleIn(info, t0, t1) * PEOPLE_BONUS;
}

/** 有人的畫面加分（品質 0..1、亮點 +0.5） */
export const PEOPLE_BONUS = 0.6;

export function scoreWindow(info: MediaInfo, t0: number, t1: number, wantMotion: number): number {
  return windowScore(info, t0, t1, wantMotion, true);
}

export function bestIn(info: MediaInfo, dur: number, wantMotion: number, avoid: { t0: number; t1: number }[], rng: () => number, highlights: number[] = []): number {
  if (dur >= info.duration) return 0;
  const latest = Math.max(0, info.duration - dur);
  const stride = info.step > 0 ? info.step / 2 : latest || 1;
  const candidates: number[] = [];
  for (let t = 0; t < latest; t += stride) candidates.push(t);
  candidates.push(latest);
  const rank = (ignoreCuts: boolean): { t: number; score: number } => {
    let best = { t: 0, score: -Infinity };
    for (const t of candidates) {
      const base = windowScore(info, t, t + dur, wantMotion, !ignoreCuts);
      if (base === -Infinity) continue;
      const overlap = avoid.reduce((sum, region) => sum + Math.max(0, Math.min(t + dur, region.t1) - Math.max(t, region.t0)), 0);
      const highlight = highlights.some((point) => point >= t && point < t + dur) ? 0.5 : 0;
      const score = base - Math.min(1, overlap / dur) + highlight + rng() * 0.15;
      if (score > best.score) best = { t, score };
    }
    return best;
  };
  const first = rank(false);
  return first.score === -Infinity ? rank(true).t : first.t;
}
