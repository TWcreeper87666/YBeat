/**
 * AI 操作專案的工具：讀時間軸 / 節拍 / 選取，以及「提議」修改。
 * 修改不會馬上執行：先驗證、收集成操作清單，聊天裡按「套用」才一次執行（一步復原）。
 */
import { $t, displayName } from '../i18n';
import { defaultTiming, parseKey, remapFor, srcAvail, uid, useStore, type AnimItem, type AudioClip, type Clip, type FxItem, type Module, type ModuleKind, type TrSide } from '../store';
import { parseParams, parsePointCh, type ParamValue, type ParamValues } from '../engine/params';
import { newKey, sortKeys, type Keyframe } from '../engine/keyframes';
import { normalizeHits, type FxTiming } from '../engine/trigger';
import { captionList } from '../engine/subtitles';
import { anchorTime, fitOf, followOf, frameRectToBox, putAnchor, type Follow, type FollowMap, type Subject } from '../engine/follow';
import { fitStart } from '../engine/overlap';
import { fxLevel } from '../engine/tracks';
import { AUTO_EDIT_DECLS, applyAutoEdit, proposeAutoEdit, readAutoEdit, type AutoEditPatch } from './autoEditTools';
import { laneOf, spansOf } from '../store';
import { triggerBeats, type BeatEvery, type FxTrigger } from '../engine/trigger';
import { getBeats } from '../ui/beatGrid';
import { transDur } from '../prefs';
import { beginHistoryTransaction, endHistoryTransaction } from '../engine/history';
import type { ToolDecl } from './gemini';

type S = ReturnType<typeof useStore.getState>;

/** 一次最多回傳幾個項目 / 節拍、一個操作最多幾個目標 */
const MAX_ITEMS = 300;
const MAX_BEATS = 500;
const MAX_TARGETS = 300;

// ───────────── 宣告 ─────────────

const num = (description: string) => ({ type: 'number', description });
const str = (description: string) => ({ type: 'string', description });
const strs = (description: string) => ({ type: 'array', items: { type: 'string' }, description });
const PARAMS = { type: 'object', description: 'Parameter values by @param name (float/int: number, bool: boolean, color: "#rrggbb", point: [x, y] screen 0..1 y down, curve: preset name or [x1,y1,x2,y2]). Omitted = keep / default.' };
const TARGETS = {
  type: 'array',
  description: 'What to change. kind effect = effect-track block (id); clip_fx = effect on a clip (clipId, fxId); transition = a clip\'s transition (clipId, side in|out); remap = a clip\'s speed remap (clipId).',
  items: {
    type: 'object',
    properties: { kind: { type: 'string', enum: ['effect', 'clip_fx', 'transition', 'remap'] }, id: str('effect block id'), clipId: str('clip id'), fxId: str('clip effect id'), side: { type: 'string', enum: ['in', 'out'] } },
    required: ['kind'],
  },
};

export const PROJECT_TOOL_DECLS: ToolDecl[] = [
  ...(AUTO_EDIT_DECLS as ToolDecl[]),
  {
    name: 'get_timeline',
    description: 'Read the timeline: video clips (with their transitions, remap, clip effects), effect-track blocks, audio clips. Times are timeline seconds. Optionally only items overlapping from..to.',
    parameters: { type: 'object', properties: { from: num('start seconds'), to: num('end seconds'), include_params: { type: 'boolean', description: 'also return parameter values' } } },
  },
  {
    name: 'get_beats',
    description: 'Beat times (timeline seconds) from the music on the audio tracks, plus downbeats (first beat of each bar). every = 0.5 (half beats), 1, 2 or 4 (bars).',
    parameters: { type: 'object', properties: { from: num('start seconds'), to: num('end seconds'), every: num('0.5 | 1 | 2 | 4, default 1') } },
  },
  {
    name: 'get_selection',
    description: 'What the user has selected on the timeline, and the playhead time.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'add_effects',
    description: 'Propose effect-track blocks. Prefer ONE long block with trigger over many blocks: trigger "beat" replays the effect on every beat inside the block (also half_beat, 2_beats, bar), "cut" replays it at every cut. A transition module here becomes a transition block applied at every cut in its range.',
    parameters: {
      type: 'object',
      properties: {
        moduleId: str('effect (or transition) module id'),
        blocks: { type: 'array', items: { type: 'object', properties: { start: num('seconds'), duration: num('seconds') }, required: ['start', 'duration'] } },
        track: num('effect track index (default: first free one, a new track if none)'),
        trigger: { type: 'string', enum: ['none', 'beat', 'half_beat', '2_beats', 'bar', 'cut'] },
        params: PARAMS,
      },
      required: ['moduleId', 'blocks'],
    },
  },
  {
    name: 'set_transitions',
    description: 'Propose transitions on clips. Either list clipIds (+ side), or give a video track with scope: cuts (between touching clips), heads (clip starts not touching a previous clip), tails (clip ends not followed by a clip), all. moduleId null removes.',
    parameters: {
      type: 'object',
      properties: {
        moduleId: { type: 'string', nullable: true, description: 'transition module id, or null to remove' },
        clipIds: strs('clip ids'),
        side: { type: 'string', enum: ['in', 'out'], description: 'with clipIds; default in' },
        track: num('video track index, with scope'),
        scope: { type: 'string', enum: ['cuts', 'heads', 'tails', 'all'] },
        duration: num('seconds'),
        params: PARAMS,
      },
    },
  },
  {
    name: 'set_anim_slots',
    description: 'Propose replacing images of an animation (get_timeline.animations): each item sets one image slot (subject, background, reveal, copy:N…) to a library media id (image or video; at_sec = which frame of a video, default 0), or media null to empty it. Other slots stay as they are.',
    parameters: {
      type: 'object',
      properties: {
        anim_id: str('animation id'),
        items: { type: 'array', items: { type: 'object', properties: { slot: str('slot id'), media: str('media id, or empty to clear'), at_sec: { type: 'number' } }, required: ['slot'] } },
      },
      required: ['anim_id', 'items'],
    },
  },
  {
    name: 'set_remap',
    description: 'Propose a speed remap module on clips.',
    parameters: { type: 'object', properties: { clipIds: strs('clip ids'), moduleId: str('remap module id'), params: PARAMS }, required: ['clipIds', 'moduleId'] },
  },
  {
    name: 'add_clip_effects',
    description: 'Propose adding an effect that applies to the whole of each clip (stacked on the clip, not on an effect track).',
    parameters: { type: 'object', properties: { clipIds: strs('clip ids'), moduleId: str('effect module id'), params: PARAMS }, required: ['clipIds', 'moduleId'] },
  },
  {
    name: 'update_params',
    description: 'Propose new parameter values on existing effects / transitions / remaps (merged into the current values).',
    parameters: { type: 'object', properties: { targets: TARGETS, params: PARAMS }, required: ['targets', 'params'] },
  },
  {
    name: 'remove',
    description: 'Propose deleting effect blocks, clip effects or transitions.',
    parameters: { type: 'object', properties: { targets: TARGETS }, required: ['targets'] },
  },
  {
    name: 'set_keyframes',
    description: 'Propose animating one numeric parameter of existing effect blocks / clip effects. keys t = seconds from the item start (clip effects: from the clip start). Point params: use "name.x" / "name.y" (screen 0..1, y down). Empty keys = stop animating (keeps the value at the first key).',
    parameters: {
      type: 'object',
      properties: {
        targets: TARGETS,
        param: str('parameter name, or name.x / name.y for a point'),
        keys: { type: 'array', items: { type: 'object', properties: { t: num('seconds from item start'), v: num('value') }, required: ['t', 'v'] } },
        ease: { type: 'string', enum: ['linear', 'inOut', 'in', 'out', 'hold'], description: 'easing between keys, default inOut' },
      },
      required: ['targets', 'param', 'keys'],
    },
  },
  {
    name: 'set_effect_timing',
    description: 'Propose when clip effects are active (kind clip_fx targets only). whole = the whole clip; hits = only inside the given windows (t, d seconds from the clip start, each one replays the effect); beat = replays on every beat inside the clip, each lasting d seconds.',
    parameters: {
      type: 'object',
      properties: {
        targets: TARGETS,
        mode: { type: 'string', enum: ['whole', 'hits', 'beat'] },
        hits: { type: 'array', items: { type: 'object', properties: { t: num('seconds from clip start'), d: num('length in seconds') }, required: ['t', 'd'] } },
        every: num('beat mode: 0.5 | 1 | 2 | 4 (bar)'),
        d: num('beat mode: seconds each replay lasts'),
      },
      required: ['targets', 'mode'],
    },
  },
  {
    name: 'set_tracking',
    description: 'Propose what video / image clips track. target: face = the largest face (automatic); box = a custom object (car, ball, game sprite…) the user outlines — pass box to add an outline yourself, otherwise the user outlines it on the preview; off = stop tracking. Followable params (marked "follows target") of effects on or over a tracked clip aim at the tracked thing; untracked clips are never analysed.',
    parameters: {
      type: 'object',
      properties: {
        clipIds: strs('clip ids'),
        target: { type: 'string', enum: ['face', 'box', 'off'] },
        box: { type: 'array', items: { type: 'number' }, description: 'target box on screen at time "at": [x0, y0, x1, y1], 0..1, y down (one clip only)' },
        at: num('timeline seconds the box is seen at (default: clip start)'),
      },
      required: ['clipIds', 'target'],
    },
  },
  {
    name: 'set_follow',
    description: 'Propose whether a point parameter (e.g. center) of effect blocks / clip effects / transitions follows the tracked target (face / custom object). Only matters when the clip it looks at is tracking something (set_tracking). Zoom-like built-in modules follow by default; on=false lets the user place / keyframe the point by hand. offset = position relative to the target (screen units, y down); side = which clip a transition follows (from = previous, to = next).',
    parameters: {
      type: 'object',
      properties: {
        targets: TARGETS,
        param: str('point parameter name, usually center'),
        on: { type: 'boolean' },
        offset: { type: 'array', items: { type: 'number' }, description: '[dx, dy]' },
        side: { type: 'string', enum: ['from', 'to'] },
      },
      required: ['targets', 'param', 'on'],
    },
  },
  {
    name: 'get_subtitles',
    description: 'Read subtitles (text clips on caption tracks): id, track, start, end, text. Optionally only from..to.',
    parameters: { type: 'object', properties: { from: num('start seconds'), to: num('end seconds') } },
  },
  {
    name: 'edit_subtitles',
    description: 'Propose changing subtitle text (proofreading, rewording) and/or timing (start/end in timeline seconds, e.g. to land on beats). Only give the fields that change. Subtitles on the same track must not overlap.',
    parameters: {
      type: 'object',
      properties: { items: { type: 'array', items: { type: 'object', properties: { clipId: str('subtitle clip id'), text: str('new text (\\n for a line break)'), start: num('seconds'), end: num('seconds') }, required: ['clipId'] } } },
      required: ['items'],
    },
  },
  {
    name: 'split_subtitles',
    description: 'Propose splitting long subtitles into consecutive pieces. parts = the text of each piece in order; times = the split points (timeline seconds, parts.length - 1 of them); omitted = split by text length.',
    parameters: {
      type: 'object',
      properties: { items: { type: 'array', items: { type: 'object', properties: { clipId: str('subtitle clip id'), parts: strs('text of each piece'), times: { type: 'array', items: { type: 'number' }, description: 'split points' } }, required: ['clipId', 'parts'] } } },
      required: ['items'],
    },
  },
  {
    name: 'translate_subtitles',
    description: 'Propose a translated subtitle track: a new track right above the source subtitles, same timing and style, placed just above them on screen. Give one translated text per source subtitle.',
    parameters: {
      type: 'object',
      properties: { items: { type: 'array', items: { type: 'object', properties: { clipId: str('source subtitle clip id'), text: str('translated text') }, required: ['clipId', 'text'] } } },
      required: ['items'],
    },
  },
];

