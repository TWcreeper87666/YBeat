// store 用了 localStorage（persist）：測試裡給一個空的
(globalThis as any).localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
(globalThis as any).window = globalThis;
console.warn = () => {};
import { strict as assert } from 'node:assert';
import { useStore } from '../src/store';
import { beginHistoryScope, beginHistoryTransaction, endHistoryScope, endHistoryTransaction, historyPath, mergeIntoStep, redo, resetHistory, settleHistory, stepsFrom, undo, useHistory } from '../src/engine/history';

const S = () => useStore.getState();
/** 做一步（立刻結算，不等 400ms 合併） */
const step = (f: () => void) => {
  f();
  settleHistory();
};
const audioTracks = () => S().tracks.audio.length;

resetHistory();
const saved = historyPath();
const n0 = audioTracks();

// ── 步數：復原往回算、重做再加回來 ──
step(() => S().addTrack('audio'));
step(() => S().addTrack('audio'));
assert.equal(stepsFrom(saved), 2, '做兩步 = 2');
undo();
assert.equal(stepsFrom(saved), 1, '復原 = 少一步');
redo();
assert.equal(stepsFrom(saved), 2, '重做 = 加回來');
undo();
undo();
assert.equal(stepsFrom(saved), 0, '復原回存檔的狀態 = 0');
assert.equal(audioTracks(), n0);

// 存檔後復原再做新的：退回的步數 + 新的一步
step(() => S().addTrack('audio'));
step(() => S().addTrack('audio'));
const saved2 = historyPath();
undo();
undo();
step(() => S().addTrack('audio'));
assert.equal(stepsFrom(saved2), 3, '分岔：退 2 步 + 新的 1 步');
resetHistory();

// ── 合併中的一步：結算前不算 ──
const p0 = historyPath();
S().addTrack('audio');
assert.equal(stepsFrom(p0), 0, '還在合併中（拖曳 / 400ms 內）不算');
settleHistory();
assert.equal(stepsFrom(p0), 1, '結算後算一步');
undo();

// ── 交易（拖曳 / 放置選單）：取消不算、確定算一步、進行中不能復原 ──
const p1 = historyPath();
const n1 = audioTracks();
beginHistoryTransaction();
S().addTrack('audio');
S().addTrack('audio');
assert.equal(useHistory.getState().canUndo, false, '交易中不能復原');
undo();
assert.equal(audioTracks(), n1 + 2, '交易中按復原沒有作用');
endHistoryTransaction(false);
assert.equal(audioTracks(), n1, '取消 = 還原');
assert.equal(stepsFrom(p1), 0, '取消不算一步');
beginHistoryTransaction();
S().addTrack('audio');
S().addTrack('audio');
endHistoryTransaction(true);
assert.equal(stepsFrom(p1), 1, '整個交易算一步');
undo();
assert.equal(audioTracks(), n1, '一次復原整個交易');

// ── 復原後清掉不存在的多選項目、軌道 ──
resetHistory();
step(() => S().addTrack('audio'));
const idx = audioTracks() - 1;
useStore.setState({ activeTrack: { kind: 'audio', idx }, selected: ['clip:gone'] });
undo();
assert.equal(S().activeTrack, null, '復原掉的軌道不再是選中的軌道');
assert.deepEqual(S().selected, [], '多選裡不存在的項目清掉');

// ── 最後一步併進前一步（AI 套用 + 產生 = 一次復原） ──
resetHistory();
const n2 = audioTracks();
step(() => S().addTrack('audio'));
const applyStep = historyPath().at(-1)!;
step(() => S().addTrack('audio'));
assert.equal(mergeIntoStep(applyStep), true, '前一步是 applyStep 才併');
assert.equal(historyPath().at(-1), applyStep, '併完留下 applyStep');
undo();
assert.equal(audioTracks(), n2, '一次復原兩步的變更');
assert.equal(historyPath().includes(applyStep), false);
redo();
assert.equal(audioTracks(), n2 + 2, '重做也是一起');
step(() => S().addTrack('audio'));
assert.equal(mergeIntoStep(12345), false, '前一步不是指定的就不併');

// ── 獨立的復原紀錄（編輯視窗）：裡面復原退不到開始之前；完成 = 一步、取消 = 不留紀錄 ──
resetHistory();
const n3 = audioTracks();
step(() => S().addTrack('audio')); // 主紀錄的一步
beginHistoryScope();
assert.equal(useHistory.getState().canUndo, false, '剛開始：沒有可以復原的');
step(() => S().addTrack('audio'));
step(() => S().addTrack('audio'));
undo();
assert.equal(audioTracks(), n3 + 2, '裡面一次退一步');
undo();
undo();
assert.equal(audioTracks(), n3 + 1, '退不到開始之前');
redo();
redo();
endHistoryScope(true);
assert.equal(audioTracks(), n3 + 3);
undo();
assert.equal(audioTracks(), n3 + 1, '完成後：整段一次復原');
undo();
assert.equal(audioTracks(), n3, '再之前是主紀錄原本的一步');
redo();
redo();
assert.equal(audioTracks(), n3 + 3, '重做整段');
const p3 = historyPath();
beginHistoryScope();
step(() => S().addTrack('audio'));
endHistoryScope(false);
assert.equal(audioTracks(), n3 + 3, '取消：還原成開始時');
assert.deepEqual(historyPath(), p3, '取消：主紀錄不多一步');
assert.equal(useHistory.getState().canRedo, false);
undo();
assert.equal(audioTracks(), n3 + 1, '取消後復原 = 編輯視窗之前的那一步');

console.log('PASS 復原紀錄');
