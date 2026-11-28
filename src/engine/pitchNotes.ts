export interface Note { a: number; b: number; midi: number }

export const hzToMidi = (hz: number) => 69 + 12 * Math.log2(hz / 440);
export const midiName = (m: number) => {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const n = Math.round(m);
  return `${names[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`;
};

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

/** 把有聲段中的穩定音高切成音符，時間以分析範圍開頭為準。 */
export function detectNotes(f0: Float32Array, hop: number, sr: number): Note[] {
  if (!f0.length || hop <= 0 || sr <= 0) return [];
  const dt = hop / sr;
  const raw = Array.from(f0, (hz) => hz > 0 && Number.isFinite(hz) ? hzToMidi(hz) : 0);
  // 八度誤判（YIN 常把音高抓成高 / 低八度）：跟前一格差大約一個八度就折回去
  for (let i = 1, prev = raw[0]; i < raw.length; i++) {
    if (!raw[i]) continue;
    if (prev) {
      for (const k of [12, -12, 24, -24]) if (Math.abs(raw[i] - prev - k) < 1.5) { raw[i] -= k; break; }
    }
    prev = raw[i];
  }
  const filled = [...raw];
  const gap = Math.ceil(0.03 / dt);
  for (let i = 0; i < raw.length;) {
    if (raw[i]) { i++; continue; }
    let j = i;
    while (j < raw.length && !raw[j]) j++;
    if (i > 0 && j < raw.length && j - i < gap) {
      for (let k = i; k < j; k++) filled[k] = raw[i - 1] + (raw[j] - raw[i - 1]) * (k - i + 1) / (j - i + 1);
    }
    i = j;
  }
  const smooth = filled.map((v, i) => v ? median(filled.slice(Math.max(0, i - 2), Math.min(filled.length, i + 3)).filter(Boolean)) : 0);
  const notes: Note[] = [];
  const minShift = Math.ceil(0.04 / dt);
  const emit = (a: number, b: number) => {
    if ((b - a) * dt < 0.05) return;
    const values = smooth.slice(a, b).filter(Boolean);
    if (values.length) notes.push({ a: a * dt, b: b * dt, midi: median(values) });
  };
  for (let i = 0; i < smooth.length;) {
    if (!smooth[i]) { i++; continue; }
    const start = i;
    while (i < smooth.length && smooth[i]) i++;
    const end = i;
    let noteStart = start;
    for (let j = start + 1; j < end;) {
      const center = median(smooth.slice(noteStart, j));
      if (Math.abs(smooth[j] - center) <= 1.5) { j++; continue; }
      const sign = Math.sign(smooth[j] - center);
      let k = j;
      while (k < end && Math.sign(smooth[k] - center) === sign && Math.abs(smooth[k] - center) > 1.5) k++;
      if (k - j >= minShift) { emit(noteStart, j); noteStart = j; j = k; }
      else j = k;
    }
    emit(noteStart, end);
  }
  return notes;
}
