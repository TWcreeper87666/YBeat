import type { MusicInfo } from './musicAnalysis';
import { banned, bestIn, faceIn, freeRoom, type FaceBox, type MediaInfo, type Span } from './mediaAnalysis';
import type { SectionKind } from './musicAnalysis';
import type { PlanPop, PopVariant } from './subjectPop';
import { boostSpeed, speedCurve, speedFocus, type PlanSpeed, type SpeedVariant } from './speedRamp';
import type { BeatEvery } from './trigger';

export interface Recipe {
  id: string;
  beatsPerShot: [number, number, number];
  jitter: number;
  transitionRate: number;
  sectionTransitionRate: number;
  accentsPer32: number;
  minShotSec: number;
  maxShotSec: number;
  /** 一般切點的轉場拍數；段落與 drop 加倍。 */
  transitionBeats: number;
}
export type RecipeId = 'calm' | 'rhythm' | 'hype' | 'velocity' | 'glitch' | 'flash';
export const RECIPES: Record<RecipeId, Recipe> = {
  calm: { id: 'calm', beatsPerShot: [8, 4, 4], jitter: 0.1, transitionRate: 0.25, sectionTransitionRate: 0.6, accentsPer32: 0.5, minShotSec: 1.2, maxShotSec: 8, transitionBeats: 1 },
  rhythm: { id: 'rhythm', beatsPerShot: [4, 2, 1], jitter: 0.2, transitionRate: 0.15, sectionTransitionRate: 0.8, accentsPer32: 2, minShotSec: 0.35, maxShotSec: 6, transitionBeats: 0.5 },
  hype: { id: 'hype', beatsPerShot: [2, 1, 1], jitter: 0.25, transitionRate: 0.1, sectionTransitionRate: 1, accentsPer32: 4, minShotSec: 0.2, maxShotSec: 4, transitionBeats: 0.5 },
  velocity: { id: 'velocity', beatsPerShot: [2, 1, 1], jitter: 0.2, transitionRate: 0.2, sectionTransitionRate: 1, accentsPer32: 0, minShotSec: 0.2, maxShotSec: 4, transitionBeats: 0.5 },
  glitch: { id: 'glitch', beatsPerShot: [4, 2, 1], jitter: 0.25, transitionRate: 0.2, sectionTransitionRate: 0.9, accentsPer32: 0, minShotSec: 0.25, maxShotSec: 5, transitionBeats: 0.5 },
  flash: { id: 'flash', beatsPerShot: [4, 2, 1], jitter: 0.2, transitionRate: 0.2, sectionTransitionRate: 0.9, accentsPer32: 0, minShotSec: 0.25, maxShotSec: 5, transitionBeats: 0.5 },
};
/** strength：0 柔和，1 強烈；weight：相對出現機會（沒有 = 1，0 = 不用）。 */
export interface TransitionOpt { id: string; strength: number; weight?: number }

/** 特效層的時機：每 N 拍 / 剪接點 / 重音 / drop / 整個段落 */
export type RuleWhen = 'beat' | 'cut' | 'accent' | 'drop' | 'section';
/** 衝突組：同一時間每組只留一個；ambient（顆粒、黑邊…）可以跟任何東西疊 */
export type FxGroup = 'zoom' | 'shake' | 'flash' | 'glitch' | 'color' | 'ambient' | 'other';
/** 特效層（風格的一部分；面板編輯、存在 localStorage） */
export interface FxRule {
  id: string;
  /** 特效模組或「我的組合」的 id */
  moduleId: string;
  on: boolean;
  when: RuleWhen;
  /** when = beat：每幾拍 */
  every?: BeatEvery;
  /** 用在哪幾種能量（0 低、1 中、2 高） */
  levels: (0 | 1 | 2)[];
  /** 每個時機點出現的機率 0..1 */
  chance: number;
  /** when = accent / drop：方塊長幾拍（沒有 = 1；衝擊型特效套用時會再縮成模組的長度） */
  beats?: number;
}
/** 給編排器的特效層：套用端已經算好組別、是不是衝擊型、參數（強度）、機率（乘過密度） */
export interface RuleOpt extends Omit<FxRule, 'on'> {
  group: FxGroup;
  hit: boolean;
  params?: Record<string, number | boolean>;
}
/** 計畫裡的觸發（套用成 FxItem.trigger）；chance < 1 = 只在挑中的時機點觸發 */
export type PlanTrigger = { kind: 'beat'; every: BeatEvery; chance?: number; seed?: number } | { kind: 'cut'; chance?: number; seed?: number };
/** hit 為單點；everyBeat 為逐拍觸發；其餘為持續型。 */
export interface AccentOpt { id: string; hit: boolean; everyBeat?: boolean; mood: 'calm' | 'any' | 'intense'; beats?: number }
export interface PlanOptions {
  transitions: TransitionOpt[];
  accents: AccentOpt[];
  dropHit: string | null;
  kenBurns: boolean;
  /** library = 清單順序（每 3 個一組小洗牌）；shuffle = 每輪全部洗牌、依適合度挑；bag = 每輪洗牌後照順序用完（同一支影片的片段盡量分開） */
  order: 'library' | 'shuffle' | 'bag';
  pops?: { variants: PopVariant[]; per32: number; text?: string };
  /** every = 每個影片鏡頭都套用（不看次數、間隔）；boost = 整體加速（素材用掉的倍數，1 = 不加速） */
  speed?: { variants: SpeedVariant[]; per32: number; intensity: number; every?: boolean; boost?: number };
  /** 特效層（依清單順序；同優先度時前面的贏） */
  rules?: RuleOpt[];
}
export const DEFAULT_OPTIONS: PlanOptions = {
  transitions: [
    { id: 'tr-crossfade', strength: 0.1 }, { id: 'tr-blur', strength: 0.2 },
    { id: 'tr-luma', strength: 0.25 }, { id: 'tr-push', strength: 0.55 },
    { id: 'tr-zoomblur', strength: 0.75 }, { id: 'tr-whip', strength: 0.8 },
    { id: 'tr-rgbsplit', strength: 0.8 }, { id: 'tr-shake', strength: 0.85 },
    { id: 'tr-crashzoom', strength: 0.9 }, { id: 'tr-flash', strength: 1 },
  ],
  accents: [
    { id: 'fx-letterbox', hit: false, mood: 'any', beats: 6 },
    { id: 'fx-zoompulse', hit: false, everyBeat: true, mood: 'intense' },
    { id: 'fx-crashzoom', hit: true, mood: 'any' },
    { id: 'fx-shake', hit: true, mood: 'intense' },
    { id: 'fx-rgb', hit: false, mood: 'intense', beats: 2 },
    { id: 'fx-glitch', hit: false, mood: 'intense', beats: 2 },
    { id: 'fx-bw', hit: false, mood: 'calm', beats: 4 },
  ],
  dropHit: 'fx-flash', kenBurns: true, order: 'library',
};
export interface PlanMedia {
  id: string; kind: 'video' | 'image'; duration: number;
  /** 影片取樣分析。 */
  info?: MediaInfo;
  /** 適合的樂段。 */
  roles?: SectionKind[];
  /** 素材優先度。 */
  weight?: number;
  /** 影片亮點秒數。 */
  highlights?: number[];
  /** 影片裡一定不能用的範圍（AI 導演說要避開的、只有別人的）。 */
  ban?: Span[];
  /** 影片的某一格（當成圖片）：只拿來做主體跳出，揭露那一拍接著播那支影片；不進一般的輪播。 */
  popOnly?: true;
  /** 主角的臉出現的取樣點（素材時間；圖片 t = 0）。 */
  leadPts?: { t: number; x: number; y: number; w: number; h: number }[];
  /** 整個素材平均有多少人（0..1；圖片 = 那一張）。 */
  people?: number;
  /** 圖片裡最大的臉。 */
  face?: FaceBox | null;
  /** 圖片主體構圖。 */
  pop?: { ok: boolean; centered: boolean; cx: number; cy: number; path?: string };
  /** AI 導演評估的主體跳出適合度，範圍 0 至 1。 */
  popSuit?: number;
}
export interface KenBurns { from: { scale: number; x: number; y: number }; to: { scale: number; x: number; y: number } }
export interface PlanTransition { moduleId: string; beats: number }
/**
 * face：這個鏡頭裡臉的平均位置（素材畫面 0..1）→ 片段打開臉部追蹤（特效的中心跟著臉）。
 * push：推近到臉上（取代一般的推近 / 拉遠；套用端依畫面比例算縮放、位移）。
 */
