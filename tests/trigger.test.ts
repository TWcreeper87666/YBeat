import { strict as assert } from 'node:assert';
(globalThis as { requestAnimationFrame?: (f: () => void) => number }).requestAnimationFrame = () => 0;
import { beatHits, fxWindow, normalizeHits, overwriteHits, setBeatSource, splitTiming, triggerMarks, triggerWindow, type FxTiming } from '../src/engine/trigger';
import { defaultTiming, makeClip, useStore, type FxItem } from '../src/store';
import { usePrefs } from '../src/prefs';

// ── 觸發窗口：方塊 [1, 5)，節拍每 1 秒 ──
const beats = [0, 1, 2, 3, 4, 5, 6];
assert.deepEqual(triggerWindow(beats, 1, 5, 1.5), { t0: 1, d: 1 });
assert.deepEqual(triggerWindow(beats, 1, 5, 3.99), { t0: 3, d: 1 });
assert.deepEqual(triggerWindow(beats, 1, 5, 4.2), { t0: 4, d: 1 }, '最後一段到方塊結尾');
assert.deepEqual(triggerWindow(beats, 1.5, 5, 1.7), { t0: 1.5, d: 0.5 }, '方塊開頭本身是一次觸發');
assert.deepEqual(triggerWindow([], 1, 5, 3), { t0: 1, d: 4 }, '沒有節拍 = 整段一次');
assert.deepEqual(triggerMarks(beats, 1, 5), [2, 3, 4], '方塊裡的觸發點（不含開頭、結尾）');
console.log('PASS 觸發窗口');

// ── 分割：疊加的特效關鍵影格也切開；有觸發的照原樣 ──
const key = (t: number, v: number) => ({ id: 'k' + t, t, v, ease: [0, 0, 1, 1] as [number, number, number, number] });
const block = (p: Partial<FxItem> = {}): FxItem => ({
  id: 'f', moduleId: 'blur', params: {}, start: 0, duration: 4, track: 0,
  keys: { r: [key(0, 0), key(3, 1)] },
  stack: [{ id: 's1', moduleId: 'glow', params: {}, keys: { k: [key(1, 0), key(3, 1)] } }],
  ...p,
});
useStore.setState({ clips: [], audios: [], tracks: { video: [{}], fx: [{}], audio: [] }, effects: [block()], selected: ['effect:f'], selection: { type: 'effect', id: 'f' }, time: 2 });
useStore.getState().split();
let fx = useStore.getState().effects.sort((a, b) => a.start - b.start);
assert.equal(fx.length, 2);
assert.equal(fx[1].stack?.[0].keys?.k[0].t, 0, '後半段疊加特效的關鍵影格從 0 開始');
assert.notEqual(fx[1].stack?.[0].id, 's1', '後半段疊加特效換新 id');

useStore.setState({ effects: [block({ trigger: { kind: 'beat', every: 1 } })], selected: ['effect:f'], selection: { type: 'effect', id: 'f' }, time: 2 });
useStore.getState().split();
fx = useStore.getState().effects.sort((a, b) => a.start - b.start);
assert.deepEqual(fx[1].keys, block().keys, '有觸發：關鍵影格照原樣');
console.log('PASS 特效方塊分割');

// ── 我的組合：整組放上時間軸 ──
usePrefs.setState({ fxCombos: [{ id: 'combo:x', name: 'Punch', fx: { moduleId: 'blur', params: { r: 3 }, duration: 2, trigger: { kind: 'cut' }, stack: [{ id: 'a', moduleId: 'glow', params: {} }] } }] });
useStore.setState({ effects: [], modules: [...useStore.getState().modules, { id: 'blur', kind: 'effect', name: 'Blur', code: '' } as never] });
useStore.getState().addEffect('combo:x', 10, 0);
const added = useStore.getState().effects[0];
assert.equal(added.moduleId, 'blur');
assert.equal(added.duration, 2);
assert.deepEqual(added.trigger, { kind: 'cut' });
assert.equal(added.stack?.length, 1);
assert.notEqual(added.stack?.[0].id, 'a', '疊加特效換新 id');
console.log('PASS 我的組合放上時間軸');

