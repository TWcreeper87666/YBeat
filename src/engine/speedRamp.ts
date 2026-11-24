export type SpeedVariant = 'beatPulse' | 'hitRamp' | 'drift' | 'holdHit' | 'rewindToCut' | 'reverseForwardB' | 'rewindReturn' | 'beatBoomerang' | 'slowPocket' | 'tapeStop' | 'whooshRamp' | 'beatStutter';
export const SPEED_VARIANTS: SpeedVariant[] = ['beatPulse', 'hitRamp', 'drift', 'holdHit', 'rewindToCut', 'reverseForwardB', 'rewindReturn', 'beatBoomerang', 'slowPocket', 'tapeStop', 'whooshRamp', 'beatStutter'];

/** 曲線控制點：beat = 全域拍號、source = 相對 shot.in 的素材秒數、ease = 到下一點的緩動。 */
export interface SpeedKnot { beat: number; source: number; ease: [number, number, number, number] | 'hold' }
export interface PlanSpeed { variant: SpeedVariant; knots: SpeedKnot[]; sourceMin: number; sourceMax: number }

/** 小數拍線性內插；範圍外沿用鄰近拍長。 */
export function beatTimeF(T: (beat: number) => number, beat: number): number {
  const i = Math.floor(beat);
  return T(i) + (beat - i) * (T(i + 1) - T(i));
}

const linear: SpeedKnot['ease'] = [0, 0, 1, 1];
const smooth: SpeedKnot['ease'] = [1 / 3, 0, 2 / 3, 1];
const slowOut: SpeedKnot['ease'] = [1 / 3, 1 / 2, 2 / 3, 1];
const speedIn: SpeedKnot['ease'] = [1 / 3, 0, 2 / 3, 1 / 3];
const accelerating: SpeedKnot['ease'] = [1 / 3, 0, 2 / 3, 0];
const clamp = (v: number) => Math.max(0, Math.min(1, v));

// 與 keyframes 的時間反解規則一致，避免載入介面模組。
function bezierY([x1, y1, x2, y2]: [number, number, number, number], x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bx = (t: number) => 3 * (1 - t) * (1 - t) * t * x1 + 3 * (1 - t) * t * t * x2 + t * t * t;
  const by = (t: number) => 3 * (1 - t) * (1 - t) * t * y1 + 3 * (1 - t) * t * t * y2 + t * t * t;
  let lo = 0, hi = 1, u = x;
  for (let i = 0; i < 40; i++) {
    const value = bx(u);
    if (Math.abs(value - x) < 1e-11) break;
    if (value < x) lo = u;
    else hi = u;
    u = (lo + hi) / 2;
  }
  return by(u);
}

/** 計算曲線內部極值，倒播時不能只看首尾。 */
function sourceBounds(knots: SpeedKnot[]): { sourceMin: number; sourceMax: number } {
  const values = knots.map((k) => k.source);
  for (let i = 0; i < knots.length - 1; i++) {
    const a = knots[i], b = knots[i + 1];
    if (a.ease === 'hold') continue;
    const [, y1, , y2] = a.ease;
    const A = 3 * y1 - 3 * y2 + 1, B = -4 * y1 + 2 * y2, C = y1;
    const roots: number[] = [];
    if (Math.abs(A) < 1e-12) {
      if (Math.abs(B) > 1e-12) roots.push(-C / B);
    } else {
      const d = B * B - 4 * A * C;
      if (d >= 0) roots.push((-B - Math.sqrt(d)) / (2 * A), (-B + Math.sqrt(d)) / (2 * A));
    }
    for (const u of roots) if (u > 0 && u < 1) {
      const y = 3 * (1 - u) ** 2 * u * y1 + 3 * (1 - u) * u * u * y2 + u ** 3;
      values.push(a.source + (b.source - a.source) * y);
    }
  }
  return { sourceMin: Math.min(...values), sourceMax: Math.max(...values) };
}

