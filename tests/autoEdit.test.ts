import { DEFAULT_OPTIONS, planEdit, planStats, RECIPES, type PlanMedia, type PlanOptions, type Recipe } from '../src/engine/autoEdit';
import type { MusicInfo } from '../src/engine/musicAnalysis';
import type { MediaInfo } from '../src/engine/mediaAnalysis';
import { SPEED_VARIANTS } from '../src/engine/speedRamp';
import type { PopVariant } from '../src/engine/subjectPop';

let fails = 0;
const ok = (cond: boolean, msg: string) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) fails++;
};
const beats = Array.from({ length: 128 }, (_, i) => ({ t: i * 60 / 128, down: i % 4 === 0 }));
const music: MusicInfo = {
  energy: Array.from({ length: 128 }, (_, i) => i < 32 ? 0.2 : i < 64 ? 0.6 : 0.9),
  level: Array.from({ length: 128 }, (_, i) => i < 32 ? 0 : i < 64 ? 1 : 2),
  sections: [{ b0: 0, b1: 32, energy: 0.2, kind: 'intro' }, { b0: 32, b1: 64, energy: 0.6, kind: 'build' }, { b0: 64, b1: 128, energy: 0.9, kind: 'drop' }],
  drops: [64], accents: [16, 40, 64, 80, 96, 112],
};
const media: PlanMedia[] = [
  { id: 'a', kind: 'video', duration: 20 }, { id: 'b', kind: 'image', duration: 0 },
  { id: 'c', kind: 'video', duration: 12 }, { id: 'd', kind: 'image', duration: 0 },
];
const input = { beats, music, media, recipe: RECIPES.rhythm, seed: 42 };
const options = (change: Partial<PlanOptions>): PlanOptions => ({ ...DEFAULT_OPTIONS, ...change });
const withOptions = (settings: PlanOptions, seed = 42, recipe: Recipe = RECIPES.rhythm) => planEdit({ ...input, options: settings, seed, recipe });
const plan = planEdit(input);

ok(JSON.stringify(plan) === JSON.stringify(planEdit(input)), '相同種子結果固定');
ok(JSON.stringify(plan) !== JSON.stringify(planEdit({ ...input, seed: 43 })), '不同種子結果不同');
ok(plan.shots[0].b0 === 0 && plan.shots.at(-1)?.b1 === 128 && plan.shots.every((s, i) => i === 0 || s.b0 === plan.shots[i - 1].b1), '鏡頭連續覆蓋範圍');
ok(plan.shots.every((s, i) => i === 0 || s.mediaId !== plan.shots[i - 1].mediaId), '素材不連續重複');
ok(new Set(plan.shots.slice(0, media.length).map((s) => s.mediaId)).size === media.length, '首輪使用所有素材');
ok([32, 64].every((b) => plan.shots.some((s) => s.b0 === b)), '段落切點保留');
const count = (id: 'calm' | 'rhythm' | 'hype') => planStats(planEdit({ ...input, recipe: RECIPES[id] })).shots;
ok(count('hype') > count('rhythm') && count('rhythm') > count('calm'), '配方控制鏡頭數');
const avg = (level: number) => {
  const shots = plan.shots.filter((s) => music.level[s.b0] === level);
  return shots.reduce((sum, s) => sum + s.b1 - s.b0, 0) / shots.length;
};
ok(avg(2) < avg(0), '高能量鏡頭較短');
ok(plan.shots.every((s) => {
  const m = media.find((x) => x.id === s.mediaId)!;
  return m.kind === 'image' || s.in >= 0 && s.in + (s.b1 - s.b0) * 60 / 128 <= m.duration + 1e-6;
}), '影片取樣不超出長度');
ok(plan.shots.every((s) => media.find((m) => m.id === s.mediaId)!.kind === 'image' ? !!s.motion : !s.motion) && !plan.shots[0].transition, '圖片動態與首鏡硬切');
ok(plan.shots.every((s) => !s.motion || [s.motion.from, s.motion.to].every((e) => Math.abs(e.x) <= (e.scale - 1) / 2 + 1e-9 && Math.abs(e.y) <= (e.scale - 1) / 2 + 1e-9)), 'Ken Burns 不露出邊緣');
ok(plan.shots.every((s, i) => i === 0 || !s.transition || !plan.shots[i - 1].transition || s.transition.moduleId !== plan.shots[i - 1].transition!.moduleId), '相鄰轉場 id 不重複');
ok(plan.overlays.every((o, i) => i === 0 || plan.overlays[i - 1].b1 <= o.b0) && plan.overlays.some((o) => o.b0 === 64 && o.moduleId === 'fx-flash'), '點綴不重疊且 drop 有閃白');
ok(planEdit({ ...input, media: [] }).shots.length === 0, '無素材無鏡頭');
ok(planEdit({ ...input, media: media.slice(0, 1) }).shots.length > 1, '單一素材仍可排片');
const shortVideo = planEdit({ ...input, media: [{ id: 'short', kind: 'video', duration: 1.1 }] });
ok(shortVideo.shots.every((s) => s.in + (s.b1 - s.b0) * 60 / 128 <= 1.1 + 1e-6), '短影片不超界');
const ranged = planEdit({ ...input, range: [16, 96] });
ok(ranged.shots[0].b0 === 16 && ranged.shots.at(-1)?.b1 === 96, '指定範圍連續');

