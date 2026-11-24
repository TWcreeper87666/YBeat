/**
 * 拖播放頭用的低解析度影格快取。
 * 長 GOP 的影片（螢幕錄影、MKV…）每次 seek 都要從前一個關鍵影格解碼，拖曳時畫面會跟不上。
 * 第一次拖曳 / 預覽某個素材時，背景用另一個 <video> 靜音快轉播一遍、邊播邊抽小張影格（不用一格一格 seek：
 * 長 GOP 的影片每次 seek 都要解幾百格）；要求的位置還沒抽到就先跳過去再接著播。
 * 精準的 seek 還沒完成前，預覽先用最接近的快取影格頂著。
 */
import type { Media } from '../store';
import { previewUrl } from './proxy';

const H = 200; // 影格高度（px）
const MAX_FRAMES = 480;

interface Entry {
  id: string;
  url: string;
  step: number;
  frames: (ImageBitmap | null)[];
  video: HTMLVideoElement | null;
  running: boolean;
  want: number; // 最近被要求的影格
  asked: number; // 最近一次被要求的時間（performance.now）
}

/**
 * 一次只抽一個素材（每個都開一個隱藏 <video> 快轉的話，素材一多就把解碼器塞滿，預覽本身反而出不了畫面）；
 * 別的素材被要求時，目前這個抽完要求位置附近就讓出來。時間軸播放中整個停下來（讓解碼器給預覽用）。
 */
let runner: Entry | null = null;
const waiting = new Set<Entry>();
let held = false;
/** 時間軸播放中：停止抽影格（渲染器每格呼叫） */
export function holdScrub(on: boolean) {
  if (held === on) return;
  held = on;
  if (!on) kick();
}
function kick(e?: Entry) {
  if (e) waiting.add(e);
  if (held || runner) return;
  let next: Entry | null = null;
  for (const x of waiting) if (!next || x.asked > next.asked) next = x;
  if (!next) return;
  waiting.delete(next);
  runner = next;
  void run(next).finally(() => {
    runner = null;
    // 放掉隱藏的 <video>（閒置的也占著解碼器）；接著抽時再建立
    const v = next!.video;
    if (v) { v.pause(); v.removeAttribute('src'); v.load(); next!.video = null; }
    if (nextIndex(next!) >= 0 && cache.get(next!.id) === next) waiting.add(next!); // 還沒抽完：之後再接著抽
    kick();
  });
}
/** 該讓出來了：播放中，或別的素材比較晚被要求、而且這個的要求位置附近已經抽好了 */
function yieldNow(e: Entry) {
  if (held) return true;
  let later = false;
  for (const x of waiting) if (x !== e && x.asked > e.asked) later = true;
  if (!later) return false;
  for (let d = -8; d <= 8; d++) {
    const i = e.want + d;
    if (i >= 0 && i < e.frames.length && !e.frames[i]) return false;
  }
  return true;
}

const cache = new Map<string, Entry>();

function entryFor(m: Media): Entry {
  let e = cache.get(m.id);
  const url = previewUrl(m);
  // 換成代理檔（內容一樣）：已經抽好的影格照用，之後改從代理檔抽（快很多）
  if (e && e.url !== url && e.url === m.url) {
    e.url = url;
    if (e.video && !e.running) { e.video.removeAttribute('src'); e.video.load(); e.video = null; }
  }
  if (e && e.url === url) return e;
  e?.frames.forEach((f) => f?.close());
  const step = Math.max(0.25, m.duration / MAX_FRAMES);
  e = { id: m.id, url, step, frames: new Array(Math.ceil(m.duration / step) + 1).fill(null), video: null, running: false, want: 0, asked: 0 };
  cache.set(m.id, e);
  return e;
}

/** 下一個要抽的影格：從最近被要求的位置往兩邊擴散 */
function nextIndex(e: Entry): number {
  const n = e.frames.length;
  for (let d = 0; d < n; d++) {
    for (const i of [e.want + d, e.want - d]) if (i >= 0 && i < n && !e.frames[i]) return i;
  }
  return -1;
}

function seekTo(v: HTMLVideoElement, t: number) {
  return new Promise<void>((res) => {
    const done = () => {
      v.removeEventListener('seeked', done);
      clearTimeout(timer);
      res();
    };
    const timer = setTimeout(done, 3000);
    v.addEventListener('seeked', done);
    v.currentTime = t;
  });
}

async function run(e: Entry) {
  if (e.running) return;
  e.running = true;
  try {
    if (!e.video) {
      const v = document.createElement('video');
      v.muted = true;
      v.playsInline = true;
      v.preload = 'auto';
      v.src = e.url;
      e.video = v;
      await new Promise<void>((res) => {
        if (v.readyState >= 1) return res();
        v.addEventListener('loadedmetadata', () => res(), { once: true });
        v.addEventListener('error', () => res(), { once: true });
      });
    }
    const v = e.video;
    if (!v.videoWidth) return;
    const W = Math.max(2, Math.round((H * v.videoWidth) / v.videoHeight));
    const grab = async (i: number) => {
      try {
        e.frames[i] = await createImageBitmap(v, { resizeWidth: W, resizeHeight: H, resizeQuality: 'low', imageOrientation: 'flipY' }); // WebGL 對 ImageBitmap 不套 UNPACK_FLIP_Y，這裡先翻好
        return true;
      } catch {
        return false;
      }
    };
    if (!(await scan(e, v, grab))) {
      // 快轉播不了（頁面在背景時畫面通知不會來…）：一格一格 seek
      let i: number;
      while ((i = nextIndex(e)) >= 0) {
        if (cache.get(e.id) !== e || yieldNow(e)) return; // 素材換掉了 / 讓給別的
        await seekTo(v, frameTime(e, i, v.duration));
        if (!(await grab(i))) return;
        await new Promise((r) => setTimeout(r, 0));
      }
    }
  } finally {
    e.running = false;
  }
}

