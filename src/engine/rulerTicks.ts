/** 時間軸以 1/60 秒為最小單位（跟方向鍵逐格、節拍提前的單位一樣） */
export const FPS = 60;
export const PPS_MAX = 1200; // 放到最大：一格 1/60 秒 = 20px
export const PPS_MIN = 5;

/** 刻度間隔的候選（秒）：影格（1、2、5、10、15、30 格）→ 秒 → 分 */
const STEPS = [1, 2, 5, 10, 15, 30].map((f) => f / FPS).concat([1, 2, 5, 10, 15, 30, 60, 120, 300, 600]);
const LABEL_PX = 64; // 有數字的刻度至少隔這麼多 px
const MINOR_PX = 6; // 小刻度至少隔這麼多 px

const divides = (a: number, b: number) => Math.abs(b / a - Math.round(b / a)) < 1e-6;

/** 依縮放決定：major = 有數字的刻度間隔、minor = 小刻度間隔（major 一定是 minor 的整數倍） */
export function rulerSteps(pps: number): { major: number; minor: number } {
  const major = STEPS.find((s) => s * pps >= LABEL_PX) ?? STEPS[STEPS.length - 1];
  const minor = STEPS.find((s) => s * pps >= MINOR_PX && s <= major && divides(s, major)) ?? major;
  return { major, minor };
}

const p2 = (n: number) => String(n).padStart(2, '0');

/**
 * 時間碼（時間「位置」都用這個）：mm:ss:ff，ff = 第幾格（1/60 秒）；超過一小時變 h:mm:ss:ff。
 * frames = false：只到秒（mm:ss）。長度（片段長度、淡入淡出…）還是用秒數顯示。
 */
export function tc(t: number, frames = true): string {
  const f = Math.max(0, Math.round(t * FPS));
  const sec = Math.floor(f / FPS);
  const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60;
  const head = h ? `${h}:${p2(m)}:${p2(s)}` : `${p2(m)}:${p2(s)}`;
  return frames ? `${head}:${p2(f % FPS)}` : head;
}

/** 刻度文字：大刻度是整秒 = mm:ss；放大到不是整秒 = mm:ss:ff */
export const rulerLabel = (t: number, major: number) => tc(t, major < 1 - 1e-9);

/** 一段範圍（a~b 秒）裡最多 max 個刻度（預設 5），間隔都是整數格 */
export function frameTicks(a: number, b: number, max = 5): { ticks: number[]; step: number } {
  const step = STEPS.find((s) => (b - a) / s <= Math.max(1, max)) ?? STEPS[STEPS.length - 1];
  const n = Math.round(step * FPS);
  const ticks: number[] = [];
  for (let f = Math.ceil((a * FPS - 1e-6) / n) * n; f / FPS <= b + 1e-6; f += n) ticks.push(f / FPS);
  return { ticks, step };
}

/** 對齊到最近的一格 */
export const snapFrame = (t: number) => Math.round(t * FPS) / FPS;
