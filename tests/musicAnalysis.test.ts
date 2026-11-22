import { analyzeMusic, bandEnvelopes } from '../src/engine/musicAnalysis';

let fails = 0;
const ok = (cond: boolean, msg: string) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) fails++;
};

const pps = 100, period = 60 / 128;
const values = [...Array(16).fill(0.2), ...Array(16).fill(0.5), ...Array(4).fill(0.05), ...Array(32).fill(0.9), ...Array(16).fill(0.2)];
const beats = values.map((_, i) => ({ t: i * period, s: 1, down: i % 4 === 0 }));
const peaks = Float32Array.from({ length: Math.ceil(values.length * period * pps) }, (_, i) => values[Math.min(values.length - 1, Math.floor(i / (period * pps)))]);
const info = analyzeMusic(beats, peaks, pps);
ok(info.level[4] === 0 && info.level[45] === 2, '安靜與響亮段落分級');
ok(info.sections.some((s) => Math.abs(s.b0 - 36) <= 4) || info.drops.some((d) => Math.abs(d - 36) <= 4), '落點附近有段落邊界');
ok(info.drops.some((d) => Math.abs(d - 36) <= 4), '偵測落點');
ok(info.sections[0]?.kind === 'intro' && info.sections.at(-1)?.kind === 'outro', '片頭與片尾分類');
const constant = analyzeMusic(beats, new Float32Array(peaks.length).fill(0.5), pps);
ok(constant.level.every((v) => v === 1) && constant.sections.length === 1, '固定音量只有一段中能量');
const sine = (hz: number) => Float32Array.from({ length: 44100 }, (_, i) => Math.sin(2 * Math.PI * hz * i / 44100));
const low = bandEnvelopes(sine(100), 44100);
const high = bandEnvelopes(sine(5000), 44100);
const avg = (a: Float32Array) => Array.from(a).reduce((sum, v) => sum + v, 0) / a.length;
ok(avg(low.low) > avg(low.high) * 5, '100Hz 主要在低頻');
ok(avg(high.high) > avg(high.low) * 5, '5kHz 主要在高頻');
ok(analyzeMusic([], [], pps).sections.length === 0, '空節拍回傳空結果');

console.log(fails ? `\n${fails} 個測試失敗` : '\n全部通過');
if (fails) process.exit(1);
