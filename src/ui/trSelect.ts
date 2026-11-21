import { create } from 'zustand';
import { $t } from '../i18n';
import { displayRows, parseTrSel, trSelId, useStore, type Clip, type TrSide, type TransitionRef } from '../store';
import { sortClips, transitionWindow } from '../engine/renderer';
import { toast } from './uiStore';

/**
 * 時間軸上轉場方塊的多選、鍵盤切換、複製貼上。
 * - 主選取還是 store 的 selection（屬性面板、編輯視窗、預覽把手照舊）；這裡另外記「一起選取的轉場」
 * - 點一下 = 只選這個；Ctrl+點 = 加選 / 取消；Shift+點 = 同一條軌道上從主選取選到這裡
 * - 轉場選取中：Ctrl+← / →（加 Shift 延伸）、Ctrl+Home / End、Ctrl+↑ / ↓、Ctrl+A、Ctrl+C / X / V、Delete
 */

export const useTrSel = create<{ ids: string[] }>(() => ({ ids: [] }));

// 主選取換成別的東西（片段、特效…）→ 轉場多選清掉；主選取換成某個轉場而它不在清單裡 → 只選它
useStore.subscribe((s, p) => {
  if (s.selection === p.selection) return;
  const sel = s.selection;
  const { ids } = useTrSel.getState();
  if (sel?.type !== 'transition') {
    if (ids.length) useTrSel.setState({ ids: [] });
  } else if (!ids.includes(sel.id)) useTrSel.setState({ ids: [sel.id] });
});

interface TrInfo { id: string; clip: Clip; side: TrSide; tr: TransitionRef; track: number; t0: number; d: number }

/** 一條影片軌上生效中的轉場，依時間排序 */
function onTrack(clips: Clip[], track: number): TrInfo[] {
  const sorted = sortClips(clips.filter((c) => c.track === track));
  const out: TrInfo[] = [];
  sorted.forEach((c, i) => {
    for (const side of ['in', 'out'] as const) {
      const tr = side === 'out' ? c.transitionOut : c.transitionIn;
      const w = tr && transitionWindow(sorted[i - 1], c, side, sorted[i + 1]);
      if (tr && w) out.push({ id: trSelId(c.id, side), clip: c, side, tr, track, t0: w.t0, d: w.d });
    }
  });
  return out.sort((a, b) => a.t0 - b.t0);
}

function infoOf(id: string): TrInfo | undefined {
  const s = useStore.getState();
  const c = s.clips.find((x) => x.id === parseTrSel(id).clipId);
  return c ? onTrack(s.clips, c.track).find((t) => t.id === id) : undefined;
}

/** 選取中轉場的範圍（最早的開頭 ~ 最晚的結尾）：Home / End 用 */
export function trSelRange(): { a: number; b: number } | null {
  const sel = useStore.getState().selection;
  const ids = useTrSel.getState().ids.length ? useTrSel.getState().ids : sel?.type === 'transition' ? [sel.id] : [];
  const ws = ids.map(infoOf).filter((t): t is TrInfo => !!t);
  if (!ws.length) return null;
  return { a: Math.min(...ws.map((t) => t.t0)), b: Math.max(...ws.map((t) => t.t0 + t.d)) };
}

const revealPlayhead = () => requestAnimationFrame(() => window.dispatchEvent(new Event('timeline-reveal-playhead')));

/** 設定轉場選取；primary = 主選取（屬性面板顯示它），播放頭移到它的開頭 */
function setSel(ids: string[], primary: string | null, move = true) {
  useTrSel.setState({ ids });
  const s = useStore.getState();
  if (!primary) return s.select(null);
  s.select({ type: 'transition', id: primary });
  const t = infoOf(primary);
  if (t && move) {
    s.setTime(t.t0);
    revealPlayhead();
  }
}

/** 點轉場方塊 */
export function clickTransition(id: string, e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) {
  const { ids } = useTrSel.getState();
  const sel = useStore.getState().selection;
  const primary = sel?.type === 'transition' ? sel.id : null;
  if (e.ctrlKey || e.metaKey) {
    if (ids.includes(id)) {
      const rest = ids.filter((x) => x !== id);
      return setSel(rest, rest.length ? (primary === id ? rest[rest.length - 1] : primary) : null, false);
    }
    return setSel([...ids, id], id);
  }
  if (e.shiftKey && primary) {
    const a = infoOf(primary), b = infoOf(id);
    if (a && b && a.track === b.track) {
      const list = onTrack(useStore.getState().clips, a.track);
      const [i, j] = [list.findIndex((t) => t.id === a.id), list.findIndex((t) => t.id === b.id)].sort((x, y) => x - y);
      useTrSel.setState({ ids: list.slice(i, j + 1).map((t) => t.id) });
      return; // 主選取不變（跟選文字一樣，另一端是錨點）
    }
  }
  setSel([id], id);
}

/** 延伸選取時移動的那一端（另一端 = 主選取） */
let focus: string | null = null;

