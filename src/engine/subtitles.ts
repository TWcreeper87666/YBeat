import { DEFAULT_TEXT, TEXT_PRESETS } from './text';
import { makeClip, uid, useStore, type Clip } from '../store';
import type { Tracks } from './tracks';

export interface Cue { start: number; end: number; text: string }
/** 文字片段都算字幕；要排除整條軌道用軌道的「不接收字幕」 */
export const isCaptionClip = (c: Clip) => !!c.text;

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
    fit: 'contain', name: source, text: { ...DEFAULT_TEXT, ...preset.style, text: cue.text },
    transform: { ...makeClip({ mediaId: '' }).transform, y: preset.y },
  }));
  useStore.setState({ clips: [...useStore.getState().clips, ...clips] });
  return clips.length;
}

// ───────────── 字幕清單編輯 ─────────────

/** 字幕／歌詞分頁要接收的字幕（排除設成不接收字幕的影片軌），依時間排序 */
export const captionList = (clips: Clip[], tracks?: Tracks) =>
  clips.filter((c) => isCaptionClip(c) && !tracks?.video[c.track]?.noCaptions).sort((a, b) => a.start - b.start || a.track - b.track);
const received = () => { const s = useStore.getState(); return captionList(s.clips, s.tracks); };
const isReceived = (c: Clip) => isCaptionClip(c) && !useStore.getState().tracks.video[c.track]?.noCaptions;

/** 切換某條影片軌是否接收字幕 */
export function setTrackCaptions(idx: number, on: boolean) {
  const s = useStore.getState();
  if (!s.tracks.video[idx]) return;
  useStore.setState({ tracks: { ...s.tracks, video: s.tracks.video.map((t, i) => (i === idx ? { ...t, noCaptions: on ? undefined : true } : t)) } });
}

/** 秒 → 00:12.34（超過一小時加上時） */
export function formatTc(t: number): string {
  const cs = Math.max(0, Math.round(t * 100));
  const p = (v: number) => String(v).padStart(2, '0');
  const h = Math.floor(cs / 360000);
  return `${h ? `${h}:` : ''}${p(Math.floor(cs / 6000) % 60)}:${p(Math.floor(cs / 100) % 60)}.${p(cs % 100)}`;
}

/** 接受 83.5、1:23.45、0:01:23,450 */
export function parseTc(raw: string): number {
  const parts = raw.trim().replace(',', '.').split(':');
  if (parts.length > 3 || parts.some((x, i) => !(i === parts.length - 1 ? /^\d+(\.\d*)?$|^\.\d+$/ : /^\d+$/).test(x))) return NaN;
  return parts.reduce((acc, x) => acc * 60 + Number(x), 0);
}

const CJK = /[぀-ヿ㐀-鿿가-힯＀-￯]/g;
/** 每秒字數；中日韓文字超過 9、其他超過 20 算太快 */
export function readingSpeed(text: string, duration: number): { cps: number; fast: boolean } {
  const chars = text.replace(/\s/g, '').length;
  const cps = duration > 0 ? chars / duration : Infinity;
  const cjk = (text.match(CJK)?.length ?? 0) * 2 > chars;
  return { cps, fast: cps > (cjk ? 9 : 20) };
}

const locked = (c: Clip) => !!useStore.getState().tracks.video[c.track]?.locked;
const freshFx = (c: Clip) => c.effects?.map((f) => ({ ...structuredClone(f), id: uid() }));

/** 在 time 加一段空白字幕（播放頭在某段字幕裡 → 接在那段後面）；樣式沿用附近的字幕。回傳新片段 id */
export function addCue(time: number): string | null {
  let s = useStore.getState();
  const caps = captionList(s.clips, s.tracks);
  const cur = caps.find((c) => time >= c.start - 1e-4 && time < c.start + c.duration - 1e-4);
  let start = cur ? cur.start + cur.duration : Math.max(0, time);
  const ref = cur ?? [...caps].reverse().find((c) => c.start <= start) ?? caps[0];
  let track: number;
  if (ref) track = ref.track;
  else {
    track = s.tracks.video.length;
    s.addTrack('video');
    s = useStore.getState();
  }
  if (s.tracks.video[track]?.locked) return null;
  const same = s.clips.filter((c) => c.track === track).sort((a, b) => a.start - b.start);
  for (const c of same) if (start >= c.start - 1e-4 && start < c.start + c.duration - 1e-4) start = c.start + c.duration;
  const next = same.find((c) => c.start >= start - 1e-4);
  const duration = Math.min(2, next ? next.start - start : Infinity);
  if (!(duration >= 0.1)) return null;
  const preset = TEXT_PRESETS.find((p) => p.id === 'subtitle')!;
  const base = makeClip({ mediaId: '' });
  const clip = makeClip({
    id: uid(), mediaId: '', track, start, duration, fit: 'contain',
    text: { ...(ref?.text ?? { ...DEFAULT_TEXT, ...preset.style }), text: '' },
    transform: ref ? { ...ref.transform } : { ...base.transform, y: preset.y },
    transitionIn: ref?.transitionIn ? structuredClone(ref.transitionIn) : null,
    transitionOut: ref?.transitionOut ? structuredClone(ref.transitionOut) : null,
    effects: ref ? freshFx(ref) : undefined,
  });
  useStore.setState({ clips: [...s.clips, clip], selection: { type: 'clip', id: clip.id }, selected: [`clip:${clip.id}`] });
  return clip.id;
}

