import { strict as assert } from 'node:assert';
import { clickTrack, moveRows, rowKey, useTrackSel, type Row } from '../src/ui/trackSel';

// 畫面順序：V2 / F1 / V1 / A1 / A2
const rows: Row[] = [{ kind: 'video', idx: 1 }, { kind: 'fx', idx: 0 }, { kind: 'video', idx: 0 }, { kind: 'audio', idx: 0 }, { kind: 'audio', idx: 1 }];
const keys = (rs: Row[] | null) => rs?.map(rowKey);

clickTrack(rows, rows[1], 'single');
assert.deepEqual(useTrackSel.getState().keys, ['fx:0']);
clickTrack(rows, rows[3], 'toggle');
assert.deepEqual(useTrackSel.getState().keys, ['fx:0', 'audio:0'], 'Ctrl = 加選');
clickTrack(rows, rows[3], 'toggle');
assert.deepEqual(useTrackSel.getState().keys, ['fx:0'], 'Ctrl 再點 = 取消');
clickTrack(rows, rows[0], 'single');
clickTrack(rows, rows[3], 'range');
assert.deepEqual(useTrackSel.getState().keys, ['video:1', 'fx:0', 'video:0', 'audio:0'], 'Shift = 範圍');

// 不相連的兩條（F1、A1）一起拖到 A2 下方：保持原本的上下順序
assert.deepEqual(keys(moveRows(rows, ['audio:0', 'fx:0'], rows[4], 'bottom')), ['video:1', 'video:0', 'audio:1', 'fx:0', 'audio:0']);
// 拖到最上方
assert.deepEqual(keys(moveRows(rows, ['video:0', 'audio:1'], rows[0], 'top')), ['video:0', 'audio:1', 'video:1', 'fx:0', 'audio:0']);
// 目標在選取裡 / 沒變 → null
assert.equal(moveRows(rows, ['fx:0', 'video:0'], rows[2], 'top'), null);
assert.equal(moveRows(rows, ['fx:0'], rows[2], 'top'), null);

// 整組移到最上 / 最下
import { moveRowsToEnd } from '../src/ui/trackSel';
assert.deepEqual(keys(moveRowsToEnd(rows, ['audio:1', 'fx:0'], 'top')), ['fx:0', 'audio:1', 'video:1', 'video:0', 'audio:0']);
assert.equal(moveRowsToEnd(rows, ['video:1', 'fx:0'], 'top'), null);

console.log('PASS 軌道多選移動');
