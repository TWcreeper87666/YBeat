/**
 * 預覽代理檔的產生（Web Worker，見 proxy.ts）：MP4 / MOV 直接解碼每一格 → 縮小 → H.264 編碼（每 0.5 秒一個關鍵影格）→ MP4。
 * 放在 Worker：不跟預覽搶主執行緒，分頁在背景時也不會被節流到幾乎停住。
 */
import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import { decodeAllFrames } from './matteDecode';

const KEY_EVERY = 0.5;

type In =
  | { type: 'build'; id: string; url: string; w: number; h: number }
  | { type: 'cancel'; id: string };
export type ProxyOut =
  | { type: 'progress'; id: string; f: number }
  | { type: 'done'; id: string; blob: Blob }
  | { type: 'fail'; id: string; err: string };

let cancelled: string | null = null;
const post = (m: ProxyOut) => (self as unknown as Worker).postMessage(m);

async function pickConfig(w: number, h: number, fps: number): Promise<VideoEncoderConfig | null> {
  for (const codec of ['avc1.4d401f', 'avc1.4d4028', 'avc1.42e01f', 'avc1.640028']) {
    // 軟體編碼：測試機（Windows）的硬體編碼器只要同時有解碼器在跑，輸出幾格就卡住；540p 軟體編碼也夠快（每秒 100+ 格）
    const c: VideoEncoderConfig = { codec, width: w, height: h, bitrate: 2_500_000, framerate: fps, hardwareAcceleration: 'prefer-software' };
    if ((await VideoEncoder.isConfigSupported(c)).supported) return c;
  }
  return null;
}

async function build(id: string, url: string, w: number, h: number): Promise<Blob | null> {
  const alive = () => cancelled !== id;
  const canvas = new OffscreenCanvas(w, h);
  const g = canvas.getContext('2d')!;
  const target = new ArrayBufferTarget();
  const fps = 30;
  const cfg = await pickConfig(w, h, fps);
  if (!cfg) throw new Error('no encoder');
  const muxer = new Muxer({ target, video: { codec: 'avc', width: w, height: h, frameRate: fps }, fastStart: 'in-memory', firstTimestampBehavior: 'offset' });
  let encError: Error | null = null;
  const enc = new VideoEncoder({
    output: (chunk, meta) => {
      try {
        // 編碼器輸出的片段不一定帶長度（mp4-muxer 一定要）：沒有就用一格的長度
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        const d = chunk.duration && chunk.duration > 0 ? chunk.duration : Math.round(1e6 / fps);
        muxer.addVideoChunkRaw(data, chunk.type, chunk.timestamp, d, meta);
      } catch (e) {
        encError = e instanceof Error ? e : new Error(String(e));
      }
    },
    error: (e) => (encError = e),
  });
  enc.configure(cfg);
  let lastKey = -Infinity;
  let first = true;
  let lastPts = -Infinity;
  try {
    const opts = {
      url,
      alive,
      wait: () => Promise.resolve(),
      onProgress: (f: number) => post({ type: 'progress', id, f }),
      onFrame: async (pts: number, frame: VideoFrame) => {
        // 0 秒以前的格子（剪輯過的檔案開頭的預捲）不會顯示，也不能放進 MP4；
        // 代理檔最多 30 fps（60 fps 的影片只編一半，預覽看不出差別）
        if (pts < -1e-3 || (!first && pts - lastPts < 1 / fps - 2e-3)) return frame.close();
        lastPts = pts;
        // 第一格放在 0 秒（MP4 從 0 開始；差不到一格，不影響對時）
        if (first) { first = false; pts = 0; }
        // 先在畫布上縮小（GPU）再編碼：比把原尺寸的畫面直接交給軟體編碼器（要整張讀回 CPU 再縮）快一倍
        try {
          g.drawImage(frame, 0, 0, w, h);
        } finally {
          frame.close();
        }
        const f = new VideoFrame(canvas, { timestamp: Math.round(pts * 1e6), duration: Math.round(1e6 / fps) });
        const key = pts - lastKey >= KEY_EVERY - 1e-3;
        if (key) lastKey = pts;
        enc.encode(f, { keyFrame: key });
        f.close();
        if (encError) throw encError;
        // 排隊太多時等一下（記憶體）；最多等一下就繼續送，不要互相等住
        for (let k = 0; enc.encodeQueueSize > 16 && !encError && k < 50; k++) {
          await new Promise<void>((r) => { enc.addEventListener('dequeue', () => r(), { once: true }); setTimeout(r, 20); });
        }
      },
    };
    // 軟體解碼：多支同時做時總速度跟著核心數變快（硬體解碼大家共用，2 支以上就不會再快），也不跟預覽的硬體解碼器搶。
    // 沒有軟體解碼器的格式（例如 HEVC）改用硬體
    try {
      await decodeAllFrames({ ...opts, accel: 'prefer-software' });
    } catch (e) {
      if (!/codec not supported/.test(String(e))) throw e;
      await decodeAllFrames(opts);
    }
    if (!alive()) return null;
    await enc.flush();
    if (encError) throw encError;
    muxer.finalize();
    return new Blob([target.buffer], { type: 'video/mp4' });
  } finally {
    if (enc.state !== 'closed') enc.close();
  }
}

self.onmessage = async (e: MessageEvent<In>) => {
  const m = e.data;
  if (m.type === 'cancel') {
    cancelled = m.id;
    return;
  }
  cancelled = null;
  try {
    const blob = await build(m.id, m.url, m.w, m.h);
    if (blob) post({ type: 'done', id: m.id, blob });
    else post({ type: 'fail', id: m.id, err: 'cancelled' });
  } catch (err) {
    post({ type: 'fail', id: m.id, err: String(err) });
  }
};
