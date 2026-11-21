import { $t } from '../i18n';
import { uid, useStore, type AudioDrive, type Clip, type ClipFx, type FxItem, type TrSide, type TransitionRef } from '../store';
import { pointCh, type ParamValue, type ParamValues } from '../engine/params';
import type { AnimProp, Keyframe } from '../engine/keyframes';
import type { FxTrigger } from '../engine/trigger';
import { clipTransformAt } from '../engine/transform';
import { sortClips, transitionWindow } from '../engine/renderer';
import { useTrSel } from './trSelect';
import { toast, type MenuItem } from './uiStore';

/**
 * 「套用到同軌 / 選取的」：把轉場、特效、片段的某個屬性（或整個）套到其他項目上。
 * - 轉場：同一條軌道上「同種類」的轉場（長度不分種類），可以只挑剪接點 / 開頭 / 結尾；或選取中的轉場
 * - 特效：「同種類」的特效（同軌、整個專案或選取的）；片段特效的「同軌」= 同一條影片軌上的片段
 * - 片段：同一條影片軌上的同類片段，或選取的片段
 */

type S = ReturnType<typeof useStore.getState>;
const selectedIds = (s: S, type: 'clip' | 'effect') => s.selected.filter((k) => k.startsWith(type + ':')).map((k) => k.slice(type.length + 1));

// ───────── 轉場 ─────────

export type TrPos = 'cuts' | 'heads' | 'tails' | 'all' | 'selected';

/** 一條軌道上所有生效中的轉場（含位置：剪接點 / 開頭 / 結尾） */
function trackTransitions(clips: Clip[], track: number) {
  const sorted = sortClips(clips.filter((c) => c.track === track));
  const out: { clip: Clip; side: TrSide; tr: TransitionRef; mode: 'cut' | 'head' | 'tail' }[] = [];
  sorted.forEach((c, i) => {
    for (const side of ['in', 'out'] as const) {
      const tr = side === 'out' ? c.transitionOut : c.transitionIn;
      const w = tr && transitionWindow(sorted[i - 1], c, side, sorted[i + 1]);
      if (tr && w) out.push({ clip: c, side, tr, mode: w.mode });
    }
  });
  return out;
}

const posOk = (pos: TrPos, mode: 'cut' | 'head' | 'tail') => pos === 'all' || (pos === 'cuts' && mode === 'cut') || (pos === 'heads' && mode === 'head') || (pos === 'tails' && mode === 'tail');
const trId = (clipId: string, side: TrSide) => (side === 'out' ? 'out:' + clipId : clipId);

/** 把來源轉場的一個參數（或長度）套用到同軌（或選取中）的其他轉場；回傳改了幾個 */
export function applyTrProp(clipId: string, side: TrSide, prop: { param: string } | 'duration', pos: TrPos): number {
  const s = useStore.getState();
  const src = s.clips.find((c) => c.id === clipId);
  const tr = side === 'out' ? src?.transitionOut : src?.transitionIn;
  if (!src || !tr) return 0;
  let pool;
  if (pos === 'selected') {
    const sel = new Set(useTrSel.getState().ids);
    const tracks = new Set(s.clips.filter((c) => sel.has(c.id) || sel.has('out:' + c.id)).map((c) => c.track));
    pool = [...tracks].flatMap((t) => trackTransitions(s.clips, t)).filter((t) => sel.has(trId(t.clip.id, t.side)));
  } else pool = trackTransitions(s.clips, src.track).filter((t) => posOk(pos, t.mode));
  const targets = pool.filter((t) => !(t.clip.id === clipId && t.side === side));
  const patch = new Map<string, Partial<Clip>>();
  let n = 0;
  for (const t of targets) {
    let next: TransitionRef;
    if (prop === 'duration') next = { ...t.tr, duration: tr.duration };
    else {
      if (t.tr.moduleId !== tr.moduleId) continue; // 參數只套用到同種類的轉場
      const v = tr.params[prop.param];
      const params = { ...t.tr.params };
      if (v === undefined) delete params[prop.param];
      else params[prop.param] = structuredClone(v);
      next = { ...t.tr, params };
    }
    const p = patch.get(t.clip.id) ?? {};
    p[t.side === 'out' ? 'transitionOut' : 'transitionIn'] = next;
    patch.set(t.clip.id, p);
    n++;
  }
  if (n) useStore.setState({ clips: s.clips.map((c) => (patch.has(c.id) ? { ...c, ...patch.get(c.id) } : c)) });
  return n;
}

