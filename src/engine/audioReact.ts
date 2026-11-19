/**
 * 音訊反應：從素材的音量包絡（peaks）算出某個時間點的「音量」與「節拍」訊號，給特效用。
 * - level：目前所有發聲項目中最大的音量（0~1）
 * - beat：偵測到節拍（音量突然上升）時 = 1，之後快速衰減到 0
 * 全部是從預先算好的 peaks 查表，匯出時結果跟預覽完全一樣。
 */
import type { AudioClip, Clip, Media, Tracks } from '../store';
import { audioMuted } from './audio';

const onsetCache = new WeakMap<number[], number[]>();

/** 素材的節拍時間點（素材內秒數） */
function onsets(peaks: number[], pps: number): number[] {
  const hit = onsetCache.get(peaks);
  if (hit) return hit;
  const out: number[] = [];
  const win = Math.max(1, Math.round(pps * 0.3));
  const gap = pps * 0.12;
  let sum = 0;
  let last = -Infinity;
  for (let i = 0; i < peaks.length; i++) {
    sum += peaks[i];
    if (i >= win) sum -= peaks[i - win];
    const mean = sum / Math.min(i + 1, win);
    const v = peaks[i];
    const rising = i > 0 && v > peaks[i - 1];
    const peak = i + 1 >= peaks.length || v >= peaks[i + 1];
    if (rising && peak && v > mean * 1.35 + 0.06 && i - last >= gap) {
      out.push(i / pps);
      last = i;
    }
  }
  onsetCache.set(peaks, out);
  return out;
}

interface Src { media: Media; src: number; gain: number; rate: number; local: number }

export interface AudioSignal { level: number; beat: number }

export function audioSignal(
  s: { audios: AudioClip[]; clips: Clip[]; media: Map<string, Media>; tracks: Tracks; linked: Set<string> },
  t: number,
): AudioSignal {
  const srcs: Src[] = [];
  for (const a of s.audios) {
    if (t < a.start || t >= a.start + a.duration || audioMuted(s, a)) continue;
    const m = s.media.get(a.mediaId);
    if (!m?.peaks || m.missing) continue;
    const rate = a.rate ?? 1;
    srcs.push({ media: m, src: a.in + (t - a.start) * rate, gain: a.volume, rate, local: t - a.start });
  }
  for (const c of s.clips) {
    if (t < c.start || t >= c.start + c.duration || (c.link && s.linked.has(c.link)) || s.tracks.video[c.track]?.muted) continue;
    const m = s.media.get(c.mediaId);
    if (!m?.peaks || m.missing || m.kind !== 'video') continue;
    const rate = c.rate ?? 1;
    srcs.push({ media: m, src: c.in + (t - c.start) * rate, gain: c.volume, rate, local: t - c.start });
  }
  let level = 0, beat = 0;
  for (const x of srcs) {
    const pps = x.media.peaksPerSec || 100;
    const peaks = x.media.peaks!;
    // 前後 30ms 取最大，避免數值跳動
    const i0 = Math.max(0, Math.floor((x.src - 0.03) * pps));
    const i1 = Math.min(peaks.length - 1, Math.ceil((x.src + 0.03) * pps));
    let v = 0;
    for (let i = i0; i <= i1; i++) v = Math.max(v, peaks[i]);
    level = Math.max(level, Math.min(1, v * x.gain));
    // 最近的一個節拍（不早於片段開頭）
    const list = onsets(peaks, pps);
    let lo = 0, hi = list.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid] <= x.src) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (best >= 0) {
      const dt = (x.src - list[best]) / Math.max(0.05, x.rate);
      if (dt <= x.local + 1e-6) beat = Math.max(beat, Math.exp(-dt * 9));
    }
  }
  return { level, beat };
}
