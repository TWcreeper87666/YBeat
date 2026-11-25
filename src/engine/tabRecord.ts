/**
 * 錄製其他分頁（含分頁音訊）：getDisplayMedia → MediaStreamTrackProcessor 拿到每一格 / 每段聲音 →
 * 影像即時用 WebCodecs 編成 H.264（固定 30fps：分頁畫面沒變時瀏覽器不送新格，這裡補上重複的格），聲音先留原始 PCM。
 * 停止後：整段封裝成 MP4 給選範圍的視窗播放；選好的範圍再從記憶體裡的資料重新編碼，準確到格。
 */
import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import { create } from 'zustand';
import { FPS, KEY_EVERY, type RecIn, type RecOut } from './tabRecordTypes';

/** 長邊上限（分頁錄影 1080p 就夠，再大檔案太肥） */
const MAX_EDGE = 1920;

// lib.dom 還沒有這兩個型別（Chrome / Edge 有）
declare class MediaStreamTrackProcessor<T> {
  constructor(o: { track: MediaStreamTrack });
  readable: ReadableStream<T>;
}

export interface Recording {
  w: number;
  h: number;
  /** 編好的影像，第 i 個 = 第 i 格（i / FPS 秒） */
  chunks: EncodedVideoChunk[];
  decoderConfig: VideoDecoderConfig;
  /** 聲音（已對齊到影像的 0 秒），沒有聲音 = null */
  audio: { rate: number; ch: Float32Array[] } | null;
  duration: number;
}

type Phase = 'idle' | 'starting' | 'recording' | 'saving';
/** 錄製狀態（介面用）：since = 開始錄的時間（performance.now） */
export const useTabRec = create<{ phase: Phase; since: number; done: Recording | null }>(() => ({ phase: 'idle', since: 0, done: null }));

export const canRecordTab = () =>
  typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia && typeof VideoEncoder !== 'undefined' &&
  typeof (globalThis as { MediaStreamTrackProcessor?: unknown }).MediaStreamTrackProcessor !== 'undefined';

let stopNow: (() => void) | null = null;

export function stopTabRecording() {
  stopNow?.();
}

async function pickVideoConfig(w: number, h: number): Promise<VideoEncoderConfig | null> {
  for (const codec of ['avc1.640028', 'avc1.4d0028', 'avc1.42e028', 'avc1.640033']) {
    const c: VideoEncoderConfig = { codec, width: w, height: h, bitrate: 8_000_000, framerate: FPS, latencyMode: 'realtime' };
    if ((await VideoEncoder.isConfigSupported(c)).supported) return c;
  }
  return null;
}

const even = (x: number) => Math.max(2, Math.round(x / 2) * 2);

/**
 * AudioData → 左右兩聲道的 Float32（單聲道複製一份）。
 * 分頁音訊的原始格式不一定（f32 / s16，交錯 / 分開），各自照格式讀，不靠瀏覽器轉換（轉換沒做好會變成雜訊）
 */
export function audioPlanes(d: Pick<AudioData, 'format' | 'numberOfFrames' | 'numberOfChannels' | 'copyTo'>): Float32Array[] {
  const n = d.numberOfFrames, C = Math.max(1, d.numberOfChannels);
  const pick = (c: number) => Math.min(c, C - 1);
  const fmt = d.format;
  if (fmt === 'f32-planar') return [0, 1].map((c) => { const b = new Float32Array(n); d.copyTo(b, { planeIndex: pick(c) }); return b; });
  if (fmt === 's16-planar') return [0, 1].map((c) => {
    const raw = new Int16Array(n);
    d.copyTo(raw, { planeIndex: pick(c) });
    return Float32Array.from(raw, (v) => v / 32768);
  });
  if (fmt === 'f32' || fmt === 's16') {
    const raw = fmt === 'f32' ? new Float32Array(n * C) : new Int16Array(n * C);
    d.copyTo(raw, { planeIndex: 0 });
    const k = fmt === 'f32' ? 1 : 1 / 32768;
    return [0, 1].map((c) => {
      const b = new Float32Array(n);
      for (let i = 0, j = pick(c); i < n; i++, j += C) b[i] = raw[j] * k;
      return b;
    });
  }
  // 其他格式（u8、s32…）：交給瀏覽器轉
  return [0, 1].map((c) => { const b = new Float32Array(n); d.copyTo(b, { planeIndex: pick(c), format: 'f32-planar' }); return b; });
}

