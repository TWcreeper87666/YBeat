import { strict as assert } from 'node:assert';
import { describe, it } from './logicHarness';
import { clipTransformAt, DEFAULT_TRANSFORM, fitSize, isAnimated, normalizeScale, setPropsAt } from '../src/engine/transform';
import type { Keyframe } from '../src/engine/keyframes';

const linear = [0, 0, 1, 1] as [number, number, number, number];
const x: Keyframe[] = [{ id: 'x0', t: 0, v: 0, ease: linear }, { id: 'x1', t: 2, v: 1, ease: linear }];

describe('transform 純邏輯', () => {
  it('舊版 scale 正規化為 X/Y 並複製 key id', () => {
    const legacy = { transform: { ...DEFAULT_TRANSFORM, scale: 2 }, keys: { scale: x } } as never;
    const result = normalizeScale(legacy) as { transform: typeof DEFAULT_TRANSFORM & { scale?: number }; keys: { scaleX: Keyframe[]; scaleY: Keyframe[] } };
    assert.equal(result.transform.scaleX, 1);
    assert.equal(result.transform.scaleY, 1);
    assert.equal(result.transform.scale, undefined);
    assert.equal(result.keys.scaleY[0].id, 'x0y');
    assert.notEqual(result.keys.scaleY[0], result.keys.scaleX[0]);
    const modern = { transform: DEFAULT_TRANSFORM };
    assert.equal(normalizeScale(modern), modern);
  });

  it('只覆蓋有動畫的屬性，並在指定時點更新 key', () => {
    const clip = { transform: { ...DEFAULT_TRANSFORM, x: 9, y: 2 }, keys: { x } };
    assert.equal(clipTransformAt(clip, 1).x, 0.5);
    assert.equal(clipTransformAt(clip, 1).y, 2);
    assert.equal(isAnimated(clip, 'x'), true);
    assert.equal(isAnimated(clip, 'y'), false);
    const patch = setPropsAt(clip, { x: 0.8, y: 4 }, 1);
    assert.equal(patch.transform?.y, 4);
    assert.equal(patch.transform?.x, 9);
    assert.equal(patch.keys?.x?.[1].t, 1);
    assert.equal(patch.keys?.x?.[1].v, 0.8);
    assert.equal(clip.keys.x.length, 2);
    assert.deepEqual(setPropsAt(clip, {}, 1), {});
  });

  it('cover 與 contain 依素材和畫面比例決定長寬', () => {
    assert.deepEqual(fitSize(true, 2, 1), [2, 1]);
    assert.deepEqual(fitSize(false, 2, 1), [1, 0.5]);
    assert.deepEqual(fitSize(true, 1, 2), [2, 2]);
    assert.deepEqual(fitSize(false, 1, 2), [1, 1]);
  });
});

