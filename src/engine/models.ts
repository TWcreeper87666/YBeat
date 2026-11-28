import { create } from 'zustand';
import { $t } from '../i18n';
import { confirmDialog } from '../ui/uiStore';
import { formatBytes } from './storageUsage';

export interface ModelFile { url: string; bytes: number; sha256: string }
export interface ModelDef {
  id: string; name: string; feature: string; files: ModelFile[]; license: string;
  /** IndexedDB 資料庫名稱：刪除模型時可以一起清掉的分析結果 */
  caches?: string[];
  silent?: boolean;
}

const base = import.meta.env.BASE_URL;
const file = (name: string, bytes: number, sha256: string): ModelFile => ({ url: `${base}models/${name}`, bytes, sha256 });
const hf = (repo: string, commit: string, path: string, bytes: number, sha256: string): ModelFile => ({ url: `https://huggingface.co/${repo}/resolve/${commit}/${path}`, bytes, sha256 });
export const MODELS: ModelDef[] = [
  { id: 'yunet', name: 'YuNet', feature: '臉部追蹤', files: [file('face_detection_yunet_2023mar.onnx', 232589, '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4')], license: 'MIT', caches: ['ybeat-face'], silent: true },
  { id: 'sface', name: 'SFace', feature: '主角辨識', files: [file('face_recognition_sface_2021dec_int8.onnx', 9896933, '2b0e941e6f16cc048c20aee0c8e31f569118f65d702914540f7bfdc14048d78a')], license: 'Apache-2.0', silent: true },
  { id: 'vittrack', name: 'VitTrack', feature: '物件追蹤', files: [file('object_tracking_vittrack_2023sep.onnx', 714726, '2990f0b7cd44d92afa48cd97db6de7be113fc1d9594fddb74e2725c10478e91d')], license: 'Apache-2.0', caches: ['ybeat-track'], silent: true },
  { id: 'u2netp', name: 'U²-Netp', feature: '去背', files: [file('u2netp.onnx', 4574861, '309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8')], license: 'Apache-2.0', caches: ['ybeat-matte'], silent: true },
  { id: 'beat-this', name: 'Beat This!', feature: '拍點偵測', files: [file('beat_this_small0.onnx', 9318934, 'fc63c64dbc82daf7bbe83e0266e5529437d51d0a15405ee790f700d178fdc559'), file('beat_this_mel.bin', 262656, '1b6269cd550322087fd6e026a0aef26768966388f35aa1acd553a4d0e761ec39')], license: 'MIT', caches: ['ybeat-beats'] },
  { id: 'silero-vad', name: 'Silero VAD', feature: '人聲偵測', files: [hf('onnx-community/silero-vad', 'e71cae966052b992a7eca6b17738916ce0eca4ec', 'onnx/model.onnx', 2243022, 'a4a068cd6cf1ea8355b84327595838ca748ec29a25bc91fc82e6c299ccdc5808')], license: 'MIT' },
  { id: 'whisper-tiny', name: 'Whisper tiny', feature: '自動字幕', files: [
    hf('onnx-community/whisper-tiny', 'ff4177021cc41f7db950912b73ea4fdf7d01d8e7', 'onnx/encoder_model_quantized.onnx', 10124990, '2af4a414ca47aa30f61246017e5fe82b0a8d229281d1255ba666a2a7f6b84d19'),
    hf('onnx-community/whisper-tiny', 'ff4177021cc41f7db950912b73ea4fdf7d01d8e7', 'onnx/decoder_model_merged_quantized.onnx', 30719241, '25e807a962b6349356d0ea5d0dfe530b7e5bf0e2a484aeca0359d03143faddd3'),
    hf('onnx-community/whisper-tiny', 'ff4177021cc41f7db950912b73ea4fdf7d01d8e7', 'vocab.json', 1036584, '50d6a919f0a0601d56a04eb583c780d18553aa388254ba3158eb6a00f13e2c1a'),
    hf('onnx-community/whisper-tiny', 'ff4177021cc41f7db950912b73ea4fdf7d01d8e7', 'generation_config.json', 3772, 'f5c67e5a4f7102f8cb4d058bc95da276bbc19eeec997267c3bb0f25ef68facd1'),
  ], license: 'MIT' },
];
export const modelDef = (id: string) => { const def = MODELS.find((m) => m.id === id); if (!def) throw new Error(`Unknown model: ${id}`); return def; };
export class ModelDeclined extends Error { constructor() { super('Model declined'); this.name = 'ModelDeclined'; } }

