/** 音樂素材的 Beat This! 結果：記憶體與 IndexedDB 共用。 */
import { create } from 'zustand';
import type { Media } from '../store';
import { getAudioBuffer } from './audio';
import { ensureModel, ModelDeclined, modelDef } from './models';
import { usePrefs } from '../prefs';
import { toast } from '../ui/uiStore';
import { $t } from '../i18n';
import type { BeatReq, BeatRes } from './beatWorker';

export interface BeatResult { v: 1; beats: number[]; downbeats: number[] }
export const useBeatAnalysis = create<{ ver: number; jobs: Record<string, { done: number; total: number }> }>(() => ({ ver: 0, jobs: {} }));
/** 失敗只提示一次（每個素材都失敗時不要一直跳） */
let failedOnce = false;
const results = new Map<string, BeatResult>();
const loading = new Map<string, Promise<void>>();
const jobs = new Map<string, Promise<void>>();
let dbp: Promise<IDBDatabase> | null = null;
function db() {
  dbp ??= new Promise((resolve, reject) => {
    const r = indexedDB.open('ybeat-beats', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('beats');
    r.onsuccess = () => { const d = r.result; d.onversionchange = () => { d.close(); dbp = null; }; resolve(d); };
    r.onerror = () => reject(r.error);
  });
  return dbp;
}
async function record(id: string, value?: BeatResult): Promise<BeatResult | undefined> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const req = value ? d.transaction('beats', 'readwrite').objectStore('beats').put(value, id) : d.transaction('beats', 'readonly').objectStore('beats').get(id);
    req.onsuccess = () => resolve(value ?? req.result);
    req.onerror = () => reject(req.error);
  });
}
const bump = () => useBeatAnalysis.setState((s) => ({ ver: s.ver + 1 }));
export function beatResult(id: string) {
  if (!results.has(id) && !loading.has(id)) {
    const p = record(id).then((r) => { if (r?.v === 1) { results.set(id, r); bump(); } }).catch(() => {}).finally(() => loading.delete(id));
    loading.set(id, p);
  }
  return results.get(id);
}
export function dropBeats(id: string) {
  results.delete(id); loading.delete(id); bump();
  void db().then((d) => d.transaction('beats', 'readwrite').objectStore('beats').delete(id)).catch(() => {});
}
export function clearBeatResults() { results.clear(); bump(); }

let worker: Worker | null = null, seq = 0;
const waiting = new Map<number, { resolve: (r: BeatResult) => void; reject: (e: Error) => void; mediaId: string }>();
let initialized = false;
function infer(wav: Float32Array, mediaId: string, model: ArrayBuffer, mel: ArrayBuffer): Promise<BeatResult> {
  if (!worker) {
    worker = new Worker(new URL('./beatWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<BeatRes>) => {
      const r = event.data, w = waiting.get(r.id);
      if (!w) return;
      if ('done' in r) {
        useBeatAnalysis.setState((s) => ({ jobs: { ...s.jobs, [w.mediaId]: { done: r.done, total: r.total } } }));
      } else {
        waiting.delete(r.id);
        if ('error' in r) { worker?.terminate(); worker = null; initialized = false; w.reject(new Error(r.error)); }
        else w.resolve({ v: 1, beats: r.beats, downbeats: r.downbeats });
      }
    };
  }
  const id = ++seq;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject, mediaId });
    const req: BeatReq = { id, wav, ...(!initialized ? { model, mel } : {}) };
    initialized = true;
    worker!.postMessage(req, [wav.buffer]);
  });
}
async function mono22050(buf: AudioBuffer) {
  const context = new OfflineAudioContext(1, Math.ceil(buf.duration * 22050), 22050);
  const mono = context.createBuffer(1, buf.length, buf.sampleRate);
  const out = mono.getChannelData(0);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const ch = buf.getChannelData(c);
    for (let i = 0; i < out.length; i++) out[i] += ch[i] / buf.numberOfChannels;
  }
  const source = context.createBufferSource(); source.buffer = mono; source.connect(context.destination); source.start();
  return new Float32Array((await context.startRendering()).getChannelData(0));
}
export function requestBeats(m: Media): Promise<void> {
  if (!usePrefs.getState().aiBeats || m.kind !== 'audio' || !m.peaks || m.missing) return Promise.resolve();
  if (beatResult(m.id)) return Promise.resolve();
  const previous = jobs.get(m.id); if (previous) return previous;
  const p = (async () => {
    try {
      await loading.get(m.id);
      if (results.has(m.id)) return;
      const def = modelDef('beat-this');
      const files = await ensureModel(def.id);
      const buf = await getAudioBuffer(m.url);
      if (!buf) return;
      useBeatAnalysis.setState((s) => ({ jobs: { ...s.jobs, [m.id]: { done: 0, total: 1 } } }));
      const r = await infer(await mono22050(buf), m.id, files.get(def.files[0].url)!, files.get(def.files[1].url)!);
      results.set(m.id, r); bump();
      await record(m.id, r).catch(() => {});
    } catch (e) {
      if (!(e instanceof ModelDeclined) && (e as Error).name !== 'AbortError' && !failedOnce) { failedOnce = true; toast($t('拍點偵測失敗，改用原本的估算'), 'error'); }
    } finally {
      useBeatAnalysis.setState((s) => { const jobs = { ...s.jobs }; delete jobs[m.id]; return { jobs }; });
      jobs.delete(m.id);
    }
  })();
  jobs.set(m.id, p);
  return p;
}
