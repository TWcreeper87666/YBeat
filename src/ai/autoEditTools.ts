/**
 * AI 助手讀 / 改「自動剪輯」面板的設定：get_auto_edit 讀目前設定（含音樂分析摘要），
 * set_auto_edit 提議修改（使用者按套用才生效），可以順便產生一版。
 * 這裡不 import projectTools（避免循環）；錯誤用傳進來的 fail 丟出。
 */
import { $t, displayName } from '../i18n';
import type { useStore } from '../store';
import { usePrefs } from '../prefs';
import { mediaBeats } from '../engine/beats';
import { categoryOf } from '../modules/categories';
import { RECIPES, type Recipe, type RecipeId } from '../engine/autoEdit';
import { accentOpt, comboAccentOpt, transitionOpt } from '../engine/autoEditPools';
import { footage, musicClips, useAutoEdit, type AutoEditSettings } from '../engine/autoEditSettings';
import { FLAT_SHAPE, shapeMusic, type EnergyShape } from '../engine/energyShape';

type S = ReturnType<typeof useStore.getState>;
export type AutoEditPatch = Partial<Omit<AutoEditSettings, 'analysis' | 'direction'>>;

const num = (description: string) => ({ type: 'number', description });
const PICK = (what: string) => ({
  type: 'object',
  description: `Which ${what} to use. Items are ids from get_auto_edit, "category:<id>" (all of one category), or "all". ${what === 'accents' ? '"combos" = all My Combos. ' : ''}only = exactly these; enable / disable = change from the current set.`,
  properties: {
    only: { type: 'array', items: { type: 'string' } },
    enable: { type: 'array', items: { type: 'string' } },
    disable: { type: 'array', items: { type: 'string' } },
  },
});

export const AUTO_EDIT_DECLS = [
  {
    name: 'get_auto_edit',
    description: 'Read the Auto Edit panel settings (which music, range, style and numbers, which media / transitions / accents are on) and, when analysed, the music sections (beat ranges, kind, energy 0..1) and drops.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'set_auto_edit',
    description: 'Propose changes to the Auto Edit panel settings (applied when the user presses Apply). generate: also cut a new take with the new settings (replace_last: replace the previous auto-edit take if it is still unchanged). Rates are 0..1.',
    parameters: {
      type: 'object',
      properties: {
        style: { type: 'string', enum: ['calm', 'rhythm', 'hype'], description: 'preset; resets the numbers before the overrides below' },
        beats_per_shot: { type: 'object', description: 'beats per shot at low / mid / high energy (1..32)', properties: { low: num(''), mid: num(''), high: num('') } },
        variation: num('0..1 chance a shot is halved / doubled'),
        min_shot_sec: num('shortest shot, seconds'),
        max_shot_sec: num('longest shot, seconds'),
        transition_rate: num('0..1 chance of a transition at a regular cut'),
        section_transition_rate: num('0..1 chance at section boundaries / drops'),
        transition_beats: num('transition length in beats (0.25..4); doubled at sections'),
        accents_per_32: num('accents per 32 beats (0..16)'),
        music: { type: 'string', description: 'audio clip id to cut to' },
        range: { type: 'string', enum: ['all', 'loop'], description: 'whole music clip or the loop range' },
        order: { type: 'string', enum: ['library', 'shuffle'] },
        ken_burns: { type: 'boolean', description: 'slow push in / pull out on images' },
        analyze: { type: 'boolean', description: 'pick video segments by motion / quality / avoiding cuts already inside the source video' },
        director: { type: 'boolean', description: 'AI director: before cutting, an AI looks at frames of every media file and decides which sections each suits, its priority and best moments' },
        director_note: { type: 'string', description: 'instruction for the AI director, e.g. "open with the landscape shots, faces on the drop"; empty string clears it' },
        drop_hit: { type: 'string', description: 'effect id or combo id hit on every drop; "none" to turn off' },
        energy: {
          type: 'object',
          description: 'Shape the energy curve that drives cut density and accents (energy ≥ 0.75 = high, < 0.45 = low). gain -0.5..0.5 shifts everything, contrast 0.5..2 spreads it around 0.6, points replace the control points: at = position 0..1 of the music clip, offset -1..1 (+1 ≈ +0.6 energy), linear in between (give at 0 and 1 too). reset: back to the analysed curve.',
          properties: {
            gain: num(''), contrast: num(''), reset: { type: 'boolean' },
            points: { type: 'array', items: { type: 'object', properties: { at: num(''), offset: num('') }, required: ['at', 'offset'] } },
          },
        },
        media: PICK('media'),
        transitions: PICK('transitions'),
        accents: PICK('accents'),
        generate: { type: 'boolean' },
        replace_last: { type: 'boolean' },
      },
    },
  },
];