/** 產生單一鏡頭的素材時間曲線。 */
export function speedCurve(variant: SpeedVariant, b0: number, b1: number, T: (beat: number) => number,
  intensity: number, opts?: { hitBeat?: number }): PlanSpeed | null {
  const n = b1 - b0;
  const D = beatTimeF(T, b1) - beatTimeF(T, b0);
  if (!(D > 0) || !Number.isFinite(D)) return null;
  const strength = clamp(intensity);
  const knots: SpeedKnot[] = [];
  const at = (beat: number) => beatTimeF(T, beat) - beatTimeF(T, b0);
  if (variant === 'beatPulse') {
    if (n < 2) return null;
    const a = 0.37 + 0.21 * strength;
    const ease: SpeedKnot['ease'] = [0.25, a, 0.75, 1 - a];
    for (let beat = b0; beat < b1; beat++) knots.push({ beat, source: at(beat), ease });
    knots.push({ beat: b1, source: D, ease: linear });
  } else if (variant === 'hitRamp') {
    if (n < 2) return null;
    const last = b1 - 1;
    const q = at(b1) - at(last);
    const average = 1.35 + 0.2 * strength;
    const peak = 2 + 1.5 * strength;
    const ease: SpeedKnot['ease'] = [0.25, 0.25 / average, 0.75, 1 - peak * 0.25 / average];
    knots.push({ beat: b0, source: 0, ease: linear },
      { beat: last, source: at(last), ease },
      { beat: b1, source: at(last) + q * average, ease: linear });
  } else if (variant === 'drift') {
    if (n < 4) return null;
    const average = 0.75 - 0.25 * strength;
    knots.push({ beat: b0, source: 0, ease: [0.25, 0.38, 0.7, 0.82] },
      { beat: b1, source: D * average, ease: linear });
  } else if (variant === 'holdHit') {
    const hit = opts?.hitBeat;
    if (n < 3 || hit === undefined || !(hit > b0 && hit < b1)) return null;
    const end = hit + 0.25 + 0.25 * strength;
    if (end >= b1) return null;
    const source = at(hit);
    knots.push({ beat: b0, source: 0, ease: linear },
      { beat: hit, source, ease: 'hold' },
      { beat: end, source, ease: linear },
      { beat: b1, source: source + at(b1) - at(end), ease: linear });
  } else if (variant === 'rewindToCut') {
    if (n < 3) return null;
    const rewindBeats = strength < 0.5 ? 1 : 2;
    const turn = b1 - rewindBeats;
    const slowStart = turn - 1;
    const q = at(turn) - at(slowStart);
    const peak = at(slowStart) + q * 2 / 3;
    const rewindTime = at(b1) - at(turn);
    const distance = Math.min(peak, (2 + 2 * strength) * rewindTime / 3);
    if (slowStart > b0) knots.push({ beat: b0, source: 0, ease: linear });
    knots.push({ beat: slowStart, source: at(slowStart), ease: slowOut },
      { beat: turn, source: peak, ease: accelerating },
      { beat: b1, source: peak - distance, ease: linear });
  } else if (variant === 'reverseForwardB') {
    if (n < 3) return null;
    const turn = b0 + 1;
    const q = at(turn);
    const h = (1.5 + strength) * q;
    const reverseEase: SpeedKnot['ease'] = [1 / 3, Math.min(4, 2 * h / q) * q / (3 * h), 2 / 3, 1];
    const resume = b0 + 2;
    const q2 = at(resume) - at(turn);
    knots.push({ beat: b0, source: h, ease: reverseEase },
      { beat: turn, source: 0, ease: speedIn },
      { beat: resume, source: q2 / 2, ease: linear },
      { beat: b1, source: q2 / 2 + at(b1) - at(resume), ease: linear });
  } else if (variant === 'rewindReturn') {
    if (n < 4) return null;
    const turn = b0 + Math.floor(n / 2);
    const slowStart = turn - 1;
    const resume = turn + 1;
    const forward = resume + 1;
    const peak = at(slowStart) + (at(turn) - at(slowStart)) * 2 / 3;
    const back = (0.5 + 0.5 * strength) * (at(resume) - at(turn));
    const low = peak - back;
    if (slowStart > b0) knots.push({ beat: b0, source: 0, ease: linear });
    knots.push({ beat: slowStart, source: at(slowStart), ease: slowOut },
      { beat: turn, source: peak, ease: smooth },
      { beat: resume, source: low, ease: speedIn },
      { beat: forward, source: low + (at(forward) - at(resume)) / 2, ease: linear });
    if (forward < b1) knots.push({ beat: b1, source: low + (at(forward) - at(resume)) / 2 + at(b1) - at(forward), ease: linear });
  } else if (variant === 'beatBoomerang') {
    if (n < 2 || n > 4 || !Number.isInteger(n)) return null;
    let source = 0;
    for (let beat = b0; beat < b1; beat++) {
      const q = at(beat + 1) - at(beat);
      const a = 0.7 * q, back = 0.55 * q, finish = (0.1 + 0.25 * strength) * q;
      knots.push({ beat, source, ease: smooth },
        { beat: beat + 0.5, source: source + a, ease: smooth },
        { beat: beat + 0.75, source: source + a - back, ease: smooth });
      source += a - back + finish;
    }
    knots.push({ beat: b1, source, ease: linear });
  } else if (variant === 'slowPocket') {
    if (n < 2) return null;
    const low = 0.7 - 0.3 * strength;
    // 拍點左右各四分之一拍加速；逐拍正規化積分，保持素材消耗量等於牆上時間。
    const weight = (phase: number) => {
      const distance = Math.min(phase, 1 - phase);
      if (distance <= 0.18) return 1;
      if (distance >= 0.25) return 0;
      const x = (distance - 0.18) / 0.07;
      return (1 + Math.cos(Math.PI * x)) / 2;
    };
    // 每拍 16 段（控制點太多，屬性面板的曲線會很難改）
    const steps = 16;
    const weights = Array.from({ length: steps + 1 }, (_, i) => weight(i / steps));
    const mean = weights.slice(0, steps).reduce((sum, w, i) => sum + (w + weights[i + 1]) / (2 * steps), 0);
    const high = low + (1 - low) / mean;
    let source = 0;
    for (let beat = b0; beat < b1; beat++) {
      const q = at(beat + 1) - at(beat);
      for (let i = 0; i < steps; i++) {
        knots.push({ beat: beat + i / steps, source, ease: linear });
        source += q / steps * (low + (high - low) * (weights[i] + weights[i + 1]) / 2);
      }
    }
    knots.push({ beat: b1, source: D, ease: linear });
  } else if (variant === 'tapeStop') {
    if (n < 1) return null;
    const holdBeat = b1 - 0.25;
    const start = Math.max(b0, holdBeat - (0.5 + 0.25 * strength));
    if (start > b0) knots.push({ beat: b0, source: 0, ease: linear });
    knots.push({ beat: start, source: at(start), ease: [1 / 3, 1, 2 / 3, 1] });
    // 三次曲線的 v=(1-x)^2，起點為原速，終點平順降到零。
    const total = at(holdBeat) - at(start);
    const stopped = at(start) + total / 3;
    knots.push({ beat: holdBeat, source: stopped, ease: 'hold' },
      { beat: b1, source: stopped, ease: linear });
  } else if (variant === 'whooshRamp') {
    if (n < 1) return null;
    const start = b1 - 0.5;
    const peak = 2.5 + 1.5 * strength;
    const average = 1 + (peak - 1) / 3;
    const ease: SpeedKnot['ease'] = [1 / 3, 1 / (3 * average), 2 / 3, 1 - peak / (3 * average)];
    if (start > b0) knots.push({ beat: b0, source: 0, ease: linear });
    knots.push({ beat: start, source: at(start), ease },
      { beat: b1, source: at(start) + (at(b1) - at(start)) * average, ease: linear });
  } else if (variant === 'beatStutter') {
    if (n < 2) return null;
    const last = b1 - 1;
    const q = at(b1) - at(last);
    const repeats = strength < 0.5 ? 2 : 4;
    const jumpSeconds = 1e-3;
    if (q <= (repeats - 1) * jumpSeconds) return null;
    const slice = (q - (repeats - 1) * jumpSeconds) / repeats;
    const source = at(last);
    if (last > b0) knots.push({ beat: b0, source: 0, ease: linear });
    knots.push({ beat: last, source, ease: linear });
    let elapsed = at(last);
    for (let i = 0; i < repeats; i++) {
      elapsed += slice;
      knots.push({ beat: last + (elapsed - at(last)) / q, source: source + slice, ease: linear });
      if (i < repeats - 1) {
        elapsed += jumpSeconds;
        knots.push({ beat: last + (elapsed - at(last)) / q, source, ease: linear });
      }
    }
  } else return null;
  return { variant, knots, ...sourceBounds(knots) };
}

