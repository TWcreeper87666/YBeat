import { analyzeSamples, bestIn, frameStats, grayOf, scoreWindow, type FrameSample, type MediaInfo } from '../src/engine/mediaAnalysis';

let fails = 0;
const ok = (condition: boolean, name: string) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}`);
  if (!condition) fails++;
};
const solid = grayOf(new Uint8Array(Array.from({ length: 16 }, () => [255, 0, 0, 255]).flat()), 4, 4);
ok(solid.length === 16 && solid.every((v) => Math.abs(v - 0.2126) < 1e-5), 'solid RGBA to gray');
const flat = new Float32Array(64).fill(0.5);
const checker = new Float32Array(Array.from({ length: 64 }, (_, i) => ((Math.floor(i / 8) + i % 8) % 2)));
ok(frameStats(flat, 8, 8).sharp < 1e-8 && frameStats(checker, 8, 8).sharp > 1, 'Laplacian sharpness');
ok(frameStats(checker, 8, 8, checker).diff === 0, 'identical frame difference');

const samples: FrameSample[] = Array.from({ length: 11 }, (_, t) => ({ t, luma: t === 2 ? 0.02 : 0.5, sharp: 1, diff: t === 5 ? 0.4 : t >= 7 ? 0.08 : 0.005 }));
const analyzed = analyzeSamples(samples, 11);
ok(analyzed.step === 1 && analyzed.cuts.length === 1 && analyzed.cuts[0] === 5, 'detect cut spike');
ok(analyzed.quality[2] < analyzed.quality[3] * 0.5, 'penalize dark frames');
ok(analyzed.motion[8] > 0.9 && analyzed.motion[5] < 0.9, 'motion scale excludes cut');
ok(scoreWindow(analyzed, 4.5, 5.5, 1) === -Infinity, 'window rejects cut');

const halves: MediaInfo = { step: 1, duration: 20, motion: Array.from({ length: 20 }, (_, i) => i < 10 ? 0 : 1), quality: Array(20).fill(1), cuts: [] };
const zero = () => 0;
ok(bestIn(halves, 3, 1, [], zero) >= 9.5, 'high motion selects moving half');
ok(bestIn(halves, 3, 0, [], zero) < 10, 'low motion selects still half');
const first = bestIn(halves, 3, 0, [], zero);
ok(bestIn(halves, 3, 0, [{ t0: first, t1: first + 3 }], zero) >= first + 3, 'avoid used interval');
ok(bestIn(halves, 3, 0, [], zero, [8]) <= 8 && bestIn(halves, 3, 0, [], zero, [8]) + 3 > 8, 'highlight attracts window');
ok(bestIn(halves, 20, 0, [], zero) === 0 && bestIn(halves, 25, 0, [], zero) === 0, 'long duration starts at zero');
const cutInfo = { ...halves, cuts: [10] };
const picked = bestIn(cutInfo, 3, 1, [], zero);
ok(!(picked < 10.1 && picked + 3 > 9.9), 'best window avoids cut');
const allCuts = { ...halves, cuts: Array.from({ length: 20 }, (_, i) => i + 0.5) };
ok(Number.isFinite(bestIn(allCuts, 3, 0, [], zero)), 'all cuts fallback');

console.log(fails ? `\n${fails} media analysis failures` : '\nMedia analysis passed');
if (fails) process.exit(1);
