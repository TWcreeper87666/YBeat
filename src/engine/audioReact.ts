/**
 * 音訊反應：從素材的音量包絡（peaks）算出某個時間點的「音量」與「節拍」訊號，給特效用。
 * - level：目前所有發聲項目中最大的音量（0~1）
 * - beat：偵測到節拍（音量突然上升）時 = 1，之後快速衰減到 0
 * 全部是從預先算好的 peaks 查表，匯出時結果跟預覽完全一樣。
 */
import type { AudioClip, AudioFrom, Clip, ClipFx, FxItem, Media, Tracks } from '../store';
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

/** from 有沒有選任何軌道（都沒選 = 全部） */
export const hasFrom = (f: AudioFrom | undefined): f is AudioFrom => !!f && !!(f.audio?.length || f.video?.length);

/** 音訊反應的快取鍵（同一格裡同樣的來源只算一次） */
export const fromKey = (f: AudioFrom | undefined) => (hasFrom(f) ? `a${(f.audio ?? []).join(',')}v${(f.video ?? []).join(',')}` : '');

/**
 * 這一格的音量 / 節拍。from = 只聽這些軌道（音訊軌的片段、影片軌片段本身的聲音）；沒有 = 全部。
 */
export function audioSignal(
  s: { audios: AudioClip[]; clips: Clip[]; media: Map<string, Media>; tracks: Tracks; linked: Set<string> },
  t: number,
  from?: AudioFrom,
): AudioSignal {
  const f = hasFrom(from) ? from : null;
  const srcs: Src[] = [];
  for (const a of s.audios) {
    if (t < a.start || t >= a.start + a.duration || audioMuted(s, a)) continue;
    // 連結在影片片段上的聲音算那條影片軌的
    const owner = f && a.link && s.linked.has(a.link) ? s.clips.find((c) => c.link === a.link) : undefined;
    if (f && (owner ? !f.video?.includes(owner.track) : !f.audio?.includes(a.track))) continue;
    const m = s.media.get(a.mediaId);
    if (!m?.peaks || m.missing) continue;
    const rate = a.rate ?? 1;
    srcs.push({ media: m, src: a.in + (t - a.start) * rate, gain: a.volume, rate, local: t - a.start });
  }
  for (const c of s.clips) {
    if (t < c.start || t >= c.start + c.duration || (c.link && s.linked.has(c.link)) || s.tracks.video[c.track]?.muted) continue;
    if (f && !f.video?.includes(c.track)) continue;
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

/**
 * 軌道新增 / 刪除 / 換順序後，音訊反應的來源軌道跟著換索引。
 * map(舊索引) = 新索引；null = 軌道被刪掉（從來源拿掉）。沒變的物件原樣回傳。
 */
export function remapDriveTracks(s: { clips: Clip[]; effects: FxItem[] }, kind: 'audio' | 'video', map: (i: number) => number | null): { clips: Clip[]; effects: FxItem[] } {
  const fixFrom = (f: AudioFrom): AudioFrom | undefined => {
    const l = f[kind];
    if (!l?.length) return f;
    const n = l.map(map).filter((x): x is number => x !== null);
    const next: AudioFrom = { ...f, [kind]: n.length ? n : undefined };
    return hasFrom(next) ? next : undefined;
  };
  const fixAudio = <T extends { audio?: Record<string, import('../store').AudioDrive> }>(x: T): T => {
    if (!x.audio || !Object.values(x.audio).some((d) => d.from?.[kind]?.length)) return x;
    const audio = Object.fromEntries(Object.entries(x.audio).map(([k, d]) => {
      if (!d.from) return [k, d];
      const from = fixFrom(d.from);
      const { from: _, ...rest } = d;
      return [k, from ? { ...rest, from } : rest];
    }));
    return { ...x, audio };
  };
  const fixList = (l: ClipFx[] | undefined) => {
    if (!l) return l;
    const n = l.map(fixAudio);
    return n.some((x, i) => x !== l[i]) ? n : l;
  };
  const clips = s.clips.map((c) => {
    const effects = fixList(c.effects);
    return effects === c.effects ? c : { ...c, effects };
  });
  const effects = s.effects.map((e) => {
    const a = fixAudio(e);
    const stack = fixList(a.stack);
    return stack === a.stack ? a : { ...a, stack };
  });
  return { clips, effects };
}
