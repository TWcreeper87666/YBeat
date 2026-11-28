import { dropMatte } from './matte';
import { dropFaces } from './face';
import { dropMediaAnalysis } from './analysisStore';
import { useAutoEdit } from './autoEditSettings';
import { dropBoxTracks } from './boxTrack';
import { colorBlob } from './colorBlob';
import { $t } from '../i18n';
import { uid, usedMediaIds, useStore, type Media } from '../store';
import { PEAKS_PER_SEC, computePeaks, getAudioBuffer } from './audio';
import { deleteMediaBlob, saveMediaBlob } from './project';
import { detachedMedia, detachedMediaOrder } from './detachedMedia';
import { setBusy, toast } from '../ui/uiStore';

function once(el: HTMLElement, ev: string) {
  return new Promise<void>((res, rej) => {
    el.addEventListener(ev, () => res(), { once: true });
    el.addEventListener('error', () => rej(new Error($t('無法讀取檔案'))), { once: true });
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
      throw new Error($t('無法解碼音訊'));
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
    const c = document.createElement('canvas');
    c.width = 160;
    c.height = Math.round((160 * v.videoHeight) / v.videoWidth);
    const g = c.getContext('2d', { willReadFrequently: true })!;
    /** 畫出 t 秒那格，回傳平均亮度（0~255） */
    const grab = async (t: number) => {
      v.currentTime = t;
      await once(v, 'seeked');
      // seeked 時那格不一定已經解好（直接畫會是黑的）：等它真的出來（最多 300ms）
      const vv = v as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number };
      if (vv.requestVideoFrameCallback) await Promise.race([new Promise<void>((r) => vv.requestVideoFrameCallback!(() => r())), new Promise((r) => setTimeout(r, 300))]);
      g.drawImage(v, 0, 0, c.width, c.height);
      const px = g.getImageData(0, 0, c.width, c.height).data;
      let sum = 0;
      for (let i = 0; i < px.length; i += 4) sum += px[i] * 0.3 + px[i + 1] * 0.59 + px[i + 2] * 0.11;
      return sum / (px.length / 4);
    };
    // 開頭幾乎全黑（錄影剛開始、淡入）：改用後面比較亮的一格當縮圖
    let best = { t: Math.min(0.1, v.duration / 2), y: 0 };
    best.y = await grab(best.t);
    if (best.y < 12) {
      for (const f of [0.25, 0.5]) {
        const t = v.duration * f;
        const y = await grab(t);
        if (y > best.y) best = { t, y };
        if (y >= 12) break;
      }
      await grab(best.t);
    }
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
  // 存不進去（例如空間不足）就不加進專案，免得重開後變成遺失素材
  try {
    await saveMediaBlob(m.id, blob);
  } catch (e) {
    console.warn($t('素材存檔失敗'), name, e);
    URL.revokeObjectURL(m.url);
    toast($t('素材存檔失敗：{0}', name), 'error');
    return null;
  }
  useStore.getState().addMedia(m);
  return m;
}

/** 一個一個匯入，底部顯示進度（第幾個 / 共幾個、檔名）；each：每個匯入成功的素材（例如放到時間軸） */
export async function addMediaFiles(files: File[], each?: (m: Media) => void): Promise<{ ok: number; bad: string[] }> {
  let ok = 0;
  const bad: string[] = [];
  try {
    for (const [i, f] of files.entries()) {
      if (files.length > 1) setBusy($t('匯入素材 {0}/{1}：{2}', i + 1, files.length, f.name), i / files.length);
      try {
        const m = await addMediaBlob(f, f.name);
        if (m) { ok++; each?.(m); } else bad.push(f.name);
      } catch (e) {
        console.warn($t('匯入失敗'), f.name, e);
        bad.push(f.name);
      }
    }
  } finally {
    if (files.length > 1) setBusy(null);
  }
  return { ok, bad };
}

export async function importFiles(files: FileList | File[]) {
  const { ok, bad } = await addMediaFiles(Array.from(files));
  if (ok) toast($t('已匯入 {0} 個檔案', ok));
  if (bad.length) toast($t('無法匯入：{0}', bad.join($t('、'))), 'error');
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
    if (!m) return toast($t('無法讀取這個檔案'), 'error');
    useStore.getState().relinkMedia(oldId, m.id);
    toast($t('已重新連結「{0}」→「{1}」', old?.name ?? '', m.name));
  } catch {
    toast($t('無法讀取這個檔案'), 'error');
  }
}

/** 色板素材的名稱 */
export const colorName = (hex: string) => $t('色板 {0}', hex.toLowerCase());

