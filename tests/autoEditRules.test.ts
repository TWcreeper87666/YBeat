import { DEFAULT_OPTIONS, planEdit, RECIPES, type PlanInput, type PlanOptions, type RuleOpt } from '../src/engine/autoEdit';
import type { MusicInfo } from '../src/engine/musicAnalysis';
import { chanceWindow, hitWindow, picked, triggerMarks, type FxTrigger } from '../src/engine/trigger';
import { STYLES, STYLE_IDS } from '../src/engine/autoEditStyles';
import { BUILTIN_MODULES } from '../src/modules/builtin';
import { fxGroup, transitionOpt } from '../src/engine/autoEditPools';

let fails = 0;
const ok = (cond: boolean, msg: string) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) fails++;
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const beats = Array.from({ length: 32 }, (_, i) => ({ t: i * 0.5, down: false }));
const music: MusicInfo = {
  energy: Array(32).fill(0.6), level: Array(32).fill(1),
  sections: [{ b0: 0, b1: 16, energy: 0.6, kind: 'body' }, { b0: 16, b1: 32, energy: 0.8, kind: 'drop' }],
  drops: [16], accents: [8],
};
const input: PlanInput = { beats, music, media: [{ id: 'video', kind: 'video', duration: 40 }], recipe: RECIPES.rhythm, seed: 42 };
const rule = (id: string, when: RuleOpt['when'], group: RuleOpt['group'], extra: Partial<RuleOpt> = {}): RuleOpt =>
  ({ id, moduleId: id, when, group, levels: [0, 1, 2], chance: 1, hit: false, ...extra });
const plan = (rules: RuleOpt[], changes: Partial<PlanOptions> = {}, request: Partial<PlanInput> = {}) =>
  planEdit({ ...input, ...request, options: { ...DEFAULT_OPTIONS, transitions: [], accents: [], dropHit: null, rules, ...changes } });
const noLane = <T extends { lane?: number }>(list: T[]) => list.map(({ lane: _l, ...rest }) => rest);

// 內建風格：高潮逐拍換鏡、段落固定轉場、每個切點震動、氛圍整段鋪著。
{
  const fastBeats = Array.from({ length: 32 }, (_, i) => ({ t: i * 60 / 170, down: i % 4 === 0 }));
  const hot: MusicInfo = { energy: Array(32).fill(0.9), level: Array(32).fill(2),
    sections: [{ b0: 0, b1: 16, energy: 0.9, kind: 'body' }, { b0: 16, b1: 32, energy: 0.9, kind: 'drop' }],
    drops: [16], accents: [] };
  for (const id of STYLE_IDS) {
    const style = STYLES[id];
    const transitions = BUILTIN_MODULES.filter((m) => m.kind === 'transition' && style.trWeights[m.id] > 0)
      .map(transitionOpt);
    const rules: RuleOpt[] = style.rules.map((r) => {
      const mod = BUILTIN_MODULES.find((m) => m.id === r.moduleId)!;
      return { ...r, group: r.drive ? 'ambient' : fxGroup(mod), hit: false };
    });
    const result = planEdit({ beats: fastBeats, music: hot, media: input.media, recipe: RECIPES[id], seed: 42,
      options: { ...DEFAULT_OPTIONS, transitions, accents: [], dropHit: null, rules } });
    ok(transitions.length === 1 && result.shots.slice(1).every((s) => !s.transition || s.transition.moduleId === transitions[0].id), `${id} 只用一種轉場`);
    ok(result.overlays.some((o) => o.moduleId === 'fx-shake' && o.trigger?.kind === 'cut') &&
      ['fx-vignette', 'fx-strobe'].every((moduleId) => result.overlays.some((o) => o.moduleId === moduleId && o.b0 === 0 && o.b1 === 16)), `${id} 剪接震動與整段氛圍`);
    if (id !== 'calm') ok(result.shots.every((s) => s.b1 - s.b0 === 1), `${id} 170 BPM 高能量逐拍換鏡`);
  }
}

// 可重現、加一層不影響其他東西
{
  const base = [rule('pulse', 'beat', 'zoom', { chance: 0.6 }), rule('hit', 'accent', 'flash')];
  const first = plan(base);
  ok(same(plan(base), first), '同一組特效層結果固定');
  const added = plan([base[0], rule('grain', 'section', 'ambient'), base[1]]);
  ok(same(added.shots, first.shots) && same(added.pops, first.pops), '多加一層：鏡頭、主體跳出不變');
  ok(same(noLane(added.overlays.filter((o) => o.moduleId === 'pulse')), noLane(first.overlays.filter((o) => o.moduleId === 'pulse'))), '多加一層：其他層不變');
}

