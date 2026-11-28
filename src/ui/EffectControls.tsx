import { EasePresetsMini } from './CurveEdit';
import { snapActive } from './snapKey';
import { $t } from '../i18n';
import { flushSync } from 'react-dom';
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { useStore, type Clip, type ClipFx, type FxItem } from '../store';
import {
  ANIM_PROPS, EASE_PRESETS, easeId, evalKeys, keyAt, newKey, sortKeys, upsertKey,
  type AnimProp, type Bez, type Ease, type Keyframe,
} from '../engine/keyframes';
import { clipTransformAt } from '../engine/transform';
import { isNumeric, parseParams, parsePointCh, pointCh, resolveParams } from '../engine/params';
import { DEFAULT_MASK, MASK_PROPS, maskKey } from '../engine/mask';
import { DragNumber } from './DragNumber';
import { setScrubbing } from '../engine/audio';
import { fps, rulerLabel, rulerSteps, snapFrame, tc } from '../engine/rulerTicks';
import { openMenu, useKeySel, useLayout, useTrimView, type KeyRef, type MenuItem } from './uiStore';
import { beatHits, HIT_MIN, normalizeHits, overwriteHits, type BeatEvery, type FxTiming, type Hit } from '../engine/trigger';
import { beatSnapPoints } from './beatGrid';
import { AudioLines, ChevronDown, ChevronLeft, ChevronRight, Diamond, RotateCcw, Search, Timer, X } from 'lucide-react';
import { Seg } from './Toggle';
import { marqueeClamp } from './marqueeClamp';
import { ViewScrollbar, wheelViewAction } from './wheelView';
import { dragPan } from './middlePan';

// ───────────────────────── 資料介面 ─────────────────────────

/** 一個可動畫的數值屬性 */
export interface Channel {
  id: string;
  label: string;
  value: number;
  keys: Keyframe[];
  def: number;
  step?: number;
  min?: number;
  max?: number;
  suffix?: string;
  display?: number;
  /** 等比例連動：改這個值時，partner 依同樣的比例跟著變（各自保留正負號）；開 / 關動畫也一起 */
  partner?: { id: string; value: number; keys: Keyframe[] };
  /** 右鍵選單最後多加的項目（名稱與數值欄位都適用，例如「套用到相同特效」） */
  menu?: MenuItem[];
  /** 名稱後面的小圖示（例如跟隨目標） */
  icon?: React.ReactNode;
  /** 音訊反應：啟用時在參數下方顯示設定列 */
  drive?: { on: boolean; toggle: () => void; rows: { label: string; node: React.ReactNode }[] };
}

/** 等比例連動時，partner 的新值：大小跟著比例變、保留原本的正負號 */
function partnerValue(from: number, to: number, partner: number) {
  const sign = partner < 0 ? -1 : 1;
  if (Math.abs(from) < 1e-9) return sign * Math.abs(to);
  return partner * Math.abs(to / from);
}

/** 擁有關鍵影格的對象（片段 / 特效） */
export interface Host {
  owner: string;
  start: number;
  duration: number;
  setKeys(ch: string, list: Keyframe[] | null, base?: number): void;
  setBase(ch: string, v: number): void;
}

export function clipHost(clipId: string): Host | null {
  const c = useStore.getState().clips.find((x) => x.id === clipId);
  if (!c) return null;
  return {
    owner: `clip:${c.id}`,
    start: c.start,
    duration: c.duration,
    setKeys(ch, list, base) {
      const cur = useStore.getState().clips.find((x) => x.id === clipId);
      if (!cur) return;
      if (ch === REMAP_CH) return setCurve(cur, list?.length ? sortKeys(list) : [newKey(0, base ?? 0, [0, 0, 1, 1])]);
      const cf = parseCfx(ch);
      if (cf) {
        const f = cur.effects?.find((x) => x.id === cf.fxId);
        if (!f) return;
        const keys = { ...(f.keys ?? {}) };
        if (list?.length) keys[cf.ch] = sortKeys(list);
        else delete keys[cf.ch];
        const patch: Partial<ClipFx> = { keys };
        if (!list?.length && base !== undefined) Object.assign(patch, fxBasePatch(f, cf.ch, base));
        return useStore.getState().updateClipFx(clipId, f.id, patch);
      }
      const keys = { ...cur.keys };
      if (list?.length) keys[ch as AnimProp] = sortKeys(list);
      else delete keys[ch as AnimProp];
      const patch: Partial<Clip> = { keys };
      if (!list?.length && base !== undefined) patch.transform = { ...cur.transform, [ch]: base };
      useStore.getState().updateClip(clipId, patch);
    },
    setBase(ch, v) {
      const cur = useStore.getState().clips.find((x) => x.id === clipId);
      if (!cur) return;
      if (ch === REMAP_CH) return setCurve(cur, [newKey(0, v, [0, 0, 1, 1])]);
      const cf = parseCfx(ch);
      if (cf) {
        const f = cur.effects?.find((x) => x.id === cf.fxId);
        if (f) useStore.getState().updateClipFx(clipId, f.id, fxBasePatch(f, cf.ch, v));
        return;
      }
      useStore.getState().updateClip(clipId, { transform: { ...cur.transform, [ch]: v } });
    },
  };
}

/** 曲線變速的「素材時間」channel（存在 clip.remap.keys；沒有 key 時至少留一個 = 定格） */
export const REMAP_CH = 'remap.time';
const setCurve = (c: Clip, keys: Keyframe[]) => useStore.getState().updateClip(c.id, { remap: { ...c.remap, keys } });

/** 曲線變速的 channel：素材時間（秒，相對片段的 in） */
export function curveChannel(c: Clip, media: { duration: number } | undefined, local: number): Channel {
  const keys = c.remap.keys ?? [];
  return {
    id: REMAP_CH,
    label: $t('素材時間'),
    value: keys.length ? evalKeys(keys, local) : 0,
    keys,
    def: 0,
    step: 0.01,
    min: 0,
    max: media ? Math.max(0, media.duration - c.in) : undefined,
    suffix: 's',
  };
}

export function fxHost(fxId: string): Host | null {
  const f = useStore.getState().effects.find((x) => x.id === fxId);
  if (!f) return null;
  return {
    owner: `effect:${f.id}`,
    start: f.start,
    duration: f.duration,
    setKeys(ch, list, base) {
      const cur = useStore.getState().effects.find((x) => x.id === fxId);
      if (!cur) return;
      // 疊加的特效：channel 跟片段特效一樣是 cfx:<id>:<參數>
      const cf = parseCfx(ch);
      if (cf) {
        const f = cur.stack?.find((x) => x.id === cf.fxId);
        if (!f) return;
        const keys = { ...(f.keys ?? {}) };
        if (list?.length) keys[cf.ch] = sortKeys(list);
        else delete keys[cf.ch];
        const patch: Partial<ClipFx> = { keys };
        if (!list?.length && base !== undefined) Object.assign(patch, fxBasePatch(f, cf.ch, base));
        return updateStackFx(fxId, f.id, patch);
      }
      const keys = { ...(cur.keys ?? {}) };
      if (list?.length) keys[ch] = sortKeys(list);
      else delete keys[ch];
      const patch: Partial<FxItem> = { keys };
      if (!list?.length && base !== undefined) Object.assign(patch, fxBasePatch(cur, ch, base));
      useStore.getState().updateEffect(fxId, patch);
    },
    setBase(ch, v) {
      const cur = useStore.getState().effects.find((x) => x.id === fxId);
      if (!cur) return;
      const cf = parseCfx(ch);
      if (cf) {
        const f = cur.stack?.find((x) => x.id === cf.fxId);
        if (f) updateStackFx(fxId, f.id, fxBasePatch(f, cf.ch, v));
        return;
      }
      useStore.getState().updateEffect(fxId, fxBasePatch(cur, ch, v));
    },
  };
}

/** 特效的固定值：一般參數存在 params，遮罩（mask.x…）存在 mask，point 的一軸（center.x）存在陣列裡 */
export function fxBasePatch<T extends { moduleId: string; params: FxItem['params']; mask?: FxItem['mask'] }>(f: T, ch: string, v: number): Partial<T> {
  if (ch.startsWith('mask.')) return { mask: { ...DEFAULT_MASK, ...f.mask, [ch.slice(5)]: v } } as Partial<T>;
  const pc = parsePointCh(ch);
  if (pc) {
    const mod = useStore.getState().modules.find((m) => m.id === f.moduleId);
    const defs = mod ? parseParams(mod.code) : [];
    const cur = [...(resolveParams(defs, f.params)[pc.name] as number[] | undefined ?? [0.5, 0.5])];
    cur[pc.axis] = v;
    return { params: { ...f.params, [pc.name]: cur } } as Partial<T>;
  }
  return { params: { ...f.params, [ch]: v } } as Partial<T>;
}

/** 特效遮罩的動畫屬性 */
export function maskChannels(f: FxItem, local: number): Channel[] {
  const m = { ...DEFAULT_MASK, ...f.mask };
  return MASK_PROPS.map(({ prop, label, step, suffix, display, min, max }) => {
    const keys = f.keys?.[maskKey(prop)] ?? [];
    const fmt = useStore.getState().format;
    const disp = prop === 'x' ? fmt.w : prop === 'y' ? fmt.h : display;
    return { id: maskKey(prop), label, value: keys.length ? evalKeys(keys, local) : m[prop], keys, def: DEFAULT_MASK[prop], step, suffix, display: disp, min, max };
  });
}

/** 片段 / 特效以外的屬性面板（動畫）：自己提供 host、關鍵影格（片段內秒數）、全部的關鍵影格 */
export interface HostKind {
  host(id: string): Host | null;
  keys(id: string, ch: string): Keyframe[];
  all(id: string): KeyRef[];
}
const hostKinds: Record<string, HostKind> = {};
export const registerHostKind = (type: string, kind: HostKind) => { hostKinds[type] = kind; };

export function hostFor(owner: string) {
  const [type, id] = [owner.slice(0, owner.indexOf(':')), owner.slice(owner.indexOf(':') + 1)];
  return type === 'clip' ? clipHost(id) : type === 'effect' ? fxHost(id) : hostKinds[type]?.host(id) ?? null;
}

/** 片段特效的 channel id：`cfx:<特效 id>:<參數 / mask.x>` */
export const cfxCh = (fxId: string, ch: string) => `cfx:${fxId}:${ch}`;
function parseCfx(ch: string): { fxId: string; ch: string } | null {
  if (!ch.startsWith('cfx:')) return null;
  const i = ch.indexOf(':', 4);
  return { fxId: ch.slice(4, i), ch: ch.slice(i + 1) };
}

/** 給 channel 加上片段特效的前綴 */
export function cfxChannels(fxId: string, chs: Channel[]): Channel[] {
  return chs.map((c) => ({ ...c, id: cfxCh(fxId, c.id) }));
}

