/**
 * AI 助手讀 / 改「自動剪輯」面板的設定：get_auto_edit 讀目前設定（含音樂分析摘要），
 * set_auto_edit 提議修改（使用者按套用才生效），可以順便產生一版。
 * 這裡不 import projectTools（避免循環）；錯誤用傳進來的 fail 丟出。
 */
import { $t, displayName } from '../i18n';
import { uid, type useStore } from '../store';
import { usePrefs } from '../prefs';
import { mediaBeats } from '../engine/beats';
import { categoryOf } from '../modules/categories';
import { BUILTIN_COMBOS } from '../modules/combos';
import { RECIPES, type FxRule, type Recipe, type RecipeId, type RuleWhen } from '../engine/autoEdit';
import { transitionOpt } from '../engine/autoEditPools';
import { aeSong, footage, lastTake, myStyleSettings, songKey, songMedia, styleSettings, trWeight, useAutoEdit, wholeSeg, type AeSong, type AeZone, type AutoEditSettings } from '../engine/autoEditSettings';
import { STYLE_IDS } from '../engine/autoEditStyles';
import type { BeatEvery } from '../engine/trigger';
import { FLAT_SHAPE, shapeMusic, type EnergyShape } from '../engine/energyShape';
import { POP_VARIANTS, type PopVariant } from '../engine/subjectPop';
import { SPEED_VARIANTS, type SpeedVariant } from '../engine/speedRamp';

type S = ReturnType<typeof useStore.getState>;
export type AutoEditPatch = Partial<Omit<AutoEditSettings, 'analysis' | 'direction'>>;

const num = (description: string) => ({ type: 'number', description });
const PICK = (what: string) => ({
  type: 'object',
  description: `Which ${what} to use. Items are ids from get_auto_edit, "category:<id>" (all of one category), or "all". only = exactly these; enable / disable = change from the current set.${what === 'transitions' ? ' Enabling keeps a weight above 0 (1 if it was 0); disabling sets weight 0.' : ''}`,
  properties: {
    only: { type: 'array', items: { type: 'string' } },
    enable: { type: 'array', items: { type: 'string' } },
    disable: { type: 'array', items: { type: 'string' } },
  },
});

