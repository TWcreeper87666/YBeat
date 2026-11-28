/** Beat This! small0 的音訊前處理與預測後處理。 */
export const FFT = 1024, HOP = 441, MELS = 128, CHUNK = 1500, BORDER = 6;
const hann = Float32Array.from({ length: FFT }, (_, n) => 0.5 - 0.5 * Math.cos(2 * Math.PI * n / FFT));
// FFT 的旋轉因子：tw[k] = e^(-2πik/FFT)
const twRe = Float32Array.from({ length: FFT / 2 }, (_, k) => Math.cos(-2 * Math.PI * k / FFT));
const twIm = Float32Array.from({ length: FFT / 2 }, (_, k) => Math.sin(-2 * Math.PI * k / FFT));
const reflect = (i: number, n: number) => {
  if (n === 1) return 0;
  while (i < 0 || i >= n) i = i < 0 ? -i : 2 * n - 2 - i;
  return i;
};

/** 22050 Hz 單聲道 → torchaudio 相同的 log-mel，shape [T,128]。 */
export function logMel(wav: Float32Array, filter: Float32Array): Float32Array {
  if (filter.length !== 513 * MELS) throw new Error('mel filter size');
  if (!wav.length) return new Float32Array();
  const frames = 1 + Math.floor(wav.length / HOP);
  const out = new Float32Array(frames * MELS);
  const re = new Float32Array(FFT), im = new Float32Array(FFT);
  const inv = 1 / Math.sqrt(FFT);
  for (let frame = 0; frame < frames; frame++) {
    const center = frame * HOP;
    for (let i = 0; i < FFT; i++) { re[i] = wav[reflect(center + i - FFT / 2, wav.length)] * hann[i]; im[i] = 0; }
    // 原地 radix-2 FFT。
    for (let i = 1, j = 0; i < FFT; i++) {
      let bit = FFT >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { const t = re[i]; re[i] = re[j]; re[j] = t; }
    }
    for (let len = 2; len <= FFT; len <<= 1) {
      const half = len >> 1, step = FFT / len;
      for (let start = 0; start < FFT; start += len) for (let k = 0; k < half; k++) {
        const c = twRe[k * step], s = twIm[k * step];
        const a = start + k, b = a + half;
        const tr = re[b] * c - im[b] * s, ti = re[b] * s + im[b] * c;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
      }
    }
    for (let f = 0; f <= FFT / 2; f++) {
      const mag = Math.hypot(re[f], im[f]) * inv;
      const offset = f * MELS, dest = frame * MELS;
      for (let m = 0; m < MELS; m++) out[dest + m] += mag * filter[offset + m];
    }
    for (let m = 0; m < MELS; m++) out[frame * MELS + m] = Math.log1p(1000 * out[frame * MELS + m]);
  }
  return out;
}

export function chunkStarts(frames: number): number[] {
  const starts: number[] = [];
  for (let s = -BORDER; s < frames - BORDER; s += CHUNK - 2 * BORDER) starts.push(s);
  if (frames > CHUNK - 2 * BORDER && starts.length) starts[starts.length - 1] = frames - (CHUNK - BORDER);
  return starts;
}
export function splitSpect(spect: Float32Array): { start: number; data: Float32Array }[] {
  const frames = spect.length / MELS;
  return chunkStarts(frames).map((start) => {
    const data = new Float32Array(CHUNK * MELS);
    const from = Math.max(0, start), to = Math.min(frames, start + CHUNK);
    data.set(spect.subarray(from * MELS, to * MELS), (from - start) * MELS);
    return { start, data };
  });
}
export function aggregatePredictions(frames: number, chunks: { start: number; values: Float32Array }[]): Float32Array {
  const out = new Float32Array(frames).fill(-1000);
  for (let j = chunks.length - 1; j >= 0; j--) {
    const { start, values } = chunks[j];
    for (let i = BORDER; i < CHUNK - BORDER; i++) {
      const dest = start + i;
      if (dest >= 0 && dest < frames) out[dest] = values[i];
    }
  }
  return out;
}
export function peaks(logits: ArrayLike<number>): number[] {
  const groups: number[][] = [];
  for (let i = 0; i < logits.length; i++) {
    if (logits[i] <= 0) continue;
    let max = -Infinity;
    for (let j = Math.max(0, i - 3); j <= Math.min(logits.length - 1, i + 3); j++) max = Math.max(max, logits[j]);
    if (logits[i] !== max) continue;
    const group = groups[groups.length - 1];
    if (group && i - group[group.length - 1] <= 1) group.push(i);
    else groups.push([i]);
  }
  return groups.map((g) => g.reduce((a, b) => a + b, 0) / g.length / 50);
}
export function postprocess(beat: ArrayLike<number>, downbeat: ArrayLike<number>) {
  const beats = peaks(beat), downs = peaks(downbeat), downbeats: number[] = [];
  for (const d of downs) {
    if (!beats.length) break;
    let best = beats[0];
    for (const b of beats) if (Math.abs(b - d) < Math.abs(best - d)) best = b;
    if (downbeats[downbeats.length - 1] !== best) downbeats.push(best);
  }
  return { beats, downbeats };
}
