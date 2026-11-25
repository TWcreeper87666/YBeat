/**
 * 錄製分頁的 Worker（見 tabRecord.ts）：主執行緒把擷取到的影像 / 聲音串流傳過來，這裡讀取、編碼、收聲音。
 * 放在 Worker：編輯器分頁在背景時主執行緒的計時器會被節流到一秒一次，預覽也會搶時間，錄影會卡、聲音會掉。
 *
 * 時間：影像固定 30fps（分頁畫面沒變時瀏覽器不送新格，這裡補上重複的格）；
 * 聲音照每段自己的時間戳放（中間掉了就是靜音，不會整段往前縮而對不上）；
 * 影像和聲音的時間戳不一定同一個基準 → 各自用「收到的時間 − 時間戳」的最小值對到同一個時鐘。
 */
import { FPS, KEY_EVERY, type RecChunk, type RecIn, type RecOut } from './tabRecordTypes';

const post = (m: RecOut, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);
/** 絕對時間（µs）：跟主執行緒同一個時鐘（兩邊的 performance.now 起點不同） */
const nowUs = () => (performance.timeOrigin + performance.now()) * 1000;

let stop: (() => void) | null = null;
let onAudio: ((m: Extract<RecIn, { type: 'audio' }>) => void) | null = null;

async function run(o: Extract<RecIn, { type: 'start' }>) {
  const { w, h } = o;
  const canvas = new OffscreenCanvas(w, h);
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, w, h);

  const chunks: RecChunk[] = [];
  let decoderConfig: VideoDecoderConfig | null = null;
  let encError: unknown = null;
  const enc = new VideoEncoder({
    output: (c, meta) => {
      if (meta?.decoderConfig && !decoderConfig) decoderConfig = meta.decoderConfig;
      const data = new ArrayBuffer(c.byteLength);
      c.copyTo(data);
      chunks.push({ data, key: c.type === 'key', timestamp: c.timestamp, duration: c.duration ?? Math.round(1e6 / FPS) });
    },
    error: (e) => (encError = e),
  });
  enc.configure(o.cfg);

  let stopped = false;
  const reader = o.video.getReader();
  const stopped$ = new Promise<void>((res) => (stop = res));
  void stopped$.then(() => {
    stopped = true;
    void reader.cancel().catch(() => {});
  });

  // ── 影像 ──
  let vTs0: number | null = null; // 第一格的時間戳（µs）
  let vLat = Infinity; // 收到的時間 − 時間戳 的最小值
  let slot = 0;
  const emit = (until: number) => {
    while (slot / FPS < until - 1e-6) {
      const f = new VideoFrame(canvas, { timestamp: Math.round((slot * 1e6) / FPS), duration: Math.round(1e6 / FPS) });
      enc.encode(f, { keyFrame: slot % KEY_EVERY === 0 });
      f.close();
      slot++;
    }
  };
  const draw = (f: VideoFrame) => {
    const fw = f.displayWidth, fh = f.displayHeight;
    const s = Math.min(w / fw, h / fh);
    const dw = fw * s, dh = fh * s;
    g.fillRect(0, 0, w, h);
    g.drawImage(f, (w - dw) / 2, (h - dh) / 2, dw, dh);
  };
  const probe = new OffscreenCanvas(16, 16).getContext('2d', { willReadFrequently: true })!;
  const blank = (f: VideoFrame) => {
    probe.drawImage(f, 0, 0, 16, 16);
    const px = probe.getImageData(0, 0, 16, 16).data;
    for (let i = 0; i < px.length; i += 4) if (px[i] + px[i + 1] + px[i + 2] > 24) return false;
    return true;
  };
  let skipUntil: number | undefined;
  const videoLoop = (async () => {
    for (;;) {
      const { value: f, done } = await reader.read().catch(() => ({ value: undefined, done: true as const }));
      if (done || !f) break;
      if (stopped) { f.close(); continue; }
      // 剛開始擷取時可能先送幾格全黑的：跳過（最多 1 秒）
      if (vTs0 === null && blank(f) && (skipUntil ??= performance.now() + 1000) > performance.now()) { f.close(); continue; }
      if (vTs0 === null) vTs0 = f.timestamp;
      vLat = Math.min(vLat, nowUs() - f.timestamp);
      emit((f.timestamp - vTs0) / 1e6);
      draw(f);
      f.close();
      // 編碼器跟不上：等一下（Worker 的計時器不會被背景分頁節流）
      while (enc.encodeQueueSize > 8 && !stopped) await new Promise((r) => setTimeout(r, 2));
    }
  })();

  // ── 聲音：照時間戳放 ──
  const parts: { at: number; ch: Float32Array[] }[] = [];
  let rate = 48000;
  let aTs0: number | null = null;
  let aLat = Infinity;
  let cursor: number | null = null; // 上一段結束的位置（樣本）
  onAudio = (m) => {
    if (stopped) return;
    if (aTs0 === null) { aTs0 = m.ts; rate = m.rate; }
    const n = m.ch[0].length;
    // 一段聲音的時間戳是它第一個樣本的時間，收到時整段已經錄完
    aLat = Math.min(aLat, m.at - m.ts - (n / m.rate) * 1e6);
    // 一段接一段緊接著放；時間戳跟接續的位置差太多（中間真的掉了聲音）才跳到時間戳的位置。
    // 每段都照時間戳四捨五入的話，段與段之間會差一兩個樣本（重疊 / 空隙），每 10ms 一個爆音 = 一直沙沙的雜訊
    const want = Math.round(((m.ts - aTs0) / 1e6) * rate);
    const at = cursor === null || Math.abs(want - cursor) > rate * 0.03 ? want : cursor;
    parts.push({ at, ch: m.ch });
    cursor = at + n;
  };

  post({ type: 'started' });
  await stopped$;
  // 停下的那一刻換算成影像的時間
  const end = vTs0 === null ? 0 : (nowUs() - vLat - vTs0) / 1e6;
  onAudio = null;
  await videoLoop;
  emit(Math.max(end, 1 / FPS));
  await enc.flush();
  enc.close();
  if (encError) throw encError;

  const duration = slot / FPS;
  let audio: { rate: number; ch: Float32Array[] } | null = null;
  if (parts.length && vTs0 !== null && aTs0 !== null) {
    const n = Math.round(duration * rate);
    // 聲音開頭在影像 0 秒之後幾個樣本（負的 = 比影像早，前面丟掉）
    let lag = ((aTs0 + aLat) - (vTs0 + vLat)) / 1e6;
    // 差超過 1 秒一定是哪裡算錯（時間戳基準怪怪的）：寧可不對齊，也不要把聲音推到影片外面
    if (!(Math.abs(lag) < 1)) {
      console.warn('tab recording: audio/video offset looks wrong, ignored', lag);
      lag = 0;
    }
    const offset = Math.round(lag * rate);
    const ch = [new Float32Array(n), new Float32Array(n)];
    for (const p of parts) {
      const at = p.at + offset;
      const from = Math.max(0, -at);
      const to = Math.min(p.ch[0].length, n - at);
      if (to <= from) continue;
      for (let c = 0; c < 2; c++) ch[c].set(p.ch[c].subarray(from, to), at + from);
    }
    audio = { rate, ch };
  }
  post({ type: 'done', w, h, chunks, decoderConfig, audio, duration },
    [...chunks.map((c) => c.data), ...(audio ? audio.ch.map((c) => c.buffer) : [])]);
}

self.onmessage = (e: MessageEvent<RecIn>) => {
  const m = e.data;
  if (m.type === 'start') run(m).catch((err) => post({ type: 'error', err: String(err) }));
  else if (m.type === 'audio') onAudio?.(m);
  else stop?.();
};
