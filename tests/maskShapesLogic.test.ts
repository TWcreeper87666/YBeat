import { strict as assert } from 'node:assert';
import { describe, it } from './logicHarness';
import { builtinShapes, fieldFromCoverage, maskFieldKey, shapeInfo, shapeName } from '../src/engine/maskShapes';

describe('maskShapes 純邏輯', () => {
  it('內建形狀 ID 唯一，分類與路徑可查', () => {
    const shapes = builtinShapes();
    assert.equal(new Set(shapes.map((shape) => shape.id)).size, shapes.length);
    assert.ok(shapes.every((shape) => shape.path && shape.aspect > 0));
    assert.equal(shapeInfo('rect')?.cat, 'basic');
    assert.equal(shapeInfo('star')?.cat, 'symbol');
    assert.equal(shapeInfo('missing'), undefined);
    assert.equal(shapeName('rect'), shapeInfo('rect')?.name);
  });

  it('自訂路徑 key 與一般形狀 key', () => {
    assert.equal(maskFieldKey({ shape: 'path', path: 'M0 0Z' }), 'path:M0 0Z');
    assert.equal(maskFieldKey({ shape: 'path' }), 'rect');
    assert.equal(maskFieldKey({ shape: 'ellipse' }), 'ellipse');
  });

  it('coverage 轉成距離場：內部小於邊界，外部大於邊界', () => {
    const field = fieldFromCoverage([
      0, 0, 0, 0, 0,
      0, 0, 0, 0, 0,
      0, 0, 1, 0, 0,
      0, 0, 0, 0, 0,
      0, 0, 0, 0, 0,
    ], 5);
    assert.equal(field.size, 5);
    assert.equal(field.data.length, 25);
    assert.ok(field.data[12] < 128);
    assert.ok(field.data[11] > 128);
    assert.ok(field.data[0] > field.data[11]);
  });
});