const r2 = (x: number) => Math.round(x * 100) / 100;

/** 候選清單：id、名稱、分類（給 AI 看、也拿來解析 category:） */
function pools(s: S) {
  const combos = usePrefs.getState().fxCombos;
  return {
    media: footage(s).map((m) => ({ id: m.id, name: m.name, cat: m.kind })),
    transitions: s.modules.filter((m) => m.kind === 'transition').map((m) => ({ id: m.id, name: displayName(m.name), cat: categoryOf(m) })),
    accents: [
      ...s.modules.filter((m) => m.kind === 'effect').map((m) => ({ id: m.id, name: displayName(m.name), cat: categoryOf(m) })),
      ...combos.map((c) => ({ id: c.id, name: c.name, cat: 'combo' })),
    ],
  };
}

export function readAutoEdit(s: S): Record<string, unknown> {
  const st = useAutoEdit.getState();
  const music = musicClips(s);
  const audioId = st.audioId && music.some((a) => a.id === st.audioId) ? st.audioId : music[0]?.id ?? null;
  const audio = s.audios.find((a) => a.id === audioId);
  const bpm = audio ? mediaBeats(s.media.find((m) => m.id === audio.mediaId))?.bpm : undefined;
  const raw = st.analysis?.audioId === audioId ? st.analysis.info : null;
  const info = raw && shapeMusic(raw, st.shape);
  const p = st.params;
  const P = pools(s);
  const combos = usePrefs.getState().fxCombos;
  const trStrength = new Map(s.modules.filter((m) => m.kind === 'transition').map((m) => [m.id, transitionOpt(m).strength]));
  const acc = new Map([
    ...s.modules.filter((m) => m.kind === 'effect').map((m) => [m.id, accentOpt(m)] as const),
    ...combos.map((c) => [c.id, comboAccentOpt(c, s.modules)] as const),
  ]);
  return {
    music: {
      selected: audioId,
      options: music.map((a) => ({ id: a.id, name: a.name || s.media.find((m) => m.id === a.mediaId)?.name, start: r2(a.start), duration: r2(a.duration) })),
      ...(bpm ? { bpm: r2(bpm) } : {}),
      ...(info ? {
        beats: info.energy.length,
        sections: info.sections.map((x) => ({ beats: [x.b0, x.b1], at: [r2(x.b0 / Math.max(1, info.energy.length)), r2(x.b1 / Math.max(1, info.energy.length))], kind: x.kind, energy: r2(x.energy) })),
        drops: info.drops,
        high_energy_beats: info.level.filter((l) => l === 2).length,
      } : { note: 'not analysed yet (the panel analyses it when opened or on generate)' }),
    },
    range: st.range,
    has_loop_range: !!s.loop,
    style: st.recipe,
    beats_per_shot: { low: p.beatsPerShot[0], mid: p.beatsPerShot[1], high: p.beatsPerShot[2] },
    variation: p.jitter, min_shot_sec: p.minShotSec, max_shot_sec: p.maxShotSec,
    transition_rate: p.transitionRate, section_transition_rate: p.sectionTransitionRate, transition_beats: p.transitionBeats,
    accents_per_32: p.accentsPer32,
    order: st.order, ken_burns: st.kenBurns, drop_hit: st.dropHit ?? 'none',
    energy: { gain: st.shape.gain, contrast: st.shape.contrast, points: st.shape.points.map((p) => ({ at: r2(p.x), offset: r2(p.y) })) },
    analyze: st.analyze, director: st.director, director_note: st.directorNote,
    ...(st.direction ? { last_direction: st.direction } : {}),
    media: P.media.map((m) => ({ ...m, on: !st.mediaOff.includes(m.id) })),
    transitions: P.transitions.map((m) => ({ ...m, strength: trStrength.get(m.id), on: !st.trOff.includes(m.id) })),
    accents: P.accents.map((m) => {
      const a = acc.get(m.id);
      return { ...m, type: a?.hit ? 'hit' : a?.everyBeat ? 'every_beat' : 'hold', mood: a?.mood, on: !st.fxOff.includes(m.id) };
    }),
  };
}

