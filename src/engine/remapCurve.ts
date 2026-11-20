import { bezierY, newKey, sortKeys, type Ease, type Keyframe } from './keyframes';

/**
 * 曲線變速：「素材時間」本身是一條關鍵影格曲線
 * - key 的 t = 片段內時間（秒）、v = 要顯示的素材時間（秒，相對片段的 in）
 * - 兩個 key 之間的緩動 = 速度變化；v 往回走 = 倒播
 *
 * 存到素材庫時把時間和數值都除以片段長度（0~1），套用到別的片段時再乘回去，
 * 存成一般的變速模組（程式碼裡帶 `// @curve [...]`），素材庫的拖曳、我的最愛、刪除都照用。
 */
export const CURVE_ID = 'remap-curve';

/** [t, v, ease]：t / v 是相對片段長度的比例 */
export type CurvePoint = [number, number, Ease];

const CURVE_RE = /^\s*\/\/\s*@curve\s+(\[.*\])\s*$/m;

export function parseCurve(code: string): CurvePoint[] | null {
  const m = CURVE_RE.exec(code);
  if (!m) return null;
  try {
    const k = JSON.parse(m[1]);
    if (!Array.isArray(k) || k.length < 2) return null;
    return k.filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])).map((p) => [p[0], p[1], p[2] ?? 'hold']) as CurvePoint[];
  } catch {
    return null;
  }
}

const r4 = (x: number) => Math.round(x * 10000) / 10000;

/** 片段上的 key → 比例曲線 */
export function keysToCurve(keys: Keyframe[], dur: number): CurvePoint[] {
  const d = Math.max(1e-6, dur);
  return sortKeys(keys).map((k) => [r4(k.t / d), r4(k.v / d), Array.isArray(k.ease) ? (k.ease.map(r4) as Ease) : k.ease]);
}

/** 比例曲線 → 這個片段的 key */
export function curveToKeys(c: CurvePoint[], dur: number): Keyframe[] {
  return c.map(([t, v, e]) => newKey(t * dur, v * dur, e));
}

/** 比例曲線在 x（0~1）的值（給素材庫的模組程式碼用：ease.curve） */
export function evalCurve(c: CurvePoint[], x: number): number {
  const n = c.length;
  if (!n) return x;
  if (x <= c[0][0]) return c[0][1];
  if (x >= c[n - 1][0]) return c[n - 1][1];
  let i = 0;
  while (i < n - 2 && c[i + 1][0] <= x) i++;
  const [ta, va, e] = c[i], [tb, vb] = c[i + 1];
  if (e === 'hold') return va;
  return va + (vb - va) * bezierY(e, (x - ta) / Math.max(1e-6, tb - ta));
}

/** 存到素材庫的模組程式碼 */
export function curveCode(c: CurvePoint[]): string {
  return `// 自訂曲線（在屬性面板的「速度」區塊編輯後存的）
// @curve ${JSON.stringify(c)}
function remap(t, p, info) {
  return ease.curve(CURVE, t / info.dur) * info.dur;
}
const CURVE = ${JSON.stringify(c)};
`;
}

/** 剛切到曲線模式：從片段開頭正常速度播到結尾 */
export const defaultCurveKeys = (dur: number): Keyframe[] => [newKey(0, 0, [0, 0, 1, 1]), newKey(dur, dur, [0, 0, 1, 1])];
