(globalThis as any).localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
(globalThis as any).window = globalThis;
import { strict as assert } from 'node:assert';
import { animLayers, animTemplate, snapAnimBeats } from '../src/engine/animation';
import { expandPop, POP_VARIANTS } from '../src/engine/subjectPop';
import { setBeatSource } from '../src/engine/trigger';
import { settleHistory, undo, resetHistory } from '../src/engine/history';
import { packProject, projectAnims } from '../src/engine/project';
import { makeClip, useStore } from '../src/store';
import { placeAnim, setAnimSlot } from '../src/engine/animPlace';
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
