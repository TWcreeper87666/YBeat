/**
 * 用鍵盤在時間軸上換片段 / 多選：
 * - Ctrl+← / →：同一條軌道的上一個 / 下一個項目
 * - Ctrl+Shift+← / →：往旁邊延伸（或縮回）選取範圍，像選文字一樣
 * - Ctrl+Home / End：軌道上第一個 / 最後一個；加 Shift = 從目前的一路選到頭 / 尾
 * - Ctrl+↑ / ↓：換到上面 / 下面的軌道（選播放頭所在、或最接近播放頭的項目）
 */
import { KIND_OF, LIST, attachedAudioIds, displayRows, keyOf, useStore, type AnyItem, type ItemType, type TrackKind } from '../store';
import { revealSelection } from './uiStore';

type S = ReturnType<typeof useStore.getState>;
type Row = { kind: TrackKind; idx: number };
type Ref = { type: ItemType; it: AnyItem };

const TYPE_OF: Record<TrackKind, ItemType> = { video: 'clip', fx: 'effect', audio: 'audio' };

/** 這條軌道上的項目（依開頭排序；連結在影片上的原音不算，它跟著影片） */
function itemsOn(s: S, row: Row): Ref[] {
  const type = TYPE_OF[row.kind];
  const attached = type === 'audio' ? attachedAudioIds(s) : null;
  return (s[LIST[type]] as AnyItem[])
    .filter((x) => x.track === row.idx && !attached?.has(x.id))
    .sort((a, b) => a.start - b.start)
    .map((it) => ({ type, it }));
}

function find(s: S, type: ItemType, id: string): AnyItem | undefined {
  return (s[LIST[type]] as AnyItem[]).find((x) => x.id === id);
}

/** 目前操作的軌道：主選取所在的軌道 → 選中的軌道 → 最上面一條有東西的影片軌 */
function currentRow(s: S): Row | null {
  const sel = s.selection;
  if (sel && (sel.type === 'clip' || sel.type === 'effect' || sel.type === 'audio')) {
    const it = find(s, sel.type, sel.id);
    if (it) return { kind: KIND_OF[sel.type], idx: it.track };
  }
  if (s.activeTrack) return s.activeTrack;
  return displayRows(s.tracks, s.upperAt).find((r) => itemsOn(s, r).length) ?? null;
}

/** 延伸選取時移動的那一端（另一端 = 主選取） */
let focus: { type: ItemType; id: string } | null = null;

/** 選一個項目（取代選取）：播放頭不在它裡面就移到它的開頭（跟點選片段一樣） */
function pickOne(r: Ref) {
  const s = useStore.getState();
  s.select({ type: r.type, id: r.it.id });
  s.setActiveTrack({ kind: KIND_OF[r.type], idx: r.it.track });
  if (s.time < r.it.start || s.time >= r.it.start + r.it.duration) s.setTime(r.it.start);
  focus = { type: r.type, id: r.it.id };
  revealSelection(false);
}

/** 從主選取（anchor）選到 r（focus）這一段 */
function extendTo(r: Ref) {
  const s = useStore.getState();
  s.select({ type: r.type, id: r.it.id }, 'range');
  focus = { type: r.type, id: r.it.id };
  revealSelection(false);
}

/** 目前「游標」在哪一個項目：延伸中 = focus，不然 = 主選取 */
function cursor(s: S, list: Ref[]): number {
  const sel = s.selection;
  const f = focus && s.selected.includes(keyOf(focus.type, focus.id)) ? focus : sel && (sel.type === 'clip' || sel.type === 'effect' || sel.type === 'audio') ? { type: sel.type, id: sel.id } : null;
  return f ? list.findIndex((r) => r.type === f.type && r.it.id === f.id) : -1;
}

/** Ctrl(+Shift)+← / → */
export function navItem(dir: -1 | 1, extend: boolean) {
  const s = useStore.getState();
  const row = currentRow(s);
  if (!row) return;
  const list = itemsOn(s, row);
  if (!list.length) return;
  const i = cursor(s, list);
  let j: number;
  if (i < 0) {
    // 還沒選：從播放頭找（往右 = 播放頭上或之後的第一個；往左 = 播放頭之前或包住播放頭的最後一個）
    j = dir > 0 ? list.findIndex((r) => r.it.start + r.it.duration > s.time + 1e-6) : list.map((r) => r.it.start < s.time - 1e-6).lastIndexOf(true);
    if (j < 0) j = dir > 0 ? list.length - 1 : 0;
    return pickOne(list[j]);
  }
  j = Math.max(0, Math.min(list.length - 1, i + dir));
  if (extend && s.selection) extendTo(list[j]);
  else pickOne(list[j]);
}

/** Ctrl(+Shift)+Home / End */
export function navEdge(edge: 'first' | 'last', extend: boolean) {
  const s = useStore.getState();
  const row = currentRow(s);
  if (!row) return;
  const list = itemsOn(s, row);
  if (!list.length) return;
  const r = list[edge === 'first' ? 0 : list.length - 1];
  if (extend && s.selection && cursor(s, list) >= 0) extendTo(r);
  else pickOne(r);
}

/** Ctrl+↑ / ↓：換軌道（跳過空的軌道） */
export function navRow(dir: -1 | 1) {
  const s = useStore.getState();
  const rows = displayRows(s.tracks, s.upperAt);
  const cur = currentRow(s);
  let i = cur ? rows.findIndex((r) => r.kind === cur.kind && r.idx === cur.idx) : -1;
  for (i += dir; i >= 0 && i < rows.length; i += dir) {
    const list = itemsOn(s, rows[i]);
    if (!list.length) continue;
    // 播放頭所在的那個；沒有就選最接近播放頭的
    const at = list.find((r) => s.time >= r.it.start && s.time < r.it.start + r.it.duration);
    const dist = (r: Ref) => Math.min(Math.abs(r.it.start - s.time), Math.abs(r.it.start + r.it.duration - s.time));
    return pickOne(at ?? list.reduce((a, b) => (dist(b) < dist(a) ? b : a)));
  }
}
