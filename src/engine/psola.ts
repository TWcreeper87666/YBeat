/** YIN 音高分析；f0 每格對應原始訊號的 hop 個取樣。 */
export function detectPitch(mono: Float32Array, sr: number): { f0: Float32Array; hop: number } {
  const factor = Math.max(1, Math.round(sr / 16000));
  const fs = sr / factor;
  const low = new Float32Array(Math.ceil(mono.length / factor));
  for (let i = 0; i < low.length; i++) {
    let sum = 0;
    for (let j = 0; j < factor; j++) sum += mono[Math.min(mono.length - 1, i * factor + j)] || 0;
    low[i] = sum / factor;
  }
  const hopLow = Math.max(1, Math.round(fs * 0.005));
  const hop = hopLow * factor;
  const win = Math.round(fs * 0.032);
  const lo = Math.max(2, Math.floor(fs / 1000));
  const hi = Math.min(Math.floor(fs / 60), win - 1);
  const f0 = new Float32Array(Math.ceil(low.length / hopLow));
  const diff = new Float32Array(hi + 1);
  for (let frame = 0; frame < f0.length; frame++) {
    const center = frame * hopLow;
    const start = Math.max(0, Math.min(low.length - win - hi, center - (win >> 1)));
    if (start < 0) continue;
    let energy = 0;
    for (let i = 0; i < win; i++) energy += low[start + i] ** 2;
    if (energy / win < 1e-5) continue;
    let running = 0, best = 0, bestScore = 1;
    for (let tau = 1; tau <= hi; tau++) {
      let d = 0;
      for (let i = 0; i < win; i++) {
        const x = low[start + i] - low[start + i + tau];
        d += x * x;
      }
      diff[tau] = d;
    }
    for (let tau = 1; tau <= hi; tau++) {
      const d = diff[tau];
      running += d;
      if (tau < lo) continue;
      const score = d * tau / Math.max(1e-12, running);
      if (score < bestScore) { bestScore = score; best = tau; }
      if (score < 0.2) {
        let k = tau;
        while (k < hi && diff[k + 1] < diff[k]) k++;
        best = k;
        break;
      }
    }
    if (best && bestScore < 0.4) {
      const a = diff[Math.max(1, best - 1)], b = diff[best], c = diff[Math.min(hi, best + 1)];
      const correction = Math.abs(a - 2 * b + c) > 1e-9 ? Math.max(-1, Math.min(1, (a - c) / (2 * (a - 2 * b + c)))) : 0;
      f0[frame] = fs / (best + correction);
    }
  }
  return { f0, hop };
}

export interface PitchMark { at: number; period: number; voiced: boolean }

/** 有音高時沿週期放標記；無音高時每 10ms 放一個。 */
export function pitchMarks(mono: Float32Array, sr: number, track: { f0: Float32Array; hop: number }): PitchMark[] {
  const marks: PitchMark[] = [];
  let at = 0;
  while (at < mono.length) {
    const hz = track.f0[Math.min(track.f0.length - 1, Math.floor(at / track.hop))] || 0;
    const voiced = hz >= 60 && hz <= 1000;
    const period = voiced ? sr / hz : sr * 0.01;
    let peak = Math.round(at);
    if (voiced) {
      const radius = Math.round(period / 4);
      let best = -1;
      const from = Math.max(0, peak - radius), to = Math.min(mono.length - 1, peak + radius);
      for (let j = from; j <= to; j++) {
        const v = Math.abs(mono[j]);
        if (v > best) { best = v; peak = j; }
      }
    }
    if (!marks.length || peak > marks[marks.length - 1].at) marks.push({ at: peak, period, voiced });
    at += period;
  }
  return marks;
}