const READ = new Set(['get_timeline', 'get_beats', 'get_selection', 'get_subtitles', 'get_auto_edit']);
export const isProjectTool = (name: string) => PROJECT_TOOL_DECLS.some((d) => d.name === name);

// ───────────── 操作 ─────────────

type Target =
  | { kind: 'effect'; id: string }
  | { kind: 'clip_fx'; clipId: string; fxId: string }
  | { kind: 'transition'; clipId: string; side: TrSide }
  | { kind: 'remap'; clipId: string };

export type Op =
  | { op: 'add_effects'; moduleId: string; blocks: { start: number; duration: number }[]; track?: number; trigger?: FxTrigger; params: ParamValues }
  | { op: 'set_transitions'; moduleId: string | null; at: { clipId: string; side: TrSide }[]; duration?: number; params: ParamValues }
  | { op: 'set_remap'; moduleId: string; clipIds: string[]; params: ParamValues }
  | { op: 'add_clip_effects'; moduleId: string; clipIds: string[]; params: ParamValues }
  | { op: 'update_params'; targets: Target[]; params: Record<string, unknown> }
  | { op: 'remove'; targets: Target[] }
  | { op: 'set_keyframes'; targets: Target[]; param: string; keys: { t: number; v: number }[]; ease: string }
  | { op: 'set_effect_timing'; targets: Target[]; timing: FxTiming | undefined }
  | { op: 'set_follow'; targets: Target[]; param: string; follow: Follow | null }
  | { op: 'set_tracking'; clipIds: string[]; subject: Subject | null }
  | { op: 'edit_subtitles'; items: { clipId: string; text?: string; start?: number; end?: number }[] }
  | { op: 'split_subtitles'; items: { clipId: string; parts: string[]; times: number[] }[] }
  | { op: 'translate_subtitles'; items: { clipId: string; text: string }[] }
  /** 改「自動剪輯」面板的設定（不動專案）；generate = 套用後產生一版 */
  | { op: 'auto_edit'; patch: AutoEditPatch; generate: boolean; replaceLast: boolean }
  /**
   * 一批新片段 / 特效方塊 / 音樂 / 動畫（自動剪輯）：clip.track、anim.track = 第幾層（0 = 基本層，1 以上疊在上面）。
   * 每層放一條這段時間空著的影片軌（比這段時間有東西的軌道都高，沒有就新增）；effect.track = 第幾層特效，放在影片軌上方空著的特效軌；音樂放第一條空著的音訊軌
   */
  | { op: 'add_items'; clips: Clip[]; effects: FxItem[]; audios?: AudioClip[]; anims?: AnimItem[] }
  /** 換動畫的圖片（每一項 = 一個圖片位置；media null = 清空；at = 影片用哪一秒那一格） */
  | { op: 'set_anim_slots'; animId: string; items: { slotId: string; mediaId: string | null; at: number }[] };

/** 提議的修改（顯示用的摘要 + 實際操作） */
export interface Proposal { summary: string; op: Op }

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : v == null ? [] : [v]);
const idList = (v: unknown) => arr(v).map(String).filter(Boolean);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

class ToolError extends Error {}
const fail = (msg: string): never => {
  throw new ToolError(msg);
};

const modName = (m: Module) => displayName(m.name);
function moduleOf(s: S, id: unknown, kinds: ModuleKind[]): Module {
  const m = s.modules.find((x) => x.id === id);
  if (!m) fail(`unknown module: ${String(id)}`);
  if (!kinds.includes(m!.kind)) fail(`${String(id)} is a ${m!.kind} module, expected ${kinds.join(' or ')}`);
  return m!;
}
function clipOf(s: S, id: string): Clip {
  const c = s.clips.find((x) => x.id === id);
  if (!c) fail(`unknown clip: ${id}`);
  return c!;
}

/** 檢查參數名稱 / 型別，回傳可以用的值；不認得的名稱列在 unknown */
export function cleanParams(code: string, raw: unknown): { params: ParamValues; unknown: string[] } {
  const defs = parseParams(code);
  const params: ParamValues = {};
  const unknown: string[] = [];
  if (!raw || typeof raw !== 'object') return { params, unknown };
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const d = defs.find((x) => x.name === k);
    if (!d) {
      unknown.push(k);
      continue;
    }
    let ok: ParamValue | undefined;
    if ((d.type === 'float' || d.type === 'int') && isNum(v)) {
      const x = d.type === 'int' ? Math.round(v) : v;
      ok = Number.isFinite(d.min) && Number.isFinite(d.max) && d.max > d.min ? Math.min(d.max, Math.max(d.min, x)) : x;
    } else if (d.type === 'bool' && typeof v === 'boolean') ok = v;
    else if (d.type === 'color' && typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)) ok = v.toLowerCase();
    else if (d.type === 'point' && Array.isArray(v) && v.length === 2 && v.every(isNum)) ok = v as number[];
    else if (d.type === 'curve' && ((typeof v === 'string' && v) || (Array.isArray(v) && v.length === 4 && v.every(isNum)))) ok = v as ParamValue;
    if (ok === undefined) fail(`bad value for ${k} (${d.type}): ${JSON.stringify(v)}`);
    params[k] = ok!;
  }
  return { params, unknown };
}

const TRIGGERS: Record<string, BeatEvery> = { beat: 1, half_beat: 0.5, '2_beats': 2, bar: 4 };

function parseTarget(s: S, t: unknown): Target {
  const o = (t ?? {}) as Record<string, unknown>;
  if (o.kind === 'effect') {
    const id = String(o.id ?? '');
    if (!s.effects.some((e) => e.id === id)) fail(`unknown effect block: ${id}`);
    return { kind: 'effect', id };
  }
  const c = clipOf(s, String(o.clipId ?? ''));
  if (o.kind === 'clip_fx') {
    const fxId = String(o.fxId ?? '');
    if (!c.effects?.some((f) => f.id === fxId && !f.base)) fail(`clip ${c.id} has no effect ${fxId}`);
    return { kind: 'clip_fx', clipId: c.id, fxId };
  }
  if (o.kind === 'transition') {
    const side: TrSide = o.side === 'out' ? 'out' : 'in';
    if (!(side === 'out' ? c.transitionOut : c.transitionIn)) fail(`clip ${c.id} has no ${side} transition`);
    return { kind: 'transition', clipId: c.id, side };
  }
  if (o.kind === 'remap') return { kind: 'remap', clipId: c.id };
  return fail(`bad target kind: ${String(o.kind)}`);
}

