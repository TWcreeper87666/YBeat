import { create } from 'zustand';
import { afterRelease, pointerHeld } from './pointerHold';
import { parseKey, useStore, type AudioClip, type Clip, type FxItem, type Marker, type Media, type Tracks } from '../store';

/** 輸出尺寸也算專案內容：改比例可以復原 */
type Format = { w: number; h: number };

/** 復原 / 重做：自動記錄時間軸變更；拖曳中的變更等放開才算一步，其他連續操作（400ms 內）合併成一步 */
/** aux：專案以外、也要一起復原的狀態（例如自動剪輯面板的設定），見 trackHistory */
interface Doc { clips: Clip[]; effects: FxItem[]; audios: AudioClip[]; markers: Marker[]; media: Media[]; tracks: Tracks; format: Format; aux: Record<string, Record<string, unknown>> }
type Proj = Omit<Doc, 'aux'>;

/** pick 回傳要記錄的欄位（每個欄位用參照比較），put 還原 */
interface Side { key: string; pick: () => Record<string, unknown>; put: (v: Record<string, unknown>) => void }
const sides: Side[] = [];
const auxNow = (key?: string, val?: Record<string, unknown>): Doc['aux'] => Object.fromEntries(sides.map((x) => [x.key, x.key === key ? val! : x.pick()]));
const shallowSame = (a: Record<string, unknown> | undefined, b: Record<string, unknown> | undefined) =>
  a === b || (!!a && !!b && Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((k) => a[k] === b[k]));
const sameAux = (a: Doc['aux'], b: Doc['aux']) => sides.every((x) => shallowSame(a[x.key], b[x.key]));

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

const docOf = (s: Proj, aux: Doc['aux'] = auxNow()): Doc => ({ clips: s.clips, effects: s.effects, audios: s.audios, markers: s.markers, media: s.media, tracks: s.tracks, format: s.format, aux });

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
  if (sameProj(s, prev)) return;
  changed(docOf(prev));
});

/** 有變更：記下這一串變更開始前的狀態，等停下來 / 放開再結算成一步 */
function changed(before: Doc) {
  if (transaction) return;
  if (!burstStart) burstStart = before;
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
}

/** 讓另一個 store 的部分狀態也能復原（跟時間軸變更排在同一條復原紀錄裡） */
export function trackHistory<T>(key: string, store: { getState(): T; subscribe(fn: (s: T, prev: T) => void): () => void }, pick: (s: T) => Record<string, unknown>, put: (v: Record<string, unknown>) => void) {
  sides.push({ key, pick: () => pick(store.getState()), put });
  store.subscribe((s, prev) => {
    if (applying) return;
    const a = pick(prev);
    if (shallowSame(a, pick(s))) return;
    changed(docOf(useStore.getState(), auxNow(key, a)));
  });
}

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
  const { aux, ...proj } = d;
  useStore.setState({ ...proj, selection: exists ? sel : null, selected: selected.length === s.selected.length ? s.selected : selected, activeTrack });
  for (const x of sides) if (aux[x.key] && !shallowSame(aux[x.key], x.pick())) x.put(aux[x.key]);
  applying = false;
}

/** Keep live drag previews out of history until the user chooses a drop action. */
let depth = 0;
export function beginHistoryTransaction() {
  // 巢狀：只有最外層記錄開始狀態、結算
  if (depth++ > 0) return;
  flush();
  transaction = docOf(useStore.getState());
  sync();
}

export function endHistoryTransaction(commit: boolean) {
  if (depth > 1) {
    depth--;
    return;
  }
  depth = 0;
  const before = transaction;
  if (!before) return;
  transaction = null;
  if (!commit) apply(before);
  else {
    if (!sameDoc(before, docOf(useStore.getState()))) {
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
/** 跟記下來的狀態比，專案有沒有變更（只看專案；面板設定之類的不算） */
export const docChanged = (d: Doc) => !sameProj(docOf(useStore.getState()), d);
function sameProj(a: Proj, b: Proj) {
  return a.clips === b.clips && a.effects === b.effects && a.audios === b.audios && a.markers === b.markers && a.media === b.media && a.tracks === b.tracks && a.format === b.format;
}
const sameDoc = (a: Doc, b: Doc) => sameProj(a, b) && sameAux(a.aux, b.aux);

/** 還原成某個狀態的專案內容（面板設定之類的保持現在的樣子）；還原本身算一步，可以再 Ctrl+Z 拿回來。回傳有沒有變更 */
export function restoreDoc(saved: Doc): boolean {
  flush();
  const now = docOf(useStore.getState());
  const d = { ...saved, aux: now.aux };
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

/** 最後一步併進前一步（前一步要是 step）：例如 AI 改設定 + 接著產生的剪輯 = 一次復原；成功回傳 true */
export function mergeIntoStep(step: number): boolean {
  if (transaction) return false;
  flush();
  if (path.length < 3 || path[path.length - 2] !== step || past.length < 2) return false;
  past.pop();
  path.pop();
  touch();
  sync();
  return true;
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
