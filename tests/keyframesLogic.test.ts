import { strict as assert } from 'node:assert';
import { describe, it } from './logicHarness';
import { bezierY, easeId, evalKeys, keyAt, newKey, scaleKeyList, scaleKeyMap, sortKeys, splitKeys, upsertKey, type Keyframe } from '../src/engine/keyframes';

const linear = [0, 0, 1, 1] as [number, number, number, number];
const key = (id: string, t: number, v: number, ease: Keyframe['ease'] = linear): Keyframe => ({ id, t, v, ease });

describe('keyframes 純邏輯', () => {
  it('辨識 easing、計算 Bezier 邊界與中點', () => {
    assert.equal(easeId(linear), 'linear');
    assert.equal(easeId('hold'), 'hold');
    assert.equal(easeId([0.1, 0, 0.9, 1]), 'custom');
    assert.equal(bezierY(linear, -1), 0);
    assert.equal(bezierY(linear, 2), 1);
    assert.ok(Math.abs(bezierY(linear, 0.5) - 0.5) < 1e-5);
    assert.equal(bezierY([-1, 0.7, 0, 0], 0.5), 0.7);
  });

  it('在區間內插值、區間外固定，以及 hold', () => {
    const keys = [key('a', 1, 10), key('b', 3, 30)];
    assert.equal(evalKeys(keys, 0), 10);
    assert.equal(evalKeys(keys, 4), 30);
    assert.ok(Math.abs(evalKeys(keys, 2) - 20) < 1e-4);
    assert.equal(evalKeys([key('a', 1, 10, 'hold'), keys[1]], 2), 10);
  });

  it('排序不改原陣列；近時點更新沿用 id 與 ease', () => {
    const original = [key('late', 2, 20, 'hold'), key('early', 0, 0)];
    assert.deepEqual(sortKeys(original).map((k) => k.id), ['early', 'late']);
    assert.equal(original[0].id, 'late');
    const sorted = sortKeys(original);
    const updated = upsertKey(sorted, 2 + 0.001, 25);
    assert.equal(updated.length, 2);
    assert.deepEqual(updated[1], { ...sorted[1], v: 25 });
    assert.equal(keyAt(updated, 2)?.v, 25);
    assert.equal(keyAt(updated, 3), undefined);
    const inserted = upsertKey(sorted, 1, 12);
    assert.deepEqual(inserted.map((k) => k.t), [0, 1, 2]);
    assert.deepEqual(inserted[1].ease, linear);
  });

  it('分割時補邊界值、位移右段時間；縮放保留原資料', () => {
    const input = { x: [key('a', 0, 0), key('b', 4, 40)], opacity: [key('o', 0, 1, 'hold'), key('p', 4, 0)] };
    const [left, right] = splitKeys(input, 2);
    assert.deepEqual(left.x?.map((k) => [k.t, k.v]), [[0, 0], [2, 20]]);
    assert.deepEqual(right.x?.map((k) => [k.t, k.v]), [[0, 20], [2, 40]]);
    assert.equal(right.opacity?.[0].v, 1);
    assert.deepEqual(scaleKeyList(input.x, 2).map((k) => k.t), [0, 8]);
    assert.deepEqual(scaleKeyMap(input, 0.5).x?.map((k) => k.t), [0, 2]);
    assert.deepEqual(scaleKeyMap(undefined, 2), {});
    assert.equal(input.x[1].t, 4);
    assert.equal(newKey(3, 7, 'hold').ease, 'hold');
  });
});

