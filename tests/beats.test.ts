import { beatIndexAtOrAfter, beatTime, estimateBeats, layoutOnBeats } from '../src/engine/beats';

let fails = 0;
const ok = (cond: boolean, msg: string) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) fails++;
};

/** 假的音量包絡：bpm 的鼓聲（重拍比較大聲），從 offset 秒開始，每拍後面快速衰減 */
function clicks(bpm: number, offset: number, secs: number, pps = 100, jitter = 0) {
  const n = Math.round(secs * pps);
  const p = new Array(n).fill(0.05);
  const period = 60 / bpm;
  let k = 0;
  for (let t = offset; t < secs; t += period, k++) {
    const tt = t + (jitter ? (Math.sin(k * 12.9898) * jitter) : 0);
    const i0 = Math.round(tt * pps);
    const amp = k % 4 === 0 ? 1 : 0.6;
    for (let j = 0; j < 12 && i0 + j < n; j++) p[i0 + j] = Math.max(p[i0 + j], 0.05 + amp * Math.exp(-j / 3));
  }
  return p;
}

for (const bpm of [92, 120, 128, 150, 174]) {
  const info = estimateBeats(clicks(bpm, 0.37, 60), 100)!;
  // 很快的歌估成一半（174 → 87，半拍感）也算對：剪接時一樣對得上
  const hit = !!info && (Math.abs(info.bpm - bpm) < 0.5 || Math.abs(info.bpm * 2 - bpm) < 1);
  ok(hit, `${bpm} BPM → 估出 ${info?.bpm.toFixed(2)}`);
}

const info = estimateBeats(clicks(128, 0.37, 60), 100)!;
const period = 60 / 128;
const last = info.beats[info.beats.length - 1];
ok(Math.abs(info.beats[0].t - 0.37) < 0.02, `第一拍對齊（${info.beats[0].t.toFixed(3)}s）`);
const k = Math.round((last.t - 0.37) / period);
ok(Math.abs(last.t - (0.37 + k * period)) < 0.02, `一分鐘後還對得上（誤差 ${(last.t - (0.37 + k * period)).toFixed(3)}s）`);
ok(info.beats[0].down && !info.beats[1].down && info.beats[4].down, '重拍 = 比較大聲的那一拍，每 4 拍一次');

const jit = estimateBeats(clicks(120, 0.2, 40, 100, 0.012), 100)!;
ok(Math.abs(jit.bpm - 120) < 0.5, `有一點點不穩也估得出來（${jit.bpm.toFixed(2)}）`);

ok(estimateBeats(new Array(3000).fill(0.2), 100) === null, '沒有起音 → null');
ok(estimateBeats(clicks(120, 0, 2), 100) === null, '太短 → null');

// 排版
const grid = [0, 0.5, 1, 1.5, 2, 2.5, 3].map((t) => ({ t }));
ok(beatIndexAtOrAfter(grid, 1.2) === 3 && beatIndexAtOrAfter(grid, 9) === 7, '找下一拍');
ok(Math.abs(beatTime(grid, 9) - 4.5) < 1e-9, '超出格線照拍長往後推');
const lay = layoutOnBeats(grid, 1, 2, [Infinity, 0.7, Infinity]);
const want = [[0.5, 1], [1.5, 0.7], [2.5, 1]];
ok(lay.length === 3 && lay.every(([a, b], i) => Math.abs(a - want[i][0]) < 1e-9 && Math.abs(b - want[i][1]) < 1e-9), `每段 2 拍、素材不夠長就停在結尾、下一段從下一拍開始：${JSON.stringify(lay)}`);

console.log(fails ? `\n${fails} 項失敗` : '\n全部通過');
if (fails) process.exit(1);
