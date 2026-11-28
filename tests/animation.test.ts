(globalThis as any).localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
(globalThis as any).window = globalThis;
import { strict as assert } from 'node:assert';
import { animLayers, animMaskAt, animTemplate, snapAnimBeats } from '../src/engine/animation';
import { expandPop, POP_VARIANTS } from '../src/engine/subjectPop';
import { setBeatSource } from '../src/engine/trigger';
import { settleHistory, undo, resetHistory } from '../src/engine/history';
import { packProject, projectAnims } from '../src/engine/project';
import { makeClip, stretchPatch, useStore } from '../src/store';
import { copySlots, pasteAnimImages, copyAnimImages, pasteSlots, patchAnimSlot, placeAnim, setAnimSameMedia, setAnimSlot, usedImageSlots } from '../src/engine/animPlace';
import { COMBO_IDS, comboBeats, comboItem } from '../src/engine/animCombos';
import { usePrefs } from '../src/prefs';

const path = 'M40 40L160 40L160 160L40 160Z';
for (const variant of POP_VARIANTS) {
  const item = animTemplate(variant, { id: variant, start: 0, duration: 4, subject: 'one', reveal: 'two', outline: path });
  const old = expandPop({ b0: 0, b1: 4, variant, mediaId: 'one', revealMediaId: 'two', cx: 0, cy: 0, path }, (b) => b)
    .filter((_, i) => variant !== 'textBehind' || i !== 1);
  assert.equal(item.layers.length, old.length, `${variant} layers`);
  for (const beat of [0, 1, 2, 3]) {
    const draw = animLayers(item, beat, 1);
    const expected = old.filter((l) => beat >= l.t0 && beat < l.t1);
    assert.equal(draw.length, expected.length, `${variant} beat ${beat}`);
    for (const [i, d] of draw.entries()) {
      const ref = expected[i];
      assert.equal(d.slot.mediaId, ref.mediaId === 'two' ? 'two' : 'one');
      assert.equal(d.mask?.mode, ref.mask?.invert ? 'hole' : ref.mask ? 'window' : undefined);
      for (const prop of ['x', 'y', 'scaleX', 'scaleY', 'rotation', 'opacity'] as const) {
        const list = ref.keys?.[prop];
        if (!list?.length) continue;
        const at = beat - ref.t0;
        const key = [...list].reverse().find((k) => Math.abs(k.t - at) < 1e-8);
        if (!key) continue;
        assert.ok(Math.abs(d[prop] - key.v) < 1e-6, `${variant} ${prop} beat ${beat}`);
      }
    }
  }
}
console.log('PASS 14 animation templates');

const base = animTemplate('step', { id: 'anim-test', start: 0, duration: 4, subject: 'one' });
assert.equal(animLayers({ ...base, slots: base.slots.map((s) => ({ ...s, mediaId: null })) }, 0, 1).length, 0);
assert.equal(animLayers(base, 4, 1).length, 0);
const snapped = snapAnimBeats({ ...base, start: 0.2 }, [0, 1, 2, 3, 4, 5]);
assert.ok(Math.abs(snapped.beatTimes![1] - 0.8) < 1e-8);
console.log('PASS missing slots and beat snap');

