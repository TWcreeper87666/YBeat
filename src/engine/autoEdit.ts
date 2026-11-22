import type { MusicInfo } from './musicAnalysis';
import { bestIn, type MediaInfo } from './mediaAnalysis';
import type { SectionKind } from './musicAnalysis';
import type { PlanPop, PopVariant } from './subjectPop';
import { speedCurve, type PlanSpeed, type SpeedVariant } from './speedRamp';

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
export type RecipeId = 'calm' | 'rhythm' | 'hype';
export const RECIPES: Record<RecipeId, Recipe> = {
  calm: { id: 'calm', beatsPerShot: [8, 4, 4], jitter: 0.1, transitionRate: 0.25, sectionTransitionRate: 0.6, accentsPer32: 0.5, minShotSec: 1.2, maxShotSec: 8, transitionBeats: 1 },
  rhythm: { id: 'rhythm', beatsPerShot: [4, 2, 1], jitter: 0.2, transitionRate: 0.15, sectionTransitionRate: 0.8, accentsPer32: 2, minShotSec: 0.35, maxShotSec: 6, transitionBeats: 0.5 },
  hype: { id: 'hype', beatsPerShot: [2, 1, 1], jitter: 0.25, transitionRate: 0.1, sectionTransitionRate: 1, accentsPer32: 4, minShotSec: 0.2, maxShotSec: 4, transitionBeats: 0.5 },
};
/** strength：0 柔和，1 強烈。 */
export interface TransitionOpt { id: string; strength: number }
/** hit 為單點；everyBeat 為逐拍觸發；其餘為持續型。 */
export interface AccentOpt { id: string; hit: boolean; everyBeat?: boolean; mood: 'calm' | 'any' | 'intense'; beats?: number }
export interface PlanOptions {
  transitions: TransitionOpt[];
  accents: AccentOpt[];
  dropHit: string | null;
  kenBurns: boolean;
  order: 'library' | 'shuffle';
  pops?: { variants: PopVariant[]; per32: number };
  speed?: { variants: SpeedVariant[]; per32: number; intensity: number };
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
  /** 圖片主體構圖。 */
  pop?: { ok: boolean; centered: boolean; cx: number; cy: number };
}
export interface KenBurns { from: { scale: number; x: number; y: number }; to: { scale: number; x: number; y: number } }
export interface PlanTransition { moduleId: string; beats: number }
export interface PlanShot { b0: number; b1: number; mediaId: string; in: number; motion?: KenBurns; transition?: PlanTransition; speed?: PlanSpeed }
export interface PlanOverlay { b0: number; b1: number; moduleId: string; params?: Record<string, number | boolean>; everyBeat?: boolean }
export interface EditPlan { seed: number; recipe: string; shots: PlanShot[]; overlays: PlanOverlay[]; pops: PlanPop[] }
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
      v === 'step' || v === 'mono' || v === 'fly' || v === 'shake');
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
      // 窗口至少需有另一個底軌素材。
      if (media.length < 2) continue;
      const ranked = candidates.map((m) => ({ m, rank: (m.roles === undefined ? 0.5 : sectionKind && m.roles.includes(sectionKind) ? 1 : 0) +
        (m.weight ?? 0.5) * 0.5 + popRng() * 0.01 })).sort((a, b) => b.rank - a.rank);
      let picked: PlanPop | undefined;
      for (const { m } of ranked) {
        const variants = enabled.filter((v) => (v !== 'step' && v !== 'shake' || m.pop!.centered) &&
          b1 - (v === 'fly' ? 2 : 4) >= start);
        if (!variants.length) continue;
        const alternate = variants.filter((v) => v !== lastVariant);
        const pool = alternate.length ? alternate : variants;
        const variant = pool[Math.floor(popRng() * pool.length)];
        picked = { b0: b1 - (variant === 'fly' ? 2 : 4), b1, variant, mediaId: m.id, cx: m.pop!.cx, cy: m.pop!.cy,
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
    p.mediaId === id && b0 < p.b1 && p.b0 < b1);

  // 每輪用完素材，依設定洗牌。
  let queue: PlanMedia[] = [];
  let previousMedia = '';
  const rotation = media.some((item) => item.weight !== 0) ? media.filter((item) => item.weight !== 0) : media;
  const refill = () => {
    queue = [];
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
  const usedVideo = new Map<string, { b0: number; b1: number }[]>();
  let previousMotion = 0;
  let previousTransition = '';
  for (let b0 = start; b0 < end;) {
    const level = music.level[b0] ?? 1;
    let length = Math.max(1, recipe.beatsPerShot[level]);
    if (rng() < recipe.jitter) length = rng() < 0.5 ? Math.max(1, Math.round(length / 2)) : length * 2;
    const stop = hardCuts.find((b) => b > b0) ?? end;
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
    for (let i = 0; i < queue.length && !reserved; i++) {
      const m = queue[i];
      if (blockedMedia(m.id, b0, b1) || m.id === previousMedia || m.kind === 'video' && m.duration + 1e-9 < shotSec) continue;
      const roleMatch = m.roles === undefined ? 0.5 : sectionKind && m.roles.includes(sectionKind) ? 1 : 0;
      const score = roleMatch + (m.weight ?? 0.5) * 0.5 + rng() * 0.3;
      if (score > bestScore) { bestScore = score; choice = i; }
    }
    if (reserved) choice = queue.findIndex((m) => m.id === reserved.mediaId);
    if (choice < 0 && !reserved) choice = queue.findIndex((m) => !blockedMedia(m.id, b0, b1) && m.id !== previousMedia);
    if (choice < 0 && !reserved) choice = queue.findIndex((m) => !blockedMedia(m.id, b0, b1));
    if (choice < 0 && !reserved) {
      refill();
      choice = queue.findIndex((m) => !blockedMedia(m.id, b0, b1));
    }
    const item = reserved ? media.find((m) => m.id === reserved.mediaId)! : queue[choice] ?? queue[0];
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
          regions.map((r) => ({ t0: r.b0, t1: r.b1 })), rng, item.highlights);
      } else {
        const options = Array.from({ length: 12 }, () => latest * rng());
        options.push(0, latest);
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
      if (rng() < (special ? recipe.sectionTransitionRate : recipe.transitionRate)) {
        const options = settings.transitions.filter((option) => option.id !== previousTransition);
        if (options.length) {
          const target = music.drops.includes(b0) ? 1 : special ? 0.8 : level / 2;
          const weights = options.map(({ strength }) => Math.exp(-((strength - target) ** 2) / 0.08));
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
  for (const { item } of order) {
    if (selected.some((other) => item.b0 < other.b1 + 4 && other.b0 < item.b1 + 4)) continue;
    const window = Math.floor((item.b0 - start) / 32);
    const budget = recipe.accentsPer32;
    const allowed = Math.floor(budget) + (rng() < budget % 1 ? 1 : 0);
    if (selected.filter((o) => !flashes.includes(o) && Math.floor((o.b0 - start) / 32) === window).length >= allowed) continue;
    selected.push(item);
  }
  selected.sort((a, b) => a.b0 - b.b0 || a.b1 - b.b1);
  plan.overlays = selected.filter((item, i) => (flashes.includes(item) || i === 0 || item.moduleId !== selected[i - 1].moduleId) &&
    !plan.pops.some((p) => item.b0 < p.b1 && p.b0 < item.b1));

  const speedOptions = settings.speed;
  if (speedOptions?.variants.length && speedOptions.per32 > 0) {
    const speedRng = random(seed ^ 0x53504545);
    const enabled = new Set(speedOptions.variants);
    const speedBudget = new Map<number, number>();
    const speedCounts = new Map<number, number>();
    const regions = new Map<string, { t0: number; t1: number }[]>();
    const regionOf = new Map<PlanShot, { t0: number; t1: number }>();
    for (const shot of plan.shots) {
      const item = media.find((m) => m.id === shot.mediaId);
      if (item?.kind !== 'video') continue;
      const list = regions.get(item.id) ?? [];
      const region = { t0: shot.in, t1: shot.in + duration(shot.b0, shot.b1) };
      list.push(region);
      regionOf.set(shot, region);
      regions.set(item.id, list);
    }
    let lastEnd = -Infinity;
    for (let i = 0; i < plan.shots.length; i++) {
      const shot = plan.shots[i];
      const item = media.find((m) => m.id === shot.mediaId);
      if (item?.kind !== 'video' || shot.b0 - lastEnd < 4) continue;
      const bucket = Math.floor((shot.b0 - start) / 32);
      if (!speedBudget.has(bucket)) speedBudget.set(bucket,
        Math.floor(speedOptions.per32) + (speedRng() < speedOptions.per32 % 1 ? 1 : 0));
      if ((speedCounts.get(bucket) ?? 0) >= speedBudget.get(bucket)!) continue;
      const level = music.level[shot.b0] ?? 1;
      const length = shot.b1 - shot.b0;
      const hits = [...new Set([...music.accents, ...beats.flatMap((beat, b) => beat.down ? [b] : [])])]
        .filter((b) => b > shot.b0 && b < shot.b1);
      const hardEnd = shot.b1 < end && (music.drops.includes(shot.b1) ||
        music.sections.some((section) => section.b0 === shot.b1 || section.b1 === shot.b1)) &&
        !plan.shots[i + 1]?.transition;
      const candidates: { variant: SpeedVariant; hitBeat?: number }[] = [];
      if (enabled.has('hitRamp') && level >= 1 && length >= 2 && hardEnd) candidates.push({ variant: 'hitRamp' });
      if (enabled.has('beatPulse') && level >= 1 && length >= 2) candidates.push({ variant: 'beatPulse' });
      if (enabled.has('drift') && level === 0 && length >= 4) candidates.push({ variant: 'drift' });
      if (enabled.has('holdHit') && level === 2 && length >= 3 && hits.length)
        candidates.push({ variant: 'holdHit', hitBeat: hits[Math.floor(speedRng() * hits.length)] });
      if (!candidates.length) continue;
      const pick = candidates[Math.floor(speedRng() * candidates.length)];
      const speed = speedCurve(pick.variant, shot.b0, shot.b1, (b) => beatTime(beats, b),
        speedOptions.intensity, { hitBeat: pick.hitBeat });
      if (!speed) continue;
      const window = speed.sourceMax - speed.sourceMin;
      const latest = item.duration - 0.02 - speed.sourceMax;
      if (!(window > 0) || latest < -speed.sourceMin) continue;
      const prior = regions.get(item.id) ?? [];
      const own = prior.indexOf(regionOf.get(shot)!);
      if (own >= 0) prior.splice(own, 1);
      const w0 = item.info
        ? bestIn(item.info, window, level / 2, prior, speedRng, item.highlights)
        : speedRng() * Math.max(0, latest + speed.sourceMin);
      const sourceEnd = w0 + window;
      const valid = w0 >= -1e-8 && sourceEnd <= item.duration - 0.02 + 1e-8 &&
        !item.info?.cuts.some((cut) => w0 < cut + 0.1 && sourceEnd > cut - 0.1);
      if (!valid) {
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
  return plan;
}

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