// 機率 0 不產生；100% 不帶 chance
{
  const overlays = plan([rule('off', 'beat', 'zoom', { chance: 0 }), rule('on', 'beat', 'flash')]).overlays;
  const on = overlays.filter((o) => o.moduleId === 'on');
  ok(!overlays.some((o) => o.moduleId === 'off'), '機率 0 不產生');
  ok(on.length === 2, '每拍層：每個段落一個方塊');
  ok(on[0]?.trigger?.kind === 'beat' && on[0].trigger.every === 1 && !('chance' in on[0].trigger), '100% 的觸發不帶 chance');
  const half = plan([rule('half', 'beat', 'zoom', { chance: 0.5 })]).overlays[0];
  ok(half?.trigger?.chance === 0.5 && typeof half.trigger.seed === 'number', '50% 的觸發帶 chance 與 seed');
}

// 同組：低優先度的讓開（切成兩段）
{
  const overlays = plan([rule('base', 'section', 'zoom'), rule('accent', 'accent', 'zoom', { beats: 2 })]).overlays;
  ok(same(overlays.filter((o) => o.moduleId === 'base' && o.b0 < 16).map((o) => [o.b0, o.b1]), [[0, 8], [10, 16]]), '同組衝突：段落層在重音處切開');
  const acc = overlays.find((o) => o.moduleId === 'accent');
  ok(acc?.b0 === 8 && acc.b1 === 10, '重音層保留 8..10');
}

// 氛圍可以疊；非氛圍同時最多 4 個
{
  const groups = ['zoom', 'shake', 'flash', 'glitch', 'color'] as const;
  const overlays = plan([...groups.map((group) => rule(group, 'section', group)), rule('grain', 'section', 'ambient')]).overlays;
  let capOk = true, grainOk = true;
  for (let beat = 0; beat < 32; beat++) {
    if (overlays.filter((o) => o.b0 <= beat && beat < o.b1 && o.moduleId !== 'grain').length !== 4) capOk = false;
    if (overlays.filter((o) => o.b0 <= beat && beat < o.b1 && o.moduleId === 'grain').length !== 1) grainOk = false;
  }
  ok(capOk, '非氛圍同時最多 4 個');
  ok(grainOk, '氛圍照樣疊上去');
  ok(new Set(overlays.map((o) => o.lane)).size === 5, '每層有自己的 lane');
}

// 主體跳出保護區、drop 前留一拍
{
  const result = plan([rule('zoom', 'section', 'zoom'), rule('flash', 'section', 'flash'), rule('drop', 'drop', 'ambient')],
    { pops: { variants: ['step'], per32: 4 } },
    { media: [{ id: 'subject', kind: 'image', duration: 0, pop: { ok: true, centered: true, cx: 0, cy: 0 } }, { id: 'base', kind: 'video', duration: 40 }] });
  ok(result.pops.length > 0, '有主體跳出');
  ok(result.pops.every((pop) => result.overlays.filter((o) => o.moduleId === 'zoom').every((o) => o.b1 <= pop.b0 || o.b0 >= pop.b1 + 1)), '主體跳出期間沒有縮放');
  ok(result.pops.every((pop) => result.overlays.some((o) => o.moduleId === 'flash' && o.b0 < pop.b1 + 1 && o.b1 > pop.b0)), '主體跳出期間可以有閃光');
  ok(!result.overlays.some((o) => o.moduleId === 'zoom' && o.b0 <= 15 && o.b1 > 15), 'drop 前一拍留白');
}

// 轉場權重 0 不會被挑到
{
  const result = plan([], { transitions: [{ id: 'off', strength: 0.5, weight: 0 }, { id: 'on', strength: 0.5, weight: 1 }] },
    { recipe: { ...RECIPES.rhythm, transitionRate: 1, sectionTransitionRate: 1 } });
  ok(result.shots.some((s) => s.transition?.moduleId === 'on'), '權重 1 的轉場會用到');
  ok(!result.shots.some((s) => s.transition?.moduleId === 'off'), '權重 0 的轉場不會用到');
  ok(plan([], { transitions: [{ id: 'off', strength: 0.5, weight: 0 }] }).shots.every((s) => !s.transition), '只有權重 0 = 沒有轉場');
}

