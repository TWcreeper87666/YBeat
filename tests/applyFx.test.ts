import { strict as assert } from 'node:assert';
(globalThis as { requestAnimationFrame?: (f: () => void) => number }).requestAnimationFrame = () => 0;
import { makeClip, useStore, type ClipFx, type FxItem } from '../src/store';
import { applyFxToTrack, copyFx, pasteFx } from '../src/ui/applyAll';

const fx = (id: string, moduleId: string, track: number, params = {}): FxItem => ({ id, moduleId, track, start: 0, duration: 1, params, keys: {} });
const cfx = (id: string, moduleId: string, params = {}): ClipFx => ({ id, moduleId, params });

// ── 特效軌 ──
const resetFx = () => useStore.setState({
  clips: [], audios: [], media: [],
  effects: [fx('a', 'blur', 0, { r: 9 }), fx('b', 'blur', 0, { r: 1 }), fx('c', 'glow', 0, { k: 1 }), fx('d', 'blur', 1, { r: 1 })],
});
const E = (id: string) => useStore.getState().effects.find((f) => f.id === id)!;

resetFx();
assert.equal(applyFxToTrack({ kind: 'fx', id: 'a' }, 'same'), 1);
assert.deepEqual(E('b').params, { r: 9 });
assert.equal(E('c').moduleId, 'glow', 'same 不動其他特效');
assert.deepEqual(E('d').params, { r: 1 }, '別條軌道不動');
console.log('PASS 特效套用到同軌：相同特效');

resetFx();
assert.equal(applyFxToTrack({ kind: 'fx', id: 'a' }, 'other'), 1);
assert.equal(E('c').moduleId, 'blur');
assert.deepEqual(E('c').params, { r: 9 });
assert.deepEqual(E('b').params, { r: 1 }, 'other 不動相同特效');
console.log('PASS 特效套用到同軌：其他特效');

resetFx();
assert.equal(applyFxToTrack({ kind: 'fx', id: 'a' }, 'all'), 2);
console.log('PASS 特效套用到同軌：全部');

// ── 片段特效 ──
const resetClips = () => useStore.setState({
  effects: [],
  clips: [
    makeClip({ id: 'p', mediaId: 'm', track: 0, start: 0, effects: [cfx('x', 'blur', { r: 5 })] }),
    makeClip({ id: 'q', mediaId: 'm', track: 0, start: 2, effects: [cfx('y', 'blur', { r: 1 }), cfx('base', 'mask', {})] }),
    makeClip({ id: 'r', mediaId: 'm', track: 0, start: 4, effects: [{ ...cfx('m', 'mask'), base: true }] }),
    makeClip({ id: 's', mediaId: 'm', track: 1, start: 0 }),
  ],
});
const C = (id: string) => useStore.getState().clips.find((c) => c.id === id)!;

resetClips();
assert.equal(applyFxToTrack({ kind: 'cfx', clipId: 'p', id: 'x' }, 'same'), 1);
assert.deepEqual(C('q').effects![0].params, { r: 5 });
assert.equal(C('r').effects!.length, 1, 'same 不加到沒有的片段');
console.log('PASS 片段特效套用到同軌：已有的片段');

resetClips();
assert.equal(applyFxToTrack({ kind: 'cfx', clipId: 'p', id: 'x' }, 'other'), 1);
const r = C('r').effects!;
assert.equal(r.length, 2);
assert.equal(r[0].moduleId, 'blur', '加在片段遮罩前面');
assert.ok(r[1].base);
assert.notEqual(r[0].id, 'x', '新的 id');
assert.equal(C('s').effects, undefined, '別條軌道不動');
console.log('PASS 片段特效套用到同軌：沒有的片段');

// ── 複製 / 貼上：遮罩保留目標自己的 ──
resetFx();
useStore.setState({ effects: useStore.getState().effects.map((f) => (f.id === 'c' ? { ...f, keys: { 'mask.x': [] }, mask: { shape: 'rect' } as never } : f)) });
assert.ok(copyFx({ kind: 'fx', id: 'a' }));
assert.ok(pasteFx({ kind: 'fx', id: 'c' }));
assert.equal(E('c').moduleId, 'blur');
assert.deepEqual(E('c').params, { r: 9 });
assert.ok(E('c').keys!['mask.x'], '遮罩關鍵影格保留');
assert.ok(E('c').mask, '遮罩保留');
console.log('PASS 特效複製貼上');

