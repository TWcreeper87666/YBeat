/**
 * 自動剪輯的素材分析（瀏覽器端）：影片每 step 秒 seek 一次、畫成 160px 寬，算亮度 / 清晰度 / 跟上一格的差異
 * （統計在 mediaAnalysis.ts），順便留幾張 384px 的 JPEG 給 AI 導演看。圖片只取一張畫面。
 * 結果只放在記憶體（同一個素材算一次）。
 */
import type { Media } from '../store';
import { analyzeSamples, frameStats, grayOf, type FrameSample, type MediaInfo } from './mediaAnalysis';
import type { Shot } from '../ai/frames';

const W = 160;
const SHOT_SIDE = 384;
/** 給 AI 看的位置（影片長度的比例） */
const SHOT_AT = [0.15, 0.5, 0.85];

export interface Sampled { info: MediaInfo | null; shots: { t: number; shot: Shot }[] }

const cache = new Map<string, Promise<Sampled>>();
/** 已經分析好的（同步拿，給 AI 工具 / 面板看狀態） */
export const sampledNow = new Map<string, Sampled>();

function toShot(src: CanvasImageSource, w: number, h: number): Shot {
  const k = Math.min(1, SHOT_SIDE / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(2, Math.round(w * k));
  c.height = Math.max(2, Math.round(h * k));
  c.getContext('2d')!.drawImage(src, 0, 0, c.width, c.height);
  const url = c.toDataURL('image/jpeg', 0.8);
  return { mime: 'image/jpeg', data: url.slice(url.indexOf(',') + 1), url };
}

async function sampleImage(m: Media): Promise<Sampled> {
  const img = new Image();
  img.src = m.url;
  await img.decode();
  return { info: null, shots: [{ t: 0, shot: toShot(img, img.naturalWidth, img.naturalHeight) }] };
}

async function sampleVideo(m: Media, onFrame: (k: number, n: number) => void): Promise<Sampled> {
  const v = document.createElement('video');
  v.muted = true;
  v.preload = 'auto';
  v.playsInline = true;
  v.src = m.url;
  try {
    await new Promise<void>((res, rej) => {
      const timer = setTimeout(() => rej(new Error('video load timeout')), 20000);
      v.onloadeddata = () => (clearTimeout(timer), res());
      v.onerror = () => (clearTimeout(timer), rej(new Error('video load failed')));
    });
    const dur = Math.max(0.1, v.duration || m.duration || 0.1);
    // 每秒 2 格；很長的影片最多 360 格
    const step = Math.max(0.5, dur / 360);
    const vw = v.videoWidth || m.width || 16, vh = v.videoHeight || m.height || 9;
    const h = Math.max(2, Math.round((W * vh) / vw));
    const g = new OffscreenCanvas(W, h).getContext('2d', { willReadFrequently: true })!;
    const times: number[] = [];
    for (let t = 0; t < dur - 0.05; t += step) times.push(t);
    const shotIdx = new Set(SHOT_AT.map((f) => Math.min(times.length - 1, Math.round((f * dur) / step))));
    const samples: FrameSample[] = [];
    const shots: Sampled['shots'] = [];
    let prev: Float32Array | undefined;
    for (let k = 0; k < times.length; k++) {
      await new Promise<void>((res) => {
        const done = () => (v.removeEventListener('seeked', done), clearTimeout(timer), res());
        const timer = setTimeout(done, 3000);
        v.addEventListener('seeked', done);
        v.currentTime = times[k];
      });
      const rv = v as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number };
      if (rv.requestVideoFrameCallback) await new Promise<void>((res) => { const tm = setTimeout(res, 200); rv.requestVideoFrameCallback!(() => (clearTimeout(tm), res())); });
      g.drawImage(v, 0, 0, W, h);
      const gray = grayOf(g.getImageData(0, 0, W, h).data, W, h);
      samples.push({ t: times[k], ...frameStats(gray, W, h, prev) });
      prev = gray;
      if (shotIdx.has(k)) shots.push({ t: times[k], shot: toShot(v, vw, vh) });
      onFrame(k + 1, times.length);
    }
    return { info: analyzeSamples(samples, dur), shots };
  } finally {
    v.pause();
    v.removeAttribute('src');
    v.load();
  }
}

/** 分析一個素材（算過就用快取）；失敗 = 沒有分析資料（照舊隨機挑） */
export function sampleMedia(m: Media, onFrame: (k: number, n: number) => void = () => {}): Promise<Sampled> {
  let p = cache.get(m.id);
  if (!p) {
    p = (m.kind === 'video' ? sampleVideo(m, onFrame) : sampleImage(m))
      .catch((): Sampled => ({ info: null, shots: [] }))
      .then((r) => (sampledNow.set(m.id, r), r));
    cache.set(m.id, p);
  }
  return p;
}

/** 依序分析一批素材；onProgress(第幾個, 共幾個) */
/** 依序分析一批素材；onProgress(第幾個, 共幾個, 名稱, 這個素材的進度 0..1)；stop() = true 就停（回傳已經算好的） */
export async function sampleAll(list: Media[], onProgress: (i: number, n: number, name: string, frac: number) => void, stop: () => boolean = () => false): Promise<Map<string, Sampled>> {
  const out = new Map<string, Sampled>();
  for (let i = 0; i < list.length; i++) {
    if (stop()) break;
    const m = list[i];
    if (!sampledNow.has(m.id)) onProgress(i + 1, list.length, m.name, 0);
    out.set(m.id, await sampleMedia(m, (k, n) => onProgress(i + 1, list.length, m.name, k / n)));
  }
  return out;
}
