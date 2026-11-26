/**
 * AI 導演（自動剪輯第 7 階段）：把音樂段落摘要 + 每個素材的幾張畫面給 Gemini，
 * 請它決定每個素材適合哪些段落（roles）、優先度（weight）、影片裡要用（use）/ 一定要避開（avoid）的範圍。
 * 時間計算、對齊節拍還是編排器負責；這裡只回傳每個素材的提示。結果依「素材 + 音樂 + 指示」快取在記憶體。
 */
import { $t } from '../i18n';
import type { Media } from '../store';
import type { MusicInfo, SectionKind } from '../engine/musicAnalysis';
import type { Sampled } from '../engine/mediaSampler';
import { imagePart, streamTurn, ApiKeyError, type Part } from './gemini';
import { useAiSettings } from './assistant';
import { loadAnalysis, saveAnalysis } from '../engine/analysisStore';
import { DEFAULT_MODEL } from './gemini';

/** highlights = use 範圍裡的時間點（給挑片段加分）；avoid = 一定不能用的範圍 */
export interface Direction { roles: SectionKind[]; weight: number; highlights: number[]; use: [number, number][]; avoid: [number, number][]; note: string; pop?: number }

const KINDS: SectionKind[] = ['intro', 'build', 'drop', 'body', 'outro'];
/** 一次最多送幾張圖（每張約 258 tokens；超過就每個素材平均少送一點） */
const MAX_IMAGES = 400;

const SYSTEM = `You are the director of a short music video that is cut automatically to the beat.
You get the song's sections and a few frames from each media file. Decide how to use each file.
Reply with ONLY a JSON object, no prose, no code fence:
{"media":[{"id":"<id>","roles":["intro"|"build"|"drop"|"body"|"outro", ...],"weight":0..1,"use":[[start,end], ...],"avoid":[[start,end], ...],"pop":0..1,"note":"<at most 8 words>"}]}
- roles: the sections the file suits. intro/outro = calm, establishing, wide or ending shots; build = rising tension; drop = the most striking, energetic, impactful shots; body = everything else that is fine.
- weight: how much to use it. 1 = hero shot, 0.5 = normal, 0.1 = filler, 0 = do not use (blurry, broken, black, off-topic, near-duplicate of a better one).
- pop: for images only, how good the image is for a "subject pop" (the main subject is cut out and grows on the beat before the full image appears): 1 = one clear, striking subject (person, animal, product) separated from the background; 0 = no single subject, busy scene, text, landscape.
- Videos come as a series of frames, each labelled with its time (t=12.0s). A frame stands for the time around it (half way to its neighbours).
- use: for videos only, time ranges in seconds (within the file) of the best moments. Empty if nothing stands out.
- avoid: for videos only, time ranges that must NOT appear in the edit: black / broken / blurry stretches, title cards, and anything the user's instruction excludes. Look at every frame. These ranges are never used, so be precise; if the whole file is unusable set weight 0 instead.
- The file name may say what or who the file shows.
- Some frames are tagged by a local face recognizer: [main person] = the person who appears most across all files is in the frame; [only other people] = faces are visible but not the main person. Trust these tags for who is on screen; the main person is usually who the user means.
- note: in the same language as the user's instruction (English if there is none).
- Include every id exactly once. The user's instruction overrides these defaults: if they want only one person or topic, give weight 0 to files without it and avoid the ranges inside a file where it is missing or unrelated people take over.`;

const cache = new Map<string, Map<string, Direction>>();

export const directionKey = (music: MusicInfo, media: Media[], note: string) =>
  `${media.map((m) => m.id).join(',')}|${music.sections.map((s) => `${s.b0}-${s.b1}${s.kind}`).join(',')}|${note.trim()}`;
export const cachedDirection = (key: string) => cache.get(key);