export interface PlanShot {
  b0: number; b1: number; mediaId: string; in: number; motion?: KenBurns; transition?: PlanTransition; speed?: PlanSpeed; face?: FaceBox; push?: true;
  /** 主角的臉（素材時間，不含指定片段的起點）：片段從這裡開始追主角 */
  anchor?: { t: number; x: number; y: number; w: number; h: number };
  /** 鏡頭中間附近實際偵測到的最大的臉（裁切過的片段沒有主角時，從這裡開始追） */
  faceAnchor?: { t: number; x: number; y: number; w?: number; h: number };
}
export interface PlanOverlay {
  b0: number; b1: number; moduleId: string; params?: Record<string, number | boolean>; everyBeat?: boolean;
  /** 特效層產生的：觸發方式 */
  trigger?: PlanTrigger;
  /** 特效層產生的：第幾層（options.rules 的索引；套用時每層一條特效軌）；沒有 = 舊的點綴 */
  lane?: number;
}
/** speedSkip：變速沒套上的影片鏡頭，各原因幾個（產生結果裡顯示，方便調整） */
export type SpeedSkip = 'spacing' | 'kind' | 'short' | 'cut' | 'motion' | 'ban';
export interface EditPlan { seed: number; recipe: string; shots: PlanShot[]; overlays: PlanOverlay[]; pops: PlanPop[]; speedSkip?: Partial<Record<SpeedSkip, number>> }
export interface PlanInput {
  beats: { t: number; down: boolean }[];
  music: MusicInfo;
  media: PlanMedia[];
  recipe: Recipe;
  seed: number;
  range?: [number, number];
  options?: PlanOptions;
}

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let x = state;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** 規則與拍號各自雜湊，不消耗主亂數。 */
function ruleHash(seed: number, id: string, beat?: number): number {
  let h = (seed ^ 0x811c9dc5) >>> 0;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193) >>> 0;
  if (beat !== undefined) h = Math.imul(h ^ beat, 0x01000193) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

function beatTime(beats: { t: number }[], i: number): number {
  if (i < beats.length) return beats[i].t;
  const n = beats.length;
  if (!n) return i * 0.5;
  const period = n >= 2 ? (beats[n - 1].t - beats[Math.max(0, n - 9)].t) / Math.min(8, n - 1) : 0.5;
  return beats[n - 1].t + (i - n + 1) * period;
}

