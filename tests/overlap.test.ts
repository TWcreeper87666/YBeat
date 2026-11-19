import { fitStart, groupFits, nextStart, prevEnd, resolveShift, type Span } from '../src/engine/overlap';

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

console.log(fails ? `\n${fails} 項失敗` : '\n全部通過');
if (fails) process.exit(1);
