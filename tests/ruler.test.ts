import { FPS, PPS_MAX, PPS_MIN, frameTicks, rulerLabel, rulerSteps, snapFrame, tc } from '../src/engine/rulerTicks';

let fails = 0;
const ok = (cond: boolean, msg: string) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) fails++;
};

const max = rulerSteps(PPS_MAX);
ok(Math.abs(max.minor - 1 / FPS) < 1e-12, '放到最大：最小刻度 = 1/60 秒');
ok(max.major * PPS_MAX >= 64, '有數字的刻度不會擠在一起');
for (const pps of [PPS_MIN, 12, 40, 100, 300, 600, PPS_MAX]) {
  const { major, minor } = rulerSteps(pps);
  ok(Math.abs(major / minor - Math.round(major / minor)) < 1e-6 && minor * pps >= 6 - 1e-9, `${pps} px/s：大刻度是小刻度的整數倍、小刻度至少 6px`);
  ok(minor >= 1 / FPS - 1e-12, `${pps} px/s：不會比 1/60 秒還細`);
}
ok(rulerLabel(65, 5) === '01:05', '整秒：mm:ss');
ok(rulerLabel(1 + 5 / 60, 5 / 60) === '00:01:05', '放大時：mm:ss:ff（第幾格）');
ok(snapFrame(1.005) === 1 && Math.abs(snapFrame(1.012) - 61 / 60) < 1e-12, '播放頭對齊到最近的一格');

ok(tc(0) === '00:00:00' && tc(3.25) === '00:03:15' && tc(59.999) === '01:00:00', '時間碼 mm:ss:ff（四捨五入到最近的一格）');
ok(tc(3725.5) === '1:02:05:30', '超過一小時：h:mm:ss:ff');
ok(tc(-1) === '00:00:00', '負的當 0');
{
  const { ticks, step } = frameTicks(0, 2, 4);
  ok(ticks.length <= 5 && ticks.every((t) => Math.abs(t * FPS - Math.round(t * FPS)) < 1e-9), '屬性面板的尺規：刻度都落在整數格上、數量不超過上限');
  ok(step >= 0.5, '2 秒最多 4 個刻度 → 間隔至少 0.5 秒');
}

console.log(fails ? `\n${fails} 個失敗` : '\n全部通過');
if (fails) process.exit(1);