/** 文字從 at 切開；沒給或在頭尾 → 找最靠近中間的空白，沒有就從中間切 */
function splitText(text: string, at?: number): [string, string] {
  if (at === undefined || at <= 0 || at >= text.length) {
    const mid = text.length / 2;
    let best = -1;
    for (const m of text.matchAll(/[\s，。、！？,.!?]/g)) if (best < 0 || Math.abs(m.index! + 1 - mid) < Math.abs(best - mid)) best = m.index! + 1;
    at = best > 0 && best < text.length ? best : Math.ceil(mid);
  }
  return [text.slice(0, at).trim(), text.slice(at).trim()];
}

/** 把一段字幕切成兩段：時間切在 time（不在片段裡就切在中間），文字切在游標位置。回傳後段 id */
export function splitCue(id: string, time: number, caret?: number): string | null {
  const s = useStore.getState();
  const c = s.clips.find((x) => x.id === id);
  if (!c?.text || locked(c) || c.duration < 0.2) return null;
  const t = time > c.start + 0.1 && time < c.start + c.duration - 0.1 ? time : c.start + c.duration / 2;
  const [a, b] = splitText(c.text.text, caret);
  useStore.setState({ selection: { type: 'clip', id }, selected: [`clip:${id}`] });
  useStore.getState().splitAtTimes([t]);
  const after = useStore.getState();
  const back = after.clips.find((x) => x.id !== id && x.track === c.track && Math.abs(x.start - t) < 1e-4);
  useStore.setState({
    clips: after.clips.map((x) => (x.id === id ? { ...x, text: { ...x.text!, text: a } } : back && x.id === back.id ? { ...x, text: { ...x.text!, text: b } } : x)),
  });
  return back?.id ?? null;
}

/** 跟下一段字幕合併（時間延到下一段結束，文字接起來） */
export function mergeCueWithNext(id: string): boolean {
  const s = useStore.getState();
  const caps = received();
  const i = caps.findIndex((c) => c.id === id);
  const c = caps[i], n = caps[i + 1];
  if (!c || !n || locked(c) || locked(n)) return false;
  const a = c.text!.text.trim(), b = n.text!.text.trim();
  const joint = !a || !b || /[぀-ヿ㐀-鿿]$/.test(a) || /^[぀-ヿ㐀-鿿]/.test(b) ? '' : ' ';
  const end = Math.max(c.start + c.duration, n.start + n.duration);
  useStore.setState({
    clips: s.clips.filter((x) => x.id !== n.id).map((x) => (x.id === id ? { ...x, duration: end - x.start, text: { ...x.text!, text: a + joint + b }, transitionOut: n.transitionOut ?? x.transitionOut } : x)),
    selection: { type: 'clip', id },
    selected: [`clip:${id}`],
  });
  return true;
}

export function removeCue(id: string) {
  const s = useStore.getState();
  const c = s.clips.find((x) => x.id === id);
  if (!c || locked(c)) return;
  useStore.setState({ clips: s.clips.filter((x) => x.id !== id), selection: s.selection?.id === id ? null : s.selection, selected: s.selected.filter((k) => k !== `clip:${id}`) });
}

export type CaptionPart = 'style' | 'position' | 'transition' | 'effects';

/** 把一段字幕的樣式 / 位置 / 轉場 / 片段特效套用到其他所有字幕。回傳改了幾段 */
export function applyToAllCaptions(srcId: string, parts: CaptionPart[]): number {
  const s = useStore.getState();
  const src = s.clips.find((x) => x.id === srcId);
  if (!src?.text) return 0;
  const has = new Set(parts);
  let n = 0;
  const clips = s.clips.map((c) => {
    if (c.id === srcId || !isReceived(c) || locked(c)) return c;
    n++;
    const out: Clip = { ...c };
    if (has.has('style')) out.text = { ...src.text!, text: c.text!.text };
    if (has.has('position')) out.transform = { ...src.transform };
    if (has.has('transition')) {
      out.transitionIn = src.transitionIn ? structuredClone(src.transitionIn) : null;
      out.transitionOut = src.transitionOut ? structuredClone(src.transitionOut) : null;
    }
    if (has.has('effects')) out.effects = freshFx(src);
    return out;
  });
  if (n) useStore.setState({ clips });
  return n;
}

/** 找出所有字幕裡的 query，換成 rep。回傳換了幾處 */
export function replaceInCaptions(query: string, rep: string): number {
  if (!query) return 0;
  const s = useStore.getState();
  let n = 0;
  const clips = s.clips.map((c) => {
    if (!isReceived(c) || locked(c) || !c.text!.text.includes(query)) return c;
    const parts = c.text!.text.split(query);
    n += parts.length - 1;
    return { ...c, text: { ...c.text!, text: parts.join(rep) } };
  });
  if (n) useStore.setState({ clips });
  return n;
}