// ── 轉場方塊 / 剪接點軌道 ──
import { applyTransitionBlocks } from '../src/engine/renderer';
import { cutPoints, cutTracks } from '../src/engine/trigger';
import { makeClip, type Tracks } from '../src/store';
const tracks2: Tracks = { video: [{}, {}], fx: [{}], audio: [] };
const v = (id: string, track: number, start: number, p = {}) => makeClip({ id, mediaId: 'm', track, start, duration: 1, ...p });
const clips2 = [v('a', 0, 0), v('b', 0, 1), v('c', 0, 2, { transitionIn: { moduleId: 'own', params: {}, duration: 0.2 } }), v('d', 0, 3), v('e', 0, 5), v('x', 1, 0), v('y', 1, 1)];
const blk = (p: Partial<FxItem> = {}): FxItem => ({ id: 'tb', moduleId: 'tr-zoom', params: { k: 1 }, start: 0.5, duration: 3, track: 0, trigger: { kind: 'cut' }, trDur: 0.3, ...p });

assert.deepEqual(cutTracks(blk(), tracks2), [0, 1], '沒指定 = 下面所有影片軌');
assert.deepEqual(cutTracks(blk({ trigger: { kind: 'cut', tracks: [1] } }), tracks2), [1]);
assert.deepEqual(cutPoints(clips2, [0]), [0, 1, 2, 3, 5]);
assert.deepEqual(cutPoints(clips2, [0], true), [1, 2, 3], '只算前面緊貼著片段的');

const out = applyTransitionBlocks(clips2.filter((c) => c.track === 0), 0, [blk()], tracks2);
const tr = (id: string) => out.find((c) => c.id === id)!.transitionIn;
assert.equal(tr('a'), null, '第一個片段沒有剪接點');
assert.deepEqual(tr('b'), { moduleId: 'tr-zoom', params: { k: 1 }, duration: 0.3 });
assert.equal(tr('c')!.moduleId, 'own', '片段自己的轉場優先');
assert.equal(tr('d')!.moduleId, 'tr-zoom', '方塊結尾剛好在剪接點上也算');
assert.equal(tr('e'), null, '有空隙不算剪接點');
assert.equal(clips2[1].transitionIn, null, 'store 裡的片段不動');
const only1 = applyTransitionBlocks(clips2.filter((c) => c.track === 0), 0, [blk({ trigger: { kind: 'cut', tracks: [1] } })], tracks2);
assert.equal(only1.find((c) => c.id === 'b')!.transitionIn, null, '沒選的軌道不套用');
console.log('PASS 轉場方塊');