/** 解析 { only, enable, disable } → 新的「不用」清單 */
function pick(raw: unknown, list: { id: string; cat: string }[], off: string[], fail: (m: string) => never, what: string): string[] | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as { only?: unknown; enable?: unknown; disable?: unknown };
  const ids = (v: unknown): string[] => {
    const out = new Set<string>();
    for (const tok of (Array.isArray(v) ? v : v == null ? [] : [v]).map(String)) {
      if (tok === 'all') list.forEach((x) => out.add(x.id));
      else if (tok === 'combos') list.filter((x) => x.cat === 'combo').forEach((x) => out.add(x.id));
      else if (tok.startsWith('category:')) {
        const hit = list.filter((x) => x.cat === tok.slice(9));
        if (!hit.length) fail(`${what}: no items in ${tok}`);
        hit.forEach((x) => out.add(x.id));
      } else if (list.some((x) => x.id === tok)) out.add(tok);
      else fail(`${what}: unknown id ${tok} (use ids from get_auto_edit)`);
    }
    return [...out];
  };
  const all = list.map((x) => x.id);
  let next = new Set(off);
  if (r.only !== undefined) {
    const on = new Set(ids(r.only));
    next = new Set(all.filter((id) => !on.has(id)));
  }
  for (const id of ids(r.enable)) next.delete(id);
  for (const id of ids(r.disable)) next.add(id);
  return [...next];
}

