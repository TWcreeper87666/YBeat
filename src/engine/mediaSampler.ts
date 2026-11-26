/**
 * 自動剪輯的素材分析（瀏覽器端）：影片每 step 秒取一格（直接解碼檔案、盡量只解關鍵影格；不支援的格式才用 <video> seek）、畫成 160px 寬，算亮度 / 清晰度 / 跟上一格的差異
 * （統計在 mediaAnalysis.ts），順便留幾張 384px 的 JPEG 給 AI 導演看。圖片只取一張畫面。
 * 結果存在記憶體，也存進瀏覽器（analysisStore），重新整理後不用重算。
 */
import type { Media } from '../store';
import { analyzeSamples, bestFace, frameStats, grayOf, peopleScore, type FaceBox, type FrameSample, type MediaInfo } from './mediaAnalysis';
import { detectFaces, embedFace, EMBED_MIN_PX } from './face';
import type { FacesAt } from './faceLead';
import type { Face } from './faceTrack';
import type { Shot } from '../ai/frames';
import { decodeAt } from './matteDecode';
import { loadAnalysis, saveAnalysis } from './analysisStore';

const W = 160;
const SHOT_SIDE = 384;
/** 給 AI 導演看的畫面：每 SHOT_GAP 秒一張，一支最多 SHOT_MAX 張（很長的影片拉開間隔） */
const SHOT_GAP = 2;
const SHOT_MAX = 40;

/** people：整個素材平均有多少人（0..1；偵測失敗 = 沒有）；face：圖片裡最大的臉；faceList：圖片裡的臉（含特徵） */
export interface Sampled { info: MediaInfo | null; shots: { t: number; shot: Shot }[]; people?: number; face?: FaceBox | null; faceList?: FacesAt }

/** 偵測到的臉 → 加上特徵（臉夠大、有特徵點才算；一格最多算最大的 EMBED_MAX 張，群眾畫面不用每張都算；特徵模型載入失敗就都不算） */
const EMBED_MAX = 4;
let embedBroken = false;
async function withEmb(src: CanvasImageSource, w: number, h: number, faces: Face[]): Promise<NonNullable<FacesAt>> {
  const out: NonNullable<FacesAt> = [];
  let n = 0;
  for (const f of [...faces].sort((a, b) => b.h - a.h)) {
    const box = { x: f.x, y: f.y, w: f.w, h: f.h };
    if (embedBroken || !f.kps || f.h * h < EMBED_MIN_PX || n >= EMBED_MAX) { out.push(box); continue; }
    n++;
    try {
      out.push({ ...box, emb: await embedFace(src, f.kps.map((v, k) => v * (k % 2 ? h : w))) });
    } catch (e) {
      console.warn('face embedding failed', e);
      embedBroken = true;
      out.push(box);
    }
  }
  return out;
}

/** from = 只分析素材的 from..from+duration 秒（自動剪輯的指定片段）；取樣時間都相對 from */
type Src = Media & { from?: number };

const cache = new Map<string, Promise<Sampled>>();
/** 已經分析好的（同步拿，給 AI 工具 / 面板看狀態） */
export const sampledNow = new Map<string, Sampled>();

