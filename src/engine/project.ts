import { $t } from '../i18n';
import { create } from 'zustand';
import { DEFAULT_FORMAT, DEFAULT_TRACKS, type Format, makeAudio, mergeModules, makeClip, useStore, type AudioClip, type Clip, type FxItem, type Media, type Tracks } from '../store';
import type { Module } from '../modules/builtin';
import { resetHistory } from './history';
import { clearDetachedMedia } from './detachedMedia';
import { colorBlob } from './colorBlob';

/** 專案自動存檔：素材檔案（Blob）與時間軸存在 IndexedDB，重新整理不會遺失 */

const DB_NAME = 'ybeat';
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

export const saveMediaBlob = (id: string, blob: Blob) => run('media', 'readwrite', (os) => os.put(blob, id)).catch((e) => console.warn($t('素材存檔失敗'), e));
export const deleteMediaBlob = (id: string) => run('media', 'readwrite', (os) => os.delete(id)).catch(() => {});
const loadMediaBlob = (id: string) => run<Blob | undefined>('media', 'readonly', (os) => os.get(id));

interface Saved {
  media: Media[];
  clips: Clip[];
  effects: FxItem[];
  audios: AudioClip[];
  tracks: Tracks;
  format?: Format;
  modules?: Module[];
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
    format: s.format,
    modules: s.modules,
  };
  try {
    await run('project', 'readwrite', (os) => os.put(data, 'current'));
    useSaveState.setState({ state: 'saved', at: Date.now() });
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

function startAutosave() {
  if (started) return;
  started = true;
  useStore.subscribe((s, p) => {
    if (s.media === p.media && s.clips === p.clips && s.effects === p.effects && s.audios === p.audios && s.tracks === p.tracks && s.format === p.format) return;
    useSaveState.setState({ state: 'dirty' });
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(save, 600);
  });
}

export async function restoreProject() {
  try {
    const data = await run<Saved | undefined>('project', 'readonly', (os) => os.get('current'));
    if (data) {
      // 復原紀錄不跨重新載入；清除先前自動隱藏、已無引用的素材 Blob。
      try {
        const keep = new Set(data.media.map((m) => m.id));
        const keys = await run<IDBValidKey[]>('media', 'readonly', (os) => os.getAllKeys());
        for (const id of keys) if (typeof id === 'string' && !keep.has(id)) await deleteMediaBlob(id);
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
        tracks: data.tracks ?? DEFAULT_TRACKS,
        format: data.format ?? DEFAULT_FORMAT,
        ...(data.modules ? { modules: mergeModules(data.modules) } : {}),
      });
    }
  } catch (e) {
    console.warn($t('讀取專案失敗'), e);
  }
  resetHistory();
  startAutosave();
}

export async function newProject() {
  clearDetachedMedia();
  useStore.setState({
    media: [], clips: [], effects: [], audios: [], tracks: DEFAULT_TRACKS, format: DEFAULT_FORMAT,
    selection: null, selected: [], time: 0, playing: false, loop: null,
  });
  resetHistory();
  await run('media', 'readwrite', (os) => os.clear()).catch(() => {});
  await saveNow();
}

interface ProjectPack { type: 'ybeat-project'; version: 1; project: Saved; blobs: Record<string, { type: string; base64: string }> }

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function base64ToBlob(base64: string, type: string): Blob {
  const raw = atob(base64);
  const parts: ArrayBuffer[] = [];
  for (let i = 0; i < raw.length; i += 65536) {
    const chunk = raw.slice(i, i + 65536);
    const bytes = new Uint8Array(chunk.length);
    for (let j = 0; j < chunk.length; j++) bytes[j] = chunk.charCodeAt(j);
    parts.push(bytes.buffer);
  }
  return new Blob(parts, { type });
}

/** 可攜專案包：時間軸、模組及所有可用素材放進同一個檔案。 */
export async function exportProjectPack(): Promise<Blob> {
  const s = useStore.getState();
  const project: Saved = {
    media: s.media.map((m) => ({ ...m, url: '', thumb: m.kind === 'image' ? '' : m.thumb })),
    clips: s.clips, effects: s.effects, audios: s.audios, tracks: s.tracks, format: s.format, modules: s.modules,
  };
  const blobs: ProjectPack['blobs'] = {};
  for (const m of s.media) {
    const blob = await loadMediaBlob(m.id);
    if (!blob) continue;
    blobs[m.id] = { type: blob.type, base64: await blobToBase64(blob) };
  }
  return new Blob([JSON.stringify({ type: 'ybeat-project', version: 1, project, blobs } satisfies ProjectPack)], { type: 'application/json' });
}

/** 先驗證整包，再取代目前專案。 */
export async function importProjectPack(file: Blob): Promise<void> {
  const pack = JSON.parse(await file.text()) as ProjectPack;
  if (!pack || pack.type !== 'ybeat-project' || pack.version !== 1 || !pack.project || !Array.isArray(pack.project.media) || !Array.isArray(pack.project.clips) || !Array.isArray(pack.project.effects) || !Array.isArray(pack.project.audios) || !pack.project.tracks || !pack.blobs) throw new Error($t('無效的專案包'));
  const media: Media[] = [];
  const decoded = new Map<string, Blob>();
  for (const m of pack.project.media) {
    const entry = pack.blobs[m.id];
    if (entry) decoded.set(m.id, base64ToBlob(entry.base64, entry.type));
  }
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
  });
  for (const m of pack.project.media) {
    const blob = decoded.get(m.id);
    const url = blob ? URL.createObjectURL(blob) : '';
    media.push({ ...m, url, thumb: m.kind === 'image' ? url : m.thumb, missing: !blob });
  }
  for (const m of old) if (m.url.startsWith('blob:')) URL.revokeObjectURL(m.url);
  useStore.setState({
    media, clips: pack.project.clips.map(makeClip), effects: pack.project.effects,
    audios: pack.project.audios.map(makeAudio), tracks: pack.project.tracks,
    format: pack.project.format ?? DEFAULT_FORMAT,
    ...(pack.project.modules ? { modules: mergeModules(pack.project.modules) } : {}),
    selection: null, selected: [], time: 0, playing: false, loop: null,
  });
  resetHistory();
  await saveNow();
}
