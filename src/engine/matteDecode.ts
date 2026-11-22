/**
 * AI 去背用：直接解碼影片檔（mp4box 拆 MP4 + WebCodecs VideoDecoder），依序拿到每一格與它的時間戳記。
 *
 * 為什麼不用 <video> 一格一格 seek：
 * - seek 之後要等瀏覽器「畫出新的一格」的通知（requestVideoFrameCallback）才知道是哪一格，
 *   而這個通知只有頁面在繪製時才會來：切到別的視窗 / 分頁、或頁面很忙時就等不到 → 進度斷斷續續、卡住。
 * - 有 B 幀的影片每次 seek 都要從關鍵影格重新解碼，很慢。
 * 解碼器不受頁面是否在前景影響，每一格的時間戳記也是檔案裡的實際值，不用猜。
 */
import { DataStream, Endianness, createFile, MP4BoxBuffer, type Movie, type Sample, type Track } from 'mp4box';

export interface DecodeInfo {
  fps: number;
  /** 範圍內要處理的格數（不含已經有的） */
  total: number;
}

/** 解碼器設定要的 codec 描述（avcC / hvcC / vpcC / av1C 盒子的內容） */
function description(file: ReturnType<typeof createFile>, track: Track): Uint8Array | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const trak = file.getTrackById(track.id) as any;
  for (const entry of trak?.mdia?.minf?.stbl?.stsd?.entries ?? []) {
    const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
    if (box) {
      const stream = new DataStream(undefined, 0, Endianness.BIG_ENDIAN);
      box.write(stream);
      return new Uint8Array(stream.buffer as ArrayBuffer, 8); // 去掉盒子的 8 bytes 標頭
    }
  }
  return undefined;
}

/**
 * 編輯清單（elst）造成的時間位移：瀏覽器播放時的時間 = cts / timescale + shift。
 * 空的編輯（media_time = -1）= 前面先空一段；第一個實際的編輯從 media_time 開始播。
 */
function editShift(track: Track): number {
  let shift = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const e of (track.edits ?? []) as any[]) {
    if (e.media_time === -1) shift += e.segment_duration / track.movie_timescale;
    else {
      shift -= e.media_time / track.timescale;
      break;
    }
  }
  return shift;
}

/** 等解碼器的佇列少一個；保險起見 50ms 也會放行（MessageChannel 不受背景節流） */
function waitDequeue(dec: VideoDecoder): Promise<void> {
  return new Promise((res) => {
    let done = false;
    const go = () => {
      if (done) return;
      done = true;
      dec.removeEventListener('dequeue', go);
      res();
    };
    dec.addEventListener('dequeue', go);
    const ch = new MessageChannel();
    const t0 = performance.now();
    const spin = () => (done ? undefined : performance.now() - t0 > 50 ? go() : ch.port2.postMessage(0));
    ch.port1.onmessage = spin;
    spin();
  });
}

async function demux(buf: ArrayBuffer): Promise<{ file: ReturnType<typeof createFile>; track: Track; samples: Sample[] }> {
  const file = createFile();
  const samples: Sample[] = [];
  let track: Track | null = null;
  let error: string | null = null;
  file.onError = (_m: string, msg: string) => (error = msg);
  file.onReady = (info: Movie) => {
    track = info.videoTracks[0] ?? null;
    if (!track) return;
    file.setExtractionOptions(track.id, null, { nbSamples: Infinity });
    file.start();
  };
  file.onSamples = (_id: number, _u: unknown, s: Sample[]) => {
    for (const x of s) samples.push(x);
  };
  file.appendBuffer(MP4BoxBuffer.fromArrayBuffer(buf, 0));
  file.flush();
  if (error) throw new Error(`mp4: ${error}`);
  if (!track) throw new Error('mp4: no video track');
  return { file, track, samples };
}

/**
 * 解碼 [from, to]（素材時間，秒）範圍內的每一格；skip(pts) = true 的格子不處理（已經算過）。
 * onFrame 處理完（推論完）才會繼續解碼，記憶體不會一直堆。
 */