function toShot(src: CanvasImageSource, w: number, h: number): Shot {
  const k = Math.min(1, SHOT_SIDE / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(2, Math.round(w * k));
  c.height = Math.max(2, Math.round(h * k));
  c.getContext('2d')!.drawImage(src, 0, 0, c.width, c.height);
  const url = c.toDataURL('image/jpeg', 0.8);
  return { mime: 'image/jpeg', data: url.slice(url.indexOf(',') + 1), url };
}

async function sampleImage(m: Media): Promise<Sampled> {
  const img = new Image();
  img.src = m.url;
  await img.decode();
  const shots = [{ t: 0, shot: toShot(img, img.naturalWidth, img.naturalHeight) }];
  try {
    const faces = await detectFaces(img, img.naturalWidth, img.naturalHeight);
    return { info: null, shots, people: peopleScore(faces), face: bestFace(faces), faceList: await withEmb(img, img.naturalWidth, img.naturalHeight, faces) };
  } catch {
    return { info: null, shots };
  }
}

/** 找人：每秒最多一格（一支最多 FACE_MAX 格），先存 640px 的小圖（遠一點的臉也抓得到、認得出是誰），取樣完再一張一張偵測臉、算特徵 */
const FACE_SIDE = 640;
const FACE_MAX = 80;
function faceGrabber(times: number[], step: number, vw: number, vh: number) {
  const every = Math.max(1, Math.ceil(1 / step - 1e-6), Math.ceil(times.length / FACE_MAX));
  const k = FACE_SIDE / Math.max(vw, vh, 1);
  const w = Math.max(2, Math.round(vw * k)), h = Math.max(2, Math.round(vh * k));
  const g = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true })!;
  const pics = new Map<number, ImageData>();
  return {
    take(i: number, src: CanvasImageSource) {
      if (i % every || pics.has(i)) return;
      g.drawImage(src, 0, 0, w, h);
      pics.set(i, g.getImageData(0, 0, w, h));
    },
    /** 偵測完填進 info.people（每個取樣點用最近一張有偵測的）；回傳整支的平均 */
    async run(info: MediaInfo): Promise<number | undefined> {
      if (!pics.size) return undefined;
      const scores = new Map<number, number>();
      const boxes = new Map<number, FaceBox | null>();
      const facesAt: FacesAt[] = info.quality.map(() => null);
      try {
        for (const [i, d] of pics) {
          g.putImageData(d, 0, 0);
          const faces = await detectFaces(g.canvas, w, h);
          scores.set(i, peopleScore(faces));
          boxes.set(i, bestFace(faces));
          if (i < facesAt.length) facesAt[i] = await withEmb(g.canvas, w, h, faces);
        }
      } catch {
        return undefined;
      }
      info.facesAt = facesAt;
      const idx = [...scores.keys()].sort((a, b) => a - b);
      const near = info.quality.map((_, i) => idx.reduce((best, x) => (Math.abs(x - i) < Math.abs(best - i) ? x : best), idx[0]));
      info.people = near.map((j) => scores.get(j)!);
      info.faces = near.map((j) => boxes.get(j) ?? null);
      return [...scores.values()].reduce((s, v) => s + v, 0) / scores.size;
    },
  };
}

/** 分析完再找人（失敗 = 沒有人的資料，照舊） */
async function withPeople(r: Sampled, faces: ReturnType<typeof faceGrabber>): Promise<Sampled> {
  if (!r.info) return r;
  const people = await faces.run(r.info);
  return people === undefined ? r : { ...r, people };
}

/** 取樣的時間點：每秒 2 格；很長的影片最多 360 格 */
function sampleTimes(dur: number) {
  const step = Math.max(0.5, dur / 360);
  const times: number[] = [];
  for (let t = 0; t < dur - 0.05; t += step) times.push(t);
  const every = Math.max(1, Math.round(SHOT_GAP / step), Math.ceil(times.length / SHOT_MAX));
  // 從半個間隔開始（開頭第一格常常是黑的 / 還沒對焦）
  const shotIdx = new Set(times.map((_, k) => k).filter((k) => (k + Math.floor(every / 2)) % every === 0));
  return { step, times, shotIdx };
}

/** 直接解碼（mp4 / mov）：附近有關鍵影格就用關鍵影格，不用從頭解每一格 */
async function sampleDecoded(m: Src, onFrame: (k: number, n: number) => void): Promise<Sampled> {
  const dur = Math.max(0.1, m.duration || 0.1);
  const { step, times, shotIdx } = sampleTimes(dur);
  const vw = m.width || 16, vh = m.height || 9;
  const h = Math.max(2, Math.round((W * vh) / vw));
  const g = new OffscreenCanvas(W, h).getContext('2d', { willReadFrequently: true })!;
  const grays: (Float32Array | undefined)[] = new Array(times.length);
  const shots: Sampled['shots'] = [];
  const faces = faceGrabber(times, step, vw, vh);
  const from = m.from ?? 0;
  await decodeAt({
    url: m.url,
    times: times.map((t) => from + t),
    // 關鍵影格離時間點不到 0.3 步就直接用它（分析只看大概的變化，差一點沒關係）
    tol: step * 0.3,
    // 一支影片最多解大約 3 倍取樣數的格子（不然 GOP 很長的影片等於整支解一遍）
    budget: times.length * 3,
    alive: () => true,
    onProgress: onFrame,
    onFrame: (k, frame) => {
      try {
        g.drawImage(frame, 0, 0, W, h);
        grays[k] = grayOf(g.getImageData(0, 0, W, h).data, W, h);
        faces.take(k, frame);
        if (shotIdx.has(k)) shots.push({ t: times[k], shot: toShot(frame, frame.displayWidth, frame.displayHeight) });
      } finally {
        frame.close();
      }
    },
  });
  const samples: FrameSample[] = [];
  let prev: Float32Array | undefined;
  for (let k = 0; k < times.length; k++) {
    const gray = grays[k];
    if (!gray) continue;
    samples.push({ t: times[k], ...frameStats(gray, W, h, prev) });
    prev = gray;
  }
  if (samples.length < times.length * 0.8) throw new Error('decode: missing frames');
  shots.sort((a, b) => a.t - b.t);
  return withPeople({ info: analyzeSamples(samples, dur), shots }, faces);
}