/** 用拍號產生可重現的剪輯計畫。 */
export function planEdit(input: PlanInput): EditPlan {
  const { beats, music, media, recipe, seed } = input;
  const settings = input.options ?? DEFAULT_OPTIONS;
  const start = Math.max(0, Math.min(beats.length, Math.floor(input.range?.[0] ?? 0)));
  const end = Math.max(start, Math.min(beats.length, Math.floor(input.range?.[1] ?? beats.length)));
  const plan: EditPlan = { seed, recipe: recipe.id, shots: [], overlays: [], pops: [] };
  if (!media.length || start === end) return plan;
  const rng = random(seed);
  const hard = new Set<number>([start, end]);
  for (const section of music.sections) {
    if (section.b0 > start && section.b0 < end) hard.add(section.b0);
    if (section.b1 > start && section.b1 < end) hard.add(section.b1);
  }
  for (const drop of music.drops) if (drop > start && drop < end) hard.add(drop);
  const hardCuts = [...hard].sort((a, b) => a - b);
  const duration = (b0: number, b1: number) => beatTime(beats, b1) - beatTime(beats, b0);

  // 用獨立亂數決定跳出，避免改動原本的剪輯順序。
  const popOptions = settings.pops;
  if (popOptions?.variants.length && popOptions.per32 > 0) {
    const popRng = random(seed ^ 0x504f5053);
    const enabled = [...new Set(popOptions.variants)].filter((v): v is PopVariant =>
      ['step', 'mono', 'fly', 'shake', 'crossShot', 'textBehind', 'trail', 'grid', 'spin', 'dim', 'halo', 'blur',
        'silhouetteWindow', 'subjectHole'].includes(v));
    const drops = [...new Set(music.drops)].filter((b) => b > start && b < end);
    const rises = music.sections.slice(1).filter((s, i) =>
      s.energy > music.sections[i].energy + 0.1).map((s) => s.b0)
      .filter((b) => b > start && b < end && !drops.includes(b));
    const budget = new Map<number, number>();
    const counts = new Map<number, number>();
    let lastVariant: PopVariant | undefined;
    for (const b1 of [...drops, ...rises]) {
      const bucket = Math.floor((b1 - start) / 32);
      if (!budget.has(bucket)) budget.set(bucket, Math.floor(popOptions.per32) + (popRng() < popOptions.per32 % 1 ? 1 : 0));
      if ((counts.get(bucket) ?? 0) >= budget.get(bucket)!) continue;
      if (plan.pops.some((p) => Math.abs(p.b1 - b1) < 16)) continue;
      const sectionKind = music.sections.find((s) => s.b0 <= b1 && b1 < s.b1)?.kind;
      const candidates = media.filter((m) => m.kind === 'image' && m.pop?.ok &&
        (m.weight !== 0 || !media.some((item) => item.weight !== 0)));
      const subjects = candidates.some((m) => m.popSuit !== 0)
        ? candidates.filter((m) => m.popSuit !== 0) : candidates;
      // 窗口至少需有另一個底軌素材。
      if (media.length < 2) continue;
      const ranked = subjects.map((m) => ({ m, rank: (m.roles === undefined ? 0.5 : sectionKind && m.roles.includes(sectionKind) ? 1 : 0) +
        (m.weight ?? 0.5) * 0.5 + (m.popSuit ?? 0.5) + popRng() * 0.3 -
        // 已經做過主體跳出的圖往後排，每次換一張
        plan.pops.filter((p) => p.mediaId === m.id).length * 2 })).sort((a, b) => b.rank - a.rank);
      let picked: PlanPop | undefined;
      for (const { m } of ranked) {
        const revealImages = media.filter((other) => other.kind === 'image' && !other.popOnly && other.id !== m.id &&
          !plan.pops.some((p) => (p.mediaId === other.id || p.revealMediaId === other.id) &&
            b1 - 4 < p.b1 && p.b0 < b1));
        const revealImage = revealImages.find((other) => other.pop?.ok === false) ?? revealImages[0];
        const variants = enabled.filter((v) => (!['step', 'shake', 'trail', 'grid', 'spin', 'halo'].includes(v) || m.pop!.centered) &&
          (v !== 'crossShot' || !!revealImage && media.some((base) =>
            base.id !== m.id && base.id !== revealImage.id &&
            (base.weight !== 0 || !media.some((item) => item.weight !== 0)))) &&
          (!['silhouetteWindow', 'subjectHole'].includes(v) || !!m.pop!.path?.trim() && !!revealImage) &&
          (v !== 'textBehind' || !!popOptions.text?.trim()) &&
          b1 - (v === 'fly' ? 2 : 4) >= start);
        if (!variants.length) continue;
        const alternate = variants.filter((v) => v !== lastVariant);
        const pool = alternate.length ? alternate : variants;
        const variant = pool[Math.floor(popRng() * pool.length)];
        picked = { b0: b1 - (variant === 'fly' ? 2 : 4), b1, variant, mediaId: m.id, cx: m.pop!.cx, cy: m.pop!.cy,
          ...(['crossShot', 'silhouetteWindow', 'subjectHole'].includes(variant) ? { revealMediaId: revealImage!.id } : {}),
          ...(['silhouetteWindow', 'subjectHole'].includes(variant) ? { path: m.pop!.path } : {}),
          ...(variant === 'textBehind' ? { text: popOptions.text!.trim() } : {}),
          ...(variant === 'fly' ? { side: popRng() < 0.5 ? -1 as const : 1 as const } : {}) };
        break;
      }
      if (!picked) continue;
      plan.pops.push(picked);
      lastVariant = picked.variant;
      counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
    }
    plan.pops.sort((a, b) => a.b1 - b.b1);
  }
  const reveal = new Map(plan.pops.map((p) => [p.b1, p]));
  const blockedMedia = (id: string, b0: number, b1: number) => plan.pops.some((p) =>
    (p.mediaId === id || p.revealMediaId === id) && b0 < p.b1 && p.b0 < b1);

  const speedOptions = settings.speed;
  const every = !!speedOptions?.every;
  const boost = Math.max(1, speedOptions?.boost ?? 1);
  // 每個鏡頭都套用：不另外預留倒播的位置（每個鏡頭本來就會輪到）
  const reserveReverse = !every && !!speedOptions?.per32 && speedOptions.variants.some((v) =>
    v === 'rewindToCut' || v === 'reverseForwardB' || v === 'rewindReturn');
  const speedRng = reserveReverse ? random(seed ^ 0x53504545) : undefined;
  const speedBudget = new Map<number, number>();
  const speedCounts = new Map<number, number>();
  const fixed = new Map<number, PlanShot>();
  const usedReverse = new Map<string, { t0: number; t1: number }[]>();
  if (reserveReverse && speedOptions && speedRng) {
    const enabled = new Set(speedOptions.variants);
    const events = [...new Set([...music.drops, ...music.sections.flatMap((s) => [s.b0, s.b1])])]
      .filter((b) => b > start && b < end);
    const downbeats = Array.from({ length: end - start }, (_, i) => start + i)
      .filter((b) => beats[b]?.down && music.level[b] === 2);
    const proposals: { b0: number; b1: number; variant: SpeedVariant; event: number }[] = [];
    for (const b of events) {
      const first = proposals.length;
      const before = music.sections.find((s) => s.b0 <= b - 1 && b - 1 < s.b1);
      const length = before && before.energy < 0.45 ? 4 : 3;
      if (enabled.has('rewindToCut') && b - length >= start &&
        !hardCuts.some((cut) => cut > b - length && cut < b))
        proposals.push({ b0: b - length, b1: b, variant: 'rewindToCut', event: b });
      if (enabled.has('reverseForwardB') && b + 3 <= end && !reveal.has(b) &&
        !hardCuts.some((cut) => cut > b && cut < b + 3))
        proposals.push({ b0: b, b1: b + 3, variant: 'reverseForwardB', event: b });
      if (proposals.length === first + 2 && speedRng() < 0.5)
        [proposals[first], proposals[first + 1]] = [proposals[first + 1], proposals[first]];
    }
    for (const b of downbeats) if (enabled.has('rewindReturn') && b + 4 <= end &&
      Array.from({ length: 4 }, (_, i) => music.level[b + i]).every((level) => level === 2) &&
      !hardCuts.some((cut) => cut > b && cut < b + 4))
      proposals.push({ b0: b, b1: b + 4, variant: 'rewindReturn', event: b });
    const chosenEvents: number[] = [];
    // 還有開其他（非預留）種類時，倒播預留最多用掉一半的次數，不然全片都是倒播
    const others = speedOptions.variants.some((v) => v !== 'rewindToCut' && v !== 'reverseForwardB' && v !== 'rewindReturn');
    const reserveCounts = new Map<number, number>();
    for (const proposal of proposals) {
      const { b0, b1, variant, event } = proposal;
      if (chosenEvents.some((b) => Math.abs(b - event) < 8) ||
        [...fixed.values()].some((shot) => b0 < shot.b1 + 4 && shot.b0 < b1 + 4) ||
        plan.pops.some((pop) => b0 < pop.b1 && pop.b0 < b1 || pop.b1 >= b0 && pop.b1 < b1)) continue;
      const bucket = Math.floor((b0 - start) / 32);
      if (!speedBudget.has(bucket)) speedBudget.set(bucket,
        Math.floor(speedOptions.per32) + (speedRng() < speedOptions.per32 % 1 ? 1 : 0));
      if ((speedCounts.get(bucket) ?? 0) >= speedBudget.get(bucket)!) continue;
      if (others && (reserveCounts.get(bucket) ?? 0) >= Math.max(1, Math.ceil(speedBudget.get(bucket)! / 2))) continue;
      const raw = speedCurve(variant, b0, b1, (b) => beatTime(beats, b), speedOptions.intensity);
      if (!raw) continue;
      const curve = boostSpeed(raw, boost);
      const window = curve.sourceMax - curve.sourceMin;
      const sectionKind = music.sections.find((s) => s.b0 <= b0 && b0 < s.b1)?.kind;
      const candidates = media.filter((m) => m.kind === 'video' &&
        (m.weight !== 0 || !media.some((item) => item.weight !== 0)))
        .map((m) => {
          const latest = m.duration - 0.02 - curve.sourceMax;
          if (!(window > 0) || latest < -curve.sourceMin) return null;
          const w0 = m.info
            ? Math.min(bestIn(m.info, window, 1, usedReverse.get(m.id) ?? [], speedRng, m.highlights, m.ban),
              m.duration - 0.02 - window)
            : speedRng() * Math.max(0, latest + curve.sourceMin);
          const w1 = w0 + window;
          const margin = (m.info?.step ?? 0.2) / 2;
          const samples = m.info?.motion.slice(Math.max(0, Math.floor(w0 / m.info.step)),
            Math.min(m.info.motion.length, Math.ceil(w1 / m.info.step)));
          const motion = samples?.length ? samples.reduce((sum, value) => sum + value, 0) / samples.length : m.info ? 0 : 1;
          if (w0 < -1e-8 || w1 > m.duration - 0.02 + 1e-8 || motion < 0.15 || banned(m.ban, w0, w1) ||
            m.info?.cuts.some((cut) => w0 < cut + margin && w1 > cut - margin)) return null;
          const role = m.roles === undefined ? 0.5 : sectionKind && m.roles.includes(sectionKind) ? 1 : 0;
          return { m, w0, w1, rank: motion + role * 0.1 + (m.weight ?? 0.5) * 0.05 };
        }).filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
        .sort((a, b) => b.rank - a.rank || a.m.id.localeCompare(b.m.id));
      const choice = candidates[0];
      if (!choice) continue;
      const w0 = alignPeak(choice.m, choice.w0, window, speedFocus(curve, b0, b1, (b) => beatTime(beats, b)) - curve.sourceMin, usedReverse.get(choice.m.id) ?? []);
      fixed.set(b0, { b0, b1, mediaId: choice.m.id, in: w0 - curve.sourceMin, speed: curve });
      const regions = usedReverse.get(choice.m.id) ?? [];
      regions.push({ t0: choice.w0, t1: choice.w1 });
      usedReverse.set(choice.m.id, regions);
      speedCounts.set(bucket, (speedCounts.get(bucket) ?? 0) + 1);
      reserveCounts.set(bucket, (reserveCounts.get(bucket) ?? 0) + 1);
      chosenEvents.push(event);
    }
  }

  // 每輪用完素材，依設定洗牌。
  let queue: PlanMedia[] = [];
  let previousMedia = '';
  const normal = media.filter((item) => !item.popOnly);
  const rotation = normal.some((item) => item.weight !== 0) ? normal.filter((item) => item.weight !== 0) : normal;
  /** 指定片段來自哪支影片（同一支的片段要分開） */
  const srcOf = (m: PlanMedia) => (m as PlanMedia & { srcId?: string }).srcId ?? m.id;
  let previousSrc = '';
  const refill = () => {
    queue = [];
    if (settings.order === 'bag') {
      // 洗牌後重排：每次從「跟上一個不同影片」的裡面，挑剩最多片段的那支影片（同分隨機），同一支影片的片段就會盡量分開
      const groups = new Map<string, PlanMedia[]>();
      for (const m of rotation) groups.set(srcOf(m), [...(groups.get(srcOf(m)) ?? []), m]);
      for (const g of groups.values()) for (let j = g.length - 1; j > 0; j--) {
        const k = Math.floor(rng() * (j + 1));
        [g[j], g[k]] = [g[k], g[j]];
      }
      let lastSrc = previousSrc;
      while (groups.size) {
        const keys = [...groups.keys()];
        const other = keys.filter((k) => k !== lastSrc);
        const pool = other.length ? other : keys;
        const most = Math.max(...pool.map((k) => groups.get(k)!.length));
        const top = pool.filter((k) => groups.get(k)!.length === most);
        const k = top[Math.floor(rng() * top.length)];
        const g = groups.get(k)!;
        queue.push(g.shift()!);
        if (!g.length) groups.delete(k);
        lastSrc = k;
      }
      return;
    }
    const groupSize = settings.order === 'shuffle' ? rotation.length : 3;
    for (let i = 0; i < rotation.length; i += groupSize) {
      const group = rotation.slice(i, i + groupSize);
      for (let j = group.length - 1; j > 0; j--) {
        const k = Math.floor(rng() * (j + 1));
        [group[j], group[k]] = [group[k], group[j]];
      }
      queue.push(...group);
    }
    if (queue.length > 1 && queue[0].id === previousMedia) {
      const i = queue.findIndex((m) => m.id !== previousMedia);
      [queue[0], queue[i]] = [queue[i], queue[0]];
    }
  };
  const usedVideo = new Map<string, { b0: number; b1: number }[]>(
    [...usedReverse].map(([id, regions]): [string, { b0: number; b1: number }[]] =>
      [id, regions.map((region) => ({ b0: region.t0, b1: region.t1 }))]));
  let previousMotion = 0;
  let previousTransition = '';
  for (let b0 = start; b0 < end;) {
    const fixedShot = fixed.get(b0);
    if (fixedShot) {
      if (!queue.length) refill();
      const index = queue.findIndex((m) => m.id === fixedShot.mediaId);
      if (index >= 0) queue.splice(index, 1);
      plan.shots.push(fixedShot);
      previousMedia = fixedShot.mediaId;
      { const fm = media.find((m) => m.id === fixedShot.mediaId); if (fm) previousSrc = srcOf(fm); }
      previousTransition = '';
      b0 = fixedShot.b1;
      continue;
    }
    const level = music.level[b0] ?? 1;
    let length = Math.max(1, recipe.beatsPerShot[level]);
    if (rng() < recipe.jitter) length = rng() < 0.5 ? Math.max(1, Math.round(length / 2)) : length * 2;
    const stop = reserveReverse
      ? Math.min(hardCuts.find((b) => b > b0) ?? end,
        [...fixed.keys()].filter((b) => b > b0).sort((a, b) => a - b)[0] ?? end)
      : hardCuts.find((b) => b > b0) ?? end;
    let b1 = Math.min(stop, b0 + length);
    if (length >= 4 && b1 < stop && !beats[b1]?.down) {
      const aligned = [b1 - 1, b1 + 1, b1 - 2, b1 + 2].find((b) => b > b0 && b < stop && beats[b]?.down);
      if (aligned !== undefined) b1 = aligned;
    }
    while (b1 < stop && duration(b0, b1) < recipe.minShotSec) b1++;
    while (b1 > b0 + 1 && duration(b0, b1) > recipe.maxShotSec) b1--;
    if (b1 < stop && duration(b1, stop) < recipe.minShotSec && duration(b0, stop) <= recipe.maxShotSec) b1 = stop;

    if (!queue.length) refill();
    const shotSec = duration(b0, b1);
    const sectionKind = music.sections.find((section) => section.b0 <= b0 && b0 < section.b1)?.kind;
    let choice = -1, bestScore = -Infinity;
    const reserved = reveal.get(b0);
    // 輪流隨機：照排好的順序，第一個能用的就用（不看適合度）
    if (settings.order === 'bag' && !reserved)
      choice = queue.findIndex((m) => !blockedMedia(m.id, b0, b1) && m.id !== previousMedia && (m.kind !== 'video' || freeRoom(m.duration, m.ban) + 1e-9 >= shotSec));
    for (let i = 0; i < queue.length && !reserved && settings.order !== 'bag'; i++) {
      const m = queue[i];
      if (blockedMedia(m.id, b0, b1) || m.id === previousMedia || m.kind === 'video' && freeRoom(m.duration, m.ban) + 1e-9 < shotSec) continue;
      const roleMatch = m.roles === undefined ? 0.5 : sectionKind && m.roles.includes(sectionKind) ? 1 : 0;
      // 有人的素材優先
      const score = roleMatch + (m.weight ?? 0.5) * 0.5 + (m.people ?? 0) * 0.4 + rng() * 0.3;
      if (score > bestScore) { bestScore = score; choice = i; }
    }
    if (reserved) choice = queue.findIndex((m) => m.id === (reserved.revealMediaId ?? reserved.mediaId));
    // 備案：先找還有空間（沒被 AI 導演整段避開）的素材，連續同一個也可以
    const room = (m: PlanMedia) => m.kind !== 'video' || freeRoom(m.duration, m.ban) + 1e-9 >= shotSec;
    if (choice < 0 && !reserved) choice = queue.findIndex((m) => !blockedMedia(m.id, b0, b1) && m.id !== previousMedia && room(m));
    if (choice < 0 && !reserved) choice = queue.findIndex((m) => !blockedMedia(m.id, b0, b1) && room(m));
    if (choice < 0 && !reserved && queue.some((m) => !room(m))) {
      refill();
      choice = queue.findIndex((m) => !blockedMedia(m.id, b0, b1) && room(m));
    }
    if (choice < 0 && !reserved) choice = queue.findIndex((m) => !blockedMedia(m.id, b0, b1) && m.id !== previousMedia);
    if (choice < 0 && !reserved) choice = queue.findIndex((m) => !blockedMedia(m.id, b0, b1));
    if (choice < 0 && !reserved) {
      refill();
      choice = queue.findIndex((m) => !blockedMedia(m.id, b0, b1));
    }
    const item = reserved ? media.find((m) => m.id === (reserved.revealMediaId ?? reserved.mediaId))! : queue[choice] ?? queue[0];
    if (choice >= 0) queue.splice(choice, 1);
    if (item.kind === 'video' && item.duration + 1e-9 < duration(b0, b1)) {
      while (b1 > b0 + 1 && duration(b0, b1) > item.duration + 1e-9) b1--;
    }
    const shot: PlanShot = { b0, b1, mediaId: item.id, in: 0 };
    if (item.kind === 'video') {
      const latest = Math.max(0, item.duration - duration(b0, b1));
      const regions = usedVideo.get(item.id) ?? [];
      if (item.info) {
        shot.in = bestIn(item.info, duration(b0, b1), level / 2,
          regions.map((r) => ({ t0: r.b0, t1: r.b1 })), rng, item.highlights, item.ban);
      } else {
        const all = [...Array.from({ length: 12 }, () => latest * rng()), 0, latest];
        const free = all.filter((t) => !banned(item.ban, t, t + duration(b0, b1)));
        const options = free.length ? free : all;
        const distance = (candidate: number) => regions.length ? Math.min(...regions.map((r) => Math.max(r.b0 - (candidate + duration(b0, b1)), candidate - r.b1, 0))) : 0;
        shot.in = options.sort((a, b) => distance(b) - distance(a))[0];
      }
      regions.push({ b0: shot.in, b1: shot.in + duration(b0, b1) });
      usedVideo.set(item.id, regions);
    } else if (settings.kenBurns && !reserved) {
      const direction = previousMotion || (rng() < 0.5 ? -1 : 1);
      const current = -direction;
      previousMotion = current;
      const delta = recipe.id === 'calm' ? 0.06 : 0.12;
      // 位移不能超過放大多出來的邊（(scale - 1) / 2），不然會露出黑邊；縮放 1 的那一端置中
      const pan = Math.min(0.04, delta / 2);
      const x = (rng() * 2 - 1) * pan, y = (rng() * 2 - 1) * pan;
      shot.motion = current > 0
        ? { from: { scale: 1, x: 0, y: 0 }, to: { scale: 1 + delta, x, y } }
        : { from: { scale: 1 + delta, x, y }, to: { scale: 1, x: 0, y: 0 } };
    }
    if (plan.shots.length && settings.transitions.length && !reserved) {
      const special = hard.has(b0) && b0 !== start;
      // 上一個鏡頭剪前倒抽：倒帶衝進硬切或強烈的轉場（柔和的轉場會把倒帶的力道吃掉）
      const rewound = plan.shots.at(-1)?.speed?.variant === 'rewindToCut';
      if (rng() < (special ? recipe.sectionTransitionRate : recipe.transitionRate)) {
        const usable = settings.transitions.filter((option) => (option.weight ?? 1) > 0 && (!rewound || STRONG_TR.has(option.id)));
        // 不連續用同一個；只開了一種（例如全部都要 Crash Zoom）就照用
        const fresh = usable.filter((option) => option.id !== previousTransition);
        const options = fresh.length ? fresh : usable;
        if (options.length) {
          const target = music.drops.includes(b0) ? 1 : special ? 0.8 : level / 2;
          const weights = options.map(({ strength, weight }) => Math.exp(-((strength - target) ** 2) / 0.08) * (weight ?? 1));
          let pick = rng() * weights.reduce((sum, weight) => sum + weight, 0);
          let index = weights.findIndex((weight) => (pick -= weight) < 0);
          if (index < 0) index = options.length - 1;
          const moduleId = options[index].id;
          shot.transition = { moduleId, beats: special ? Math.min(2, 2 * recipe.transitionBeats) : recipe.transitionBeats };
          previousTransition = moduleId;
        }
      }
    }
    if (!shot.transition) previousTransition = '';
    plan.shots.push(shot);
    previousMedia = item.id;
    previousSrc = srcOf(item);
    b0 = b1;
  }

  // Drop 強調固定保留；其餘點綴受預算與冷卻限制。
  const flashes: PlanOverlay[] = settings.dropHit === null ? [] : music.drops.filter((d) => d >= start && d < end)
    .map((d) => ({ b0: d, b1: d + 1, moduleId: settings.dropHit! }));
  const candidates: PlanOverlay[] = [];
  const sectionAt = (beat: number) => music.sections.find((section) => section.b0 <= beat && beat < section.b1);
  const levelMatches = (mood: AccentOpt['mood'], beat: number) => {
    const level = music.level[beat] ?? 0;
    return mood === 'calm' ? level === 0 : mood === 'intense' ? level === 2 : level >= 1;
  };
  const energyMatches = (mood: AccentOpt['mood'], energy: number, intro: boolean, hold: boolean) =>
    !(hold && intro && mood !== 'calm') &&
    (mood === 'calm' ? energy < 0.45 : mood === 'intense' ? energy >= 0.75 : hold || energy >= 0.45);
  const addSpan = (at: number, sectionEnd: number, length: number, option: AccentOpt) => {
    if (at < start || at >= end || at >= sectionEnd) return;
    candidates.push({ b0: at, b1: Math.min(end, sectionEnd, at + Math.max(1, length)), moduleId: option.id,
      ...(option.everyBeat ? { everyBeat: true } : {}) });
  };
  for (const option of settings.accents) {
    if (option.hit) {
      const positions = new Set(music.accents.filter((beat) => beat >= start && beat < end));
      for (let beat = start; beat < end; beat++) if (beat % 8 === 0 && beats[beat]?.down) positions.add(beat);
      for (const beat of positions) {
        const section = sectionAt(beat);
        if (section && levelMatches(option.mood, beat)) addSpan(beat, section.b1, option.beats ?? 1, option);
      }
      continue;
    }
    for (const section of music.sections) {
      const b0 = Math.max(start, section.b0), b1 = Math.min(end, section.b1);
      if (b0 >= b1 || !energyMatches(option.mood, section.energy, section.kind === 'intro', !option.everyBeat)) continue;
      if (option.everyBeat) {
        for (let beat = b0; beat < b1; beat++) if (beat % 8 === 0 && beats[beat]?.down)
          addSpan(beat, b1, option.beats ?? (rng() < 0.5 ? 4 : 8), option);
      } else {
        for (const beat of [section.b0, section.b0 + 8])
          addSpan(beat, b1, option.beats ?? (rng() < 0.5 ? 4 : 8), option);
      }
    }
  }
  const selected = [...flashes];
  const order = candidates.map((item) => ({ item, rank: rng() })).sort((a, b) => a.rank - b.rank);
  const accentBudgets = new Map<number, number>();
  for (const { item } of order) {
    if (selected.some((other) => item.b0 < other.b1 + 4 && other.b0 < item.b1 + 4)) continue;
    const window = Math.floor((item.b0 - start) / 32);
    const budget = recipe.accentsPer32;
    if (!accentBudgets.has(window)) accentBudgets.set(window,
      Math.floor(budget) + (rng() < budget % 1 ? 1 : 0));
    const allowed = accentBudgets.get(window)!;
    if (selected.filter((o) => !flashes.includes(o) && Math.floor((o.b0 - start) / 32) === window).length >= allowed) continue;
    selected.push(item);
  }
  selected.sort((a, b) => a.b0 - b.b0 || a.b1 - b.b1);
  plan.overlays = selected.filter((item, i) => (flashes.includes(item) || i === 0 || item.moduleId !== selected[i - 1].moduleId) &&
    !plan.pops.some((p) => item.b0 < p.b1 && p.b0 < item.b1));

  if (speedOptions?.variants.length && (speedOptions.per32 > 0 || every)) {
    const assignmentRng = speedRng ?? random(seed ^ 0x53504545);
    const skip: Partial<Record<SpeedSkip, number>> = {};
    const skipped = (k: SpeedSkip) => { skip[k] = (skip[k] ?? 0) + 1; };
    plan.speedSkip = skip;
    const enabled = new Set(speedOptions.variants);
    const regions = new Map<string, { t0: number; t1: number }[]>();
    const regionOf = new Map<PlanShot, { t0: number; t1: number }>();
    const strongTransitions = new Set(['tr-whip', 'tr-zoomblur', 'tr-crashzoom', 'tr-flash', 'tr-rgbsplit', 'tr-glitch']);
    const whooshTransitions = new Set(['tr-whip', 'tr-zoomblur', 'tr-crashzoom', 'tr-push', 'tr-spin']);
    const reverseVariants = new Set<SpeedVariant>(['rewindToCut', 'reverseForwardB', 'rewindReturn', 'beatBoomerang']);
    for (const shot of plan.shots) {
      const item = media.find((m) => m.id === shot.mediaId);
      if (item?.kind !== 'video') continue;
      const list = regions.get(item.id) ?? [];
      const region = shot.speed
        ? { t0: shot.in + shot.speed.sourceMin, t1: shot.in + shot.speed.sourceMax }
        : { t0: shot.in, t1: shot.in + duration(shot.b0, shot.b1) };
      list.push(region);
      regionOf.set(shot, region);
      regions.set(item.id, list);
    }
    let lastEnd = -Infinity;
    for (let i = 0; i < plan.shots.length; i++) {
      const shot = plan.shots[i];
      if (shot.speed) { lastEnd = shot.b1; continue; }
      const item = media.find((m) => m.id === shot.mediaId);
      const nextFixed = reserveReverse ? plan.shots.slice(i + 1).find((s) => !!s.speed) : undefined;
      if (item?.kind !== 'video') continue;
      if (!every && (shot.b0 - lastEnd < 4 || nextFixed && nextFixed.b0 - shot.b1 < 4)) { skipped('spacing'); continue; }
      const bucket = Math.floor((shot.b0 - start) / 32);
      if (!speedBudget.has(bucket)) speedBudget.set(bucket,
        Math.floor(speedOptions.per32) + (assignmentRng() < speedOptions.per32 % 1 ? 1 : 0));
      if (!every && (speedCounts.get(bucket) ?? 0) >= speedBudget.get(bucket)!) { skipped('spacing'); continue; }
      const level = music.level[shot.b0] ?? 1;
      const length = shot.b1 - shot.b0;
      const hits = [...new Set([...music.accents, ...beats.flatMap((beat, b) => beat.down ? [b] : [])])]
        .filter((b) => b > shot.b0 && b < shot.b1);
      const hardEnd = shot.b1 < end && (music.drops.includes(shot.b1) ||
        music.sections.some((section) => section.b0 === shot.b1 || section.b1 === shot.b1)) &&
        !plan.shots[i + 1]?.transition;
      const boundaryEnd = shot.b1 < end && (music.drops.includes(shot.b1) ||
        music.sections.some((section) => section.b0 === shot.b1 || section.b1 === shot.b1));
      const boundaryStart = music.drops.includes(shot.b0) ||
        music.sections.some((section) => section.b0 === shot.b0 || section.b1 === shot.b0);
      const nextStrong = strongTransitions.has(plan.shots[i + 1]?.transition?.moduleId ?? '');
      const nextWhoosh = whooshTransitions.has(plan.shots[i + 1]?.transition?.moduleId ?? '');
      const ownStrong = strongTransitions.has(shot.transition?.moduleId ?? '');
      const candidates: { variant: SpeedVariant; hitBeat?: number }[] = [];
      if (enabled.has('hitRamp') && level >= 1 && length >= 2 && hardEnd) candidates.push({ variant: 'hitRamp' });
      if (enabled.has('beatPulse') && level >= 1 && length >= 2) candidates.push({ variant: 'beatPulse' });
      if (enabled.has('drift') && level === 0 && length >= 4) candidates.push({ variant: 'drift' });
      if (enabled.has('holdHit') && level === 2 && length >= 3 && hits.length)
        candidates.push({ variant: 'holdHit', hitBeat: hits[Math.floor(assignmentRng() * hits.length)] });
      if (!reserveReverse && enabled.has('rewindToCut') && (every ? length >= 1 : level >= 1 && length >= 3 &&
        (boundaryEnd && !plan.shots[i + 1]?.transition || nextStrong))) candidates.push({ variant: 'rewindToCut' });
      if (!reserveReverse && enabled.has('reverseForwardB') && level >= 1 && length >= 3 &&
        (boundaryStart || ownStrong) && !reveal.has(shot.b0)) candidates.push({ variant: 'reverseForwardB' });
      if (!reserveReverse && enabled.has('rewindReturn') && level === 2 && length >= 4) candidates.push({ variant: 'rewindReturn' });
      if (enabled.has('beatBoomerang') && level === 2 && length >= 2 && length <= 4) candidates.push({ variant: 'beatBoomerang' });
      if (enabled.has('slowPocket') && level === 1 && length >= 2) candidates.push({ variant: 'slowPocket' });
      // 卡帶停：停住之後接硬切或轉場都可以；1 拍的鏡頭也放得下（減速 3/4 拍 + 停 1/4 拍）
      if (enabled.has('tapeStop') && level >= 1 && length >= 1 && boundaryEnd)
        candidates.push({ variant: 'tapeStop' });
      if (enabled.has('whooshRamp') && level >= 1 && length >= 1 && nextWhoosh)
        candidates.push({ variant: 'whooshRamp' });
      if (enabled.has('beatStutter') && level === 2 && length >= 2)
        candidates.push({ variant: 'beatStutter' });
      if (!candidates.length) { skipped('kind'); continue; }
      const pick = candidates[Math.floor(assignmentRng() * candidates.length)];
      const raw = speedCurve(pick.variant, shot.b0, shot.b1, (b) => beatTime(beats, b),
        speedOptions.intensity, { hitBeat: pick.hitBeat });
      if (!raw) { skipped('kind'); continue; }
      // 加速後素材不夠長：這個鏡頭不加速
      let speed = boostSpeed(raw, boost);
      if (speed.sourceMax - speed.sourceMin > item.duration - 0.02) speed = raw;
      const window = speed.sourceMax - speed.sourceMin;
      const latest = item.duration - 0.02 - speed.sourceMax;
      if (!(window > 0) || latest < -speed.sourceMin) { skipped('short'); continue; }
      const prior = regions.get(item.id) ?? [];
      const own = prior.indexOf(regionOf.get(shot)!);
      if (own >= 0) prior.splice(own, 1);
      const pick0 = item.info
        ? bestIn(item.info, window, level / 2, prior, assignmentRng, item.highlights, item.ban)
        : assignmentRng() * Math.max(0, latest + speed.sourceMin);
      // 動作最大的那格對準曲線的重點（剪前倒抽 = 開始倒帶那一刻）
      const w0 = alignPeak(item, pick0, window, speedFocus(speed, shot.b0, shot.b1, (b) => beatTime(beats, b)) - speed.sourceMin, prior, every);
      const sourceEnd = w0 + window;
      const margin = reverseVariants.has(pick.variant) ? (item.info?.step ?? 0.2) / 2 : 0.1;
      const meanMotion = item.info ? item.info.motion
        .slice(Math.max(0, Math.floor(w0 / item.info.step)), Math.min(item.info.motion.length, Math.ceil(sourceEnd / item.info.step)))
        .reduce((sum, value, _, samples) => sum + value / samples.length, 0) : 1;
      const why: SpeedSkip | null = !(w0 >= -1e-8 && sourceEnd <= item.duration - 0.02 + 1e-8) ? 'short'
        : banned(item.ban, w0, sourceEnd) ? 'ban'
          : item.info?.cuts.some((cut) => w0 < cut + margin && sourceEnd > cut - margin) ? 'cut'
            : !every && (reverseVariants.has(pick.variant) || pick.variant === 'beatStutter') && meanMotion < 0.15 ? 'motion' : null;
      if (why) {
        skipped(why);
        prior.push(regionOf.get(shot)!);
        continue;
      }
      shot.in = w0 - speed.sourceMin;
      shot.speed = speed;
      prior.push({ t0: w0, t1: sourceEnd });
      speedCounts.set(bucket, (speedCounts.get(bucket) ?? 0) + 1);
      lastEnd = shot.b1;
    }
  }
  if (settings.rules?.length) {
    const priorities: Record<RuleWhen, number> = { section: 0, beat: 1, cut: 2, accent: 3, drop: 4 };
    const proposals: { overlay: PlanOverlay; rule: RuleOpt; lane: number }[] = [];
    const addRule = (rule: RuleOpt, lane: number, b0: number, b1: number, trigger?: PlanTrigger) => {
      b0 = Math.ceil(b0);
      b1 = Math.floor(b1);
      if (b1 - b0 < 1) return;
      proposals.push({ rule, lane, overlay: { b0, b1, moduleId: rule.moduleId,
        ...(rule.params ? { params: rule.params } : {}), ...(trigger ? { trigger } : {}), lane } });
    };
    // 變速：衝進剪接點這幾種的落點（下一個鏡頭的第一拍）當重音；變速期間不疊縮放類
    const LANDING = new Set<SpeedVariant>(['hitRamp', 'whooshRamp', 'tapeStop', 'rewindToCut']);
    const ramps = plan.shots.filter((shot) => shot.speed && LANDING.has(shot.speed.variant));
    const landings = ramps.map((shot) => shot.b1).filter((b) => b >= start && b < end);
    const inRamp = (b: number) => ramps.some((shot) => b >= shot.b0 && b < shot.b1);
    for (const [lane, rule] of settings.rules.entries()) {
      if (rule.chance <= 0) continue;
      const ruleSeed = ruleHash(seed, rule.id);
      const draw = (beat: number) => ruleHash(seed, rule.id, beat) / 4294967296;
      if (rule.when === 'beat' || rule.when === 'cut' || rule.when === 'section') {
        for (const section of music.sections) {
          const b0 = Math.max(start, section.b0), b1 = Math.min(end, section.b1);
          const level = section.energy < 0.45 ? 0 : section.energy >= 0.75 ? 2 : 1;
          if (b1 - b0 < 1 || !rule.levels.includes(level)) continue;
          if (rule.when === 'section') {
            if (draw(section.b0) < rule.chance) addRule(rule, lane, b0, b1);
          } else {
            const chance = rule.chance < 1 ? { chance: rule.chance } : {};
            const trigger: PlanTrigger = rule.when === 'beat'
              ? { kind: 'beat', every: rule.every ?? 1, ...chance, seed: ruleSeed }
              : { kind: 'cut', ...chance, seed: ruleSeed };
            addRule(rule, lane, b0, b1, trigger);
          }
        }
      } else if (rule.when === 'accent') {
        const events = new Set(music.accents.filter((b) => b >= start && b < end));
        for (let b = start; b < end; b++) if (b % 8 === 0 && beats[b]?.down) events.add(b);
        for (const b of landings) events.add(b);
        for (const b of events) {
          const section = sectionAt(b);
          // 變速落點不看能量（變速本身已經挑過）
          if (section && (landings.includes(b) || rule.levels.includes(music.level[b] as 0 | 1 | 2)) && draw(b) < rule.chance)
            addRule(rule, lane, b, Math.min(end, section.b1, b + (rule.beats ?? 1)));
        }
      } else {
        for (const d of music.drops) if (d >= start && d < end && draw(d) < rule.chance)
          addRule(rule, lane, d, Math.min(end, d + (rule.beats ?? 1)));
      }
    }
    proposals.sort((a, b) => priorities[b.rule.when] - priorities[a.rule.when] || a.lane - b.lane || a.overlay.b0 - b.overlay.b0);
    const occupied = new Map<string, Set<number>>();
    const counts = new Map<number, number>();
    const breath = settings.rules.some((rule) => rule.when === 'drop')
      ? new Set(music.drops.filter((d) => d >= start && d < end).map((d) => d - 1)) : new Set<number>();
    for (const { overlay, rule } of proposals) {
      const ambient = rule.group === 'ambient';
      const key = rule.group === 'other' ? `other:${rule.moduleId}` : rule.group;
      const groupBeats = occupied.get(key) ?? new Set<number>();
      let pieceStart = -1;
      const finish = (beat: number) => {
        if (pieceStart < 0) return;
        plan.overlays.push({ ...overlay, b0: pieceStart, b1: beat });
        for (let b = pieceStart; b < beat; b++) {
          if (!ambient) {
            groupBeats.add(b);
            counts.set(b, (counts.get(b) ?? 0) + 1);
          }
        }
        pieceStart = -1;
      };
      for (let b = overlay.b0; b < overlay.b1; b++) {
        const allowed = (ambient || !groupBeats.has(b) && (counts.get(b) ?? 0) < 4) &&
          (ambient || rule.when === 'drop' || !breath.has(b)) &&
          // 變速期間不疊一直在動的縮放（每拍 / 整段）；剪接點、重音、drop 這種打一下的照樣打（落點正好是變速衝進去的那一拍）
          (rule.group !== 'zoom' || (rule.when !== 'beat' && rule.when !== 'section') || !inRamp(b)) &&
          (ambient || rule.group === 'flash' || rule.group === 'color' ||
            !plan.pops.some((p) => b >= p.b0 && b < p.b1 + 1));
        if (allowed) {
          if (pieceStart < 0) pieceStart = b;
        } else finish(b);
      }
      finish(overlay.b1);
      if (!ambient) occupied.set(key, groupBeats);
    }
    plan.overlays.sort((a, b) => a.b0 - b.b0 || (a.lane ?? -1) - (b.lane ?? -1));
  }
  // 有人的鏡頭：打開臉部追蹤；有開推近 / 拉遠就推近到臉上
  for (const shot of plan.shots) {
    const m = media.find((x) => x.id === shot.mediaId);
    if (!m) continue;
    const f = m.kind === 'image' ? m.face ?? null
      : m.info ? faceIn(m.info, shot.in + (shot.speed?.sourceMin ?? 0), shot.in + (shot.speed?.sourceMax ?? duration(shot.b0, shot.b1))) : null;
    if (!f || f.h < FACE_MIN_H) continue;
    shot.face = f;
    // 主角在這個鏡頭裡的取樣點（離中間最近的）
    const t0 = m.kind === 'image' ? 0 : shot.in + (shot.speed?.sourceMin ?? 0);
    const t1 = m.kind === 'image' ? 0 : shot.in + (shot.speed?.sourceMax ?? duration(shot.b0, shot.b1));
    const mid = (t0 + t1) / 2;
    // 取樣大約每秒一格：短鏡頭可能夾在兩格中間，前後放寬 1 秒
    const pt = m.leadPts?.filter((p) => p.t >= t0 - 1 && p.t <= t1 + 1).sort((a, b) => Math.abs(a.t - mid) - Math.abs(b.t - mid))[0];
    if (pt) shot.anchor = pt;
    else if (m.kind === 'video' && m.info?.faces) {
      const { step, faces } = m.info;
      let bi = -1;
      for (let i = Math.max(0, Math.floor(t0 / step)); i <= Math.min(faces.length - 1, Math.ceil(t1 / step)); i++)
        if (faces[i] && faces[i]!.h >= FACE_MIN_H && (bi < 0 || Math.abs(i * step - mid) < Math.abs(bi * step - mid))) bi = i;
      if (bi >= 0) shot.faceAnchor = { ...faces[bi]!, t: bi * step };
    }
    if (settings.kenBurns) {
      delete shot.motion;
      shot.push = true;
    }
  }
  return plan;
}