// ── 片段特效的作用範圍 ──
{
  const hits: FxTiming = { kind: 'hits', hits: [{ t: 0, d: 0.5 }, { t: 2, d: 1 }] };
  assert.deepEqual(fxWindow(undefined, 1.2, 4), { t0: 0, d: 4 }, '沒有 timing = 整段');
  assert.deepEqual(fxWindow(hits, 0, 4), { t0: 0, d: 0.5 }, 'Hit 開頭本身算');
  assert.equal(fxWindow(hits, 0.5, 4), null, 'Hit 結尾不算');
  assert.equal(fxWindow(hits, 1.5, 4), null, '兩個 Hit 中間 = 跳過');
  assert.deepEqual(fxWindow(hits, 2.9, 4), { t0: 2, d: 1 });
  assert.equal(fxWindow(hits, 3.5, 4), null);
  assert.equal(fxWindow({ kind: 'hits', hits: [] }, 1, 4), null, '沒有 Hit = 完全不作用');

  // 節拍每 1 秒；片段從 1.5 開始、長 3 秒
  setBeatSource((every) => [0, 1, 2, 3, 4, 5, 6].filter((_, i) => i % every === 0));
  const beat: FxTiming = { kind: 'beat', every: 1, d: 0.25 };
  assert.equal(fxWindow(beat, 0.2, 3, 1.5), null, '片段開頭在兩拍中間：還沒到第一拍');
  assert.deepEqual(fxWindow(beat, 0.6, 3, 1.5), { t0: 0.5, d: 0.25 }, '第一拍（時間軸 2 秒）');
  assert.equal(fxWindow(beat, 0.8, 3, 1.5), null, '這一拍播完了');
  assert.deepEqual(fxWindow(beat, 2.5, 3, 1.5), { t0: 2.5, d: 0.25 }, '時間軸 4 秒那拍');
  assert.deepEqual(fxWindow(beat, 0.1, 3, 1), { t0: 0, d: 0.25 }, '片段開頭剛好在拍上');
  assert.deepEqual(beatHits(1, 0.25, 1.5, 3), [{ t: 0.5, d: 0.25 }, { t: 1.5, d: 0.25 }, { t: 2.5, d: 0.25 }], '轉成手動');
  assert.deepEqual(beatHits(1, 5, 1.5, 3).map((h) => h.d), [1, 1, 1], '長度不超過下一拍；片段結尾不截（畫面跟每拍模式一樣）');
  setBeatSource(() => []);
  assert.equal(fxWindow(beat, 1, 3, 1.5), null, '沒有節拍 = 不作用');

  assert.deepEqual(normalizeHits([{ t: 2, d: 1 }, { t: 0.5, d: 3 }, { t: 9, d: 1 }], 4), [{ t: 0.5, d: 1.5 }, { t: 2, d: 1 }], '排序、重疊截短、片段外丟掉');

  const ow = (base: [number, number][], add: [number, number][]) => overwriteHits(base.map(([t, d]) => ({ t, d })), add.map(([t, d]) => ({ t, d })), 4).map((h) => [+h.t.toFixed(3), +h.d.toFixed(3)]);
  assert.deepEqual(ow([[0, 0.5], [0.8, 0.5]], [[0.5, 0.5]]), [[0, 0.5], [0.5, 0.5], [1, 0.3]], 'Ctrl+D：接在後面、蓋到下一個的開頭 → 下一個從新的結尾開始');
  assert.deepEqual(ow([[0, 0.5], [1, 0.2]], [[0.9, 0.5]]), [[0, 0.5], [0.9, 0.5]], '整個蓋住的刪掉');
  assert.deepEqual(ow([[0, 2]], [[0.5, 0.5]]), [[0, 0.5], [0.5, 0.5], [1, 1]], '包住新的那個：拆成前後兩段');
  assert.deepEqual(ow([[0, 1]], [[5, 1]]), [[0, 1]], '片段外的丟掉');

  const [a, b] = splitTiming({ kind: 'hits', hits: [{ t: 0, d: 0.5 }, { t: 1.8, d: 0.5 }, { t: 3, d: 0.5 }] }, 2);
  assert.deepEqual(a, { kind: 'hits', hits: [{ t: 0, d: 0.5 }, { t: 1.8, d: 0.5 }] }, '跨切點的留在前段、長度不變');
  assert.deepEqual(b, { kind: 'hits', hits: [{ t: 1, d: 0.5 }] }, '後段從 0 算');
  assert.deepEqual(splitTiming(beat, 2), [beat, beat], 'beat 兩段都保留規則');
  assert.deepEqual(splitTiming(undefined, 2), [undefined, undefined]);

  assert.deepEqual(defaultTiming({ kind: 'effect', code: '// @duration 0.3\n// @hit\n' }), { kind: 'hits', hits: [{ t: 0, d: 0.3 }] }, '衝擊特效 = 開頭打一下');
  assert.equal(defaultTiming({ kind: 'effect', code: '// @duration 0.5\n' }), undefined, '持續特效 = 整段');

  // 切割片段：片段特效的 timing 分到兩段
  const clip = makeClip({ id: 'c', mediaId: 'm', start: 0, duration: 4, effects: [{ id: 'e', moduleId: 'blur', params: {}, timing: { kind: 'hits', hits: [{ t: 0.5, d: 0.5 }, { t: 3, d: 0.5 }] } }] });
  useStore.setState({ clips: [clip], effects: [], media: [], selected: ['clip:c'], selection: { type: 'clip', id: 'c' }, time: 2 });
  useStore.getState().split();
  const cs = useStore.getState().clips.sort((x, y) => x.start - y.start);
  assert.equal(cs.length, 2);
  assert.deepEqual(cs[0].effects![0].timing, { kind: 'hits', hits: [{ t: 0.5, d: 0.5 }] });
  assert.deepEqual(cs[1].effects![0].timing, { kind: 'hits', hits: [{ t: 1, d: 0.5 }] });
  console.log('PASS 片段特效作用範圍');
}
