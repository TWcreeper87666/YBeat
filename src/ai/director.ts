/**
 * AI 導演（自動剪輯第 7 階段）：把音樂段落摘要 + 每個素材的幾張畫面給 Gemini，
 * 請它決定每個素材適合哪些段落（roles）、優先度（weight）、影片裡值得用的時間點（highlights）。
 * 時間計算、對齊節拍還是編排器負責；這裡只回傳每個素材的提示。結果依「素材 + 音樂 + 指示」快取在記憶體。
 */
import type { Media } from '../store';
import type { MusicInfo, SectionKind } from '../engine/musicAnalysis';
import type { Sampled } from '../engine/mediaSampler';
import { imagePart, streamTurn, ApiKeyError, type Part } from './gemini';
import { useAiSettings } from './assistant';
import { DEFAULT_MODEL } from './gemini';

export interface Direction { roles: SectionKind[]; weight: number; highlights: number[]; note: string }

const KINDS: SectionKind[] = ['intro', 'build', 'drop', 'body', 'outro'];
/** 每個素材最多幾張圖（素材很多時降到 1 張，控制請求大小） */
const MAX_IMAGES = 48;

const SYSTEM = `You are the director of a short music video that is cut automatically to the beat.
You get the song's sections and a few frames from each media file. Decide how to use each file.
Reply with ONLY a JSON object, no prose, no code fence:
{"media":[{"id":"<id>","roles":["intro"|"build"|"drop"|"body"|"outro", ...],"weight":0..1,"highlights":[seconds, ...],"note":"<at most 8 words>"}]}
- roles: the sections the file suits. intro/outro = calm, establishing, wide or ending shots; build = rising tension; drop = the most striking, energetic, impactful shots; body = everything else that is fine.
- weight: how much to use it. 1 = hero shot, 0.5 = normal, 0.1 = filler, 0 = do not use (blurry, broken, black, off-topic, near-duplicate of a better one).
- highlights: for videos only, timestamps (seconds, within the file) of the best moments, using the frame times given. Empty if nothing stands out.
- Include every id exactly once. Follow the user's instruction if one is given.`;

const cache = new Map<string, Map<string, Direction>>();

export const directionKey = (music: MusicInfo, media: Media[], note: string) =>
  `${media.map((m) => m.id).join(',')}|${music.sections.map((s) => `${s.b0}-${s.b1}${s.kind}`).join(',')}|${note.trim()}`;
export const cachedDirection = (key: string) => cache.get(key);

export async function directMedia(music: MusicInfo, media: Media[], sampled: Map<string, Sampled>, note: string, signal?: AbortSignal): Promise<Map<string, Direction>> {
  const key = directionKey(music, media, note);
  const hit = cache.get(key);
  if (hit) return hit;
  const ai = useAiSettings.getState();
  if (!ai.key) throw new ApiKeyError('no key');
  const per = media.length * 3 > MAX_IMAGES ? 1 : 3;
  const n = music.energy.length;
  const sec = music.sections.map((s) => `- beats ${s.b0}-${s.b1} (${Math.round(((s.b1 - s.b0) / Math.max(1, n)) * 100)}% of the song): ${s.kind}, energy ${s.energy.toFixed(2)}`).join('\n');
  const parts: Part[] = [{ text: `Song sections:\n${sec}\nDrops at beats: ${music.drops.join(', ') || 'none'}\n${note.trim() ? `\nUser instruction: ${note.trim()}\n` : ''}\nMedia files:` }];
  for (const m of media) {
    const s = sampled.get(m.id);
    const shots = s?.shots ?? [];
    const pick = shots.length <= per ? shots : [shots[Math.floor(shots.length / 2)]];
    parts.push({ text: `\nid=${m.id} ${m.kind}${m.kind === 'video' ? ` ${m.duration.toFixed(1)}s, frames at ${pick.map((x) => `${x.t.toFixed(1)}s`).join(', ')}` : ''} name="${m.name}"` });
    for (const x of pick) parts.push(imagePart(x.shot));
  }
  const r = await streamTurn({ key: ai.key, model: ai.model || DEFAULT_MODEL, system: SYSTEM, turns: [{ role: 'user', text: '', parts }], signal });
  const out = parseDirection(r.text, media);
  cache.set(key, out);
  return out;
}

/** 解析 AI 的 JSON（容忍前後多出來的字、code fence）；不認得的 id、欄位略過 */
export function parseDirection(text: string, media: { id: string; kind: string; duration: number }[]): Map<string, Direction> {
  const out = new Map<string, Direction>();
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('AI did not return JSON');
  const j = JSON.parse(text.slice(a, b + 1)) as { media?: unknown };
  const list = Array.isArray(j.media) ? j.media : [];
  for (const raw of list) {
    const x = raw as Record<string, unknown>;
    const m = media.find((y) => y.id === x.id);
    if (!m) continue;
    const roles = (Array.isArray(x.roles) ? x.roles : []).map(String).filter((k): k is SectionKind => KINDS.includes(k as SectionKind));
    const w = typeof x.weight === 'number' && Number.isFinite(x.weight) ? Math.min(1, Math.max(0, x.weight)) : 0.5;
    const hl = m.kind === 'video' ? (Array.isArray(x.highlights) ? x.highlights : []).filter((t): t is number => typeof t === 'number' && t >= 0 && t <= m.duration) : [];
    out.set(m.id, { roles, weight: w, highlights: hl, note: typeof x.note === 'string' ? x.note.slice(0, 80) : '' });
  }
  return out;
}
