import { fitInGap, fitStart, groupFits, nextStart, prevEnd, resolveShift, overwriteParts, insertParts, type Span } from '../src/engine/overlap';

let fails = 0;
const ok = (cond: boolean, msg: string) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) fails++;
};
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
const V = (start: number, duration: number, track = 0): Span => ({ lane: `video:${track}`, start, duration });

const others = [V(0, 2), V(4, 2), V(10, 1)];

ok(groupFits([V(2, 2)], others, 0), '剛好塞進 2~4 的空隙');
ok(!groupFits([V(1, 2)], others, 0), '壓到 0~2 → 不行');
ok(groupFits([V(1, 2, 1)], others, 0), '不同軌不算重疊');

// 拖到 3 秒（長度 2）會壓到 4~6 → 最近的空位是 2~4
ok(near(fitStart(others, 'video:0', 3, 2), 2), '放到 3 秒 → 退到 2 秒');
// 放到 4.8 → 最近是 6
ok(near(fitStart(others, 'video:0', 4.8, 2), 6), '放到 4.8 秒 → 移到 6 秒');
// forward 只往後找
ok(near(fitStart(others, 'video:0', 0.5, 2, true), 2), 'forward：0.5 → 2');
// 太長的放不進空隙 → 跳到後面
ok(near(fitStart(others, 'video:0', 2, 3), 6), '3 秒長放不進 2 秒空隙 → 6 秒');
// 不會跑到 0 之前
ok(fitStart([V(0.5, 5)], 'video:0', 0.2, 1) >= 0, '不會放到負的時間');

// 整組（兩軌）一起移動
const group = [V(6, 1, 0), V(6, 1, 1)];
const os = [V(0, 2, 0), V(7, 2, 1)];
const dt = resolveShift(group, os, 0.5);
ok(groupFits(group, os, dt), `整組移動找到可放的位移 ${dt}`);

ok(near(nextStart(others, 'video:0', 2), 4), '下一個片段從 4 秒開始');
ok(near(prevEnd(others, 'video:0', 4), 2), '上一個片段在 2 秒結束');
ok(nextStart(others, 'video:0', 11) === Infinity, '後面沒東西 → Infinity');

const parts = (xs: { start: number; duration: number }[]) => xs.map((x) => [x.start, x.duration]);
ok(JSON.stringify(parts(overwriteParts(2, 8, [{ start: 4, duration: 2 }]))) === JSON.stringify([[2, 2], [6, 4]]), '覆蓋中段保留兩側');
ok(overwriteParts(3, 2, [{ start: 2, duration: 5 }]).length === 0, '完全覆蓋移除片段');
ok(JSON.stringify(parts(overwriteParts(2, 8, [{ start: 1, duration: 3 }, { start: 7, duration: 5 }]))) === JSON.stringify([[4, 3]]), '多段覆蓋修剪左右');
ok(JSON.stringify(parts(insertParts(2, 8, 4, 3))) === JSON.stringify([[2, 2], [7, 6]]), '插入點切開跨越片段並推右段');
ok(JSON.stringify(parts(insertParts(5, 2, 4, 3))) === JSON.stringify([[8, 2]]), '插入點後的片段波紋右移');
ok(JSON.stringify(parts(insertParts(0, 2, 4, 3))) === JSON.stringify([[0, 2]]), '插入點前的片段不動');

// 圖片 / 色板放進空隙：縮短到剛好填滿
{
  const others: Span[] = [{ lane: 'clip:0', start: 0, duration: 2 }, { lane: 'clip:0', start: 3, duration: 2 }];
  const g = fitInGap(others, 'clip:0', 2, 2);
  ok(g.start === 2 && Math.abs(g.duration - 1) < 1e-9, '1 秒的空隙放 2 秒的圖片 → 縮成 1 秒');
  const big = fitInGap(others, 'clip:0', 6, 2);
  ok(big.start === 6 && big.duration === 2, '後面沒東西：長度不變');
  const on = fitInGap(others, 'clip:0', 1, 2);
  ok(on.duration === 2 && on.start >= 5 - 1e-9 || on.start + on.duration <= 0 + 1e-9 || on.start === 5, '放在片段上面：照原本的規則找空位、長度不變');
  const tiny = fitInGap([{ lane: 'clip:0', start: 0, duration: 2 }, { lane: 'clip:0', start: 2.05, duration: 2 }], 'clip:0', 2, 2);
  ok(tiny.duration === 2, '空隙太小（< 0.1 秒）：不縮，照原本的規則找空位');
}

console.log(fails ? `\n${fails} 項失敗` : '\n全部通過');
if (fails) process.exit(1);
