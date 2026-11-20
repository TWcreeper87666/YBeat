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

export interface MoveSnap {
  /** 吸附後的框中心（px） */
  center: number;
  /** 吸到的線（px）；null = 沒吸到 */
  line: number | null;
}

/** Only show a snap guide when the constrained result actually lands on its target. */
export function snapTargetIfApplied(snap: { v: number; d: number }, actual: number): number | null {
  return Number.isFinite(snap.d) && Math.abs(snap.v - actual) <= 1e-6 ? snap.v : null;
}

/** Timeline placement snap targets for another item's start, end, or end-to-start alignment. */
export function laneSnapPoints(items: { start: number; duration: number }[], time: number, duration: number) {
  const points = [0, time];
  for (const item of items) points.push(item.start, item.start + item.duration, item.start - duration);
  return points;
}

/**
 * 移動的吸附（一個軸）：框的中心、兩個邊（center ± half）都可以吸到任何一條線，取最近的。
 * half 是框在畫面上（含旋轉）的半寬 / 半高。
 */
export function snapMoveAxis(center: number, half: number, lines: number[], tol: number): MoveSnap {
  let best: { center: number; line: number; dist: number } | null = null;
  for (const t of lines) {
    for (const off of half > 1e-6 ? [0, -half, half] : [0]) {
      const dist = Math.abs(center + off - t);
      if (dist <= tol && (!best || dist < best.dist)) best = { center: t - off, line: t, dist };
    }
  }
  return best ? { center: best.center, line: best.line } : { center, line: null };
}

/** 旋轉後框在畫面上的半寬 / 半高（外接矩形） */
export function rotatedHalf(w: number, h: number, rotDeg: number): { hx: number; hy: number } {
  const a = (rotDeg * Math.PI) / 180;
  const c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
  return { hx: (w * c + h * s) / 2, hy: (w * s + h * c) / 2 };
}

/** Shift 吸附可以吸的線（px）：畫面四邊、中線；開了輔助網格 → 每一條網格線（含安全區），沒開 → 三分線 */
export function gridSnapLines(W: number, H: number, g: { grid: boolean; gridRows: number; gridCols: number; gridSafe: boolean }) {
  const x = [0, W / 2, W], y = [0, H / 2, H];
  if (g.grid) {
    for (let i = 1; i < g.gridCols; i++) x.push((i / g.gridCols) * W);
    for (let i = 1; i < g.gridRows; i++) y.push((i / g.gridRows) * H);
    if (g.gridSafe) {
      x.push(W * 0.04, W * 0.84);
      y.push(H * 0.08, H * 0.78);
    }
  } else {
    x.push(W / 3, (W * 2) / 3);
    y.push(H / 3, (H * 2) / 3);
  }
  return { x, y };
}
