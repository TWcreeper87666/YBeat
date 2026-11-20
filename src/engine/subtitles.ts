import { DEFAULT_TEXT, TEXT_PRESETS } from './text';
import { makeClip, uid, useStore, type Clip } from '../store';

export interface Cue { start: number; end: number; text: string }
export const isCaptionClip = (c: Clip) => !!c.text && (c.caption ?? (c.name === 'SRT' || c.name === 'LRC'));

const parseTime = (s: string) => {
  const m = s.trim().match(/^(\d+):(\d{2}):(\d{2})[,.](\d{1,3})$/);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0')) / 1000 : NaN;
};

export function parseSrt(input: string): Cue[] {
  const cues: Cue[] = [];
  for (const block of input.replace(/^\uFEFF/, '').replace(/\r/g, '').trim().split(/\n\s*\n/)) {
    const lines = block.split('\n');
    const at = lines.findIndex((l) => l.includes('-->'));
    if (at < 0) continue;
    const [a, b] = lines[at].split('-->');
    const start = parseTime(a), end = parseTime(b);
    const text = lines.slice(at + 1).join('\n').trim();
    if (Number.isFinite(start) && Number.isFinite(end) && end > start && text) cues.push({ start, end, text });
  }
  return cues;
}

const stamp = (n: number) => {
  const ms = Math.round(n * 1000);
  const p = (v: number, w = 2) => String(v).padStart(w, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
};

export function writeSrt(clips: Clip[]): string {
  return clips.filter((c) => c.text?.text.trim()).sort((a, b) => a.start - b.start).map((c, i) => `${i + 1}\n${stamp(c.start)} --> ${stamp(c.start + c.duration)}\n${c.text!.text.trim()}\n`).join('\n');
}

export function parseLrc(input: string): Cue[] {
  const lines: { start: number; text: string }[] = [];
  for (const line of input.replace(/^\uFEFF/, '').replace(/\r/g, '').split('\n')) {
    const text = line.replace(/\[(\d+):(\d{2})(?:[.:](\d{1,3}))?\]/g, '').trim();
    if (!text) continue;
    for (const m of line.matchAll(/\[(\d+):(\d{2})(?:[.:](\d{1,3}))?\]/g)) {
      const start = Number(m[1]) * 60 + Number(m[2]) + Number((m[3] ?? '0').padEnd(3, '0')) / 1000;
      lines.push({ start, text });
    }
  }
  lines.sort((a, b) => a.start - b.start);
  return lines.map((line, i) => ({ start: line.start, end: Math.max(line.start + .1, lines[i + 1]?.start ?? line.start + 3), text: line.text }));
}

export function writeLrc(clips: Clip[]): string {
  return clips.filter((c) => c.text?.text.trim()).sort((a, b) => a.start - b.start).map((c) => {
    const cs = Math.round(c.start * 100);
    return `[${String(Math.floor(cs / 6000)).padStart(2, '0')}:${String(Math.floor(cs / 100) % 60).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}]${c.text!.text.trim().replace(/\s*\n\s*/g, ' ')}`;
  }).join('\n') + '\n';
}

export function addSrtCues(cues: Cue[], source: 'SRT' | 'LRC' = 'SRT'): number {
  if (!cues.length) return 0;
  const s = useStore.getState();
  const track = s.tracks.video.length;
  s.addTrack('video');
  const preset = TEXT_PRESETS.find((p) => p.id === 'subtitle')!;
  const clips = cues.map((cue) => makeClip({
    id: uid(), mediaId: '', track, start: cue.start, duration: cue.end - cue.start,
    fit: 'contain', name: source, caption: true, text: { ...DEFAULT_TEXT, ...preset.style, text: cue.text },
    transform: { ...makeClip({ mediaId: '' }).transform, y: preset.y },
  }));
  useStore.setState({ clips: [...useStore.getState().clips, ...clips] });
  return clips.length;
}