/** set_auto_edit → 要改的設定（相對目前的設定算好）；回傳改了幾項 */
export function proposeAutoEdit(a: Record<string, unknown>, s: S, fail: (m: string) => never, warn: string[]): {
  summary: string; patch: AutoEditPatch; generate: boolean; replaceLast: boolean;
} {
  const st = useAutoEdit.getState();
  const patch: AutoEditPatch = {};
  let changed = 0;
  let params: Recipe = { ...st.params };
  if (a.style !== undefined) {
    const id = String(a.style) as RecipeId;
    if (!RECIPES[id]) fail(`unknown style ${String(a.style)}`);
    params = { ...RECIPES[id] };
    patch.recipe = id;
    changed++;
  }
  const n = (k: string, lo: number, hi: number): number | undefined => {
    const v = a[k];
    if (v === undefined) return undefined;
    if (typeof v !== 'number' || !Number.isFinite(v)) return fail(`${k} must be a number`);
    if (v < lo || v > hi) warn.push(`${k} clamped to ${lo}..${hi}`);
    changed++;
    return Math.min(hi, Math.max(lo, v));
  };
  const custom = (k: keyof Recipe, v: number | undefined) => {
    if (v === undefined) return;
    (params as unknown as Record<string, number>)[k] = v;
    patch.recipe = 'custom';
  };
  const bps = a.beats_per_shot as { low?: unknown; mid?: unknown; high?: unknown } | undefined;
  if (bps && typeof bps === 'object') {
    const b = [...params.beatsPerShot] as Recipe['beatsPerShot'];
    (['low', 'mid', 'high'] as const).forEach((k, i) => {
      const v = bps[k];
      if (v === undefined) return;
      if (typeof v !== 'number' || !Number.isFinite(v)) fail(`beats_per_shot.${k} must be a number`);
      b[i] = Math.min(32, Math.max(1, Math.round(v as number)));
      changed++;
    });
    params.beatsPerShot = b;
    patch.recipe = 'custom';
  }
  custom('jitter', n('variation', 0, 1));
  custom('minShotSec', n('min_shot_sec', 0.1, 10));
  custom('maxShotSec', n('max_shot_sec', 0.5, 30));
  custom('transitionRate', n('transition_rate', 0, 1));
  custom('sectionTransitionRate', n('section_transition_rate', 0, 1));
  custom('transitionBeats', n('transition_beats', 0.25, 4));
  custom('accentsPer32', n('accents_per_32', 0, 16));
  if (params.minShotSec > params.maxShotSec) fail('min_shot_sec must be ≤ max_shot_sec');
  if (patch.recipe) patch.params = { ...params, id: patch.recipe };

  if (a.music !== undefined) {
    if (!musicClips(s).some((x) => x.id === a.music)) fail(`music: ${String(a.music)} is not an audio clip with beats`);
    patch.audioId = String(a.music);
    changed++;
  }
  if (a.range !== undefined) {
    if (a.range !== 'all' && a.range !== 'loop') fail('range must be all or loop');
    if (a.range === 'loop' && !s.loop) fail('there is no loop range; ask the user to set one');
    patch.range = a.range as 'all' | 'loop';
    changed++;
  }
  if (a.order !== undefined) {
    if (a.order !== 'library' && a.order !== 'shuffle') fail('order must be library or shuffle');
    patch.order = a.order as 'library' | 'shuffle';
    changed++;
  }
  if (a.ken_burns !== undefined) {
    patch.kenBurns = !!a.ken_burns;
    changed++;
  }
  const en = a.energy as { gain?: unknown; contrast?: unknown; reset?: unknown; points?: unknown } | undefined;
  if (en && typeof en === 'object') {
    let shape: EnergyShape = en.reset ? FLAT_SHAPE() : { ...st.shape, points: st.shape.points.map((p) => ({ ...p })) };
    const clampN = (v: unknown, lo: number, hi: number, k: string) => {
      if (typeof v !== 'number' || !Number.isFinite(v)) return fail(`energy.${k} must be a number`);
      if (v < lo || v > hi) warn.push(`energy.${k} clamped to ${lo}..${hi}`);
      return Math.min(hi, Math.max(lo, v));
    };
    if (en.gain !== undefined) shape = { ...shape, gain: clampN(en.gain, -0.5, 0.5, 'gain') };
    if (en.contrast !== undefined) shape = { ...shape, contrast: clampN(en.contrast, 0.5, 2, 'contrast') };
    if (en.points !== undefined) {
      const pts = (Array.isArray(en.points) ? en.points : []).map((q) => {
        const o = q as { at?: unknown; offset?: unknown };
        return { x: clampN(o.at, 0, 1, 'points.at'), y: clampN(o.offset, -1, 1, 'points.offset') };
      }).sort((p, q) => p.x - q.x);
      // 頭尾一定要有點（沒給就補 0）
      if (!pts.length || pts[0].x > 0) pts.unshift({ x: 0, y: 0 });
      if (pts[pts.length - 1].x < 1) pts.push({ x: 1, y: 0 });
      shape = { ...shape, points: pts };
    }
    patch.shape = shape;
    changed++;
  }
  if (a.analyze !== undefined) {
    patch.analyze = !!a.analyze;
    changed++;
  }
  if (a.director !== undefined) {
    patch.director = !!a.director;
    changed++;
  }
  if (a.director_note !== undefined) {
    patch.directorNote = String(a.director_note).slice(0, 300);
    if (a.director === undefined && patch.directorNote) patch.director = true;
    changed++;
  }
  const P = pools(s);
  if (a.drop_hit !== undefined) {
    const v = String(a.drop_hit);
    if (v === 'none' || v === '') patch.dropHit = null;
    else if (P.accents.some((x) => x.id === v)) patch.dropHit = v;
    else fail(`drop_hit: unknown id ${v}`);
    changed++;
  }
  const lists: [string, keyof AutoEditPatch, { id: string; cat: string }[], string[]][] = [
    ['media', 'mediaOff', P.media, st.mediaOff],
    ['transitions', 'trOff', P.transitions, st.trOff],
    ['accents', 'fxOff', P.accents, st.fxOff],
  ];
  for (const [k, field, list, off] of lists) {
    const next = pick(a[k], list, off, fail, k);
    if (!next) continue;
    if (k === 'media' && list.every((x) => next.includes(x.id))) fail('media: at least one item must stay on');
    (patch as Record<string, unknown>)[field] = next;
    changed++;
  }
  const generate = !!a.generate;
  if (!changed && !generate) fail('nothing to change');
  const summary = generate
    ? (changed ? $t('修改自動剪輯設定 ×{0}，產生一版', changed) : $t('產生一版自動剪輯'))
    : $t('修改自動剪輯設定 ×{0}', changed);
  return { summary, patch, generate, replaceLast: generate && !!a.replace_last };
}

/** 套用：改面板設定；要產生就等這批修改結束後再跑（分析是非同步） */
export function applyAutoEdit(patch: AutoEditPatch, generate: boolean, replaceLast: boolean) {
  if (Object.keys(patch).length) useAutoEdit.getState().set(patch);
  void import('../ui/Dock').then((d) => d.useDock.getState().activatePanel('auto', true)).catch(() => {});
  if (generate) setTimeout(() => void import('../engine/autoEditApply').then((m) => m.generateAutoEdit(replaceLast)).catch(() => {}), 0);
}
