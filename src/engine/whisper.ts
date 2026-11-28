import type { Cue } from './subtitles';

export const WHISPER_SR = 16000, WHISPER_SAMPLES = 480000, WHISPER_FRAMES = 3000;
const FFT = 400, HOP = 160, BINS = 201, MELS = 80, TS = 50364, EOT = 50257;
const hann = Float64Array.from({ length: FFT }, (_, n) => 0.5 - 0.5 * Math.cos(2 * Math.PI * n / FFT));
const cos = new Float64Array(BINS * FFT), sin = new Float64Array(BINS * FFT);
for (let k = 0; k < BINS; k++) for (let n = 0; n < FFT; n++) {
  cos[k * FFT + n] = Math.cos(2 * Math.PI * k * n / FFT) * hann[n];
  sin[k * FFT + n] = Math.sin(2 * Math.PI * k * n / FFT) * hann[n];
}
const hzToMel = (hz: number) => hz < 1000 ? hz / (200 / 3) : 15 + Math.log(hz / 1000) / (Math.log(6.4) / 27);
const melToHz = (mel: number) => mel < 15 ? mel * (200 / 3) : 1000 * Math.exp(Math.log(6.4) / 27 * (mel - 15));
const melHz = Float64Array.from({ length: MELS + 2 }, (_, i) => melToHz(hzToMel(8000) * i / (MELS + 1)));
const filters = new Float32Array(MELS * BINS);
for (let m = 0; m < MELS; m++) for (let k = 0; k < BINS; k++) {
  const hz = k * 40, left = (hz - melHz[m]) / (melHz[m + 1] - melHz[m]);
  const right = (melHz[m + 2] - hz) / (melHz[m + 2] - melHz[m + 1]);
  filters[m * BINS + k] = Math.max(0, Math.min(left, right)) * 2 / (melHz[m + 2] - melHz[m]);
}
const reflect = (i: number) => i < 0 ? -i : i >= WHISPER_SAMPLES ? 2 * WHISPER_SAMPLES - 2 - i : i;

/** 30 秒、80 × 3000 的 Whisper log-mel 特徵。 */
export function whisperFeatures(samples: Float32Array): Float32Array {
  const wav = new Float32Array(WHISPER_SAMPLES);
  wav.set(samples.subarray(0, WHISPER_SAMPLES));
  const out = new Float32Array(MELS * WHISPER_FRAMES), power = new Float32Array(BINS);
  let high = -Infinity;
  for (let f = 0; f < WHISPER_FRAMES; f++) {
    const center = f * HOP;
    for (let k = 0; k < BINS; k++) {
      let re = 0, im = 0, offset = k * FFT;
      for (let n = 0; n < FFT; n++) {
        const v = wav[reflect(center + n - FFT / 2)];
        re += v * cos[offset + n]; im -= v * sin[offset + n];
      }
      re = Math.fround(re); im = Math.fround(im);
      power[k] = re * re + im * im;
    }
    for (let m = 0; m < MELS; m++) {
      let v = 0, offset = m * BINS;
      for (let k = 0; k < BINS; k++) v += power[k] * filters[offset + k];
      const log = Math.log10(Math.max(v, 1e-10));
      out[m * WHISPER_FRAMES + f] = log;
      if (log > high) high = log;
    }
  }
  const floor = high - 8;
  for (let i = 0; i < out.length; i++) out[i] = (Math.max(out[i], floor) + 4) / 4;
  return out;
}

export interface GenerationConfig { lang_to_id: Record<string, number>; suppress_tokens: number[]; begin_suppress_tokens: number[] }
const argmax = (a: ArrayLike<number>) => { let best = -Infinity, id = 0; for (let i = 0; i < a.length; i++) if (a[i] > best) { best = a[i]; id = i; } return id; };
export function detectLanguage(logits: ArrayLike<number>, config: GenerationConfig): number {
  let best = -Infinity, id = 0;
  for (const lang of Object.values(config.lang_to_id)) if (logits[lang] > best) { best = logits[lang]; id = lang; }
  return id;
}

