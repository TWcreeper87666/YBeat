import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { detectNotes, hzToMidi } from '../src/engine/pitchNotes';

test('切出有聲段與直接跳音', () => {
  const sr = 1000, hop = 5;
  const f0 = new Float32Array(200);
  f0.fill(150, 0, 60);
  f0.fill(200, 80, 140);
  f0.fill(300, 140, 200);
  const notes = detectNotes(f0, hop, sr);
  assert.equal(notes.length, 3);
  for (const [i, a, b, hz] of [[0, 0, 0.3, 150], [1, 0.4, 0.7, 200], [2, 0.7, 1, 300]]) {
    assert.ok(Math.abs(notes[i].a - a) < 0.03);
    assert.ok(Math.abs(notes[i].b - b) < 0.03);
    assert.ok(Math.abs(notes[i].midi - hzToMidi(hz)) < 0.3);
  }
  assert.equal(detectNotes(new Float32Array(200), hop, sr).length, 0);
});
