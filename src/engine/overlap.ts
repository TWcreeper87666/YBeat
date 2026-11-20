/** 同一條軌道上的項目不能重疊：計算「最接近想要的位置、又不會撞到別人」的位移 */

export interface Span {
  /** 軌道識別：`${kind}:${track}`，只有同一條軌道才會互相碰撞 */
  lane: string;
  start: number;
  duration: number;
}

const EPS = 1e-4;

export function selectedItemsAtEdge<T extends { id: string; start: number; duration: number }>(
  items: T[],
  selectedIds: string[],
  primaryId: string,
  side: 'start' | 'end',
): T[] {
  const primary = items.find((item) => item.id === primaryId);
  if (!primary) return [];
  return selectedItemsAtTime(items, [...selectedIds, primaryId], side === 'start' ? primary.start : primary.start + primary.duration, side);
}

export function selectedItemsAtTime<T extends { id: string; start: number; duration: number }>(
  items: T[],
  selectedIds: string[],
  edge: number,
  side: 'start' | 'end',
): T[] {
  const selected = new Set(selectedIds);
  return items.filter((item) => selected.has(item.id) && Math.abs((side === 'start' ? item.start : item.start + item.duration) - edge) <= EPS);
}

export const spansOverlap = (a: Span, b: Span) => a.lane === b.lane && a.start < b.start + b.duration - EPS && b.start < a.start + a.duration - EPS;

/** Parts of an existing span that survive an overwrite. */
export function overwriteParts(start: number, duration: number, cuts: { start: number; duration: number }[]): { start: number; duration: number }[] {
  let parts = [{ start, duration }];
  for (const cut of cuts) {
    const end = cut.start + cut.duration;
    parts = parts.flatMap((p) => {
      const pEnd = p.start + p.duration;
      if (end <= p.start + EPS || cut.start >= pEnd - EPS) return [p];
      const out: { start: number; duration: number }[] = [];
      if (cut.start > p.start + EPS) out.push({ start: p.start, duration: cut.start - p.start });
      if (end < pEnd - EPS) out.push({ start: end, duration: pEnd - end });
      return out;
    });
  }
  return parts;
}

/** Insert at t: split the item crossing t and shift every part to its right. */
export function insertParts(start: number, duration: number, t: number, length: number): { start: number; duration: number }[] {
  const end = start + duration;
  if (end <= t + EPS) return [{ start, duration }];
  if (start >= t - EPS) return [{ start: start + length, duration }];
  return [{ start, duration: t - start }, { start: t + length, duration: end - t }];
}

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

/**
 * 長度可以隨意的項目（圖片 / 色板 / 文字）：放在空隙裡就縮短到剛好填滿空隙；
 * 放在別的項目上（或空隙太小）就照 fitStart 找最近的空位、長度不變。
 */
export function fitInGap(others: Span[], lane: string, start: number, duration: number, min = 0.1): { start: number; duration: number } {
  const inside = others.some((o) => o.lane === lane && start >= o.start - EPS && start < o.start + o.duration - EPS);
  if (!inside) {
    const room = nextStart(others, lane, start) - start;
    if (room >= min) return { start, duration: Math.min(duration, room) };
  }
  return { start: fitStart(others, lane, start, duration), duration };
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
