import { create } from 'zustand';
import { $t } from '../i18n';
import { ensureModel, ModelDeclined, modelDef } from './models';
import type { Cue } from './subtitles';
import { speechWindows, type SpeechSpan } from './vad';
import type { SpeechRes } from './speechWorker';

export const useSpeechJob = create<{ stage: string | null; done: number; total: number; cancel: (() => void) | null }>(() => ({ stage: null, done: 0, total: 1, cancel: null }));
const abortError = () => new DOMException('Aborted', 'AbortError');
type WorkerInput = { kind: 'vad'; wav: Float32Array; model: ArrayBuffer } | { kind: 'whisper'; wav: Float32Array; encoder: ArrayBuffer; decoder: ArrayBuffer; vocab: ArrayBuffer; config: ArrayBuffer; language: string };
/** 模型下載不了（跟辨識失敗分開提示） */
export class ModelUnavailable extends Error { constructor() { super('Model unavailable'); this.name = 'ModelUnavailable'; } }
const modelFiles = (id: string, signal?: AbortSignal) => ensureModel(id, { signal }).catch((e) => {
  throw e instanceof ModelDeclined || (e as Error).name === 'AbortError' ? e : new ModelUnavailable();
});

// 同一個 worker 跑完整個工作：模型 session 留在 worker 裡，每段不用重建；取消 / 出錯就整個關掉
let worker: Worker | null = null, seq = 0;
function workerRun(req: WorkerInput, onProgress?: (done: number, total: number) => void, signal?: AbortSignal): Promise<SpeechRes> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const w = worker ??= new Worker(new URL('./speechWorker.ts', import.meta.url), { type: 'module' });
    const id = ++seq;
    const kill = () => { w.terminate(); if (worker === w) worker = null; };
    const clean = () => { signal?.removeEventListener('abort', abort); w.onmessage = null; w.onerror = null; };
    const abort = () => { clean(); kill(); reject(abortError()); };
    signal?.addEventListener('abort', abort, { once: true });
    w.onerror = (e) => { clean(); kill(); reject(new Error(e.message)); };
    w.onmessage = (e: MessageEvent<SpeechRes>) => {
      const r = e.data;
      if (r.id !== id) return;
      if (r.kind === 'progress') { onProgress?.(r.done, r.total); return; }
      clean();
      if (r.kind === 'error') { kill(); reject(new Error(r.error)); } else resolve(r);
    };
    w.postMessage({ ...req, id });
  });
}
/** 工作結束：放掉 worker 和裡面的模型 */
export function releaseSpeech() { worker?.terminate(); worker = null; }

export async function mono16k(buffer: AudioBuffer): Promise<Float32Array> {
  const context = new OfflineAudioContext(1, Math.max(1, Math.ceil(buffer.duration * 16000)), 16000);
  const mono = context.createBuffer(1, buffer.length, buffer.sampleRate), out = mono.getChannelData(0);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const channel = buffer.getChannelData(c);
    for (let i = 0; i < out.length; i++) out[i] += channel[i] / buffer.numberOfChannels;
  }
  const source = context.createBufferSource(); source.buffer = mono; source.connect(context.destination); source.start();
  return new Float32Array((await context.startRendering()).getChannelData(0));
}

/** 16 kHz 單聲道輸入；回傳秒數區間。 */
export async function detectSpeech(samples16k: Float32Array, onProgress?: (done: number, total: number) => void, signal?: AbortSignal): Promise<SpeechSpan[]> {
  const def = modelDef('silero-vad');
  const files = await modelFiles(def.id, signal);
  const result = await workerRun({ kind: 'vad', wav: samples16k, model: files.get(def.files[0].url)! }, onProgress, signal);
  if (result.kind !== 'vad') throw new Error('VAD result missing');
  return result.spans;
}

export async function autoSubtitles(samples16k: Float32Array, language: string, signal: AbortSignal): Promise<Cue[]> {
  // 整個工作一條進度：偵測人聲佔前 10%，其餘平分給每一段辨識
  const at = (frac: number) => useSpeechJob.setState({ done: Math.min(1, frac), total: 1 });
  useSpeechJob.setState({ stage: $t('偵測人聲'), done: 0, total: 1 });
  const spans = await detectSpeech(samples16k, (d, t) => at(0.1 * d / Math.max(1, t)), signal);
  if (!spans.length) return [];
  const windows = speechWindows(spans);
  const def = modelDef('whisper-tiny');
  const files = await modelFiles(def.id, signal);
  const cues: Cue[] = [];
  for (const [i, window] of windows.entries()) {
    if (signal.aborted) throw abortError();
    useSpeechJob.setState({ stage: `${i + 1} / ${windows.length}` });
    at(0.1 + 0.9 * i / windows.length);
    // 一段大約每秒 4 個 token；只是估計，最多跑到這段的 90%
    const expect = Math.max(8, (window.end - window.start) * 4);
    const progress = (tokens: number) => at(0.1 + 0.9 * (i + Math.min(0.9, tokens / expect)) / windows.length);
    const from = Math.floor(window.start * 16000), to = Math.ceil(window.end * 16000);
    const result = await workerRun({ kind: 'whisper', wav: samples16k.slice(from, to), encoder: files.get(def.files[0].url)!, decoder: files.get(def.files[1].url)!, vocab: files.get(def.files[2].url)!, config: files.get(def.files[3].url)!, language }, (d) => progress(d), signal);
    if (result.kind !== 'whisper') throw new Error('Whisper result missing');
    for (const cue of result.cues) cues.push({ ...cue, start: Math.min(window.end, window.start + cue.start), end: Math.min(window.end, window.start + cue.end) });
  }
  cues.sort((a, b) => a.start - b.start);
  for (let i = 0; i < cues.length - 1; i++) cues[i].end = Math.min(cues[i].end, cues[i + 1].start);
  return cues.filter((c) => c.end > c.start);
}
