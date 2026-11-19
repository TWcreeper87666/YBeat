/** 同一條軌道上的項目不能重疊：計算「最接近想要的位置、又不會撞到別人」的位移 */

export interface Span {
  /** 軌道識別：`${kind}:${track}`，只有同一條軌道才會互相碰撞 */
  lane: string;
  start: number;
  duration: number;
}

const EPS = 1e-4;

export const spansOverlap = (a: Span, b: Span) => a.lane === b.lane && a.start < b.start + b.duration - EPS && b.start < a.start + a.duration - EPS;

/** moving 整組平移 dt 之後會不會撞到 others（或跑到 0 秒之前） */
export function groupFits(moving: Span[], others: Span[], dt: number): boolean {
  for (const m of moving) {
    if (m.start + dt < -EPS) return false;
    const moved = { ...m, start: m.start + dt };
    for (const o of others) if (spansOverlap(moved, o)) return false;
  }
  return true;
}

/**
 * 找出最接近 dt、而且整組都放得下的位移。
 * forward = true 時只往後找（貼上 / 再製用）。
 * 一定找得到（最差就是放到所有項目後面），moving 為空時回傳 dt。
 */
export function resolveShift(moving: Span[], others: Span[], dt: number, forward = false): number {
  if (!moving.length) return dt;
  if (groupFits(moving, others, dt)) return dt;
  const minStart = Math.min(...moving.map((m) => m.start));
  const cands = new Set<number>([-minStart]);
  const lanes = new Set(moving.map((m) => m.lane));
  for (const m of moving) {
    for (const o of others) {
      if (o.lane !== m.lane) continue;
      cands.add(o.start + o.duration - m.start); // 放到 o 後面
      cands.add(o.start - (m.start + m.duration)); // 放到 o 前面
    }
  }
  let best = dt, bd = Infinity;
  for (const c of cands) {
    if (forward && c < dt - EPS) continue;
    const d = Math.abs(c - dt);
    if (d >= bd) continue;
    if (groupFits(moving, others, c)) {
      best = c;
      bd = d;
    }
  }
  if (bd === Infinity) {
    // 理論上不會發生：保險起見放到所有相關軌道的最後面
    const end = Math.max(0, ...others.filter((o) => lanes.has(o.lane)).map((o) => o.start + o.duration));
    return end - minStart;
  }
  return best;
}

/** 單一項目：回傳最接近 start 的可放位置 */
export function fitStart(others: Span[], lane: string, start: number, duration: number, forward = false): number {
  return start + resolveShift([{ lane, start, duration }], others, 0, forward);
}

/** 項目在同軌上可以往右延伸到哪裡（下一個項目的開頭） */
export function nextStart(others: Span[], lane: string, end: number): number {
  let n = Infinity;
  for (const o of others) if (o.lane === lane && o.start >= end - EPS && o.start < n) n = o.start;
  return n;
}

/** 項目在同軌上可以往左延伸到哪裡（上一個項目的結尾） */
export function prevEnd(others: Span[], lane: string, start: number): number {
  let p = 0;
  for (const o of others) {
    const e = o.start + o.duration;
    if (o.lane === lane && e <= start + EPS && e > p) p = e;
  }
  return p;
}
