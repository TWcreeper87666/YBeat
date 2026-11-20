/**
 * 節拍格線：從素材的音量包絡（peaks，每秒 PEAKS_PER_SEC 格）估出速度（BPM）與相位，
 * 產生一條規律的節拍格線（每拍一點、每 4 拍一個重拍），再把每一拍微調到附近真正的起音。
 *
 * 規律的格線比「偵測到的每個起音」好用：剪接要的是穩定的拍子，不是每個鼓聲都算一次。
 * 全部是純函式，結果依 peaks 陣列快取。
 */
import type { AudioClip, Clip, Media } from '../store';

export interface Beat {
  /** 素材內秒數（timelineBeats 回傳的是時間軸秒數） */
  t: number;
  /** 這一拍的起音強度 0~1 */
  s: number;
  /** 重拍（每小節第一拍） */
  down: boolean;
}

export interface BeatInfo {
  bpm: number;
  /** 一拍幾秒 */
  period: number;
  beats: Beat[];
}

const MIN_BPM = 70, MAX_BPM = 180;

/** 起音包絡：音量上升的量，減掉附近的平均（只留下突出的起音） */
export function onsetEnvelope(peaks: ArrayLike<number>, pps: number): Float32Array {
  const n = peaks.length;
  const d = new Float32Array(n);
  for (let i = 1; i < n; i++) d[i] = Math.max(0, peaks[i] - peaks[i - 1]);
  const win = Math.max(1, Math.round(pps * 0.25));
  const out = new Float32Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += d[i];
    if (i >= win * 2 + 1) sum -= d[i - win * 2 - 1];
    // 以 i - win 為中心的平均（延遲 win 格寫回）
    const c = i - win;
    if (c >= 0) out[c] = Math.max(0, d[c] - sum / Math.min(i + 1, win * 2 + 1));
  }
  for (let c = Math.max(0, n - win); c < n; c++) out[c] = d[c];
  return out;
}

/** 包絡在小數位置 x（格）的值（線性內插） */
function at(env: Float32Array, x: number) {
  const i = Math.floor(x);
  if (i < 0 || i >= env.length - 1) return i === env.length - 1 ? env[i] : 0;
  const f = x - i;
  return env[i] * (1 - f) + env[i + 1] * f;
}

/** 梳狀加總：從 phase 開始每隔 period 格取一次（附近 ±1 格取最大，容忍一點點不準） */
function comb(env: Float32Array, period: number, phase: number) {
  let s = 0;
  for (let x = phase; x < env.length; x += period) s += Math.max(at(env, x - 1), at(env, x), at(env, x + 1));
  return s;
}

/** 估速度與相位；太安靜 / 太短 = null */
export function estimateBeats(peaks: ArrayLike<number>, pps: number): BeatInfo | null {
  const n = peaks.length;
  if (n < pps * 4) return null;
  const env = onsetEnvelope(peaks, pps);
  let total = 0;
  for (let i = 0; i < n; i++) total += env[i];
  if (total < 1e-3) return null;

  // 1) 自相關找大概的週期（整數格），偏好 120 BPM 附近，避免抓到兩倍 / 一半
  const lo = Math.floor((pps * 60) / MAX_BPM), hi = Math.ceil((pps * 60) / MIN_BPM);
  let best = 0, bestLag = 0;
  for (let L = lo; L <= hi; L++) {
    let s = 0;
    for (let i = L; i < n; i++) s += env[i] * env[i - L];
    const bpm = (pps * 60) / L;
    const w = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.9, 2));
    if (s * w > best) {
      best = s * w;
      bestLag = L;
    }
  }
  if (!bestLag) return null;

  // 2) 細調週期（小數格）與相位：整首歌的梳狀加總最大（整數格的誤差累積下來會漂很多）
  let bp = bestLag, bph = 0, bs = -1;
  for (let p = bestLag - 1.5; p <= bestLag + 1.5; p += 0.02) {
    for (let ph = 0; ph < p; ph += 0.5) {
      const s = comb(env, p, ph);
      if (s > bs) {
        bs = s;
        bp = p;
        bph = ph;
      }
    }
  }

  // 3) 格線：從第一個有聲音的地方開始，每一拍微調到 ±30ms 內最強的起音
  let first = 0;
  let maxPeak = 0;
  for (let i = 0; i < n; i++) maxPeak = Math.max(maxPeak, peaks[i]);
  while (first < n && peaks[first] < maxPeak * 0.05) first++;
  let last = n - 1;
  while (last > first && peaks[last] < maxPeak * 0.05) last--;
  const sorted = Array.from(env).sort((a, b) => a - b);
  const ref = sorted[Math.floor(sorted.length * 0.98)] || 1;
  const snapW = Math.round(pps * 0.03);
  const raw: { x: number; v: number }[] = [];
  // 相位是梳狀加總（±1 格容錯）找的，可能比第一個起音早一點點：往前留 1/4 拍
  let k = Math.ceil((first - bp * 0.25 - bph) / bp);
  for (let x = bph + k * bp; x <= last; x = bph + ++k * bp) {
    let bx = x, bv = at(env, x);
    for (let j = Math.ceil(x - snapW); j <= Math.floor(x + snapW); j++) {
      if (j >= 0 && j < n && env[j] > bv * 1.5 && env[j] > ref * 0.3) {
        bv = env[j];
        bx = j;
      }
    }
    raw.push({ x: bx, v: bv });
  }
  if (!raw.length) return null;

  // 4) 重拍：4 種對齊方式裡，那一拍的強度加總最大的
  let downK = 0, downS = -1;
  for (let o = 0; o < 4; o++) {
    let s = 0;
    for (let i = o; i < raw.length; i += 4) s += raw[i].v;
    if (s > downS) {
      downS = s;
      downK = o;
    }
  }
  return {
    bpm: (pps * 60) / bp,
    period: bp / pps,
    beats: raw.map((b, i) => ({ t: Math.max(0, b.x) / pps, s: Math.min(1, b.v / ref), down: (((i - downK) % 4) + 4) % 4 === 0 })),
  };
}

