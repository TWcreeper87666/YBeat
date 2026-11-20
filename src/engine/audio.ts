import type { AudioClip, Clip, Media, Tracks } from '../store';
import type { Module } from '../modules/builtin';
import { plainSpeed } from './remap';
import { timeStretch } from './stretch';

export const SAMPLE_RATE = 48000;

// ───────────── 解碼 / 波形 ─────────────

const buffers = new Map<string, Promise<AudioBuffer | null>>();

/** 解碼素材音訊（快取，重新取樣到 48kHz） */
export function getAudioBuffer(url: string): Promise<AudioBuffer | null> {
  let p = buffers.get(url);
  if (!p) {
    p = (async () => {
      try {
        const ab = await (await fetch(url)).arrayBuffer();
        return await new OfflineAudioContext(2, 1, SAMPLE_RATE).decodeAudioData(ab);
      } catch {
        return null;
      }
    })();
    buffers.set(url, p);
  }
  return p;
}

export const PEAKS_PER_SEC = 100;
export function computePeaks(buf: AudioBuffer): number[] {
  const n = Math.ceil(buf.duration * PEAKS_PER_SEC);
  const step = buf.sampleRate / PEAKS_PER_SEC;
  const chans = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i));
  const out = new Array<number>(n);
  let max = 1e-6;
  for (let i = 0; i < n; i++) {
    let m = 0;
    const a = Math.floor(i * step), b = Math.min(buf.length, Math.floor((i + 1) * step));
    for (const ch of chans) for (let j = a; j < b; j += 4) m = Math.max(m, Math.abs(ch[j]));
    out[i] = m;
    max = Math.max(max, m);
  }
  return out.map((v) => Math.round((v / max) * 1000) / 1000);
}

export function fadeGain(a: AudioClip, local: number) {
  let g = 1;
  if (a.fadeIn > 0) g = Math.min(g, local / a.fadeIn);
  if (a.fadeOut > 0) g = Math.min(g, (a.duration - local) / a.fadeOut);
  return Math.min(1, Math.max(0, g));
}

// ───────────── 要播放的聲音（預覽與匯出共用）─────────────

/** 一段要播放的聲音：時間軸 start 起播放素材 in 秒處，長 duration（時間軸秒），速率 rate */
export interface AudioPlanItem {
  url: string;
  start: number;
  duration: number;
  in: number;
  rate: number;
  volume: number;
  fadeIn: number;
  fadeOut: number;
  /** 變速時保持音調 */
  keepPitch: boolean;
}

type PlanInput = { audios: AudioClip[]; clips: Clip[]; media: Media[]; tracks: Tracks };

export function audioPlan(s: PlanInput, modules: Map<string, Module>): AudioPlanItem[] {
  const media = new Map(s.media.map((m) => [m.id, m]));
  const out: AudioPlanItem[] = [];
  for (const a of s.audios) {
    const m = media.get(a.mediaId);
    if (!m || m.missing || audioMuted(s, a) || a.volume <= 0) continue;
    out.push({ url: m.url, start: a.start, duration: a.duration, in: a.in, rate: a.rate ?? 1, volume: a.volume, fadeIn: a.fadeIn, fadeOut: a.fadeOut, keepPitch: a.keepPitch !== false });
  }
  // 影片原音：只有一般變速（非倒放 / 非自訂重映射）的片段會帶聲音
  for (const c of s.clips) {
    const m = media.get(c.mediaId);
    if (!m || m.missing || m.kind !== 'video' || !m.hasAudio || c.volume <= 0 || s.tracks.video[c.track]?.muted) continue;
    if (c.link && s.audios.some((a) => a.link === c.link)) continue; // 聲音由連結的音訊片段負責
    const speed = plainSpeed(c, modules);
    if (!speed) continue;
    out.push({ url: m.url, start: c.start, duration: c.duration, in: c.in, rate: speed, volume: c.volume, fadeIn: 0, fadeOut: 0, keepPitch: c.keepPitch !== false });
  }
  return out;
}

// ───────────── 保持音調的變速：只處理片段用到的那段，結果快取 ─────────────

const stretched = new Map<string, Promise<AudioBuffer | null>>();
const needsStretch = (p: AudioPlanItem) => p.keepPitch && Math.abs(p.rate - 1) > 1e-3;
const stretchKey = (p: AudioPlanItem) => `${p.url}|${p.in.toFixed(4)}|${(p.duration * p.rate).toFixed(4)}|${p.rate.toFixed(5)}`;

/**
 * 取得要播放的音訊：一般情況直接用解碼好的素材；保持音調的變速片段 → 先做成「已經變速、音調不變」的那一段，
 * 之後以 1× 播放（回傳改寫過的 in / rate）。
 */
