import { hasKeyIn, insertKey, lastAtOrBefore, pickFrame, snapFps, toKey } from '../src/engine/matteIndex';

let fails = 0;
const ok = (cond: boolean, msg: string) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) fails++;
};

const keys: number[] = [];
for (const t of [0.1, 0.0, 0.05]) insertKey(keys, toKey(t));
ok(keys.join() === '0,500,1000', '插入後保持排序');
ok(!insertKey(keys, 500) && keys.length === 3, '重複的不再加');
ok(lastAtOrBefore(keys, 999) === 1 && lastAtOrBefore(keys, -1) === -1, '≤ x 的最後一個');
ok(hasKeyIn(keys, 400, 600) && !hasKeyIn(keys, 501, 999), '區間內有沒有 key');

// 30fps、第一格在 0.02 秒（影片開頭有位移）
const fd = 1 / 30;
const pts = Array.from({ length: 30 }, (_, k) => 0.02 + k * fd);
const K = pts.map(toKey);
const at = (t: number) => pickFrame(K, t, fd, 1);
ok(at(pts[10]) === K[10], '播放中：rVFC 給的時間戳記 → 剛好那一格');
ok(at(pts[10] + fd * 0.9) === K[10], '暫停在一格中間 → 還是那一格（≤ t 的最後一格）');
ok(at(pts[11] - 0.0005) === K[11], '時間戳記差 0.5ms 內算同一格');
ok(at(0) === K[0], '片段從 0 開始、第一格在 0.02 → 用第一格');
ok(at(pts[29] + 5) === null, '離最後一格太遠（還沒算）→ 沒有');

// 還在算：缺了中間幾格
const partial = K.filter((_, i) => i < 5 || i > 20);
ok(pickFrame(partial, pts[6], fd, 1) === K[4], '缺一兩格：先用前一格');
ok(pickFrame(partial, pts[15], fd, 1) === null, '缺很多格：當作還沒好');

// 變動影格率：格子間距不固定
const vfr = [0, 0.03, 0.07, 0.1, 0.15].map(toKey);
ok(pickFrame(vfr, 0.08, fd, 1) === toKey(0.07), '變動影格率也照時間戳記找');

// 60fps 隔格算：用前後最近的
const fd60 = 1 / 60;
const even = Array.from({ length: 30 }, (_, k) => toKey(k * 2 * fd60));
ok(pickFrame(even, 3 * fd60 + 0.001, fd60, 2) === toKey(4 * fd60) || pickFrame(even, 3 * fd60 + 0.001, fd60, 2) === toKey(2 * fd60), '隔格算：用最近的一格');
ok(pickFrame(even, 2 * fd60 + 0.0002, fd60, 2) === toKey(2 * fd60), '隔格算：剛好算過的格子就用它');

// ── 影格率：要取最接近的，不能把 30 當成 29.97 ──
ok(snapFps(1 / (1 / 30)) === 30, '30fps → 30（不是 29.97）');
ok(snapFps(1 / 0.0416667) === 24, '24fps → 24（不是 23.976）');
ok(Math.abs(snapFps(1 / (1001 / 30000)) - 30000 / 1001) < 1e-9, '29.97 → 29.97');
ok(Math.abs(snapFps(1 / (1001 / 24000)) - 24000 / 1001) < 1e-9, '23.976 → 23.976');
ok(snapFps(1 / (1 / 60)) === 60, '60fps → 60');
ok(Math.abs(snapFps(27.3) - 27.3) < 1e-9, '不常見的影格率直接用量到的');
// 長片：10 分鐘 30fps，每一格的 seek 目標都要落在那一格的中間附近（不能累積誤差跑到隔壁格）
{
  const fps = snapFps(1 / (1 / 30));
  let worst = 0;
  for (let k = 0; k < 18000; k++) {
    const target = (k + 0.5) / fps; // 跟 runJob 一樣對準格子中間
    worst = Math.max(worst, Math.abs(target - k / 30 - 0.5 / 30) * 30);
  }
  ok(worst < 0.01, `10 分鐘的影片 seek 目標誤差 < 0.01 格（${worst.toFixed(5)}）`);
  // 舊的錯誤：當成 29.97 的話，後段會偏到隔壁格
  const wrong = 30000 / 1001;
  ok(Math.abs((17999 + 0.5) / wrong - (17999 + 0.5) / 30) * 30 > 1, '（對照）用 29.97 算 30fps 的影片，10 分鐘時會偏超過一格');
}

console.log(fails ? `\n${fails} 項失敗` : '\n全部通過');
if (fails) process.exit(1);