// 輪流隨機：每輪每個素材用一次；同一支影片的片段盡量分開
{
  const segs = [
    { id: 'A@1', srcId: 'A', kind: 'video', duration: 30 }, { id: 'A@2', srcId: 'A', kind: 'video', duration: 30 }, { id: 'A@3', srcId: 'A', kind: 'video', duration: 30 },
    { id: 'B@1', srcId: 'B', kind: 'video', duration: 30 }, { id: 'C@1', srcId: 'C', kind: 'video', duration: 30 }, { id: 'D@1', srcId: 'D', kind: 'video', duration: 30 },
  ] as PlanMedia[];
  const bag = planEdit({ ...input, media: segs, options: options({ order: 'bag', transitions: [] }), seed: 7 });
  const ids = bag.shots.map((s) => s.mediaId);
  const src = (id: string) => id.split('@')[0];
  ok(ids.length >= 12 && new Set(ids.slice(0, 6)).size === 6 && new Set(ids.slice(6, 12)).size === 6, '輪流：每輪每個素材用一次');
  ok(ids.slice(0, 12).every((id, i) => i === 0 || src(id) !== src(ids[i - 1])), '輪流：同一支影片的片段不相鄰');
}

const chosen = withOptions(options({ transitions: [{ id: 'soft', strength: 0.1 }, { id: 'hard', strength: 0.9 }] }));
ok(chosen.shots.every((s) => !s.transition || ['soft', 'hard'].includes(s.transition.moduleId)), '轉場只用指定 id');
ok(withOptions(options({ transitions: [] })).shots.every((s) => !s.transition), '空轉場清單全硬切');
const always: Recipe = { ...RECIPES.rhythm, id: 'custom', transitionRate: 1, sectionTransitionRate: 1, accentsPer32: 12 };
const single = withOptions(options({ transitions: [{ id: 'one', strength: 0.5 }] }), 42, always);
ok(single.shots.filter((s) => s.transition?.moduleId === 'one').length > single.shots.length / 2, '只開一種轉場：每個剪接點都可以用（不再隔鏡）');
ok(single.recipe === 'custom', '自訂配方 id 保留');
ok(single.shots.every((s) => !s.transition || s.transition.beats === (s.b0 === 32 || s.b0 === 64 ? 1 : 0.5)), '轉場長度依切點加倍');
ok(withOptions(options({ transitions: [{ id: 'soft', strength: 0.1 }] }), 42, always).shots.some((s) => s.transition?.moduleId === 'soft'), '純柔和轉場可用');
ok(withOptions(options({ transitions: [{ id: 'hard', strength: 0.9 }] }), 42, always).shots.some((s) => s.transition?.moduleId === 'hard'), '純強烈轉場可用');
const mixed = options({ transitions: [{ id: 'soft', strength: 0 }, { id: 'mid', strength: 0.5 }, { id: 'hard', strength: 1 }] });
const strengths = new Map(mixed.transitions.map((t) => [t.id, t.strength]));
const mixedPlans = Array.from({ length: 80 }, (_, seed) => withOptions(mixed, seed, always));
const dropValues = mixedPlans.flatMap((p) => p.shots.filter((s) => s.b0 === 64 && s.transition).map((s) => strengths.get(s.transition!.moduleId)!));
const lowValues = mixedPlans.flatMap((p) => p.shots.filter((s) => s.b0 < 32 && s.transition).map((s) => strengths.get(s.transition!.moduleId)!));
ok(dropValues.length > 0 && lowValues.length > 0 && dropValues.reduce((a, b) => a + b, 0) / dropValues.length > lowValues.reduce((a, b) => a + b, 0) / lowValues.length, 'drop 轉場平均較強');
ok(withOptions(options({ kenBurns: false })).shots.every((s) => !s.motion), '關閉 Ken Burns 無圖片動態');

