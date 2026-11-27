import { $t } from '../i18n';
import { afterRelease, pointerHeld } from './pointerHold';
import { create } from 'zustand';
import { DEFAULT_FORMAT, DEFAULT_TRACKS, type Format, makeAudio, mergeModules, makeClip, useStore, type AudioClip, type Clip, type FxItem, type Marker, type Media, type Tracks } from '../store';
import type { Module } from '../modules/builtin';
import { historyPath, resetHistory, settleHistory } from './history';
import { clearDetachedMedia } from './detachedMedia';
import { colorBlob } from './colorBlob';
import { usePrefs } from '../prefs';
import { PackError, readPack, writePack, type PackProgress } from './ybeatPack';
import { pruneCaches } from './storageUsage';
import { useAutoEdit, type AeLead, type AeSeg, type AeSong, type AutoEditSettings } from './autoEditSettings';
import { clearProxyBlobs, deleteProxyBlob, proxyBlobIds } from './proxyStore';

/** 專案自動存檔：素材檔案（Blob）與時間軸存在 IndexedDB，重新整理不會遺失 */

const DB_NAME = 'ybeat';
let dbp: Promise<IDBDatabase> | null = null;

function db() {
  dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 3);
    r.onupgradeneeded = () => {
      const have = r.result.objectStoreNames;
      if (!have.contains('media')) r.result.createObjectStore('media');
      if (!have.contains('project')) r.result.createObjectStore('project');
      // 代理檔改存在 ybeat-proxy（proxyStore.ts）
      if (have.contains('proxy')) r.result.deleteObjectStore('proxy');
    };
    r.onsuccess = () => {
      const d = r.result;
      // 清除所有資料要刪掉這個資料庫：讓出連線
      d.onversionchange = () => { d.close(); dbp = null; };
      res(d);
    };
    r.onerror = () => rej(r.error);
  });
  return dbp;
}