export const AUTO_EDIT_DECLS = [
  {
    name: 'get_auto_edit',
    description: 'Read the Auto Edit panel settings (which music, range, style and numbers, fx layers, transition weights, which media are on) and, when analysed, the music sections (beat ranges, kind, energy 0..1) and drops.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'set_auto_edit',
    description: 'Propose changes to the Auto Edit panel settings (applied when the user presses Apply). generate: also cut a new take with the new settings (replace_last: replace the previous auto-edit take if it is still unchanged); after the user presses Apply the steps are shown in the chat and you get the result to review. For requests like \"make an edit of <person>, no unrelated people\", turn on the director with a director_note. Rates are 0..1.',
    parameters: {
      type: 'object',
      properties: {
        style: { type: 'string', description: `preset (${STYLE_IDS.join(', ')}; energetic styles cut every beat in high-energy sections, shake on cuts and keep vignette / flicker throughout; velocity adds speed ramps) or the name of one of the user's saved styles (get_auto_edit.my_styles); resets the numbers, fx layers and transition weights before the overrides below` },
        density: num('0..2, multiplies the chance of every fx layer (1 = as set)'),
        intensity: num('0..1, strength of the effects in the fx layers (0.5 = normal)'),
        fx_layers: {
          type: 'array',
          description: 'Replace the fx layers (stacked effects, each on its own fx track). effect: effect or combo id from get_auto_edit.effects; when: beat (every N beats), cut (on shot changes), accent (on strong hits), drop, section (whole section, for colour looks); every: 0.5 / 1 / 2 / 4 beats (when = beat); levels: energy levels to use it in (0 low, 1 mid, 2 high; ignored for drop); chance 0..1 per beat / cut / hit / section; beats: block length for accent / drop. Same-group effects (zoom, shake, flash, glitch, colour) never overlap: drop > accent > cut > beat > section, earlier layer wins ties.',
          items: {
            type: 'object',
            properties: {
              effect: { type: 'string' }, when: { type: 'string', enum: ['beat', 'cut', 'accent', 'drop', 'section'] },
              every: num(''), levels: { type: 'array', items: { type: 'number' } }, chance: num(''), beats: num(''), on: { type: 'boolean' },
            },
            required: ['effect', 'when'],
          },
        },
        transition_weights: {
          type: 'array', description: 'relative weight 0..3 per transition id (0 = never, 1 = normal); only the listed ones change',
          items: { type: 'object', properties: { id: { type: 'string' }, weight: { type: 'number' } }, required: ['id', 'weight'] },
        },
        beats_per_shot: { type: 'object', description: 'beats per shot at low / mid / high energy (1..32)', properties: { low: num(''), mid: num(''), high: num('') } },
        variation: num('0..1 chance a shot is halved / doubled'),
        min_shot_sec: num('shortest shot, seconds'),
        max_shot_sec: num('longest shot, seconds'),
        transition_rate: num('0..1 chance of a transition at a regular cut'),
        section_transition_rate: num('0..1 chance at section boundaries / drops'),
        transition_beats: num('transition length in beats (0.25..4); doubled at sections'),
        music: { type: 'string', description: 'media id of the song to cut to (an audio / video file in the library with beats); the take is placed after the end of the timeline' },
        music_range: { type: 'array', items: { type: 'number' }, description: '[start, end] seconds inside the song; omit for the whole song' },
        chorus: { type: 'array', items: { type: 'number' }, description: 'chorus starts, seconds inside the song (subject pops go only there); empty array = detect automatically' },
        zones_auto: { type: 'boolean', description: 'true = drop the zones set by the user and go back to automatic zones' },
        zones: {
          type: 'array',
          description: "Replace the zones: time ranges of the song (seconds inside the song, snapped to beats, no overlap) whose settings override the style there. Keep each zone's prompt (the user's instruction for that zone, from get_auto_edit.music.selected.zones) unless asked. transitions_mode: style = the style's transitions, none = hard cuts only, only = just the ids in transitions; transition_rate 0..1 = cut transition chance there; style_fx_rate 0..2 multiplies the chance of the style's fx layers there (0 = off); fx_layers: extra layers only in this zone (same format as fx_layers, levels ignored); beats_per_shot: fixed shot length there (1..32); subject_pop / speed_ramps: false = none in this zone. Empty array = no zones. When the song has no zones of its own, automatic zones are used (calm opening section: longer shots, fewer transitions; climax sections: tighter and busier); get_auto_edit shows them with zones_auto = true, and setting zones replaces them.",
          items: {
            type: 'object',
            properties: {
              from_sec: num(''), to_sec: num(''), prompt: { type: 'string' },
              transitions_mode: { type: 'string', enum: ['style', 'none', 'only'] },
              transitions: { type: 'array', items: { type: 'string' } },
              transition_rate: num(''), style_fx_rate: num(''),
              fx_layers: { type: 'array', items: { type: 'object', properties: {
                effect: { type: 'string' }, when: { type: 'string', enum: ['beat', 'cut', 'accent', 'drop', 'section'] },
                every: num(''), chance: num(''), beats: num(''), on: { type: 'boolean' },
              }, required: ['effect', 'when'] } },
              beats_per_shot: num(''), subject_pop: { type: 'boolean' }, speed_ramps: { type: 'boolean' },
            },
            required: ['from_sec', 'to_sec'],
          },
        },
        order: { type: 'string', enum: ['library', 'shuffle', 'bag'], description: 'library = list order; shuffle = random, picks what fits each section; bag = every media once per round in a shuffled order, segments of the same video kept apart' },
        ken_burns: { type: 'boolean', description: 'slow push in / pull out on images; shots with a detected face (videos too) push in on the face' },
        analyze: { type: 'boolean', description: 'pick video segments by motion / quality / avoiding cuts already inside the source video' },
        director: { type: 'boolean', description: 'AI director: before cutting, an AI looks at frames of every media file and decides which sections each suits, its priority and best moments' },
        director_note: { type: 'string', description: 'instruction for the AI director, e.g. "open with the landscape shots, faces on the drop"; empty string clears it' },
        energy: {
          type: 'object',
          description: 'Shape the energy curve that drives cut density and accents (energy ≥ 0.75 = high, < 0.45 = low). gain -0.5..0.5 shifts everything, contrast 0.5..2 spreads it around 0.6, points replace the control points: at = position 0..1 of the music clip, offset -1..1 (+1 ≈ +0.6 energy), linear in between (give at 0 and 1 too). reset: back to the analysed curve.',
          properties: {
            gain: num(''), contrast: num(''), reset: { type: 'boolean' },
            points: { type: 'array', items: { type: 'object', properties: { at: num(''), offset: num('') }, required: ['at', 'offset'] } },
          },
        },
        subject_pop: {
          type: 'object',
          description: 'Subject pop: a cut-out image grows / flies in on the beats before a drop or section change, and the reveal beat cuts to the full image. on: master switch; variants: which kinds may be used (step = grows one step per beat, mono = colour subject over its black-and-white image, fly = flies in, shake = grows with a shake + flash per beat, crossShot = subject of one image grows over the NEXT image which is then revealed, textBehind = big text placed behind the subject (needs text), trail = echo copies per beat, grid = four copies in the quadrants, spin = rotated copies, dim = subject over its darkened image, halo = glowing outline per beat, blur = subject over its blurred image, silhouetteWindow = the next image shows through the growing silhouette of the subject, subjectHole = a subject-shaped hole opens wider each beat revealing the next image); per_32: at most this many per 32 beats (0..4); text: the words for textBehind.',
          properties: {
            on: { type: 'boolean' },
            variants: { type: 'array', items: { type: 'string', enum: POP_VARIANTS } },
            per_32: num(''),
            text: { type: 'string' },
          },
        },
        speed_ramps: {
          type: 'object',
          description: 'Beat-synced speed ramps on video shots. on: master switch; variants: beatPulse = fast through each beat, slow in between; hitRamp = accelerates into a hard cut at a drop / section change; drift = gentle slow motion in quiet parts; holdHit = brief freeze on an accent; rewindToCut = rewinds over the last beat or two into a cut / strong transition; reverseForwardB = the shot after a section change starts reversed and snaps forward on the next beat; rewindReturn = forward, rewind one beat, forward; beatBoomerang = every beat forward-back-forward; slowPocket = slow motion between beats, short burst on each beat; tapeStop = slows to a stop before a drop / section change; whooshRamp = speeds up into a whip / zoom transition; beatStutter = repeats a short slice on the last beat of the shot. Reverse kinds are only used on footage with motion. per_32: at most this many per 32 beats (0..8); every: apply to every video shot (ignores per_32; e.g. rewindToCut on every cut, even 1-beat shots); boost: overall speed-up of ramped shots, 1..3 (1 = normal); intensity 0..1. The moment with the most motion is aligned to the ramp\'s focus (the rewind turn for rewindToCut).',
          properties: {
            on: { type: 'boolean' },
            variants: { type: 'array', items: { type: 'string', enum: SPEED_VARIANTS } },
            per_32: num(''), intensity: num(''), every: { type: 'boolean' }, boost: num(''),
          },
        },
        media: PICK('media'),
        transitions: PICK('transitions'),
        generate: { type: 'boolean' },
        replace_last: { type: 'boolean' },
      },
    },
  },
];