/** 開始錄：跳出瀏覽器的分享選擇視窗；使用者按停止（或瀏覽器上的「停止共用」）後，錄好的放進 useTabRec.done */
export async function startTabRecording(): Promise<void> {
  if (useTabRec.getState().phase !== 'idle') return;
  useTabRec.setState({ phase: 'starting' });
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: 'browser', frameRate: FPS },
      audio: { suppressLocalAudioPlayback: false } as MediaTrackConstraints,
      // Chrome 的選項：預設選分頁、列表不放這個編輯器自己、錄的時候可以換分頁、勾選分頁音訊
      preferCurrentTab: false, selfBrowserSurface: 'exclude', surfaceSwitching: 'include', systemAudio: 'include',
    } as DisplayMediaStreamOptions);
  } catch (e) {
    useTabRec.setState({ phase: 'idle' });
    // 使用者在選擇視窗按取消：不算錯誤
    if (e instanceof DOMException && e.name === 'NotAllowedError') return;
    throw e;
  }
  const vTrack = stream.getVideoTracks()[0];
  const aTrack = stream.getAudioTracks()[0] ?? null;
  const stopTracks = () => stream.getTracks().forEach((t) => t.stop());
  if (!vTrack) {
    stopTracks();
    useTabRec.setState({ phase: 'idle' });
    return;
  }

  const set = vTrack.getSettings();
  const sw = set.width || 1280, sh = set.height || 720;
  const k = Math.min(1, MAX_EDGE / Math.max(sw, sh));
  const w = even(sw * k), h = even(sh * k);
  const cfg = await pickVideoConfig(w, h);
  if (!cfg) {
    stopTracks();
    useTabRec.setState({ phase: 'idle' });
    throw new Error('no encoder');
  }
  // 讀取、編碼都在 Worker（主執行緒在背景會被節流，預覽也會搶時間）；串流直接傳過去
  const worker = new Worker(new URL('./tabRecordWorker.ts', import.meta.url), { type: 'module' });
  const video = new MediaStreamTrackProcessor<VideoFrame>({ track: vTrack }).readable;
  const result = new Promise<Extract<RecOut, { type: 'done' }>>((res, rej) => {
    worker.onmessage = (e: MessageEvent<RecOut>) => {
      const m = e.data;
      if (m.type === 'started') useTabRec.setState({ phase: 'recording', since: performance.now() });
      else if (m.type === 'done') res(m);
      else rej(new Error(m.err));
    };
    worker.onerror = (e) => rej(new Error(e.message));
  });
  const msg: RecIn = { type: 'start', video, w, h, cfg };
  worker.postMessage(msg, [video] as unknown as Transferable[]);
  // 聲音在主執行緒讀（聲音串流傳不進 Worker），複製成 PCM 再送過去；讀串流不靠計時器，背景節流影響不大
  const aReader = aTrack ? new MediaStreamTrackProcessor<AudioData>({ track: aTrack }).readable.getReader() : null;
  if (aReader) void (async () => {
    for (;;) {
      const { value: d, done } = await aReader.read().catch(() => ({ value: undefined, done: true as const }));
      if (done || !d) break;
      const at = (performance.timeOrigin + performance.now()) * 1000;
      try {
        const ch = audioPlanes(d);
        const m: RecIn = { type: 'audio', ts: d.timestamp, at, rate: d.sampleRate, ch };
        worker.postMessage(m, ch.map((c) => c.buffer));
      } catch (e) {
        console.warn('tab recording: audio copy failed', e);
      } finally {
        d.close();
      }
    }
  })();

  const stop = () => {
    stopNow = null;
    void aReader?.cancel().catch(() => {});
    worker.postMessage({ type: 'stop' } satisfies RecIn);
    useTabRec.setState({ phase: 'saving' });
  };
  stopNow = stop;
  vTrack.addEventListener('ended', () => stopNow?.());
  let out: Extract<RecOut, { type: 'done' }>;
  try {
    out = await result;
  } catch (e) {
    useTabRec.setState({ phase: 'idle' });
    throw e;
  } finally {
    stopNow = null;
    stopTracks();
    worker.terminate();
  }
  if (!out.decoderConfig || !out.chunks.length) {
    useTabRec.setState({ phase: 'idle' });
    return;
  }
  const chunks = out.chunks.map((c) => new EncodedVideoChunk({ type: c.key ? 'key' : 'delta', timestamp: c.timestamp, duration: c.duration, data: c.data }));
  useTabRec.setState({ phase: 'idle', done: { w, h, chunks, decoderConfig: out.decoderConfig, audio: out.audio, duration: out.duration } });
}

async function pickAudioConfig(rate: number) {
  if (typeof AudioEncoder === 'undefined') return null;
  for (const o of [{ codec: 'mp4a.40.2', mux: 'aac' as const }, { codec: 'opus', mux: 'opus' as const }]) {
    const c: AudioEncoderConfig = { codec: o.codec, sampleRate: rate, numberOfChannels: 2, bitrate: 192_000 };
    if ((await AudioEncoder.isConfigSupported(c)).supported) return { config: c, mux: o.mux };
  }
  return null;
}

