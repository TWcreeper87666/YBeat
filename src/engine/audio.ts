import type { AudioClip, Clip, Media, Tracks } from '../store';
import type { Module } from '../modules/builtin';
import { plainSpeed } from './remap';

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

// ───────────── 預覽播放（音訊軌）─────────────

const els = new Map<string, HTMLAudioElement>();

export function syncAudioPreview(s: { audios: AudioClip[]; media: Media[]; tracks: Tracks; clips?: Clip[] }, t: number, playing: boolean) {
  const ids = new Set(s.audios.map((a) => a.id));
  for (const [id, el] of els) if (!ids.has(id)) { el.pause(); els.delete(id); }
  for (const a of s.audios) {
    const m = s.media.find((x) => x.id === a.mediaId);
    if (!m || m.missing) continue;
    let el = els.get(a.id);
    if (!el || el.dataset.src !== m.url) {
      el?.pause();
      el = new Audio(m.url);
      el.preload = 'auto';
      el.dataset.src = m.url;
      els.set(a.id, el);
    }
    const local = t - a.start;
    const active = playing && local >= 0 && local < a.duration && !audioMuted(s, a);
    if (!active) {
      if (!el.paused) el.pause();
      continue;
    }
    el.volume = Math.min(1, Math.max(0, a.volume * fadeGain(a, local)));
    const rate = a.rate ?? 1;
    if (Math.abs(el.playbackRate - rate) > 1e-3) el.playbackRate = Math.min(16, Math.max(0.0625, rate));
    const want = a.in + local * rate;
    if (el.paused) {
      el.currentTime = want;
      el.play().catch(() => {});
    } else if (Math.abs(el.currentTime - want) > 0.12) el.currentTime = want;
  }
}

export function stopAudioPreview() {
  for (const el of els.values()) el.pause();
}

// ───────────── 匯出混音 ─────────────

export async function mixdown(
  s: { audios: AudioClip[]; clips: Clip[]; media: Media[]; tracks: Tracks },
  modules: Map<string, Module>,
  duration: number,
): Promise<AudioBuffer | null> {
  const ctx = new OfflineAudioContext(2, Math.max(1, Math.ceil(duration * SAMPLE_RATE)), SAMPLE_RATE);
  let any = false;
  const media = new Map(s.media.map((m) => [m.id, m]));

  for (const a of s.audios) {
    const m = media.get(a.mediaId);
    if (!m || m.missing || audioMuted(s, a) || a.volume <= 0) continue;
    const buf = await getAudioBuffer(m.url);
    if (!buf) continue;
    any = true;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    const end = a.start + a.duration;
    g.gain.setValueAtTime(a.fadeIn > 0 ? 0 : a.volume, a.start);
    if (a.fadeIn > 0) g.gain.linearRampToValueAtTime(a.volume, a.start + a.fadeIn);
    if (a.fadeOut > 0) {
      g.gain.setValueAtTime(a.volume, Math.max(a.start, end - a.fadeOut));
      g.gain.linearRampToValueAtTime(0, end);
    }
    src.connect(g).connect(ctx.destination);
    src.playbackRate.value = a.rate ?? 1;
    src.start(a.start, a.in, a.duration * (a.rate ?? 1));
  }

  // 影片原音：只有一般變速（非倒放 / 非自訂重映射）的片段會帶聲音
  for (const c of s.clips) {
    const m = media.get(c.mediaId);
    if (!m || m.missing || m.kind !== 'video' || !m.hasAudio || c.volume <= 0 || s.tracks.video[c.track]?.muted) continue;
    if (c.link && s.audios.some((a) => a.link === c.link)) continue; // 聲音由連結的音訊片段負責
    const speed = plainSpeed(c, modules);
    if (!speed) continue;
    const buf = await getAudioBuffer(m.url);
    if (!buf) continue;
    any = true;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = speed;
    const g = ctx.createGain();
    g.gain.value = c.volume;
    src.connect(g).connect(ctx.destination);
    src.start(c.start, c.in, c.duration * speed);
  }
  return any ? ctx.startRendering() : null;
}

/** 音訊片段是否靜音：連結在影片上的音訊跟著影片軌的靜音，其他看音訊軌 */
export function audioMuted(s: { tracks: Tracks; clips?: Clip[] }, a: AudioClip) {
  const c = a.link ? s.clips?.find((x) => x.link === a.link) : undefined;
  if (c) return !!s.tracks.video[c.track]?.muted;
  return !!s.tracks.audio[a.track]?.muted;
}