const cache = new WeakMap<object, BeatInfo | null>();
/** 素材的節拍（依 peaks 快取；沒有 peaks = null） */
export function mediaBeats(m: Media | undefined): BeatInfo | null {
  if (!m?.peaks || m.missing) return null;
  if (cache.has(m.peaks)) return cache.get(m.peaks)!;
  const info = estimateBeats(m.peaks, m.peaksPerSec || 100);
  cache.set(m.peaks, info);
  return info;
}

/** 這個音訊片段有沒有提供節拍（連結在影片上的原音不算；屬性可以關掉） */
export const beatSource = (a: AudioClip, attached: Set<string>) => a.beats !== false && !attached.has(a.id);

/**
 * 時間軸上的節拍：所有提供節拍的音訊片段，素材時間換成時間軸時間（照速率），合併、去掉太近的重複。
 * lead：整體往前移幾秒（畫面要比聲音早一點切換，看起來才會對到拍子；跟威力導演的「節拍提前」一樣）。
 */
export function timelineBeats(s: { audios: AudioClip[]; clips: Clip[]; media: Media[] }, attached: Set<string>, lead = 0): Beat[] {
  const media = new Map(s.media.map((m) => [m.id, m]));
  const out: Beat[] = [];
  for (const a of s.audios) {
    if (!beatSource(a, attached)) continue;
    const info = mediaBeats(media.get(a.mediaId));
    if (!info) continue;
    const rate = a.rate || 1;
    const end = a.in + a.duration * rate;
    for (const b of info.beats) {
      if (b.t < a.in - 1e-6 || b.t >= end) continue;
      const t = a.start + (b.t - a.in) / rate - lead;
      if (t >= 0) out.push({ ...b, t });
    }
  }
  out.sort((x, y) => x.t - y.t);
  const dedup: Beat[] = [];
  for (const b of out) {
    const prev = dedup[dedup.length - 1];
    if (prev && b.t - prev.t < 0.03) {
      if (b.s > prev.s) dedup[dedup.length - 1] = { ...b, down: b.down || prev.down };
    } else dedup.push(b);
  }
  return dedup;
}

/** 第一個 ≥ t 的節拍索引（全部都比較早 = beats.length） */
export function beatIndexAtOrAfter(beats: { t: number }[], t: number): number {
  let lo = 0, hi = beats.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (beats[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** 第 i 拍的時間；超出格線就照最後的拍長往後推（片段可以排到音樂結束之後） */
export function beatTime(beats: { t: number }[], i: number): number {
  if (i < beats.length) return beats[i].t;
  const n = beats.length;
  const period = n >= 2 ? (beats[n - 1].t - beats[Math.max(0, n - 9)].t) / Math.min(8, n - 1) : 0.5;
  return beats[n - 1].t + (i - n + 1) * period;
}

/**
 * 依節拍排片段：從 startBeat 開始，每段佔 every 拍，依序接上。
 * maxDur[i] = 第 i 段最長多長（素材不夠長時就停在素材結尾，下一段從下一拍開始）。
 * 回傳每段的 [start, duration]。
 */
export function layoutOnBeats(beats: { t: number }[], startBeat: number, every: number, maxDur: number[]): [number, number][] {
  const out: [number, number][] = [];
  let b = startBeat;
  for (const max of maxDur) {
    const st = beatTime(beats, b);
    let end = beatTime(beats, b + every);
    let nb = b + every;
    if (end - st > max) {
      end = st + max;
      nb = Math.max(b + 1, beatIndexAtOrAfter(beats, end - 1e-6));
      // 超出格線的部分：用推算的拍點
      while (beatTime(beats, nb) < end - 1e-6) nb++;
    }
    out.push([st, end - st]);
    b = nb;
  }
  return out;
}
