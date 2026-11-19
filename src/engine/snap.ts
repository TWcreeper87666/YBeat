/**
 * 預覽變換框的縮放吸附（按住 Shift）：讓框的邊吸到附近的線（畫面四邊、中線、網格線）。純函式，方便測試。
 */

export interface ScaleSnap {
  /** 吸附後的倍率（相對開始拖曳時的大小） */
  f: number;
  /** 吸到哪條線（同一軸上的座標）；null = 沒吸到 */
  line: number | null;
  /** 吸附前，框邊到那條線的距離（px） */
  dist: number;
}

/**
 * 一個軸上的吸附。center = 框中心；half = 開始拖曳時的半寬（倍率 1）；f = 目前倍率。
 * 框的兩個邊在 center ± half × f，找最近的線，距離在 tol（px）內就吸過去。
 */
export function snapScaleAxis(center: number, half: number, f: number, lines: number[], tol: number): ScaleSnap {
  let best: ScaleSnap = { f, line: null, dist: Infinity };
  if (half <= 1e-6) return best;
  const edge = half * f;
  for (const t of lines) {
    const d = Math.abs(t - center);
    if (d < 1e-6) continue; // 線在中心上：怎麼縮放邊都碰不到
    const dist = Math.abs(edge - d);
    if (dist < best.dist) best = { f: d / half, line: t, dist };
  }
  return best.dist <= tol ? best : { f, line: null, dist: best.dist };
}

/** 框的旋轉角對齊到 0 / 90 / 180 / 270 度時，回傳畫面上寬高是否對調；不對齊回傳 null（不吸附） */
export function axisAligned(rot: number): { swapped: boolean } | null {
  const r = ((rot % 360) + 360) % 360;
  const near = Math.round(r / 90) * 90;
  if (Math.abs(r - near) > 0.5) return null;
  return { swapped: near % 180 === 90 };
}