function currentKeys(owner: string, ch: string): Keyframe[] {
  const s = useStore.getState();
  const [type, id] = [owner.slice(0, owner.indexOf(':')), owner.slice(owner.indexOf(':') + 1)];
  if (type === 'clip') {
    const c = s.clips.find((x) => x.id === id);
    if (ch === REMAP_CH) return c?.remap.keys ?? [];
    const cf = parseCfx(ch);
    if (cf) return c?.effects?.find((f) => f.id === cf.fxId)?.keys?.[cf.ch] ?? [];
    return c?.keys[ch as AnimProp] ?? [];
  }
  if (hostKinds[type]) return hostKinds[type].keys(id, ch);
  const fx = s.effects.find((f) => f.id === id);
  const cf = parseCfx(ch);
  if (cf) return fx?.stack?.find((f) => f.id === cf.fxId)?.keys?.[cf.ch] ?? [];
  return fx?.keys?.[ch] ?? [];
}

/** 改特效方塊裡疊加的某個特效 */
export function updateStackFx(fxId: string, sid: string, patch: Partial<ClipFx>) {
  const cur = useStore.getState().effects.find((x) => x.id === fxId);
  if (cur?.stack) useStore.getState().updateEffect(fxId, { stack: cur.stack.map((f) => (f.id === sid ? { ...f, ...patch } : f)) });
}

/** 片段的動畫屬性 */
export function clipChannels(c: Clip, local: number): Channel[] {
  const cur = clipTransformAt(c, local);
  const pct = (p: string) => p === 'scaleX' || p === 'scaleY' || p === 'opacity';
  const other = { scaleX: 'scaleY', scaleY: 'scaleX' } as Record<string, AnimProp | undefined>;
  return ANIM_PROPS.map(({ prop, label, step, suffix, min, max }) => {
    const o = other[prop];
    return {
      id: prop,
      label,
      value: cur[prop],
      keys: c.keys[prop] ?? [],
      def: pct(prop) ? 1 : 0,
      step: pct(prop) ? 0.005 : step,
      min,
      max,
      // 位置用像素顯示（畫面 1080×1920），縮放 / 不透明度用 %
      suffix: pct(prop) ? '%' : prop === 'x' || prop === 'y' ? ' px' : suffix,
      display: pct(prop) ? 100 : prop === 'x' ? useStore.getState().format.w : prop === 'y' ? useStore.getState().format.h : 1,
      ...(o && !c.scaleUnlinked ? { partner: { id: o, value: cur[o], keys: c.keys[o] ?? [] } } : {}),
    };
  });
}

/** 特效的動畫屬性（數值型參數、point 的 X / Y 可以打 key） */
export function fxChannels(f: FxItem, code: string, local: number): Channel[] {
  const defs = parseParams(code);
  const base = resolveParams(defs, f.params);
  const fmt = useStore.getState().format;
  const out: Channel[] = [];
  for (const d of defs) {
    if (isNumeric(d)) {
      const keys = f.keys?.[d.name] ?? [];
      out.push({
        id: d.name,
        label: $t(d.label),
        value: keys.length ? evalKeys(keys, local) : Number(base[d.name]),
        keys,
        def: Number(d.def),
        step: d.type === 'int' ? 1 : niceStep((d.max - d.min) / 200),
      });
    } else if (d.type === 'point') {
      // 位置用像素顯示（跟遮罩、片段位置一樣）
      for (const axis of [0, 1] as const) {
        const id = pointCh(d.name, axis);
        const keys = f.keys?.[id] ?? [];
        out.push({
          id,
          label: `${$t(d.label)} ${axis ? 'Y' : 'X'}`,
          value: keys.length ? evalKeys(keys, local) : (base[d.name] as number[])[axis],
          keys,
          def: (d.def as number[])[axis],
          step: 0.001,
          suffix: ' px',
          display: axis ? fmt.h : fmt.w,
        });
      }
    }
  }
  return out;
}

function niceStep(x: number) {
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(x, 1e-6))));
  const n = x / p;
  return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * p;
}

/** 緩動作用的區段：選取的 key → 下一個；如果是最後一個，就用前一段 */
function targetSegment(keys: Keyframe[], selId: string | undefined, lc: number): number {
  if (keys.length < 2) return -1;
  const i = selId ? keys.findIndex((k) => k.id === selId) : -1;
  if (i >= 0) return i < keys.length - 1 ? i : i - 1;
  for (let j = 0; j < keys.length - 1; j++) if (lc >= keys[j].t && lc < keys[j + 1].t) return j;
  return lc < keys[0].t ? 0 : keys.length - 2;
}

function setSegmentEase(host: Host, ch: string, seg: number, ease: Ease) {
  const list = currentKeys(host.owner, ch);
  if (seg < 0 || seg >= list.length - 1) return;
  host.setKeys(ch, list.map((k, i) => (i === seg ? { ...k, ease } : k)));
}

function listen(onMove: (ev: PointerEvent) => void, onUp?: () => void) {
  const up = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', up);
    onUp?.();
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', up);
}

// ───────────────────────── 關鍵影格選取 / 編輯（跟時間軸一樣：多選、框選、整組移動、快捷鍵） ─────────────────────────

/** 選取關鍵影格；primary 為主選取 */
function selectKeys(owner: string, keys: KeyRef[], primary?: KeyRef) {
  const p = primary ?? keys[keys.length - 1];
  useKeySel.setState({ owner, keys, sel: p ? { owner, ...p } : null, focus: true, channel: p?.ch ?? null });
}
const clearKeys = () => useKeySel.setState({ owner: null, keys: [], sel: null });
const sameKey = (a: KeyRef, b: KeyRef) => a.ch === b.ch && a.id === b.id;

/** 目前屬性面板顯示的對象（片段 / 特效） */
function currentHost(): Host | null {
  const s = useStore.getState().selection;
  if (!s) return null;
  return hostFor(`${s.type}:${s.id}`);
}

/** 快捷鍵要不要作用在關鍵影格上 */
export const keysFocused = () => useKeySel.getState().focus && !!currentHost();

// 點到屬性面板以外的地方 → 快捷鍵回到時間軸
if (typeof window !== 'undefined') {
  window.addEventListener(
    'pointerdown',
    (e) => {
      const t = e.target as HTMLElement;
      if (!t.closest?.('.ec .ec-right, .ec .ec-graph')) useKeySel.setState({ focus: false });
    },
    true,
  );
}

/** Delete 鍵：刪除選取的關鍵影格 */
export function deleteSelectedKey(): boolean {
  const { owner, keys } = useKeySel.getState();
  if (!owner || !keys.length) return false;
  const host = hostFor(owner);
  if (!host) return false;
  let done = false;
  for (const ch of new Set(keys.map((k) => k.ch))) {
    const list = currentKeys(owner, ch);
    const rest = list.filter((x) => !keys.some((k) => k.ch === ch && k.id === x.id));
    if (rest.length === list.length) continue;
    const last = list.find((x) => !rest.includes(x))!;
    host.setKeys(ch, rest, rest.length ? undefined : last.v);
    done = true;
  }
  clearKeys();
  return done;
}

let keyClipboard: { ch: string; t: number; v: number; ease: Ease }[] = [];

export function copyKeys(): boolean {
  const { owner, keys } = useKeySel.getState();
  if (!owner || !keys.length) return false;
  const list = keys
    .map((k) => ({ ch: k.ch, key: currentKeys(owner, k.ch).find((x) => x.id === k.id) }))
    .filter((x): x is { ch: string; key: Keyframe } => !!x.key);
  if (!list.length) return false;
  const t0 = Math.min(...list.map((x) => x.key.t));
  keyClipboard = list.map((x) => ({ ch: x.ch, t: x.key.t - t0, v: x.key.v, ease: x.key.ease }));
  return true;
}

/** 屬性名稱選單：只複製該屬性的關鍵影格。 */
function copyChannelKeys(owner: string, ch: string): boolean {
  const keys = currentKeys(owner, ch).map((k) => ({ ch, id: k.id }));
  if (!keys.length) return false;
  selectKeys(owner, keys);
  return copyKeys();
}

/** 屬性名稱選單：將單一來源屬性貼到指定目標屬性，可跨片段。 */
function pasteChannelKeys(host: Host, ch: string): boolean {
  if (!keyClipboard.length || keyClipboard.some((k) => k.ch !== keyClipboard[0].ch)) return false;
  const lc = Math.min(host.duration, Math.max(0, useStore.getState().time - host.start));
  let list = currentKeys(host.owner, ch);
  const added: KeyRef[] = [];
  for (const k of keyClipboard) {
    const t = Math.min(host.duration, lc + k.t);
    list = upsertKey(list, t, k.v).map((x) => (Math.abs(x.t - t) < 1 / 120 ? { ...x, ease: k.ease } : x));
    const hit = keyAt(list, t);
    if (hit) added.push({ ch, id: hit.id });
  }
  host.setKeys(ch, list);
  selectKeys(host.owner, added);
  return true;
}

/** 貼上到播放頭（同名屬性） */
export function pasteKeys(): boolean {
  const host = currentHost();
  if (!host || !keyClipboard.length) return false;
  const lc = Math.min(host.duration, Math.max(0, useStore.getState().time - host.start));
  const added: KeyRef[] = [];
  for (const ch of new Set(keyClipboard.map((k) => k.ch))) {
    let list = currentKeys(host.owner, ch);
    for (const k of keyClipboard.filter((x) => x.ch === ch)) {
      const t = Math.min(host.duration, lc + k.t);
      list = upsertKey(list, t, k.v).map((x) => (Math.abs(x.t - t) < 1 / 120 ? { ...x, ease: k.ease } : x));
      const hit = keyAt(list, t);
      if (hit) added.push({ ch, id: hit.id });
    }
    host.setKeys(ch, list);
  }
  selectKeys(host.owner, added);
  return true;
}

export function selectAllKeys(): boolean {
  const host = currentHost();
  if (!host) return false;
  const s = useStore.getState();
  const sel = s.selection!;
  const keys: KeyRef[] = [];
  if (sel.type === 'clip') {
    const c = s.clips.find((x) => x.id === sel.id);
    for (const [ch, l] of Object.entries(c?.keys ?? {})) for (const k of l ?? []) keys.push({ ch, id: k.id });
    for (const f of c?.effects ?? []) for (const [ch, l] of Object.entries(f.keys ?? {})) for (const k of l) keys.push({ ch: cfxCh(f.id, ch), id: k.id });
  } else if (hostKinds[sel.type]) {
    keys.push(...hostKinds[sel.type].all(sel.id));
  } else {
    const f = s.effects.find((x) => x.id === sel.id);
    for (const [ch, l] of Object.entries(f?.keys ?? {})) for (const k of l) keys.push({ ch, id: k.id });
    for (const x of f?.stack ?? []) for (const [ch, l] of Object.entries(x.keys ?? {})) for (const k of l) keys.push({ ch: cfxCh(x.id, ch), id: k.id });
  }
  selectKeys(host.owner, keys);
  return true;
}