ok(withOptions(options({ accents: [], dropHit: null })).overlays.length === 0, '空點綴且無 dropHit 無覆蓋');
const hitOnly = withOptions(options({ accents: [], dropHit: 'x' }));
ok(hitOnly.overlays.length === 1 && hitOnly.overlays[0].b0 === 64 && hitOnly.overlays[0].moduleId === 'x', '自訂 dropHit 位於 64');
const customFx = options({ accents: [{ id: 'quiet', hit: true, mood: 'calm' }, { id: 'loud', hit: true, mood: 'intense' }], dropHit: 'x' });
const fxPlan = withOptions(customFx, 42, always);
ok(fxPlan.overlays.every((o) => ['quiet', 'loud', 'x'].includes(o.moduleId)), '點綴只用指定 id');
ok(fxPlan.overlays.filter((o) => o.moduleId === 'quiet').every((o) => music.level[o.b0] === 0) && fxPlan.overlays.filter((o) => o.moduleId === 'loud').every((o) => music.level[o.b0] === 2), 'hit mood 符合能量');
const pulse = withOptions(options({ accents: [{ id: 'pulse', hit: false, everyBeat: true, mood: 'intense' }], dropHit: null }), 42, always);
ok(pulse.overlays.some((o) => o.everyBeat === true && o.b1 - o.b0 >= 4 && o.b1 - o.b0 <= 8), '逐拍點綴長 4 至 8 拍');
const shuffled = withOptions(options({ order: 'shuffle', transitions: [], accents: [], dropHit: null }));
ok(shuffled.shots.every((s, i) => i === 0 || s.mediaId !== shuffled.shots[i - 1].mediaId) &&
  new Set(shuffled.shots.slice(0, media.length).map((s) => s.mediaId)).size === media.length, '完全洗牌首輪用齊且不連續重複');

const info: MediaInfo = { step: 0.5, duration: 20, motion: Array.from({ length: 40 }, (_, i) => i < 20 ? 0 : 1), quality: Array(40).fill(1), cuts: [] };
const analyzedMedia: PlanMedia[] = [{ id: 'analyzed', kind: 'video', duration: 20, info }];
const highPlans = Array.from({ length: 30 }, (_, seed) => planEdit({ ...input, seed, media: analyzedMedia, range: [64, 80] }));
const highShots = highPlans.flatMap((p) => p.shots);
ok(highShots.filter((s) => s.in >= 10).length > highShots.length / 2, 'high energy favors moving footage');
const cutPlans = Array.from({ length: 15 }, (_, seed) => planEdit({ ...input, seed, media: [{ ...analyzedMedia[0], info: { ...info, cuts: [10] } }], range: [0, 32] }));
ok(cutPlans.every((p) => p.shots.every((s) => !(s.in < 10.1 && s.in + (s.b1 - s.b0) * 60 / 128 > 9.9))), 'analyzed shots avoid source cuts');
const highlightPlan = planEdit({ ...input, media: [{ ...analyzedMedia[0], highlights: [8] }], range: [0, 4] });
ok(highlightPlan.shots[0].in <= 8 && highlightPlan.shots[0].in + (highlightPlan.shots[0].b1 - highlightPlan.shots[0].b0) * 60 / 128 > 8, 'highlight pulls video in point');

const weighted: PlanMedia[] = [{ id: 'off', kind: 'image', duration: 0, weight: 0 }, { id: 'on', kind: 'image', duration: 0 }];
ok(planEdit({ ...input, media: weighted }).shots.every((s) => s.mediaId === 'on'), 'weight zero excluded when another item exists');
ok(planEdit({ ...input, media: weighted.slice(0, 1) }).shots.every((s) => s.mediaId === 'off'), 'weight zero used alone');
const roleMedia: PlanMedia[] = [{ id: 'drop', kind: 'image', duration: 0, roles: ['drop'] }, { id: 'intro', kind: 'image', duration: 0, roles: ['intro'] }];
const rolePlans = Array.from({ length: 60 }, (_, seed) => planEdit({ ...input, seed, media: roleMedia, range: [64, 66] }));
ok(rolePlans.flatMap((p) => p.shots).filter((s) => s.mediaId === 'drop').length > rolePlans.length / 2, 'drop role preferred in drop section');
const popMedia: PlanMedia[] = [
  { id: 'subject', kind: 'image', duration: 0, pop: { ok: true, centered: true, cx: 0.2, cy: 0 } },
  { id: 'background', kind: 'video', duration: 60 },
];
const popOptions = options({ pops: { variants: ['step'], per32: 4 } });
const popped = planEdit({ ...input, media: popMedia, options: popOptions });
const reveal = popped.pops.find((p) => p.b1 === 64);
ok(!!reveal && reveal.variant === 'step' && reveal.b0 === 60, 'drop reveal uses step window');
ok(popped.shots.some((s) => s.b0 === 64 && s.mediaId === 'subject' && !s.transition && !s.motion), 'reveal hard cuts to full image');
ok(popped.shots.filter((s) => s.b0 < 64 && s.b1 > 60).every((s) => s.mediaId !== 'subject'), 'window base shots exclude subject');
ok(popped.overlays.filter((o) => o.b0 < 64 && o.b1 > 60).length === 0 &&
  popped.overlays.some((o) => o.b0 === 64 && o.moduleId === 'fx-flash'), 'pop window clears accents but keeps drop hit');