const done = (n: number) => toast(n ? $t('已套用到 {0} 個轉場', n) : $t('沒有可以套用的轉場'), n ? undefined : 'error');

/** 轉場屬性的右鍵選單：「套用到同軌」→ 剪接點 / 開頭 / 結尾 / 全部；「套用到選取的轉場」 */
export function trPropMenu(clipId: string, side: TrSide, prop: { param: string } | 'duration'): MenuItem[] {
  const run = (pos: TrPos) => () => done(applyTrProp(clipId, side, prop, pos));
  return [
    {
      label: $t('套用到同軌'),
      submenu: [
        { label: $t('剪接點'), action: run('cuts') },
        { label: $t('開頭'), action: run('heads') },
        { label: $t('結尾'), action: run('tails') },
        { separator: true },
        { label: $t('全部'), action: run('all') },
      ],
    },
    { label: $t('套用到選取的轉場'), action: run('selected') },
  ];
}

// ───────── 特效 ─────────

/** 特效是誰：特效軌上的特效，或某個片段的片段特效 */
export type FxOwner = { kind: 'fx'; id: string } | { kind: 'cfx'; clipId: string; id: string };

/** 特效參數套用到同種類的特效；value = 播放頭位置的值（套用成固定值，目標上這個參數的關鍵影格會移除） */
export function applyFxParam(owner: FxOwner, name: string, value: ParamValue, scope: 'track' | 'all' | 'selected'): number {
  const s = useStore.getState();
  const dropKeys = (keys: Record<string, Keyframe[]> | undefined) => {
    if (!keys) return keys;
    const k = { ...keys };
    delete k[name];
    delete k[pointCh(name, 0)];
    delete k[pointCh(name, 1)];
    return k;
  };
  const set = <T extends { params: ParamValues; keys?: Record<string, Keyframe[]> }>(f: T): T => ({ ...f, params: { ...f.params, [name]: structuredClone(value) }, keys: dropKeys(f.keys) });
  let n = 0;
  if (owner.kind === 'fx') {
    const src = s.effects.find((f) => f.id === owner.id);
    if (!src) return 0;
    const sel = new Set(selectedIds(s, 'effect'));
    const effects = s.effects.map((f) => {
      if (f.id === src.id || f.moduleId !== src.moduleId) return f;
      if (scope === 'track' && f.track !== src.track) return f;
      if (scope === 'selected' && !sel.has(f.id)) return f;
      n++;
      return set(f);
    });
    if (n) useStore.setState({ effects });
    return n;
  }
  const clip = s.clips.find((c) => c.id === owner.clipId);
  const src = clip?.effects?.find((f) => f.id === owner.id);
  if (!clip || !src) return 0;
  const sel = new Set(selectedIds(s, 'clip'));
  const clips = s.clips.map((c) => {
    if (!c.effects?.length || (scope === 'track' && c.track !== clip.track) || (scope === 'selected' && !sel.has(c.id))) return c;
    let changed = false;
    const effects = c.effects.map((f) => {
      if (f.id === src.id || f.moduleId !== src.moduleId || f.base) return f;
      changed = true;
      n++;
      return set(f);
    });
    return changed ? { ...c, effects } : c;
  });
  if (n) useStore.setState({ clips });
  return n;
}

