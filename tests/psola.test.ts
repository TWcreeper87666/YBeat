import { strict as assert } from 'node:assert';
import { detectPitch, pitchMarks, psola } from '../src/engine/psola';

const sr = 48000;
const input = new Float32Array(sr);
for (let i = 0; i < input.length; i++) {
  const t = i / sr;
  input[i] = 0.4 * Math.sin(2 * Math.PI * 150 * t) + 0.18 * Math.sin(2 * Math.PI * 300 * t) + 0.09 * Math.sin(2 * Math.PI * 450 * t);
}
const median = (a: Float32Array) => {
  const voiced = [...a.slice(Math.floor(a.length * 0.2), Math.floor(a.length * 0.8))].filter((v) => v > 0).sort((x, y) => x - y);
  return voiced[Math.floor(voiced.length / 2)] ?? 0;
};
const track = detectPitch(input, sr);
assert.ok(Math.abs(median(track.f0) - 150) / 150 < 0.03, `偵測 150 Hz：${median(track.f0)}`);
const marks = pitchMarks(input, sr, track);
const [up] = psola([input], sr, marks, { stretch: 1, beta: () => 2 });
assert.equal(up.length, input.length);
assert.ok(Math.abs(median(detectPitch(up, sr).f0) - 300) / 300 < 0.03, `升十二半音：${median(detectPitch(up, sr).f0)}`);
const [long] = psola([input], sr, marks, { stretch: 2, beta: () => 1 });
assert.equal(long.length, input.length * 2);
assert.ok(Math.abs(median(detectPitch(long, sr).f0) - 150) / 150 < 0.03, '拉長後音高不變');
const silence = new Float32Array(sr / 4);
const [quiet] = psola([silence], sr, pitchMarks(silence, sr, detectPitch(silence, sr)), { stretch: 2, beta: () => 2 });
assert.ok(quiet.every(Number.isFinite), '靜音沒有 NaN');
// 沒有音高的部分（背景音樂、雜音）也要變調：標記全部當成沒有音高，數過零點估頻率
const hi = new Float32Array(sr / 2);
for (let i = 0; i < hi.length; i++) hi[i] = 0.3 * Math.sin(2 * Math.PI * 2000 * i / sr);
const hiTrack = detectPitch(hi, sr);
const hiMarks = pitchMarks(hi, sr, { f0: new Float32Array(hiTrack.f0.length), hop: hiTrack.hop });
const [hiUp] = psola([hi], sr, hiMarks, { stretch: 1, beta: () => 2 ** (5 / 12) });
const freq = (x: Float32Array) => {
  let z = 0;
  const a = Math.floor(x.length * 0.2), b = Math.floor(x.length * 0.8);
  for (let i = a + 1; i < b; i++) if ((x[i - 1] < 0) !== (x[i] < 0)) z++;
  return (z / 2) / ((b - a) / sr);
};
assert.ok(Math.abs(freq(hiUp) / 2000 - 2 ** (5 / 12)) < 0.05, `沒有音高的部分也變調：${freq(hiUp)}`);
console.log('PSOLA 通過');
