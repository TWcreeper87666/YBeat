import { axisAligned, snapScaleAxis } from '../src/engine/snap';

let fails = 0;
const ok = (cond: boolean, msg: string) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) fails++;
};

// 畫面寬 400，框中心 200、半寬 100（邊在 100 / 300）
const lines = [0, 200, 400];
{
  const r = snapScaleAxis(200, 100, 1.97, lines, 8); // 邊在 3 / 397，離 0 / 400 只有 3px
  ok(r.line === 0 || r.line === 400, '靠近畫面邊 → 吸過去');
  ok(Math.abs(r.f - 2) < 1e-9, `倍率變成剛好 2（${r.f}）`);
}
{
  const r = snapScaleAxis(200, 100, 1.5, lines, 8); // 邊在 50 / 350，離最近的線 50px
  ok(r.line === null && r.f === 1.5, '離線太遠 → 不吸、倍率不變');
}
{
  // 中心不在中間：中心 150、半寬 50，邊在 100 / 200 → 縮放 1.04 時右邊 202，離中線 200 只有 2px
  const r = snapScaleAxis(150, 50, 1.04, lines, 8);
  ok(r.line === 200 && Math.abs(r.f - 1) < 1e-9, `吸到中線，倍率回到 1（${r.f}）`);
}
{
  const r = snapScaleAxis(200, 100, 1.0, [200], 8);
  ok(r.line === null, '線剛好在中心上 → 不會吸（怎麼縮放都碰不到）');
}
ok(axisAligned(0)?.swapped === false, '0° 對齊、寬高不對調');
ok(axisAligned(90.2)?.swapped === true, '90° 附近對齊、寬高對調');
ok(axisAligned(-180)?.swapped === false, '-180° 對齊');
ok(axisAligned(30) === null, '30° 不對齊 → 不吸附');

console.log(fails ? `\n${fails} 項失敗` : '\n全部通過');
process.exit(fails ? 1 : 0);