const r2 = (x: number) => Math.round(x * 100) / 100;

const layerOut = (r: FxRule) => ({ effect: r.moduleId, when: r.when, ...(r.every ? { every: r.every } : {}), levels: r.levels, chance: r.chance, ...(r.beats ? { beats: r.beats } : {}), on: r.on });
const zoneOut = (z: AeZone) => ({
  from_sec: r2(z.t0), to_sec: r2(z.t1), ...(z.prompt ? { prompt: z.prompt } : {}),
  transitions_mode: z.tr === undefined ? 'style' : z.tr === null ? 'none' : 'only', ...(z.tr ? { transitions: z.tr } : {}),
  ...(z.trRate !== undefined ? { transition_rate: z.trRate } : {}), ...(z.fxRate !== undefined ? { style_fx_rate: z.fxRate } : {}),
  ...(z.rules?.length ? { fx_layers: z.rules.map(layerOut) } : {}), ...(z.beatsPerShot ? { beats_per_shot: z.beatsPerShot } : {}),
  ...(z.noPop ? { subject_pop: false } : {}), ...(z.noSpeed ? { speed_ramps: false } : {}),
});

/** 歌的秒數 → 最近的一拍（歌的範圍外 = 範圍的頭 / 尾） */
function snapToBeat(s: S, song: AeSong, t: number): number {
  if (t <= song.a + 0.05) return song.a;
  if (t >= song.b - 0.05) return song.b;
  const beats = (mediaBeats(s.media.find((m) => m.id === song.mediaId))?.beats ?? []).filter((b) => b.t >= song.a && b.t < song.b);
  let best = t, d = Infinity;
  for (const b of beats) if (Math.abs(b.t - t) < d) { d = Math.abs(b.t - t); best = b.t; }
  return best;
}

