/**
 * 動態圖片（GIF、動態 WebP / PNG）：用 WebCodecs 的 ImageDecoder 解出每一格與它的長度，依片段內時間循環播放。
 * 不支援 ImageDecoder 的瀏覽器、或只有一格的圖片 → null（照一般靜態圖片處理）。
 */
import type { Media } from '../store';

export interface AnimImage {
  frames: ImageBitmap[];
  /** 每一格的開始時間（秒），最後多一個 = 總長度 */
  starts: number[];
  total: number;
}

/** 一張動態圖片最多解幾格（太長的 GIF 不要把記憶體吃光） */
const MAX_FRAMES = 1500;
/** 沒有寫長度（或寫 0）的格子：瀏覽器的慣例是當成 0.1 秒 */
const DEFAULT_DELAY = 0.1;

type Decoder = {
  tracks: { ready: Promise<void>; selectedTrack: { animated: boolean; frameCount: number } | null };
  decode(o: { frameIndex: number }): Promise<{ image: VideoFrame }>;
  close(): void;
};
type DecoderCtor = { new (o: { data: ArrayBuffer; type: string }): Decoder; isTypeSupported(t: string): Promise<boolean> };

const cache = new Map<string, { url: string; state: AnimImage | null | 'loading'; promise: Promise<AnimImage | null> }>();

/** 從檔頭判斷格式（Blob URL 拿不到副檔名） */
function sniff(b: Uint8Array): string | null {
  const s = (i: number, n: number) => String.fromCharCode(...b.slice(i, i + n));
  if (s(0, 4) === 'GIF8') return 'image/gif';
  if (s(0, 4) === 'RIFF' && s(8, 4) === 'WEBP') return 'image/webp';
  if (b[0] === 0x89 && s(1, 3) === 'PNG') return 'image/png';
  return null;
}

/** 把每一格的長度累加成開始時間（長度 0 / 太短的照瀏覽器慣例當 0.1 秒） */
export function frameStarts(durations: number[]): { starts: number[]; total: number } {
  const starts: number[] = [];
  let t = 0;
  for (const d of durations) {
    starts.push(t);
    t += d > 0.011 ? d : DEFAULT_DELAY;
  }
  starts.push(t);
  return { starts, total: t };
}

/** 時間 t（秒，從頭開始、會循環）是第幾格 */
export function frameIndexAt(starts: number[], total: number, t: number): number {
  const n = starts.length - 1;
  if (n <= 1 || !(total > 0)) return 0;
  const x = ((t % total) + total) % total;
  let lo = 0, hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= x) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

async function load(url: string): Promise<AnimImage | null> {
  const Ctor = (globalThis as unknown as { ImageDecoder?: DecoderCtor }).ImageDecoder;
  if (!Ctor) return null;
  const data = await (await fetch(url)).arrayBuffer();
  const type = sniff(new Uint8Array(data, 0, Math.min(16, data.byteLength)));
  if (!type || !(await Ctor.isTypeSupported(type))) return null;
  const dec = new Ctor({ data, type });
  try {
    await dec.tracks.ready;
    const tr = dec.tracks.selectedTrack;
    if (!tr?.animated || tr.frameCount <= 1) return null;
    const n = Math.min(tr.frameCount, MAX_FRAMES);
    const frames: ImageBitmap[] = [];
    const durs: number[] = [];
    for (let i = 0; i < n; i++) {
      const { image } = await dec.decode({ frameIndex: i });
      durs.push((image.duration ?? 0) / 1e6);
      frames.push(await createImageBitmap(image));
      image.close();
    }
    const { starts, total } = frameStarts(durs);
    return { frames, starts, total };
  } finally {
    dec.close();
  }
}

/** 素材的動態圖片（還在解 / 不是動態的 = null）；第一次呼叫時開始在背景解 */
export function animImage(media: Media): AnimImage | null {
  let e = cache.get(media.id);
  if (!e || e.url !== media.url) {
    for (const f of (e?.state && e.state !== 'loading' ? e.state.frames : [])) f.close();
    const ent: { url: string; state: AnimImage | null | 'loading'; promise: Promise<AnimImage | null> } = { url: media.url, state: 'loading', promise: Promise.resolve(null) };
    ent.promise = load(media.url)
      .catch((err) => (console.warn('animated image decode failed', err), null))
      .then((a) => (ent.state = a));
    e = ent;
    cache.set(media.id, e);
  }
  return e.state === 'loading' ? null : e.state;
}

/** 匯出前：等動態圖片解完（不是動態的也會很快回來） */
export function animImageReady(media: Media): Promise<AnimImage | null> {
  animImage(media);
  return cache.get(media.id)!.promise;
}

/** 片段內時間 t 的那一格 */
export function animFrameAt(a: AnimImage, t: number): { index: number; image: ImageBitmap } {
  const index = frameIndexAt(a.starts, a.total, t);
  return { index, image: a.frames[index] };
}