/** 選取的關鍵影格整組平移 dt（秒），不會超出片段範圍 */
function moveKeys(owner: string, keys: KeyRef[], orig: Map<string, Keyframe[]>, dt: number) {
  const host = hostFor(owner);
  if (!host) return;
  for (const [ch, list] of orig) {
    host.setKeys(ch, list.map((x) => (keys.some((k) => k.ch === ch && k.id === x.id) ? { ...x, t: x.t + dt } : x)));
  }
}

function snapshot(owner: string, keys: KeyRef[]) {
  const orig = new Map<string, Keyframe[]>();
  for (const ch of new Set(keys.map((k) => k.ch))) orig.set(ch, currentKeys(owner, ch));
  const ts: number[] = [];
  for (const [ch, l] of orig) for (const x of l) if (keys.some((k) => k.ch === ch && k.id === x.id)) ts.push(x.t);
  return { orig, min: Math.min(...ts), max: Math.max(...ts) };
}

/** Alt+← / →：選取的關鍵影格移動一格 */
export function nudgeKeys(dt: number): boolean {
  const { owner, keys } = useKeySel.getState();
  const host = owner ? hostFor(owner) : null;
  if (!owner || !host || !keys.length) return false;
  const { orig, min, max } = snapshot(owner, keys);
  const d = Math.max(-min, Math.min(host.duration - max, dt));
  moveKeys(owner, keys, orig, d);
  return true;
}

// ───────────────────────── 效果控制面板 ─────────────────────────

/** 這個屬性改過了嗎：有關鍵影格、音訊反應開著，或固定值不是預設值（沒有關鍵影格時 value 就是存的值） */
const edited = (ch: Channel) => ch.keys.length > 0 || !!ch.drive?.on || Math.abs(ch.value - ch.def) > 1e-6;

/**
 * 屬性面板的篩選：keys = 只留有關鍵影格的屬性、edited = 只留改過的屬性（不能動畫的列看不出改過沒，不顯示）；
 * 搜尋比對屬性名稱，比到區塊標題 = 整個區塊都留下。沒有留下任何列的區塊整個不顯示
 */
function filterSections(sections: Section[], mode: 'all' | 'keys' | 'edited', query: string): Section[] {
  const q = query.trim().toLowerCase();
  const has = (s: string) => s.toLowerCase().includes(q);
  return sections.flatMap((sec) => {
    const whole = !!q && has(sec.title);
    const match = (label: string) => !q || whole || has(label);
    const channels = (sec.channels ?? []).filter((ch) => match(ch.label) && (mode === 'all' || (mode === 'keys' ? ch.keys.length > 0 : edited(ch))));
    const rows = mode === 'all' ? (sec.rows ?? []).filter((r) => match(r.label)) : [];
    const rest = mode === 'all' && (!q || whole);
    const out: Section = { ...sec, channels, rows, timing: rest ? sec.timing : undefined, footer: rest ? sec.footer : undefined };
    return channels.length || rows.length || out.timing || out.footer ? [out] : [];
  });
}

export interface Section {
  id: string;
  title: string;
  channels?: Channel[];
  /** 不可動畫的列（下拉、開關、顏色…）；sub = 上一列的子屬性（往內縮、小標題） */
  rows?: { label: string; node: React.ReactNode; sub?: boolean }[];
  /** 放在區塊最下面（例如程式碼） */
  footer?: React.ReactNode;
  onReset?: () => void;
  /** 標題列右邊的按鈕（片段特效：開關 / 上下移 / 移除） */
  actions?: React.ReactNode;
  /** 標題前面的小標籤 */
  badge?: React.ReactNode;
  dim?: boolean;
  /** 標題列右鍵選單（打開時才建立，剪貼簿狀態才會是最新的） */
  menu?: () => MenuItem[];
  /** 使用者還沒展開 / 收合過時的預設狀態 */
  defaultCollapsed?: boolean;
  /** 「作用」列（片段特效的時間範圍） */
  timing?: TimingLane;
}

/** 片段特效什麼時候作用：屬性面板的「作用」列 */
export interface TimingLane {
  /** 選取用的識別（片段 id + 特效 id） */
  id: string;
  /** 從 store 拿最新的（拖曳中 props 會舊） */
  get(): FxTiming | undefined;
  set(v: FxTiming | undefined): void;
  /** 片段在時間軸上的開頭（節拍換算用） */
  start: number;
  /** 新的一次播放預設多長（秒） */
  defD: number;
  /** 片段長度（秒） */
  len: number;
  /** 只有手動（特效方塊的「手動」觸發）：沒有模式選單，模式由別的列決定；排在區塊的其他列後面 */
  fixed?: true;
}

/** 最近一層可以上下捲的容器（屬性面板 / 編輯視窗） */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}

/** 屬性表格左欄寬度範圍（px） */
const LEFT_MIN = 240, LEFT_MAX = 640;

/** 關鍵影格時間軸的可見範圍（片段內時間，秒）；每個片段 / 特效各自記住 */
export interface View { a: number; b: number }
const viewMem = new Map<string, View>();
export function clampView(v: View, dur: number): View {
  if (!(dur > 0)) return { a: 0, b: 0 };
  const minSpan = Math.min(dur, Math.max(0.05, dur / 1000));
  const span = Math.min(dur, Math.max(minSpan, v.b - v.a));
  const a = Math.min(dur - span, Math.max(0, v.a));
  return { a, b: a + span };
}
/** 以 anchor（秒）為中心縮放 */
export function zoomView(v: View, anchor: number, factor: number, dur: number): View {
  const span = v.b - v.a;
  const next = span * factor;
  const f = span > 0 ? (anchor - v.a) / span : 0;
  return clampView({ a: anchor - f * next, b: anchor - f * next + next }, dur);
}

/** 屬性面板要捲到哪個區塊（'@top' = 最上面）：套用東西到片段後捲到新加的那一塊 */
const useEcFocus = create<{ id: string | null }>(() => ({ id: null }));
export const focusSection = (id: string) => useEcFocus.setState({ id });

/** 區塊（標題列 + 底下的屬性列）亮一下，跟時間軸新增片段時一樣 */
function flashSection(head: Element) {
  const rows: Element[] = [head];
  for (let n = head.nextElementSibling; n && !n.classList.contains('ec-section') && !n.classList.contains('add-cfx-row'); n = n.nextElementSibling) {
    if (n.classList.contains('ec-row')) rows.push(n);
  }
  for (const r of rows) {
    r.classList.remove('ec-flash');
    void (r as HTMLElement).offsetWidth;
    r.classList.add('ec-flash');
    setTimeout(() => r.classList.remove('ec-flash'), 1300);
  }
}