/** 與 evalKeys 使用相同的 cubic-bezier 與 hold 規則。 */
export function speedSourceAt(speed: PlanSpeed, b0: number, T: (beat: number) => number, t: number): number {
  const knots = speed.knots;
  if (!knots.length) return 0;
  const origin = beatTimeF(T, b0);
  if (t <= beatTimeF(T, knots[0].beat) - origin) return knots[0].source;
  for (let i = 0; i < knots.length - 1; i++) {
    const a = knots[i], b = knots[i + 1];
    const t0 = beatTimeF(T, a.beat) - origin;
    const t1 = beatTimeF(T, b.beat) - origin;
    if (t <= t1) {
      if (a.ease === 'hold') return a.source;
      return a.source + (b.source - a.source) * bezierY(a.ease, (t - t0) / (t1 - t0));
    }
  }
  return knots[knots.length - 1].source;
}

/** 曲線裡會倒播或幾乎停住（|速度| < 0.25）的區段，片段內秒數。 */
export function slowOrReverseSpans(speed: PlanSpeed, b0: number, T: (beat: number) => number): { t0: number; t1: number }[] {
  const spans: { t0: number; t1: number }[] = [];
  const origin = beatTimeF(T, b0);
  for (let i = 0; i < speed.knots.length - 1; i++) {
    const a = speed.knots[i], b = speed.knots[i + 1];
    const t0 = beatTimeF(T, a.beat) - origin, t1 = beatTimeF(T, b.beat) - origin;
    if (!(t1 > t0)) continue;
    const steps = Math.max(64, Math.ceil((t1 - t0) * 120));
    for (let j = 0; j < steps; j++) {
      const left = t0 + (t1 - t0) * j / steps;
      const right = t0 + (t1 - t0) * (j + 1) / steps;
      const rate = (speedSourceAt(speed, b0, T, right) - speedSourceAt(speed, b0, T, left)) / (right - left);
      if (rate >= 0.25) continue;
      const last = spans.at(-1);
      if (last && left - last.t1 < 1e-7) last.t1 = right;
      else spans.push({ t0: left, t1: right });
    }
  }
  return spans;
}
