import { strict as assert } from 'node:assert';
import { describe, it } from './logicHarness';
import { groupFits, resolveShift, selectedItemsAtEdge, spansOverlap, type Span } from '../src/engine/overlap';

const span = (lane: string, start: number, duration: number): Span => ({ lane, start, duration });

describe('overlap 補充邊界測試', () => {
  it('相接邊界不算重疊，跨軌道也不算', () => {
    assert.equal(spansOverlap(span('v:0', 0, 2), span('v:0', 2, 2)), false);
    assert.equal(spansOverlap(span('v:0', 0, 2), span('v:1', 1, 2)), false);
    assert.equal(spansOverlap(span('v:0', 0, 2), span('v:0', 1, 2)), true);
  });

  it('移動不可越過零點；forward 只選前方空位', () => {
    assert.equal(groupFits([span('v:0', 0, 1)], [], -0.5), false);
    const moving = [span('v:0', 2, 2)];
    const others = [span('v:0', 4, 2)];
    assert.equal(resolveShift(moving, others, 1, true), 4);
    assert.equal(resolveShift([], others, 1), 1);
  });

  it('找不到主要項目時不回傳任何選取項', () => {
    assert.deepEqual(selectedItemsAtEdge([{ id: 'a', start: 0, duration: 1 }], ['a'], 'missing', 'start'), []);
  });
});

