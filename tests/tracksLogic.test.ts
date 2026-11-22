import { strict as assert } from 'node:assert';
import { describe, it } from './logicHarness';
import { displayRows, fxLevel, visualRows, type Tracks } from '../src/engine/tracks';

describe('tracks 補充邊界測試', () => {
  const tracks: Tracks = { video: [{}, {}], fx: [{ level: -1 }, { level: 1 }, { level: 99 }], audio: [{ row: -2 }, { row: 99 }] };

  it('特效層級限制在影片軌範圍內', () => {
    assert.deepEqual([fxLevel(tracks, 0), fxLevel(tracks, 1), fxLevel(tracks, 2), fxLevel(tracks, 10)], [0, 1, 2, 2]);
  });

  it('視覺順序與上下方向、音軌 row 邊界', () => {
    assert.deepEqual(visualRows(tracks).map((r) => `${r.kind}:${r.idx}`), ['fx:2', 'video:1', 'fx:1', 'video:0', 'fx:0']);
    assert.deepEqual(displayRows(tracks, 'top').map((r) => `${r.kind}:${r.idx}`), ['audio:0', 'fx:2', 'video:1', 'fx:1', 'video:0', 'fx:0', 'audio:1']);
    assert.deepEqual(displayRows(tracks, 'bottom').map((r) => `${r.kind}:${r.idx}`), ['audio:0', 'fx:0', 'video:0', 'fx:1', 'video:1', 'fx:2', 'audio:1']);
  });
});