export async function decodeRange(o: {
  url: string;
  from: number;
  to: number;
  size: number;
  /** 不拉成正方形：畫布 w × h，影格畫在左上角 dw × dh（臉部偵測要保持比例）；沒有 = size × size 拉滿 */
  box?: { w: number; h: number; dw: number; dh: number };
  skip: (pts: number) => boolean;
  onInfo: (info: DecodeInfo) => void;
  onFrame: (pts: number, rgba: Uint8ClampedArray) => Promise<void>;
  alive: () => boolean;
}): Promise<void> {
  if (typeof VideoDecoder === 'undefined') throw new Error('no WebCodecs');
  const buf = await (await fetch(o.url)).arrayBuffer();
  const { file, track, samples } = await demux(buf);
  const ts = track.timescale;
  const shift = editShift(track);
  const ptsOf = (s: Sample) => s.cts / ts + shift;

  // 影格率：相鄰時間戳記的差（取中位數）
  const sorted = samples.map(ptsOf).sort((a, b) => a - b);
  const gaps = sorted.slice(1).map((t, i) => t - sorted[i]).filter((d) => d > 1e-4).sort((a, b) => a - b);
  const fd = gaps.length ? gaps[gaps.length >> 1] : 1 / 30;
  const lo = o.from - fd * 0.5, hi = o.to + fd * 0.5;
  const wanted = (pts: number) => pts >= lo && pts <= hi && !o.skip(pts);
  o.onInfo({ fps: 1 / fd, total: samples.filter((s) => wanted(ptsOf(s))).length });

  // 從範圍開頭之前最近的關鍵影格開始解碼（samples 是解碼順序）
  const first = samples.findIndex((s) => ptsOf(s) >= lo);
  if (first < 0) return;
  let start = first;
  while (start > 0 && !samples[start].is_sync) start--;
  // 解到範圍結尾之後再多幾格（B 幀要後面的參考格才解得出來）
  let end = samples.length - 1;
  for (let i = first; i < samples.length; i++) if (ptsOf(samples[i]) > hi + fd * 8) { end = i; break; }

  const bw = o.box?.w ?? o.size, bh = o.box?.h ?? o.size;
  const dw = o.box?.dw ?? o.size, dh = o.box?.dh ?? o.size;
  const canvas = new OffscreenCanvas(bw, bh);
  const g = canvas.getContext('2d', { willReadFrequently: true })!;
  const queue: { pts: number; rgba: Uint8ClampedArray }[] = [];
  let decodeError: Error | null = null;
  const dec = new VideoDecoder({
    output: (frame) => {
      const pts = frame.timestamp / 1e6;
      if (wanted(pts)) {
        // 跟 rembg 一樣直接拉成正方形（不保持比例），遮罩畫回去時再拉回原比例
        g.fillStyle = '#000';
        g.fillRect(0, 0, bw, bh);
        g.drawImage(frame, 0, 0, dw, dh);
        queue.push({ pts, rgba: g.getImageData(0, 0, bw, bh).data });
      }
      frame.close();
    },
    error: (e) => (decodeError = e instanceof Error ? e : new Error(String(e))),
  });
  const config: VideoDecoderConfig = {
    codec: track.codec,
    codedWidth: track.video?.width ?? track.track_width,
    codedHeight: track.video?.height ?? track.track_height,
    description: description(file, track),
  };
  if (!(await VideoDecoder.isConfigSupported(config)).supported) throw new Error(`codec not supported: ${track.codec}`);
  dec.configure(config);

  const drain = async () => {
    while (queue.length) {
      if (!o.alive()) return;
      const f = queue.shift()!;
      await o.onFrame(f.pts, f.rgba);
    }
  };
  try {
    for (let i = start; i <= end; i++) {
      if (!o.alive()) return;
      if (decodeError) throw decodeError;
      const s = samples[i];
      dec.decode(new EncodedVideoChunk({
        type: s.is_sync ? 'key' : 'delta',
        timestamp: Math.round(ptsOf(s) * 1e6),
        duration: Math.round((s.duration / ts) * 1e6),
        data: s.data!,
      }));
      // 推論比解碼慢很多：佇列有東西就先處理，解碼器也不要排太多
      if (queue.length >= 2 || dec.decodeQueueSize > 16) await drain();
      // 等解碼器消化（用它自己的 dequeue 事件，不用 setTimeout：背景分頁的計時器會被節流到一分鐘一次）
      while (dec.decodeQueueSize > 16 && !decodeError) await waitDequeue(dec);
    }
    await dec.flush();
    if (decodeError) throw decodeError;
    await drain();
  } finally {
    if (dec.state !== 'closed') dec.close();
  }
}