ok(popped.pops.every((p, i) => i === 0 || p.b1 - popped.pops[i - 1].b1 >= 16), 'pop reveals spaced sixteen beats');
{
  const three: PlanMedia[] = [...popMedia.filter((m) => m.id !== 'subject'),
    ...['s1', 's2', 's3'].map((id) => ({ id, kind: 'image' as const, duration: 0, pop: { ok: true, centered: true, cx: 0, cy: 0 } }))];
  const multi = planEdit({ ...input, media: three, options: popOptions });
  ok(multi.pops.length >= 2 && new Set(multi.pops.map((p) => p.mediaId)).size === multi.pops.length, `每次主體跳出換一張圖：${multi.pops.map((p) => p.mediaId)}`);
}
const noPops = planEdit({ ...input, options: options({ pops: { variants: [], per32: 4 } }) });
ok(plan.pops.length === 0 && noPops.pops.length === 0 && JSON.stringify(plan.shots) === JSON.stringify(noPops.shots), 'disabled pops preserve shots');
const flyOnly = planEdit({ ...input, media: popMedia, options: options({ pops: { variants: ['fly'], per32: 4 } }) });
ok(flyOnly.pops.length > 0 && flyOnly.pops.every((p) => p.variant === 'fly' && p.b1 - p.b0 === 2), 'fly variant respected');
const offCentre = planEdit({ ...input, media: [{ ...popMedia[0], pop: { ok: true, centered: false, cx: 0.4, cy: 0 } }, popMedia[1]],
  options: options({ pops: { variants: ['step', 'shake'], per32: 4 } }) });
ok(offCentre.pops.length === 0, 'off centre media rejects step and shake');
ok(JSON.stringify(popped) === JSON.stringify(planEdit({ ...input, media: popMedia, options: popOptions })), 'pops deterministic');

const popImages: PlanMedia[] = [
  { id: 'A', kind: 'image', duration: 0, pop: { ok: true, centered: true, cx: 0.1, cy: 0 } },
  { id: 'B', kind: 'image', duration: 0, pop: { ok: false, centered: false, cx: 0, cy: 0 } },
  { id: 'base', kind: 'video', duration: 60 },
];
const variantPlan = (variants: PopVariant[],
  mediaItems = popImages, text?: string) => planEdit({ ...input, media: mediaItems,
    options: options({ pops: { variants, per32: 4, text } }) });
const crossPlan = variantPlan(['crossShot']);
ok(crossPlan.pops.length > 0 && crossPlan.pops.every((p) => p.revealMediaId === 'B' && p.mediaId === 'A' &&
  crossPlan.shots.some((shot) => shot.b0 === p.b1 && shot.mediaId === 'B') &&
  crossPlan.shots.filter((shot) => shot.b0 < p.b1 && shot.b1 > p.b0)
    .every((shot) => shot.mediaId !== 'A' && shot.mediaId !== 'B')), 'crossShot 揭露 B 且窗口避開 A、B');
ok(variantPlan(['textBehind'], popImages, '  ').pops.length === 0 &&
  variantPlan(['textBehind'], popImages, '  主標  ').pops.every((p) => p.text === '主標'),
  'textBehind 需要非空文字並去除空白');
