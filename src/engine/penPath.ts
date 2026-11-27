/**
 * 鋼筆工具畫的封閉路徑：錨點 + 貝茲控制把手。
 * o = 出去的把手、i = 進來的把手（相對錨點的位移）；只有 o 沒有 i = 平滑點（i 是 o 的反方向）。
 */
export interface PenPt { x: number; y: number; o?: [number, number]; i?: [number, number] }

export const handleOut = (p: PenPt): [number, number] => p.o ?? [0, 0];
export const handleIn = (p: PenPt): [number, number] => p.i ?? (p.o ? [-p.o[0], -p.o[1]] : [0, 0]);
const isCurve = (a: PenPt, b: PenPt) => !!(a.o || b.i || b.o);

const n2 = (v: number) => +v.toFixed(2);

/** 轉成 SVG 路徑（closed = 最後一點接回第一點） */
export function penToPath(pts: PenPt[], closed = true): string {
  if (!pts.length) return '';
  let d = `M${n2(pts[0].x)} ${n2(pts[0].y)}`;
  const n = closed ? pts.length : pts.length - 1;
  for (let k = 0; k < n; k++) {
    const a = pts[k], b = pts[(k + 1) % pts.length];
    if (isCurve(a, b)) {
      const [ox, oy] = handleOut(a), [ix, iy] = handleIn(b);
      d += `C${n2(a.x + ox)} ${n2(a.y + oy)} ${n2(b.x + ix)} ${n2(b.y + iy)} ${n2(b.x)} ${n2(b.y)}`;
    } else if (!(closed && k === n - 1)) d += `L${n2(b.x)} ${n2(b.y)}`; // 封閉的最後一段直線交給 Z
  }
  return closed ? d + 'Z' : d;
}

/** 第 k 段（pts[k] → pts[k+1]）上 t 位置的點 */
export function segPoint(pts: PenPt[], k: number, t: number): [number, number] {
  const a = pts[k], b = pts[(k + 1) % pts.length];
  const [ox, oy] = handleOut(a), [ix, iy] = handleIn(b);
  const p1 = [a.x + ox, a.y + oy], p2 = [b.x + ix, b.y + iy];
  const u = 1 - t;
  return [
    u * u * u * a.x + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * b.x,
    u * u * u * a.y + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * b.y,
  ];
}