/** 特效參數的右鍵選單：「套用到相同特效」→ 同軌 / 整個專案 / 選取的 */
export function fxParamMenu(owner: FxOwner, name: string, value: () => ParamValue): MenuItem[] {
  const run = (scope: 'track' | 'all' | 'selected') => () => {
    const n = applyFxParam(owner, name, value(), scope);
    toast(n ? $t('已套用到 {0} 個特效', n) : $t('沒有相同的特效'), n ? undefined : 'error');
  };
  return [{
    label: $t('套用到相同特效'),
    submenu: [
      { label: $t('同軌'), action: run('track') },
      { label: $t('整個專案'), action: run('all') },
      { separator: true },
      { label: owner.kind === 'fx' ? $t('選取的特效') : $t('選取的片段'), action: run('selected') },
    ],
  }];
}

// ───────── 整個特效：複製 / 貼上 / 套用 ─────────

/** 特效的「設定」：種類、參數、參數的關鍵影格、音訊反應；特效方塊另外帶疊加的特效與觸發（遮罩、時間位置不算） */
type FxSetting = { moduleId: string; params: ParamValues; keys: Record<string, Keyframe[]>; audio?: Record<string, AudioDrive>; stack?: ClipFx[]; trigger?: FxTrigger; trDur?: number };
type FxLikeItem = { moduleId: string; params: ParamValues; keys?: Record<string, Keyframe[]>; audio?: Record<string, AudioDrive>; stack?: ClipFx[]; trigger?: FxTrigger; trDur?: number };

const isMaskKey = (k: string) => k.startsWith('mask.');
function settingOf(f: FxLikeItem): FxSetting {
  const keys = Object.fromEntries(Object.entries(f.keys ?? {}).filter(([k]) => !isMaskKey(k)));
  return structuredClone({ moduleId: f.moduleId, params: f.params, keys, audio: f.audio, stack: f.stack, trigger: f.trigger, trDur: f.trDur });
}
/** 套上設定：遮罩與遮罩的關鍵影格保留目標自己的；疊加 / 觸發只有特效方塊有 */
function withSetting<T extends FxLikeItem>(f: T, st: FxSetting, block: boolean): T {
  const s = structuredClone(st);
  const maskKeys = Object.fromEntries(Object.entries(f.keys ?? {}).filter(([k]) => isMaskKey(k)));
  const out: T = { ...f, moduleId: s.moduleId, params: s.params, keys: { ...maskKeys, ...s.keys }, audio: s.audio };
  if (block) {
    out.stack = s.stack?.map((x) => ({ ...x, id: uid() }));
    out.trigger = s.trigger;
    out.trDur = s.trDur;
  }
  return out;
}

function ownerFx(owner: FxOwner): FxLikeItem | undefined {
  const s = useStore.getState();
  if (owner.kind === 'fx') return s.effects.find((f) => f.id === owner.id);
  return s.clips.find((c) => c.id === owner.clipId)?.effects?.find((f) => f.id === owner.id);
}

let fxClipboard: FxSetting | null = null;

export function copyFx(owner: FxOwner): boolean {
  const f = ownerFx(owner);
  if (!f) return false;
  fxClipboard = settingOf(f);
  toast($t('已複製特效'));
  return true;
}

export function pasteFx(owner: FxOwner): boolean {
  if (!fxClipboard) return false;
  const s = useStore.getState();
  const st = fxClipboard;
  if (owner.kind === 'fx') {
    if (!s.effects.some((f) => f.id === owner.id)) return false;
    useStore.setState({ effects: s.effects.map((f) => (f.id === owner.id ? withSetting(f, st, true) : f)) });
  } else {
    const c = s.clips.find((x) => x.id === owner.clipId);
    if (!c?.effects?.some((f) => f.id === owner.id)) return false;
    useStore.setState({ clips: s.clips.map((x) => (x.id === c.id ? { ...x, effects: x.effects!.map((f) => (f.id === owner.id ? withSetting(f, st, false) : f)) } : x)) });
  }
  return true;
}
export const hasFxClipboard = () => !!fxClipboard;