{
  const legacy = { ...base, layers: [{ ...base.layers[0], fromBeat: 0, toBeat: 4, keys: {}, base: { x: 0.25, y: 0.1, opacity: 0.8 } }] };
  const before = animLayers(legacy, 0.25, 1, 16 / 9)[0];
  assert.deepEqual(animLayers({ ...legacy, transform: undefined, keys: undefined }, 0.25, 1, 16 / 9)[0], before);
  const moved = { ...legacy, transform: { x: 0.1, y: 0.2, scaleX: 1, scaleY: 1, rotation: 90, opacity: 0.5 } };
  const draw = animLayers(moved, 0.25, 1, 16 / 9)[0];
  assert.ok(Math.abs(draw.x - (0.1 - 0.1 * 9 / 16)) < 1e-9);
  assert.ok(Math.abs(draw.y - (0.2 + 0.25 * 16 / 9)) < 1e-9);
  assert.equal(draw.opacity, 0.4);
  const sheared = animLayers({ ...legacy, transform: { ...moved.transform, scaleX: 2, scaleY: 1 },
    layers: [{ ...legacy.layers[0], base: { ...legacy.layers[0].base, rotation: 45 } }] }, 0.25, 1, 16 / 9)[0];
  assert.ok(sheared.matrix && Math.abs(sheared.matrix[0] * sheared.matrix[2] + sheared.matrix[1] * sheared.matrix[3]) > 0.1,
    'nonuniform overall scale retains the shear from layer rotation');
  const keyed = { ...moved, keys: { x: [{ id: 'all-x', t: 1, v: 0.3, ease: 'hold' as const }] } };
  const patch = stretchPatch('anim', keyed, 0, 2) as Partial<typeof keyed>;
  assert.deepEqual(patch.beatTimes, keyed.beatTimes?.map((b) => b * 2));
  assert.equal(patch.keys, undefined);
  assert.equal(animLayers({ ...keyed, ...patch }, 2.5, 1, 16 / 9)[0].x,
    animLayers(keyed, 1.25, 1, 16 / 9)[0].x);
  assert.deepEqual(snapAnimBeats({ ...keyed, start: 0.2 }, [0, 1, 2, 3, 4, 5]).keys, keyed.keys);
  console.log('PASS overall animation transform, stretch and legacy data');
}

useStore.setState({ anims: [base] });
const saved = JSON.parse(JSON.stringify(packProject(useStore.getState())));
assert.deepEqual(projectAnims(saved), JSON.parse(JSON.stringify([base])));
assert.deepEqual(projectAnims({}), []);
console.log('PASS project animation round trip');

const reset = () => {
  resetHistory();
  useStore.setState({ clips: [], effects: [], audios: [], anims: [base], tracks: { video: [{}], fx: [], audio: [] },
    selected: ['anim:anim-test'], selection: { type: 'anim', id: 'anim-test' }, time: 2, clipboard: null });
  resetHistory();
};
reset();
setBeatSource(() => [0, 1, 2, 3, 4, 5, 6]);
useStore.getState().patchItems({ 'anim:anim-test': { start: 0.2 } });
assert.ok(Math.abs(useStore.getState().anims[0].beatTimes![1] - 0.8) < 1e-8);
useStore.setState({ time: 2.2 });
useStore.getState().trim('start');
assert.equal(useStore.getState().anims[0].start, 2.2);
assert.ok(Math.abs(useStore.getState().anims[0].beatTimes![1] - 0.8) < 1e-8);
setBeatSource(() => []);
reset();
useStore.getState().split();
assert.equal(useStore.getState().anims.length, 1);
useStore.getState().splitAtTimes([1, 2]);
assert.equal(useStore.getState().anims.length, 1);
useStore.getState().toggleLockSelected();
useStore.getState().nudge(1);
assert.equal(useStore.getState().anims[0].start, 0);
useStore.getState().copy();
useStore.getState().paste({ time: 5, track: 0, kind: 'video' });
assert.equal(useStore.getState().anims.length, 2);
assert.notEqual(useStore.getState().anims[1].id, base.id);
assert.equal(useStore.getState().anims[1].locked, undefined);
reset();
useStore.getState().removeSelection();
assert.equal(useStore.getState().anims.length, 0);
settleHistory();
undo();
assert.equal(useStore.getState().anims.length, 1);
console.log('PASS animation store operations and undo');