/** 目標目前用的模組（檢查參數用） */
function targetModule(s: S, t: Target): string | undefined {
  if (t.kind === 'effect') return s.effects.find((e) => e.id === t.id)?.moduleId;
  const c = s.clips.find((x) => x.id === t.clipId);
  if (t.kind === 'clip_fx') return c?.effects?.find((f) => f.id === t.fxId)?.moduleId;
  if (t.kind === 'transition') return (t.side === 'out' ? c?.transitionOut : c?.transitionIn)?.moduleId;
  return c?.remap.moduleId;
}

/** 剪接點 / 開頭 / 結尾 → 實際的片段與邊（跟 applyTransitions 同一套規則） */
export function scopeTargets(clips: Clip[], track: number, scope: string): { clipId: string; side: TrSide }[] {
  const sorted = clips.filter((c) => c.track === track).sort((a, b) => a.start - b.start);
  const adj = (a: Clip | undefined, b: Clip | undefined) => !!a && !!b && Math.abs(a.start + a.duration - b.start) <= 0.01;
  const out: { clipId: string; side: TrSide }[] = [];
  sorted.forEach((c, i) => {
    const hasPrev = adj(sorted[i - 1], c);
    const hasNext = adj(c, sorted[i + 1]);
    if ((scope === 'cuts' || scope === 'all') && hasPrev) out.push({ clipId: c.id, side: 'in' });
    if ((scope === 'heads' || scope === 'all') && !hasPrev) out.push({ clipId: c.id, side: 'in' });
    if ((scope === 'tails' || scope === 'all') && !hasNext) out.push({ clipId: c.id, side: 'out' });
  });
  return out;
}

