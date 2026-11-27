/**
 * AI 寫的模組：把套在畫面上算出來的幾格讀回像素（縮成小圖），找出明顯壞掉的輸出。
 * 不用給 AI 看圖：整片黑（NaN 讀回來也是黑）、全透明、跟原圖一樣就丟回去修。
 */
import type { ModuleKind } from '../store';

/** RGBA 像素（長度 = 寬 × 高 × 4） */
export type Pixels = ArrayLike<number>;

export type RenderProblem = 'black' | 'transparent' | 'unchanged';

const mean = (p: Pixels, f: (r: number, g: number, b: number, a: number) => number) => {
  let s = 0;
  const n = Math.floor(p.length / 4);
  for (let i = 0; i < n; i++) s += f(p[i * 4], p[i * 4 + 1], p[i * 4 + 2], p[i * 4 + 3]);
  return n ? s / n : 0;
};
const luma = (p: Pixels) => mean(p, (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b);
const alpha = (p: Pixels) => mean(p, (_r, _g, _b, a) => a);
/** 兩張圖平均每個通道差多少（0..255） */
export function pixelDiff(a: Pixels, b: Pixels): number {
  const n = Math.min(a.length, b.length);
  let s = 0, k = 0;
  for (let i = 0; i < n; i++) if (i % 4 !== 3) { s += Math.abs(a[i] - b[i]); k++; }
  return k ? s / k : 0;
}

/** 幾乎全黑 / 全透明 / 沒變化的門檻（0..255） */
const DARK = 6;
const CLEAR = 8;
const SAME = 1.5;

/**
 * 檢查算出來的幾格。base = 原始畫面；other = 轉場的後一段；frames = SAMPLE_AT 那幾格。
 * 原圖本來就很暗時不判黑。沒問題 = null。
 */
export function renderProblem(kind: ModuleKind, base: Pixels, frames: Pixels[], other?: Pixels): RenderProblem | null {
  if (!frames.length) return null;
  if (frames.every((f) => alpha(f) < CLEAR)) return 'transparent';
  const inputDark = luma(base) < DARK && (!other || luma(other) < DARK);
  if (!inputDark && frames.every((f) => luma(f) < DARK)) return 'black';
  if (frames.every((f) => pixelDiff(f, base) < SAME)) return 'unchanged';
  // 轉場一直停在後一段也算沒做事（硬切到 B）
  if (kind === 'transition' && other && frames.every((f) => pixelDiff(f, other) < SAME)) return 'unchanged';
  return null;
}

const WHAT: Record<RenderProblem, string> = {
  black: 'every sampled frame came out completely black (NaN or division by zero also reads back as black)',
  transparent: 'every sampled frame came out fully transparent (alpha ≈ 0)',
  unchanged: 'the output is identical to the input in every sampled frame, so the module does nothing visible',
};

/** 丟回給 AI 的訊息 */
export const renderPrompt = (kind: ModuleKind, problem: RenderProblem, at: number[], ok: string) =>
  `The app rendered your ${kind} module with its default parameters at progress ${at.join(', ')}: ${WHAT[problem]}.` +
  ` Reply with the full corrected module in one code block.` +
  ` Only if that is really intended with default parameters (for example it only reacts to beats or audio), reply with exactly ${ok} instead.`;
