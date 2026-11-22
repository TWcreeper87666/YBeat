import { strict as assert } from 'node:assert';
import { describe, it } from './logicHarness';
import { anchorShift } from '../src/engine/textAnchor';
import { DEFAULT_TEXT } from '../src/engine/text';
import type { Clip } from '../src/store';

describe('textAnchor 純邏輯邊界', () => {
  const clip = { id: 'caption', start: 0, duration: 2 } as Clip;
  const previous = { ...DEFAULT_TEXT, align: 'left' as const };

  it('置中對齊不位移錨點', () => {
    assert.equal(anchorShift(clip, previous, { ...previous, align: 'center' }), null);
  });

  it('對齊方式變更時不位移錨點', () => {
    assert.equal(anchorShift(clip, previous, { ...previous, align: 'right' }), null);
  });
});