/**
 * 整個特效套用到其他地方：
 * - 特效軌的特效：same = 同軌的相同特效；other = 同軌的其他特效換成這個；all = 兩者；selected = 選取的特效
 * - 片段特效：same = 同一條影片軌上已經有這個特效的片段；other = 還沒有的片段（加上去）；all = 兩者；selected = 選取的片段
 * 回傳改了幾個特效 / 片段
 */
export type FxScope = 'same' | 'other' | 'all' | 'selected';
export function applyFxToTrack(owner: FxOwner, scope: FxScope): number {
  const s = useStore.getState();
  const src = ownerFx(owner);
  if (!src) return 0;
  const st = settingOf(src);
  const same = scope !== 'other', other = scope !== 'same';
  let n = 0;
  if (owner.kind === 'fx') {
    const track = (src as FxItem).track;
    const sel = new Set(selectedIds(s, 'effect'));
    const effects = s.effects.map((f) => {
      if (f.id === owner.id) return f;
      const hit = scope === 'selected' ? sel.has(f.id) : f.track === track && (f.moduleId === st.moduleId ? same : other);
      if (!hit) return f;
      n++;
      return withSetting(f, st, true);
    });
    if (n) useStore.setState({ effects });
    return n;
  }
  const clip = s.clips.find((c) => c.id === owner.clipId)!;
  const sel = new Set(selectedIds(s, 'clip'));
  const clips = s.clips.map((c) => {
    if (c.id === clip.id) return c;
    if (scope === 'selected' ? !sel.has(c.id) : c.track !== clip.track) return c;
    const list = c.effects ?? [];
    if (list.some((f) => !f.base && f.moduleId === st.moduleId)) {
      if (!same) return c;
      n++;
      return { ...c, effects: list.map((f) => (!f.base && f.moduleId === st.moduleId ? withSetting(f, st, false) : f)) };
    }
    if (!other) return c;
    n++;
    // 加在片段本身的遮罩前面（遮罩一律最後套用）
    const add: ClipFx = { id: uid(), moduleId: st.moduleId, params: structuredClone(st.params), keys: structuredClone(st.keys), audio: structuredClone(st.audio) };
    const at = list.findIndex((f) => f.base);
    return { ...c, effects: at < 0 ? [...list, add] : [...list.slice(0, at), add, ...list.slice(at)] };
  });
  if (n) useStore.setState({ clips });
  return n;
}

export function runFxApply(owner: FxOwner, scope: FxScope) {
  const n = applyFxToTrack(owner, scope);
  toast(n ? (owner.kind === 'fx' ? $t('已套用到 {0} 個特效', n) : $t('已套用到 {0} 個片段', n)) : $t('沒有可以套用的地方'), n ? undefined : 'error');
}
/** 套用的選項（選單與屬性面板最下面的按鈕共用） */
export const fxScopeLabels = (owner: FxOwner): Record<FxScope, string> =>
  owner.kind === 'cfx'
    ? { same: $t('已有這個特效的片段'), other: $t('還沒有這個特效的片段'), all: $t('全部片段'), selected: $t('選取的片段') }
    : { same: $t('相同特效'), other: $t('其他特效'), all: $t('全部特效'), selected: $t('選取的特效') };

/** 特效標題列的右鍵選單：複製 / 貼上 / 套用到同軌 / 套用到選取的 */
export function fxTitleMenu(owner: FxOwner): MenuItem[] {
  const run = (scope: FxScope) => () => runFxApply(owner, scope);
  const L = fxScopeLabels(owner);
  return [
    { label: $t('複製特效'), action: () => copyFx(owner) },
    { label: $t('貼上特效'), action: hasFxClipboard() ? () => pasteFx(owner) : undefined },
    { separator: true },
    {
      label: $t('套用到同軌'),
      submenu: [
        { label: L.same, action: run('same') },
        { label: L.other, action: run('other') },
        { separator: true },
        { label: L.all, action: run('all') },
      ],
    },
    { label: owner.kind === 'fx' ? $t('套用到選取的特效') : $t('套用到選取的片段'), action: run('selected') },
  ];
}

