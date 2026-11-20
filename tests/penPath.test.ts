import { fitPen, insertPoint, movePts, nearestOnPath, penBounds, penToPath, penToShape, ptsInRect, segPoint, type PenPt } from '../src/engine/penPath';

let fails = 0;
const ok = (cond: boolean, msg: string) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) fails++;
};
const near = (a: number, b: number, e = 1e-6) => Math.abs(a - b) < e;

const tri: PenPt[] = [{ x: 100, y: 100 }, { x: 300, y: 100 }, { x: 200, y: 400 }];
ok(penToPath(tri) === 'M100 100L300 100L200 400Z', '直角點 → 直線路徑');
ok(penToPath(tri, false) === 'M100 100L300 100L200 400', '沒封閉就不加 Z');

const s = penToShape(tri)!;
ok(s.path === 'M0 0L200 0L100 200Z', '正規化到 200×200');
ok(near(s.aspect, 200 / 300), '比例 = 寬 / 高');
ok(penToShape(tri.slice(0, 2)) === null, '少於 3 點 → 不能存');

// 平滑點：只有 o，i 自動是反方向
const curvy: PenPt[] = [{ x: 0, y: 0, o: [50, 0] }, { x: 100, y: 0 }, { x: 50, y: 100 }];
ok(penToPath(curvy).includes('C50 0'), '有把手 → 貝茲曲線');
const b = penBounds([{ x: 0, y: 0, o: [0, -100] }, { x: 100, y: 0, i: [0, -100] }, { x: 50, y: 50 }]);
ok(b.y0 < -70 && b.y0 > -80, '範圍算的是曲線本身（約 -75），不是把手（-100）');

// 插入錨點：形狀不變
const before: [number, number][] = [];
for (let i = 0; i <= 10; i++) before.push(segPoint(curvy, 0, i / 10));
const ins = insertPoint(curvy, 0, 0.5);
ok(ins.length === 4, '插入後多一個點');
const mid = segPoint(curvy, 0, 0.5);
ok(near(ins[1].x, mid[0]) && near(ins[1].y, mid[1]), '新點在曲線上');
ok(near(segPoint(ins, 0, 0.5)[0], segPoint(curvy, 0, 0.25)[0], 1e-6), '前半段形狀不變');
ok(near(segPoint(ins, 1, 0.5)[0], segPoint(curvy, 0, 0.75)[0], 1e-6), '後半段形狀不變');
ok(near(segPoint(ins, 2, 0.3)[0], segPoint(curvy, 1, 0.3)[0]), '其他線段不受影響');
const sq = insertPoint(tri, 0, 0.5);
ok(sq[1].x === 200 && sq[1].y === 100 && !sq[1].o, '直線段插入 = 直角點');

const n = nearestOnPath(tri, 200, 90);
ok(n.k === 0 && near(n.t, 0.5) && near(n.d, 10), '找最近的線段');

// 多選 / 框選 / 同步移動
const mv = movePts(curvy, [0, 2], 10, -5);
ok(mv[0].x === 10 && mv[0].y === -5 && mv[2].x === 60 && mv[1].x === 100, '只移動選取的點');
ok(mv[0].o![0] === 50 && mv[0].o![1] === 0, '把手是相對位移，跟著點一起走');
ok(ptsInRect(tri, 350, 50, 150, 150).join() === '1', '框選（反方向拖也可以）');
ok(ptsInRect(tri, 0, 0, 1000, 1000).length === 3, '框住全部');

// 放回遮罩框（含旋轉）
const fit = fitPen(tri, { x0: 0, y0: 0, x1: 100, y1: 100 });
const fb = penBounds(fit);
ok(near(fb.x0, 0) && near(fb.y0, 0) && near(fb.x1, 100) && near(fb.y1, 100), '拉滿到框裡');
const rot = fitPen([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }], { x0: 0, y0: 0, x1: 20, y1: 10 }, 90);
const rb = penBounds(rot);
ok(near(rb.x1 - rb.x0, 10) && near(rb.y1 - rb.y0, 20) && near((rb.x0 + rb.x1) / 2, 10) && near((rb.y0 + rb.y1) / 2, 5), '旋轉 90° 繞框中心');
const rh = fitPen([{ x: 0, y: 0, o: [10, 0] }, { x: 10, y: 0 }, { x: 10, y: 10 }], { x0: 0, y0: 0, x1: 10, y1: 10 }, 90);
ok(near(rh[0].o![0], 0, 1e-9) && rh[0].o![1] > 0, '把手也跟著旋轉（往右 → 往下）');

console.log(fails ? `\n${fails} 項失敗` : '\n全部通過');
if (fails) process.exit(1);