/** 臉至少要這麼大（素材高度的比例）才算有人 */
const FACE_MIN_H = 0.03;

/** 計畫的摘要特徵。 */
export function planStats(plan: EditPlan): { shots: number; avgBeatsPerShot: number; transitions: number; overlays: number } {
  const shots = plan.shots.length;
  return {
    shots,
    avgBeatsPerShot: shots ? plan.shots.reduce((sum, s) => sum + s.b1 - s.b0, 0) / shots : 0,
    transitions: plan.shots.filter((s) => s.transition).length,
    overlays: plan.overlays.length,
  };
}

/**
 * 變速鏡頭：在原本挑的位置附近（前後一個鏡頭長），找動作最大的那一格，讓它落在 focus（相對片段開頭的素材秒數）。
 * AI 導演標的精彩秒數加分；放不下（超出素材、跨過剪接點、避開的範圍、跟已經用過的重疊）的位置不考慮；找不到就照原本。
 */
function alignPeak(m: { duration: number; info?: MediaInfo; highlights?: number[]; ban?: Span[] }, w0: number, window: number, focus: number,
  used: { t0: number; t1: number }[], wide = false): number {
  const info = m.info;
  if (!info?.motion.length || !(window > 0)) return w0;
  const end = m.duration - 0.02;
  const half = info.step / 2;
  // wide（每個鏡頭都套用）：整個素材都找，原本的位置放不下也能換到別處
  const lo = wide ? 0 : Math.max(0, w0 - window), hi = wide ? end : Math.min(end, w0 + 2 * window);
  let best = -Infinity, at = w0;
  for (let i = Math.max(1, Math.floor(lo / info.step)); i < info.motion.length && (i - 0.5) * info.step <= hi; i++) {
    // 動作量是這格跟上一格的差：動作發生在兩格中間
    const t = (i - 0.5) * info.step;
    const w = t - focus;
    if (w < 0 || w + window > end || banned(m.ban, w, w + window) ||
      info.cuts.some((c) => w < c + half && w + window > c - half)) continue;
    // 跟已經用過的重疊：扣分（素材不夠時還是可以用）
    const reused = used.some((u) => w < u.t1 && w + window > u.t0) ? 1 : 0;
    const score = info.motion[i] + (m.highlights?.some((h) => Math.abs(h - t) <= info.step) ? 0.3 : 0) - reused;
    if (score > best) { best = score; at = w; }
  }
  return at;
}

/** 強烈的轉場：剪前倒抽可以衝進去（跟變速挑種類時的判斷一樣） */
const STRONG_TR = new Set(['tr-whip', 'tr-zoomblur', 'tr-crashzoom', 'tr-flash', 'tr-rgbsplit', 'tr-glitch']);