/** fx_layers（全域或分段的）→ 特效層；zone = 分段的（不看能量） */
function parseLayers(raw: unknown, path: string, effects: { id: string }[], fail: (m: string) => never, zone = false): FxRule[] {
  if (!Array.isArray(raw)) fail(`${path} must be an array`);
  const WHEN: RuleWhen[] = ['beat', 'cut', 'accent', 'drop', 'section'];
  return (raw as Record<string, unknown>[]).map((x, i): FxRule => {
    const effect = String(x.effect);
    if (!effects.some((e) => e.id === effect)) fail(`${path}[${i}].effect: unknown id ${effect}`);
    const when = String(x.when) as RuleWhen;
    if (!WHEN.includes(when)) fail(`${path}[${i}].when must be one of ${WHEN.join(', ')}`);
    const every = ([0.5, 1, 2, 4] as BeatEvery[]).includes(x.every as BeatEvery) ? (x.every as BeatEvery) : 1;
    const levels = zone ? [0, 1, 2] as (0 | 1 | 2)[] : Array.isArray(x.levels)
      ? [...new Set(x.levels.map(Number).filter((l) => l === 0 || l === 1 || l === 2))] as (0 | 1 | 2)[]
      : [1, 2] as (0 | 1 | 2)[];
    const chance = typeof x.chance === 'number' && Number.isFinite(x.chance) ? Math.min(1, Math.max(0, x.chance)) : 1;
    const beats = typeof x.beats === 'number' && x.beats > 0 ? Math.min(16, x.beats) : undefined;
    return { id: uid(), moduleId: effect, on: x.on !== false, when, ...(when === 'beat' ? { every } : {}), levels, chance, ...(beats ? { beats } : {}) };
  });
}

/** 候選清單：id、名稱、分類（給 AI 看、也拿來解析 category:） */
function pools(s: S) {
  const combos = usePrefs.getState().fxCombos;
  return {
    media: footage(s).map((m) => ({ id: m.id, name: m.name, cat: m.kind })),
    transitions: s.modules.filter((m) => m.kind === 'transition').map((m) => ({ id: m.id, name: displayName(m.name), cat: categoryOf(m) })),
    effects: [
      ...s.modules.filter((m) => m.kind === 'effect').map((m) => ({ id: m.id, name: displayName(m.name), cat: categoryOf(m) })),
      ...[...combos, ...BUILTIN_COMBOS].map((c) => ({ id: c.id, name: displayName(c.name), cat: 'combo' })),
    ],
  };
}