// ───────── 片段本身的屬性（運動、不透明度、畫面、片段特效） ─────────

/** 屬性分組：運動 = 位置 / 縮放 / 旋轉；不透明度 = 不透明度 + 混合模式；畫面 = 填滿模式 / 翻轉；特效 = 片段特效（含片段遮罩） */
export type ClipGroup = 'motion' | 'opacity' | 'frame' | 'effects';
const GROUP_PROPS: Partial<Record<ClipGroup, AnimProp[]>> = { motion: ['x', 'y', 'scaleX', 'scaleY', 'rotation'], opacity: ['opacity'] };
const ALL_GROUPS: ClipGroup[] = ['motion', 'opacity', 'frame', 'effects'];
/** 套用到哪裡：同軌的同類片段 / 選取的片段 */
export type ClipTarget = 'track' | 'selected';

/** 來源片段的屬性 → 要寫到目標上的 patch（關鍵影格一起帶，時間照原樣） */
function groupPatch(src: Clip, dst: Clip, groups: ClipGroup[]): Partial<Clip> {
  const p: Partial<Clip> = {};
  const transform = { ...dst.transform };
  const keys = { ...dst.keys };
  for (const g of groups) {
    for (const prop of GROUP_PROPS[g] ?? []) {
      transform[prop] = src.transform[prop];
      if (src.keys[prop]?.length) keys[prop] = structuredClone(src.keys[prop]);
      else delete keys[prop];
    }
    if (g === 'motion') p.scaleUnlinked = src.scaleUnlinked;
    if (g === 'opacity') p.blend = src.blend;
    if (g === 'frame') { p.fit = src.fit; p.flipX = src.flipX; }
    if (g === 'effects') p.effects = (src.effects ?? []).map((f) => ({ ...structuredClone(f), id: uid() }));
  }
  if (groups.some((g) => GROUP_PROPS[g])) { p.transform = transform; p.keys = keys; }
  return p;
}

/** 目標片段：同一條影片軌上的同類片段（文字只對文字、素材只對素材），或選取的片段 */
function targetsOf(s: S, src: Clip, target: ClipTarget) {
  if (target === 'selected') {
    const sel = new Set(selectedIds(s, 'clip'));
    return s.clips.filter((c) => c.id !== src.id && sel.has(c.id));
  }
  return s.clips.filter((c) => c.id !== src.id && c.track === src.track && !!c.text === !!src.text);
}

function patchClips(patches: Map<string, Partial<Clip>>) {
  if (!patches.size) return 0;
  useStore.setState({ clips: useStore.getState().clips.map((c) => (patches.has(c.id) ? { ...c, ...patches.get(c.id) } : c)) });
  return patches.size;
}

/** 屬性分組套用到其他片段 */
export function applyClipGroups(clipId: string, groups: ClipGroup[] = ALL_GROUPS, target: ClipTarget = 'track'): number {
  const s = useStore.getState();
  const src = s.clips.find((c) => c.id === clipId);
  if (!src) return 0;
  return patchClips(new Map(targetsOf(s, src, target).map((c) => [c.id, groupPatch(src, c, groups)])));
}

/**
 * 單一屬性套用到其他片段：
 * withKeys = false → 播放頭位置的值變成固定值（目標上這個屬性的關鍵影格移除）；true → 連關鍵影格一起
 */
export function applyClipProps(clipId: string, props: AnimProp[], local: number, withKeys: boolean, target: ClipTarget = 'track'): number {
  const s = useStore.getState();
  const src = s.clips.find((c) => c.id === clipId);
  if (!src) return 0;
  const cur = clipTransformAt(src, local);
  const patches = new Map<string, Partial<Clip>>();
  for (const c of targetsOf(s, src, target)) {
    const transform = { ...c.transform };
    const keys = { ...c.keys };
    for (const prop of props) {
      transform[prop] = withKeys ? src.transform[prop] : cur[prop];
      if (withKeys && src.keys[prop]?.length) keys[prop] = structuredClone(src.keys[prop]);
      else delete keys[prop];
    }
    patches.set(c.id, { transform, keys });
  }
  return patchClips(patches);
}

