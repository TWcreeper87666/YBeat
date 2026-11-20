(globalThis as any).localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
console.warn = () => {};
import { makeClip, useStore } from '../src/store';
import { strict as assert } from 'node:assert';

const a = makeClip({ id: 'locked', mediaId: '', track: 0, start: 0, duration: 2 });
const b = makeClip({ id: 'free', mediaId: '', track: 1, start: 3, duration: 2 });
useStore.setState({ clips: [a, b], effects: [], audios: [], tracks: { video: [{ locked: true }, {}], fx: [], audio: [] }, selected: ['clip:locked'], selection: { type: 'clip', id: 'locked' }, clipboard: null });
useStore.getState().patchItems({ 'clip:locked': { start: 4 }, 'clip:free': { track: 0 } });
assert.equal(useStore.getState().clips[0].start, 0);
assert.equal(useStore.getState().clips[1].track, 1);
useStore.getState().removeSelection('all');
assert.equal(useStore.getState().clips.length, 2);
useStore.setState({ selected: ['clip:free'], selection: { type: 'clip', id: 'free' } });
useStore.getState().removeSelection('all');
assert.equal(useStore.getState().clips.length, 1);
assert.equal(useStore.getState().clips[0].id, 'locked');
console.log('PASS locked track blocks edits, moves, and ripple deletion');
