/**
 * VitTrack 自訂目標追蹤（跑在 Web Worker）。前 / 後處理在 vitTrack.ts。
 * init：用這一格與框做模板（依 tid 記住）；update：在上一格的框附近找 → 新的框與分數。
 */
import * as ort from 'onnxruntime-web/webgpu';
import wasmUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm?url';
import { SEARCH, TEMPLATE, cropBlob, decodeVit, type PxBox } from './vitTrack';

ort.env.wasm.wasmPaths = { wasm: wasmUrl };
// 模型的無害警告（例如 initializer 出現在 graph inputs）不要印到 console
ort.env.logLevel = 'error';
if (!self.crossOriginIsolated) ort.env.wasm.numThreads = 1;

let session: Promise<ort.InferenceSession> | null = null;
function getSession(modelBytes?: ArrayBuffer) {
  session ??= (async () => {
    if (!modelBytes) throw new Error('model bytes missing');
    return ort.InferenceSession.create(new Uint8Array(modelBytes), { executionProviders: ['wasm'], logSeverityLevel: 3 });
  })();
  session.catch(() => (session = null));
  return session;
}

/** tid → 模板（只留最近一個：追蹤一次只跑一段） */
const templates = new Map<string, ort.Tensor>();

export type TrackReq =
  | { id: number; op: 'init'; tid: string; rgba: Uint8ClampedArray; w: number; h: number; box: PxBox; modelBytes?: ArrayBuffer }
  | { id: number; op: 'update'; tid: string; rgba: Uint8ClampedArray; w: number; h: number; box: PxBox; modelBytes?: ArrayBuffer };
export type TrackRes = { id: number; box?: PxBox; score?: number } | { id: number; error: string };

self.onmessage = async (e: MessageEvent<TrackReq>) => {
  const q = e.data;
  const post = (r: TrackRes) => (self as unknown as Worker).postMessage(r);
  try {
    const s = await getSession(q.modelBytes);
    if (q.op === 'init') {
      templates.clear();
      const { blob } = cropBlob(q.rgba, q.w, q.h, q.box, 2, TEMPLATE);
      templates.set(q.tid, new ort.Tensor('float32', blob, [1, 3, TEMPLATE, TEMPLATE]));
      return post({ id: q.id });
    }
    const tpl = templates.get(q.tid);
    if (!tpl) throw new Error('tracker not initialised');
    const { blob, size } = cropBlob(q.rgba, q.w, q.h, q.box, 4, SEARCH);
    const res = await s.run({ template: tpl, search: new ort.Tensor('float32', blob, [1, 3, SEARCH, SEARCH]) });
    const [conf, sz, off] = await Promise.all(['output1', 'output2', 'output3'].map(async (k) => (await res[k].getData()) as Float32Array));
    for (const t of Object.values(res)) t.dispose?.();
    post({ id: q.id, ...decodeVit(conf, sz, off, q.box, size, q.w, q.h) });
  } catch (err) {
    post({ id: q.id, error: String((err as Error)?.message ?? err) });
  }
};
