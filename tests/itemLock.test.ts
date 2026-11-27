(globalThis as any).localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
console.warn = () => {};
import { makeClip, useStore } from '../src/store';
import { strict as assert } from 'node:assert';

// 鎖住的片段：位置、長度固定；屬性照改；不能分割、刪除；漣漪刪除不會推到它上面
const base = () => {
  const a = makeClip({ id: 'a', mediaId: '', track: 0, start: 0, duration: 2 });
  const b = makeClip({ id: 'b', mediaId: '', track: 0, start: 2, duration: 2 });
  const c = makeClip({ id: 'c', mediaId: '', track: 0, start: 6, duration: 2 });
  useStore.setState({ clips: [a, b, c], effects: [], audios: [], tracks: { video: [{}], fx: [], audio: [] }, selected: ['clip:b'], selection: { type: 'clip', id: 'b' }, clipboard: null, time: 3 });
};
const clip = (id: string) => useStore.getState().clips.find((x) => x.id === id);

base();
useStore.getState().toggleLockSelected();
assert.equal(clip('b')!.locked, true);
useStore.getState().patchItems({ 'clip:b': { start: 5, volume: 0.5 } });
assert.equal(clip('b')!.start, 2);
assert.equal(clip('b')!.volume, 0.5);
console.log('PASS 鎖住：位置不變、屬性照改');

useStore.getState().split();
assert.equal(useStore.getState().clips.length, 3);
useStore.getState().nudge(1);
assert.equal(clip('b')!.start, 2);
console.log('PASS 鎖住：不能分割、微移');

// 漣漪刪除 a：b 鎖住不動，後面的 c 也不能被推到 b 上面
useStore.setState({ selected: ['clip:a'], selection: { type: 'clip', id: 'a' } });
useStore.getState().removeSelection(true);
assert.equal(clip('b')!.start, 2);
assert.ok(clip('c')!.start >= 4 - 1e-9);
console.log('PASS 漣漪刪除不會推動、疊到鎖住的片段');

// 自己選起來按刪除：鎖住的照樣刪得掉
base();
useStore.getState().toggleLockSelected();
useStore.getState().removeSelection();
assert.equal(clip('b'), undefined);
console.log('PASS 鎖住的可以刪除');

// 沒選東西按 S：鎖住的不切，其他的切
base();
useStore.setState({ clips: useStore.getState().clips.map((x) => (x.id === 'b' ? { ...x, locked: true as const } : x)), selected: [], selection: null, time: 3 });
useStore.getState().split();
assert.equal(useStore.getState().clips.filter((x) => x.track === 0).length, 3);
console.log('PASS 沒選東西分割：鎖住的不切');

// 複製貼上出來的不鎖
base();
useStore.getState().toggleLockSelected();
useStore.getState().copy();
useStore.getState().paste();
assert.ok(useStore.getState().clips.filter((x) => x.locked).length === 1);
console.log('PASS 貼上的不帶鎖');

// 解鎖
useStore.setState({ selected: ['clip:b'], selection: { type: 'clip', id: 'b' } });
useStore.getState().toggleLockSelected();
assert.equal(clip('b')!.locked, undefined);
console.log('PASS 解鎖');
