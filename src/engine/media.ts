import { uid, useStore, type Media } from '../store';
import { PEAKS_PER_SEC, computePeaks, getAudioBuffer } from './audio';
import { deleteMediaBlob, saveMediaBlob } from './project';
import { toast } from '../ui/uiStore';

function once(el: HTMLElement, ev: string) {
  return new Promise<void>((res, rej) => {
    el.addEventListener(ev, () => res(), { once: true });
    el.addEventListener('error', () => rej(new Error('無法讀取檔案')), { once: true });
  });
}

const MAX_DECODE = 400 * 1024 * 1024; // 太大的影片不預先解碼音訊

async function audioInfo(url: string, size: number) {
  if (size > MAX_DECODE) return { hasAudio: true };
  const buf = await getAudioBuffer(url);
  if (!buf) return { hasAudio: false };
  return { hasAudio: true, peaks: computePeaks(buf), peaksPerSec: PEAKS_PER_SEC, duration: buf.duration };
}

export async function importFile(file: Blob, name: string): Promise<Media | null> {
  const url = URL.createObjectURL(file);
  const type = file.type;
  if (type.startsWith('image/')) {
    const img = new Image();
    img.src = url;
    await img.decode();
    return { id: uid(), name, kind: 'image', url, width: img.naturalWidth, height: img.naturalHeight, duration: 3600, thumb: url, hasAudio: false };
  }
  if (type.startsWith('audio/')) {
    const info = await audioInfo(url, 0);
    if (!info.hasAudio || !info.duration) {
      URL.revokeObjectURL(url);
      throw new Error('無法解碼音訊');
    }
    return { id: uid(), name, kind: 'audio', url, width: 0, height: 0, duration: info.duration, thumb: '', hasAudio: true, peaks: info.peaks, peaksPerSec: info.peaksPerSec };
  }
  if (type.startsWith('video/')) {
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'auto';
    v.src = url;
    await once(v, 'loadedmetadata');
    if (!Number.isFinite(v.duration)) {
      // MediaRecorder 錄的 webm 沒寫長度：seek 到很後面讓瀏覽器算出真實長度
      v.currentTime = 1e9;
      await once(v, 'seeked');
    }
    v.currentTime = Math.min(0.1, v.duration / 2);
    await once(v, 'seeked');
    const c = document.createElement('canvas');
    c.width = 160;
    c.height = Math.round((160 * v.videoHeight) / v.videoWidth);
    c.getContext('2d')!.drawImage(v, 0, 0, c.width, c.height);
    const info = await audioInfo(url, file.size);
    return {
      id: uid(), name, kind: 'video', url,
      width: v.videoWidth, height: v.videoHeight, duration: v.duration,
      thumb: c.toDataURL('image/jpeg', 0.7),
      hasAudio: info.hasAudio, peaks: info.peaks, peaksPerSec: info.peaksPerSec,
    };
  }
  URL.revokeObjectURL(url);
  return null;
}

/** 匯入並存進專案（IndexedDB） */
export async function addMediaBlob(blob: Blob, name: string) {
  const m = await importFile(blob, name);
  if (!m) return null;
  await saveMediaBlob(m.id, blob);
  useStore.getState().addMedia(m);
  return m;
}

export async function importFiles(files: FileList | File[]) {
  let ok = 0;
  const bad: string[] = [];
  for (const f of Array.from(files)) {
    try {
      if (await addMediaBlob(f, f.name)) ok++;
      else bad.push(f.name);
    } catch (e) {
      console.warn('匯入失敗', f.name, e);
      bad.push(f.name);
    }
  }
  if (ok) toast(`已匯入 ${ok} 個檔案`);
  if (bad.length) toast(`無法匯入：${bad.join('、')}`, 'error');
}

/** 開啟檔案選擇視窗 */
export function pickFiles(accept = 'video/*,image/*,audio/*', multiple = true): Promise<File[]> {
  return new Promise((res) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.onchange = () => res(Array.from(input.files ?? []));
    input.click();
  });
}

/** 為遺失（或要替換）的素材選一個新檔案，所有使用它的片段都會改用新檔 */
export async function relinkWithPicker(oldId: string) {
  const old = useStore.getState().media.find((m) => m.id === oldId);
  const accept = old?.kind === 'audio' ? 'audio/*,video/*' : old?.kind === 'image' ? 'image/*,video/*' : 'video/*,image/*';
  const [file] = await pickFiles(accept, false);
  if (!file) return;
  try {
    const m = await addMediaBlob(file, file.name);
    if (!m) return toast('無法讀取這個檔案', 'error');
    useStore.getState().relinkMedia(oldId, m.id);
    toast(`已重新連結「${old?.name ?? ''}」→「${m.name}」`);
  } catch {
    toast('無法讀取這個檔案', 'error');
  }
}

/** 從素材庫移除：沒被使用就直接刪；被使用就變成「遺失」狀態，片段保留 */
export function removeMedia(id: string) {
  const s = useStore.getState();
  const m = s.media.find((x) => x.id === id);
  if (!m) return;
  const used = s.clips.some((c) => c.mediaId === id) || s.audios.some((a) => a.mediaId === id);
  if (m.url) URL.revokeObjectURL(m.url);
  deleteMediaBlob(id);
  if (used) {
    useStore.setState({ media: s.media.map((x) => (x.id === id ? { ...x, url: '', thumb: x.kind === 'image' ? '' : x.thumb, missing: true } : x)) });
    toast(`「${m.name}」已移除，使用中的片段標記為遺失`);
  } else {
    useStore.setState({ media: s.media.filter((x) => x.id !== id) });
  }
}