/** 路徑實際的範圍（取樣曲線，不是把手的範圍） */
export function penBounds(pts: PenPt[]): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let k = 0; k < pts.length; k++) {
    for (let s = 0; s <= 24; s++) {
      const [x, y] = segPoint(pts, k, s / 24);
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return { x0, y0, x1, y1 };
}

/**
 * 存成遮罩形狀：裁掉空白、拉滿 200×200（跟內建形狀一樣），比例另外記。
 * 太扁的一邊至少當作 1 單位，避免除以 0。
 */
export function penToShape(pts: PenPt[]): { path: string; aspect: number } | null {
  if (pts.length < 3) return null;
  const b = penBounds(pts);
  const bw = Math.max(1, b.x1 - b.x0), bh = Math.max(1, b.y1 - b.y0);
  const sx = 200 / bw, sy = 200 / bh;
  const norm = pts.map<PenPt>((p) => ({
    x: (p.x - b.x0) * sx,
    y: (p.y - b.y0) * sy,
    ...(p.o ? { o: [p.o[0] * sx, p.o[1] * sy] as [number, number] } : {}),
    ...(p.i ? { i: [p.i[0] * sx, p.i[1] * sy] as [number, number] } : {}),
  }));
  return { path: penToPath(norm), aspect: bw / bh };
}

/** 離 (x, y) 最近的線段與位置（插入錨點用） */
export function nearestOnPath(pts: PenPt[], x: number, y: number): { k: number; t: number; d: number } {
  let best = { k: 0, t: 0, d: Infinity };
  for (let k = 0; k < pts.length; k++) {
    for (let s = 0; s <= 40; s++) {
      const [px, py] = segPoint(pts, k, s / 40);
      const d = Math.hypot(px - x, py - y);
      if (d < best.d) best = { k, t: s / 40, d };
    }
  }
  return best;
}

/** 在第 k 段的 t 位置插入錨點，曲線形狀不變（de Casteljau 分割） */
export function insertPoint(pts: PenPt[], k: number, t: number): PenPt[] {
  const a = pts[k], bi = (k + 1) % pts.length, b = pts[bi];
  const out = pts.map((p) => ({ ...p }));
  if (!isCurve(a, b)) {
    const [x, y] = segPoint(pts, k, t);
    out.splice(k + 1, 0, { x, y });
    return out;
  }
  const lerp = (p: number[], q: number[], u: number) => [p[0] + (q[0] - p[0]) * u, p[1] + (q[1] - p[1]) * u];
  const [ox, oy] = handleOut(a), [ix, iy] = handleIn(b);
  const P0 = [a.x, a.y], P1 = [a.x + ox, a.y + oy], P2 = [b.x + ix, b.y + iy], P3 = [b.x, b.y];
  const A = lerp(P0, P1, t), B = lerp(P1, P2, t), C = lerp(P2, P3, t);
  const D = lerp(A, B, t), E = lerp(B, C, t), M = lerp(D, E, t);
  // a 的出把手、b 的進把手縮短；新點兩邊的把手共線（平滑）
  out[k] = { ...out[k], o: [A[0] - a.x, A[1] - a.y], ...(out[k].o && !out[k].i ? { i: handleIn(a) } : {}) };
  out[bi] = { ...out[bi], i: [C[0] - b.x, C[1] - b.y] };
  const np: PenPt = { x: M[0], y: M[1], o: [E[0] - M[0], E[1] - M[1]], i: [D[0] - M[0], D[1] - M[1]] };
  out.splice(k + 1, 0, np);
  return out;
}

/** 把選取的錨點（連同它們的把手）平移 */
export function movePts(pts: PenPt[], sel: Iterable<number>, dx: number, dy: number): PenPt[] {
  const s = new Set(sel);
  return pts.map((p, k) => (s.has(k) ? { ...p, x: p.x + dx, y: p.y + dy } : p));
}

/** 範圍落在矩形裡的錨點（框選） */
export function ptsInRect(pts: PenPt[], x0: number, y0: number, x1: number, y1: number): number[] {
  const [ax, bx] = x0 < x1 ? [x0, x1] : [x1, x0];
  const [ay, by] = y0 < y1 ? [y0, y1] : [y1, y0];
  const out: number[] = [];
  pts.forEach((p, k) => p.x >= ax && p.x <= bx && p.y >= ay && p.y <= by && out.push(k));
  return out;
}

/**
 * 把路徑（實際範圍）拉到 box 裡，再繞 box 中心旋轉 rotation 度（y 向下，正值 = 順時針）。
 * 用來把存起來的形狀放回遮罩框在畫面上的位置。
 */
export function fitPen(pts: PenPt[], box: { x0: number; y0: number; x1: number; y1: number }, rotation = 0): PenPt[] {
  if (!pts.length) return [];
  const b = penBounds(pts);
  const sx = (box.x1 - box.x0) / Math.max(1e-9, b.x1 - b.x0), sy = (box.y1 - box.y0) / Math.max(1e-9, b.y1 - b.y0);
  const cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2;
  const th = (rotation * Math.PI) / 180, c = Math.cos(th), s = Math.sin(th);
  const rv = (x: number, y: number): [number, number] => [c * x - s * y, s * x + c * y];
  return pts.map((p) => {
    const [x, y] = rv(box.x0 + (p.x - b.x0) * sx - cx, box.y0 + (p.y - b.y0) * sy - cy);
    return {
      x: cx + x,
      y: cy + y,
      ...(p.o ? { o: rv(p.o[0] * sx, p.o[1] * sy) } : {}),
      ...(p.i ? { i: rv(p.i[0] * sx, p.i[1] * sy) } : {}),
    };
  });
}

/** SVG 弧線（A 指令）→ 幾段三次貝茲曲線（每段 ≤ 90°）：[c1x, c1y, c2x, c2y, x, y] */
function arcToCubics(x1: number, y1: number, rx: number, ry: number, phiDeg: number, large: boolean, sweep: boolean, x2: number, y2: number): number[][] {
  if (!rx || !ry || (x1 === x2 && y1 === y2)) return [[x1, y1, x2, y2, x2, y2]];
  rx = Math.abs(rx); ry = Math.abs(ry);
  const phi = (phiDeg * Math.PI) / 180, cp = Math.cos(phi), sp = Math.sin(phi);
  // 端點 → 中心（SVG 規格 F.6.5）
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const x1p = cp * dx + sp * dy, y1p = -sp * dx + cp * dy;
  const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam); }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const co = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / den));
  const cxp = (co * rx * y1p) / ry, cyp = (-co * ry * x1p) / rx;
  const cx = cp * cxp - sp * cyp + (x1 + x2) / 2, cy = sp * cxp + cp * cyp + (y1 + y2) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  else if (sweep && dt < 0) dt += 2 * Math.PI;
  const n = Math.max(1, Math.ceil(Math.abs(dt) / (Math.PI / 2) - 1e-9));
  const seg = dt / n, k = (4 / 3) * Math.tan(seg / 4);
  const pt = (t: number): [number, number] => [cx + rx * Math.cos(t) * cp - ry * Math.sin(t) * sp, cy + rx * Math.cos(t) * sp + ry * Math.sin(t) * cp];
  const dv = (t: number): [number, number] => [-rx * Math.sin(t) * cp - ry * Math.cos(t) * sp, -rx * Math.sin(t) * sp + ry * Math.cos(t) * cp];
  const out: number[][] = [];
  for (let i = 0; i < n; i++) {
    const a = t1 + i * seg, b = a + seg;
    const [ax, ay] = pt(a), [bx, by] = pt(b), [dax, day] = dv(a), [dbx, dby] = dv(b);
    out.push([ax + k * dax, ay + k * day, bx - k * dbx, by - k * dby, bx, by]);
  }
  return out;
}