function propose(name: string, a: Record<string, unknown>, s: S): { p: Proposal; warn: string[] } {
  const warn: string[] = [];
  const P = (code: string, raw: unknown) => {
    const r = cleanParams(code, raw);
    if (r.unknown.length) warn.push(`ignored unknown params: ${r.unknown.join(', ')}`);
    return r.params;
  };
  const tooMany = (n: number) => n > MAX_TARGETS && fail(`too many targets (${n}), max ${MAX_TARGETS}`);

  if (name === 'set_auto_edit') {
    const r = proposeAutoEdit(a, s, fail, warn);
    return { p: { summary: r.summary, op: { op: 'auto_edit', patch: r.patch, generate: r.generate, replaceLast: r.replaceLast } }, warn };
  }
  if (name === 'add_effects') {
    const m = moduleOf(s, a.moduleId, ['effect', 'transition']);
    const blocks = arr(a.blocks).map((b) => b as { start?: unknown; duration?: unknown });
    if (!blocks.length) fail('blocks is empty');
    tooMany(blocks.length);
    const list = blocks.map((b) => {
      if (!isNum(b.start) || !isNum(b.duration) || b.duration <= 0) fail(`bad block: ${JSON.stringify(b)}`);
      return { start: Math.max(0, b.start as number), duration: Math.max(0.05, b.duration as number) };
    });
    let track: number | undefined;
    if (a.track != null) {
      if (!isNum(a.track) || !s.tracks.fx[a.track]) fail(`no effect track ${String(a.track)} (there are ${s.tracks.fx.length})`);
      if (s.tracks.fx[a.track as number].locked) fail(`effect track ${String(a.track)} is locked`);
      track = a.track as number;
    }
    const tg = String(a.trigger ?? 'none');
    const trigger: FxTrigger | undefined = m.kind === 'transition' || tg === 'cut' ? { kind: 'cut' } : TRIGGERS[tg] ? { kind: 'beat', every: TRIGGERS[tg] } : undefined;
    return { p: { summary: $t('新增特效 {0} ×{1}', modName(m), list.length), op: { op: 'add_effects', moduleId: m.id, blocks: list, track, trigger, params: P(m.code, a.params) } }, warn };
  }

  if (name === 'set_transitions') {
    const m = a.moduleId == null || a.moduleId === '' ? null : moduleOf(s, a.moduleId, ['transition']);
    let at: { clipId: string; side: TrSide }[];
    const ids = idList(a.clipIds);
    if (ids.length) {
      const side: TrSide = a.side === 'out' ? 'out' : 'in';
      at = ids.map((id) => ({ clipId: clipOf(s, id).id, side }));
    } else {
      if (!isNum(a.track) || !s.tracks.video[a.track]) fail('give clipIds, or a video track index with scope');
      at = scopeTargets(s.clips, a.track as number, String(a.scope ?? 'cuts'));
    }
    if (!m) at = at.filter((x) => { const c = clipOf(s, x.clipId); return !!(x.side === 'out' ? c.transitionOut : c.transitionIn); });
    if (!at.length) fail('no matching clips');
    tooMany(at.length);
    const duration = isNum(a.duration) ? Math.min(10, Math.max(0.05, a.duration)) : undefined;
    const summary = m ? $t('轉場 {0} ×{1}', modName(m), at.length) : $t('移除轉場 ×{0}', at.length);
    return { p: { summary, op: { op: 'set_transitions', moduleId: m?.id ?? null, at, duration, params: m ? P(m.code, a.params) : {} } }, warn };
  }

  if (name === 'set_remap' || name === 'add_clip_effects') {
    const m = moduleOf(s, a.moduleId, [name === 'set_remap' ? 'remap' : 'effect']);
    const ids = idList(a.clipIds);
    if (!ids.length) fail('clipIds is empty');
    tooMany(ids.length);
    for (const id of ids) if (clipOf(s, id).text && name === 'set_remap') fail(`clip ${id} is a text clip (no remap)`);
    const params = P(m.code, a.params);
    return name === 'set_remap'
      ? { p: { summary: $t('變速 {0} ×{1}', modName(m), ids.length), op: { op: 'set_remap', moduleId: m.id, clipIds: ids, params } }, warn }
      : { p: { summary: $t('片段特效 {0} ×{1}', modName(m), ids.length), op: { op: 'add_clip_effects', moduleId: m.id, clipIds: ids, params } }, warn };
  }

  if (name === 'set_anim_slots') {
    const an = s.anims.find((x) => x.id === String(a.anim_id));
    if (!an) fail(`unknown animation ${String(a.anim_id)} (use get_timeline.animations)`);
    const items = arr(a.items).map((x, i) => {
      const o = x as { slot?: unknown; media?: unknown; at_sec?: unknown };
      const slot = an!.slots.find((sl) => sl.id === String(o.slot));
      if (!slot) fail(`items[${i}].slot: unknown slot ${String(o.slot)}; slots: ${an!.slots.map((sl) => sl.id).join(', ')}`);
      const mid = o.media ? String(o.media) : null;
      const m = mid ? s.media.find((x) => x.id === mid) : undefined;
      if (mid && (!m || m.missing || m.kind === 'audio')) fail(`items[${i}].media: ${mid} is not a usable image / video`);
      const at = isNum(o.at_sec) && m?.kind === 'video' ? Math.max(0, Math.min(m.duration - 0.05, o.at_sec)) : 0;
      return { slotId: slot!.id, mediaId: mid, at };
    });
    if (!items.length) fail('items is empty');
    return { p: { summary: $t('換動畫的圖片 ×{0}', items.length), op: { op: 'set_anim_slots', animId: an!.id, items } }, warn };
  }

  if (name === 'update_params') {
    const targets = arr(a.targets).map((t) => parseTarget(s, t));
    if (!targets.length) fail('targets is empty');
    tooMany(targets.length);
    // 每個目標各自檢查（模組可能不同）
    for (const t of targets) {
      const m = s.modules.find((x) => x.id === targetModule(s, t));
      if (m) P(m.code, a.params);
    }
    return { p: { summary: $t('調整參數 ×{0}', targets.length), op: { op: 'update_params', targets, params: (a.params ?? {}) as Record<string, unknown> } }, warn: [...new Set(warn)] };
  }

  if (name === 'remove') {
    const targets = arr(a.targets).map((t) => parseTarget(s, t));
    if (!targets.length) fail('targets is empty');
    tooMany(targets.length);
    if (targets.some((t) => t.kind === 'remap')) fail('remap cannot be removed; set_remap to remap-none instead');
    return { p: { summary: $t('刪除 ×{0}', targets.length), op: { op: 'remove', targets } }, warn };
  }
  if (name === 'set_keyframes') {
    const targets = arr(a.targets).map((t) => parseTarget(s, t));
    if (!targets.length) fail('targets is empty');
    tooMany(targets.length);
    if (targets.some((t) => t.kind !== 'effect' && t.kind !== 'clip_fx')) fail('set_keyframes works on effect blocks and clip effects only');
    const param = String(a.param ?? '');
    const pt = parsePointCh(param);
    for (const t of targets) {
      const m = s.modules.find((x) => x.id === targetModule(s, t));
      const d = m && parseParams(m.code).find((x) => x.name === (pt?.name ?? param));
      if (!d) fail(`${targetModule(s, t)} has no parameter ${param}`);
      if (pt ? d!.type !== 'point' : d!.type !== 'float' && d!.type !== 'int') fail(`${param} is a ${d!.type} parameter; only float / int (or point .x/.y) can be animated`);
    }
    const keys = arr(a.keys).map((k) => k as { t?: unknown; v?: unknown });
    if (keys.length > 200) fail('too many keys (max 200)');
    const list = keys.map((k) => {
      if (!isNum(k.t) || !isNum(k.v)) fail(`bad key: ${JSON.stringify(k)}`);
      return { t: Math.max(0, k.t as number), v: k.v as number };
    });
    const ease = ['linear', 'inOut', 'in', 'out', 'hold'].includes(String(a.ease)) ? String(a.ease) : 'inOut';
    const summary = list.length ? $t('關鍵影格 {0} ×{1}', param, targets.length) : $t('移除動畫 {0} ×{1}', param, targets.length);
    return { p: { summary, op: { op: 'set_keyframes', targets, param, keys: list, ease } }, warn };
  }

  if (name === 'set_tracking') {
    const ids = idList(a.clipIds);
    if (!ids.length) fail('clipIds is empty');
    tooMany(ids.length);
    const media = new Map(s.media.map((m) => [m.id, m]));
    for (const id of ids) {
      const c = clipOf(s, id);
      const m = media.get(c.mediaId);
      if (c.text || !m || (m.kind !== 'video' && m.kind !== 'image')) fail(`clip ${id} is not a video / image clip`);
    }
    const target = a.target === 'off' || a.target === 'box' ? a.target : 'face';
    if (target === 'off') return { p: { summary: $t('關閉追蹤 ×{0}', ids.length), op: { op: 'set_tracking', clipIds: ids, subject: null } }, warn };
    if (target === 'face') return { p: { summary: $t('臉部追蹤 ×{0}', ids.length), op: { op: 'set_tracking', clipIds: ids, subject: { kind: 'face' } } }, warn };
    // 自訂目標：有給框就在那一格加錨點，沒給 = 開著等使用者在預覽上框
    const c = clipOf(s, ids[0]);
    let anchors = c.subject?.kind === 'box' ? c.subject.anchors : [];
    if (a.box !== undefined) {
      if (ids.length !== 1) fail('box needs exactly one clip');
      const b = a.box;
      if (!Array.isArray(b) || b.length !== 4 || !b.every(isNum)) fail('box must be [x0, y0, x1, y1]');
      const at = isNum(a.at) ? (a.at as number) : c.start;
      if (at < c.start || at >= c.start + c.duration) fail(`at ${at} is outside clip ${c.id}`);
      const m = media.get(c.mediaId)!;
      const modules = new Map(s.modules.map((x) => [x.id, x]));
      const v = b as number[];
      const box = frameRectToBox(c, m, at - c.start, s.format.w / s.format.h, [v[0], v[1]], [v[2], v[3]]);
      if (!box) fail('box is empty or outside the clip');
      anchors = putAnchor(anchors, { t: anchorTime(c, m, at - c.start, modules), box: box! });
    }
    return { p: { summary: $t('追蹤自訂目標 ×{0}', ids.length), op: { op: 'set_tracking', clipIds: ids, subject: { kind: 'box', anchors } } }, warn };
  }

  if (name === 'set_follow') {
    const targets = arr(a.targets).map((t) => parseTarget(s, t));
    if (!targets.length) fail('targets is empty');
    tooMany(targets.length);
    if (targets.some((t) => t.kind === 'remap')) fail('remaps have no point parameters');
    const param = String(a.param ?? '');
    for (const t of targets) {
      const m = s.modules.find((x) => x.id === targetModule(s, t));
      if (!m || !parseParams(m.code).some((d) => d.name === param && d.type === 'point')) fail(`${targetModule(s, t)} has no point parameter ${param}`);
    }
    const off = Array.isArray(a.offset) && a.offset.length === 2 && a.offset.every(isNum) ? (a.offset as [number, number]) : undefined;
    const follow: Follow | null = a.on === false ? null : { ...(off ? { offset: off } : {}), ...(a.side === 'to' || a.side === 'from' ? { side: a.side } : {}) };
    return { p: { summary: follow ? $t('跟隨目標 ×{0}', targets.length) : $t('不跟隨目標 ×{0}', targets.length), op: { op: 'set_follow', targets, param, follow } }, warn };
  }

  if (name === 'set_effect_timing') {
    const targets = arr(a.targets).map((t) => parseTarget(s, t));
    if (!targets.length) fail('targets is empty');
    tooMany(targets.length);
    if (targets.some((t) => t.kind !== 'clip_fx')) fail('set_effect_timing works on clip effects (kind clip_fx) only; effect blocks use add_effects with trigger');
    let timing: FxTiming | undefined;
    if (a.mode === 'whole') timing = undefined;
    else if (a.mode === 'beat') {
      const every = ([0.5, 1, 2, 4] as const).find((x) => x === a.every) ?? 1;
      timing = { kind: 'beat', every, d: isNum(a.d) && a.d > 0 ? Math.min(10, a.d) : 0.4 };
    } else if (a.mode === 'hits') {
      const hits = arr(a.hits).map((h) => h as { t?: unknown; d?: unknown });
      if (hits.length > MAX_TARGETS) fail(`too many hits (max ${MAX_TARGETS})`);
      timing = {
        kind: 'hits',
        hits: hits.map((h) => {
          if (!isNum(h.t) || !isNum(h.d) || h.d <= 0) fail(`bad hit: ${JSON.stringify(h)}`);
          return { t: Math.max(0, h.t as number), d: h.d as number };
        }),
      };
    } else fail('mode must be whole, hits or beat');
    const label = !timing ? $t('整段') : timing.kind === 'beat' ? $t('每拍觸發') : $t('手動');
    return { p: { summary: $t('作用範圍 {0} ×{1}', label, targets.length), op: { op: 'set_effect_timing', targets, timing } }, warn };
  }

  if (name === 'edit_subtitles' || name === 'split_subtitles' || name === 'translate_subtitles') {
    const raw = arr(a.items).map((x) => (x ?? {}) as Record<string, unknown>);
    if (!raw.length) fail('items is empty');
    tooMany(raw.length);
    const sub = (id: unknown) => {
      const c = clipOf(s, String(id ?? ''));
      if (!c.text) fail(`clip ${c.id} is not a subtitle (text clip)`);
      if (s.tracks.video[c.track]?.locked) fail(`clip ${c.id} is on a locked track`);
      return c;
    };
    const txt = (v: unknown) => (typeof v === 'string' ? v.replace(/\\n/g, '\n').trim() : undefined);

    if (name === 'edit_subtitles') {
      const items = raw.map((x) => {
        const c = sub(x.clipId);
        const start = isNum(x.start) ? Math.max(0, x.start) : undefined;
        const end = isNum(x.end) ? x.end : undefined;
        const st = start ?? c.start, en = end ?? c.start + c.duration;
        if (en - st < 0.1) fail(`subtitle ${c.id}: end must be at least 0.1s after start`);
        return { clipId: c.id, text: txt(x.text), start, end };
      });
      // 同一條軌上不能重疊（改過的用新時間）
      const span = new Map(items.map((i) => { const c = clipOf(s, i.clipId); return [c.id, { st: i.start ?? c.start, en: i.end ?? c.start + c.duration }]; }));
      for (const i of items) {
        const c = clipOf(s, i.clipId);
        const me = span.get(c.id)!;
        for (const o of s.clips) {
          if (o.id === c.id || o.track !== c.track) continue;
          const os = span.get(o.id) ?? { st: o.start, en: o.start + o.duration };
          if (me.st < os.en - 1e-4 && os.st < me.en - 1e-4) fail(`subtitle ${c.id} would overlap clip ${o.id} on the same track`);
        }
      }
      const nText = items.filter((i) => i.text != null).length, nTime = items.filter((i) => i.start != null || i.end != null).length;
      const summary = nText && nTime ? $t('修改字幕 ×{0}', items.length) : nTime ? $t('調整字幕時間 ×{0}', nTime) : $t('修改字幕文字 ×{0}', nText);
      return { p: { summary, op: { op: 'edit_subtitles', items } }, warn };
    }

    if (name === 'split_subtitles') {
      let pieces = 0;
      const items = raw.map((x) => {
        const c = sub(x.clipId);
        const parts = arr(x.parts).map((p) => txt(p) ?? '').filter(Boolean);
        if (parts.length < 2) fail(`subtitle ${c.id}: give at least 2 parts`);
        let times = arr(x.times).filter(isNum).sort((p, q) => p - q);
        if (times.length && times.length !== parts.length - 1) fail(`subtitle ${c.id}: times needs ${parts.length - 1} split points`);
        if (!times.length) {
          // 依字數分配時間
          const total = parts.reduce((n, p) => n + p.replace(/\s/g, '').length, 0) || parts.length;
          let acc = 0;
          times = parts.slice(0, -1).map((p) => { acc += p.replace(/\s/g, '').length || 1; return c.start + (c.duration * acc) / total; });
        }
        let prev = c.start;
        for (const t of [...times, c.start + c.duration]) {
          if (t - prev < 0.1) fail(`subtitle ${c.id}: each piece must be at least 0.1s (split points must be inside ${r3(c.start)}-${r3(c.start + c.duration)})`);
          prev = t;
        }
        pieces += parts.length;
        return { clipId: c.id, parts, times };
      });
      return { p: { summary: $t('拆開字幕 {0} → {1}', items.length, pieces), op: { op: 'split_subtitles', items } }, warn };
    }

    const items = raw.map((x) => {
      const c = sub(x.clipId);
      const text = txt(x.text);
      if (!text) fail(`subtitle ${c.id}: empty translation`);
      return { clipId: c.id, text: text! };
    });
    return { p: { summary: $t('翻譯字幕 ×{0}', items.length), op: { op: 'translate_subtitles', items } }, warn };
  }
  return fail(`unknown tool: ${name}`);
}