/** 每個素材給 AI 看哪幾張（總數超過 MAX_IMAGES 就每個素材平均挑，至少 1 張） */
export function directorShots(media: Media[], sampled: Map<string, Sampled>): Map<string, Sampled['shots']> {
  const all = media.map((m) => [m.id, sampled.get(m.id)?.shots ?? []] as const);
  const total = all.reduce((s, [, l]) => s + l.length, 0);
  const per = total <= MAX_IMAGES ? Infinity : Math.max(1, Math.floor(MAX_IMAGES / Math.max(1, media.length)));
  return new Map(all.map(([id, l]) => [id, l.length <= per ? l : Array.from({ length: per }, (_, i) => l[Math.floor(((i + 0.5) * l.length) / per)])]));
}

/** 這個素材給 AI 看的畫面間隔（秒） */
const gapOf = (shots: { t: number }[], duration: number) =>
  shots.length > 1 ? (shots[shots.length - 1].t - shots[0].t) / (shots.length - 1) : Math.max(1, duration);

/** 一次請求最多幾張圖（太多張伺服器會逾時）；同時最多幾個請求 */
const BATCH_IMAGES = 60;
const PARALLEL = 3;

/** 把素材分批（每批的圖不超過 max；照順序裝） */
export function directorBatches<T extends { id: string }>(media: T[], count: (m: T) => number, max = BATCH_IMAGES): T[][] {
  const out: T[][] = [];
  let cur: T[] = [], n = 0;
  for (const m of media) {
    const k = Math.max(1, count(m));
    if (cur.length && n + k > max) { out.push(cur); cur = []; n = 0; }
    cur.push(m);
    n += k;
  }
  if (cur.length) out.push(cur);
  return out;
}

/**
 * 素材多的時候分成幾批同時問（每批都附上音樂段落與使用者的指示），結果合併。
 * onBatch：分批的進度（完成幾批 / 共幾批；只有一批就不通知）。
 * 有幾批失敗：其他批的結果照用（失敗那批的素材沒有安排），onFail 通知；全部失敗才丟錯。有失敗的結果不快取（下次重問）。
 */
/** AI 回傳的格式壞掉時重問幾次 */
const FORMAT_RETRY = 2;

export async function directMedia(music: MusicInfo, media: Media[], sampled: Map<string, Sampled>, note: string, signal?: AbortSignal,
  onRetry?: (attempt: number, waitSec: number, format?: boolean) => void, onBatch?: (done: number, total: number) => void,
  onFail?: (failed: number, total: number, err: unknown) => void, frameNote?: (mediaId: string, t: number) => string): Promise<Map<string, Direction>> {
  const key = directionKey(music, media, note);
  const hit = cache.get(key) ?? await loadAnalysis<Map<string, Direction>>('director', key);
  if (hit) return cache.set(key, hit), hit;
  const ai = useAiSettings.getState();
  if (!ai.key) throw new ApiKeyError('no key');
  const picks = directorShots(media, sampled);
  const n = music.energy.length;
  const sec = music.sections.map((s) => `- beats ${s.b0}-${s.b1} (${Math.round(((s.b1 - s.b0) / Math.max(1, n)) * 100)}% of the song): ${s.kind}, energy ${s.energy.toFixed(2)}`).join('\n');
  const batches = directorBatches(media, (m) => picks.get(m.id)?.length ?? 0);
  const ask = async (list: Media[], k: number) => {
    const part = batches.length > 1 ? ` (part ${k + 1} of ${batches.length}; the other files are judged separately)` : '';
    const parts: Part[] = [{ text: `Song sections:\n${sec}\nDrops at beats: ${music.drops.join(', ') || 'none'}\n${note.trim() ? `\nUser instruction: ${note.trim()}\n` : ''}\nMedia files${part}:` }];
    for (const m of list) {
      const pick = picks.get(m.id) ?? [];
      parts.push({ text: `\nid=${m.id} ${m.kind}${m.kind === 'video' ? ` ${m.duration.toFixed(1)}s, a frame every ${gapOf(pick, m.duration).toFixed(1)}s` : ''} name="${m.name}"` });
      for (const x of pick) {
        if (m.kind === 'video') parts.push({ text: `t=${x.t.toFixed(1)}s${frameNote?.(m.id, x.t) ?? ''}` });
        else if (frameNote?.(m.id, 0)) parts.push({ text: frameNote(m.id, 0).trim() });
        parts.push(imagePart(x.shot));
      }
    }
    // 分批同時送容易碰到限流：自動等久一點再試
    // 回傳的 JSON 壞掉（漏逗號、被截斷）：再問一次，最多 FORMAT_RETRY 次
    for (let tries = 0; ; tries++) {
      const r = await streamTurn({ key: ai.key, model: ai.model || DEFAULT_MODEL, system: SYSTEM, turns: [{ role: 'user', text: '', parts }], signal, onRetry: (a, w) => onRetry?.(a, w), maxRateWait: 90 });
      try {
        return parseDirection(r.text, list, new Map(list.map((m) => [m.id, gapOf(picks.get(m.id) ?? [], m.duration)])));
      } catch {
        if (signal?.aborted || tries >= FORMAT_RETRY) throw new Error($t('AI 回傳的格式有誤'));
        onRetry?.(tries + 1, 0, true);
      }
    }
  };
  const out = new Map<string, Direction>();
  const errors: unknown[] = [];
  let next = 0, done = 0;
  if (batches.length > 1) onBatch?.(0, batches.length);
  const worker = async () => {
    while (next < batches.length) {
      const k = next++;
      try {
        for (const [id, d] of await ask(batches[k], k)) out.set(id, d);
      } catch (e) {
        if (signal?.aborted || e instanceof ApiKeyError) throw e;
        errors.push(e);
      }
      if (batches.length > 1) onBatch?.(++done, batches.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, batches.length) }, worker));
  if (errors.length === batches.length) throw errors[0];
  if (errors.length) onFail?.(errors.length, batches.length, errors[0]);
  else cache.set(key, out), void saveAnalysis('director', key, out);
  return out;
}