type RvfcVideo = HTMLVideoElement & { requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number };

/**
 * 快轉播一遍抽影格：每次畫面更新抓最接近的那一格（還沒抓過的話）；要求的位置（want）離目前播的地方很遠、
 * 又還沒抽到 → 跳過去接著播；播到結尾還有缺的就跳到最近的缺口。全部抽完回傳 true，停住太久回傳 false。
 */
async function scan(e: Entry, v0: HTMLVideoElement, grab: (i: number) => Promise<boolean>): Promise<boolean> {
  const v = v0 as RvfcVideo;
  if (!v.requestVideoFrameCallback) return false;
  const n = e.frames.length;
  return new Promise<boolean>((res) => {
    let last = performance.now();
    let busy = false;
    let done = false;
    const end = (ok: boolean) => {
      if (done) return;
      done = true;
      clearInterval(watch);
      v.pause();
      res(ok);
    };
    const watch = setInterval(() => {
      if (cache.get(e.id) !== e || yieldNow(e)) end(true);
      else if (performance.now() - last > 2000) end(false);
    }, 500);
    const jump = (i: number) => { v.currentTime = frameTime(e, i, v.duration); };
    const tick = async (_now: number, meta: { mediaTime: number }) => {
      if (done) return;
      last = performance.now();
      if (cache.get(e.id) !== e || yieldNow(e)) return end(true);
      const i = Math.max(0, Math.min(n - 1, Math.round(meta.mediaTime / e.step)));
      if (!e.frames[i] && !busy && Math.abs(meta.mediaTime - frameTime(e, i, v.duration)) < e.step * 0.6) {
        busy = true;
        if (!(await grab(i))) return end(false);
        busy = false;
      }
      const next = nextIndex(e);
      if (next < 0) return end(true);
      // 被要求的位置還沒抽到、離現在播的地方超過 8 格（或已經播過頭）→ 跳過去
      if (!e.frames[e.want] && (e.want < i || e.want - i > 8)) jump(next);
      else if (v.ended || meta.mediaTime >= v.duration - e.step * 0.5) jump(next);
      if (v.paused) void v.play().catch(() => end(false));
      v.requestVideoFrameCallback!(tick);
    };
    v.onended = () => {
      const next = nextIndex(e);
      if (next < 0) return end(true);
      jump(next);
      void v.play().catch(() => end(false));
    };
    v.requestVideoFrameCallback(tick);
    // 每次畫面更新（約 60Hz）前進不超過 0.9 格，才不會漏抽
    v.playbackRate = Math.max(2, Math.min(16, e.step * 60 * 0.9));
    jump(Math.max(0, nextIndex(e)));
    void v.play().catch(() => end(false));
  });
}

/** 第 i 張快取影格是在素材的第幾秒抽的（跟 run() 的 seek 位置一樣） */
const frameTime = (e: Entry, i: number, duration: number) => Math.max(0, Math.min(duration - 0.01, i * e.step));

/**
 * 取得素材在 t 秒最接近的快取影格，連同它實際的時間（沒有就回傳 null，並開始在背景抽）。
 * 快取影格之間至少差 0.25 秒：要對齊其他東西（例如 AI 去背的遮罩）時要用回傳的 t，不能用要求的時間。
 */
export function scrubFrameAt(m: Media, t: number): { bm: ImageBitmap; t: number } | null {
  if (m.kind !== 'video' || m.missing || !m.url) return null;
  const e = entryFor(m);
  const i = Math.max(0, Math.min(e.frames.length - 1, Math.round(t / e.step)));
  e.want = i;
  e.asked = performance.now();
  kick(e);
  // 最近的已抽好的影格（最多差 2 格）
  for (let d = 0; d <= 2; d++) {
    for (const j of [i - d, i + d]) {
      const f = e.frames[j];
      if (f) return { bm: f, t: frameTime(e, j, m.duration) };
    }
  }
  return null;
}

/** 取得素材在 t 秒最接近的快取影格（沒有就回傳 null，並開始在背景抽） */
export function scrubFrame(m: Media, t: number): ImageBitmap | null {
  return scrubFrameAt(m, t)?.bm ?? null;
}

/** 快取影格的間距（秒） */
export const scrubStep = (m: Media) => entryFor(m).step;

/** 預先開始抽（打開素材預覽、選範圍視窗時就先抽，拖曳時才有得用） */
export function warmScrub(m: Media, t = 0) {
  scrubFrameAt(m, t);
}