// ───────────── 讀取 ─────────────

const inRange = (start: number, dur: number, from?: number, to?: number) => (from == null || start + dur > from) && (to == null || start < to);

function readTimeline(s: S, a: Record<string, unknown>) {
  const from = isNum(a.from) ? a.from : undefined;
  const to = isNum(a.to) ? a.to : undefined;
  const withP = a.include_params === true;
  const media = new Map(s.media.map((m) => [m.id, m]));
  const pv = (p: ParamValues) => (withP && Object.keys(p).length ? { params: p } : {});
  const tr = (t: Clip['transitionIn']) => t && { module: t.moduleId, duration: r3(t.duration), ...pv(t.params) };
  const clips = s.clips.filter((c) => inRange(c.start, c.duration, from, to)).sort((x, y) => x.track - y.track || x.start - y.start);
  const effects = s.effects.filter((e) => inRange(e.start, e.duration, from, to)).sort((x, y) => x.track - y.track || x.start - y.start);
  const audios = s.audios.filter((c) => inRange(c.start, c.duration, from, to)).sort((x, y) => x.track - y.track || x.start - y.start);
  const anims = s.anims.filter((x) => inRange(x.start, x.duration, from, to)).sort((x, y) => x.start - y.start);
  const end = Math.max(0, ...[...s.clips, ...s.effects, ...s.audios].map((x) => x.start + x.duration));
  const cut = <T,>(l: T[]) => l.slice(0, MAX_ITEMS);
  return {
    format: `${s.format.w}x${s.format.h}`,
    duration: r3(end),
    playhead: r3(s.time),
    tracks: { video: s.tracks.video.length, fx: s.tracks.fx.length, audio: s.tracks.audio.length },
    clips: cut(clips).map((c) => {
      const m = media.get(c.mediaId);
      const remap = c.remap.moduleId !== 'remap-none' && (c.remap.moduleId !== 'remap-speed' || (c.remap.params.speed ?? 1) !== 1)
        ? { module: c.remap.moduleId, ...pv(c.remap.params) } : undefined;
      const fx = (c.effects ?? []).filter((f) => !f.base).map((f) => ({ id: f.id, module: f.moduleId, ...pv(f.params) }));
      return {
        id: c.id, track: c.track, start: r3(c.start), end: r3(c.start + c.duration),
        name: c.name ?? (c.text ? c.text.text.slice(0, 40) : m?.name),
        type: c.text ? 'text' : m?.kind ?? 'missing',
        ...(c.transitionIn ? { transitionIn: tr(c.transitionIn) } : {}),
        ...(c.transitionOut ? { transitionOut: tr(c.transitionOut) } : {}),
        ...(remap ? { remap } : {}),
        ...(fx.length ? { fx } : {}),
      };
    }),
    effects: cut(effects).map((e) => ({
      id: e.id, track: e.track, start: r3(e.start), end: r3(e.start + e.duration), module: e.moduleId,
      ...(e.trigger ? { trigger: (e.trigger.kind === 'beat' ? `every ${e.trigger.every} beat` : e.trigger.kind === 'hits' ? `manual, ${e.trigger.hits.length} hits` : 'cut') + (e.trigger.chance !== undefined && e.trigger.chance < 1 ? ` (${Math.round(e.trigger.chance * 100)}%)` : '') } : {}),
      ...(e.stack?.length ? { stacked: e.stack.map((f) => f.moduleId) } : {}),
      ...pv(e.params),
    })),
    audios: cut(audios).map((c) => ({ id: c.id, track: c.track, start: r3(c.start), end: r3(c.start + c.duration), name: c.name ?? media.get(c.mediaId)?.name })),
    // 動畫：多張圖組成的現成動畫（主體跳出）；圖片用 set_anim_slots 換
    ...(anims.length ? { animations: cut(anims).map((x) => ({
      id: x.id, track: x.track, start: r3(x.start), end: r3(x.start + x.duration), template: x.presetId, ...(x.name ? { name: x.name } : {}), ...(x.locked ? { locked: true } : {}),
      slots: x.slots.filter((sl) => sl.role !== 'other').map((sl) => ({ id: sl.id, role: sl.role, media: sl.mediaId, ...(sl.mediaId ? { name: media.get(sl.mediaId)?.name, at_sec: r3(sl.sourceTime) } : {}) })),
    })) } : {}),
    ...(clips.length > MAX_ITEMS || effects.length > MAX_ITEMS || audios.length > MAX_ITEMS ? { note: `truncated to ${MAX_ITEMS} per list; use from/to` } : {}),
  };
}

function readBeats(s: S, a: Record<string, unknown>) {
  const every = ([0.5, 1, 2, 4] as const).find((x) => x === a.every) ?? 1;
  const from = isNum(a.from) ? a.from : -Infinity;
  const to = isNum(a.to) ? a.to : Infinity;
  const all = getBeats(s, 1);
  if (!all.length) return { beats: [], note: 'no beats: there is no music on the audio tracks' };
  const pts = triggerBeats(every).filter((t) => t >= from && t < to);
  const downs = all.filter((b) => b.down && b.t >= from && b.t < to).map((b) => r3(b.t));
  const period = all.length > 1 ? (all[all.length - 1].t - all[0].t) / (all.length - 1) : 0;
  return {
    bpm: period ? Math.round(60 / period) : undefined,
    every,
    count: pts.length,
    times: pts.slice(0, MAX_BEATS).map(r3),
    downbeats: downs.slice(0, MAX_BEATS),
    ...(pts.length > MAX_BEATS ? { note: `truncated to ${MAX_BEATS}; use from/to` } : {}),
  };
}

function readSubtitles(s: S, a: Record<string, unknown>) {
  const from = isNum(a.from) ? a.from : undefined;
  const to = isNum(a.to) ? a.to : undefined;
  const list = captionList(s.clips, s.tracks).filter((c) => inRange(c.start, c.duration, from, to));
  return {
    count: list.length,
    subtitles: list.slice(0, MAX_ITEMS).map((c) => ({ id: c.id, track: c.track, start: r3(c.start), end: r3(c.start + c.duration), text: c.text!.text })),
    ...(list.length > MAX_ITEMS ? { note: `truncated to ${MAX_ITEMS}; use from/to` } : {}),
  };
}

function readSelection(s: S) {
  const keys = s.selected.map(parseKey);
  const sel = s.selection;
  if (sel?.type === 'transition') keys.unshift({ type: 'transition' as never, id: sel.id });
  return {
    playhead: r3(s.time),
    selected: keys.map((k) => (k.type === ('transition' as never) ? { type: 'transition', clipId: k.id.replace(/^out:/, ''), side: k.id.startsWith('out:') ? 'out' : 'in' } : k)),
    ...(s.loop ? { loop: { from: r3(s.loop.a), to: r3(s.loop.b) } } : {}),
  };
}

// ───────────── 快照（跟著問題一起送，省掉讀取的來回） ─────────────

/** 快照裡每個清單最多幾行（超過就請 AI 用 get_timeline 分段讀） */
const SNAP_ITEMS = 80;
const SNAP_DOWNBEATS = 48;

/** 模組參數：目前值（沒設定 = 預設值） */
function paramLine(s: S, moduleId: string, values: ParamValues, follow?: FollowMap): string {
  const m = s.modules.find((x) => x.id === moduleId);
  if (!m) return '';
  const defs = parseParams(m.code);
  if (!defs.length) return '';
  return defs.map((d) => {
    const v = values[d.name] ?? d.def;
    const range = (d.type === 'float' || d.type === 'int') && d.max > d.min ? ` (${d.min}..${d.max})` : '';
    const tag = followOf(d, follow) ? ' (follows target)' : fitOf(d, defs, follow) ? ' (sized to target)' : '';
    return `${d.name}:${d.type}=${JSON.stringify(v)}${range}${tag}`;
  }).join(', ');
}

