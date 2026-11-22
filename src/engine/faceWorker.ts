/**
 * YuNet 臉部偵測（跑在 Web Worker）。
 * 輸入：inW × inH 的 RGBA（素材畫在左上角 imgW × imgH，其他是黑的）；輸出：偵測到的臉（素材畫面 0..1）。
 * 前處理跟 OpenCV FaceDetectorYN 一樣：BGR、0..255、不減平均、NCHW。
 */
import * as ort from 'onnxruntime-web/webgpu';
import wasmUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm?url';
import { decodeYunet, type Face } from './faceTrack';

ort.env.wasm.wasmPaths = { wasm: wasmUrl };
if (!self.crossOriginIsolated) ort.env.wasm.numThreads = 1;

let session: Promise<ort.InferenceSession> | null = null;
function getSession(modelUrl: string) {
  session ??= (async () => {
    const r = await fetch(modelUrl);
    if (!r.ok) throw new Error(`model HTTP ${r.status}`);
    return ort.InferenceSession.create(new Uint8Array(await r.arrayBuffer()), { executionProviders: ['wasm'] });
  })();
  session.catch(() => (session = null));
  return session;
}

export interface FaceReq { id: number; rgba: Uint8ClampedArray; inW: number; inH: number; imgW: number; imgH: number; modelUrl: string }
export type FaceRes = { id: number; faces: Face[] } | { id: number; error: string };

self.onmessage = async (e: MessageEvent<FaceReq>) => {
  const { id, rgba, inW, inH, imgW, imgH, modelUrl } = e.data;
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