// 放到時間軸：吸附到拍、4 拍長、底下的片段當主體 / 背景、下一個鏡頭當揭露、放在上面的空軌
{
  const media = [
    { id: 'v1', name: 'v1', kind: 'video', url: '', thumb: '', duration: 20, width: 1920, height: 1080 },
    { id: 'v2', name: 'v2', kind: 'video', url: '', thumb: '', duration: 20, width: 1920, height: 1080 },
  ] as any;
  resetHistory();
  useStore.setState({ media, anims: [], effects: [], audios: [], tracks: { video: [{}], fx: [], audio: [] },
    clips: [makeClip({ id: 'c1', mediaId: 'v1', track: 0, start: 0, duration: 3, in: 5 }), makeClip({ id: 'c2', mediaId: 'v2', track: 0, start: 3, duration: 3, in: 1 })] });
  setBeatSource(() => [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4]);
  const id = placeAnim('crossShot', 0, 1.1)!;
  const a = useStore.getState().anims.find((x) => x.id === id)!;
  assert.equal(a.start, 1);
  assert.ok(Math.abs(a.duration - 2) < 1e-9);
  assert.equal(a.track, 1);
  assert.equal(useStore.getState().tracks.video.length, 2);
  const slot = (role: string) => a.slots.find((x) => x.role === role)!;
  assert.equal(slot('subject').mediaId, 'v1');
  assert.ok(Math.abs(slot('subject').sourceTime - 6) < 1e-6);
  assert.equal(slot('reveal').mediaId, 'v2');
  assert.ok(Math.abs(slot('reveal').sourceTime - 1) < 1e-6);
  setAnimSlot(id, 'reveal', 'v1');
  assert.equal(useStore.getState().anims.find((x) => x.id === id)!.slots.find((x) => x.id === 'reveal')!.mediaId, 'v1');
  console.log('PASS place animation: beat snap, slots from clips, upper track, replace one slot');

  // 空白處：圖片位置待補；我的動畫：這個專案沒有的素材變待補
  useStore.setState({ clips: [], anims: [] });
  const eid = placeAnim('step', 0, 0);
  const empty = useStore.getState().anims.find((x) => x.id === eid)!;
  assert.ok(empty.slots.every((x) => x.mediaId === null));
  usePrefs.setState({ animPresets: [{ id: 'p1', name: 'mine', item: { ...a, slots: a.slots.map((x) => ({ ...x, mediaId: x.role === 'subject' ? 'gone' : x.mediaId })) } }] });
  const mid = placeAnim('my:p1', 0, 2);
  const mine = useStore.getState().anims.find((x) => x.id === mid)!;
  assert.equal(mine.slots.find((x) => x.role === 'subject')!.mediaId, null);
  assert.equal(mine.slots.find((x) => x.role === 'reveal')!.mediaId, 'v2');
  assert.equal(mine.presetId, 'crossShot');
  setBeatSource(() => []);
  console.log('PASS empty placement and my animation with missing media');
}

// 組合範本：圖層 / 遮罩指到存在的位置，關鍵影格照拍排好；放到時間軸照自己的拍數、填底下 / 下一個鏡頭
{
  for (const combo of COMBO_IDS) {
    const item = comboItem(combo, { id: combo, start: 0, duration: 4, track: 0, under: { mediaId: 'one', sourceTime: 2 }, next: { mediaId: 'two', sourceTime: 0 } });
    const slots = new Set(item.slots.map((s) => s.id));
    const layers = new Set(item.layers.map((l) => l.id));
    assert.equal(layers.size, item.layers.length, `${combo} unique layer ids`);
    assert.equal(item.beatTimes!.length, comboBeats(combo) + 1);
    for (const l of item.layers) {
      assert.ok(slots.has(l.slotId), `${combo} ${l.id} slot`);
      assert.ok(l.fromBeat < l.toBeat && l.toBeat <= comboBeats(combo) + 1e-9, `${combo} ${l.id} range`);
      if (l.mask) { assert.ok(slots.has(l.mask.slotId)); assert.ok(!l.mask.layerId || layers.has(l.mask.layerId)); }
      for (const list of Object.values(l.keys)) for (let i = 1; i < (list?.length ?? 0); i++) assert.ok(list![i].t >= list![i - 1].t, `${combo} ${l.id} sorted`);
    }
    for (const s of item.slots) assert.equal(s.mediaId, s.role === 'reveal' ? 'two' : 'one', `${combo} ${s.id} filled`);
    assert.ok(animLayers(item, 3.99, 1).length > 0, `${combo} draws at the end`);
  }
  console.log(`PASS ${COMBO_IDS.length} combo templates`);
}