// ── 片段本身的屬性 ──
import { applyClipGroups, applyClipProps, copyClipAttrs, pasteClipAttrs } from '../src/ui/applyAll';
const resetCl = () => useStore.setState({
  selected: [],
  clips: [
    makeClip({ id: 'a', mediaId: 'm', track: 0, start: 0, transform: { x: 0.1, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 0.5 }, keys: { scaleX: [{ id: 'k1', t: 0, v: 1.2 }, { id: 'k2', t: 0.5, v: 1 }] } as never, blend: 'screen' }),
    makeClip({ id: 'b', mediaId: 'm', track: 0, start: 2, keys: { x: [{ id: 'k3', t: 0, v: 0.3 }] } as never }),
    makeClip({ id: 't', mediaId: '', track: 0, start: 4, text: {} as never }),
    makeClip({ id: 'z', mediaId: 'm', track: 1, start: 0 }),
  ],
});
resetCl();
assert.equal(applyClipProps('a', ['scaleX'], 0, false), 1, '文字片段 / 別軌不算');
assert.equal(C('b').transform.scaleX, 1.2, '播放頭位置的值');
assert.equal(C('b').keys.scaleX, undefined);
assert.equal(C('t').transform.scaleX, 1);
resetCl();
applyClipProps('a', ['scaleX'], 0, true);
assert.equal(C('b').keys.scaleX?.length, 2, '含關鍵影格');
console.log('PASS 片段屬性套用到同軌');

resetCl();
assert.equal(applyClipGroups('a', ['motion']), 1);
assert.equal(C('b').transform.x, 0.1);
assert.equal(C('b').keys.x, undefined, '來源沒有 key → 目標的 key 移除');
assert.equal(C('b').transform.opacity, 1, '只套用運動');
applyClipGroups('a', ['opacity']);
assert.equal(C('b').transform.opacity, 0.5);
assert.equal(C('b').blend, 'screen');
console.log('PASS 片段屬性分組套用');

resetCl();
copyClipAttrs('a');
useStore.setState({ selected: ['clip:b', 'clip:z'] });
assert.equal(pasteClipAttrs('b'), 2, '貼到所有選取的片段');
assert.equal(C('z').transform.x, 0.1);
console.log('PASS 片段屬性複製貼上');

// ── 套用到選取的 ──
resetFx();
useStore.setState({ selected: ['effect:d', 'effect:c'] });
assert.equal(applyFxToTrack({ kind: 'fx', id: 'a' }, 'selected'), 2, '選取的特效（不分軌道、種類）');
assert.equal(E('d').moduleId, 'blur');
assert.deepEqual(E('d').params, { r: 9 });
assert.deepEqual(E('b').params, { r: 1 }, '沒選的不動');
console.log('PASS 特效套用到選取的');

resetCl();
useStore.setState({ selected: ['clip:z', 'clip:t'] });
assert.equal(applyClipProps('a', ['x'], 0, false, 'selected'), 2, '選取的片段（不分軌道、種類）');
assert.equal(C('z').transform.x, 0.1);
assert.equal(C('b').transform.x, 0, '沒選的不動');
console.log('PASS 片段屬性套用到選取的');

// ── 區塊複製貼上：只貼複製的那一組 ──
resetCl();
copyClipAttrs('a', ['motion']);
useStore.setState({ selected: [] });
assert.equal(pasteClipAttrs('b', 'opacity'), 0, '複製的是運動，不能貼到不透明度');
assert.equal(pasteClipAttrs('b', 'motion'), 1);
assert.equal(C('b').keys.scaleX?.length, 2);
assert.equal(C('b').blend, undefined, '不透明度那組不動');
console.log('PASS 區塊複製貼上');