const offCentrePop = popImages.map((m) => m.id === 'A' ? { ...m, pop: { ...m.pop!, centered: false } } : m);
for (const variant of ['step', 'shake', 'trail', 'grid', 'spin', 'halo'] as const) {
  ok(variantPlan([variant], offCentrePop).pops.length === 0, `${variant} 只接受置中主體`);
}
for (const variant of ['mono', 'fly', 'crossShot', 'textBehind', 'dim', 'blur'] as const) {
  ok(variantPlan([variant], offCentrePop, '標題').pops.length > 0, `${variant} 接受非置中主體`);
}
const suited: PlanMedia[] = [
  { ...popImages[0], id: 'low', popSuit: 0 },
  { ...popImages[0], id: 'high', popSuit: 1 },
  popImages[2],
];
ok(variantPlan(['step'], suited).pops.every((p) => p.mediaId === 'high'), 'popSuit 零分不選主體');
const rankedSuit = suited.map((m) => m.id === 'low' ? { ...m, popSuit: 0.1 } : m);
ok(Array.from({ length: 20 }, (_, seed) => planEdit({ ...input, seed, media: rankedSuit,
  options: options({ pops: { variants: ['step'], per32: 4 } }) })).every((p) =>
    p.pops.find((pop) => pop.b1 === 64)?.mediaId === 'high'),
  'popSuit 高分優先');
ok(JSON.stringify(crossPlan) === JSON.stringify(variantPlan(['crossShot'])), '新種類規劃結果固定');
ok(JSON.stringify(popped) === JSON.stringify(planEdit({ ...input, media: popMedia,
  options: options({ pops: { variants: ['step'], per32: 4, text: undefined } }) })), '舊種類輸出維持一致');

const tracedImages: PlanMedia[] = popImages.map((m) => m.id === 'A'
  ? { ...m, pop: { ...m.pop!, path: 'M20 20L180 20L180 180Z' } } : m);
for (const variant of ['silhouetteWindow', 'subjectHole'] as const) {
  const traced = variantPlan([variant], tracedImages);
  ok(traced.pops.length > 0 && traced.pops.every((p) => p.variant === variant && p.mediaId === 'A' &&
    p.revealMediaId === 'B' && p.path === tracedImages[0].pop!.path && p.b1 - p.b0 === 4 &&
    traced.shots.some((shot) => shot.b0 === p.b1 && shot.mediaId === 'B') &&
    traced.shots.filter((shot) => shot.b0 < p.b1 && shot.b1 > p.b0)
      .every((shot) => shot.mediaId !== 'A' && shot.mediaId !== 'B')),
  `${variant} 揭露 B 且窗口避開 A、B`);
  ok(variantPlan([variant]).pops.length === 0 &&
    variantPlan([variant], [{ ...tracedImages[0], pop: { ...tracedImages[0].pop!, path: '  ' } },
      tracedImages[1], tracedImages[2]]).pops.length === 0 &&
    variantPlan([variant], [tracedImages[0], tracedImages[2]]).pops.length === 0,
  `${variant} 需要非空路徑和第二張圖片`);
  ok(JSON.stringify(traced) === JSON.stringify(variantPlan([variant], tracedImages)),
    `${variant} 規劃結果固定`);
}

const speedRecipe: Recipe = { ...RECIPES.rhythm, beatsPerShot: [4, 4, 4], jitter: 0, minShotSec: 0.1, maxShotSec: 20 };
const speedSettings = options({ speed: { variants: SPEED_VARIANTS, per32: 3.5, intensity: 0.7 } });
const speedMedia: PlanMedia[] = [{ id: 'speedVideo', kind: 'video', duration: 80 }, { id: 'speedImage', kind: 'image', duration: 0 }];
const speedInput = { ...input, recipe: speedRecipe, media: speedMedia };
const speedPlan = planEdit({ ...speedInput, options: speedSettings });
const plainSpeedPlan = planEdit({ ...speedInput, options: options({}) });
ok(JSON.stringify(plainSpeedPlan) === JSON.stringify(planEdit({ ...speedInput, options: options({ speed: undefined }) })) &&
  plainSpeedPlan.shots.every((s) => s.speed === undefined), 'disabled speed preserves existing plan');
ok(speedPlan.shots[0].b0 === 0 && speedPlan.shots.at(-1)?.b1 === 128 &&
  speedPlan.shots.every((s, i) => i === 0 || s.b0 === speedPlan.shots[i - 1].b1),
  'speed reservations preserve continuous coverage');
const speedShots = speedPlan.shots.filter((s) => s.speed);
ok(speedShots.length > 0 && speedShots.every((s) => speedMedia.find((m) => m.id === s.mediaId)?.kind === 'video' &&
  SPEED_VARIANTS.includes(s.speed!.variant)), 'speed only on videos with enabled variants');
ok(speedShots.every((s) => s.in + s.speed!.sourceMin >= -1e-8 && s.in + s.speed!.sourceMax <= 80 - 0.02 + 1e-8),
  'speed source windows stay in bounds');
ok(speedShots.every((s, i) => i === 0 || s.b0 - speedShots[i - 1].b1 >= 4), 'speed cooldown');
ok(Array.from({ length: 4 }, (_, bucket) => speedShots.filter((s) => Math.floor(s.b0 / 32) === bucket).length <= 4).every(Boolean),
  'speed budget per 32 beats');
