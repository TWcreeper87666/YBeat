import { create } from 'zustand';
import { afterRelease, pointerHeld } from './pointerHold';
import { useStore, type AudioClip, type Clip, type FxItem, type Media, type Tracks } from '../store';

/** 復原 / 重做：自動記錄時間軸變更；拖曳中的變更等放開才算一步，其他連續操作（400ms 內）合併成一步 */
interface Doc { clips: Clip[]; effects: FxItem[]; audios: AudioClip[]; media: Media[]; tracks: Tracks }

const past: Doc[] = [];
let future: Doc[] = [];
let burstStart: Doc | null = null;
let timer = 0;
let applying = false;
let transaction: Doc | null = null;
const LIMIT = 200;

export const useHistory = create(() => ({ canUndo: false, canRedo: false }));
const sync = () => useHistory.setState({ canUndo: past.length > 0 || !!burstStart, canRedo: future.length > 0 });

const docOf = (s: Doc): Doc => ({ clips: s.clips, effects: s.effects, audios: s.audios, media: s.media, tracks: s.tracks });

function flush() {
  clearTimeout(timer);
  if (burstStart) {
    past.push(burstStart);
    if (past.length > LIMIT) past.shift();
    burstStart = null;
  }
}

useStore.subscribe((s, prev) => {
  if (applying) return;
  if (s.clips === prev.clips && s.effects === prev.effects && s.audios === prev.audios && s.media === prev.media && s.tracks === prev.tracks) return;
  if (transaction) return;
  if (!burstStart) burstStart = docOf(prev);
  future = [];
  clearTimeout(timer);
  const settle = () => {
    flush();
    sync();
  };
  // 拖曳中：中途停頓也不切成兩步，放開才結算
  if (pointerHeld()) afterRelease(settle);
  else timer = window.setTimeout(settle, 400);
  sync();
});

function apply(d: Doc) {
  applying = true;
  const sel = useStore.getState().selection;
  const exists =
    !sel ||
    sel.type === 'module' ||
    d.clips.some((c) => c.id === sel.id || `out:${c.id}` === sel.id) ||
    d.effects.some((c) => c.id === sel.id) ||
    d.audios.some((c) => c.id === sel.id);
  useStore.setState({ ...d, selection: exists ? sel : null });
  applying = false;
}

/** Keep live drag previews out of history until the user chooses a drop action. */
export function beginHistoryTransaction() {
  flush();
  transaction = docOf(useStore.getState());
  sync();
}

export function endHistoryTransaction(commit: boolean) {
  const before = transaction;
  if (!before) return;
  transaction = null;
  if (!commit) apply(before);
  else {
    const now = useStore.getState();
    if (before.clips !== now.clips || before.effects !== now.effects || before.audios !== now.audios || before.media !== now.media || before.tracks !== now.tracks) {
      past.push(before);
      if (past.length > LIMIT) past.shift();
      future = [];
    }
  }
  sync();
}

/** 目前的專案狀態（例如打開編輯視窗時記下來，取消時還原） */
export type HistoryDoc = Doc;
export const snapshotDoc = (): Doc => docOf(useStore.getState());
/** 跟記下來的狀態比，專案有沒有變更 */
export const docChanged = (d: Doc) => !sameDoc(docOf(useStore.getState()), d);
const sameDoc = (a: Doc, b: Doc) => a.clips === b.clips && a.effects === b.effects && a.audios === b.audios && a.media === b.media && a.tracks === b.tracks;

/** 還原成某個狀態；還原本身算一步，可以再 Ctrl+Z 拿回來。回傳有沒有變更 */
export function restoreDoc(d: Doc): boolean {
  flush();
  const now = docOf(useStore.getState());
  if (sameDoc(now, d)) return false;
  past.push(now);
  if (past.length > LIMIT) past.shift();
  future = [];
  apply(d);
  sync();
  return true;
}

export function undo() {
  flush();
  const d = past.pop();
  if (!d) return;
  future.push(docOf(useStore.getState()));
  apply(d);
  sync();
}

export function redo() {
  flush();
  const d = future.pop();
  if (!d) return;
  past.push(docOf(useStore.getState()));
  apply(d);
  sync();
}

export function resetHistory() {
  clearTimeout(timer);
  past.length = 0;
  future = [];
  burstStart = null;
  transaction = null;
  sync();
}
