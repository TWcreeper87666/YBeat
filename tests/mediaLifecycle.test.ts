(globalThis as any).localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
(globalThis as any).window = globalThis;
console.warn = () => {};
import { strict as assert } from 'node:assert';
import { makeClip, useStore } from '../src/store';
import { removeMediaEverywhere } from '../src/engine/media';
import { resetHistory, undo } from '../src/engine/history';
import { attachedAudioIds } from '../src/store';

const a = { id: 'a', name: 'a', kind: 'image' as const, url: 'blob:a', width: 10, height: 10, duration: 3600, thumb: 'blob:a', hasAudio: false };
const b = { ...a, id: 'b', name: 'b', url: 'blob:b', thumb: 'blob:b' };
const ca = makeClip({ id: 'ca', mediaId: 'a', start: 0, duration: 2 });
const cb = makeClip({ id: 'cb', mediaId: 'b', start: 3, duration: 2 });
useStore.setState({ media: [a, b], clips: [ca, cb], audios: [], effects: [], tracks: { video: [{}], fx: [], audio: [{}] } });
useStore.setState({ clips: [cb] });
assert.deepEqual(useStore.getState().media.map((m) => m.id), ['a', 'b']);
useStore.setState({ clips: [ca, cb] });
assert.deepEqual(useStore.getState().media.map((m) => m.id), ['a', 'b']);
resetHistory();
assert.equal(removeMediaEverywhere(['a']), true);
assert.deepEqual(useStore.getState().clips.map((c) => c.id), ['cb']);
assert.deepEqual(useStore.getState().media.map((m) => m.id), ['b']);
undo();
assert.deepEqual(useStore.getState().media.map((m) => m.id), ['a', 'b']);
useStore.setState({ tracks: { video: [{ locked: true }], fx: [], audio: [{}] } });
assert.equal(removeMediaEverywhere(['a']), false);
assert.equal(useStore.getState().clips.length, 2);
const missing = { ...a, id: 'missing', missing: true, url: '' };
const cm = makeClip({ id: 'cm', mediaId: missing.id, start: 5, duration: 2 });
useStore.setState({ media: [missing, b], clips: [cm], audios: [], effects: [], tracks: { video: [{}], fx: [], audio: [{}] } });
resetHistory();
useStore.setState({ clips: [] });
assert.deepEqual(useStore.getState().media.map((m) => m.id), ['b']);
undo();
assert.deepEqual(useStore.getState().media.map((m) => m.id), ['missing', 'b']);
{
  const video = { id: 'video', name: 'video', kind: 'video' as const, url: 'blob:video', width: 10, height: 10, duration: 10, thumb: '', hasAudio: true };
  const clip = { ...makeClip({ id: 'sound-clip', mediaId: video.id, start: 0, duration: 2 }), link: 'pair' };
  const audio = { id: 'sound-track', mediaId: video.id, track: 0, start: 0, duration: 2, in: 0, volume: 1, fadeIn: 0, fadeOut: 0, link: 'pair' };
  useStore.setState({
    media: [video], clips: [clip], audios: [audio], effects: [],
    tracks: { video: [{}], fx: [], audio: [{}] },
    selection: { type: 'audio', id: audio.id }, selected: [`audio:${audio.id}`],
  });
  resetHistory();
  assert.equal(useStore.getState().removeClipAudio(clip.id), true);
  assert.equal(useStore.getState().clips[0].volume, 0);
  assert.equal(useStore.getState().clips[0].audioSplit, true);
  assert.equal(useStore.getState().audios.length, 0);
  assert.equal(useStore.getState().selection?.id, clip.id);
  undo();
  assert.equal(useStore.getState().audios.length, 1);
  assert.equal(useStore.getState().clips[0].volume, 1);
  useStore.setState({ tracks: { video: [{ locked: true }], fx: [], audio: [{}] } });
  assert.equal(useStore.getState().removeClipAudio(clip.id), false);
  assert.equal(useStore.getState().audios.length, 1);
  useStore.setState({
    clips: [{ ...clip, id: 'other-clip', link: 'shared' }, { ...clip, link: 'shared' }],
    audios: [{ ...audio, link: 'shared' }],
    tracks: { video: [{}, {}], fx: [], audio: [{}] },
  });
  assert.equal(useStore.getState().removeClipAudio(clip.id), true);
  assert.equal(useStore.getState().audios.length, 1);
  assert.equal(useStore.getState().clips.find((c) => c.id === 'other-clip')?.link, 'shared');
  assert.equal(attachedAudioIds(useStore.getState()).has(audio.id), true);
}
console.log('PASS media follows timeline references and restores on undo');