ok(speedShots.filter((s) => s.speed!.variant === 'hitRamp').every((s) => music.drops.includes(s.b1) ||
  music.sections.some((section) => section.b0 === s.b1 || section.b1 === s.b1)), 'hit ramps end at section boundaries');
ok(JSON.stringify(speedPlan) === JSON.stringify(planEdit({ ...speedInput, options: speedSettings })), 'speed deterministic');
const pulseOnly = planEdit({ ...speedInput, options: options({ speed: { variants: ['beatPulse'], per32: 12, intensity: 1 } }) });
ok(pulseOnly.shots.filter((s) => s.speed).every((s) => s.speed!.variant === 'beatPulse'), 'enabled variant respected');
const cutInfo: MediaInfo = { step: 0.5, duration: 80, motion: Array(160).fill(1), quality: Array(160).fill(1), cuts: [15, 30, 45, 60] };
const cutSpeed = planEdit({ ...speedInput, media: [{ ...speedMedia[0], info: cutInfo }],
  options: options({ speed: { variants: ['drift', 'beatPulse'], per32: 16, intensity: 1 } }) });
ok(cutSpeed.shots.some((s) => s.speed) && cutSpeed.shots.filter((s) => s.speed).every((s) =>
  cutInfo.cuts.every((cut) => !(s.in + s.speed!.sourceMin < cut + 0.1 && s.in + s.speed!.sourceMax > cut - 0.1))),
  'analyzed speed windows avoid cuts');

const reverseIds = ['rewindToCut', 'reverseForwardB', 'rewindReturn', 'beatBoomerang'];
const reverseSettings = options({ speed: { variants: SPEED_VARIANTS, per32: 16, intensity: 0.8 } });
const reversePlans = Array.from({ length: 30 }, (_, seed) => planEdit({ ...speedInput, seed, options: reverseSettings }));
const reverseShots = reversePlans.flatMap((p) => p.shots.filter((s) => s.speed && reverseIds.includes(s.speed.variant))
  .map((s) => ({ s, next: p.shots[p.shots.indexOf(s) + 1] })));
const strong = new Set(['tr-whip', 'tr-zoomblur', 'tr-crashzoom', 'tr-flash', 'tr-rgbsplit', 'tr-glitch']);
const boundary = (b: number) => music.drops.includes(b) || music.sections.some((section) => section.b0 === b || section.b1 === b);
ok(reverseShots.length > 0, 'reverse variants are selectable');
ok(reverseShots.every(({ s, next }) => {
  const length = s.b1 - s.b0;
  const level = music.level[s.b0];
  if (s.speed!.variant === 'rewindToCut') return length >= 3 &&
    (boundary(s.b1) && !next?.transition || strong.has(next?.transition?.moduleId ?? ''));
  if (s.speed!.variant === 'reverseForwardB') return length >= 3 &&
    (boundary(s.b0) || strong.has(s.transition?.moduleId ?? ''));
  if (s.speed!.variant === 'rewindReturn') return level === 2 && length >= 4;
  return level === 2 && length >= 2 && length <= 4;
}), 'reverse variants follow shot rules');
ok(reversePlans.every((p) => p.shots.filter((s) => s.speed).every((s) =>
  s.in + s.speed!.sourceMin >= -1e-8 && s.in + s.speed!.sourceMax <= 80 - 0.02 + 1e-8)),
  'reverse windows stay within video');
const staticInfo: MediaInfo = { step: 0.5, duration: 80, motion: Array(160).fill(0.1), quality: Array(160).fill(1), cuts: [] };
const staticPlans = Array.from({ length: 12 }, (_, seed) => planEdit({ ...speedInput, seed,
  media: [{ id: 'speedVideo', kind: 'video', duration: 80, info: staticInfo }], options: reverseSettings }));
ok(staticPlans.every((p) => p.shots.every((s) => !s.speed || !reverseIds.includes(s.speed.variant))),
  'static footage excludes reverse');
const phaseOneVariants = SPEED_VARIANTS.slice(0, 4);
const phaseOneSettings = options({ speed: { variants: phaseOneVariants, per32: 16, intensity: 0.8 } });
const phaseOnePlan = planEdit({ ...speedInput, options: phaseOneSettings });
ok(phaseOnePlan.shots.every((s) => !s.speed || phaseOneVariants.includes(s.speed.variant)) &&
  JSON.stringify(phaseOnePlan) === JSON.stringify(planEdit({ ...speedInput, options: phaseOneSettings })),
  'phase one only remains deterministic');
