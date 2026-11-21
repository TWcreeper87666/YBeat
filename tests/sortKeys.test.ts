import { strict as assert } from 'node:assert';
import { moveKey, reorderSubset } from '../src/ui/sortKeys';

const k = ['a', 'b', 'c', 'd'];
assert.deepEqual(moveKey(k, 'a', 3), ['b', 'c', 'a', 'd'], '往後移：插在 d 前面');
assert.deepEqual(moveKey(k, 'a', 4), ['b', 'c', 'd', 'a'], '移到最後');
assert.deepEqual(moveKey(k, 'd', 0), ['d', 'a', 'b', 'c'], '移到最前面');
assert.deepEqual(moveKey(k, 'c', 1), ['a', 'c', 'b', 'd'], '往前移');
assert.equal(moveKey(k, 'b', 1), k, '插在自己前面 = 沒變');
assert.equal(moveKey(k, 'b', 2), k, '插在自己後面 = 沒變');
assert.equal(moveKey(k, 'x', 0), k, '不在清單裡 = 沒變');
console.log('PASS 拖曳排序：移動位置');

// 我的最愛混著不同分頁的項目（例如轉場 / 特效）：只調整其中一部分的順序，其他不動
assert.deepEqual(reorderSubset(['t1', 'e1', 't2', 'e2', 't3'], ['t3', 't1', 't2']), ['t3', 'e1', 't1', 'e2', 't2']);
console.log('PASS 拖曳排序：只調整部分項目');