/** 純色素材（色板）：已經有同色的就直接用，沒有就產生一張 9:16 純色圖 */
export async function colorMedia(hex: string): Promise<Media | null> {
  const color = hex.toLowerCase();
  const hit = useStore.getState().media.find((m) => m.color === color && !m.missing);
  if (hit) return hit;
  const blob = await colorBlob(color);
  if (!blob) return null;
  const m = await addMediaBlob(blob, colorName(color));
  if (!m) return null;
  const out = { ...m, color };
  useStore.setState({ media: useStore.getState().media.map((x) => (x.id === m.id ? out : x)) });
  return out;
}

/** 從素材庫移除：沒被使用就直接刪；被使用就變成「遺失」狀態，片段保留 */
export function removeMedia(id: string, quiet = false) {
  const s = useStore.getState();
  const m = s.media.find((x) => x.id === id);
  if (!m) return;
  const used = usedMediaIds(s).has(id);
  if (m.url) URL.revokeObjectURL(m.url);
  deleteMediaBlob(id);
  dropMatte(id);
  dropFaces(id);
  dropMediaAnalysis(id);
  // 自動剪輯清單裡這個素材的片段一起拿掉
  const ae = useAutoEdit.getState();
  if (ae.segs.some((g) => g.mediaId === id)) useAutoEdit.setState({ segs: ae.segs.filter((g) => g.mediaId !== id) });
  dropBoxTracks(id);
  if (used) {
    useStore.setState({ media: s.media.map((x) => (x.id === id ? { ...x, url: '', thumb: x.kind === 'image' ? '' : x.thumb, missing: true } : x)) });
    if (!quiet) toast($t('「{0}」已移除，使用中的片段標記為遺失', m.name));
  } else {
    useStore.setState({ media: s.media.filter((x) => x.id !== id) });
  }
}

/** 從素材庫與時間軸一起移除。保留 Blob 直到復原紀錄失效，Ctrl+Z 可還原。 */
export function removeMediaEverywhere(ids: string[]): boolean {
  const s = useStore.getState();
  const removing = new Set(ids);
  if (s.clips.some((c) => removing.has(c.mediaId) && s.tracks.video[c.track]?.locked)
    || s.audios.some((a) => removing.has(a.mediaId) && s.tracks.audio[a.track]?.locked)) return false;
  const clips = s.clips.filter((c) => !removing.has(c.mediaId));
  const audios = s.audios.filter((a) => !removing.has(a.mediaId));
  s.media.forEach((m, i) => { if (removing.has(m.id)) { detachedMedia.set(m.id, m); detachedMediaOrder.set(m.id, i); } });
  const idsLeft = new Set([...clips.map((c) => c.id), ...audios.map((a) => a.id), ...s.effects.map((e) => e.id)]);
  useStore.setState({
    media: s.media.filter((m) => !removing.has(m.id)), clips, audios,
    selected: s.selected.filter((k) => idsLeft.has(k.slice(k.indexOf(':') + 1))),
    selection: s.selection && 'id' in s.selection && !idsLeft.has(s.selection.id) && s.selection.type !== 'module' ? null : s.selection,
  });
  return true;
}

/** 時間軸最後一個引用消失時，自動移除來源遺失的素材與色板（色板隨時可以重新產生）；復原時重新顯示。 */
useStore.subscribe((s, prev) => {
  if (s.clips === prev.clips && s.audios === prev.audios && s.anims === prev.anims) return;
  const before = usedMediaIds(prev);
  const after = usedMediaIds(s);
  const gone = s.media.filter((m) => (m.missing || m.color) && before.has(m.id) && !after.has(m.id));
  const back = [...after].filter((id) => !s.media.some((m) => m.id === id) && detachedMedia.has(id)).map((id) => detachedMedia.get(id)!);
  if (!gone.length && !back.length) return;
  for (const m of gone) { detachedMedia.set(m.id, m); detachedMediaOrder.set(m.id, s.media.findIndex((x) => x.id === m.id)); }
  const media = s.media.filter((m) => !gone.some((g) => g.id === m.id));
  for (const m of back.sort((a, b) => (detachedMediaOrder.get(a.id) ?? 0) - (detachedMediaOrder.get(b.id) ?? 0))) {
    media.splice(Math.min(media.length, detachedMediaOrder.get(m.id) ?? media.length), 0, m);
    detachedMedia.delete(m.id);
    detachedMediaOrder.delete(m.id);
  }
  useStore.setState({ media });
});