/** Ctrl(+Shift)+← / → */
export function navTransition(dir: -1 | 1, extend: boolean) {
  const sel = useStore.getState().selection;
  if (sel?.type !== 'transition') return;
  const cur = infoOf(focus && useTrSel.getState().ids.includes(focus) ? focus : sel.id);
  if (!cur) return;
  const list = onTrack(useStore.getState().clips, cur.track);
  const j = Math.max(0, Math.min(list.length - 1, list.findIndex((t) => t.id === cur.id) + dir));
  extendOrPick(list, j, extend);
}

/** Ctrl(+Shift)+Home / End */
export function navTransitionEdge(edge: 'first' | 'last', extend: boolean) {
  const sel = useStore.getState().selection;
  const cur = sel?.type === 'transition' ? infoOf(sel.id) : undefined;
  if (!cur) return;
  const list = onTrack(useStore.getState().clips, cur.track);
  extendOrPick(list, edge === 'first' ? 0 : list.length - 1, extend);
}

function extendOrPick(list: TrInfo[], j: number, extend: boolean) {
  const target = list[j];
  if (!target) return;
  const sel = useStore.getState().selection;
  if (extend && sel?.type === 'transition') {
    const a = list.findIndex((t) => t.id === sel.id);
    const [lo, hi] = [a, j].sort((x, y) => x - y);
    useTrSel.setState({ ids: list.slice(lo, hi + 1).map((t) => t.id) });
    focus = target.id;
    useStore.getState().setTime(target.t0);
    revealPlayhead();
    return;
  }
  focus = target.id;
  setSel([target.id], target.id);
}

/** Ctrl+↑ / ↓：換到上面 / 下面有轉場的影片軌（選最接近播放頭的） */
export function navTransitionRow(dir: -1 | 1) {
  const s = useStore.getState();
  const sel = s.selection;
  const cur = sel?.type === 'transition' ? infoOf(sel.id) : undefined;
  if (!cur) return;
  // 照畫面上的軌道順序（跟 Ctrl+↑ / ↓ 換片段一樣），只看影片軌
  const rows = displayRows(s.tracks, s.upperAt).filter((r) => r.kind === 'video');
  const i = rows.findIndex((r) => r.idx === cur.track);
  for (let k = i + dir; k >= 0 && k < rows.length; k += dir) {
    const list = onTrack(s.clips, rows[k].idx);
    if (!list.length) continue;
    const best = list.reduce((a, b) => (Math.abs(b.t0 + b.d / 2 - s.time) < Math.abs(a.t0 + a.d / 2 - s.time) ? b : a));
    focus = best.id;
    return setSel([best.id], best.id);
  }
}

/** Ctrl+A：同一條軌道上的所有轉場 */
export function selectAllTransitions() {
  const sel = useStore.getState().selection;
  const cur = sel?.type === 'transition' ? infoOf(sel.id) : undefined;
  if (!cur) return;
  useTrSel.setState({ ids: onTrack(useStore.getState().clips, cur.track).map((t) => t.id) });
}

// ───────── 複製 / 貼上 / 刪除 ─────────

let clipboard: TransitionRef | null = null;
export const hasTransitionClipboard = () => !!clipboard;

/** 複製主選取的轉場（種類、參數、長度） */
export function copyTransition(id?: string): boolean {
  const sel = useStore.getState().selection;
  const t = infoOf(id ?? (sel?.type === 'transition' ? sel.id : ''));
  if (!t) return false;
  clipboard = structuredClone(t.tr);
  toast($t('已複製轉場'));
  return true;
}

/** 貼上到所有選取的轉場（取代種類、參數、長度） */
export function pasteTransition(): number {
  if (!clipboard) return 0;
  const { ids } = useTrSel.getState();
  const s = useStore.getState();
  const byClip = new Map<string, Partial<Clip>>();
  for (const id of ids) {
    const { clipId, side } = parseTrSel(id);
    const p = byClip.get(clipId) ?? {};
    p[side === 'out' ? 'transitionOut' : 'transitionIn'] = structuredClone(clipboard);
    byClip.set(clipId, p);
  }
  if (!byClip.size) return 0;
  useStore.setState({ clips: s.clips.map((c) => (byClip.has(c.id) ? { ...c, ...byClip.get(c.id) } : c)) });
  toast($t('已貼上到 {0} 個轉場', ids.length));
  return ids.length;
}

/** 移除所有選取的轉場 */
export function removeTransitions(): number {
  const { ids } = useTrSel.getState();
  if (!ids.length) return 0;
  const s = useStore.getState();
  const byClip = new Map<string, Partial<Clip>>();
  for (const id of ids) {
    const { clipId, side } = parseTrSel(id);
    const p = byClip.get(clipId) ?? {};
    p[side === 'out' ? 'transitionOut' : 'transitionIn'] = null;
    byClip.set(clipId, p);
  }
  // 選取改回第一個轉場所在的片段（跟移除單一轉場一樣）
  const first = parseTrSel(ids[0]).clipId;
  useTrSel.setState({ ids: [] });
  useStore.setState({ clips: s.clips.map((c) => (byClip.has(c.id) ? { ...c, ...byClip.get(c.id) } : c)), selection: { type: 'clip', id: first }, selected: [`clip:${first}`] });
  return ids.length;
}

export function cutTransitions() {
  if (copyTransition()) removeTransitions();
}