function sourceFor(p: AudioPlanItem): Promise<{ buf: AudioBuffer; p: AudioPlanItem } | null> {
  if (!needsStretch(p)) return getAudioBuffer(p.url).then((buf) => (buf ? { buf, p } : null));
  const key = stretchKey(p);
  let job = stretched.get(key);
  if (!job) {
    job = getAudioBuffer(p.url).then((src) => {
      if (!src) return null;
      const a = Math.max(0, Math.floor(p.in * src.sampleRate));
      const b = Math.min(src.length, Math.ceil((p.in + p.duration * p.rate) * src.sampleRate));
      if (b <= a) return null;
      const chans = Array.from({ length: src.numberOfChannels }, (_, i) => src.getChannelData(i).subarray(a, b));
      const out = timeStretch(chans, p.rate);
      const buf = new AudioBuffer({ length: out[0].length, numberOfChannels: out.length, sampleRate: src.sampleRate });
      out.forEach((d, i) => buf.copyToChannel(d, i));
      return buf;
    });
    stretched.set(key, job);
    // 快取別無限長大（拖速度滑桿時會產生很多版本）
    if (stretched.size > 48) stretched.delete(stretched.keys().next().value!);
  }
  return job.then((buf) => (buf ? { buf, p: { ...p, in: 0, rate: 1 } } : null));
}

/**
 * 把一段聲音排進 AudioContext。
 * c0 = 時間軸 t0 對應的 context 時間；已經過去的部分會從中間開始播。
 */
function schedule(ctx: BaseAudioContext, dest: AudioNode, buf: AudioBuffer, p: AudioPlanItem, t0: number, c0: number) {
  const now = 'currentTime' in ctx ? ctx.currentTime : 0;
  const end = p.start + p.duration;
  if (end <= t0) return null;
  let when = c0 + (p.start - t0);
  let offset = p.in;
  let dur = p.duration;
  const skip = Math.max(0, Math.max(now, c0) - when); // 已經錯過的時間軸秒數
  if (skip >= dur) return null;
  when += skip;
  offset += skip * p.rate;
  dur -= skip;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = p.rate;
  const g = ctx.createGain();
  // 音量 / 淡入淡出：時間軸時間 T → context 時間 c0 + (T - t0)
  const at = (T: number) => c0 + (T - t0);
  const gain = (local: number) => {
    let k = 1;
    if (p.fadeIn > 0) k = Math.min(k, local / p.fadeIn);
    if (p.fadeOut > 0) k = Math.min(k, (p.duration - local) / p.fadeOut);
    return p.volume * Math.min(1, Math.max(0, k));
  };
  const local0 = when - c0 + t0 - p.start;
  g.gain.setValueAtTime(gain(local0), when);
  if (p.fadeIn > 0 && local0 < p.fadeIn) g.gain.linearRampToValueAtTime(p.volume, at(p.start + p.fadeIn));
  if (p.fadeOut > 0) {
    const fs = Math.max(local0, p.duration - p.fadeOut);
    g.gain.setValueAtTime(gain(fs), at(p.start + fs));
    g.gain.linearRampToValueAtTime(0, at(end));
  }
  src.connect(g).connect(dest);
  src.start(when, offset, dur * p.rate);
  return src;
}

// ───────────── 預覽播放（Web Audio：用 AudioContext 的時鐘排程，不會因為 <audio> 元素對時而卡頓）─────────────

let actx: AudioContext | null = null;
/** 正在播放 / 排程中的聲音：key = 這段聲音的所有參數；內容改了只換掉變動的那幾段，其他繼續播（不會卡頓） */
type LiveItem = { node: AudioBufferSourceNode | null; dead: boolean };
let live = new Map<string, LiveItem>();
/** 目前排程對應的時間軸起點與 context 時間 */
let anchor: { t0: number; c0: number } | null = null;
let lastInput: unknown[] = [];
/** 上一次看到的時間軸時間與畫面時鐘（偵測跳動用） */
let tick: { t: number; perf: number } | null = null;
let modMap: { src: Module[] | null; map: Map<string, Module> } = { src: null, map: new Map() };
let prepTimer: ReturnType<typeof setTimeout> | undefined;

const planKey = (p: AudioPlanItem) =>
  `${p.url}|${p.start}|${p.duration}|${p.in}|${p.rate}|${p.volume}|${p.fadeIn}|${p.fadeOut}|${p.keepPitch}`;

function killItem(it: LiveItem) {
  it.dead = true;
  if (!it.node) return;
  try { it.node.stop(); } catch { /* 還沒開始 */ }
  it.node.disconnect();
}

