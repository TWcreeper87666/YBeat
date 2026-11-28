import * as ort from 'onnxruntime-web/webgpu';
import wasmUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm?url';
import { speechSegments, vadProbabilities } from './vad';
import { toTraditional } from './zhConvert';
import { detectLanguage, nextWhisperToken, whisperCues, whisperFeatures, zhPunctuation, type GenerationConfig } from './whisper';

ort.env.wasm.wasmPaths = { wasm: wasmUrl };
ort.env.logLevel = 'error';
if (!self.crossOriginIsolated) ort.env.wasm.numThreads = 1;
export type SpeechReq = { id: number; kind: 'vad'; wav: Float32Array; model: ArrayBuffer } | { id: number; kind: 'whisper'; wav: Float32Array; encoder: ArrayBuffer; decoder: ArrayBuffer; vocab: ArrayBuffer; config: ArrayBuffer; language: string };
export type SpeechRes = { id: number; kind: 'progress'; done: number; total: number } | { id: number; kind: 'vad'; spans: { start: number; end: number }[] } | { id: number; kind: 'whisper'; cues: { start: number; end: number; text: string }[] } | { id: number; kind: 'error'; error: string };
const post = (r: SpeechRes) => (self as unknown as Worker).postMessage(r);
const makeSession = (bytes: ArrayBuffer) => ort.InferenceSession.create(new Uint8Array(bytes), { executionProviders: ['wasm'], logSeverityLevel: 3 });
const emptyPast = () => new ort.Tensor('float32', new Float32Array(0), [1, 6, 0, 64]);

// 同一個工作的每一段共用（worker 由主執行緒在工作結束時關掉）
let whisper: Promise<[ort.InferenceSession, ort.InferenceSession]> | null = null;
let vad: Promise<ort.InferenceSession> | null = null;

async function transcribe(req: Extract<SpeechReq, { kind: 'whisper' }>) {
  whisper ??= Promise.all([makeSession(req.encoder), makeSession(req.decoder)]);
  const [encoder, decoder] = await whisper;
  const vocab = JSON.parse(new TextDecoder().decode(req.vocab)) as Record<string, number>;
  const config = JSON.parse(new TextDecoder().decode(req.config)) as GenerationConfig;
  const features = new ort.Tensor('float32', whisperFeatures(req.wav), [1, 80, 3000]);
  const encoded = await encoder.run({ input_features: features });
  features.dispose();
  const hidden = encoded.last_hidden_state;
  let firstEncoderPast: Record<string, ort.Tensor> = {}, decoderPast: Record<string, ort.Tensor> = {};
  const step = async (ids: number[], cache: boolean) => {
    const feeds: Record<string, ort.Tensor> = {
      input_ids: new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]),
      encoder_hidden_states: hidden,
      use_cache_branch: new ort.Tensor('bool', Uint8Array.of(cache ? 1 : 0), [1]),
    };
    for (let i = 0; i < 4; i++) for (const side of ['decoder', 'encoder']) for (const kv of ['key', 'value']) {
      const name = `past_key_values.${i}.${side}.${kv}`;
      feeds[name] = cache ? (side === 'encoder' ? firstEncoderPast[name] : decoderPast[name]) : emptyPast();
    }
    const result = await decoder.run(feeds);
    const logits = result.logits.data as Float32Array;
    const last = logits.slice(logits.length - 51865);
    feeds.input_ids.dispose(); feeds.use_cache_branch.dispose();
    if (!cache) for (const name of decoder.inputNames.filter((n) => n.startsWith('past_key_values.'))) feeds[name].dispose();
    for (const value of Object.values(decoderPast)) value.dispose();
    decoderPast = {};
    if (!cache) { for (const value of Object.values(firstEncoderPast)) value.dispose(); firstEncoderPast = {}; }
    for (let i = 0; i < 4; i++) for (const kv of ['key', 'value']) {
      const suffix = `${i}.decoder.${kv}`;
      decoderPast[`past_key_values.${suffix}`] = result[`present.${suffix}`];
      if (!cache) {
        const encSuffix = `${i}.encoder.${kv}`;
        firstEncoderPast[`past_key_values.${encSuffix}`] = result[`present.${encSuffix}`];
      } else result[`present.${i}.encoder.${kv}`].dispose();
    }
    result.logits.dispose();
    return last;
  };
  try {
    let language = req.language === 'auto' ? detectLanguage(await step([50258], false), config) : config.lang_to_id[`<|${req.language}|>`];
    if (language === undefined) language = config.lang_to_id['<|en|>'];
    const zh = language === config.lang_to_id['<|zh|>'];
    const prompt = [50258, language, 50359];
    let logits = await step(prompt, false);
    const tokens: number[] = [];
    while (tokens.length + prompt.length < 448) {
      const token = nextWhisperToken(logits, tokens, config);
      tokens.push(token);
      if (token === 50257) break;
      post({ id: req.id, kind: 'progress', done: tokens.length, total: 448 });
      logits = await step([token], true);
    }
    const cues = whisperCues(tokens, vocab, req.wav.length / 16000);
    post({ id: req.id, kind: 'whisper', cues: zh ? await Promise.all(cues.map(async (c) => ({ ...c, text: zhPunctuation(await toTraditional(c.text)) }))) : cues });
  } finally {
    hidden.dispose();
    for (const value of Object.values(decoderPast)) value.dispose();
    for (const value of Object.values(firstEncoderPast)) value.dispose();
  }
}

self.onmessage = async (event: MessageEvent<SpeechReq>) => {
  const req = event.data;
  try {
    if (req.kind === 'whisper') return await transcribe(req);
    vad ??= makeSession(req.model);
    const session = await vad;
    {
      const probs = await vadProbabilities(req.wav, async (input, state) => {
        const feeds = { input: new ort.Tensor('float32', input, [1, 576]), state: new ort.Tensor('float32', state, [2, 1, 128]), sr: new ort.Tensor('int64', BigInt64Array.of(16000n), []) };
        const result = await session.run(feeds);
        const probability = (result.output.data as Float32Array)[0], next = Float32Array.from(result.stateN.data as Float32Array);
        for (const t of Object.values(feeds)) t.dispose();
        for (const t of Object.values(result)) t.dispose();
        return { probability, state: next };
      }, (done, total) => { if (done % 20 === 0 || done === total) post({ id: req.id, kind: 'progress', done, total }); });
      post({ id: req.id, kind: 'vad', spans: speechSegments(probs, req.wav.length) });
    }
  } catch (error) { post({ id: req.id, kind: 'error', error: String((error as Error).message ?? error) }); }
};
