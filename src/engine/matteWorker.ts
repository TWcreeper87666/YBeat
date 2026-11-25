/**
 * U²-Netp 去背推論（跑在 Web Worker，不卡畫面）。
 * 輸入：320×320 RGBA；輸出：320×320 的 0–255 遮罩（白 = 主體）。
 * 前處理與 rembg 相同：除以最大值 → ImageNet mean / std → NCHW。
 */
import * as ort from 'onnxruntime-web/webgpu';
import wasmUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm?url';

ort.env.wasm.wasmPaths = { wasm: wasmUrl };
// 模型的無害警告（例如 initializer 出現在 graph inputs）不要印到 console
ort.env.logLevel = 'error';
// 沒有 cross-origin isolation 就不能用多執行緒（SharedArrayBuffer）
if (!self.crossOriginIsolated) ort.env.wasm.numThreads = 1;

export const MATTE_SIZE = 320;
const S = MATTE_SIZE;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

/**
 * 一律用 WASM：U²-Netp 的 MaxPool 用了 ceil_mode，onnxruntime 的 WebGPU 後端還不支援（建立 session 不會報錯，執行才失敗）。
 */
let session: Promise<ort.InferenceSession> | null = null;

function getSession(modelUrl: string) {
  session ??= (async () => {
    const r = await fetch(modelUrl);
    if (!r.ok) throw new Error(`model HTTP ${r.status}`);
    return ort.InferenceSession.create(new Uint8Array(await r.arrayBuffer()), { executionProviders: ['wasm'], logSeverityLevel: 3 });
  })();
  session.catch(() => (session = null));
  return session;
}

async function run(modelUrl: string, input: Float32Array) {
  const s = await getSession(modelUrl);
  const out = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, S, S]) });
  const d = (await out[s.outputNames[0]].getData()) as Float32Array;
  for (const t of Object.values(out)) t.dispose?.();
  return { d, ep: 'wasm' };
}

export interface MatteReq { id: number; rgba: Uint8ClampedArray; modelUrl: string }
export type MatteRes = { id: number; mask: Uint8Array; ep: string } | { id: number; error: string };

self.onmessage = async (e: MessageEvent<MatteReq>) => {
  const { id, rgba, modelUrl } = e.data;
  try {
    const n = S * S;
    let mx = 0;
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      if (rgba[o] > mx) mx = rgba[o];
      if (rgba[o + 1] > mx) mx = rgba[o + 1];
      if (rgba[o + 2] > mx) mx = rgba[o + 2];
    }
    mx = mx || 1;
    const input = new Float32Array(3 * n);
    for (let c = 0; c < 3; c++) {
      const m = MEAN[c], sd = STD[c], base = c * n;
      for (let i = 0; i < n; i++) input[base + i] = (rgba[i * 4 + c] / mx - m) / sd;
    }
    const { d, ep } = await run(modelUrl, input);
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < n; i++) {
      if (d[i] < lo) lo = d[i];
      if (d[i] > hi) hi = d[i];
    }
    const k = hi - lo > 1e-6 ? 255 / (hi - lo) : 0;
    const mask = new Uint8Array(n);
    for (let i = 0; i < n; i++) mask[i] = Math.round((d[i] - lo) * k);
    (self as unknown as Worker).postMessage({ id, mask, ep } satisfies MatteRes, [mask.buffer]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String((err as Error)?.message ?? err) } satisfies MatteRes);
  }
};
