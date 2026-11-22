export interface Bands { pps: number; low: Float32Array; mid: Float32Array; high: Float32Array }

/** 單聲道取樣轉成三頻帶 RMS 包絡。 */
export function bandEnvelopes(samples: Float32Array, sampleRate: number, pps = 50): Bands {
  const n = sampleRate > 0 && pps > 0 ? Math.ceil(samples.length * pps / sampleRate) : 0;
  const low = new Float32Array(n), mid = new Float32Array(n), high = new Float32Array(n);
  if (!n) return { pps, low, mid, high };
  const aLow = 1 - Math.exp(-2 * Math.PI * 200 / sampleRate);
  const aHigh = 1 - Math.exp(-2 * Math.PI * 2000 / sampleRate);
  let lp = 0, hpBase = 0;
  const sums = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
  const counts = new Uint32Array(n);
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i];
    lp += aLow * (x - lp);
    hpBase += aHigh * (x - hpBase);
    const band = Math.min(n - 1, Math.floor(i * pps / sampleRate));
    const m = hpBase - lp, h = x - hpBase;
    sums[0][band] += lp * lp;
    sums[1][band] += m * m;
    sums[2][band] += h * h;
    counts[band]++;
  }
  for (let i = 0; i < n; i++) {
    low[i] = Math.sqrt(sums[0][i] / counts[i]);
    mid[i] = Math.sqrt(sums[1][i] / counts[i]);
    high[i] = Math.sqrt(sums[2][i] / counts[i]);
  }
  return { pps, low, mid, high };
}

export type SectionKind = 'intro' | 'build' | 'drop' | 'outro' | 'body';
export interface Section { b0: number; b1: number; energy: number; kind: SectionKind }
export interface MusicInfo {
  energy: number[];
  level: (0 | 1 | 2)[];
  sections: Section[];
  drops: number[];
  accents: number[];
}

const mean = (a: number[], b0: number, b1: number) => {
  let sum = 0;
  for (let i = b0; i < b1; i++) sum += a[i];
  return b1 > b0 ? sum / (b1 - b0) : 0;
};

function beatMeans(beats: { t: number }[], values: ArrayLike<number>, pps: number): number[] {
  return beats.map((beat, i) => {
    const period = beats.length > 1 ? beats[beats.length - 1].t - beats[beats.length - 2].t : 0.5;
    const end = i + 1 < beats.length ? beats[i + 1].t : beat.t + period;
    const b0 = Math.max(0, Math.floor(beat.t * pps));
    const b1 = Math.min(values.length, Math.max(b0 + 1, Math.floor(end * pps)));
    let sum = 0;
    for (let j = b0; j < b1; j++) sum += Math.max(0, values[j] || 0);
    return b1 > b0 ? sum / (b1 - b0) : 0;
  });
}

/** 每拍音量、段落、落點與重拍。 */
export function analyzeMusic(beats: { t: number; s: number; down: boolean }[], peaks: ArrayLike<number>, pps: number, bands?: Bands): MusicInfo {
  const n = beats.length;
  if (!n) return { energy: [], level: [], sections: [], drops: [], accents: [] };
  const raw = beatMeans(beats, peaks, pps);
  const smooth = raw.map((_, i) => mean(raw, Math.max(0, i - 2), Math.min(n, i + 3)));
  const sorted = [...smooth].sort((a, b) => a - b);
  const ref = sorted[Math.floor((n - 1) * 0.95)] || 1;
  const energy = smooth.map((v) => Math.min(1, v / ref));
  const spread = sorted[n - 1] - sorted[0];
  const level: (0 | 1 | 2)[] = spread < Math.max(1e-5, sorted[n - 1] * 0.03)
    ? Array(n).fill(1) : energy.map((v) => v < 0.45 ? 0 : v < 0.75 ? 1 : 2);
  const features = [energy];
  if (bands) {
    for (const band of [bands.low, bands.mid, bands.high]) {
      const values = beatMeans(beats, band, bands.pps);
      const peak = [...values].sort((a, b) => a - b)[Math.floor((n - 1) * 0.95)] || 1;
      features.push(values.map((v) => Math.min(1, v / peak)));
    }
  }

  const firstDown = Math.max(0, beats.findIndex((b) => b.down));
  const novelty = new Array<number>(n).fill(0);
  for (let i = 8; i <= n - 8; i++) {
    novelty[i] = Math.sqrt(features.reduce((sum, f) => sum + (mean(f, i - 8, i) - mean(f, i, i + 8)) ** 2, 0));
  }
  const boundaries = [0];
  if (n >= 16 && spread >= Math.max(1e-5, sorted[n - 1] * 0.03)) {
    const candidates: { i: number; score: number }[] = [];
    for (let i = 8; i <= n - 8; i++) {
      if (!beats[i].down) continue;
      const distance = Math.min(...[8, 16].map((step) => Math.abs((i - firstDown) % step)));
      const score = novelty[i] * (distance === 0 ? 1.2 : 0.8);
      if (score > 0.18) candidates.push({ i, score });
    }
    candidates.sort((a, b) => b.score - a.score || a.i - b.i);
    for (const candidate of candidates) {
      if (boundaries.every((b) => Math.abs(b - candidate.i) >= 8) && n - candidate.i >= 8) boundaries.push(candidate.i);
    }
  }
  boundaries.push(n);
  boundaries.sort((a, b) => a - b);

  const drops: number[] = [];
  for (let d = 16; d <= n - 8; d++) {
    if (!beats[d].down) continue;
    const dip = mean(raw, d - 4, d);
    const before = mean(raw, Math.max(0, d - 12), d - 4);
    const after = mean(raw, d, d + 8);
    const rebound = dip < before * 0.65 && dip < after * 0.55 && after > before * 1.2;
    const jump = boundaries.includes(d) && mean(energy, d, Math.min(n, d + 8)) - mean(energy, d - 8, d) > 0.3;
    if ((rebound || jump) && (drops.length === 0 || d - drops[drops.length - 1] >= 16)) drops.push(d);
  }
  const sections: Section[] = boundaries.slice(0, -1).map((b0, i) => ({
    b0, b1: boundaries[i + 1], energy: mean(energy, b0, boundaries[i + 1]), kind: 'body',
  }));
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    if (i === 0 && section.energy < 0.6) section.kind = 'intro';
    else if (i === sections.length - 1 && i > 0 && section.energy < sections[i - 1].energy * 0.8) section.kind = 'outro';
    else if (drops.some((d) => Math.abs(d - section.b0) <= 4)) section.kind = 'drop';
    else if (i + 1 < sections.length && drops.some((d) => Math.abs(d - section.b1) <= 4)) section.kind = 'build';
  }
  const accents: number[] = [];
  const ranked = beats.map((b, i) => ({ i, score: b.s * (b.down ? 1.4 : 1) * (0.4 + energy[i]) }))
    .sort((a, b) => b.score - a.score || a.i - b.i);
  for (const item of ranked) {
    if (accents.every((i) => Math.abs(i - item.i) >= 8)) accents.push(item.i);
    if (accents.length === 8) break;
  }
  accents.sort((a, b) => a - b);
  return { energy, level, sections, drops, accents };
}