/** 各聲道共用標記，按合成標記的位置疊加 Hann grain。 */
export function psola(channels: Float32Array[], sr: number, marks: PitchMark[], opts: { stretch: number; beta: (tOut: number) => number }): Float32Array[] {
  if (!channels.length) return [];
  const length = Math.max(1, Math.round(channels[0].length * opts.stretch));
  const out = channels.map(() => new Float32Array(length));
  const weights = new Float32Array(length);
  if (!marks.length) return out;
  let ts = 0, i = 0;
  while (ts < length) {
    const ta = ts / opts.stretch;
    while (i + 1 < marks.length && Math.abs(marks[i + 1].at - ta) < Math.abs(marks[i].at - ta)) i++;
    const mark = marks[i];
    const half = Math.max(1, Math.round(mark.period));
    const center = Math.round(ts);
    const beta = Math.max(0.25, Math.min(4, opts.beta(ts / sr)));
    // 有音高：grain 原樣疊（音色不變），靠間隔改音調。
    // 沒有音高（子音、背景音樂、雜音）：grain 本身重新取樣 β 倍、間隔不變（顆粒式變調，什麼聲音都適用）
    const read = mark.voiced ? 1 : beta;
    const n = channels[0].length;
    for (let j = -half; j <= half; j++) {
      const dst = center + j;
      if (dst < 0 || dst >= length) continue;
      const src = mark.at + j * read;
      const s0 = Math.floor(src), f = src - s0;
      if (s0 < 0 || s0 + 1 >= n) continue;
      const w = 0.5 + 0.5 * Math.cos(Math.PI * j / half);
      weights[dst] += w;
      for (let ch = 0; ch < out.length; ch++) {
        const c = channels[ch];
        out[ch][dst] += ((c[s0] || 0) * (1 - f) + (c[s0 + 1] || 0) * f) * w;
      }
    }
    ts += Math.max(1, mark.voiced ? mark.period / beta : mark.period);
  }
  for (const channel of out) for (let j = 0; j < length; j++) channel[j] /= Math.max(weights[j], 1);
  return out;
}

/**
 * 只處理要變調的段落（spans：取樣位置），其他地方原封不動；交界處（前後各 pad 個取樣，那裡不變調）淡入淡出接回原本的聲音。
 * 沒動到的字跟原版一模一樣（整段跑 PSOLA 就算不變調，重新疊合的波形也會跟原本有一點差）。
 * beta(t)：t = 從開頭算起的秒數。輸出長度跟輸入一樣（只變調、不變長度）。
 */
export function psolaPatch(channels: Float32Array[], sr: number, marks: PitchMark[], spans: { a: number; b: number }[], beta: (t: number) => number, pad = Math.round(sr * 0.03)): Float32Array[] {
  const out = channels.map((c) => c.slice());
  const n = channels[0]?.length ?? 0;
  if (!n) return out;
  // 加上前後的 pad，靠太近的合成同一塊（不然一塊的淡出會跟下一塊的變調重疊）
  const blocks: { a: number; b: number }[] = [];
  for (const s of [...spans].sort((x, y) => x.a - y.a)) {
    const a = Math.max(0, Math.floor(s.a) - pad), b = Math.min(n, Math.ceil(s.b) + pad);
    if (b <= a) continue;
    const last = blocks[blocks.length - 1];
    if (last && a <= last.b) last.b = Math.max(last.b, b);
    else blocks.push({ a, b });
  }
  for (const { a, b } of blocks) {
    const sub = channels.map((c) => c.subarray(a, b));
    const subMarks = marks.filter((m) => m.at >= a && m.at < b).map((m) => ({ ...m, at: m.at - a }));
    const done = psola(sub, sr, subMarks, { stretch: 1, beta: (t) => beta(a / sr + t) });
    const fade = Math.max(1, Math.min(pad, Math.floor((b - a) / 2)));
    for (let ch = 0; ch < out.length; ch++) {
      const o = out[ch], d = done[ch], src = channels[ch];
      for (let i = 0; i < b - a; i++) {
        // 開頭 / 結尾 fade 個取樣：原本 → 處理過的（開頭不是素材開頭時才需要）
        const w = Math.min(1, a > 0 ? i / fade : 1, b < n ? (b - a - 1 - i) / fade : 1);
        o[a + i] = src[a + i] * (1 - w) + d[i] * w;
      }
    }
  }
  return out;
}