/** 有動畫的參數：name[t:v …] */
function animLine(keys: Record<string, Keyframe[]> | undefined): string {
  const l = Object.entries(keys ?? {}).filter(([k, v]) => !k.startsWith('mask.') && v.length);
  return l.length ? `; animated: ${l.map(([k, v]) => `${k}[${v.slice(0, 8).map((x) => `${r3(x.t)}:${r3(x.v)}`).join(' ')}${v.length > 8 ? ' …' : ''}]`).join(' ')}` : '';
}
function timingLine(t: FxTiming | undefined): string {
  if (!t) return 'whole clip';
  if (t.kind === 'beat') return `every ${t.every} beat, ${r3(t.d)}s each`;
  return `hits ${t.hits.slice(0, 12).map((h) => `${r3(h.t)}+${r3(h.d)}`).join(' ') || 'none'}${t.hits.length > 12 ? ' …' : ''}`;
}

/** 快照裡最多列幾段字幕、每段最多幾個字 */
const SNAP_SUBS = 60;
const SUB_CHARS = 80;

/**
 * 專案的精簡文字快照：選取（含參數）、節拍、片段、特效方塊、音訊。
 * 大部分要求靠它就能直接提議修改，不用先花一個請求讀時間軸。
 */
export function projectSnapshot(s: S = useStore.getState()): string {
  const t = readTimeline(s, {});
  const L: string[] = [];
  L.push(`format ${t.format}, length ${t.duration}s, playhead ${t.playhead}s, tracks: video ${t.tracks.video}, fx ${t.tracks.fx}, audio ${t.tracks.audio}`);

  // 選取的項目：連參數一起給（「調強一點」之類的要求不用再讀）
  const sel = readSelection(s).selected as { type: string; id?: string; clipId?: string; side?: string }[];
  if (!sel.length) L.push('selected: nothing');
  else {
    L.push('selected:');
    for (const k of sel.slice(0, 10)) {
      if (k.type === 'effect') {
        const e = s.effects.find((x) => x.id === k.id);
        if (e) L.push(`- effect block ${e.id} ${e.moduleId} ${r3(e.start)}-${r3(e.start + e.duration)} params: ${paramLine(s, e.moduleId, e.params, e.follow) || '-'}${animLine(e.keys)}`);
      } else if (k.type === 'transition') {
        const c = s.clips.find((x) => x.id === k.clipId);
        const tr = k.side === 'out' ? c?.transitionOut : c?.transitionIn;
        if (tr) L.push(`- transition clipId=${c!.id} side=${k.side} ${tr.moduleId} ${r3(tr.duration)}s params: ${paramLine(s, tr.moduleId, tr.params, tr.follow) || '-'}`);
      } else if (k.type === 'clip') {
        const c = s.clips.find((x) => x.id === k.id);
        if (!c) continue;
        L.push(`- clip ${c.id} ${r3(c.start)}-${r3(c.start + c.duration)}; remap ${c.remap.moduleId} params: ${paramLine(s, c.remap.moduleId, c.remap.params) || '-'}`);
        for (const f of (c.effects ?? []).filter((x) => !x.base)) L.push(`  - clip_fx fxId=${f.id} ${f.moduleId} params: ${paramLine(s, f.moduleId, f.params, f.follow) || '-'}${animLine(f.keys)}; active: ${timingLine(f.timing)}`);
      } else L.push(`- ${k.type} ${k.id}`);
    }
  }

  // 節拍：BPM + 重拍時間；每拍的效果用觸發，不需要列出每一拍
  const all = getBeats(s, 1);
  if (!all.length) L.push('beats: none (no music on the audio tracks)');
  else {
    const period = all.length > 1 ? (all[all.length - 1].t - all[0].t) / (all.length - 1) : 0;
    const downs = all.filter((b) => b.down).map((b) => r3(b.t));
    L.push(`beats: ${period ? Math.round(60 / period) : '?'} BPM, ${all.length} beats ${r3(all[0].t)}-${r3(all[all.length - 1].t)}s, beat ≈ ${r3(period)}s`);
    L.push(`downbeats: ${downs.slice(0, SNAP_DOWNBEATS).join(' ')}${downs.length > SNAP_DOWNBEATS ? ` … (${downs.length} total; get_beats for more)` : ''}`);
  }

  const more = (n: number) => (n > SNAP_ITEMS ? [`… ${n - SNAP_ITEMS} more; use get_timeline with from/to`] : []);
  L.push('clips (id track start-end name extras):');
  for (const c of t.clips.slice(0, SNAP_ITEMS)) {
    const x: string[] = [];
    if (c.transitionIn) x.push(`in:${c.transitionIn.module}/${c.transitionIn.duration}`);
    if (c.transitionOut) x.push(`out:${c.transitionOut.module}/${c.transitionOut.duration}`);
    if (c.remap) x.push(`remap:${c.remap.module}`);
    if (c.fx) x.push(`fx:${c.fx.map((f) => `${f.id}=${f.module}`).join(',')}`);
    const sub = s.clips.find((k) => k.id === c.id)?.subject;
    if (sub) x.push(sub.kind === 'face' ? 'tracking:face' : `tracking:box(${sub.anchors.length} anchors)`);
    L.push(`${c.id} v${c.track} ${c.start}-${c.end} ${c.type} "${(c.name ?? '').slice(0, 30)}"${x.length ? ' ' + x.join(' ') : ''}`);
  }
  L.push(...more(s.clips.length));
  L.push('effect blocks (id track start-end module):');
  if (!t.effects.length) L.push('none');
  for (const e of t.effects.slice(0, SNAP_ITEMS)) L.push(`${e.id} fx${e.track} ${e.start}-${e.end} ${e.module}${e.trigger ? ` trigger=${e.trigger}` : ''}${e.stacked ? ` +${e.stacked.join('+')}` : ''}`);
  L.push(...more(s.effects.length));
  const subs = captionList(s.clips, s.tracks);
  if (subs.length) {
    L.push('subtitles (id track start-end text):');
    for (const c of subs.slice(0, SNAP_SUBS)) {
      const x = c.text!.text.replace(/\n/g, '\\n');
      L.push(`${c.id} v${c.track} ${r3(c.start)}-${r3(c.start + c.duration)} "${x.length > SUB_CHARS ? x.slice(0, SUB_CHARS) + '…' : x}"`);
    }
    if (subs.length > SNAP_SUBS || subs.some((c) => c.text!.text.length > SUB_CHARS)) L.push(`… ${subs.length} subtitles in total, long ones cut; use get_subtitles for full text`);
  }
  if (t.audios.length) {
    L.push('audio:');
    for (const a of t.audios.slice(0, SNAP_ITEMS)) L.push(`${a.id} a${a.track} ${a.start}-${a.end} "${(a.name ?? '').slice(0, 30)}"`);
  }
  return L.join('\n');
}

/** 修改工具（成功後不用再問 AI 一次） */
export const isEditTool = (name: string) => isProjectTool(name) && !READ.has(name);

// ───────────── 執行工具 ─────────────

/** 執行一個專案工具：讀取 → 回傳資料；修改 → 驗證後放進 proposals，回傳摘要 */
export function runProjectTool(name: string, args: Record<string, unknown>, proposals: Proposal[]): Record<string, unknown> {
  const s = useStore.getState();
  try {
    if (name === 'get_timeline') return readTimeline(s, args);
    if (name === 'get_beats') return readBeats(s, args);
    if (name === 'get_selection') return readSelection(s);
    if (name === 'get_subtitles') return readSubtitles(s, args);
    if (name === 'get_auto_edit') return readAutoEdit(s);
    if (READ.has(name)) return { error: 'unknown' };
    const { p, warn } = propose(name, args, s);
    proposals.push(p);
    return { ok: true, proposed: p.summary, note: 'Not applied yet: the user reviews all proposed changes and presses Apply.', ...(warn.length ? { warnings: warn } : {}) };
  } catch (e) {
    if (e instanceof ToolError) return { error: e.message };
    throw e;
  }
}

// ───────────── 套用 ─────────────

/** 找一條在 [start, start+dur) 有空位的特效軌；都沒有就新增一條 */
function freeFxTrack(start: number, dur: number, prefer?: number): number {
  const s = useStore.getState();
  const spans = spansOf(s);
  const free = (i: number) => !s.tracks.fx[i]?.locked && Math.abs(fitStart(spans, laneOf('effect', i), start, dur) - start) < 1e-6;
  if (prefer != null && free(prefer)) return prefer;
  for (let i = 0; i < s.tracks.fx.length; i++) if (free(i)) return i;
  s.addTrack('fx');
  return useStore.getState().tracks.fx.length - 1;
}

function mergeParams(code: string | undefined, cur: ParamValues, raw: unknown): ParamValues {
  if (!code) return cur;
  try {
    return { ...cur, ...cleanParams(code, raw).params };
  } catch {
    return cur;
  }
}

