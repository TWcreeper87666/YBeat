import { create } from 'zustand';
import { useStore, type AudioClip, type Clip, type FxItem, type Tracks } from '../store';

/** 復原 / 重做：自動記錄時間軸變更，連續的拖曳 / 滑桿操作（400ms 內）合併成一步 */
interface Doc { clips: Clip[]; effects: FxItem[]; audios: AudioClip[]; tracks: Tracks }

const past: Doc[] = [];
let future: Doc[] = [];
let burstStart: Doc | null = null;
let timer = 0;
let applying = false;
const LIMIT = 200;

export const useHistory = create(() => ({ canUndo: false, canRedo: false }));
const sync = () => useHistory.setState({ canUndo: past.length > 0 || !!burstStart, canRedo: future.length > 0 });

const docOf = (s: Doc): Doc => ({ clips: s.clips, effects: s.effects, audios: s.audios, tracks: s.tracks });

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
  if (s.clips === prev.clips && s.effects === prev.effects && s.audios === prev.audios && s.tracks === prev.tracks) return;
  if (!burstStart) burstStart = docOf(prev);
  future = [];
  clearTimeout(timer);
  timer = window.setTimeout(() => {
    flush();
    sync();
  }, 400);
  sync();
});

function apply(d: Doc) {
  applying = true;
  const sel = useStore.getState().selection;
  const exists =
    !sel ||
    sel.type === 'module' ||
    d.clips.some((c) => c.id === sel.id) ||
    d.effects.some((c) => c.id === sel.id) ||
    d.audios.some((c) => c.id === sel.id);
  useStore.setState({ ...d, selection: exists ? sel : null });
  applying = false;
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
  sync();
}