ok(JSON.stringify(reversePlans[0]) === JSON.stringify(planEdit({ ...speedInput, seed: 0, options: reverseSettings })),
  'reverse planning deterministic');

const reserveBeats = Array.from({ length: 84 }, (_, i) => ({ t: i * 0.5, down: i % 4 === 0 }));
const reserveMusic: MusicInfo = {
  energy: Array.from({ length: 84 }, (_, i) => i < 16 ? 0.2 : i < 28 ? 0.55 : i < 40 ? 0.7 : i < 68 ? 0.95 : 0.3),
  level: Array.from({ length: 84 }, (_, i) => i < 16 || i >= 68 ? 0 : i < 40 ? 1 : 2),
  sections: [
    { b0: 0, b1: 16, energy: 0.2, kind: 'intro' },
    { b0: 16, b1: 28, energy: 0.55, kind: 'body' },
    { b0: 28, b1: 40, energy: 0.7, kind: 'build' },
    { b0: 40, b1: 68, energy: 0.95, kind: 'drop' },
    { b0: 68, b1: 84, energy: 0.3, kind: 'outro' },
  ], drops: [36, 40], accents: [16, 28, 36, 40, 52, 68],
};
const longInfo: MediaInfo = { step: 0.5, duration: 90, motion: Array(180).fill(0.9),
  quality: Array(180).fill(1), cuts: [] };
const reserveMedia: PlanMedia[] = [
  { id: 'v1', kind: 'video', duration: 90, info: longInfo },
  { id: 'v2', kind: 'video', duration: 90, info: longInfo },
  { id: 'pop', kind: 'image', duration: 0, pop: { ok: true, centered: true, cx: 0, cy: 0 } },
];
const reserveInput = { beats: reserveBeats, music: reserveMusic, media: reserveMedia, recipe: RECIPES.rhythm };
const reserveBoundary = (b: number) => reserveMusic.drops.includes(b) ||
  reserveMusic.sections.some((section) => section.b0 === b || section.b1 === b);
for (const variant of ['rewindToCut', 'reverseForwardB', 'rewindReturn'] as const) {
  const settings = options({ speed: { variants: [variant], per32: 6, intensity: 0.8 },
    pops: { variants: ['step'], per32: 2 } });
  const plans = Array.from({ length: 10 }, (_, seed) => planEdit({ ...reserveInput, seed, options: settings }));
  const appearances = plans.filter((p) => p.shots.some((s) => s.speed?.variant === variant)).length;
  ok(appearances >= 6, `${variant} appears in most seeds`);
  ok(plans.every((p) => p.shots.filter((s) => s.speed?.variant === variant).every((s) => {
    const item = reserveMedia.find((m) => m.id === s.mediaId)!;
    const legal = item.kind === 'video' && s.in + s.speed!.sourceMin >= -1e-8 &&
      s.in + s.speed!.sourceMax <= item.duration - 0.02 + 1e-8;
    const clearPop = p.pops.every((pop) => !(s.b0 < pop.b1 && pop.b0 < s.b1) &&
      !(s.b0 <= pop.b1 && pop.b1 < s.b1));
    if (variant === 'rewindToCut') return legal && clearPop && s.b1 - s.b0 >= 3 && reserveBoundary(s.b1);
    if (variant === 'reverseForwardB') return legal && clearPop && s.b1 - s.b0 === 3 && reserveBoundary(s.b0);
    return legal && clearPop && s.b1 - s.b0 === 4 && reserveMusic.level[s.b0] === 2 && reserveBeats[s.b0].down;
  })), `${variant} keeps its boundary, pop, and source window rules`);
  ok(plans.every((p, seed) => JSON.stringify(p) === JSON.stringify(planEdit({ ...reserveInput, seed, options: settings }))),
    `${variant} reservations deterministic`);
  const still = { ...longInfo, motion: Array(180).fill(0.05) };
  ok(Array.from({ length: 10 }, (_, seed) => planEdit({ ...reserveInput, seed, options: settings,
    media: reserveMedia.slice(0, 2).map((m) => ({ ...m, info: still })) }))
    .every((p) => p.shots.every((s) => s.speed?.variant !== variant)), `${variant} rejects static footage`);
}
const nonReverse = options({ speed: { variants: ['beatPulse', 'beatBoomerang'], per32: 6, intensity: 0.8 } });
const noReverseBase = Array.from({ length: 10 }, (_, seed) => planEdit({ ...reserveInput, seed,
  options: options({ ...nonReverse, speed: undefined }) }));