/** onAutoEdit：自動剪輯產生完的結果（AI 對話接著看結果） */
export interface ApplyHooks { onAutoEdit?: (r: { ok: boolean; text: string; cancelled?: true } | null) => void }

function applyOp(op: Op, hooks: ApplyHooks = {}): number {
  const st = useStore.getState();
  const code = (id: string | undefined) => st.modules.find((m) => m.id === id)?.code;
  const has = (id: string) => useStore.getState().clips.some((c) => c.id === id);
  // 直接改資料：store 的 setTransition / setRemap / addClipFx 會改選取，選取一變面板就會跳到「屬性」
  const patchClip = (id: string, fn: (c: Clip) => Clip) => useStore.setState((s) => ({ clips: s.clips.map((c) => (c.id === id ? fn(c) : c)) }));
  const trField = (side: TrSide) => (side === 'out' ? 'transitionOut' : 'transitionIn') as 'transitionOut' | 'transitionIn';
  let n = 0;
  switch (op.op) {
    case 'auto_edit':
      applyAutoEdit(op.patch, op.generate, op.replaceLast, hooks.onAutoEdit);
      return 1;
    case 'add_items': {
      const ok = (id: string) => st.modules.some((m) => m.id === id);
      // 文字片段沒有素材（mediaId 是空的）
      const clips = op.clips.filter((c) => !!c.text || st.media.some((m) => m.id === c.mediaId && !m.missing));
      const effects = op.effects.filter((e) => ok(e.moduleId));
      const audios = (op.audios ?? []).filter((a) => st.media.some((m) => m.id === a.mediaId && !m.missing));
      const anims = op.anims ?? [];
      if (!clips.length && !effects.length && !audios.length && !anims.length) return 0;
      // 這批東西佔的時間：軌道在這段時間沒東西 = 空著
      const all = [...clips, ...effects, ...audios, ...anims];
      const t0 = Math.min(...all.map((x) => x.start)), t1 = Math.max(...all.map((x) => x.start + x.duration));
      // 差不到 1 毫秒不算重疊（接在時間軸最後面時，開頭對齊格線會比最後一個片段的結尾早一點點）
      const busy = (items: { track: number; start: number; duration: number }[], i: number) => items.some((x) => x.track === i && x.start < t1 - 1e-3 && x.start + x.duration > t0 + 1e-3);
      // 影片軌：每一層一條；用比這段時間有東西的軌道都高的空軌（層的上下順序不變），不夠再新增
      let s = useStore.getState();
      const layerOf = (c: { track: number }) => Math.max(0, Math.round(c.track));
      const layers = clips.length || anims.length ? Math.max(...[...clips, ...anims].map(layerOf)) + 1 : 0;
      const vts: number[] = [];
      if (layers) {
        let floor = -1;
        s.tracks.video.forEach((t, i) => { if (t.locked || busy(s.clips, i) || busy(s.anims, i)) floor = i; });
        for (let i = floor + 1; i < s.tracks.video.length && vts.length < layers; i++) vts.push(i);
        while (vts.length < layers) {
          st.addTrack('video', useStore.getState().tracks.video.length);
          vts.push(useStore.getState().tracks.video.length - 1);
        }
      }
      s = useStore.getState();
      // 特效軌：effect.track = 第幾層（每層一條，層號小的先套用），放在所有影片軌上方；這段時間空著的先用
      const fts: number[] = [];
      // 層號可能跳號（0、2）：照順序對到連續的特效軌
      const layerIdx = [...new Set(effects.map((e) => Math.max(0, Math.round(e.track))))].sort((a, b) => a - b);
      if (effects.length) {
        const top = s.tracks.video.length;
        s.tracks.fx.forEach((t, i) => {
          if (fts.length < layerIdx.length && !t.locked && fxLevel(s.tracks, i) >= top && !busy(s.effects, i)) fts.push(i);
        });
        while (fts.length < layerIdx.length) {
          st.addTrack('fx', useStore.getState().tracks.fx.length, top);
          fts.push(useStore.getState().tracks.fx.length - 1);
        }
      }
      // 音訊軌：第一條這段時間空著的
      s = useStore.getState();
      let at = -1;
      if (audios.length) {
        at = s.tracks.audio.findIndex((t, i) => !t.locked && !busy(s.audios, i));
        if (at < 0) {
          st.addTrack('audio');
          at = useStore.getState().tracks.audio.length - 1;
        }
      }
      useStore.setState((x) => ({
        clips: [...x.clips, ...clips.map((c) => ({ ...c, track: vts[layerOf(c)] }))],
        effects: [...x.effects, ...effects.map((e) => ({ ...e, track: fts[layerIdx.indexOf(Math.max(0, Math.round(e.track)))] }))],
        ...(audios.length ? { audios: [...x.audios, ...audios.map((a) => ({ ...a, track: at }))] } : {}),
        ...(anims.length ? { anims: [...x.anims, ...anims.map((a) => ({ ...a, track: vts[layerOf(a)] }))] } : {}),
      }));
      return clips.length + effects.length + audios.length + anims.length;
    }
    case 'add_effects': {
      if (!st.modules.some((m) => m.id === op.moduleId)) return 0;
      const isTr = st.modules.find((m) => m.id === op.moduleId)!.kind === 'transition';
      for (const b of op.blocks) {
        const track = freeFxTrack(b.start, b.duration, op.track);
        const fx: FxItem = {
          id: uid(), moduleId: op.moduleId, params: { ...op.params }, start: b.start, duration: b.duration, track,
          ...(op.trigger ? { trigger: op.trigger } : {}),
          ...(isTr ? { trDur: transDur() } : {}),
        };
        useStore.setState((s) => ({ effects: [...s.effects, fx] }));
        n++;
      }
      return n;
    }
    case 'set_transitions':
      for (const x of op.at) {
        if (!has(x.clipId)) continue;
        const f = trField(x.side);
        const id = op.moduleId;
        patchClip(x.clipId, (c) => {
          const cur = c[f];
          return {
            ...c,
            [f]: id ? { moduleId: id, params: { ...(cur?.moduleId === id ? cur.params : {}), ...op.params }, duration: op.duration ?? cur?.duration ?? transDur() } : null,
          };
        });
        n++;
      }
      return n;
    case 'set_anim_slots': {
      const an = st.anims.find((x) => x.id === op.animId);
      if (!an) return 0;
      const by = new Map(op.items.map((x) => [x.slotId, x]));
      st.updateAnim(an.id, { slots: an.slots.map((sl) => { const x = by.get(sl.id); return x ? { ...sl, mediaId: x.mediaId, sourceTime: x.at } : sl; }) });
      return op.items.length;
    }
    case 'set_remap':
      for (const id of op.clipIds) {
        if (!has(id)) continue;
        patchClip(id, (c) => {
          const r = remapFor(c, op.moduleId, st.modules, srcAvail(c, st.media));
          return { ...c, remap: { ...r, params: { ...r.params, ...op.params } } };
        });
        n++;
      }
      return n;
    case 'add_clip_effects':
      for (const id of op.clipIds) {
        if (!has(id)) continue;
        patchClip(id, (c) => ({ ...c, effects: [...(c.effects ?? []), { id: uid(), moduleId: op.moduleId, params: { ...op.params }, timing: defaultTiming(useStore.getState().modules.find((m) => m.id === op.moduleId)) }] }));
        n++;
      }
      return n;
    case 'update_params':
      for (const t of op.targets) {
        const s = useStore.getState();
        if (t.kind === 'effect') {
          const e = s.effects.find((x) => x.id === t.id);
          if (!e) continue;
          st.updateEffect(e.id, { params: mergeParams(code(e.moduleId), e.params, op.params) });
        } else {
          const c = s.clips.find((x) => x.id === t.clipId);
          if (!c) continue;
          if (t.kind === 'clip_fx') {
            const f = c.effects?.find((x) => x.id === t.fxId);
            if (!f) continue;
            st.updateClipFx(c.id, f.id, { params: mergeParams(code(f.moduleId), f.params, op.params) });
          } else if (t.kind === 'transition') {
            const tr = t.side === 'out' ? c.transitionOut : c.transitionIn;
            if (!tr) continue;
            st.updateTransition(c.id, { params: mergeParams(code(tr.moduleId), tr.params, op.params) }, t.side);
          } else {
            st.updateClip(c.id, { remap: { ...c.remap, params: mergeParams(code(c.remap.moduleId), c.remap.params, op.params) } });
          }
        }
        n++;
      }
      return n;
    case 'set_keyframes': {
      const EASES: Record<string, Keyframe['ease']> = { linear: [0, 0, 1, 1], inOut: [0.42, 0, 0.58, 1], in: [0.42, 0, 1, 1], out: [0, 0, 0.58, 1], hold: 'hold' };
      const ease = EASES[op.ease] ?? EASES.inOut;
      const pt = parsePointCh(op.param);
      for (const t of op.targets) {
        const s = useStore.getState();
        const item = t.kind === 'effect' ? s.effects.find((x) => x.id === t.id) : t.kind === 'clip_fx' ? s.clips.find((c) => c.id === t.clipId)?.effects?.find((f) => f.id === t.fxId) : undefined;
        if (!item) continue;
        const d = parseParams(code(item.moduleId) ?? '').find((x) => x.name === (pt?.name ?? op.param));
        if (!d) continue;
        const clamp = (v: number) => (Number.isFinite(d.min) && Number.isFinite(d.max) && d.max > d.min && !pt ? Math.min(d.max, Math.max(d.min, v)) : v);
        const keys = { ...(item.keys ?? {}) };
        let params = item.params;
        if (op.keys.length) keys[op.param] = sortKeys(op.keys.map((k) => newKey(k.t, clamp(k.v), ease)));
        else {
          // 關掉動畫：值留在第一個關鍵影格
          const first = keys[op.param]?.[0];
          delete keys[op.param];
          if (first) {
            if (pt) {
              const cur = (Array.isArray(params[d.name]) ? params[d.name] : String(d.def).split(',').map(Number)) as number[];
              const next = [...cur];
              next[pt.axis] = first.v;
              params = { ...params, [d.name]: next };
            } else params = { ...params, [d.name]: first.v };
          }
        }
        if (t.kind === 'effect') st.updateEffect(t.id, { keys, params });
        else if (t.kind === 'clip_fx') st.updateClipFx(t.clipId, t.fxId, { keys, params });
        n++;
      }
      return n;
    }
    case 'set_tracking':
      for (const id of op.clipIds) {
        if (!has(id)) continue;
        patchClip(id, (c) => ({ ...c, subject: op.subject ?? undefined }));
        n++;
      }
      return n;
    case 'set_follow':
      for (const t of op.targets) {
        const s = useStore.getState();
        const put = <T extends { follow?: FollowMap }>(x: T) => ({ follow: { ...(x.follow ?? {}), [op.param]: op.follow } });
        if (t.kind === 'effect') {
          const e = s.effects.find((x) => x.id === t.id);
          if (!e) continue;
          st.updateEffect(e.id, put(e));
        } else if (t.kind === 'clip_fx') {
          const f = s.clips.find((c) => c.id === t.clipId)?.effects?.find((x) => x.id === t.fxId);
          if (!f) continue;
          st.updateClipFx(t.clipId, t.fxId, put(f));
        } else if (t.kind === 'transition') {
          const c = s.clips.find((x) => x.id === t.clipId);
          const tr = t.side === 'out' ? c?.transitionOut : c?.transitionIn;
          if (!tr) continue;
          st.updateTransition(t.clipId, put(tr), t.side);
        } else continue;
        n++;
      }
      return n;
    case 'set_effect_timing':
      for (const t of op.targets) {
        if (t.kind !== 'clip_fx') continue;
        const c = useStore.getState().clips.find((x) => x.id === t.clipId);
        if (!c?.effects?.some((f) => f.id === t.fxId)) continue;
        const timing = op.timing?.kind === 'hits' ? { kind: 'hits' as const, hits: normalizeHits(op.timing.hits, c.duration) } : op.timing;
        st.updateClipFx(c.id, t.fxId, { timing });
        n++;
      }
      return n;
    case 'edit_subtitles':
      for (const i of op.items) {
        if (!has(i.clipId)) continue;
        patchClip(i.clipId, (c) => {
          const start = i.start ?? c.start;
          const end = i.end ?? c.start + c.duration;
          return { ...c, start, duration: Math.max(0.1, end - start), ...(i.text != null && c.text ? { text: { ...c.text, text: i.text } } : {}) };
        });
        n++;
      }
      return n;
    case 'split_subtitles':
      for (const i of op.items) {
        const c = useStore.getState().clips.find((x) => x.id === i.clipId);
        if (!c?.text) continue;
        const end = c.start + c.duration;
        const times = i.times.filter((t) => t > c.start + 0.05 && t < end - 0.05);
        if (times.length !== i.parts.length - 1) continue;
        // 跟字幕清單的「分割」一樣用 splitAtTimes（轉場、關鍵影格、片段特效都會照規則分）
        useStore.setState({ selection: { type: 'clip', id: c.id }, selected: [`clip:${c.id}`] });
        useStore.getState().splitAtTimes(times);
        const pieces = useStore.getState().clips.filter((x) => x.track === c.track && x.text && x.start >= c.start - 1e-4 && x.start < end - 1e-4).sort((p, q) => p.start - q.start);
        if (pieces.length !== i.parts.length) continue;
        const text = new Map(pieces.map((x, k) => [x.id, i.parts[k]]));
        useStore.setState((s) => ({ clips: s.clips.map((x) => (text.has(x.id) ? { ...x, text: { ...x.text!, text: text.get(x.id)! } } : x)) }));
        n++;
      }
      return n;
    case 'translate_subtitles': {
      const src = op.items.map((i) => ({ i, c: useStore.getState().clips.find((x) => x.id === i.clipId) })).filter((x): x is { i: typeof x.i; c: Clip } => !!x.c?.text);
      if (!src.length) return 0;
      // 新軌道放在來源字幕最上面那條軌的正上方
      const at = Math.max(...src.map((x) => x.c.track)) + 1;
      useStore.getState().addTrack('video', at);
      const fh = useStore.getState().format.h || 1080;
      const copies: Clip[] = src.map(({ i, c: old }) => {
        const c = useStore.getState().clips.find((x) => x.id === old.id) ?? old;
        const lines = Math.max(1, c.text!.text.split('\n').length);
        const lh = (c.text!.size * (c.text!.lineHeight || 1.2) * Math.abs(c.transform.scaleY || 1)) / fh;
        return {
          ...structuredClone(c),
          id: uid(),
          track: at,
          name: undefined,
          text: { ...c.text!, text: i.text },
          // 畫面上放在原字幕上方，不會疊在一起
          transform: { ...c.transform, y: c.transform.y - lh * (lines + 0.2) },
          effects: c.effects?.map((f) => ({ ...structuredClone(f), id: uid() })),
        };
      });
      useStore.setState((s) => ({ clips: [...s.clips, ...copies] }));
      return copies.length;
    }
    case 'remove':
      for (const t of op.targets) {
        const s = useStore.getState();
        if (t.kind === 'effect') {
          if (!s.effects.some((e) => e.id === t.id)) continue;
          useStore.setState({ effects: s.effects.filter((e) => e.id !== t.id) });
        } else if (t.kind === 'clip_fx') {
          if (!s.clips.find((c) => c.id === t.clipId)?.effects?.some((f) => f.id === t.fxId)) continue;
          st.removeClipFx(t.clipId, t.fxId);
        } else if (t.kind === 'transition') {
          if (!has(t.clipId)) continue;
          patchClip(t.clipId, (c) => ({ ...c, [trField(t.side)]: null }));
        } else continue;
        n++;
      }
      return n;
  }
}

