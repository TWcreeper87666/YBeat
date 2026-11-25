/**
 * YuNet 臉部偵測（跑在 Web Worker）。
 * 輸入：inW × inH 的 RGBA（素材畫在左上角 imgW × imgH，其他是黑的）；輸出：偵測到的臉（素材畫面 0..1）。
 * 前處理跟 OpenCV FaceDetectorYN 一樣：BGR、0..255、不減平均、NCHW。
 */
import * as ort from 'onnxruntime-web/webgpu';
import wasmUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm?url';
import { decodeYunet, type Face } from './faceTrack';

ort.env.wasm.wasmPaths = { wasm: wasmUrl };
// 模型的無害警告（例如 initializer 出現在 graph inputs）不要印到 console
ort.env.logLevel = 'error';
if (!self.crossOriginIsolated) ort.env.wasm.numThreads = 1;

const sessions = new Map<string, Promise<ort.InferenceSession>>();
function getSession(modelUrl: string) {
  let p = sessions.get(modelUrl);
  if (!p) {
    p = (async () => {
      const r = await fetch(modelUrl);
      if (!r.ok) throw new Error(`model HTTP ${r.status}`);
      return ort.InferenceSession.create(new Uint8Array(await r.arrayBuffer()), { executionProviders: ['wasm'], logSeverityLevel: 3 });
    })();
    sessions.set(modelUrl, p);
    p.catch(() => sessions.delete(modelUrl));
  }
  return p;
}

/**
 * 偵測（YuNet）；或 embed = 臉的特徵（SFace：rgba 是對齊好的 112 × 112 臉，RGB、0..255、NCHW → 128 維）。
 */
export type FaceReq = { id: number; rgba: Uint8ClampedArray; inW: number; inH: number; imgW: number; imgH: number; modelUrl: string; embed?: false }
  | { id: number; rgba: Uint8ClampedArray; modelUrl: string; embed: true };
export type FaceRes = { id: number; faces: Face[] } | { id: number; emb: number[] } | { id: number; error: string };

self.onmessage = async (e: MessageEvent<FaceReq>) => {
  const req = e.data;
  if (req.embed) {
    try {
      const s = await getSession(req.modelUrl);
      const n = 112 * 112, input = new Float32Array(3 * n);
      for (let i = 0; i < n; i++) {
        input[i] = req.rgba[i * 4];
        input[n + i] = req.rgba[i * 4 + 1];
        input[2 * n + i] = req.rgba[i * 4 + 2];
      }
      const res = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, 112, 112]) });
      const emb = Array.from((await res[s.outputNames[0]].getData()) as Float32Array);
      for (const t of Object.values(res)) t.dispose?.();
      (self as unknown as Worker).postMessage({ id: req.id, emb } satisfies FaceRes);
    } catch (err) {
      (self as unknown as Worker).postMessage({ id: req.id, error: String((err as Error)?.message ?? err) } satisfies FaceRes);
    }
    return;
  }
  const { id, rgba, inW, inH, imgW, imgH, modelUrl } = req;
  try {
    const s = await getSession(modelUrl);
    const n = inW * inH;
    const input = new Float32Array(3 * n);
    for (let i = 0; i < n; i++) {
      input[i] = rgba[i * 4 + 2]; // B
      input[n + i] = rgba[i * 4 + 1]; // G
      input[2 * n + i] = rgba[i * 4]; // R
    }
    const res = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, inH, inW]) });
    const out: Record<string, Float32Array> = {};
    for (const name of s.outputNames) out[name] = (await res[name].getData()) as Float32Array;
    for (const t of Object.values(res)) t.dispose?.();
    const faces = decodeYunet(out, inW, inH, imgW, imgH);
    (self as unknown as Worker).postMessage({ id, faces } satisfies FaceRes);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String((err as Error)?.message ?? err) } satisfies FaceRes);
  }
};