// 舊點綴：每 32 拍預算的小數只抽一次
{
  const denseMusic: MusicInfo = { ...music, accents: Array.from({ length: 32 }, (_, i) => i), drops: [] };
  let max = 0;
  for (let seed = 0; seed < 80; seed++) {
    const result = plan([], { accents: [{ id: 'hit', hit: true, mood: 'any' }] }, { seed, music: denseMusic, recipe: { ...RECIPES.rhythm, accentsPer32: 0.5 } });
    max = Math.max(max, result.overlays.length);
  }
  ok(max <= 1, '0.5 / 32 拍最多 1 個');
}

// 變速落點當重音、變速期間不疊縮放
{
  const result = plan([rule('zoom', 'section', 'zoom'), rule('hit', 'accent', 'flash', { levels: [] })],
    { speed: { variants: ['hitRamp'], per32: 4, intensity: 0.5 } });
  const ramps = result.shots.filter((s) => s.speed?.variant === 'hitRamp');
  ok(ramps.length > 0, '有衝入剪接');
  ok(ramps.every((r) => r.b1 >= 32 || result.overlays.some((o) => o.moduleId === 'hit' && o.b0 === r.b1)), '落點有重音特效（能量不符也放）');
  ok(ramps.every((r) => !result.overlays.some((o) => o.moduleId === 'zoom' && o.b0 < r.b1 && o.b1 > r.b0)), '變速期間沒有縮放');
}

// 有人的鏡頭打開臉部追蹤
{
  const info = (p: number) => ({ step: 0.5, duration: 40, motion: Array(80).fill(0.5), quality: Array(80).fill(1), cuts: [], people: Array(80).fill(p),
    faces: Array(80).fill(p ? { x: 0.3, y: 0.4, h: 0.2 } : null) });
  const withFace = plan([], {}, { media: [{ id: 'video', kind: 'video', duration: 40, info: info(1) }] });
  ok(withFace.shots.length > 0 && withFace.shots.every((s) => s.face?.x === 0.3 && s.push), '有人的影片：鏡頭帶臉的位置、推近');
  ok(plan([], { kenBurns: false }, { media: [{ id: 'video', kind: 'video', duration: 40, info: info(1) }] }).shots.every((s) => s.face && !s.push), '關掉推近：只追蹤不推近');
  const noFace = plan([], {}, { media: [{ id: 'video', kind: 'video', duration: 40, info: info(0) }] });
  ok(noFace.shots.every((s) => !s.face), '沒人的影片：不標 face');
  const imgs = plan([], {}, { media: [{ id: 'a', kind: 'image', duration: 0, people: 0.8, face: { x: 0.5, y: 0.3, h: 0.2 } }, { id: 'b', kind: 'image', duration: 0, people: 0, face: null }] });
  ok(imgs.shots.every((s) => !!s.face === (s.mediaId === 'a')), '圖片：看整張有沒有人');
  ok(imgs.shots.every((s) => s.mediaId !== 'a' || !s.motion), '推近到臉取代一般推近');
}

// AI 導演說要避開的範圍一定不用；整支都不能用的不選
{
  const info = { step: 0.5, duration: 40, motion: Array(80).fill(0.5), quality: Array(80).fill(1), cuts: [] };
  const ban: [number, number][] = [[0, 30]];
  const r = plan([], {}, { media: [{ id: 'video', kind: 'video', duration: 40, info, ban }] });
  ok(r.shots.length > 0 && r.shots.every((s) => s.in >= 30 - 0.05), `只用沒避開的部分（${r.shots.map((s) => s.in.toFixed(1)).join(',')}）`);
  const two = plan([], {}, { media: [{ id: 'a', kind: 'video', duration: 40, info, ban: [[0, 40]] }, { id: 'b', kind: 'video', duration: 40, info }] });
  ok(two.shots.every((s) => s.mediaId === 'b'), '整支避開的素材不選');
  const noInfo = plan([], {}, { media: [{ id: 'video', kind: 'video', duration: 40, ban }] });
  ok(noInfo.shots.every((s) => s.in >= 30 - 0.05), '沒分析過也避開');
}

