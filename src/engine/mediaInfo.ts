/**
 * 素材資訊：從素材檔本身讀（不另外存進專案）。
 * MP4 / MOV / M4A 用 mp4box 只讀檔頭（moov），WAV 讀 RIFF 標頭；其他格式只有大小、格式、位元率。
 */
import { createFile, MP4BoxBuffer, type Movie } from 'mp4box';
import { loadMediaBlob } from './project';

export interface MediaProbe {
  size: number;
  /** 容器格式（MP4 / MOV / PNG…） */
  format: string;
  /** 檔案的修改時間（匯入的是 File 才有） */
  modified?: number;
  /** 檔案裡記錄的建立時間 */
  created?: number;
  fps?: number;
  videoCodec?: string;
  audioCodec?: string;
  sampleRate?: number;
  channels?: number;
}

const MIME_FORMAT: Record<string, string> = {
  'video/quicktime': 'MOV',
  'video/x-matroska': 'MKV',
  'audio/mpeg': 'MP3',
  'audio/x-wav': 'WAV',
  'audio/wave': 'WAV',
  'audio/x-m4a': 'M4A',
  'audio/mp4': 'M4A',
  'image/jpeg': 'JPEG',
  'image/svg+xml': 'SVG',
};

/** 容器格式：先看 MIME，沒有再看副檔名 */
export function formatOf(mime: string, name: string): string {
  const m = mime.toLowerCase();
  if (MIME_FORMAT[m]) return MIME_FORMAT[m];
  const sub = m.split('/')[1];
  if (sub && /^[a-z0-9]+$/.test(sub)) return sub.toUpperCase();
  const ext = /\.([a-z0-9]{2,5})$/i.exec(name)?.[1];
  return ext ? ext.toUpperCase() : m || '—';
}

/** codec 字串 → 常見名稱 */
export function codecName(codec: string): string {
  const c = codec.trim();
  const l = c.toLowerCase();
  if (/^avc[13]/.test(l)) return 'H.264';
  if (/^(hvc1|hev1)/.test(l)) return 'H.265';
  if (l.startsWith('vp09')) return 'VP9';
  if (l.startsWith('vp08') || l === 'vp8') return 'VP8';
  if (l.startsWith('av01')) return 'AV1';
  if (/^ap(cn|ch|cs|co|4h|4x)/.test(l)) return 'ProRes';
  if (l === 'mp4a.6b' || l === 'mp4a.69' || l === 'mp4a.40.34') return 'MP3';
  if (l.startsWith('mp4a')) return 'AAC';
  if (l === 'opus') return 'Opus';
  if (l === 'ac-3') return 'AC-3';
  if (l === 'ec-3') return 'E-AC-3';
  if (l === 'alac') return 'ALAC';
  if (l === 'flac') return 'FLAC';
  if (l === 'lpcm' || l === 'sowt' || l === 'twos' || l === 'ipcm') return 'PCM';
  return c;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/** bit/s → kbps / Mbps */
export function formatBitrate(bps: number): string {
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(bps >= 1e7 ? 0 : 1)} Mbps`;
  return `${Math.round(bps / 1e3)} kbps`;
}

/** 長寬比：約分後數字小就用 16:9，不然用 1.85:1 */
export function aspectOf(w: number, h: number): string {
  if (!w || !h) return '';
  const g = (a: number, b: number): number => (b ? g(b, a % b) : a);
  const d = g(w, h);
  const a = w / d, b = h / d;
  if (a <= 32 && b <= 32) return `${a}:${b}`;
  return w >= h ? `${(w / h).toFixed(2)}:1` : `1:${(h / w).toFixed(2)}`;
}

/** 影格率：整數就不帶小數，其他留兩位（29.97） */
export const formatFps = (fps: number) => (Math.abs(fps - Math.round(fps)) < 0.01 ? String(Math.round(fps)) : fps.toFixed(2));

/** WAV 標頭：聲道與取樣率 */
export function parseWav(head: DataView): { sampleRate: number; channels: number } | null {
  const tag = (o: number) => String.fromCharCode(head.getUint8(o), head.getUint8(o + 1), head.getUint8(o + 2), head.getUint8(o + 3));
  if (head.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  for (let o = 12; o + 8 <= head.byteLength; ) {
    const size = head.getUint32(o + 4, true);
    if (tag(o) === 'fmt ' && o + 16 <= head.byteLength) return { channels: head.getUint16(o + 10, true), sampleRate: head.getUint32(o + 12, true) };
    o += 8 + size + (size & 1);
  }
  return null;
}

/** MP4 / MOV：一段一段餵給 mp4box，讀到 moov 就停（moov 在檔尾時會直接跳過 mdat） */
async function probeMp4(blob: Blob): Promise<Movie | null> {
  const file = createFile();
  let movie: Movie | null = null;
  let failed = false;
  file.onReady = (m: Movie) => (movie = m);
  file.onError = () => (failed = true);
  const CHUNK = 1 << 20;
  let pos = 0;
  for (let n = 0; !movie && !failed && pos < blob.size && n < 64; n++) {
    const ab = await blob.slice(pos, pos + CHUNK).arrayBuffer();
    const next = file.appendBuffer(MP4BoxBuffer.fromArrayBuffer(ab, pos), pos + CHUNK >= blob.size);
    pos = next > pos ? next : pos + CHUNK;
  }
  return movie;
}

const validDate = (d: Date | undefined) => (d && d.getFullYear() > 1990 && d.getTime() < Date.now() + 864e5 ? d.getTime() : undefined);

export async function probeBlob(blob: Blob, name: string): Promise<MediaProbe> {
  const out: MediaProbe = { size: blob.size, format: formatOf(blob.type, name) };
  if (blob instanceof File && blob.lastModified) out.modified = blob.lastModified;
  try {
    if (['MP4', 'MOV', 'M4A', 'M4V', '3GPP'].includes(out.format)) {
      const mv = await probeMp4(blob);
      const v = mv?.videoTracks[0], a = mv?.audioTracks[0];
      if (v) {
        out.videoCodec = codecName(v.codec);
        if (v.nb_samples > 1 && v.duration > 0) out.fps = v.nb_samples / (v.duration / v.timescale);
      }
      if (a) {
        out.audioCodec = codecName(a.codec);
        out.sampleRate = a.audio?.sample_rate;
        out.channels = a.audio?.channel_count;
      }
      out.created = validDate(mv?.created);
    } else if (out.format === 'WAV') {
      const w = parseWav(new DataView(await blob.slice(0, 4096).arrayBuffer()));
      if (w) Object.assign(out, w, { audioCodec: 'PCM' });
    }
  } catch {
    // 讀不懂就只顯示基本資訊
  }
  return out;
}

const cache = new Map<string, Promise<MediaProbe | null>>();
/** 同一個 URL 只讀一次；優先拿專案裡存的原檔（File 才有修改時間），沒有再從 URL 讀 */
export function probeMedia(id: string, url: string, name: string): Promise<MediaProbe | null> {
  let p = cache.get(url);
  if (!p) {
    p = loadMediaBlob(id)
      .catch(() => undefined)
      .then(async (b) => b ?? (await fetch(url)).blob())
      .then((b) => probeBlob(b, name))
      .catch(() => null);
    cache.set(url, p);
  }
  return p;
}