// 全用同一張：打開 = 其他位置換成同一張；換一個位置 = 全部一起換；關掉 = 只換那一個
{
  const item = comboItem('tripleSlide', { id: 'same', start: 0, duration: 2, track: 0, under: { mediaId: 'a', sourceTime: 1 } });
  useStore.setState({ anims: [item], clips: [], tracks: { video: [{}], fx: [], audio: [] } });
  patchAnimSlot('same', 'p2', { mediaId: 'b', sourceTime: 3 });
  const get = () => useStore.getState().anims[0];
  assert.deepEqual(get().slots.map((s) => s.mediaId), ['a', 'b', 'a']);
  setAnimSameMedia('same', true, 'p2');
  assert.ok(get().sameMedia);
  assert.deepEqual(get().slots.map((s) => [s.mediaId, s.sourceTime]), [['b', 3], ['b', 3], ['b', 3]]);
  setAnimSlot('same', 'p3', 'c');
  assert.deepEqual(get().slots.map((s) => s.mediaId), ['c', 'c', 'c']);
  patchAnimSlot('same', 'p1', { cutout: { mode: 'off' } });
  assert.equal(get().slots.filter((s) => s.cutout?.mode === 'off').length, 1, 'cut-out stays per slot');
  setAnimSameMedia('same', false);
  setAnimSlot('same', 'p1', 'd');
  assert.deepEqual(get().slots.map((s) => s.mediaId), ['d', 'c', 'c']);
  console.log('PASS same image for all slots');
}

// Ctrl+拖曳變速：拍點跟著縮放（關鍵影格一起拉長），不再吸附回專案拍點
{
  setBeatSource(() => [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5]);
  const item = { ...animTemplate('fly', { id: 'st', start: 1, duration: 2, subject: 'm' }), track: 0 };
  useStore.setState({ anims: [item], clips: [], tracks: { video: [{}], fx: [], audio: [] } });
  const p = stretchPatch('anim', item, 1, 0.6) as Partial<typeof item>;
  assert.deepEqual(p.beatTimes!.map((b) => +b.toFixed(6)), item.beatTimes!.map((b) => +(b * 0.6).toFixed(6)));
  useStore.getState().patchItems({ 'anim:st': p });
  const after = useStore.getState().anims[0];
  assert.ok(Math.abs(after.duration - 1.2) < 1e-9);
  assert.deepEqual(after.beatTimes!.map((b) => +b.toFixed(6)), p.beatTimes!.map((b) => +b.toFixed(6)));
  // 同一拍的位置：拉短後在新時間的同一個比例
  const x0 = animLayers(item, 1 + 0.25, 0.5)[0].x;
  const x1 = animLayers(after, 1 + 0.25 * 0.6, 0.5)[0].x;
  assert.ok(Math.abs(x0 - x1) < 1e-9, 'keyframes stretch with the item');
  setBeatSource(() => []);
  console.log('PASS anim stretch scales the beat grid');
}