// 主角：鏡頭帶主角的臉當追蹤起點（在鏡頭範圍裡、離中間最近的取樣點）
{
  const faces = Array(80).fill({ x: 0.7, y: 0.4, w: 0.1, h: 0.2 });
  const info = { step: 0.5, duration: 40, motion: Array(80).fill(0.5), quality: Array(80).fill(1), cuts: [], people: Array(80).fill(0.8), faces };
  const leadPts = Array.from({ length: 40 }, (_, i) => ({ t: i, x: 0.7, y: 0.4, w: 0.1, h: 0.2 }));
  const r = plan([], {}, { media: [{ id: 'video', kind: 'video', duration: 40, info, leadPts }] });
  ok(r.shots.length > 0 && r.shots.every((s) => !!s.anchor && s.anchor.t >= s.in - 1 - 1e-6), '有主角：每個鏡頭都有追蹤起點（鏡頭範圍前後 1 秒內）');
  const none = plan([], {}, { media: [{ id: 'video', kind: 'video', duration: 40, info }] });
  ok(none.shots.every((s) => !s.anchor && !!s.face), '沒有主角資料：只開一般臉部追蹤');
  // 別人的臉在 (0.2, 0.4)、主角只在前 10 秒出現在 (0.7, 0.4)
  const other = { ...info, faces: Array(80).fill({ x: 0.2, y: 0.4, w: 0.1, h: 0.3 }) };
  const early = leadPts.filter((p) => p.t < 10);
  const known = plan([], {}, { media: [{ id: 'video', kind: 'video', duration: 40, info: other, leadPts: early, leadKnown: true }] });
  ok(known.shots.some((s) => s.in > 12) && known.shots.every((s) => (s.anchor ? s.face?.x === 0.7 : !s.face)),
    '有主角：附近沒有主角的鏡頭不追別人，推近對準主角');
}

// 影片的一格（popOnly）：只拿來做主體跳出、揭露拍用它，不進一般輪播
{
  const result = plan([], { pops: { variants: ['step'], per32: 4 } }, {
    media: [
      { id: 'video', kind: 'video', duration: 40 },
      { id: 'video@3.00', kind: 'image', duration: Infinity, popOnly: true, pop: { ok: true, centered: true, cx: 0, cy: 0 } },
    ],
  });
  ok(result.pops.length > 0 && result.pops.every((p) => p.mediaId === 'video@3.00'), '影片的一格拿來做主體跳出');
  ok(result.shots.filter((s) => s.mediaId === 'video@3.00').every((s) => result.pops.some((p) => p.b1 === s.b0)), '影片的一格只出現在揭露拍');
}

// 觸發機率（trigger.ts）
{
  const pts = Array.from({ length: 400 }, (_, i) => i * 0.5);
  const tr: FxTrigger = { kind: 'beat', every: 1, chance: 0.5, seed: 7 };
  const n = pts.filter((_, i) => picked(tr, pts, i)).length;
  ok(n > 160 && n < 240, `50% 挑中約一半（${n}/400）`);
  ok(pts.every((_, i) => picked({ kind: 'beat', every: 1 }, pts, i)), '沒有機率 = 全部觸發');
  ok(!pts.some((_, i) => picked({ kind: 'beat', every: 1, chance: 0, seed: 1 }, pts, i)), '機率 0 = 都不觸發');
  const marks = triggerMarks(pts, 10, 40, tr);
  ok(marks.every((t) => picked(tr, pts, Math.round(t * 2))), '時間軸只畫挑中的觸發點');
  const i = pts.findIndex((_, k) => k >= 20 && picked(tr, pts, k));
  const j = pts.findIndex((_, k) => k >= 20 && !picked(tr, pts, k));
  const w = chanceWindow(tr, pts, 10, 190, pts[i] + 0.1);
  ok(!!w && w.t0 === pts[i] && Math.abs(w.d - 0.5) < 1e-9, '挑中的拍子作用到下一拍');
  ok(chanceWindow(tr, pts, 10, 190, pts[j] + 0.1) === null, '沒挑中的拍子不作用');
  ok(chanceWindow(tr, pts, 10, 190, 9) === null, '方塊開始前不作用');
  const other: FxTrigger = { ...tr, seed: 8 };
  ok(pts.some((_, k) => picked(tr, pts, k) !== picked(other, pts, k)), '不同 seed 挑法不同');
}

// 衝擊特效每次觸發只打一下
{
  const w = { t0: 2, d: 0.5 };
  ok(same(hitWindow(w, 2.1, 0.35), { t0: 2, d: 0.35 }), '拍子比 @duration 長：只播 @duration');
  ok(hitWindow(w, 2.4, 0.35) === null, '打完到下一拍之間不作用');
  ok(hitWindow(w, 2.4, 0.6) === w, '拍子比 @duration 短：照拍子');
  ok(hitWindow(w, 2.4, 0) === w, '持續特效不變');
  ok(hitWindow(null, 2.1, 0.35) === null, '沒挑中的拍子照樣不作用');
}

if (fails) {
  console.log(`\n${fails} 個失敗`);
  process.exit(1);
}
