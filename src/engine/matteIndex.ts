/**
 * AI 去背遮罩的索引：每張遮罩用「那一格實際的時間戳記」（影格的 PTS）當 key，
 * 查的時候跟瀏覽器選畫面的規則一樣：時間 t 顯示的是「時間戳記 ≤ t 的最後一格」。
 * 不假設影格從 0 開始、也不假設固定影格率（手機錄的常常是變動影格率）。
 */

/** 秒 → 整數 key（0.1ms），避免浮點數比較 */
export const toKey = (t: number) => Math.round(t * 1e4);

/** 已排序陣列中 ≤ x 的最後一個位置（沒有 = -1） */
export function lastAtOrBefore(keys: number[], x: number): number {
  let lo = 0, hi = keys.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (keys[mid] <= x) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
}

/** 插入並保持排序（已存在就不動）；回傳是否新增 */
export function insertKey(keys: number[], k: number): boolean {
  const i = lastAtOrBefore(keys, k);
  if (i >= 0 && keys[i] === k) return false;
  keys.splice(i + 1, 0, k);
  return true;
}

/** [a, b) 之間有沒有 key */
export function hasKeyIn(keys: number[], a: number, b: number): boolean {
  const i = lastAtOrBefore(keys, b - 1);
  return i >= 0 && keys[i] >= a;
}

/**
 * 時間 t（畫面上那一格的時間）要用哪一張遮罩。
 * - frameDur：一格多長（秒）；step：每幾格算一次。
 * - 每格都算（step = 1）：用「≤ t 的最後一格」，跟畫面一致；t 在第一格之前一點點就用第一格。
 * - 隔格算：用前後最近的那一格。
 * - 最近的那格離太遠（還沒算到）→ null。
 */
export function pickFrame(keys: number[], t: number, frameDur: number, step: number): number | null {
  if (!keys.length) return null;
  const tk = toKey(t);
  const tol = 10; // 1ms：時間戳記的小誤差
  const maxGap = toKey(frameDur * Math.max(3, step * 2));
  const i = lastAtOrBefore(keys, tk + tol);
  const a = i >= 0 ? keys[i] : null;
  const b = i + 1 < keys.length ? keys[i + 1] : null;
  if (step <= 1) {
    if (a !== null && tk - a <= maxGap) return a;
    if (b !== null && b - tk <= toKey(frameDur)) return b;
    return null;
  }
  const da = a !== null ? Math.abs(tk - a) : Infinity;
  const db = b !== null ? Math.abs(b - tk) : Infinity;
  const best = da <= db ? a : b;
  return best !== null && Math.min(da, db) <= maxGap ? best : null;
}

/** 常見的影格率（含 NTSC 的 1000/1001） */
export const COMMON_FPS = [24000 / 1001, 24, 25, 30000 / 1001, 30, 48, 50, 60000 / 1001, 60, 90, 100, 120];

/**
 * 量到的影格率對到最接近的常見值；差超過 0.2% 就直接用量到的。
 * 不能取「第一個差 3% 以內的」：30 會被當成 29.97、24 被當成 23.976，
 * 一格的差很小但會一路累積，影片後段 seek 就會落到相鄰的格子。
 */
export function snapFps(raw: number): number {
  if (!(raw > 0)) return 30;
  let best = COMMON_FPS[0];
  for (const f of COMMON_FPS) if (Math.abs(f - raw) < Math.abs(best - raw)) best = f;
  return Math.abs(best - raw) / raw < 0.002 ? best : Math.min(240, Math.max(5, raw));
}