export function readAutoEdit(s: S): Record<string, unknown> {
  const st = useAutoEdit.getState();
  const music = songMedia(s);
  const song = aeSong(s, st);
  const bpm = song ? mediaBeats(s.media.find((m) => m.id === song.mediaId))?.bpm : undefined;
  const raw = song && st.analysis?.key === songKey(song) ? st.analysis.info : null;
  const info = raw && shapeMusic(raw, st.shape);
  const p = st.params;
  const P = pools(s);
  const zonesNow = lastTake.zones();
  const trStrength = new Map(s.modules.filter((m) => m.kind === 'transition').map((m) => [m.id, transitionOpt(m).strength]));
  return {
    music: {
      selected: song ? { id: song.mediaId, range: [r2(song.a), r2(song.b)], chorus: song.chorus ?? [], zones_auto: zonesNow.auto, zones: zonesNow.list.map(zoneOut) } : null,
      options: music.map((m) => ({ id: m.id, name: m.name, duration: r2(m.duration) })),
      ...(bpm ? { bpm: r2(bpm) } : {}),
      ...(info ? {
        beats: info.energy.length,
        sections: info.sections.map((x) => ({ beats: [x.b0, x.b1], at: [r2(x.b0 / Math.max(1, info.energy.length)), r2(x.b1 / Math.max(1, info.energy.length))], kind: x.kind, energy: r2(x.energy) })),
        drops: info.drops,
        high_energy_beats: info.level.filter((l) => l === 2).length,
      } : { note: 'not analysed yet (the panel analyses it when opened or on generate)' }),
    },
    // replace_last 只有在上一版產生後沒被改過時有用
    last_take_replaceable: lastTake.replaceable(),
    style: st.recipe.startsWith('my:') ? st.myStyles.find((m) => `my:${m.id}` === st.recipe)?.name ?? 'custom' : st.recipe,
    my_styles: st.myStyles.map((m) => m.name),
    beats_per_shot: { low: p.beatsPerShot[0], mid: p.beatsPerShot[1], high: p.beatsPerShot[2] },
    variation: p.jitter, min_shot_sec: p.minShotSec, max_shot_sec: p.maxShotSec,
    transition_rate: p.transitionRate, section_transition_rate: p.sectionTransitionRate, transition_beats: p.transitionBeats,
    density: st.density, intensity: st.intensity,
    fx_layers: st.rules.map(layerOut),
    order: st.order, ken_burns: st.kenBurns,
    energy: { gain: st.shape.gain, contrast: st.shape.contrast, points: st.shape.points.map((p) => ({ at: r2(p.x), offset: r2(p.y) })) },
    subject_pop: { on: st.popOn, variants: st.popVariants, per_32: st.popsPer32, text: st.popText },
    speed_ramps: { on: st.speedOn, variants: st.speedVariants, per_32: st.speedsPer32, intensity: st.speedIntensity, every: !!st.speedEvery, boost: st.speedBoost ?? 1 },
    analyze: st.analyze, director: st.director, director_note: st.directorNote,
    ...(st.direction ? { last_direction: st.direction } : {}),
    media: P.media.map((m) => ({ ...m, on: st.pick !== 'list' || st.segs.some((g) => g.mediaId === m.id) })),
    // 使用者在面板指定的片段（影片的範圍）；關掉素材 = 拿掉它的片段、打開 = 整段加入
    ...(st.pick === 'list' ? { segments: st.segs.map((g) => ({ media: g.mediaId, from_sec: r2(g.a), to_sec: r2(g.b), ...(g.name ? { name: g.name } : {}) })) } : {}),
    transitions: P.transitions.map((m) => ({ ...m, strength: trStrength.get(m.id), weight: trWeight(st.trWeights, m.id) })),
    effects: P.effects,
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
  let trWeights = st.trWeights;
  if (a.style !== undefined) {
    const id = String(a.style) as RecipeId;
    const my = st.myStyles.find((m) => m.name === String(a.style));
    if (!RECIPES[id] && !my) fail(`unknown style ${String(a.style)}`);
    const sty = my ? myStyleSettings(my) : styleSettings(id);
    Object.assign(patch, sty);
    params = { ...sty.params! };
    trWeights = sty.trWeights!;
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
  const density = n('density', 0, 2);
  if (density !== undefined) patch.density = density;
  const intensity = n('intensity', 0, 1);
  if (intensity !== undefined) patch.intensity = intensity;
  if (params.minShotSec > params.maxShotSec) fail('min_shot_sec must be ≤ max_shot_sec');

  if (a.music !== undefined || a.music_range !== undefined || a.chorus !== undefined) {
    const cur = aeSong(s, { song: patch.song !== undefined ? patch.song : useAutoEdit.getState().song });
    const id = a.music !== undefined ? String(a.music) : cur?.mediaId;
    const m = songMedia(s).find((x) => x.id === id);
    if (!m) fail(`music: ${String(id)} is not a library audio / video file with beats`);
    const same = cur?.mediaId === m!.id;
    let ab: [number, number] = same && cur ? [cur.a, cur.b] : [0, m!.duration];
    if (a.music_range !== undefined) {
      const r = Array.isArray(a.music_range) ? a.music_range.map(Number) : [];
      if (r.length !== 2 || !r.every(Number.isFinite) || r[0] < 0 || r[1] <= r[0] + 1) fail('music_range must be [start, end] seconds, end > start + 1');
      ab = [Math.min(r[0], m!.duration), Math.min(r[1], m!.duration)];
    }
    let chorus = same ? cur?.chorus : undefined;
    if (a.chorus !== undefined) {
      const c = Array.isArray(a.chorus) ? a.chorus.map(Number) : [];
      if (!c.every((t) => Number.isFinite(t) && t >= 0)) fail('chorus must be an array of seconds');
      chorus = c.length ? [...new Set(c)].sort((x, y) => x - y) : undefined;
    }
    // 同一首歌：分段留著（範圍外的下面夾掉）
    const zones = same ? cur?.zones?.filter((z) => z.t1 > ab[0] && z.t0 < ab[1]).map((z) => ({ ...z, t0: Math.max(ab[0], z.t0), t1: Math.min(ab[1], z.t1) })) : undefined;
    patch.song = { mediaId: m!.id, a: ab[0], b: ab[1], ...(chorus?.length ? { chorus } : {}), ...(zones?.length ? { zones } : {}) };
    changed++;
  }
  if (a.order !== undefined) {
    if (a.order !== 'library' && a.order !== 'shuffle' && a.order !== 'bag') fail('order must be library, shuffle or bag');
    patch.order = a.order as 'library' | 'shuffle' | 'bag';
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
  const sp = a.subject_pop as { on?: unknown; variants?: unknown; per_32?: unknown; text?: unknown } | undefined;
  if (sp && typeof sp === 'object') {
    if (sp.on !== undefined) patch.popOn = !!sp.on;
    if (sp.variants !== undefined) {
      const list = (Array.isArray(sp.variants) ? sp.variants : []).map(String);
      const bad = list.filter((v) => !POP_VARIANTS.includes(v as PopVariant));
      if (bad.length) fail(`subject_pop.variants: unknown ${bad.join(', ')}`);
      patch.popVariants = [...new Set(list)] as PopVariant[];
      if (sp.on === undefined && list.length) patch.popOn = true;
    }
    if (sp.text !== undefined) patch.popText = String(sp.text).slice(0, 40);
    if (sp.per_32 !== undefined) {
      if (typeof sp.per_32 !== 'number' || !Number.isFinite(sp.per_32)) fail('subject_pop.per_32 must be a number');
      patch.popsPer32 = Math.min(4, Math.max(0, sp.per_32 as number));
    }
    changed++;
  }
  const sr = a.speed_ramps as { on?: unknown; variants?: unknown; per_32?: unknown; intensity?: unknown; every?: unknown; boost?: unknown } | undefined;
  if (sr && typeof sr === 'object') {
    if (sr.on !== undefined) patch.speedOn = !!sr.on;
    if (sr.variants !== undefined) {
      const list = (Array.isArray(sr.variants) ? sr.variants : []).map(String);
      const bad = list.filter((v) => !SPEED_VARIANTS.includes(v as SpeedVariant));
      if (bad.length) fail(`speed_ramps.variants: unknown ${bad.join(', ')}`);
      patch.speedVariants = [...new Set(list)] as SpeedVariant[];
      if (sr.on === undefined && list.length) patch.speedOn = true;
    }
    for (const [k, field, hi] of [['per_32', 'speedsPer32', 8], ['intensity', 'speedIntensity', 1]] as const) {
      const v = sr[k];
      if (v === undefined) continue;
      if (typeof v !== 'number' || !Number.isFinite(v)) fail(`speed_ramps.${k} must be a number`);
      patch[field] = Math.min(hi, Math.max(0, v as number));
    }
    if (sr.every !== undefined) patch.speedEvery = !!sr.every;
    if (sr.boost !== undefined) {
      if (typeof sr.boost !== 'number' || !Number.isFinite(sr.boost)) fail('speed_ramps.boost must be a number');
      patch.speedBoost = Math.min(3, Math.max(1, sr.boost as number));
    }
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
  if (a.fx_layers !== undefined) {
    patch.rules = parseLayers(a.fx_layers, 'fx_layers', P.effects, fail);
    patch.recipe = 'custom';
    changed++;
  }
  if (a.zones !== undefined) {
    if (!Array.isArray(a.zones)) fail('zones must be an array');
    const song = patch.song ?? aeSong(s, useAutoEdit.getState());
    if (!song) fail('zones: no music selected');
    const list: AeZone[] = [];
    for (const [i, x] of (a.zones as Record<string, unknown>[]).entries()) {
      const t0 = Number(x.from_sec), t1 = Number(x.to_sec);
      if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 <= t0) fail(`zones[${i}]: from_sec / to_sec must be seconds, to > from`);
      const mode = x.transitions_mode ?? (x.transitions !== undefined ? 'only' : 'style');
      if (mode !== 'style' && mode !== 'none' && mode !== 'only') fail(`zones[${i}].transitions_mode must be style, none or only`);
      const tr = mode === 'only' ? (Array.isArray(x.transitions) ? x.transitions.map(String) : []) : undefined;
      for (const id of tr ?? []) if (!P.transitions.some((m) => m.id === id)) fail(`zones[${i}].transitions: unknown id ${id}`);
      const rate = typeof x.transition_rate === 'number' && Number.isFinite(x.transition_rate) ? Math.min(1, Math.max(0, x.transition_rate)) : undefined;
      const bps = typeof x.beats_per_shot === 'number' && x.beats_per_shot >= 1 ? Math.min(32, Math.round(x.beats_per_shot)) : undefined;
      const rules = x.fx_layers !== undefined ? parseLayers(x.fx_layers, `zones[${i}].fx_layers`, P.effects, fail, true) : [];
      list.push({
        id: uid(), t0: snapToBeat(s, song!, t0), t1: snapToBeat(s, song!, t1),
        ...(mode === 'none' ? { tr: null } : tr ? { tr } : {}), ...(rate !== undefined ? { trRate: rate } : {}),
        ...(typeof x.style_fx_rate === 'number' && Number.isFinite(x.style_fx_rate) && x.style_fx_rate !== 1 ? { fxRate: Math.min(2, Math.max(0, x.style_fx_rate)) } : {}), ...(rules.length ? { rules } : {}),
        ...(bps ? { beatsPerShot: bps } : {}), ...(x.subject_pop === false ? { noPop: true as const } : {}),
        ...(x.speed_ramps === false ? { noSpeed: true as const } : {}),
        ...(typeof x.prompt === 'string' && x.prompt.trim() ? { prompt: x.prompt.trim().slice(0, 300) } : {}),
      });
    }
    const zones = list.filter((z) => z.t1 - z.t0 > 0.05).sort((p, q) => p.t0 - q.t0);
    for (let i = 1; i < zones.length; i++) if (zones[i].t0 < zones[i - 1].t1 - 1e-3) fail('zones must not overlap');
    patch.song = { ...song!, zones };
    changed++;
  } else if (a.zones_auto) {
    const song = patch.song ?? aeSong(s, useAutoEdit.getState());
    if (song) { const { zones: _z, ...rest } = song; patch.song = rest; }
    changed++;
  }
  const trPick = pick(a.transitions, P.transitions, P.transitions.filter((m) => trWeight(trWeights, m.id) <= 0).map((m) => m.id), fail, 'transitions');
  // [{ id, weight }]（Gemini 的 schema 不支援 id → 數字的對照表）；舊的物件寫法也收
  const raw = a.transition_weights;
  const tw: Record<string, unknown> | undefined = Array.isArray(raw)
    ? Object.fromEntries(raw.map((x) => [String((x as { id?: unknown })?.id), (x as { weight?: unknown })?.weight]))
    : raw && typeof raw === 'object' ? raw as Record<string, unknown> : undefined;
  if (trPick || tw) {
    const next = { ...trWeights };
    if (trPick) for (const m of P.transitions) next[m.id] = trPick.includes(m.id) ? 0 : Math.max(1, trWeight(next, m.id));
    for (const [id, v] of Object.entries(tw ?? {})) {
      if (!P.transitions.some((m) => m.id === id)) fail(`transition_weights: unknown id ${id}`);
      if (typeof v !== 'number' || !Number.isFinite(v)) fail(`transition_weights.${id} must be a number`);
      next[id] = Math.min(3, Math.max(0, v as number));
    }
    patch.trWeights = next;
    patch.recipe = 'custom';
    changed++;
  }
  // 風格變「自訂」時把目前的數字一起帶過去（選了風格 = 風格的數字再加上覆寫）
  if (patch.recipe) patch.params = { ...params, id: patch.recipe };
  // 素材開關 → 片段清單：關掉 = 拿掉那個素材的所有片段；打開 = 整段加入（全部打開又沒有範圍 = 回到「全部素材」）
  {
    const used = new Set(st.pick === 'list' ? st.segs.map((g) => g.mediaId) : P.media.map((m) => m.id));
    const next = pick(a.media, P.media, P.media.filter((m) => !used.has(m.id)).map((m) => m.id), fail, 'media');
    if (next) {
      if (P.media.every((x) => next.includes(x.id))) fail('media: at least one item must stay on');
      const base = st.pick === 'list' ? st.segs : s.media.filter((m) => used.has(m.id)).map((m) => wholeSeg(m, uid()));
      const segs = [
        ...base.filter((g) => !next.includes(g.mediaId)),
        ...s.media.filter((m) => P.media.some((x) => x.id === m.id) && !next.includes(m.id) && !used.has(m.id)).map((m) => wholeSeg(m, uid())),
      ];
      const whole = !next.length && segs.every((g) => { const m = s.media.find((x) => x.id === g.mediaId); return !!m && g.a === 0 && (m.kind !== 'video' || g.b >= m.duration) && !g.name; });
      patch.segs = whole ? [] : segs;
      patch.pick = whole ? 'all' : 'list';
      changed++;
    }
  }
  const generate = !!a.generate;
  if (!changed && !generate) fail('nothing to change');
  const summary = generate
    ? (changed ? $t('修改自動剪輯設定 ×{0}，產生一版', changed) : $t('產生一版自動剪輯'))
    : $t('修改自動剪輯設定 ×{0}', changed);
  return { summary, patch, generate, replaceLast: generate && !!a.replace_last };
}

/**
 * 套用：改面板設定；要產生就等這批修改結束後再跑（分析是非同步）。
 * 產生的進度顯示在 AI 對話裡（不切到自動剪輯面板）；onDone = 跑完的結果（AI 接著看結果說明）。
 */
export function applyAutoEdit(patch: AutoEditPatch, generate: boolean, replaceLast: boolean, onDone?: (r: { ok: boolean; text: string; cancelled?: true } | null) => void) {
  if (Object.keys(patch).length) useAutoEdit.getState().set(patch);
  if (!generate) {
    void import('../ui/Dock').then((d) => d.useDock.getState().activatePanel('auto', true)).catch(() => {});
    return;
  }
  setTimeout(() => void import('../engine/autoEditApply').then((m) => m.generateAutoEdit(replaceLast, true)).then((r) => onDone?.(r), () => onDone?.(null)), 0);
}