/** 參照生成設定套用抑制、時間戳與機率規則。 */
export function nextWhisperToken(values: ArrayLike<number>, gen: number[], config: GenerationConfig): number {
  const logits = Float64Array.from(values);
  for (const t of config.suppress_tokens) logits[t] = -Infinity;
  if (!gen.length) for (const t of config.begin_suppress_tokens) logits[t] = -Infinity;
  logits[50363] = -Infinity;
  const lastTs = gen.length >= 1 && gen[gen.length - 1] >= TS;
  const penTs = gen.length < 2 || gen[gen.length - 2] >= TS;
  if (lastTs) {
    if (penTs) logits.fill(-Infinity, TS);
    else logits.fill(-Infinity, 0, EOT);
  }
  const prev = gen.filter((x) => x >= TS);
  if (prev.length) logits.fill(-Infinity, TS, lastTs && !penTs ? prev[prev.length - 1] : prev[prev.length - 1] + 1);
  if (!gen.length) { logits.fill(-Infinity, 0, TS); logits.fill(-Infinity, TS + 51); }
  let max = -Infinity;
  for (const v of logits) max = Math.max(max, v);
  let sum = 0, tsSum = 0, textMax = -Infinity;
  for (let i = 0; i < logits.length; i++) {
    const exp = Math.exp(logits[i] - max); sum += exp;
    if (i >= TS) tsSum += exp;
    else textMax = Math.max(textMax, logits[i]);
  }
  if (Math.log(tsSum / sum) > (textMax - max) - Math.log(sum)) logits.fill(-Infinity, 0, TS);
  return argmax(logits);
}

/** GPT-2 的位元組字元對照。 */
export function bytesToUnicode(): string[] {
  const bs: number[] = [];
  for (let i = 33; i <= 126; i++) bs.push(i);
  for (let i = 161; i <= 172; i++) bs.push(i);
  for (let i = 174; i <= 255; i++) bs.push(i);
  const cs = [...bs]; let extra = 0;
  for (let i = 0; i < 256; i++) if (!bs.includes(i)) { bs.push(i); cs.push(256 + extra++); }
  const out: string[] = [];
  bs.forEach((b, i) => { out[b] = String.fromCodePoint(cs[i]); });
  return out;
}
const byteMap = new Map(bytesToUnicode().map((v, i) => [v, i]));
export function decodeWhisper(ids: number[], vocab: Record<string, number>): string {
  const inverse: string[] = [];
  for (const [token, id] of Object.entries(vocab)) inverse[id] = token;
  const bytes: number[] = [];
  for (const id of ids) if (id < EOT && inverse[id]) for (const c of inverse[id]) bytes.push(byteMap.get(c) ?? 63);
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

/** 中文後面的半形標點換成全形 */
export function zhPunctuation(text: string): string {
  const full: Record<string, string> = { ',': '，', '?': '？', '!': '！', ':': '：', ';': '；' };
  return text.replace(/([㐀-鿿豈-﫿])\s*([,?!:;])\s*/g, (_, c: string, p: string) => c + full[p]);
}

export function whisperCues(tokens: number[], vocab: Record<string, number>, windowEnd: number): Cue[] {
  const cues: Cue[] = [];
  let start: number | null = null, text: number[] = [];
  const flush = (end: number) => {
    const value = decodeWhisper(text, vocab).trim();
    if (start !== null && value && end > start) cues.push({ start, end: Math.min(end, windowEnd), text: value });
    text = [];
  };
  for (const t of tokens) {
    if (t === EOT) break;
    if (t >= TS) { const at = (t - TS) * 0.02; if (text.length) flush(at); start = at; }
    else text.push(t);
  }
  if (text.length) flush(windowEnd);
  return cues;
}