export const useModels = create<{ status: Record<string, { downloaded: boolean; bytes: number }>; progress: Record<string, { done: number; total: number; cancel: () => void }> }>(() => ({ status: {}, progress: {} }));
const inflight = new Map<string, Promise<Map<string, ArrayBuffer>>>();
const generations = new Map<string, number>();
export const modelGeneration = (id: string) => generations.get(id) ?? 0;
let persisted = false;
const declinedKey = (id: string) => `ybeat-model-declined:${id}`;
const totalSize = (def: ModelDef) => def.files.reduce((n, f) => n + f.bytes, 0);

async function cached(def: ModelDef) {
  const cache = await caches.open('ybeat-models');
  const out = new Map<string, ArrayBuffer>();
  for (const f of def.files) {
    const r = await cache.match(f.url);
    if (r) out.set(f.url, await r.arrayBuffer());
  }
  return out;
}
export async function refreshModelStatus() {
  const status: Record<string, { downloaded: boolean; bytes: number }> = {};
  const cache = await caches.open('ybeat-models');
  for (const def of MODELS) {
    // 只看有沒有存，不要把整個模型讀進記憶體
    const have = await Promise.all(def.files.map((f) => cache.match(f.url).then((r) => !!r)));
    status[def.id] = { downloaded: have.every(Boolean), bytes: def.files.reduce((n, f, i) => n + (have[i] ? f.bytes : 0), 0) };
  }
  useModels.setState({ status });
  return status;
}
export const modelStatus = () => useModels.getState().status;

export function ensureModel(id: string, opts: { onProgress?: (done: number, total: number) => void; signal?: AbortSignal; ask?: boolean } = {}): Promise<Map<string, ArrayBuffer>> {
  const existing = inflight.get(id);
  if (existing) return existing;
  const promise = download(modelDef(id), opts).finally(() => inflight.delete(id));
  inflight.set(id, promise);
  return promise;
}
async function download(def: ModelDef, opts: { onProgress?: (done: number, total: number) => void; signal?: AbortSignal; ask?: boolean }) {
  if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const data = await cached(def);
  if (data.size === def.files.length) return data;
  if (!def.silent && totalSize(def) >= 5_000_000) {
    if (opts.ask !== true && localStorage.getItem(declinedKey(def.id))) throw new ModelDeclined();
    if (opts.ask !== false) {
      const ok = await confirmDialog({ title: $t('下載模型？'), message: `${$t(def.name)} · ${formatBytes(totalSize(def))} · ${def.license}`, ok: $t('下載') });
      if (!ok) { localStorage.setItem(declinedKey(def.id), '1'); throw new ModelDeclined(); }
      localStorage.removeItem(declinedKey(def.id));
    }
  }
  if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const controller = new AbortController();
  const abort = () => controller.abort();
  opts.signal?.addEventListener('abort', abort, { once: true });
  if (opts.signal?.aborted) controller.abort();
  let done = [...data.values()].reduce((n, b) => n + b.byteLength, 0);
  const total = totalSize(def);
  const progress = () => {
    opts.onProgress?.(done, total);
    useModels.setState((s) => ({ progress: { ...s.progress, [def.id]: { done, total, cancel: abort } } }));
  };
  progress();
  try {
    const cache = await caches.open('ybeat-models');
    for (const f of def.files) {
      if (data.has(f.url)) continue;
      const response = await fetch(f.url, { signal: controller.signal });
      if (!response.ok) throw new Error(`model HTTP ${response.status}`);
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader) {
        while (true) {
          const { value, done: end } = await reader.read();
          if (end) break;
          chunks.push(value); size += value.byteLength; done += value.byteLength; progress();
        }
      } else { const b = new Uint8Array(await response.arrayBuffer()); chunks.push(b); size = b.byteLength; done += size; progress(); }
      if (size !== f.bytes) throw new Error('model size mismatch');
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((n) => n.toString(16).padStart(2, '0')).join('');
      if (hash !== f.sha256) throw new Error('model hash mismatch');
      await cache.put(f.url, new Response(bytes));
      data.set(f.url, bytes.buffer);
    }
    if (!persisted) { persisted = true; void navigator.storage.persist?.().catch(() => {}); }
    await refreshModelStatus();
    return data;
  } finally {
    opts.signal?.removeEventListener('abort', abort);
    useModels.setState((s) => { const progress = { ...s.progress }; delete progress[def.id]; return { progress }; });
  }
}

export async function deleteModel(id: string, opts: { caches: boolean }) {
  const def = modelDef(id);
  const cache = await caches.open('ybeat-models');
  for (const f of def.files) await cache.delete(f.url);
  generations.set(id, modelGeneration(id) + 1);
  if (opts.caches) for (const name of def.caches ?? []) await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve(); req.onerror = () => reject(req.error);
    // 被別的分頁擋住時刪除會排著，等那邊關掉才完成，不用一直等
    req.onblocked = () => setTimeout(resolve, 1500);
  });
  await refreshModelStatus();
}