async function sampleVideo(m: Src, onFrame: (k: number, n: number) => void): Promise<Sampled> {
  try {
    return await sampleDecoded(m, onFrame);
  } catch {
    try {
      return await sampleScan(m, onFrame);
    } catch {
      return sampleSeek(m, onFrame);
    }
  }
}

/** seek 到 t 並等完成（最多 3 秒） */
function seekTo(v: HTMLVideoElement, t: number): Promise<void> {
  return new Promise<void>((res) => {
    const done = () => (v.removeEventListener('seeked', done), clearTimeout(timer), res());
    const timer = setTimeout(done, 3000);
    v.addEventListener('seeked', done);
    v.currentTime = t;
  });
}

/** 等影片可以播；逾時 / 失敗就丟錯 */
function loadVideo(v: HTMLVideoElement): Promise<void> {
  return new Promise<void>((res, rej) => {
    const timer = setTimeout(() => rej(new Error('video load timeout')), 20000);
    v.onloadeddata = () => (clearTimeout(timer), res());
    v.onerror = () => (clearTimeout(timer), rej(new Error('video load failed')));
  });
}

type RvfcVideo = HTMLVideoElement & { requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number };

/**
 * 不能直接解碼的格式（MKV、WebM…）：靜音 16 倍速從頭播一遍，播到取樣點就抓當下的畫面。
 * 不用 seek（關鍵影格很稀的影片每次 seek 都要解幾百格）。頁面在背景時畫面通知不會來 → 停太久就丟錯、改用 seek。
 */
async function sampleScan(m: Src, onFrame: (k: number, n: number) => void): Promise<Sampled> {
  const v = document.createElement('video') as RvfcVideo;
  if (!v.requestVideoFrameCallback) throw new Error('no rVFC');
  v.muted = true;
  v.preload = 'auto';
  v.playsInline = true;
  v.src = m.url;
  try {
    await loadVideo(v);
    const from = m.from ?? 0;
    const dur = Math.max(0.1, m.from !== undefined ? m.duration : v.duration || m.duration || 0.1);
    const { step, times, shotIdx } = sampleTimes(dur);
    if (from > 0) await seekTo(v, from);
    const vw = v.videoWidth || m.width || 16, vh = v.videoHeight || m.height || 9;
    const h = Math.max(2, Math.round((W * vh) / vw));
    const g = new OffscreenCanvas(W, h).getContext('2d', { willReadFrequently: true })!;
    const grays: (Float32Array | undefined)[] = new Array(times.length);
    const shots: Sampled['shots'] = [];
    const faces = faceGrabber(times, step, vw, vh);
    let next = 0;
    // 抓目前畫面給 mediaTime 之前（含半步內）還沒抓到的取樣點
    const grab = (mt: number, all = false) => {
      if (next >= times.length || (!all && times[next] > mt + step * 0.5)) return;
      g.drawImage(v, 0, 0, W, h);
      const gray = grayOf(g.getImageData(0, 0, W, h).data, W, h);
      while (next < times.length && (all || times[next] <= mt + step * 0.5)) {
        grays[next] = gray;
        faces.take(next, v);
        if (shotIdx.has(next)) shots.push({ t: times[next], shot: toShot(v, vw, vh) });
        next++;
      }
      onFrame(next, times.length);
    };
    await new Promise<void>((res, rej) => {
      let last = performance.now();
      const watch = setInterval(() => {
        if (performance.now() - last > 3000) (clearInterval(watch), rej(new Error('scan stalled')));
      }, 500);
      const finish = () => (clearInterval(watch), grab(dur, true), res());
      const tick = (_now: number, meta: { mediaTime: number }) => {
        last = performance.now();
        grab(meta.mediaTime - from);
        if (next >= times.length) return finish();
        v.requestVideoFrameCallback!(tick);
      };
      v.onended = finish;
      v.requestVideoFrameCallback!(tick);
      v.playbackRate = 16;
      v.play().catch((e) => (clearInterval(watch), rej(e)));
    });
    const samples: FrameSample[] = [];
    let prev: Float32Array | undefined;
    for (let k = 0; k < times.length; k++) {
      const gray = grays[k];
      if (!gray) continue;
      // 同一格給了好幾個取樣點（播太快跳格）：跟上一格的差異照算（= 0）
      samples.push({ t: times[k], ...frameStats(gray, W, h, prev) });
      prev = gray;
    }
    return withPeople({ info: analyzeSamples(samples, dur), shots }, faces);
  } finally {
    v.pause();
    v.removeAttribute('src');
    v.load();
  }
}

