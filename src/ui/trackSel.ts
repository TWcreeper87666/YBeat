import { create } from 'zustand';
import type { TrackKind } from '../store';

/** 軌道多選（Ctrl / Shift 點軌道標籤）：一起拖曳改順序 */
export type Row = { kind: TrackKind; idx: number };
export const rowKey = (r: Row) => `${r.kind}:${r.idx}`;

export const useTrackSel = create<{ keys: string[]; anchor: string | null }>(() => ({ keys: [], anchor: null }));

/** 點軌道標籤：一般點 = 只選這條；Ctrl = 加選 / 取消；Shift = 從上次點的軌道選到這條（畫面順序） */
export function clickTrack(rows: Row[], r: Row, mode: 'single' | 'toggle' | 'range') {
  const k = rowKey(r);
  const { keys, anchor } = useTrackSel.getState();
  if (mode === 'toggle') {
    useTrackSel.setState({ keys: keys.includes(k) ? keys.filter((x) => x !== k) : [...keys, k], anchor: k });
    return;
  }
  if (mode === 'range' && anchor) {
    const a = rows.findIndex((x) => rowKey(x) === anchor), b = rows.findIndex((x) => rowKey(x) === k);
    if (a >= 0 && b >= 0) {
      const [lo, hi] = a < b ? [a, b] : [b, a];
      useTrackSel.setState({ keys: rows.slice(lo, hi + 1).map(rowKey) });
      return;
    }
  }
  useTrackSel.setState({ keys: [k], anchor: k });
}

/**
 * 把 moving（畫面順序不變）整組插到 target 的上方 / 下方；回傳新的順序，沒變或不合法回傳 null。
 * target 本身在 moving 裡 = 放回原處。
 */
export function moveRows(rows: Row[], moving: string[], target: Row, edge: 'top' | 'bottom'): Row[] | null {
  const set = new Set(moving);
  const tk = rowKey(target);
  if (set.has(tk)) return null;
  const picked = rows.filter((r) => set.has(rowKey(r)));
  if (!picked.length) return null;
  const rest = rows.filter((r) => !set.has(rowKey(r)));
  const ti = rest.findIndex((r) => rowKey(r) === tk);
  if (ti < 0) return null;
  const out = [...rest];
  out.splice(ti + (edge === 'bottom' ? 1 : 0), 0, ...picked);
  return out.every((r, i) => r === rows[i]) ? null : out;
}

/** 整組移到最上方 / 最下方（保持原本的上下順序）；沒變回傳 null */
export function moveRowsToEnd(rows: Row[], moving: string[], to: 'top' | 'bottom'): Row[] | null {
  const set = new Set(moving);
  const picked = rows.filter((r) => set.has(rowKey(r)));
  const rest = rows.filter((r) => !set.has(rowKey(r)));
  const out = to === 'top' ? [...picked, ...rest] : [...rest, ...picked];
  return out.every((r, i) => r === rows[i]) ? null : out;
}