/**
 * SVG 路徑 → 鋼筆錨點（只取第一個子路徑；M / L / H / V / C / A / Z，大小寫都可以）。
 * 給「在畫面上繪製」從現有的形狀開始改用：內建形狀、形狀庫的鋼筆形狀、主體輪廓描成的路徑
 */
export function pathToPen(d: string): PenPt[] {
  const tok = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) ?? [];
  const pts: PenPt[] = [];
  let i = 0, cmd = '', x = 0, y = 0, started = false;
  const num = () => Number(tok[i++]);
  const isNum = () => i < tok.length && !/^[a-zA-Z]$/.test(tok[i]);
  const lineTo = (nx: number, ny: number) => { pts.push({ x: nx, y: ny }); x = nx; y = ny; };
  const curveTo = (c1x: number, c1y: number, c2x: number, c2y: number, nx: number, ny: number) => {
    const last = pts[pts.length - 1];
    if (last) last.o = [c1x - last.x, c1y - last.y];
    pts.push({ x: nx, y: ny, i: [c2x - nx, c2y - ny] });
    x = nx; y = ny;
  };
  while (i < tok.length) {
    if (!isNum()) cmd = tok[i++];
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    if (C === 'Z') break;
    if (C === 'M') {
      if (started) break;
      started = true;
      const nx = num() + (rel ? x : 0), ny = num() + (rel ? y : 0);
      lineTo(nx, ny);
      cmd = rel ? 'l' : 'L'; // M 後面接著的座標 = L
      continue;
    }
    if (!started || !isNum()) { i++; continue; }
    if (C === 'L') lineTo(num() + (rel ? x : 0), num() + (rel ? y : 0));
    else if (C === 'H') lineTo(num() + (rel ? x : 0), y);
    else if (C === 'V') lineTo(x, num() + (rel ? y : 0));
    else if (C === 'C') {
      const v = [num(), num(), num(), num(), num(), num()];
      if (rel) for (let k = 0; k < 6; k++) v[k] += k % 2 ? y : x;
      curveTo(v[0], v[1], v[2], v[3], v[4], v[5]);
    } else if (C === 'A') {
      const rx = num(), ry = num(), rot = num(), la = num(), sw = num();
      const nx = num() + (rel ? x : 0), ny = num() + (rel ? y : 0);
      for (const c of arcToCubics(x, y, rx, ry, rot, !!la, !!sw, nx, ny)) curveTo(c[0], c[1], c[2], c[3], c[4], c[5]);
    } else i++;
  }
  // 最後一點跟第一點重疊（封閉）：合併成一點
  if (pts.length > 1) {
    const a = pts[0], b = pts[pts.length - 1];
    if (Math.hypot(a.x - b.x, a.y - b.y) < 1e-6) { if (b.i) a.i = b.i; pts.pop(); }
  }
  // 直線進來的點：進把手是 0（不然會被當成對稱的平滑點）
  for (const p of pts) if (p.o && !p.i) p.i = [0, 0];
  return pts;
}
