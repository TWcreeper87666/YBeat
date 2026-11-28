import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import * as ort from 'onnxruntime-web';
ort.env.wasm.numThreads = 1;
import { speechSegments, speechWindows, vadProbabilities } from '../src/engine/vad';
import { toTraditional } from '../src/engine/zhConvert';
import { bytesToUnicode, decodeWhisper, detectLanguage, nextWhisperToken, whisperCues, whisperFeatures, zhPunctuation, type GenerationConfig } from '../src/engine/whisper';

const fixture = 'tests/fixtures/whisper/';
const floats = (path: string) => { const b = readFileSync(path); return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
const wav = readFileSync(fixture + 'speech.wav');
assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
let offset = 12, samples = new Float32Array();
while (offset + 8 <= wav.length) {
  const kind = wav.toString('ascii', offset, offset + 4), size = wav.readUInt32LE(offset + 4), at = offset + 8;
  if (kind === 'fmt ') { assert.equal(wav.readUInt16LE(at), 1); assert.equal(wav.readUInt16LE(at + 2), 1); assert.equal(wav.readUInt32LE(at + 4), 16000); assert.equal(wav.readUInt16LE(at + 14), 16); }
  if (kind === 'data') samples = Float32Array.from({ length: size / 2 }, (_, i) => wav.readInt16LE(at + i * 2) / 32768);
  offset = at + size + (size & 1);
}
assert.ok(samples.length > 16000);
const features = whisperFeatures(samples), reference = floats(fixture + 'feat80x1000.f32');
let max = 0;
for (let m = 0; m < 80; m++) for (let f = 0; f < 1000; f++) max = Math.max(max, Math.abs(features[m * 3000 + f] - reference[m * 1000 + f]));
assert.ok(max < 2e-3, `features max diff ${max}`);
assert.deepEqual(speechWindows([{ start: 0, end: 3 }, { start: 4, end: 8 }, { start: 30, end: 61 }]), [{ start: 0, end: 8 }, { start: 30, end: 58 }, { start: 58, end: 61 }]);
const synthetic = new Float32Array(100);
synthetic.fill(0.9, 10, 45); synthetic.fill(0.9, 60, 90);
assert.equal(speechSegments(synthetic).length, 2);
const chars = bytesToUnicode(), chinese = '中文', bytes = new TextEncoder().encode(chinese);
const fake = { [Array.from(bytes, (b) => chars[b]).join('')]: 17 };
assert.equal(decodeWhisper([17], fake), chinese);
assert.equal(zhPunctuation('今天, 我們?OK, fine'), '今天，我們？OK, fine');

void (async () => {
  assert.equal(await toTraditional('这个软件可以剪辑视频'), '這個軟體可以剪輯影片');
  const vadPath = 'node_modules/.cache/models/silero_vad.onnx';
  if (existsSync(vadPath)) {
    const session = await ort.InferenceSession.create(new Uint8Array(readFileSync(vadPath)));
    const probs = await vadProbabilities(samples, async (input, state) => {
      const r = await session.run({ input: new ort.Tensor('float32', input, [1, 576]), state: new ort.Tensor('float32', state, [2, 1, 128]), sr: new ort.Tensor('int64', BigInt64Array.of(16000n), []) });
      const result = { probability: (r.output.data as Float32Array)[0], state: Float32Array.from(r.stateN.data as Float32Array) };
      for (const t of Object.values(r)) t.dispose();
      return result;
    });
    const expected = floats(fixture + 'vad_probs.f32');
    assert.equal(probs.length, expected.length);
    let diff = 0; for (let i = 0; i < probs.length; i++) diff = Math.max(diff, Math.abs(probs[i] - expected[i]));
    assert.ok(diff < 1e-3, `VAD max diff ${diff}`);
    const spans = speechSegments(probs, samples.length);
    assert.equal(spans.length, 2); assert.ok(spans[0].start < 0.3 && spans[0].end > 3 && spans[1].start > 3.5 && spans[1].end > 8);
    await session.release();
  } else console.log('SKIP Silero model fixture missing');
  const root = 'node_modules/.cache/models/whisper-tiny/';
  const paths = ['onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx', 'vocab.json', 'generation_config.json'].map((p) => root + p);
  if (paths.every(existsSync)) {
    const enc = await ort.InferenceSession.create(new Uint8Array(readFileSync(paths[0]))), dec = await ort.InferenceSession.create(new Uint8Array(readFileSync(paths[1])));
    const vocab = JSON.parse(readFileSync(paths[2], 'utf8')) as Record<string, number>;
    const config = JSON.parse(readFileSync(paths[3], 'utf8')) as GenerationConfig;
    const ref = JSON.parse(readFileSync(fixture + 'ref.json', 'utf8')) as { prompt: number[]; tokens: number[]; text: string };
    const encoded = await enc.run({ input_features: new ort.Tensor('float32', features, [1, 80, 3000]) });
    const hidden = encoded.last_hidden_state;
    const run = async (ids: number[], cache: boolean, past: Record<string, ort.Tensor>) => {
      const feeds: Record<string, ort.Tensor> = { input_ids: new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]), encoder_hidden_states: hidden, use_cache_branch: new ort.Tensor('bool', Uint8Array.of(cache ? 1 : 0), [1]) };
      for (let i = 0; i < 4; i++) for (const side of ['decoder', 'encoder']) for (const kv of ['key', 'value']) {
        const name = `past_key_values.${i}.${side}.${kv}`;
        feeds[name] = cache ? past[name] : new ort.Tensor('float32', new Float32Array(0), [1, 6, 0, 64]);
      }
      const r = await dec.run(feeds), values = r.logits.data as Float32Array;
      return { logits: values.slice(values.length - 51865), present: r };
    };
    let result = await run(ref.prompt, false, {}), first = result.present;
    const past: Record<string, ort.Tensor> = {};
    for (let i = 0; i < 4; i++) for (const side of ['encoder', 'decoder']) for (const kv of ['key', 'value']) past[`past_key_values.${i}.${side}.${kv}`] = first[`present.${i}.${side}.${kv}`];
    const tokens: number[] = [];
    while (tokens.length + ref.prompt.length < 448) {
      const t = nextWhisperToken(result.logits, tokens, config); tokens.push(t);
      if (t === 50257) break;
      result = await run([t], true, past);
      for (let i = 0; i < 4; i++) for (const kv of ['key', 'value']) past[`past_key_values.${i}.decoder.${kv}`] = result.present[`present.${i}.decoder.${kv}`];
    }
    const auto = await run([50258], false, {});
    assert.equal(detectLanguage(auto.logits, config), 50259);
    assert.equal(decodeWhisper(ref.tokens, vocab), ref.text);
    assert.deepEqual(whisperCues(ref.tokens, vocab, 8.7).map((c) => [c.start, c.end, c.text]), [[0, 4, 'The quick brown fox jumps over the lazy dog.'], [4, 8, 'Today we are testing automatic subtitles in the browser.']]);
    // int8 模型在不同 runtime 的數值差 ~0.3 logit（Python 關掉圖最佳化就會變），比較接近的字可能翻：
    // 前面完全一樣、時間戳一樣、整段文字差不多就好
    assert.deepEqual(tokens.slice(0, 17), ref.tokens.slice(0, 17), `greedy tokens: ${JSON.stringify(tokens)}`);
    assert.deepEqual(tokens.filter((t) => t >= 50364), ref.tokens.filter((t) => t >= 50364), 'timestamps');
    const words = (s: string) => s.toLowerCase().replace(/[^a-z ]/g, '').split(/\s+/).filter(Boolean);
    const got = words(decodeWhisper(tokens, vocab)), want = words(ref.text);
    const same = want.filter((w) => got.includes(w)).length;
    assert.ok(same >= want.length - 2, `text: ${decodeWhisper(tokens, vocab)}`);
    hidden.dispose(); await enc.release(); await dec.release();
  } else console.log('SKIP Whisper model fixture missing');
  console.log('PASS speech features, VAD, Whisper, pure helpers');
})().catch((e) => { console.error(e); process.exit(1); });
