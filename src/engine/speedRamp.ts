export type SpeedVariant = 'beatPulse' | 'hitRamp' | 'drift' | 'holdHit';
export const SPEED_VARIANTS: SpeedVariant[] = ['beatPulse', 'hitRamp', 'drift', 'holdHit'];

/** 曲線控制點：beat = 全域拍號、source = 相對 shot.in 的素材秒數、ease = 到下一點的緩動。 */
export interface SpeedKnot { beat: number; source: number; ease: [number, number, number, number] | 'hold' }
export interface PlanSpeed { variant: SpeedVariant; knots: SpeedKnot[]; sourceMin: number; sourceMax: number }

/** 小數拍線性內插；範圍外沿用鄰近拍長。 */
export function beatTimeF(T: (beat: number) => number, beat: number): number {
  const i = Math.floor(beat);
  return T(i) + (beat - i) * (T(i + 1) - T(i));
}

const linear: SpeedKnot['ease'] = [0, 0, 1, 1];
const clamp = (v: number) => Math.max(0, Math.min(1, v));

// 與 keyframes 的時間反解規則一致，避免載入介面模組。
function bezierY([x1, y1, x2, y2]: [number, number, number, number], x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bx = (t: number) => 3 * (1 - t) * (1 - t) * t * x1 + 3 * (1 - t) * t * t * x2 + t * t * t;
  const by = (t: number) => 3 * (1 - t) * (1 - t) * t * y1 + 3 * (1 - t) * t * t * y2 + t * t * t;
  let lo = 0, hi = 1, u = x;
  for (let i = 0; i < 24; i++) {
    const value = bx(u);
    if (Math.abs(value - x) < 1e-5) break;
    if (value < x) lo = u;
    else hi = u;
    u = (lo + hi) / 2;
  }
  return by(u);
}

/** 產生單一鏡頭的向前素材時間曲線。 */
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
  } else return null;
  return { variant, knots, sourceMin: knots[0].source, sourceMax: knots[knots.length - 1].source };
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
