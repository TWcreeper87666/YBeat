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

// ───────────── 倒播預覽用：解出一段範圍的影格（VideoFrame 交給呼叫端處理、關閉） ─────────────

/** 同一個檔案拆一次就好（倒播快取會對同一支影片要好幾段） */
const demuxed = new Map<string, Promise<{ file: ReturnType<typeof createFile>; track: Track; samples: Sample[] }>>();
function demuxUrl(url: string) {
  let p = demuxed.get(url);
  if (!p) {
    p = fetch(url).then((r) => r.arrayBuffer()).then(demux);
    p.catch(() => demuxed.delete(url));
    demuxed.set(url, p);
    // 只留最近的兩支（拆好的檔案含整個影片資料）
    while (demuxed.size > 2) demuxed.delete(demuxed.keys().next().value!);
  }
  return p;
}

/**
 * 解碼 from..to（素材秒數）的每一格，依解碼輸出順序呼叫 onFrame(pts, frame)；frame 由 onFrame 負責 close。
 * 回傳影格率。alive() = false 就停。
 */
export async function decodeFrames(o: {
  url: string;
  from: number;
  to: number;
  onFrame: (pts: number, frame: VideoFrame) => void;
  alive: () => boolean;
}): Promise<number> {
  if (typeof VideoDecoder === 'undefined') throw new Error('no WebCodecs');
  const { file, track, samples } = await demuxUrl(o.url);
  const ts = track.timescale;
  const shift = editShift(track);
  const ptsOf = (s: Sample) => s.cts / ts + shift;
  const sorted = samples.map(ptsOf).sort((a, b) => a - b);
  const gaps = sorted.slice(1).map((t, i) => t - sorted[i]).filter((d) => d > 1e-4).sort((a, b) => a - b);
  const fd = gaps.length ? gaps[gaps.length >> 1] : 1 / 30;
  const lo = o.from - fd * 0.5, hi = o.to + fd * 0.5;
  const first = samples.findIndex((s) => ptsOf(s) >= lo);
  if (first < 0) return 1 / fd;
  let start = first;
  while (start > 0 && !samples[start].is_sync) start--;
  let end = samples.length - 1;
  for (let i = first; i < samples.length; i++) if (ptsOf(samples[i]) > hi + fd * 8) { end = i; break; }
  let decodeError: Error | null = null;
  const dec = new VideoDecoder({
    output: (frame) => {
      const pts = frame.timestamp / 1e6;
      if (pts >= lo && pts <= hi && o.alive()) o.onFrame(pts, frame);
      else frame.close();
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
  try {
    for (let i = start; i <= end; i++) {
      if (!o.alive()) return 1 / fd;
      if (decodeError) throw decodeError;
      const s = samples[i];
      dec.decode(new EncodedVideoChunk({
        type: s.is_sync ? 'key' : 'delta',
        timestamp: Math.round(ptsOf(s) * 1e6),
        duration: Math.round((s.duration / ts) * 1e6),
        data: s.data!,
      }));
      while (dec.decodeQueueSize > 16 && !decodeError) await waitDequeue(dec);
    }
    await dec.flush();
    if (decodeError) throw decodeError;
  } finally {
    if (dec.state !== 'closed') dec.close();
  }
  return 1 / fd;
}

// ───────────── 自動剪輯的素材抽樣：只解出指定時間點附近的格子 ─────────────

/**
 * 依序取 times（素材秒數）每個時間點最接近的一格，onFrame(第幾個時間點, frame)；frame 由 onFrame 負責 close。
 * 為什麼快：附近（tol 秒內）有關鍵影格就只解那一格（關鍵影格不依賴別的格子）；
 * 沒有的話從前一個關鍵影格解到那一格，同一段（GOP）裡的時間點一起解。不用一格一格 seek，也不受頁面在背景影響。
 */
export async function decodeAt(o: {
  url: string;
  times: number[];
  tol: number;
  /** 最多解幾格（大約）；超過就多用關鍵影格 */
  budget?: number;
  onFrame: (k: number, frame: VideoFrame) => void;
  onProgress?: (done: number, total: number) => void;
  alive: () => boolean;
}): Promise<void> {
  if (typeof VideoDecoder === 'undefined') throw new Error('no WebCodecs');
  const { file, track, samples } = await demuxUrl(o.url);
  const ts = track.timescale;
  const shift = editShift(track);
  const pts = samples.map((s) => s.cts / ts + shift);
  // 呈現順序（找最接近的格子用）
  const byPts = pts.map((_, i) => i).sort((a, b) => pts[a] - pts[b]);
  const syncs = byPts.filter((i) => samples[i].is_sync);
  const nearest = (list: number[], t: number) => {
    let lo = 0, hi = list.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pts[list[mid]] < t) lo = mid + 1;
      else hi = mid;
    }
    return lo > 0 && Math.abs(pts[list[lo - 1]] - t) <= Math.abs(pts[list[lo]] - t) ? list[lo - 1] : list[lo];
  };
  // 每個時間點要哪一格（解碼順序的 index），再依所屬的 GOP 分組
  const syncBefore = (i: number) => { let s = i; while (s > 0 && !samples[s].is_sync) s--; return s; };
  const plan = (tol: number) => {
    const groups = new Map<number, { end: number; want: Map<number, number[]> }>();
    o.times.forEach((t, k) => {
      if (!byPts.length) return;
      const ks = syncs.length ? nearest(syncs, t) : -1;
      const idx = ks >= 0 && Math.abs(pts[ks] - t) <= tol ? ks : nearest(byPts, t);
      const g0 = syncBefore(idx);
      const g = groups.get(g0) ?? { end: g0, want: new Map() };
      g.end = Math.max(g.end, idx);
      const key = Math.round(pts[idx] * 1e6);
      g.want.set(key, [...(g.want.get(key) ?? []), k]);
      groups.set(g0, g);
    });
    let cost = 0;
    for (const [g0, g] of groups) cost += g.end - g0 + 1;
    return { groups, cost };
  };
  // 要解的格數超過上限就放寬「用關鍵影格代替」的距離（關鍵影格很稀的影片，最後全部用關鍵影格）
  let { groups, cost } = plan(o.tol);
  for (let f = 2; cost > (o.budget ?? Infinity) && f <= 64; f *= 2) ({ groups, cost } = plan(o.tol * f));

  // 所有要的格子（時間戳記 → 時間點）；每一段都從關鍵影格開始送，段與段之間不用等解碼器清空
  const want = new Map<number, number[]>();
  for (const g of groups.values()) for (const [key, ks] of g.want) want.set(key, [...(want.get(key) ?? []), ...ks]);
  let decodeError: Error | null = null;
  const dec = new VideoDecoder({
    output: (frame) => {
      const ks = want.get(frame.timestamp);
      if (!ks || !o.alive()) return frame.close();
      want.delete(frame.timestamp);
      ks.forEach((k, j) => o.onFrame(k, j === ks.length - 1 ? frame : frame.clone()));
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
  try {
    const list = [...groups.entries()].sort((a, b) => a[0] - b[0]);
    for (let n = 0; n < list.length; n++) {
      const [g0, g] = list[n];
      for (let i = g0; i <= g.end; i++) {
        if (!o.alive()) return;
        if (decodeError) throw decodeError;
        const s = samples[i];
        dec.decode(new EncodedVideoChunk({
          type: i === g0 ? 'key' : 'delta',
          timestamp: Math.round(pts[i] * 1e6),
          duration: Math.round((s.duration / ts) * 1e6),
          data: s.data!,
        }));
        while (dec.decodeQueueSize > 16 && !decodeError) await waitDequeue(dec);
      }
      o.onProgress?.(n + 1, list.length);
    }
    await dec.flush();
    if (decodeError) throw decodeError;
  } finally {
    if (dec.state !== 'closed') dec.close();
  }
}

// ───────────── 預覽代理檔用 ─────────────

/** 關鍵影格的最大間隔（秒）與影片長度；拆不開（不是 MP4 / MOV）就丟錯 */
export async function keyframeInfo(url: string): Promise<{ maxGap: number; duration: number }> {
  const { track, samples } = await demuxUrl(url);
  const ts = track.timescale;
  const shift = editShift(track);
  const keys = samples.filter((s) => s.is_sync).map((s) => s.cts / ts + shift).sort((a, b) => a - b);
  const all = samples.map((s) => s.cts / ts + shift);
  const duration = all.length ? Math.max(...all) : 0;
  let maxGap = keys.length ? keys[0] : duration;
  for (let i = 1; i < keys.length; i++) maxGap = Math.max(maxGap, keys[i] - keys[i - 1]);
  maxGap = Math.max(maxGap, duration - (keys.at(-1) ?? 0));
  return { maxGap, duration };
}

/**
 * 依序解出整支影片的每一格：onFrame(pts, frame) 回傳的 Promise 完成才繼續（frame 由 onFrame 負責 close）；
 * 每送一批之前先 await wait()（例如時間軸播放中就先停著）。alive() = false 就停。回傳影格率。
 */
export async function decodeAllFrames(o: {
  url: string;
  onFrame: (pts: number, frame: VideoFrame) => Promise<void> | void;
  wait: () => Promise<void>;
  alive: () => boolean;
  onProgress?: (frac: number) => void;
  /** 解碼器要用硬體還是軟體（預設讓瀏覽器決定） */
  accel?: HardwareAcceleration;
}): Promise<number> {
  if (typeof VideoDecoder === 'undefined') throw new Error('no WebCodecs');
  const { file, track, samples } = await demuxUrl(o.url);
  const ts = track.timescale;
  const shift = editShift(track);
  const ptsOf = (s: Sample) => s.cts / ts + shift;
  const sorted = samples.map(ptsOf).sort((a, b) => a - b);
  const gaps = sorted.slice(1).map((t, i) => t - sorted[i]).filter((d) => d > 1e-4).sort((a, b) => a - b);
  const fd = gaps.length ? gaps[gaps.length >> 1] : 1 / 30;
  const queue: { pts: number; frame: VideoFrame }[] = [];
  let decodeError: Error | null = null;
  const dec = new VideoDecoder({
    output: (frame) => queue.push({ pts: frame.timestamp / 1e6, frame }),
    error: (e) => (decodeError = e instanceof Error ? e : new Error(String(e))),
  });
  const config: VideoDecoderConfig = {
    codec: track.codec,
    codedWidth: track.video?.width ?? track.track_width,
    codedHeight: track.video?.height ?? track.track_height,
    description: description(file, track),
    ...(o.accel ? { hardwareAcceleration: o.accel } : {}),
  };
  if (!(await VideoDecoder.isConfigSupported(config)).supported) throw new Error(`codec not supported: ${track.codec}`);
  dec.configure(config);
  const drain = async () => {
    while (queue.length) {
      const f = queue.shift()!;
      if (!o.alive()) { f.frame.close(); continue; }
      await o.onFrame(f.pts, f.frame);
    }
  };
  try {
    for (let i = 0; i < samples.length; i++) {
      if (!o.alive()) return 1 / fd;
      if (decodeError) throw decodeError;
      if (i % 8 === 0) await o.wait();
      const s = samples[i];
      dec.decode(new EncodedVideoChunk({
        type: s.is_sync ? 'key' : 'delta',
        timestamp: Math.round(ptsOf(s) * 1e6),
        duration: Math.round((s.duration / ts) * 1e6),
        data: s.data!,
      }));
      // 解出來的格子先處理掉（解碼器的影格數有限，不 close 會卡住）
      if (queue.length) await drain();
      // 等解碼器消化：用它的 dequeue 事件（最多 20ms），不要忙等（會占住主執行緒，編碼器的回呼也跟著變慢）
      while (dec.decodeQueueSize > 8 && !decodeError && o.alive()) {
        await new Promise<void>((r) => { dec.addEventListener('dequeue', () => r(), { once: true }); setTimeout(r, 20); });
        if (queue.length) await drain();
      }
      if (i % 30 === 0) o.onProgress?.(i / samples.length);
    }
    // 清空解碼器時也要一邊處理吐出來的格子（不 close 的話解碼器的緩衝用完，flush 永遠等不到）
    let flushed = false;
    const fl = dec.flush().finally(() => (flushed = true));
    while (!flushed && !decodeError) {
      if (queue.length) await drain();
      else await new Promise((r) => setTimeout(r, 5));
    }
    await fl;
    if (decodeError) throw decodeError;
    await drain();
  } finally {
    queue.forEach((f) => f.frame.close());
    if (dec.state !== 'closed') dec.close();
  }
  return 1 / fd;
}