/** 一次套用所有提議（一步復原）；回傳實際套用了幾項、幾項因為目標不見了而跳過 */
export function applyProposals(list: Proposal[], hooks: ApplyHooks = {}): { done: number; skipped: number } {
  const s0 = useStore.getState();
  const keep = { selection: s0.selection, selected: s0.selected, leftTab: s0.leftTab };
  let done = 0;
  let skipped = 0;
  beginHistoryTransaction();
  try {
    for (const p of list) {
      const o = p.op;
      const want = o.op === 'auto_edit' ? 1 : o.op === 'add_items' ? o.clips.length + o.effects.length + (o.audios?.length ?? 0) + (o.anims?.length ?? 0) : o.op === 'add_effects' ? o.blocks.length : o.op === 'set_transitions' ? o.at.length : 'clipIds' in o ? o.clipIds.length : 'items' in o ? o.items.length : o.targets.length;
      const n = applyOp(p.op, hooks);
      done += n;
      skipped += Math.max(0, want - n);
    }
  } finally {
    endHistoryTransaction(true);
  }
  // 選取的東西被刪了就清掉
  const s = useStore.getState();
  const alive = (type: string, id: string): boolean => {
    if (type === 'clip') return s.clips.some((x) => x.id === id);
    if (type === 'effect') return s.effects.some((x) => x.id === id);
    if (type === 'audio') return s.audios.some((x) => x.id === id);
    if (type === 'transition') {
      const c = s.clips.find((x) => x.id === id.replace(/^out:/, ''));
      return !!(id.startsWith('out:') ? c?.transitionOut : c?.transitionIn);
    }
    return true;
  };
  const sel = keep.selection && alive(keep.selection.type, keep.selection.id) ? keep.selection : null;
  const selected = keep.selected.filter((k) => { const x = parseKey(k); return alive(x.type, x.id); });
  // 沒變就不要動（同一個物件 = 面板不會切換）
  if (sel !== s.selection || selected.length !== s.selected.length || s.leftTab !== keep.leftTab) useStore.setState({ selection: sel, selected, leftTab: keep.leftTab });
  return { done, skipped };
}