ok(noReverseBase.every((p, seed) => {
  const withSpeed = planEdit({ ...reserveInput, seed, options: nonReverse });
  // 變速會改素材起點（in），比較切法與素材順序就好
  const layout = (x: typeof p) => JSON.stringify(x.shots.map((s) => [s.b0, s.b1, s.mediaId]));
  return layout(withSpeed) === layout(p);
}), '沒開倒播類：鏡頭切法與素材順序跟不開變速一樣');

const phaseTwoMedia: PlanMedia[] = [{ id: 'phaseTwoVideo', kind: 'video', duration: 100 }];
const phaseTwoInput = { ...speedInput, media: phaseTwoMedia };
const phaseTwoTransitions = options({ transitions: [{ id: 'tr-whip', strength: 0.8 }, { id: 'tr-push', strength: 0.6 }] });
const phaseTwoRecipe: Recipe = { ...speedRecipe, transitionRate: 1, sectionTransitionRate: 1 };
for (const variant of ['slowPocket', 'tapeStop', 'whooshRamp', 'beatStutter'] as const) {
  const settings = options({ ...phaseTwoTransitions, transitions: variant === 'tapeStop' ? [] : phaseTwoTransitions.transitions,
    speed: { variants: [variant], per32: 16, intensity: 0.8 } });
  const request = { ...phaseTwoInput, recipe: phaseTwoRecipe, options: settings };
  const plans = Array.from({ length: 24 }, (_, seed) => planEdit({ ...request, seed }));
  const selected = plans.flatMap((p) => p.shots.map((shot, i) => ({ shot, next: p.shots[i + 1] }))
    .filter(({ shot }) => shot.speed?.variant === variant));
  ok(selected.length > 0, `${variant} is assigned`);
  ok(selected.every(({ shot, next }) => {
    const length = shot.b1 - shot.b0;
    const legal = shot.in + shot.speed!.sourceMin >= -1e-8 &&
      shot.in + shot.speed!.sourceMax <= phaseTwoMedia[0].duration - 0.02 + 1e-8;
    if (variant === 'slowPocket') return legal && length >= 2 && music.level[shot.b0] === 1;
    if (variant === 'tapeStop') return legal && length >= 1 && music.level[shot.b0] >= 1 && boundary(shot.b1);
    if (variant === 'whooshRamp') return legal && music.level[shot.b0] >= 1 &&
      ['tr-whip', 'tr-zoomblur', 'tr-crashzoom', 'tr-push', 'tr-spin'].includes(next?.transition?.moduleId ?? '');
    return legal && length >= 2 && music.level[shot.b0] === 2;
  }), `${variant} follows eligibility and source limits`);
  ok(plans.every((p, seed) => JSON.stringify(p) === JSON.stringify(planEdit({ ...request, seed }))),
    `${variant} deterministic`);
}
const stillStutter: MediaInfo = { step: 0.5, duration: 100, motion: Array(200).fill(0.1),
  quality: Array(200).fill(1), cuts: [] };
ok(Array.from({ length: 8 }, (_, seed) => planEdit({ ...phaseTwoInput, seed,
  media: [{ ...phaseTwoMedia[0], info: stillStutter }],
  options: options({ speed: { variants: ['beatStutter'], per32: 16, intensity: 1 } }) }))
  .every((p) => p.shots.every((s) => s.speed?.variant !== 'beatStutter')),
  'stutter rejects low motion when analysis exists');
ok(JSON.stringify(planEdit({ ...phaseTwoInput, options: options({ speed: { variants: [], per32: 16, intensity: 1 } }) })) ===
  JSON.stringify(planEdit({ ...phaseTwoInput, options: options({}) })),
  'disabled phase two variants preserve output');

const rotationMedia: PlanMedia[] = [
  { id: 'intro', kind: 'image', duration: 0, roles: ['intro'], weight: 1 },
  { id: 'drop', kind: 'image', duration: 0, roles: ['drop'], weight: 0.8 },
  { id: 'general', kind: 'image', duration: 0, weight: 0.5 },
];
const rotated = planEdit({ ...input, media: rotationMedia });
ok(rotated.shots.every((s, i) => i === 0 || s.mediaId !== rotated.shots[i - 1].mediaId) &&
  Array.from({ length: Math.floor(rotated.shots.length / 3) }, (_, i) => rotated.shots.slice(i * 3, i * 3 + 3))
    .every((round) => new Set(round.map((s) => s.mediaId)).size === 3), 'roles and weights preserve rotation');
console.log(fails ? `\n${fails} 項測試失敗` : '\n全部通過');
if (fails) process.exit(1);
