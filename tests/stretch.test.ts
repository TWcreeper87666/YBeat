import { timeStretch } from '../src/engine/stretch';

let fails = 0;
const ok = (cond: boolean, msg: string) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) fails++;
};

const SR = 48000;
const sine = (hz: number, sec: number) => {
  const a = new Float32Array(Math.round(SR * sec));
  for (let i = 0; i < a.length; i++) a[i] = Math.sin((2 * Math.PI * hz * i) / SR) * 0.5;
  return a;
};
/** 用過零點估頻率（只看中段，避開頭尾） */
const freq = (a: Float32Array) => {
  const s = Math.floor(a.length * 0.2), e = Math.floor(a.length * 0.8);
  let z = 0;
  for (let i = s + 1; i < e; i++) if (a[i - 1] < 0 && a[i] >= 0) z++;
  return (z * SR) / (e - s);
};
const rms = (a: Float32Array) => {
  const s = Math.floor(a.length * 0.2), e = Math.floor(a.length * 0.8);
  let x = 0;
  for (let i = s; i < e; i++) x += a[i] * a[i];
  return Math.sqrt(x / (e - s));
};

for (const rate of [2, 1.5, 0.5]) {
  const input = sine(440, 2);
  const t0 = performance.now();
  const [out] = timeStretch([input, input], rate);
  const ms = performance.now() - t0;
  const f = freq(out);
  ok(Math.abs(out.length - input.length / rate) <= 1, `${rate}×：長度 ${out.length}（預期 ${Math.round(input.length / rate)}）`);
  ok(Math.abs(f - 440) < 8, `${rate}×：音調不變，頻率 ${f.toFixed(1)} Hz（原本 440）`);
  ok(Math.abs(rms(out) - rms(input)) < 0.05, `${rate}×：音量差不多（${rms(out).toFixed(3)} vs ${rms(input).toFixed(3)}）`);
  console.log(`    2 秒立體聲處理時間 ${ms.toFixed(0)} ms`);
}
{
  const input = sine(440, 1);
  const [out] = timeStretch([input], 1);
  ok(out.length === input.length && out.every((v, i) => v === input[i]), '1×：原樣輸出');
}

console.log(fails ? `\n${fails} 項失敗` : '\n全部通過');
process.exit(fails ? 1 : 0);
