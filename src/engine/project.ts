import { create } from 'zustand';
import { DEFAULT_TRACKS, makeAudio, makeClip, useStore, type AudioClip, type Clip, type FxItem, type Media, type Tracks } from '../store';
import { resetHistory } from './history';

/** 專案自動存檔：素材檔案（Blob）與時間軸存在 IndexedDB，重新整理不會遺失 */

const DB_NAME = 'beatsync';
let dbp: Promise<IDBDatabase> | null = null;

function db() {
  dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore('media');
      r.result.createObjectStore('project');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}

async function run<T>(store: string, mode: IDBTransactionMode, fn: (os: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((res, rej) => {
    const req = fn(d.transaction(store, mode).objectStore(store));
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

export const saveMediaBlob = (id: string, blob: Blob) => run('media', 'readwrite', (os) => os.put(blob, id)).catch((e) => console.warn('素材存檔失敗', e));
export const deleteMediaBlob = (id: string) => run('media', 'readwrite', (os) => os.delete(id)).catch(() => {});
const loadMediaBlob = (id: string) => run<Blob | undefined>('media', 'readonly', (os) => os.get(id));

interface Saved {
  media: Media[];
  clips: Clip[];
  effects: FxItem[];
  audios: AudioClip[];
  tracks: Tracks;
}

/** 存檔狀態（顯示在標題列） */
export const useSaveState = create<{ state: 'saved' | 'dirty' | 'saving'; at: number }>(() => ({ state: 'saved', at: Date.now() }));

let saveTimer = 0;
let started = false;

async function save() {
  useSaveState.setState({ state: 'saving' });
  const s = useStore.getState();
  const data: Saved = {
    // 圖片的 thumb 就是 blob URL，重新載入時再產生
    media: s.media.map((m) => ({ ...m, url: '', thumb: m.kind === 'image' ? '' : m.thumb })),
    clips: s.clips,
    effects: s.effects,
    audios: s.audios,
    tracks: s.tracks,
  };
  try {
    await run('project', 'readwrite', (os) => os.put(data, 'current'));
    useSaveState.setState({ state: 'saved', at: Date.now() });
  } catch (e) {
    console.warn('專案存檔失敗', e);
    useSaveState.setState({ state: 'dirty' });
  }
}

/** 立即存檔（Ctrl+S） */
export function saveNow() {
  clearTimeout(saveTimer);
  return save();
}

function startAutosave() {
  if (started) return;
  started = true;
  useStore.subscribe((s, p) => {
    if (s.media === p.media && s.clips === p.clips && s.effects === p.effects && s.audios === p.audios && s.tracks === p.tracks) return;
    useSaveState.setState({ state: 'dirty' });
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(save, 600);
  });
}

export async function restoreProject() {
  try {
    const data = await run<Saved | undefined>('project', 'readonly', (os) => os.get('current'));
    if (data) {
      const media: Media[] = [];
      for (const m of data.media) {
        const blob = await loadMediaBlob(m.id).catch(() => undefined);
        if (!blob) {
          // 檔案不見了：保留資訊（名稱、長度），標記為遺失，讓使用者重新連結
          media.push({ ...m, url: '', thumb: m.kind === 'image' ? '' : m.thumb, missing: true });
          continue;
        }
        const url = URL.createObjectURL(blob);
        media.push({ ...m, url, thumb: m.kind === 'image' ? url : m.thumb, missing: false });
      }
      // 片段引用了完全不存在的素材 → 補一筆遺失紀錄，才能在素材庫看到並重新連結
      const known = new Set(media.map((m) => m.id));
      for (const c of [...(data.clips ?? []), ...(data.audios ?? [])]) {
        if (known.has(c.mediaId)) continue;
        known.add(c.mediaId);
        const isAudio = (data.audios ?? []).some((a) => a.mediaId === c.mediaId);
        media.push({ id: c.mediaId, name: '未知素材', kind: isAudio ? 'audio' : 'video', url: '', width: 1080, height: 1920, duration: c.duration, thumb: '', hasAudio: isAudio, missing: true });
      }
      useStore.setState({
        media,
        clips: (data.clips ?? []).map((c) => makeClip(c)),
        effects: data.effects ?? [],
        audios: (data.audios ?? []).map((a) => makeAudio(a)),
        tracks: data.tracks ?? DEFAULT_TRACKS,
      });
    }
  } catch (e) {
    console.warn('讀取專案失敗', e);
  }
  resetHistory();
  startAutosave();
}

export async function newProject() {
  useStore.setState({
    media: [], clips: [], effects: [], audios: [], tracks: DEFAULT_TRACKS,
    selection: null, selected: [], time: 0, playing: false, loop: null,
  });
  resetHistory();
  await run('media', 'readwrite', (os) => os.clear()).catch(() => {});
  await saveNow();
}
