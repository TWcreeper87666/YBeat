/**
 * 保持音調的變速（WSOLA：Waveform Similarity Overlap-Add）。
 * 把聲音切成重疊的小段，依速度改變「取樣的間隔」再疊回去；每段會在附近找波形最像的位置接上，
 * 所以速度改變、音調不變。純函式（只處理 Float32Array），方便測試。
 */

const FRAME = 1024; // 每段長度（48kHz 約 21ms）
const HOP = FRAME / 2; // 輸出端每段間隔（50% 重疊）
const TOL = 256; // 往前後找最像位置的範圍（樣本）
const CORR_STEP = 4; // 算相似度時每幾個樣本取一個（加速）
const SEARCH_STEP = 2;

let hann: Float32Array | null = null;
function hannWindow(): Float32Array {
  if (hann) return hann;
  hann = new Float32Array(FRAME);
  for (let i = 0; i < FRAME; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME);
  return hann;
}

/**
 * 把多聲道音訊以 rate 倍速播放、音調不變。
 * 回傳長度約為 input.length / rate 的各聲道資料。
 */
export function timeStretch(channels: Float32Array[], rate: number): Float32Array<ArrayBuffer>[] {
  const n = channels[0]?.length ?? 0;
  if (!n || Math.abs(rate - 1) < 1e-4) return channels.map((c) => c.slice());
  const outLen = Math.max(1, Math.round(n / rate));
  const w = hannWindow();
  // 找最像位置只用單聲道（各聲道平均）
  const mono = new Float32Array(n);
  for (const c of channels) for (let i = 0; i < n; i++) mono[i] += c[i] / channels.length;
  const at = (i: number) => (i >= 0 && i < n ? mono[i] : 0);

  const out = channels.map(() => new Float32Array(outLen + FRAME));
  const norm = new Float32Array(outLen + FRAME);
  const ha = HOP * rate; // 輸入端每段間隔
  let prev = 0; // 上一段實際取的輸入位置

  for (let k = 0; k * HOP < outLen; k++) {
    const nominal = Math.round(k * ha);
    let pos = nominal;
    if (k > 0) {
      // 上一段在輸入中「自然接下去」的位置，跟 nominal 附近哪裡最像
      const cont = prev + HOP;
      let best = -Infinity;
      for (let d = -TOL; d <= TOL; d += SEARCH_STEP) {
        const p = nominal + d;
        if (p < 0 || p + FRAME > n + FRAME / 2) continue;
        let c = 0;
        for (let i = 0; i < FRAME; i += CORR_STEP) c += at(cont + i) * at(p + i);
        if (c > best) {
          best = c;
          pos = p;
        }
      }
    }
    const o = k * HOP;
    for (let ch = 0; ch < channels.length; ch++) {
      const src = channels[ch], dst = out[ch];
      for (let i = 0; i < FRAME; i++) {
        const j = pos + i;
        if (j >= 0 && j < n) dst[o + i] += src[j] * w[i];
      }
    }
    for (let i = 0; i < FRAME; i++) norm[o + i] += w[i];
    prev = pos;
  }
  return out.map((d) => {
    const r = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) r[i] = norm[i] > 1e-3 ? d[i] / norm[i] : d[i];
    return r;
  });
}