/** 選範圍 a..b（秒）的第幾格到第幾格 */
export const frameSpan = (rec: Pick<Recording, 'chunks'>, a: number, b: number) => {
  const i0 = Math.max(0, Math.min(rec.chunks.length - 1, Math.round(a * FPS)));
  const i1 = Math.max(i0 + 1, Math.min(rec.chunks.length, Math.round(b * FPS)));
  return [i0, i1] as const;
};

/** 裁切框（比例 0~1）換成像素：寬高取偶數（H.264 要求） */
export function cropPixels(rec: Pick<Recording, 'w' | 'h'>, c?: { x: number; y: number; w: number; h: number }) {
  if (!c) return { x: 0, y: 0, w: rec.w, h: rec.h };
  const w = Math.min(rec.w, even(c.w * rec.w)), h = Math.min(rec.h, even(c.h * rec.h));
  const x = Math.max(0, Math.min(rec.w - w, Math.round(c.x * rec.w))), y = Math.max(0, Math.min(rec.h - h, Math.round(c.y * rec.h)));
  return { x, y, w, h };
}

/**
 * 封裝成 MP4：整段、不裁切 → 直接用編好的資料；
 * 只要其中一段或有裁切 → 從前一個關鍵格解碼、重新編碼（準確到格）
 */
export async function recordingMp4(rec: Recording, a = 0, b = rec.duration, onProgress?: (f: number) => void,
  crop?: { x: number; y: number; w: number; h: number }): Promise<Blob> {
  const [i0, i1] = frameSpan(rec, a, b);
  const box = cropPixels(rec, crop);
  const cropped = box.w !== rec.w || box.h !== rec.h;
  const whole = i0 === 0 && i1 === rec.chunks.length && !cropped;
  const aPick = rec.audio ? await pickAudioConfig(rec.audio.rate) : null;
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: 'avc', width: box.w, height: box.h, frameRate: FPS },
    audio: aPick && rec.audio ? { codec: aPick.mux, sampleRate: rec.audio.rate, numberOfChannels: 2 } : undefined,
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
  });

  if (aPick && rec.audio) {
    let err: unknown = null;
    const ae = new AudioEncoder({ output: (c, m) => muxer.addAudioChunk(c, m), error: (e) => (err = e) });
    ae.configure(aPick.config);
    const { rate, ch } = rec.audio;
    const s0 = Math.round((i0 / FPS) * rate), s1 = Math.min(ch[0].length, Math.round((i1 / FPS) * rate));
    const N = 1024;
    for (let i = s0; i < s1; i += N) {
      const n = Math.min(N, s1 - i);
      const data = new Float32Array(n * 2);
      data.set(ch[0].subarray(i, i + n), 0);
      data.set(ch[1].subarray(i, i + n), n);
      const ad = new AudioData({ format: 'f32-planar', sampleRate: rate, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round(((i - s0) / rate) * 1e6), data });
      ae.encode(ad);
      ad.close();
    }
    await ae.flush();
    ae.close();
    if (err) throw err;
  }

  if (whole) {
    rec.chunks.forEach((c, i) => muxer.addVideoChunk(c, i === 0 ? { decoderConfig: rec.decoderConfig } : undefined));
  } else {
    let err: unknown = null;
    const cfg = await pickVideoConfig(box.w, box.h);
    // 裁切：把那一塊畫到輸出大小的畫布上再編碼
    const canvas = cropped ? new OffscreenCanvas(box.w, box.h) : null;
    const g = canvas?.getContext('2d') ?? null;
    if (!cfg) throw new Error('no encoder');
    const enc = new VideoEncoder({ output: (c, m) => muxer.addVideoChunk(c, m), error: (e) => (err = e) });
    enc.configure({ ...cfg, latencyMode: 'quality' });
    let out = 0;
    const dec = new VideoDecoder({
      output: (f) => {
        const i = Math.round((f.timestamp * FPS) / 1e6);
        if (i >= i0 && i < i1) {
          if (canvas && g) g.drawImage(f, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
          const o = new VideoFrame(canvas ?? f, { timestamp: Math.round(((i - i0) * 1e6) / FPS), duration: Math.round(1e6 / FPS) });
          enc.encode(o, { keyFrame: out % KEY_EVERY === 0 });
          o.close();
          out++;
        }
        f.close();
      },
      error: (e) => (err = e),
    });
    dec.configure(rec.decoderConfig);
    let start = i0;
    while (start > 0 && rec.chunks[start].type !== 'key') start--;
    for (let i = start; i < i1; i++) {
      if (err) throw err;
      dec.decode(rec.chunks[i]);
      while (dec.decodeQueueSize > 8 || enc.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 1));
      if (i % 15 === 0) onProgress?.((i - start) / (i1 - start));
    }
    await dec.flush();
    dec.close();
    await enc.flush();
    enc.close();
    if (err) throw err;
  }
  muxer.finalize();
  return new Blob([target.buffer], { type: 'video/mp4' });
}