async function sampleSeek(m: Src, onFrame: (k: number, n: number) => void): Promise<Sampled> {
  const v = document.createElement('video');
  v.muted = true;
  v.preload = 'auto';
  v.playsInline = true;
  v.src = m.url;
  try {
    await loadVideo(v);
    const from = m.from ?? 0;
    const dur = Math.max(0.1, m.from !== undefined ? m.duration : v.duration || m.duration || 0.1);
    const { step, times, shotIdx } = sampleTimes(dur);
    const vw = v.videoWidth || m.width || 16, vh = v.videoHeight || m.height || 9;
    const h = Math.max(2, Math.round((W * vh) / vw));
    const g = new OffscreenCanvas(W, h).getContext('2d', { willReadFrequently: true })!;
    const samples: FrameSample[] = [];
    const shots: Sampled['shots'] = [];
    const faces = faceGrabber(times, step, vw, vh);
    let prev: Float32Array | undefined;
    for (let k = 0; k < times.length; k++) {
      await new Promise<void>((res) => {
        const done = () => (v.removeEventListener('seeked', done), clearTimeout(timer), res());
        const timer = setTimeout(done, 3000);
        v.addEventListener('seeked', done);
        v.currentTime = from + times[k];
      });
      const rv = v as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number };
      if (rv.requestVideoFrameCallback) await new Promise<void>((res) => { const tm = setTimeout(res, 200); rv.requestVideoFrameCallback!(() => (clearTimeout(tm), res())); });
      g.drawImage(v, 0, 0, W, h);
      const gray = grayOf(g.getImageData(0, 0, W, h).data, W, h);
      samples.push({ t: times[k], ...frameStats(gray, W, h, prev) });
      prev = gray;
      faces.take(k, v);
      if (shotIdx.has(k)) shots.push({ t: times[k], shot: toShot(v, vw, vh) });
      onFrame(k + 1, times.length);
    }
    return withPeople({ info: analyzeSamples(samples, dur), shots }, faces);
  } finally {
    v.pause();
    v.removeAttribute('src');
    v.load();
  }
}

/** 正在分析的素材 → 想知道進度的人（背景預先分析時，按「產生」也要看得到進度） */
const listeners = new Map<string, Set<(k: number, n: number) => void>>();

// ───────────── 存進瀏覽器：縮圖只存 base64、臉部特徵存成 Float32Array（小一半） ─────────────

type Face32 = FaceBox & { emb?: Float32Array };
type Saved = Omit<Sampled, 'shots' | 'faceList' | 'info'> & {
  shots: { t: number; data: string }[];
  faceList?: Face32[] | null;
  info: (Omit<MediaInfo, 'facesAt'> & { facesAt?: (Face32[] | null)[] }) | null;
};
const packFaces = (l: FacesAt): Face32[] | null => l && l.map((f) => (f.emb ? { ...f, emb: Float32Array.from(f.emb) } : (f as Face32)));
const unpackFaces = (l: Face32[] | null | undefined): FacesAt => (l ? l.map((f) => (f.emb ? { ...f, emb: Array.from(f.emb) } : (f as FaceBox))) : null);