const clipDone = (target: ClipTarget) => (n: number) =>
  toast(n ? $t('已套用到 {0} 個片段', n) : target === 'track' ? $t('同軌沒有其他片段') : $t('沒有選取其他片段'), n ? undefined : 'error');

/** 屬性（數值欄）右鍵：套用到同軌 / 選取的片段 → 目前的值 / 含關鍵影格 */
export function clipPropMenu(clipId: string, props: AnimProp[], local: () => number): MenuItem[] {
  const sub = (target: ClipTarget): MenuItem[] => [
    { label: $t('目前的值'), action: () => clipDone(target)(applyClipProps(clipId, props, local(), false, target)) },
    { label: $t('含關鍵影格'), action: () => clipDone(target)(applyClipProps(clipId, props, local(), true, target)) },
  ];
  return [
    { label: $t('套用到同軌'), submenu: sub('track') },
    { label: $t('套用到選取的片段'), submenu: sub('selected') },
  ];
}

// 複製 / 貼上屬性：記住來源片段與複製了哪幾組
let attrClipboard: { src: Clip; groups: ClipGroup[] } | null = null;
export function copyClipAttrs(clipId: string, groups: ClipGroup[] = ALL_GROUPS) {
  const c = useStore.getState().clips.find((x) => x.id === clipId);
  if (!c) return;
  attrClipboard = { src: structuredClone(c), groups };
  toast($t('已複製屬性'));
}
/** 貼到所有選取的片段（沒有多選就貼到這個片段）；only = 只貼其中一組 */
export function pasteClipAttrs(clipId: string, only?: ClipGroup): number {
  const cb = attrClipboard;
  if (!cb) return 0;
  const groups = only ? cb.groups.filter((g) => g === only) : cb.groups;
  if (!groups.length) return 0;
  const s = useStore.getState();
  const ids = new Set(selectedIds(s, 'clip'));
  if (!ids.size) ids.add(clipId);
  const n = patchClips(new Map(s.clips.filter((c) => ids.has(c.id) && c.id !== cb.src.id).map((c) => [c.id, groupPatch(cb.src, c, groups)])));
  if (n) toast($t('已貼上到 {0} 個片段', n));
  return n;
}
const canPaste = (group?: ClipGroup) => !!attrClipboard && (!group || attrClipboard.groups.includes(group));

/** 區塊標題右鍵（運動、不透明度、畫面）：複製 / 貼上這一組、套用到同軌 / 選取的片段 */
export function clipGroupMenu(clipId: string, group: ClipGroup): MenuItem[] {
  return [
    { label: $t('複製'), action: () => copyClipAttrs(clipId, [group]) },
    { label: $t('貼上'), action: canPaste(group) ? () => pasteClipAttrs(clipId, group) : undefined },
    { separator: true },
    { label: $t('套用到同軌'), action: () => clipDone('track')(applyClipGroups(clipId, [group], 'track')) },
    { label: $t('套用到選取的片段'), action: () => clipDone('selected')(applyClipGroups(clipId, [group], 'selected')) },
  ];
}

/** 片段標題右鍵：複製 / 貼上屬性、全部屬性套用到同軌 / 選取的片段 */
export function clipTitleMenu(clipId: string): MenuItem[] {
  return [
    { label: $t('複製屬性'), action: () => copyClipAttrs(clipId) },
    { label: $t('貼上屬性'), action: canPaste() ? () => pasteClipAttrs(clipId) : undefined },
    { separator: true },
    { label: $t('套用到同軌'), action: () => clipDone('track')(applyClipGroups(clipId, ALL_GROUPS, 'track')) },
    { label: $t('套用到選取的片段'), action: () => clipDone('selected')(applyClipGroups(clipId, ALL_GROUPS, 'selected')) },
  ];
}