/** 解析 AI 的 JSON（容忍前後多出來的字、code fence）；不認得的 id、欄位略過 */
/** 範圍清單：[[a, b], …]，夾在 0..dur、前後各放寬 pad 秒（AI 說的是畫面的時間，一張代表前後半個間隔）、合併重疊的 */
function spans(raw: unknown, dur: number, pad: number): [number, number][] {
  const list: [number, number][] = [];
  for (const x of Array.isArray(raw) ? raw : []) {
    if (!Array.isArray(x) || x.length < 2 || typeof x[0] !== 'number' || typeof x[1] !== 'number' || !Number.isFinite(x[0]) || !Number.isFinite(x[1])) continue;
    const a = Math.max(0, Math.min(x[0], x[1]) - pad), b = Math.min(dur, Math.max(x[0], x[1]) + pad);
    if (b > a) list.push([a, b]);
  }
  list.sort((p, q) => p[0] - q[0]);
  const out: [number, number][] = [];
  for (const s of list) {
    const last = out[out.length - 1];
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
    else out.push([s[0], s[1]]);
  }
  return out;
}

/** gaps：每個素材給 AI 看的畫面間隔（範圍前後各放寬一半） */
export function parseDirection(text: string, media: { id: string; kind: string; duration: number }[], gaps: Map<string, number> = new Map()): Map<string, Direction> {
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
    const pad = (gaps.get(m.id) ?? 0) / 2;
    const use = m.kind === 'video' ? spans(x.use, m.duration, pad) : [];
    const avoid = m.kind === 'video' ? spans(x.avoid, m.duration, pad) : [];
    // 舊格式的 highlights（時間點）+ use 範圍裡每 0.5 秒一點（挑片段時碰到就加分）
    const hl = m.kind === 'video' ? [
      ...(Array.isArray(x.highlights) ? x.highlights : []).filter((t): t is number => typeof t === 'number' && t >= 0 && t <= m.duration),
      ...use.flatMap(([a, b]) => Array.from({ length: Math.max(1, Math.floor((b - a) / 0.5)) }, (_, i) => a + i * 0.5)),
    ] : [];
    const pop = m.kind === 'image' && typeof x.pop === 'number' && Number.isFinite(x.pop) ? Math.min(1, Math.max(0, x.pop)) : undefined;
    out.set(m.id, { roles, weight: w, highlights: hl, use, avoid, note: typeof x.note === 'string' ? x.note.slice(0, 80) : '', ...(pop !== undefined ? { pop } : {}) });
  }
  return out;
}
