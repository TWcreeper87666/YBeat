import { create } from 'zustand';
import { afterRelease, pointerHeld } from './pointerHold';
import { parseKey, useStore, type AudioClip, type Clip, type FxItem, type Media, type Tracks } from '../store';

/** 復原 / 重做：自動記錄時間軸變更；拖曳中的變更等放開才算一步，其他連續操作（400ms 內）合併成一步 */
interface Doc { clips: Clip[]; effects: FxItem[]; audios: AudioClip[]; media: Media[]; tracks: Tracks }

const past: Doc[] = [];
let future: Doc[] = [];
let burstStart: Doc | null = null;
let timer = 0;
let applying = false;
let transaction: Doc | null = null;
const LIMIT = 200;

/**
 * 每一步都有編號：path = 從開頭走到目前狀態經過的步驟（復原 = 退一步、重做 = 再走回去）。
 * 存檔時記下 path，跟目前的 path 比 = 還沒存的步數（復原回存檔的狀態就是 0）。
 * ver：path 有變就加一，讓畫面重畫
 */
export const useHistory = create(() => ({ canUndo: false, canRedo: false, ver: 0 }));
let nextId = 1;
let path: number[] = [0];
let futureIds: number[] = [];
const touch = () => useHistory.setState((s) => ({ ver: s.ver + 1 }));
const bump = () => {
  path.push(nextId++);
  futureIds = [];
  touch();
};
export const historyPath = () => [...path];
/** 從 saved（存檔時的 path）走到目前狀態要幾步 */
export function stepsFrom(saved: number[]): number {
  let common = 0;
  while (common < saved.length && common < path.length && saved[common] === path[common]) common++;
  return saved.length - common + (path.length - common);
}
const sync = () => useHistory.setState({ canUndo: !transaction && (past.length > 0 || !!burstStart), canRedo: !transaction && future.length > 0 });

const docOf = (s: Doc): Doc => ({ clips: s.clips, effects: s.effects, audios: s.audios, media: s.media, tracks: s.tracks });

function flush() {
  clearTimeout(timer);
  if (burstStart) {
    past.push(burstStart);
    if (past.length > LIMIT) past.shift();
    burstStart = null;
    bump(); // 結算（拖曳放開 / 停 400ms）才算一步
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

/** 存檔前先把還在合併中的一步結算掉（不然存檔記下的步數會少一步） */
export function settleHistory() {
  flush();
  sync();
}

function apply(d: Doc) {
  applying = true;
  const s = useStore.getState();
  const sel = s.selection;
  const exists =
    !sel ||
    sel.type === 'module' ||
    d.clips.some((c) => c.id === sel.id || `out:${c.id}` === sel.id) ||
    d.effects.some((c) => c.id === sel.id) ||
    d.audios.some((c) => c.id === sel.id);
  // 多選裡被復原掉的項目、已經不存在的軌道也要清掉
  const ids = { clip: new Set(d.clips.map((x) => x.id)), effect: new Set(d.effects.map((x) => x.id)), audio: new Set(d.audios.map((x) => x.id)) };
  const selected = s.selected.filter((k) => {
    const { type, id } = parseKey(k);
    return ids[type]?.has(id);
  });
  const at = s.activeTrack;
  const activeTrack = at && at.idx < d.tracks[at.kind].length ? at : null;
  useStore.setState({ ...d, selection: exists ? sel : null, selected: selected.length === s.selected.length ? s.selected : selected, activeTrack });
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
      bump();
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
  bump();
  sync();
  return true;
}

export function undo() {
  // 拖曳到一半 / 放置選單還開著：先不要復原（不然放開時會把復原前的狀態又記一次）
  if (transaction) return;
  flush();
  const d = past.pop();
  if (!d) return;
  future.push(docOf(useStore.getState()));
  apply(d);
  if (path.length > 1) futureIds.push(path.pop()!);
  touch();
  sync();
}

export function redo() {
  if (transaction) return;
  flush();
  const d = future.pop();
  if (!d) return;
  past.push(docOf(useStore.getState()));
  apply(d);
  const id = futureIds.pop();
  if (id !== undefined) path.push(id);
  touch();
  sync();
}

export function resetHistory() {
  clearTimeout(timer);
  past.length = 0;
  future = [];
  burstStart = null;
  transaction = null;
  path = [nextId++];
  futureIds = [];
  touch();
  sync();
}
