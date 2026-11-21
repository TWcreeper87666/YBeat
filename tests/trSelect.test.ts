import { strict as assert } from 'node:assert';
(globalThis as { requestAnimationFrame?: (f: () => void) => number }).requestAnimationFrame = () => 0;
import { makeClip, useStore, type Clip } from '../src/store';
import { clickTransition, copyTransition, navTransition, pasteTransition, removeTransitions, selectAllTransitions, trSelRange, useTrSel } from '../src/ui/trSelect';

const tr = (moduleId: string, duration = 0.4) => ({ moduleId, params: {}, duration });
// 同一條軌道三個相接的片段：b、c 開頭各有剪接點轉場
const clip = (id: string, start: number, p: Partial<Clip> = {}) => makeClip({ id, mediaId: 'm', track: 0, start, duration: 2, ...p });
const reset = () => {
  useStore.setState({
    media: [], audios: [], effects: [], selection: null, selected: [], time: 0,
    tracks: { video: [{}], fx: [], audio: [] },
    clips: [clip('a', 0), clip('b', 2, { transitionIn: tr('tr-crossfade') }), clip('c', 4, { transitionIn: tr('tr-push', 0.6) })],
  });
  useTrSel.setState({ ids: [] });
};
const no = { ctrlKey: false, metaKey: false, shiftKey: false };

reset();
clickTransition('b', no);
assert.deepEqual(useTrSel.getState().ids, ['b']);
assert.equal(useStore.getState().selection?.id, 'b');
clickTransition('c', { ...no, ctrlKey: true });
assert.deepEqual(useTrSel.getState().ids, ['b', 'c'], 'Ctrl+點 = 加選');
clickTransition('c', { ...no, ctrlKey: true });
assert.deepEqual(useTrSel.getState().ids, ['b'], 'Ctrl+點選取中的 = 取消');
clickTransition('c', { ...no, shiftKey: true });
assert.deepEqual(useTrSel.getState().ids, ['b', 'c'], 'Shift+點 = 選一段');
console.log('PASS 轉場多選');

reset();
clickTransition('b', no);
navTransition(1, false);
assert.equal(useStore.getState().selection?.id, 'c', 'Ctrl+→ 換到下一個轉場');
assert.deepEqual(useTrSel.getState().ids, ['c']);
navTransition(-1, true);
assert.deepEqual(useTrSel.getState().ids.sort(), ['b', 'c'], 'Ctrl+Shift+← 延伸選取');
selectAllTransitions();
assert.equal(useTrSel.getState().ids.length, 2);
console.log('PASS 轉場鍵盤切換');

reset();
clickTransition('c', no);
assert.ok(copyTransition());
clickTransition('b', no);
assert.equal(pasteTransition(), 1);
const b = useStore.getState().clips.find((x) => x.id === 'b')!;
assert.equal(b.transitionIn?.moduleId, 'tr-push');
assert.equal(b.transitionIn?.duration, 0.6, '貼上包含長度');
clickTransition('c', { ...no, ctrlKey: true });
assert.equal(removeTransitions(), 2);
assert.ok(useStore.getState().clips.every((x) => !x.transitionIn), '移除所有選取的轉場');
assert.equal(useStore.getState().selection?.type, 'clip');
console.log('PASS 轉場複製貼上 / 移除');

// 選了別的東西 → 轉場多選清掉
reset();
clickTransition('b', no);
useStore.getState().select({ type: 'clip', id: 'a' });
assert.deepEqual(useTrSel.getState().ids, []);
console.log('PASS 選別的項目時清掉轉場選取');

// Home / End：選取的轉場的頭尾（剪接點轉場以剪接點為中心）
reset();
clickTransition('b', no);
assert.deepEqual(trSelRange(), { a: 1.8, b: 2.2 });
clickTransition('c', { ...no, ctrlKey: true });
assert.deepEqual(trSelRange(), { a: 1.8, b: 4.3 }, '多選 = 最早的開頭 ~ 最晚的結尾');
console.log('PASS 轉場頭尾範圍');
