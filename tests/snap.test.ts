import { axisAligned, rotatedHalf, snapSpan, snapMoveAxis, snapScaleAxis, snapTargetIfApplied } from '../src/engine/snap';

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
ok(snapTargetIfApplied({ v: 10, d: 2 }, 9) === null, '受素材長度限制時不顯示未套用的吸附線');
ok(snapTargetIfApplied({ v: 10, d: 2 }, 10) === 10, '實際吸附到素材尾端時顯示吸附線');

// 移動吸附：中心、兩邊都能吸到每一條線
{
  const grid = [0, 100, 200, 300, 400];
  const r = snapMoveAxis(105, 30, grid, 8);
  ok(r.line === 100 && r.center === 100, `中心吸到網格線（${r.center}）`);
  const e = snapMoveAxis(232, 30, grid, 8); // 左邊 202 → 吸到 200
  ok(e.line === 200 && e.center === 230, `左邊吸到網格線（${e.center}）`);
  const f = snapMoveAxis(266, 30, grid, 8); // 右邊 296 → 吸到 300
  ok(f.line === 300 && f.center === 270, `右邊吸到網格線（${f.center}）`);
  const n = snapMoveAxis(150, 20, grid, 8);
  ok(n.line === null && n.center === 150, '離線太遠 → 不吸');
}
{
  const h = rotatedHalf(100, 40, 90);
  ok(Math.abs(h.hx - 20) < 1e-9 && Math.abs(h.hy - 50) < 1e-9, '旋轉 90° 半寬半高對調');
}
{
  ok(snapSpan(4.9, 3, [5, 20], 0.2).start === 5, '開頭吸到點');
  const e = snapSpan(1.9, 3, [5, 20], 0.2);
  ok(e.start === 2 && e.line === 5, '結尾吸到點（開頭跟著移）');
  ok(snapSpan(4.85, 3, [5, 7.9], 0.2).start === 4.9, '開頭、結尾都能吸時取最近的');
  ok(snapSpan(10, 3, [5, 20], 0.2).line === null, '太遠不吸');
  ok(snapSpan(0.1, 3, [2.95], 0.2).line === null, '結尾吸過去會讓開頭變負的 → 不吸');
}

console.log(fails ? `\n${fails} 項失敗` : '\n全部通過');
process.exit(fails ? 1 : 0);