export function EffectControls({ host, sections, title, extra, titleMenu }: { host: Host; sections: Section[]; title?: React.ReactNode; extra?: React.ReactNode; /** 表頭（名稱）右鍵選單 */ titleMenu?: () => MenuItem[] }) {
  const time = useStore((s) => s.time);
  // 左欄固定寬度（px）：不管面板多寬、屬性分頁還是編輯視窗都一樣，面板變窄只縮右邊的時間軸
  const leftPx = useLayout((s) => s.ecLeftPx);
  const collapsed = useLayout((s) => s.ecCollapsed);
  const ksel = useKeySel();
  const fmode = useLayout((s) => s.ecFilter);
  const [query, setQuery] = useState('');
  const [fcol, setFcol] = useState<Record<string, boolean>>({});
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const rulerRef = useRef<HTMLDivElement>(null);
  const [rulerW, setRulerW] = useState(320);
  useLayoutEffect(() => {
    const el = rulerRef.current;
    if (!el) return;
    // ResizeObserver 在繪製前通知：flushSync 讓尺規跟面板同一幀更新（不然換排版時會先畫一幀舊寬度）
    const ro = new ResizeObserver(() => flushSync(() => setRulerW(el.clientWidth)));
    ro.observe(el);
    setRulerW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const tableRef = useRef<HTMLDivElement>(null);
  const S = useStore.getState();
  const dur = host.duration;
  const focus = useEcFocus((s) => s.id);
  useEffect(() => {
    const root = tableRef.current;
    if (!focus || !root || !root.isConnected) return;
    if (focus === '@top') {
      root.scrollIntoView({ block: 'start' });
      return useEcFocus.setState({ id: null });
    }
    // 收合的區塊先展開，下一次畫完再捲
    const fsec = sections.find((x) => x.id === focus);
    if (collapsed[focus] ?? fsec?.defaultCollapsed) return useLayout.getState().set({ ecCollapsed: { ...collapsed, [focus]: false } });
    const el = root.querySelector(`[data-sec="${CSS.escape(focus)}"]`);
    if (!el) return; // 區塊還沒畫出來：等下一次
    el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    flashSection(el);
    useEcFocus.setState({ id: null });
  });
  const local = time - host.start;
  const inside = local >= -1e-6 && local <= dur + 1e-6;
  const lc = Math.min(dur, Math.max(0, local));
  const mine = ksel.owner === host.owner;
  const isSel = (ch: string, id: string) => mine && ksel.keys.some((k) => k.ch === ch && k.id === id);
  const primary = mine ? ksel.sel : null;
  /** 目前在看的屬性（預覽上的路徑 / 框跟著它） */
  const curCh = mine ? ksel.channel ?? ksel.sel?.ch ?? null : null;

  const [, bump] = useState(0);
  const view = clampView(viewMem.get(host.owner) ?? { a: 0, b: dur }, dur);
  const span = view.b - view.a || 1;
  const zoomed = span < dur - 1e-6;
  const setView = (v: View) => {
    const full = clampView(v, dur);
    if (full.b - full.a >= dur - 1e-6) viewMem.delete(host.owner);
    else viewMem.set(host.owner, full);
    bump((n) => n + 1);
  };
  const viewRef = useRef({ view, dur, setView });
  viewRef.current = { view, dur, setView };

  const seek = (l: number) => S.setTime(snapFrame(host.start + Math.min(dur, Math.max(0, l))));
  /** 片段內時間對齊時間軸格線（關鍵影格、雙擊加入都用） */
  const qt = (l: number) => Math.min(dur, Math.max(0, snapFrame(host.start + l) - host.start));
  const localAt = (clientX: number) => {
    const r = rulerRef.current!.getBoundingClientRect();
    return Math.min(dur, Math.max(0, view.a + ((clientX - r.left) / r.width) * span));
  };

  // 時間軸區：Ctrl + 滾輪縮放（以游標為中心），滾輪依時間軸設定平移
  useEffect(() => {
    const el = tableRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest?.('.ec-right') || !rulerRef.current) return;
      const { view: v, dur: d, setView: sv } = viewRef.current;
      const r = rulerRef.current.getBoundingClientRect();
      const sp = v.b - v.a;
      const action = wheelViewAction(e, useLayout.getState().wheelScroll, true);
      if (action.kind === 'zoom') {
        e.preventDefault();
        const anchor = v.a + Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * sp;
        sv(zoomView(v, anchor, Math.exp(action.delta * 0.0025), d));
        return;
      }
      if (!action.delta) return;
      e.preventDefault();
      if (action.kind === 'scrollX') {
        if (sp < d - 1e-6) sv({ a: v.a + (action.delta / r.width) * sp, b: v.b + (action.delta / r.width) * sp });
      } else scrollParent(el)?.scrollBy({ top: action.delta });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    // 中鍵拖曳：左右平移顯示範圍（有放大時）、上下捲動面板
    const onPan = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (e.button !== 1 || !t.closest?.('.ec-right') || !rulerRef.current) return;
      const { view: v, dur: d, setView: sv } = viewRef.current;
      const w = rulerRef.current.getBoundingClientRect().width, sp = v.b - v.a;
      const sc = scrollParent(el), st = sc?.scrollTop ?? 0;
      dragPan(e, (dx, dy) => {
        if (sp < d - 1e-6) { const a = Math.max(0, Math.min(d - sp, v.a - (dx / w) * sp)); sv({ a, b: a + sp }); }
        if (sc) sc.scrollTop = st - dy;
      });
    };
    el.addEventListener('pointerdown', onPan, true);
    return () => { el.removeEventListener('wheel', onWheel); el.removeEventListener('pointerdown', onPan, true); };
  }, []);

  // 播放中播放頭跑出可見範圍：整頁往後翻
  const playing = useStore((s) => s.playing);
  useEffect(() => {
    if (playing && zoomed && inside && (lc > view.b || lc < view.a)) setView({ a: lc, b: lc + span });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, lc]);
  /** 只有上方的尺規可以拖播放頭 */
  const scrub = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    seek(localAt(e.clientX));
    listen(
      (ev) => {
        setScrubbing(true);
        seek(localAt(ev.clientX));
      },
      () => setScrubbing(false),
    );
  };

  /** 關鍵影格區的空白處：框選（Shift / Ctrl 加選），單擊空白 = 取消選取 */
  const startMarquee = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    useKeySel.setState({ focus: true });
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    const base = additive && mine ? ksel.keys : [];
    const x0 = e.clientX, y0 = e.clientY;
    const clamp = marqueeClamp(e.currentTarget);
    let moved = false;
    listen(
      (ev) => {
        if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return;
        moved = true;
        const [x1, y1] = clamp(ev.clientX, ev.clientY);
        const r = { x0, y0, x1, y1 };
        setMarquee(r);
        const L = Math.min(r.x0, r.x1), R = Math.max(r.x0, r.x1), T = Math.min(r.y0, r.y1), B = Math.max(r.y0, r.y1);
        const hits: KeyRef[] = [...base];
        tableRef.current!.querySelectorAll<HTMLElement>('.ec-key[data-ch]').forEach((el) => {
          const b = el.getBoundingClientRect();
          const cx = (b.left + b.right) / 2, cy = (b.top + b.bottom) / 2;
          const ref = { ch: el.dataset.ch!, id: el.dataset.id! };
          if (cx >= L && cx <= R && cy >= T && cy <= B && !hits.some((h) => sameKey(h, ref))) hits.push(ref);
        });
        selectKeys(host.owner, hits);
      },
      () => {
        setMarquee(null);
        if (!moved && !additive) clearKeys();
        useKeySel.setState({ focus: true });
      },
    );
  };

  /** 雙擊屬性的時間軸：在那裡加關鍵影格（數值 = 那個時間點目前的值） */
  const addKeyAt = (e: React.MouseEvent, ch: Channel) => {
    const t = qt(localAt(e.clientX));
    const list = currentKeys(host.owner, ch.id);
    const v = list.length ? evalKeys(list, t) : ch.value;
    const next = upsertKey(list, t, v);
    host.setKeys(ch.id, next);
    const hit = keyAt(next, t);
    if (hit) selectKeys(host.owner, [{ ch: ch.id, id: hit.id }]);
  };

  const setOne = (id: string, hasKeys: boolean, v: number) => {
    if (hasKeys) host.setKeys(id, upsertKey(currentKeys(host.owner, id), lc, v));
    else host.setBase(id, v);
  };
  const setValue = (ch: Channel, v: number) => {
    setOne(ch.id, ch.keys.length > 0, v);
    // 等比例：另一個也依比例跟著變
    if (ch.partner) setOne(ch.partner.id, ch.partner.keys.length > 0, partnerValue(ch.value, v, ch.partner.value));
  };
  const toggleAnim = (ch: Channel) => {
    const chans = [{ id: ch.id, value: ch.value, on: ch.keys.length > 0 }, ...(ch.partner ? [{ id: ch.partner.id, value: ch.partner.value, on: ch.partner.keys.length > 0 }] : [])];
    const turnOff = ch.keys.length > 0;
    for (const c of chans) {
      if (turnOff && c.on) host.setKeys(c.id, null, c.value);
      else if (!turnOff && !c.on) host.setKeys(c.id, [newKey(lc, c.value)]);
    }
    if (!turnOff && !inside) seek(lc);
  };
  const toggleKeyHere = (ch: Channel) => {
    const list = currentKeys(host.owner, ch.id);
    const hit = keyAt(list, lc);
    if (hit) {
      const rest = list.filter((k) => k !== hit);
      host.setKeys(ch.id, rest, rest.length ? undefined : hit.v);
    } else host.setKeys(ch.id, upsertKey(list, lc, ch.value));
    if (!inside) seek(lc);
  };
  const jump = (ch: Channel, dir: -1 | 1) => {
    const k = dir < 0 ? [...ch.keys].reverse().find((x) => x.t < lc - 1e-3) : ch.keys.find((x) => x.t > lc + 1e-3);
    if (k) seek(k.t);
  };

  const channelMenu = (e: React.MouseEvent, ch: Channel) => {
    e.preventDefault();
    e.stopPropagation();
    openMenu(e.clientX, e.clientY, [
      { label: $t('重設'), action: () => { host.setKeys(ch.id, null, ch.def); clearKeys(); } },
      { separator: true },
      { label: $t('全選關鍵影格'), action: ch.keys.length ? () => selectKeys(host.owner, currentKeys(host.owner, ch.id).map((k) => ({ ch: ch.id, id: k.id }))) : undefined },
      { label: $t('複製關鍵影格'), action: ch.keys.length ? () => copyChannelKeys(host.owner, ch.id) : undefined },
      { label: $t('貼上到播放頭'), action: keyClipboard.length && keyClipboard.every((k) => k.ch === keyClipboard[0].ch) ? () => pasteChannelKeys(host, ch.id) : undefined },
      ...(ch.drive ? [{ separator: true } as MenuItem, { label: ch.drive.on ? $t('關閉音訊反應') : $t('音訊反應'), action: ch.drive.toggle }] : []),
      ...(ch.menu?.length ? [{ separator: true } as MenuItem, ...ch.menu] : []),
    ]);
  };

  const sectionResetMenu = (e: React.MouseEvent, sec: Section) => {
    const extra = sec.menu?.() ?? [];
    if (!sec.onReset && !extra.length) return;
    e.preventDefault();
    e.stopPropagation();
    openMenu(e.clientX, e.clientY, [...extra, ...(extra.length && sec.onReset ? [{ separator: true } as MenuItem] : []), ...(sec.onReset ? [{ label: $t('重設這個區塊'), action: sec.onReset }] : [])]);
  };

  /** 點關鍵影格：Ctrl 切換、Shift 加選；拖曳 = 選取的整組一起移動（吸附播放頭與其他關鍵影格） */
  const dragKey = (e: React.PointerEvent, ch: Channel, k: Keyframe) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const me = { ch: ch.id, id: k.id };
    const cur = mine ? ksel.keys : [];
    const already = cur.some((x) => sameKey(x, me));
    if (e.ctrlKey || e.metaKey) {
      return selectKeys(host.owner, already ? cur.filter((x) => !sameKey(x, me)) : [...cur, me], already ? undefined : me);
    }
    const group = e.shiftKey ? (already ? cur : [...cur, me]) : already ? cur : [me];
    selectKeys(host.owner, group, me);
    // 點關鍵影格：播放頭跟過去（拖曳時跟著走）
    seek(k.t);
    const { orig, min, max } = snapshot(host.owner, group);
    const r = rulerRef.current!.getBoundingClientRect();
    const pxPerSec = r.width / span;
    // 吸附點：播放頭、其他沒選到的關鍵影格
    const pts = [lc, 0, dur];
    for (const c of sections.flatMap((s) => s.channels ?? [])) for (const x of c.keys) if (!group.some((g) => g.ch === c.id && g.id === x.id)) pts.push(x.t);
    const x0 = e.clientX;
    let moved = false;
    listen(
      (ev) => {
        if (!moved && Math.abs(ev.clientX - x0) < 3) return;
        moved = true;
        const raw = k.t + (ev.clientX - x0) / pxPerSec;
        let t = qt(raw);
        for (const p of pts) if (Math.abs(p - raw) * pxPerSec < 6) { t = p; break; }
        const dt = Math.max(-min, Math.min(dur - max, t - k.t));
        moveKeys(host.owner, group, orig, dt);
        seek(k.t + dt);
      },
      () => {
        if (!moved && already && !e.shiftKey && cur.length > 1) selectKeys(host.owner, [me]);
      },
    );
  };

  const keyMenu = (e: React.MouseEvent, ch: Channel, k: Keyframe) => {
    e.preventDefault();
    e.stopPropagation();
    const me = { ch: ch.id, id: k.id };
    if (!isSel(ch.id, k.id)) selectKeys(host.owner, [me]);
    else selectKeys(host.owner, ksel.keys, me);
    const n = useKeySel.getState().keys.length;
    const list = currentKeys(host.owner, ch.id);
    const seg = targetSegment(list, k.id, lc);
    const curE = seg >= 0 ? easeId(list[seg].ease) : '';
    // 緩動放子選單；只有一個關鍵影格（沒有區段可以設定）就不顯示
    openMenu(e.clientX, e.clientY, [
      ...(seg >= 0
        ? [{ label: $t('緩動'), submenu: EASE_PRESETS.map((p) => ({ label: p.label, checked: curE === p.id, action: () => setSegmentEase(host, ch.id, seg, p.ease) })) }, { separator: true as const }]
        : []),
      { label: n > 1 ? $t('複製 {0} 個關鍵影格', n) : $t('複製'), shortcut: 'Ctrl+C', action: copyKeys },
      { label: $t('貼上到播放頭'), shortcut: 'Ctrl+V', action: keyClipboard.length ? pasteKeys : undefined },
      { label: n > 1 ? $t('刪除 {0} 個關鍵影格', n) : $t('刪除關鍵影格'), shortcut: 'Del', danger: true, action: deleteSelectedKey },
    ]);
  };

  const laneMenu = (e: React.MouseEvent, ch?: Channel) => {
    e.preventDefault();
    e.stopPropagation();
    const t = localAt(e.clientX);
    openMenu(e.clientX, e.clientY, [
      { label: $t('在這裡加入關鍵影格'), action: ch ? () => addKeyAt(e, ch) : undefined },
      { label: $t('播放頭移到這裡'), action: () => seek(t) },
      { separator: true },
      { label: $t('全選關鍵影格'), shortcut: 'Ctrl+A', action: selectAllKeys },
      { label: $t('貼上到播放頭'), shortcut: 'Ctrl+V', action: keyClipboard.length ? pasteKeys : undefined },
    ]);
  };

  const dragSplit = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const r = tableRef.current!.getBoundingClientRect();
    listen((ev) => useLayout.getState().set({ ecLeftPx: Math.round(Math.min(LEFT_MAX, Math.max(LEFT_MIN, ev.clientX - r.left))) }));
  };

  // 篩選：有篩選時區塊一律展開（收合狀態另外記，不動原本的）
  const filtering = fmode !== 'all' || !!query.trim();
  const shown = filtering ? filterSections(sections, fmode, query) : sections;
  const isCollapsed = (sec: Section) => filtering ? !!fcol[sec.id] : collapsed[sec.id] ?? !!sec.defaultCollapsed;
  const toggleSection = (sec: Section) => filtering ? setFcol({ ...fcol, [sec.id]: !fcol[sec.id] }) : useLayout.getState().set({ ecCollapsed: { ...collapsed, [sec.id]: !isCollapsed(sec) } });
  // 刻度文字是 mm:ss:ff（比較寬）：依尺規寬度決定最多幾個，每個至少 64px
  // 尺規跟時間軸的一樣：大刻度（有數字）+ 小刻度，放大到最後小刻度是一格
  useLayout((l) => l.timeGrid);
  const rpps = rulerW / span;
  const { major, minor } = rulerSteps(rpps);
  const ticks: number[] = [];
  {
    const n = Math.max(1, Math.round(major * fps()));
    for (let f = Math.ceil((view.a * fps() - 1e-6) / n) * n; f / fps() <= view.b + 1e-6; f += n) ticks.push(f / fps());
  }
  const minorPx = minor * rpps;
  const minorOff = ((Math.ceil(view.a / minor - 1e-6) * minor - view.a) * rpps) % (minorPx || 1);
  const frac = (t: number) => (t - view.a) / span;
  const pct = (t: number) => `${frac(t) * 100}%`;
  /** 範圍外的關鍵影格不畫（留一點邊，邊上的菱形還看得到一半） */
  const visible = (t: number) => t >= view.a - span * 0.02 && t <= view.b + span * 0.02;

  return (
    <div className="ec" ref={tableRef} style={{ '--ec-left': `${Math.max(LEFT_MIN, leftPx)}px` } as React.CSSProperties}>
      {/* 表頭：名稱 + 片段內時間尺規（只有這裡可以拖播放頭） */}
      <div className="ec-row ec-header">
        <div
          className="ec-left"
          onContextMenu={(e) => {
            const items = titleMenu?.();
            if (!items?.length) return;
            e.preventDefault();
            e.stopPropagation();
            openMenu(e.clientX, e.clientY, items);
          }}
        >
          {title}
          <span className="ec-time">{inside ? tc(lc) : '—'}</span>
          <div className="ec-split" onPointerDown={dragSplit} title={$t('拖曳調整左右寬度')} />
        </div>
        <div
          className="ec-right ec-ruler"
          ref={rulerRef}
          onPointerDown={scrub}
          title={$t('拖曳移動播放頭')}
          style={{ backgroundImage: `repeating-linear-gradient(90deg, color-mix(in srgb, var(--text) 7%, transparent) 0 1px, transparent 1px ${minorPx}px)`, backgroundPosition: `${minorOff}px 0` }}
        >
          {ticks.map((t) => <div key={t} className="tick" style={{ left: pct(t) }}>{rulerLabel(t, major)}</div>)}
        </div>
      </div>

      {/* 篩選：搜尋屬性名稱 + 只看有關鍵影格 / 改過的 */}
      <div className="ec-row ec-filter">
        <div className="ec-left">
          <div className="lib-search ec-search">
            <Search size={13} />
            <input placeholder={$t('搜尋…')} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape' && query) { e.stopPropagation(); setQuery(''); } }} />
            {query && <button onClick={() => setQuery('')}><X size={13} /></button>}
          </div>
        </div>
        <div className="ec-right" />
      </div>
      <div className="ec-row ec-filter">
        <div className="ec-left">
          <Seg className="ec-filter-seg" value={fmode} on={(v) => useLayout.getState().set({ ecFilter: v })}
            opts={[{ v: 'all', label: $t('全部') }, { v: 'keys', label: <Diamond size={12} />, title: $t('有關鍵影格') }, { v: 'edited', label: $t('已修改') }]} />
        </div>
        <div className="ec-right" />
      </div>
      {filtering && !shown.length && (
        <div className="ec-empty">
          <span>{$t('沒有符合的屬性')}</span>
          <button className="btn small-h" onClick={() => { setQuery(''); useLayout.getState().set({ ecFilter: 'all' }); }}>{$t('清除篩選')}</button>
        </div>
      )}

      {shown.map((sec) => {
        const isCol = isCollapsed(sec);
        return (
          <React.Fragment key={sec.id}>
            <div className="ec-row ec-section" data-sec={sec.id}>
              <div className="ec-left" onClick={() => toggleSection(sec)} onContextMenu={(e) => sectionResetMenu(e, sec)}>
                <span className="twirl">{isCol ? <ChevronRight size={14} /> : <ChevronDown size={14} />}</span>
                {sec.badge}
                <span className={`ec-sec-title ${sec.dim ? 'dim' : ''}`}>{sec.title}</span>
                {sec.actions && <span className="ec-actions" onClick={(e) => e.stopPropagation()}>{sec.actions}</span>}
                {sec.onReset && <button className="ec-icon" title={$t('重設這個區塊')} onClick={(e) => { e.stopPropagation(); sec.onReset!(); }}><RotateCcw size={13} /></button>}
              </div>
              <div className="ec-right" onPointerDown={startMarquee} onContextMenu={(e) => laneMenu(e)} />
            </div>
            {!isCol && (
              <>
                {sec.timing && !sec.timing.fixed && <TimingRow tm={sec.timing} dur={dur} lc={lc} view={view} localAt={localAt} seek={seek} />}
                {sec.rows?.map((r, i) => (
                  <div key={`${i}:${r.label}`} className={`ec-row ${r.sub ? 'sub' : ''}`}>
                    <div className="ec-left ec-plain" onContextMenu={(e) => sectionResetMenu(e, sec)}><span className="ec-label" title={typeof r.label === 'string' ? r.label : undefined}>{r.label}</span><div className="ec-node">{r.node}</div></div>
                    <div className="ec-right ec-dim" onPointerDown={startMarquee} onContextMenu={(e) => laneMenu(e)} />
                  </div>
                ))}
                {sec.timing?.fixed && <TimingRow tm={sec.timing} dur={dur} lc={lc} view={view} localAt={localAt} seek={seek} />}
                {sec.channels?.map((ch) => {
                  const animated = ch.keys.length > 0;
                  const here = keyAt(ch.keys, lc);
                  const rowKey = `${sec.id}.${ch.id}`;
                  const isOpen = open[rowKey];
                  return (
                    <React.Fragment key={ch.id}>
                      <div className={`ec-row ${animated ? 'anim' : ''} ${ch.drive?.on ? 'driven' : ''} ${curCh === ch.id ? 'cur' : ''}`}>
                        <div className="ec-left ec-ch" onPointerDown={() => curCh !== ch.id && useKeySel.setState({ owner: host.owner, channel: ch.id })}>
                          <span className="twirl small" onClick={() => setOpen({ ...open, [rowKey]: !isOpen })} title={$t('展開曲線')}>
                            {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                          </span>
                          <button className={`ec-watch ${animated ? 'on' : ''}`} title={animated ? $t('關閉動畫（移除所有關鍵影格）') : $t('開啟動畫（在播放頭加關鍵影格）')} onClick={() => toggleAnim(ch)}>
                            <Timer size={13} />
                          </button>
                          {ch.drive && <button className={`ec-watch ${ch.drive.on ? 'on' : ''}`} title={$t('音訊反應')} onClick={ch.drive.toggle}><AudioLines size={13} /></button>}
                          <span className="ec-label" title={ch.label} onPointerDown={() => useKeySel.setState({ owner: host.owner, channel: ch.id, keys: [], sel: null })} onContextMenu={(e) => channelMenu(e, ch)}>{ch.label}{ch.icon}</span>
                          <span className="ec-nav">
                            {animated && (
                              <>
                                <button onClick={() => jump(ch, -1)} title={$t('上一個關鍵影格')}><ChevronLeft size={13} /></button>
                                <button className={here ? 'on' : ''} onClick={() => toggleKeyHere(ch)} title={here ? $t('移除關鍵影格') : $t('加入關鍵影格')}>
                                  <Diamond size={11} fill={here ? 'currentColor' : 'none'} />
                                </button>
                                <button onClick={() => jump(ch, 1)} title={$t('下一個關鍵影格')}><ChevronRight size={13} /></button>
                              </>
                            )}
                          </span>
                          {/* 數值一律靠右（跟其他列的控制項對齊）；關鍵影格導覽放在數值左邊 */}
                          <DragNumber variant="text" value={ch.value} step={ch.step} min={ch.min} max={ch.max} suffix={ch.suffix} display={ch.display} def={ch.def} menu={ch.menu} onChange={(v) => setValue(ch, v)} />
                        </div>
                        <div
                          className="ec-right ec-lane"
                          onClick={() => useKeySel.setState({ owner: host.owner, channel: ch.id })}
                          onPointerDown={startMarquee}
                          onDoubleClick={(e) => e.target === e.currentTarget && addKeyAt(e, ch)}
                          onContextMenu={(e) => laneMenu(e, ch)}
                          title={$t('拖曳框選、雙擊加入關鍵影格')}
                        >
                          {ch.keys.length > 1 && (() => {
                            const l = Math.max(0, frac(ch.keys[0].t)), r = Math.min(1, frac(ch.keys[ch.keys.length - 1].t));
                            return r > l && <div className="ec-span" style={{ left: `${l * 100}%`, width: `${(r - l) * 100}%` }} />;
                          })()}
                          {ch.keys.filter((k) => visible(k.t)).map((k) => (
                            <div
                              key={k.id}
                              data-ch={ch.id}
                              data-id={k.id}
                              className={`ec-key ${isSel(ch.id, k.id) ? 'sel' : ''} ${k.ease === 'hold' ? 'hold' : ''}`}
                              style={{ left: pct(k.t) }}
                              title={$t('{0}s（拖曳移動、右鍵緩動）', k.t.toFixed(2))}
                              onPointerDown={(e) => dragKey(e, ch, k)}
                              onDoubleClick={(e) => { e.stopPropagation(); seek(k.t); }}
                              onContextMenu={(e) => keyMenu(e, ch, k)}
                            />
                          ))}
                        </div>
                      </div>
                      {ch.drive?.on && ch.drive.rows.map((r, i) => (
                        <div key={`${i}:${r.label}`} className="ec-row sub">
                          <div className="ec-left ec-plain" onContextMenu={(e) => sectionResetMenu(e, sec)}><span className="ec-label" title={r.label}>{r.label}</span><div className="ec-node">{r.node}</div></div>
                          <div className="ec-right ec-dim" onPointerDown={startMarquee} onContextMenu={(e) => laneMenu(e)} />
                        </div>
                      ))}
                      {isOpen && <GraphRow host={host} ch={ch} lc={lc} view={view} selId={primary?.ch === ch.id ? primary.id : undefined} />}
                    </React.Fragment>
                  );
                })}
                {sec.footer && <div className="ec-footer">{sec.footer}</div>}
              </>
            )}
          </React.Fragment>
        );
      })}

      {extra}
      {/* 播放頭（蓋住右側所有列） */}
      {inside && lc >= view.a - 1e-6 && lc <= view.b + 1e-6 && <div className="ec-playhead" style={{ left: `calc(var(--ec-col) + (100% - var(--ec-col)) * ${frac(lc)})` }} />}
      {marquee && (
        <div
          className="marquee"
          style={{
            position: 'fixed',
            left: Math.min(marquee.x0, marquee.x1),
            top: Math.min(marquee.y0, marquee.y1),
            width: Math.abs(marquee.x1 - marquee.x0),
            height: Math.abs(marquee.y1 - marquee.y0),
          }}
        />
      )}
      {/* 放大時：底部的水平捲軸（跟時間軸一樣，只捲動；縮放用 Ctrl + 滾輪） */}
      {zoomed && (
        <div className="ec-viewrow">
          <ViewScrollbar a={view.a} b={view.b} dur={dur} onChange={([a, b]) => setView({ a, b })} />
        </div>
      )}
    </div>
  );
}


