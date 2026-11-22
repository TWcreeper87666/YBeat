import { strict as assert } from 'node:assert';
import { frameIndexAt, frameStarts } from '../src/engine/animImage';

const { starts, total } = frameStarts([0.1, 0, 0.2, 0.005]);
assert.deepEqual(starts.map((x) => +x.toFixed(3)), [0, 0.1, 0.2, 0.4, 0.5], '長度 0 / 太短的當 0.1 秒（跟瀏覽器一樣）');
assert.equal(+total.toFixed(3), 0.5);
assert.equal(frameIndexAt(starts, total, 0), 0);
assert.equal(frameIndexAt(starts, total, 0.15), 1);
assert.equal(frameIndexAt(starts, total, 0.39), 2);
assert.equal(frameIndexAt(starts, total, 0.45), 3);
assert.equal(frameIndexAt(starts, total, 0.55), 0, '播完從頭循環');
assert.equal(frameIndexAt(starts, total, 1.25), 2, '循環兩圈後');
assert.equal(frameIndexAt([0, 1], 1, 5), 0, '只有一格');
console.log('PASS 動態圖片：每一格的時間');