function stopLive() {
  for (const it of live.values()) killItem(it);
  live = new Map();
  anchor = null;
  tick = null;
}

/** 把計畫裡還沒在播的聲音排進去、已經不在計畫裡的停掉（相同的不動） */
function reconcile(ctx: AudioContext, plan: AudioPlanItem[]) {
  const { t0, c0 } = anchor!;
  const next = new Map<string, LiveItem>();
  const tNow = t0 + (ctx.currentTime - c0); // 現在的時間軸時間
  for (const p of plan) {
    const key = planKey(p);
    if (next.has(key)) continue;
    const old = live.get(key);
    if (old) {
      next.set(key, old);
      continue;
    }
    if (p.start + p.duration <= tNow) continue;
    const it: LiveItem = { node: null, dead: false };
    next.set(key, it);
    void sourceFor(p).then((r) => {
      if (!r || it.dead) return;
      it.node = schedule(ctx, ctx.destination, r.buf, r.p, t0, c0);
    });
  }
  for (const [k, it] of live) if (!next.has(k)) killItem(it);
  live = next;
}

export function syncAudioPreview(s: PlanInput & { modules: Module[] }, t: number, playing: boolean) {
  if (modMap.src !== s.modules) modMap = { src: s.modules, map: new Map(s.modules.map((m) => [m.id, m])) };
  const input = [s.audios, s.clips, s.media, s.tracks, s.modules];
  const changed = input.some((x, i) => x !== lastInput[i]);
  lastInput = input;
  const plan = changed || !anchor ? audioPlan(s, modMap.map) : null;
  if (changed) {
    for (const p of plan!) void getAudioBuffer(p.url); // 先解碼，按下播放時就有聲音
    // 保持音調的變速片段：停止編輯一下子之後才預先處理（拖速度滑桿時不要每一格都算）
    clearTimeout(prepTimer);
    prepTimer = setTimeout(() => {
      for (const p of audioPlan(s, modMap.map)) if (needsStretch(p)) void sourceFor(p);
    }, 400);
  }
  if (!playing) {
    if (anchor) stopLive();
    return;
  }
  actx ??= new AudioContext({ latencyHint: 'interactive' });
  // 還沒開始跑（瀏覽器的自動播放限制、剛建立）：時鐘不會動，等它跑起來再排程，不然會一直重排
  if (actx.state !== 'running') {
    void actx.resume();
    if (anchor) stopLive();
    return;
  }
  // 時間軸跳動（拖播放頭、循環、Home/End）→ 全部重新排程。
  // 用畫面時鐘判斷「跳動」：AudioContext 剛啟動時 currentTime 會停一下，拿它比會誤判
  const now = performance.now();
  const jumped = !tick || Math.abs(t - (tick.t + (now - tick.perf) / 1000)) > 0.25;
  tick = { t, perf: now };
  if (jumped || !anchor) {
    stopLive();
    tick = { t, perf: now };
    anchor = { t0: t, c0: actx.currentTime + 0.02 };
    reconcile(actx, plan ?? audioPlan(s, modMap.map));
    return;
  }
  // 內容改了（拖片段、改音量…）：只換掉有變動的聲音，跟這次編輯無關的繼續播
  if (changed) reconcile(actx, plan!);
}

export function stopAudioPreview() {
  stopLive();
}

// ───────────── 匯出混音 ─────────────

/** 混音：時間軸 start 秒起、長 duration 秒（只輸出循環範圍時 start > 0） */
export async function mixdown(s: PlanInput, modules: Map<string, Module>, duration: number, start = 0): Promise<AudioBuffer | null> {
  const ctx = new OfflineAudioContext(2, Math.max(1, Math.ceil(duration * SAMPLE_RATE)), SAMPLE_RATE);
  let any = false;
  for (const p of audioPlan(s, modules)) {
    if (p.start + p.duration <= start || p.start >= start + duration) continue;
    const r = await sourceFor(p);
    if (!r) continue;
    if (schedule(ctx, ctx.destination, r.buf, r.p, start, 0)) any = true;
  }
  return any ? ctx.startRendering() : null;
}

/** 音訊片段是否靜音：連結在影片上的音訊跟著影片軌的靜音，其他看音訊軌 */
export function audioMuted(s: { tracks: Tracks; clips?: Clip[] }, a: AudioClip) {
  const c = a.link ? s.clips?.find((x) => x.link === a.link) : undefined;
  if (c) return !!s.tracks.video[c.track]?.muted;
  return !!s.tracks.audio[a.track]?.muted;
}
