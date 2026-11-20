(globalThis as any).localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
console.warn = () => {};
import { strict as assert } from 'node:assert';
import { applyMediaBatch, planMediaBatch } from '../src/engine/mediaBatch';
import { useStore } from '../src/store';

const image = (id: string) => ({ id, name: id, kind: 'image' as const, url: 'blob:test', width: 10, height: 10, duration: 3600, thumb: '', hasAudio: false });
const audio = { id: 'music', name: 'music', kind: 'audio' as const, url: 'blob:test', width: 0, height: 0, duration: 3, thumb: '', hasAudio: true };
useStore.setState({ media: [image('one'), image('two'), audio], clips: [], audios: [], effects: [], tracks: { video: [{}], audio: [{}], fx: [] }, time: 1, selection: null, selected: [] });
const plan = planMediaBatch(['one', 'two', 'music'], 1, { kind: 'video', track: 0 })!;
assert.deepEqual(plan.map((p) => [p.kind, p.start, p.duration]), [['video', 1, 2], ['video', 3, 2], ['audio', 5, 3]]);
assert.equal(applyMediaBatch(plan), 3);
assert.deepEqual(useStore.getState().selected.length, 3);
assert.deepEqual(useStore.getState().clips.map((c) => c.start), [1, 3]);
assert.equal(useStore.getState().audios[0].start, 5);
useStore.setState({ tracks: { video: [{ locked: true }], audio: [{}], fx: [] } });
assert.equal(planMediaBatch(['one'], 0, { kind: 'video', track: 0 }), null);
console.log('PASS batch media ghost plan matches inserted clips and selection');
