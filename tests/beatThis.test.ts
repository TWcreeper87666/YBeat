import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as ort from 'onnxruntime-web';
import { CHUNK, MELS, aggregatePredictions, logMel, postprocess, splitSpect } from '../src/engine/beatThis';

const sr = 22050, wav = new Float32Array(sr * 6);
for (let i = 0; i < wav.length; i++) wav[i] = 0.02 * Math.sin(i * 0.0123) * Math.sin(i * 0.731);
for (let k = 0; k < 12; k++) {
  const start = Math.floor((0.25 + 0.5 * k) * sr), amp = k % 4 === 0 ? 0.9 : 0.5;
  for (let j = 0; j < 2000; j++) wav[start + j] += amp * Math.sin(2 * Math.PI * (60 + 100 * Math.exp(-j / 300)) * j / sr) * Math.exp(-j / 600);
}
const asFloat = (path: string) => { const b = readFileSync(path); return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
const f32 = (name: string) => asFloat(`tests/fixtures/beatThis/${name}`);
const maxDiff = (a: ArrayLike<number>, b: ArrayLike<number>) => { assert.equal(a.length, b.length); let max = 0; for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs(a[i] - b[i])); return max; };
const mel = logMel(wav, asFloat('public/models/beat_this_mel.bin'));
assert.ok(maxDiff(mel, f32('mel.f32')) < 1e-3, 'log-mel 與參考一致');
const refBeat = f32('beat.f32'), refDown = f32('down.f32');
const ref = JSON.parse(readFileSync('tests/fixtures/beatThis/ref.json', 'utf8')) as { beats: number[]; downbeats: number[] };
const actual = postprocess(refBeat, refDown);
assert.ok(maxDiff(actual.beats, ref.beats) < 1e-6);
assert.ok(maxDiff(actual.downbeats, ref.downbeats) < 1e-6);
const chunks = splitSpect(new Float32Array(4000 * MELS));
const stitched = aggregatePredictions(4000, chunks.map((c, i) => ({ start: c.start, values: new Float32Array(CHUNK).fill(i + 1) })));
assert.ok([...stitched].every((x) => x > 0), '所有影格都有覆蓋');
assert.equal(stitched[2700], 2, '較早的區塊優先');
void (async () => {
  const s = await ort.InferenceSession.create(new Uint8Array(readFileSync('public/models/beat_this_small0.onnx')));
  const input = new Float32Array(CHUNK * MELS); input.set(mel);
  const r = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', input, [1, CHUNK, MELS]) });
  assert.ok(maxDiff((r.beat.data as Float32Array).subarray(0, 301), refBeat) < 1e-3, 'beat logits');
  assert.ok(maxDiff((r.downbeat.data as Float32Array).subarray(0, 301), refDown) < 1e-3, 'downbeat logits');
  console.log('PASS Beat This! 前後處理與模型');
})().catch((e) => { console.error(e); process.exit(1); });
