/**
 * 拖播放頭用的低解析度影格快取。
 * 長 GOP 的影片（螢幕錄影、MKV…）每次 seek 都要從前一個關鍵影格解碼，拖曳時畫面會跟不上。
 * 第一次拖曳某個素材時，背景用另一個 <video> 依序抽出小張影格（離播放頭近的先抽），
 * 精準的 seek 還沒完成前，預覽先用最接近的快取影格頂著。
 */
import type { Media } from '../store';

const H = 200; // 影格高度（px）
const MAX_FRAMES = 480;

interface Entry {
  id: string;
  url: string;
  step: number;
  frames: (ImageBitmap | null)[];
  video: HTMLVideoElement | null;
  running: boolean;
  want: number; // 最近被要求的影格
}

const cache = new Map<string, Entry>();

function entryFor(m: Media): Entry {
  let e = cache.get(m.id);
  if (e && e.url === m.url) return e;
  e?.frames.forEach((f) => f?.close());
  const step = Math.max(0.25, m.duration / MAX_FRAMES);
  e = { id: m.id, url: m.url, step, frames: new Array(Math.ceil(m.duration / step) + 1).fill(null), video: null, running: false, want: 0 };
  cache.set(m.id, e);
  return e;
}

/** 下一個要抽的影格：從最近被要求的位置往兩邊擴散 */
function nextIndex(e: Entry): number {
  const n = e.frames.length;
  for (let d = 0; d < n; d++) {
    for (const i of [e.want + d, e.want - d]) if (i >= 0 && i < n && !e.frames[i]) return i;
  }
  return -1;
}

function seekTo(v: HTMLVideoElement, t: number) {
  return new Promise<void>((res) => {
    const done = () => {
      v.removeEventListener('seeked', done);
      clearTimeout(timer);
      res();
    };
    const timer = setTimeout(done, 3000);
    v.addEventListener('seeked', done);
    v.currentTime = t;
  });
}

async function run(e: Entry) {
  if (e.running) return;
  e.running = true;
  try {
    if (!e.video) {
      const v = document.createElement('video');
      v.muted = true;
      v.preload = 'auto';
      v.src = e.url;
      e.video = v;
      await new Promise<void>((res) => {
        if (v.readyState >= 1) return res();
        v.addEventListener('loadedmetadata', () => res(), { once: true });
        v.addEventListener('error', () => res(), { once: true });
      });
    }
    const v = e.video;
    if (!v.videoWidth) return;
    const W = Math.max(2, Math.round((H * v.videoWidth) / v.videoHeight));
    let i: number;
    while ((i = nextIndex(e)) >= 0) {
      if (cache.get(e.id) !== e) return; // 素材換掉了
      await seekTo(v, Math.min(v.duration - 0.01, i * e.step));
      try {
        e.frames[i] = await createImageBitmap(v, { resizeWidth: W, resizeHeight: H, resizeQuality: 'low', imageOrientation: 'flipY' }); // WebGL 對 ImageBitmap 不套 UNPACK_FLIP_Y，這裡先翻好
      } catch {
        e.frames[i] = null;
        return;
      }
      await new Promise((r) => setTimeout(r, 0));
    }
  } finally {
    e.running = false;
  }
}

/** 取得素材在 t 秒最接近的快取影格（沒有就回傳 null，並開始在背景抽） */
export function scrubFrame(m: Media, t: number): ImageBitmap | null {
  if (m.kind !== 'video' || m.missing || !m.url) return null;
  const e = entryFor(m);
  const i = Math.max(0, Math.min(e.frames.length - 1, Math.round(t / e.step)));
  e.want = i;
  void run(e);
  // 最近的已抽好的影格（最多差 2 格）
  for (let d = 0; d <= 2; d++) {
    for (const j of [i - d, i + d]) {
      const f = e.frames[j];
      if (f) return f;
    }
  }
  return null;
}

/** 快取影格的間距（秒） */
export const scrubStep = (m: Media) => entryFor(m).step;