// 複製 / 貼上圖片：主體依序（少了輪流）、背景 / 揭露同種、分身跟主體、對不到的保留、全用同一張、多個動畫依序分配
{
  const usable = (id: string) => id !== 'gone';
  const ids = (a: { slots: { id: string; mediaId: string | null }[] }) => Object.fromEntries(a.slots.map((s) => [s.id, s.mediaId]));
  const triple = comboItem('tripleSlide', { id: 't', start: 0, duration: 2, track: 0, under: { mediaId: 'old', sourceTime: 0 } });
  const fly = animTemplate('fly', { id: 'f', start: 0, duration: 2, subject: 'old', reveal: 'oldR' });
  const echo = comboItem('zoomEcho', { id: 'z', start: 0, duration: 2, track: 0, under: { mediaId: 'old', sourceTime: 0 } });
  const src3 = copySlots(usedImageSlots({ ...triple, slots: triple.slots.map((s, i) => ({ ...s, mediaId: ['A', 'B', 'C'][i] })) }));
  // 一個人 → 三人：三個都是他；背景來源沒有 → 保留
  const one = copySlots(usedImageSlots({ ...fly, slots: fly.slots.map((s) => (s.role === 'subject' ? { ...s, mediaId: 'P' } : s)) }));
  assert.deepEqual(ids({ slots: pasteSlots(triple, one, { usable }).slots }), { p1: 'P', p2: 'P', p3: 'P' });
  const duo = comboItem('duoClash', { id: 'd', start: 0, duration: 2, track: 0, under: { mediaId: 'old', sourceTime: 0 } });
  assert.deepEqual(ids({ slots: pasteSlots(duo, one, { usable }).slots }), { background: 'old', p1: 'P', p2: 'P' });
  // 三人 → 一個主體：用第一個
  assert.equal(pasteSlots(fly, src3, { usable }).slots.find((s) => s.role === 'subject')!.mediaId, 'A');
  // 分身沒有對應的：跟著主體
  assert.deepEqual(ids({ slots: pasteSlots(echo, src3, { usable }).slots }), { echo1: 'A', echo2: 'A', subject: 'A' });
  // 遺失的素材略過
  const lost = { slots: [{ role: 'subject' as const, image: { mediaId: 'gone', sourceTime: 0 } }, { role: 'subject' as const, image: { mediaId: 'Q', sourceTime: 1 } }] };
  assert.deepEqual(ids({ slots: pasteSlots(triple, lost, { usable }).slots }), { p1: 'Q', p2: 'Q', p3: 'Q' });
  // 全用同一張：全部第一個主體
  assert.ok(pasteSlots({ ...triple, sameMedia: true }, src3, { usable }).slots.every((s) => s.mediaId === 'A'));
  // 多個動畫：依序分配（6 人 → 前三、後三），一次就好
  const six = { slots: ['1', '2', '3', '4', '5', '6'].map((m) => ({ role: 'subject' as const, image: { mediaId: m, sourceTime: 0 } })) };
  const r1 = pasteSlots(triple, six, { usable });
  const r2 = pasteSlots(triple, six, { usable, offset: r1.used });
  assert.deepEqual([r1, r2].map((r) => r.slots.filter((s) => s.role === 'subject').map((s) => s.mediaId)), [['1', '2', '3'], ['4', '5', '6']]);
  // 透過 store：複製 → 貼到兩個動畫
  const media = ['bg', 'A', 'B', 'C', 'old'].map((id) => ({ id, name: id, kind: 'image', url: '', thumb: '', duration: 1, width: 10, height: 10 })) as any;
  const t2 = { ...triple, id: 't2', start: 3 };
  const src = { ...triple, id: 'src', start: 6, slots: triple.slots.map((s, i) => ({ ...s, mediaId: ['A', 'B', 'C'][i] })) };
  useStore.setState({ media, anims: [triple, t2, src], clips: [], tracks: { video: [{}], fx: [], audio: [] } });
  assert.ok(copyAnimImages('src'));
  assert.equal(pasteAnimImages(['t2', 't']), 2);
  const got = useStore.getState().anims.find((a) => a.id === 't2')!;
  assert.deepEqual(ids(got), { p1: 'A', p2: 'B', p3: 'C' });
  // 單一列
  assert.ok(copyAnimImages('src', 'p3'));
  pasteAnimImages(['t'], 'p1');
  assert.equal(useStore.getState().anims.find((a) => a.id === 't')!.slots.find((s) => s.id === 'p1')!.mediaId, 'C');
  console.log('PASS copy / paste animation images');
}

{
  // 整體遮罩：沒有形狀 = 不套；關鍵影格用拍
  const base = animTemplate('spin', { id: 'm', start: 0, duration: 4 });
  assert.equal(animMaskAt(base, 1), null);
  const mask = { shape: 'ellipse', invert: false, x: 0, y: 0, w: 0.5, h: 0.5, feather: 0, rotation: 0 };
  const item = { ...base, mask: { mask, keys: { 'mask.x': [{ id: 'k0', t: 0, v: 0, ease: [0, 0, 1, 1] as [number, number, number, number] }, { id: 'k1', t: 2, v: 0.4, ease: [0, 0, 1, 1] as [number, number, number, number] }] } } };
  assert.equal(animMaskAt(item, 1)!.x, 0.2);
  assert.equal(animMaskAt(item, 1)!.w, 0.5);
  assert.equal(animMaskAt({ ...item, mask: { mask: { ...mask, shape: 'none' } } }, 1), null);
  console.log('PASS whole-animation mask');
}