async function run<T>(store: string, mode: IDBTransactionMode, fn: (os: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((res, rej) => {
    const tx = d.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    if (mode === 'readonly') {
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
      return;
    }
    // 寫入：等交易真的完成才算成功（空間不足之類的錯誤會在交易中止時才出現）
    tx.oncomplete = () => res(req.result);
    tx.onabort = tx.onerror = () => rej(tx.error ?? req.error);
  });
}

export const saveMediaBlob = (id: string, blob: Blob) => run('media', 'readwrite', (os) => os.put(blob, id));
export const deleteMediaBlob = (id: string) => run('media', 'readwrite', (os) => os.delete(id)).catch(() => {});
export const loadMediaBlob = (id: string) => run<Blob | undefined>('media', 'readonly', (os) => os.get(id));

interface Saved {
  media: Media[];
  clips: Clip[];
  effects: FxItem[];
  audios: AudioClip[];
  markers?: Marker[];
  tracks: Tracks;
  format?: Format;
  modules?: Module[];
  /** 自動剪輯的素材清單（全部素材 / 自選的片段） */
  autoEdit?: AutoEditPart;
}

type AutoEditPart = { pick: 'all' | 'list'; segs: AeSeg[]; lead?: AeLead | null; song?: AeSong | null; lastTake?: AutoEditSettings['lastTake'] };
const autoEditPart = (): AutoEditPart => { const a = useAutoEdit.getState(); return { pick: a.pick, segs: a.segs, lead: a.lead, song: a.song, lastTake: a.lastTake }; };
/** 載入 / 開新專案：素材清單換成這個專案的（不存在的素材拿掉） */
function setAutoEditPart(p: AutoEditPart | undefined, media: { id: string }[]) {
  const ids = new Set(media.map((m) => m.id));
  useAutoEdit.setState({
    pick: p?.pick ?? 'all', segs: (p?.segs ?? []).filter((g) => ids.has(g.mediaId)), lead: p?.lead ?? null,
    song: p?.song && ids.has(p.song.mediaId) ? p.song : null, lastTake: p?.lastTake ?? null,
  });
}

/** 存檔狀態（顯示在標題列） */
/** savedPath：上次存檔時的復原紀錄路徑（跟目前比 = 還沒存的步數） */
export const useSaveState = create<{ state: 'saved' | 'dirty' | 'saving'; at: number; savedPath: number[] }>(() => ({ state: 'saved', at: Date.now(), savedPath: historyPath() }));

let saveTimer = 0;
let started = false;

/** 上次存檔時的專案內容（物件參照）：復原回這個狀態 = 跟存檔一樣，不用再存 */
type StoreRefs = Pick<ReturnType<typeof useStore.getState>, 'media' | 'clips' | 'effects' | 'audios' | 'markers' | 'tracks' | 'format'>;
type SavedRefs = StoreRefs & { aeSegs: AeSeg[]; aePick: string; aeSong: AeSong | null; aeTake: unknown };
let savedRefs: SavedRefs | null = null;
const refsOf = (s: StoreRefs): SavedRefs => ({ media: s.media, clips: s.clips, effects: s.effects, audios: s.audios, markers: s.markers, tracks: s.tracks, format: s.format, aeSegs: useAutoEdit.getState().segs, aePick: useAutoEdit.getState().pick, aeSong: useAutoEdit.getState().song, aeTake: useAutoEdit.getState().lastTake });
const sameStore = (a: StoreRefs, b: StoreRefs) =>
  a.media === b.media && a.clips === b.clips && a.effects === b.effects && a.audios === b.audios && a.markers === b.markers && a.tracks === b.tracks && a.format.w === b.format.w && a.format.h === b.format.h; // 比例每次都是新物件，比數值
const sameRefs = (a: SavedRefs, b: SavedRefs) => sameStore(a, b) && a.aeSegs === b.aeSegs && a.aePick === b.aePick && a.aeSong === b.aeSong && a.aeTake === b.aeTake;

async function save() {
  useSaveState.setState({ state: 'saving' });
  settleHistory();
  const savedPath = historyPath();
  const s = useStore.getState();
  const refs = refsOf(s);
  const data: Saved = {
    // 圖片的 thumb 就是 blob URL，重新載入時再產生
    media: s.media.map((m) => ({ ...m, url: '', thumb: m.kind === 'image' ? '' : m.thumb })),
    clips: s.clips,
    effects: s.effects,
    audios: s.audios,
    markers: s.markers,
    tracks: s.tracks,
    format: s.format,
    modules: s.modules,
    autoEdit: autoEditPart(),
  };
  try {
    await run('project', 'readwrite', (os) => os.put(data, 'current'));
    savedRefs = refs;
    // 存檔中又有變更：還是未儲存
    const changed = !sameRefs(refsOf(useStore.getState()), refs);
    useSaveState.setState({ state: changed ? 'dirty' : 'saved', at: Date.now(), savedPath });
  } catch (e) {
    console.warn($t('專案存檔失敗'), e);
    useSaveState.setState({ state: 'dirty' });
  }
}

/** 立即存檔（Ctrl+S） */
export function saveNow() {
  clearTimeout(saveTimer);
  return save();
}

const saveSoon = () => {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(save, 600);
};

function startAutosave() {
  if (started) return;
  started = true;
  const changed = () => {
    clearTimeout(saveTimer);
    // 復原回存檔時的狀態 = 已儲存
    if (savedRefs && sameRefs(refsOf(useStore.getState()), savedRefs)) return useSaveState.setState({ state: 'saved' });
    useSaveState.setState({ state: 'dirty' });
    if (!usePrefs.getState().autosave) return;
    // 拖曳中不存，放開才存
    if (pointerHeld()) afterRelease(saveSoon);
    else saveTimer = window.setTimeout(save, 600);
  };
  useStore.subscribe((s, p) => { if (!sameStore(s, p)) changed(); });
  // 自動剪輯的素材清單、歌、上一版也存在專案裡
  useAutoEdit.subscribe((s, p) => { if (s.segs !== p.segs || s.pick !== p.pick || s.song !== p.song || s.lastTake !== p.lastTake) changed(); });
  // 重新打開自動儲存：有沒存的變更就馬上存
  usePrefs.subscribe((s, p) => {
    if (s.autosave && !p.autosave && useSaveState.getState().state === 'dirty') saveSoon();
  });
}

let restored: Promise<void> | null = null;
/** 專案載入完成（還沒開始載入 = 馬上完成） */
export const projectRestored = () => restored ?? Promise.resolve();

export function restoreProject(): Promise<void> {
  return (restored ??= loadProject());
}

async function loadProject() {
  try {
    const data = await run<Saved | undefined>('project', 'readonly', (os) => os.get('current'));
    if (data) {
      // 復原紀錄不跨重新載入；清除先前自動隱藏、已無引用的素材 Blob。
      try {
        const keep = new Set(data.media.map((m) => m.id));
        const keys = await run<IDBValidKey[]>('media', 'readonly', (os) => os.getAllKeys());
        for (const id of keys) if (typeof id === 'string' && !keep.has(id)) await deleteMediaBlob(id);
        const pk = await proxyBlobIds().catch(() => []);
        for (const id of pk) if (typeof id === 'string' && !keep.has(id)) await deleteProxyBlob(id);
        await pruneCaches(keep);
      } catch (e) { console.warn($t('素材清理失敗'), e); }
      const media: Media[] = [];
      const referenced = new Set([...(data.clips ?? []), ...(data.audios ?? [])].map((c) => c.mediaId));
      for (const m of data.media) {
        const color = m.color;
        // 色板：時間軸沒用到就不載入；資料不見就重新產生（不會變成遺失）
        if (color && !referenced.has(m.id)) continue;
        let blob = await loadMediaBlob(m.id).catch(() => undefined);
        if (!blob && color) {
          blob = (await colorBlob(color)) ?? undefined;
          if (blob) await saveMediaBlob(m.id, blob).catch(() => {});
        }
        if (!blob) {
          // 檔案不見了：時間軸有用到 → 保留資訊（名稱、長度），標記為遺失，讓使用者重新連結；
          // 沒用到 → 直接不載入（跟刪掉最後一個片段時自動移除遺失素材一樣）
          if (referenced.has(m.id)) media.push({ ...m, url: '', thumb: m.kind === 'image' ? '' : m.thumb, missing: true });
          continue;
        }
        const url = URL.createObjectURL(blob);
        media.push({ ...m, url, thumb: m.kind === 'image' ? url : m.thumb, missing: false });
      }
      // 片段引用了完全不存在的素材 → 補一筆遺失紀錄，才能在素材庫看到並重新連結
      const known = new Set(media.map((m) => m.id));
      for (const c of [...(data.clips ?? []), ...(data.audios ?? [])]) {
        if ((c as Clip).text || known.has(c.mediaId)) continue;
        known.add(c.mediaId);
        const isAudio = (data.audios ?? []).some((a) => a.mediaId === c.mediaId);
        media.push({ id: c.mediaId, name: $t('未知素材'), kind: isAudio ? 'audio' : 'video', url: '', width: 1080, height: 1920, duration: c.duration, thumb: '', hasAudio: isAudio, missing: true });
      }
      useStore.setState({
        media,
        clips: (data.clips ?? []).map((c) => makeClip(c)),
        effects: data.effects ?? [],
        audios: (data.audios ?? []).map((a) => makeAudio(a)),
        markers: data.markers ?? [],
        tracks: data.tracks ?? DEFAULT_TRACKS,
        format: data.format ?? DEFAULT_FORMAT,
        ...(data.modules ? { modules: mergeModules(data.modules) } : {}),
      });
      setAutoEditPart(data.autoEdit, media);
    }
  } catch (e) {
    console.warn($t('讀取專案失敗'), e);
  }
  resetHistory();
  savedRefs = refsOf(useStore.getState());
  useSaveState.setState({ state: 'saved', savedPath: historyPath() });
  startAutosave();
}

export async function newProject() {
  clearDetachedMedia();
  useStore.setState({
    media: [], clips: [], effects: [], audios: [], markers: [], tracks: DEFAULT_TRACKS, format: DEFAULT_FORMAT,
    selection: null, selected: [], time: 0, playing: false, loop: null,
  });
  setAutoEditPart(undefined, []);
  resetHistory();
  await run('media', 'readwrite', (os) => os.clear()).catch(() => {});
  await clearProxyBlobs();
  await pruneCaches(new Set());
  await saveNow();
}

const packProject = (s: ReturnType<typeof useStore.getState>): Saved => ({
  media: s.media.map((m) => ({ ...m, url: '', thumb: m.kind === 'image' ? '' : m.thumb })),
  clips: s.clips, effects: s.effects, audios: s.audios, markers: s.markers, tracks: s.tracks, format: s.format, modules: s.modules,
  autoEdit: autoEditPart(),
});

/** 可攜專案包：時間軸、模組及所有可用素材放進同一個檔案（格式見 ybeatPack.ts）。 */
export async function exportProjectPack(onProgress?: PackProgress): Promise<Blob> {
  const s = useStore.getState();
  const project = packProject(s);
  const media: { id: string; blob: Blob }[] = [];
  onProgress?.(0, s.media.length * 2);
  for (const [i, m] of s.media.entries()) {
    const blob = await loadMediaBlob(m.id);
    if (blob) media.push({ id: m.id, blob });
    onProgress?.(i + 1, s.media.length * 2);
  }
  return writePack(project, media, (done) => { if (done) onProgress?.(s.media.length + done, s.media.length * 2); });
}

const isSaved = (p: Record<string, unknown>): p is Record<string, unknown> & Saved =>
  Array.isArray(p.media) && Array.isArray(p.clips) && Array.isArray(p.effects) && Array.isArray(p.audios) && !!p.tracks && typeof p.tracks === 'object'
  && p.media.every((m) => !!m && typeof m === 'object' && typeof (m as Media).id === 'string');

/** 先驗證整包（含素材雜湊），再取代目前專案；失敗時目前專案不動。 */
export async function importProjectPack(file: Blob, onProgress?: PackProgress): Promise<void> {
  let pack: Awaited<ReturnType<typeof readPack>>;
  try {
    pack = await readPack(file, onProgress);
  } catch (e) {
    if (e instanceof PackError) { console.warn('ybeat pack:', e.message); throw new Error($t('無效的專案包')); }
    throw e;
  }
  const project = pack.manifest.project as Record<string, unknown>;
  if (!isSaved(project)) throw new Error($t('無效的專案包'));
  const ids = new Set(project.media.map((m) => m.id));
  if ([...pack.blobs.keys()].some((id) => !ids.has(id))) throw new Error($t('無效的專案包'));
  const decoded = pack.blobs;
  const media: Media[] = [];
  clearTimeout(saveTimer);
  clearDetachedMedia();
  const old = useStore.getState().media;
  const d = await db();
  await new Promise<void>((resolve, reject) => {
    const tx = d.transaction('media', 'readwrite');
    const os = tx.objectStore('media');
    os.clear();
    for (const [id, blob] of decoded) os.put(blob, id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  for (const m of project.media) {
    const blob = decoded.get(m.id);
    const url = blob ? URL.createObjectURL(blob) : '';
    media.push({ ...m, url, thumb: m.kind === 'image' ? url : m.thumb, missing: !blob });
  }
  for (const m of old) if (m.url.startsWith('blob:')) URL.revokeObjectURL(m.url);
  useStore.setState({
    media, clips: project.clips.map(makeClip), effects: project.effects,
    audios: project.audios.map(makeAudio), tracks: project.tracks,
    markers: project.markers ?? [],
    format: project.format ?? DEFAULT_FORMAT,
    ...(project.modules ? { modules: mergeModules(project.modules) } : {}),
    selection: null, selected: [], time: 0, playing: false, loop: null,
  });
  setAutoEditPart(project.autoEdit, media);
  resetHistory();
  await pruneCaches(ids);
  await saveNow();
}
