export interface SpeechSpan { start: number; end: number }
const FRAME = 512, SR = 16000;

/** 將每格語音機率轉成秒數區間。 */
export function speechSegments(probs: ArrayLike<number>, sampleCount = probs.length * FRAME): SpeechSpan[] {
  const raw: SpeechSpan[] = [];
  let start = -1, endCandidate = -1;
  for (let i = 0; i < probs.length; i++) {
    const t = i * FRAME;
    if (probs[i] >= 0.5) { if (start < 0) start = t; endCandidate = -1; }
    else if (start >= 0 && probs[i] < 0.35) {
      if (endCandidate < 0) endCandidate = t;
      if (t - endCandidate >= 1600) {
        if (endCandidate - start >= 4000) raw.push({ start, end: endCandidate });
        start = -1; endCandidate = -1;
      }
    }
  }
  if (start >= 0 && sampleCount - start >= 4000) raw.push({ start, end: sampleCount });
  const out: SpeechSpan[] = [];
  for (const r of raw) {
    const span = { start: Math.max(0, r.start - 480) / SR, end: Math.min(sampleCount, r.end + 480) / SR };
    const prev = out[out.length - 1];
    if (prev && span.start <= prev.end) prev.end = Math.max(prev.end, span.end);
    else out.push(span);
  }
  return out;
}

/** 相鄰人聲合併成最長 28 秒的辨識視窗（Whisper 有前後文比較準） */
export function speechWindows(spans: SpeechSpan[], max = 28): SpeechSpan[] {
  const out: SpeechSpan[] = [];
  for (const span of spans) {
    let at = span.start;
    while (at < span.end - 1e-6) {
      const end = Math.min(span.end, at + max);
      const prev = out[out.length - 1];
      if (prev && end - prev.start <= max) prev.end = end;
      else out.push({ start: at, end });
      at = end;
    }
  }
  return out;
}

export type VadRun = (input: Float32Array, state: Float32Array) => Promise<{ probability: number; state: Float32Array }>;
/** 模型呼叫由 worker 提供，分格與狀態處理可在 Node 測試。 */
export async function vadProbabilities(samples: Float32Array, run: VadRun, onProgress?: (done: number, total: number) => void, signal?: AbortSignal): Promise<Float32Array> {
  const total = Math.floor(samples.length / FRAME), probs = new Float32Array(total);
  let state = new Float32Array(256), tail = new Float32Array(64);
  for (let i = 0; i < total; i++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const input = new Float32Array(576);
    input.set(tail); input.set(samples.subarray(i * FRAME, (i + 1) * FRAME), 64);
    const result = await run(input, state);
    probs[i] = result.probability; state = new Float32Array(result.state);
    tail = input.slice(512);
    onProgress?.(i + 1, total);
  }
  return probs;
}