// ───────────────────────── 曲線列（展開在屬性下方） ─────────────────────────

const GH = 120;
const PAD = 10;

function GraphRow({ host, ch, lc, view, selId }: { host: Host; ch: Channel; lc: number; view: View; selId?: string }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(200);
  const frozen = useRef<{ min: number; max: number } | null>(null);
  const keys = ch.keys;
  const dur = host.duration;
  const mul = ch.display ?? 1;
  const { a: va, b: vb } = view;
  const vs = vb - va || 1;

  useLayoutEffect(() => {
    const el = wrapRef.current!;
    const ro = new ResizeObserver(() => flushSync(() => setW(el.clientWidth)));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // 曲線的數值範圍與取樣點只有 key / 大小改變時才重算（播放中每格只動播放頭）
  const flatV = keys.length ? 0 : ch.value;
  const auto = useMemo(() => {
    const vals = keys.length ? keys.map((k) => k.v) : [flatV];
    if (keys.length > 1) for (let i = 0; i <= 60; i++) vals.push(evalKeys(keys, (i / 60) * dur));
    let mn = Math.min(...vals), mx = Math.max(...vals);
    if (mx - mn < 1e-6) {
      const p = Math.max(Math.abs(mx) * 0.5, ch.step ? ch.step * 20 : 0.25);
      mn -= p;
      mx += p;
    }
    const p = (mx - mn) * 0.15;
    return { min: mn - p, max: mx + p };
  }, [keys, dur, flatV, ch.step]);
  const range = frozen.current ?? auto;
  const { min, max } = range;
  const X = (t: number) => ((t - va) / vs) * W;
  const Y = (v: number) => PAD + (1 - (v - min) / (max - min)) * (GH - PAD * 2);
  const T = (x: number) => Math.min(dur, Math.max(0, va + (x / W) * vs));
  const V = (y: number) => min + (1 - (y - PAD) / (GH - PAD * 2)) * (max - min);

  const seg = targetSegment(keys, selId, lc);
  const a = seg >= 0 ? keys[seg] : undefined;
  const b = seg >= 0 ? keys[seg + 1] : undefined;

  // 點關鍵影格：顯示它左右兩邊的把手（進入 = 前一段的後把手、離開 = 這一段的前把手）
  // 點曲線：顯示那一段的兩個把手
  const [keyMode, setKeyMode] = useState<string | null>(null);
  const ki = keyMode && keyMode === selId ? keys.findIndex((k) => k.id === keyMode) : -1;
  type H = { seg: number; which: 0 | 1 };
  const handles: H[] = ki >= 0 ? [{ seg: ki - 1, which: 1 as const }, { seg: ki, which: 0 as const }] : seg >= 0 ? [{ seg, which: 0 }, { seg, which: 1 }] : [];
  /** 把手的位置：anchor = 它連著的 key、p = 把手本身；這段是定格 / 平的就沒有把手 */
  const handleAt = ({ seg: i, which }: H) => {
    const p = keys[i], q = keys[i + 1];
    if (!p || !q || p.ease === 'hold' || Math.abs(q.v - p.v) < 1e-9) return null;
    const e = p.ease as Bez, sdt = q.t - p.t, sdv = q.v - p.v;
    const anchor = which === 0 ? p : q;
    const ax = X(anchor.t), ay = Y(anchor.v);
    let x = X(p.t + e[which * 2] * sdt), y = Y(p.v + e[which * 2 + 1] * sdv);
    // 把手跟 key 疊在一起（例如線性）會點不到：畫在這段的 1/3 處（一拖就照滑鼠位置算）
    if (Math.hypot(x - ax, y - ay) < 10) {
      const f = which === 0 ? 1 / 3 : 2 / 3;
      x = X(p.t + f * sdt);
      y = Y(p.v + f * sdv);
    }
    return { ax, ay, x, y };
  };

  // 曲線：取樣點數跟寬度成正比（每 2px 一點），只在 key / 範圍 / 寬度改變時重算
  const pts = useMemo(() => {
    const out: string[] = [];
    if (!keys.length) return `0,${Y(flatV)} ${W},${Y(flatV)}`;
    const n = Math.max(24, Math.min(400, Math.round(W / 2)));
    for (let i = 0; i <= n; i++) {
      const t = va + (i / n) * vs;
      out.push(`${X(t).toFixed(1)},${Y(evalKeys(keys, t)).toFixed(1)}`);
    }
    return out.join(' ');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys, dur, W, min, max, flatV, va, vb]);
  // 目前作用中的區段另外加亮
  const segPts = useMemo(() => {
    if (!a || !b) return '';
    const out: string[] = [];
    for (let i = 0; i <= 60; i++) {
      const t = a.t + (i / 60) * (b.t - a.t);
      out.push(`${X(t).toFixed(1)},${Y(evalKeys(keys, t)).toFixed(1)}`);
    }
    return out.join(' ');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys, a, b, dur, W, min, max, va, vb]);

  const pt = (e: { clientX: number; clientY: number }) => {
    const r = wrapRef.current!.querySelector('svg')!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const dragPoint = (e: React.PointerEvent, k: Keyframe) => {
    e.preventDefault();
    e.stopPropagation();
    setKeyMode(k.id);
    useKeySel.setState({ owner: host.owner, keys: [{ ch: ch.id, id: k.id }], sel: { owner: host.owner, ch: ch.id, id: k.id }, focus: true, channel: ch.id });
    frozen.current = range;
    const p0 = pt(e);
    // 點曲線上的關鍵影格：播放頭跟過去（拖曳時跟著走）
    const seekTo = (t: number) => useStore.getState().setTime(host.start + Math.min(host.duration, Math.max(0, t)));
    seekTo(k.t);
    listen(
      (ev) => {
        const p = pt(ev);
        const t = ev.shiftKey ? k.t : T(X(k.t) + p.x - p0.x);
        const v = V(Y(k.v) + p.y - p0.y);
        host.setKeys(ch.id, currentKeys(host.owner, ch.id).map((x) => (x.id === k.id ? { ...x, t, v } : x)));
        seekTo(t);
      },
      () => (frozen.current = null),
    );
  };

  const dragHandle = (e: React.PointerEvent, { seg: i, which }: H) => {
    e.preventDefault();
    e.stopPropagation();
    const a = keys[i], b = keys[i + 1];
    if (!a || !b) return;
    const dt = b.t - a.t, dv = b.v - a.v;
    frozen.current = range;
    listen(
      (ev) => {
        const p = pt(ev);
        const ex = Math.min(1, Math.max(0, (T(p.x) - a.t) / dt));
        const ey = (V(p.y) - a.v) / dv;
        const list = currentKeys(host.owner, ch.id);
        const cur = list.find((x) => x.id === a.id);
        if (!cur || cur.ease === 'hold') return;
        const bz = [...cur.ease] as Bez;
        if (which === 0) { bz[0] = ex; bz[1] = ey; } else { bz[2] = ex; bz[3] = ey; }
        host.setKeys(ch.id, list.map((x) => (x.id === a.id ? { ...x, ease: bz.map((n) => Math.round(n * 1000) / 1000) as Bez } : x)));
      },
      () => (frozen.current = null),
    );
  };

  /** 點曲線：選取那一段；雙擊：在那裡加關鍵影格 */
  const onDown = (e: React.PointerEvent) => {
    const t = T(pt(e).x);
    setKeyMode(null);
    if (keys.length < 2) return useKeySel.setState({ owner: null, keys: [], sel: null });
    let i = keys.findIndex((k, j) => j < keys.length - 1 && t >= k.t && t < keys[j + 1].t);
    if (i < 0) i = t < keys[0].t ? 0 : keys.length - 2;
    useKeySel.setState({ owner: host.owner, keys: [{ ch: ch.id, id: keys[i].id }], sel: { owner: host.owner, ch: ch.id, id: keys[i].id }, focus: true, channel: ch.id });
  };
  const onDbl = (e: React.MouseEvent) => {
    const t = T(pt(e).x);
    const v = keys.length ? evalKeys(keys, t) : ch.value;
    host.setKeys(ch.id, upsertKey(currentKeys(host.owner, ch.id), t, v));
  };

  const curEase = a ? easeId(a.ease) : '';

  return (
    <div className="ec-row ec-graph-row">
      <div className="ec-left ec-graph-side">
        {a && b ? (
          <>
            <div className="muted small">{$t('區段')}{' '}{tc(a.t)} → {tc(b.t)}</div>
            <select className="select wide" value={curEase} onChange={(e) => { const p = EASE_PRESETS.find((x) => x.id === e.target.value); if (p) setSegmentEase(host, ch.id, seg, p.ease); }}>
              {curEase === 'custom' && <option value="custom">{$t('自訂曲線')}</option>}
              {EASE_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
            <EasePresetsMini current={curEase} onPick={(e) => setSegmentEase(host, ch.id, seg, e)} />
          </>
        ) : (
          <div className="muted small">{keys.length ? $t('再加一個關鍵影格就能調緩動') : $t('按左側的碼錶開啟動畫，或雙擊曲線加關鍵影格')}</div>
        )}
        <div className="ec-range muted small">{(max * mul).toFixed(1)} / {(min * mul).toFixed(1)}</div>
      </div>
      <div className="ec-right ec-graph" ref={wrapRef}>
        <svg width={W} height={GH} onPointerDown={onDown} onDoubleClick={onDbl}>
          {[0.25, 0.5, 0.75].map((f) => <line key={f} className="cg-grid" x1={0} x2={W} y1={PAD + f * (GH - PAD * 2)} y2={PAD + f * (GH - PAD * 2)} />)}
          <polyline className={`cg-curve ${keys.length ? '' : 'flat'}`} points={pts} />
          {segPts && <polyline className="cg-seg" points={segPts} />}
          <line className="cg-playhead" x1={X(lc)} x2={X(lc)} y1={0} y2={GH} />
          {keys.map((k) => (
            <rect
              key={k.id}
              className={`cg-key ${selId === k.id ? 'sel' : ''}`}
              x={X(k.t) - 5}
              y={Y(k.v) - 5}
              width={10}
              height={10}
              transform={`rotate(45 ${X(k.t)} ${Y(k.v)})`}
              onPointerDown={(e) => dragPoint(e, k)}
            />
          ))}
          <g className="cg-handles">
            {handles.map((h) => {
              const p = handleAt(h);
              return p && (
                <React.Fragment key={`${h.seg}.${h.which}`}>
                  <line x1={p.ax} y1={p.ay} x2={p.x} y2={p.y} />
                  <circle r={6} cx={p.x} cy={p.y} onPointerDown={(e) => dragHandle(e, h)} />
                </React.Fragment>
              );
            })}
          </g>
        </svg>
      </div>
    </div>
  );
}

// ───────────────────────── 作用列（片段特效的時間範圍） ─────────────────────────

/**
 * 作用列的焦點與選取：id = 最後點的那一列（貼上的目標），is = 選取的 Hit。
 * 點作用列以外的地方就取消（快捷鍵回到關鍵影格 / 時間軸）。
 */
const useHitSel = create<{ id: string | null; is: number[] }>(() => ({ id: null, is: [] }));
if (typeof window !== 'undefined') {
  window.addEventListener(
    'pointerdown',
    (e) => {
      if (!(e.target as HTMLElement).closest?.('.ec-hits')) useHitSel.setState({ id: null, is: [] });
    },
    true,
  );
}
const hitLanes = new Map<string, TimingLane>();
/** 複製的 Hit（相對第一個的時間） */
let hitClipboard: Hit[] = [];

/** 目前焦點的作用列與它的 Hit 清單（每拍 / 整段先展開成手動的樣子，貼上時才真的轉換） */
function focusedLane() {
  const { id, is } = useHitSel.getState();
  const tm = id ? hitLanes.get(id) : undefined;
  if (!tm) return null;
  const cur = tm.get();
  const hits = !cur ? [] : cur.kind === 'hits' ? cur.hits : beatHits(cur.every, cur.d, tm.start, tm.len);
  return { tm, cur, hits, is: is.filter((i) => cur?.kind === 'hits' && i < hits.length) };
}
export const hitsFocused = () => !!focusedLane();

/** 片段內時間對齊時間軸格線（格線是以時間軸時間算的） */
const qLocal = (tm: TimingLane, t: number) => Math.max(0, snapFrame(tm.start + t) - tm.start);
const seekHit = (tm: TimingLane, t: number) => useStore.getState().setTime(snapFrame(tm.start + Math.max(0, t)));

/** 加進去（重疊就覆蓋，跟時間軸一樣），選取加進去的那幾個 */
function addHits(tm: TimingLane, base: Hit[], add: Hit[]) {
  const q = add.map((h) => ({ t: qLocal(tm, h.t), d: h.d }));
  const next = overwriteHits(base, q, tm.len);
  tm.set({ kind: 'hits', hits: next });
  const is = next.map((h, i) => (q.some((a) => Math.abs(a.t - h.t) < 1e-4) ? i : -1)).filter((i) => i >= 0);
  useHitSel.setState({ id: tm.id, is });
  if (is.length) seekHit(tm, next[is[0]].t);
}

/** Delete：刪除選取的 Hit */
export function deleteSelectedHit(): boolean {
  const f = focusedLane();
  if (!f || f.cur?.kind !== 'hits' || !f.is.length) return false;
  f.tm.set({ kind: 'hits', hits: f.hits.filter((_, j) => !f.is.includes(j)) });
  useHitSel.setState({ is: [] });
  return true;
}

/** Ctrl+C：複製選取的 Hit */
export function copyHits(): boolean {
  const f = focusedLane();
  const sel = f?.is.map((i) => f.hits[i]).sort((a, b) => a.t - b.t) ?? [];
  if (!sel.length) return false;
  hitClipboard = sel.map((h) => ({ t: h.t - sel[0].t, d: h.d }));
  return true;
}

/** Ctrl+X：剪下 */
export const cutHits = () => copyHits() && deleteSelectedHit();

/** Ctrl+V：貼到播放頭（整段 / 每拍會先轉成手動）；跟現有的重疊就覆蓋 */
export function pasteHits(): boolean {
  const f = focusedLane();
  if (!f || !hitClipboard.length) return false;
  const at = Math.min(f.tm.len, Math.max(0, useStore.getState().time - f.tm.start));
  addHits(f.tm, f.hits, hitClipboard.map((h) => ({ t: at + h.t, d: h.d })));
  return true;
}

/** Ctrl+D：選取的 Hit 再製一份，緊接在後面、一樣長；跟後面的重疊就覆蓋 */
export function duplicateHits(): boolean {
  const f = focusedLane();
  const sel = f?.is.map((i) => f.hits[i]).sort((a, b) => a.t - b.t) ?? [];
  if (!f || !sel.length) return false;
  const off = Math.max(...sel.map((h) => h.t + h.d)) - sel[0].t;
  addHits(f.tm, f.hits, sel.map((h) => ({ t: h.t + off, d: h.d })));
  return true;
}

/** Ctrl+A：選取這一列全部的 Hit */
export function selectAllHits(): boolean {
  const f = focusedLane();
  if (!f || f.cur?.kind !== 'hits') return false;
  useHitSel.setState({ is: f.hits.map((_, i) => i) });
  return true;
}

/** Home / End：播放頭跳到選取的 Hit 的開頭 / 結尾（多選 = 整組的頭尾） */
export function hitEdge(edge: 'start' | 'end'): boolean {
  const f = focusedLane();
  const sel = f?.is.map((i) => f.hits[i]) ?? [];
  if (!f || !sel.length) return false;
  seekHit(f.tm, edge === 'start' ? Math.min(...sel.map((h) => h.t)) : Math.max(...sel.map((h) => h.t + h.d)));
  return true;
}

/** Ctrl+← / →：選上 / 下一個 Hit（Shift = 延伸選取）；播放頭跳到它的開頭 */
export function navHit(dir: -1 | 1, extend: boolean): boolean {
  const f = focusedLane();
  if (!f || f.cur?.kind !== 'hits' || !f.hits.length) return false;
  const lt = useStore.getState().time - f.tm.start;
  let j: number;
  if (f.is.length) j = dir > 0 ? Math.max(...f.is) + 1 : Math.min(...f.is) - 1;
  else j = dir > 0 ? f.hits.findIndex((h) => h.t > lt + 1e-4) : f.hits.map((h) => h.t < lt - 1e-4).lastIndexOf(true);
  if (j < 0 || j >= f.hits.length) return true;
  useHitSel.setState({ is: extend ? [...new Set([...f.is, j])] : [j] });
  seekHit(f.tm, f.hits[j].t);
  return true;
}

/** Ctrl+Home / End：選第一個 / 最後一個 Hit（Shift = 一路選到頭 / 尾） */
export function navHitEdge(which: 'first' | 'last', extend: boolean): boolean {
  const f = focusedLane();
  if (!f || f.cur?.kind !== 'hits' || !f.hits.length) return false;
  const j = which === 'first' ? 0 : f.hits.length - 1;
  const from = f.is.length ? (which === 'first' ? Math.max(...f.is) : Math.min(...f.is)) : j;
  const range = Array.from({ length: Math.abs(from - j) + 1 }, (_, k) => Math.min(from, j) + k);
  useHitSel.setState({ is: extend ? range : [j] });
  seekHit(f.tm, f.hits[j].t);
  return true;
}

/** Alt+← / →：選取的 Hit 移動 dt 秒（不會蓋到旁邊沒選的、不會跑出片段開頭） */
export function nudgeHits(dt: number): boolean {
  const f = focusedLane();
  if (!f || f.cur?.kind !== 'hits' || !f.is.length) return false;
  const sel = new Set(f.is);
  let d = dt;
  f.hits.forEach((h, i) => {
    if (!sel.has(i)) return;
    if (d < 0) {
      const prev = f.hits.slice(0, i).reverse().find((_, k) => !sel.has(i - 1 - k));
      d = Math.max(d, (prev ? prev.t + prev.d : 0) - h.t);
    } else {
      const next = f.hits.slice(i + 1).find((_, k) => !sel.has(i + 1 + k));
      d = Math.min(d, (next ? next.t : f.tm.len) - (h.t + h.d));
    }
  });
  if (Math.abs(d) < 1e-6) return true;
  f.tm.set({ kind: 'hits', hits: f.hits.map((h, i) => (sel.has(i) ? { t: h.t + d, d: h.d } : h)) });
  const first = Math.min(...f.is);
  seekHit(f.tm, f.hits[first].t + d);
  return true;
}

/** Ctrl+B：在播放頭把 Hit 切成兩個（選取的優先，沒選就切播放頭底下那個）；後段從切點重新播一次 */
export function splitHit(): boolean {
  const f = focusedLane();
  if (!f || f.cur?.kind !== 'hits') return false;
  const lt = useStore.getState().time - f.tm.start;
  const inside = (h: Hit) => lt > h.t + 1e-4 && lt < h.t + h.d - 1e-4;
  const i = [...f.is, ...f.hits.map((_, j) => j)].find((j) => f.hits[j] && inside(f.hits[j]));
  if (i === undefined) return true;
  const h = f.hits[i];
  const next = [...f.hits.slice(0, i), { t: h.t, d: lt - h.t }, { t: lt, d: h.t + h.d - lt }, ...f.hits.slice(i + 1)];
  f.tm.set({ kind: 'hits', hits: next });
  useHitSel.setState({ is: [i + 1] });
  return true;
}

/** Q / W：選取的 Hit 開頭 / 結尾修剪到播放頭 */
export function trimHit(side: 'start' | 'end'): boolean {
  const f = focusedLane();
  if (!f || f.cur?.kind !== 'hits' || f.is.length !== 1) return false;
  const i = f.is[0], h = f.hits[i];
  const lt = useStore.getState().time - f.tm.start;
  if (lt <= h.t + 1e-4 || lt >= h.t + h.d - 1e-4) return true;
  const n = side === 'start' ? { t: lt, d: h.t + h.d - lt } : { t: h.t, d: lt - h.t };
  f.tm.set({ kind: 'hits', hits: f.hits.map((x, j) => (j === i ? n : x)) });
  return true;
}

const BEATS: { every: BeatEvery; label: () => string }[] = [
  { every: 0.5, label: () => $t('每半拍') },
  { every: 1, label: () => $t('每拍') },
  { every: 2, label: () => $t('每 2 拍') },
  { every: 4, label: () => $t('每小節') },
];

function TimingRow({ tm, dur, lc, view, localAt, seek }: { tm: TimingLane; dur: number; lc: number; view: View; localAt: (x: number) => number; seek: (t: number) => void }) {
  const sel = useHitSel();
  hitLanes.set(tm.id, tm);
  const timing = tm.get();
  const span = view.b - view.a || 1;
  const frac = (t: number) => (t - view.a) / span;
  const laneRef = useRef<HTMLDivElement>(null);
  /** 目前的 Hit 清單（整段 = 一個蓋滿的；beat = 展開後的） */
  const manual = (t = tm.get()): Hit[] => (!t ? [{ t: 0, d: dur }] : t.kind === 'hits' ? t.hits : beatHits(t.every, t.d, tm.start, dur));
  const setHits = (hits: Hit[]) => tm.set({ kind: 'hits', hits: normalizeHits(hits, dur) });
  /** 在 t 加一次播放（整段 / 每拍會先變成手動；蓋到的那個換掉） */
  const addAt = (t: number) => {
    const cur = tm.get();
    const base = cur ? manual(cur) : [];
    const next = base.find((h) => h.t > t + 1e-4);
    setHits([...base.filter((h) => !(t >= h.t && t < h.t + h.d)), { t, d: Math.max(HIT_MIN, Math.min(tm.defD, (next?.t ?? dur) - t)) }]);
    // 選取新加的那個（接著可以 Ctrl+D、Delete…）
    const now = tm.get();
    const j = now?.kind === 'hits' ? now.hits.findIndex((h) => Math.abs(h.t - t) < 1e-4) : -1;
    useHitSel.setState({ id: tm.id, is: j >= 0 ? [j] : [] });
  };
  const beatD = () => {
    const cur = tm.get();
    return cur?.kind === 'beat' ? cur.d : cur?.kind === 'hits' && cur.hits[0] ? cur.hits[0].d : tm.defD;
  };
  const menuItems = (): MenuItem[] => {
    const cur = tm.get();
    if (tm.fixed) return [{ label: $t('在播放頭觸發'), action: () => addAt(lc) }];
    return [
      { label: $t('在播放頭觸發'), action: () => addAt(lc) },
      { label: $t('每拍觸發'), submenu: BEATS.map((b) => ({ label: b.label(), checked: cur?.kind === 'beat' && cur.every === b.every, action: () => tm.set({ kind: 'beat', every: b.every, d: beatD() }) })) },
      { label: $t('整段'), checked: !cur, action: () => tm.set(undefined) },
      { label: $t('轉成手動'), action: cur?.kind === 'beat' ? () => setHits(manual(cur)) : undefined },
    ];
  };
  const laneMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    useHitSel.setState({ id: tm.id, is: [] });
    openMenu(e.clientX, e.clientY, [{ label: $t('貼上到播放頭'), shortcut: 'Ctrl+V', action: hitClipboard.length ? pasteHits : undefined }, { label: $t('全選'), shortcut: 'Ctrl+A', action: tm.get()?.kind === 'hits' ? selectAllHits : undefined }, { separator: true }, ...menuItems()]);
  };

  /**
   * 拖曳 Hit（跟時間軸的片段一樣）：中間移動、兩端修剪；對齊格線，磁吸開著時吸附播放頭、旁邊的 Hit、節拍。
   * 點選取中的（或播放頭不在裡面）→ 播放頭跳到開頭，移動時播放頭跟著開頭走；修剪時預覽顯示邊緣那一格。
   * 每拍模式：拖右端 = 改每一次的長度。
   */
  const drag = (e: React.PointerEvent, i: number, mode: 'move' | 'l' | 'r') => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const cur = tm.get();
    const w = laneRef.current!.getBoundingClientRect().width || 1;
    const pxPerSec = w / span;
    const x0 = e.clientX;
    if (cur?.kind === 'beat') {
      if (mode !== 'r') return;
      const d0 = cur.d;
      document.body.classList.add('hit-dragging', 'hit-resizing');
      return listen(
        (ev) => tm.set({ ...cur, d: Math.max(HIT_MIN, d0 + (ev.clientX - x0) / pxPerSec) }),
        () => document.body.classList.remove('hit-dragging', 'hit-resizing'),
      );
    }
    if (cur?.kind !== 'hits') return;
    const prev = useHitSel.getState();
    const mine = prev.id === tm.id ? prev.is : [];
    if (e.ctrlKey || e.metaKey || e.shiftKey) return useHitSel.setState({ id: tm.id, is: mine.includes(i) ? mine.filter((x) => x !== i) : [...mine, i] });
    const already = mine.includes(i);
    useHitSel.setState({ id: tm.id, is: already ? mine : [i] });
    const hits = cur.hits;
    const h = hits[i];
    const lt0 = useStore.getState().time - tm.start;
    const inside = lt0 >= h.t - 1e-6 && lt0 < h.t + h.d;
    if (mode === 'move' && (already || !inside)) seekHit(tm, h.t);
    const lo = i > 0 ? hits[i - 1].t + hits[i - 1].d : 0;
    const hi = i + 1 < hits.length ? hits[i + 1].t : tm.len;
    // 吸附點（片段內時間）：播放頭、片段頭尾、旁邊的 Hit、節拍
    const pts = [useStore.getState().time - tm.start, 0, tm.len, lo, hi, ...beatSnapPoints().map((b) => b - tm.start)];
    const snap = (t: number) => {
      const q = qLocal(tm, t);
      if (!snapActive()) return q;
      let best = q, bd = 6 / pxPerSec;
      for (const p of pts) if (Math.abs(p - t) < bd) { bd = Math.abs(p - t); best = p; }
      return best;
    };
    let moved = false;
    document.body.classList.add('hit-dragging');
    document.body.classList.toggle('hit-resizing', mode !== 'move');
    listen(
      (ev) => {
        if (!moved && Math.abs(ev.clientX - x0) < 3) return;
        moved = true;
        const dt = (ev.clientX - x0) / pxPerSec;
        let n: Hit;
        if (mode === 'move') {
          // 開頭或結尾哪個比較靠近吸附點就用哪個
          const s0 = snap(h.t + dt), s1 = snap(h.t + h.d + dt) - h.d;
          const t = Math.abs(s0 - (h.t + dt)) <= Math.abs(s1 - (h.t + dt)) ? s0 : s1;
          n = { t: Math.min(Math.max(lo, t), Math.max(lo, hi - h.d)), d: h.d };
          if (inside || already) seekHit(tm, n.t);
        } else if (mode === 'l') {
          const t = Math.min(Math.max(lo, snap(h.t + dt)), h.t + h.d - HIT_MIN);
          n = { t, d: h.t + h.d - t };
          useTrimView.setState({ t: tm.start + n.t });
        } else {
          const end = Math.min(hi, Math.max(h.t + HIT_MIN, snap(h.t + h.d + dt)));
          n = { t: h.t, d: end - h.t };
          useTrimView.setState({ t: tm.start + end - 1e-3 });
        }
        tm.set({ kind: 'hits', hits: hits.map((x, j) => (j === i ? n : x)) });
      },
      () => {
        document.body.classList.remove('hit-dragging', 'hit-resizing');
        useTrimView.setState({ t: null });
        // 點一下多選中的其中一個（沒拖）→ 只選它
        if (!moved && already && mine.length > 1) useHitSel.setState({ id: tm.id, is: [i] });
      },
    );
  };

  const auto = timing?.kind === 'beat';
  const blocks = !timing ? [] : timing.kind === 'hits' ? timing.hits : beatHits(timing.every, timing.d, tm.start, dur);
  const mode = !timing ? 'all' : timing.kind === 'hits' ? 'hits' : `b${timing.every}`;
  return (
    <div className="ec-row">
      <div className="ec-left ec-plain">
        <span className="ec-label">{tm.fixed ? $t('觸發時間') : $t('作用')}</span>
        {!tm.fixed && <div className="ec-node">
          {timing?.kind === 'beat' && <DragNumber variant="text" value={timing.d} step={0.05} min={HIT_MIN} suffix="s" onChange={(v) => tm.set({ ...timing, d: Math.max(HIT_MIN, v) })} />}
          <select
            className="select"
            value={mode}
            onChange={(e) => {
              const v = e.target.value;
              if (v === 'all') tm.set(undefined);
              else if (v === 'hits') setHits(manual());
              else tm.set({ kind: 'beat', every: Number(v.slice(1)) as BeatEvery, d: beatD() });
            }}
          >
            <option value="all">{$t('整段')}</option>
            <option value="hits">{$t('手動')}</option>
            {BEATS.map((b) => <option key={b.every} value={`b${b.every}`}>{b.label()}</option>)}
          </select>
        </div>}
      </div>
      <div ref={laneRef} className="ec-right ec-hits" onPointerDown={(e) => e.target === e.currentTarget && useHitSel.setState({ id: tm.id, is: [] })} onContextMenu={laneMenu} onDoubleClick={(e) => e.target === e.currentTarget && addAt(qLocal(tm, localAt(e.clientX)))}>
        {!timing && <div className="ec-hit all" />}
        {blocks.map((h, i) => {
          const l = Math.max(0, frac(h.t)), r = Math.min(1, frac(Math.min(dur, h.t + h.d)));
          if (r <= 0 || l >= 1) return null;
          const isSel = !auto && sel.id === tm.id && sel.is.includes(i);
          return (
            <div
              key={i}
              className={`ec-hit ${auto ? 'auto' : ''} ${isSel ? 'sel' : ''}`}
              style={{ left: `${l * 100}%`, width: `${(r - l) * 100}%` }}
              title={`${tc(h.t)} · ${h.d.toFixed(2)}s`}
              onPointerDown={(e) => drag(e, i, 'move')}
              onDoubleClick={(e) => {
                e.stopPropagation();
                seek(h.t);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (!auto && !isSel) useHitSel.setState({ id: tm.id, is: [i] });
                const del: MenuItem[] = auto
                  ? []
                  : [
                      { label: $t('複製'), shortcut: 'Ctrl+C', action: copyHits },
                      { label: $t('剪下'), shortcut: 'Ctrl+X', action: cutHits },
                      { label: $t('再製'), shortcut: 'Ctrl+D', action: duplicateHits },
                      { label: $t('刪除'), shortcut: 'Delete', danger: true, action: deleteSelectedHit },
                      { separator: true },
                    ];
                openMenu(e.clientX, e.clientY, [...del, ...menuItems()]);
              }}
            >
              {!auto && <i className="l" onPointerDown={(e) => drag(e, i, 'l')} />}
              <i className="r" onPointerDown={(e) => drag(e, i, 'r')} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
