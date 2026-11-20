import { fitStart } from './overlap';
import { stillDur } from '../prefs';
import { keyOf, mediaUsable, spansOf, useStore, type Media, type TrackKind } from '../store';

export interface MediaPlacement {
  id: string;
  kind: 'video' | 'audio';
  track: number;
  start: number;
  duration: number;
  label: string;
  thumb?: string;
}

/** 多個素材從同一時間點依序排入可用軌道；預覽與實際插入共用此計畫。 */
export function planMediaBatch(ids: string[], at: number, target?: { kind: TrackKind; track: number }): MediaPlacement[] | null {
  const s = useStore.getState();
  const spans = spansOf(s);
  const plan: MediaPlacement[] = [];
  let cursor = at;
  if (target && s.tracks[target.kind][target.track]?.locked) return null;
  for (const id of ids) {
    const m = s.media.find((x) => x.id === id);
    if (!mediaUsable(m)) continue;
    const kind = m.kind === 'audio' ? 'audio' : 'video';
    const preferred = target?.kind === kind ? target.track : s.activeTrack?.kind === kind ? s.activeTrack.idx : kind === 'video' ? s.tracks.video.length - 1 : 0;
    const track = !s.tracks[kind][preferred]?.locked ? preferred : s.tracks[kind].findIndex((t) => !t.locked);
    if (track < 0 || !s.tracks[kind][track]) return null;
    const duration = m.kind === 'image' ? stillDur() : m.duration;
    const lane = `${kind}:${track}`;
    const start = fitStart(spans, lane, Math.max(0, cursor), duration);
    plan.push({ id, kind, track, start, duration, label: m.name, thumb: kind === 'video' ? m.thumb : undefined });
    spans.push({ lane, start, duration });
    cursor = start + duration;
  }
  return plan;
}

/** 插入後選中整組新片段，包含影片的連結音訊。 */
export function applyMediaBatch(plan: MediaPlacement[]): number {
  const keys: string[] = [];
  let count = 0;
  let primary: { type: 'clip' | 'audio'; id: string } | null = null;
  for (const p of plan) {
    const before = useStore.getState();
    const clips = new Set(before.clips.map((c) => c.id));
    const audios = new Set(before.audios.map((a) => a.id));
    if (p.kind === 'audio') before.addAudio(p.id, p.start, p.track);
    else before.addClip(p.id, p.start, p.track, before.media.find((m: Media) => m.id === p.id)?.kind === 'image' ? { in: 0, duration: p.duration } : undefined);
    const after = useStore.getState();
    if (after.clips.length > before.clips.length || after.audios.length > before.audios.length) count++;
    for (const c of after.clips) if (!clips.has(c.id)) { keys.push(keyOf('clip', c.id)); primary = { type: 'clip', id: c.id }; }
    for (const a of after.audios) if (!audios.has(a.id)) { keys.push(keyOf('audio', a.id)); if (p.kind === 'audio') primary = { type: 'audio', id: a.id }; }
  }
  if (keys.length) useStore.setState({ selected: keys, selection: primary });
  return count;
}
