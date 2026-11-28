/** Beat This! small0 推論；模型與 mel filter 由主執行緒驗證後傳入。 */
import * as ort from 'onnxruntime-web/webgpu';
import wasmUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm?url';
import { CHUNK, MELS, aggregatePredictions, logMel, postprocess, splitSpect } from './beatThis';

ort.env.wasm.wasmPaths = { wasm: wasmUrl };
ort.env.logLevel = 'error';
if (!self.crossOriginIsolated) ort.env.wasm.numThreads = 1;
let session: Promise<ort.InferenceSession> | null = null;
let filter: Float32Array | null = null;
export type BeatReq = { id: number; wav: Float32Array; model?: ArrayBuffer; mel?: ArrayBuffer };
export type BeatRes = { id: number; beats: number[]; downbeats: number[] } | { id: number; error: string } | { id: number; done: number; total: number };
self.onmessage = async (event: MessageEvent<BeatReq>) => {
  const { id, wav, model, mel } = event.data;
  const post = (res: BeatRes) => (self as unknown as Worker).postMessage(res);
  try {
    if (mel) filter = new Float32Array(mel);
    if (model) session = ort.InferenceSession.create(new Uint8Array(model), { executionProviders: ['wasm'], logSeverityLevel: 3 });
    if (!session || !filter) throw new Error('model bytes missing');
    const spect = logMel(wav, filter);
    const chunks = splitSpect(spect);
    const beat: { start: number; values: Float32Array }[] = [], down: { start: number; values: Float32Array }[] = [];
    const s = await session;
    for (const [i, chunk] of chunks.entries()) {
      const r = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', chunk.data, [1, CHUNK, MELS]) });
      beat.push({ start: chunk.start, values: Float32Array.from((await r.beat.getData()) as Float32Array) });
      down.push({ start: chunk.start, values: Float32Array.from((await r.downbeat.getData()) as Float32Array) });
      for (const t of Object.values(r)) t.dispose?.();
      post({ id, done: i + 1, total: chunks.length });
    }
    post({ id, ...postprocess(aggregatePredictions(spect.length / MELS, beat), aggregatePredictions(spect.length / MELS, down)) });
  } catch (err) { post({ id, error: String((err as Error)?.message ?? err) }); }
};