function pack(r: Sampled): [Saved, number] {
  const info = r.info && { ...r.info, facesAt: r.info.facesAt?.map(packFaces) };
  const { faceList, ...rest } = r;
  const saved: Saved = { ...rest, info, shots: r.shots.map((x) => ({ t: x.t, data: x.shot.data })), ...(faceList !== undefined ? { faceList: packFaces(faceList) } : {}) };
  let bytes = r.shots.reduce((s, x) => s + x.shot.data.length, 0);
  const embs = (l: FacesAt) => (l ?? []).reduce((s, f) => s + (f.emb?.length ?? 0) * 4, 0);
  bytes += (r.info?.facesAt ?? []).reduce((s, l) => s + embs(l), 0) + embs(r.faceList ?? null);
  bytes += ((r.info?.motion.length ?? 0) + (r.info?.quality.length ?? 0)) * 16 + 1024;
  return [saved, bytes];
}
function unpack(s: Saved): Sampled {
  const info = s.info && { ...s.info, facesAt: s.info.facesAt?.map(unpackFaces) };
  const { faceList, ...rest } = s;
  return {
    ...rest,
    info: info as MediaInfo | null,
    shots: s.shots.map((x) => ({ t: x.t, shot: { mime: 'image/jpeg' as const, data: x.data, url: `data:image/jpeg;base64,${x.data}` } })),
    ...(faceList !== undefined ? { faceList: unpackFaces(faceList) } : {}),
  };
}
/** 同一個檔案、同一段才算同一筆（指定片段的 id 是虛擬的，用原素材 id + 範圍） */
const savedKey = (m: Src) => {
  const src = (m as Src & { srcId?: string }).srcId ?? m.id;
  return m.kind === 'video' ? `${src}|${(m.from ?? 0).toFixed(2)}|${m.duration.toFixed(2)}` : `${src}|0|0`;
};

/** 分析一個素材（算過 / 正在算就用同一份）；失敗 = 沒有分析資料（照舊隨機挑） */
export function sampleMedia(m: Src, onFrame: (k: number, n: number) => void = () => {}): Promise<Sampled> {
  let p = cache.get(m.id);
  if (!p) {
    const set = new Set<(k: number, n: number) => void>();
    listeners.set(m.id, set);
    const key = savedKey(m);
    p = loadAnalysis<Saved>('media', key)
      .then((hit) => hit ? unpack(hit) : (m.kind === 'video' ? sampleVideo(m, (k, n) => set.forEach((f) => f(k, n))) : sampleImage(m)).then((r) => {
        // 失敗 / 沒有資料的不存（下次再試）
        if (r.info || r.shots.length) { const [saved, bytes] = pack(r); void saveAnalysis('media', key, saved, bytes); }
        return r;
      }))
      .catch((): Sampled => ({ info: null, shots: [] }))
      .then((r) => (sampledNow.set(m.id, r), listeners.delete(m.id), r));
    cache.set(m.id, p);
  }
  const set = listeners.get(m.id);
  if (set) {
    set.add(onFrame);
    p.then(() => set.delete(onFrame));
  }
  return p;
}

/**
 * 背景預先分析（自動剪輯分頁開著時）：一次一個，stop() = true 就不再開始下一個。
 * 結果進快取，按「產生」時直接用。
 */
export async function presample(list: Src[], stop: () => boolean): Promise<void> {
  for (const m of list) {
    if (stop()) return;
    if (!sampledNow.has(m.id)) await sampleMedia(m);
  }
}

/** 依序分析一批素材；onProgress(第幾個, 共幾個, 名稱, 這個素材的進度 0..1)；stop() = true 就停（回傳已經算好的） */
export async function sampleAll(list: Src[], onProgress: (i: number, n: number, name: string, frac: number) => void, stop: () => boolean = () => false): Promise<Map<string, Sampled>> {
  const out = new Map<string, Sampled>();
  for (let i = 0; i < list.length; i++) {
    if (stop()) break;
    const m = list[i];
    if (!sampledNow.has(m.id)) onProgress(i + 1, list.length, m.name, 0);
    out.set(m.id, await sampleMedia(m, (k, n) => onProgress(i + 1, list.length, m.name, k / n)));
  }
  return out;
}
