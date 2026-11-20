import { matteCoverage, requestMatte, useMatte } from '../engine/matte';
import { openEditorWindow } from './EditorWindow';
import { $t, displayName } from '../i18n';
import { ArrowLeftRight, ArrowRightLeft, CircleDashed, Eye, EyeOff, FastForward, Film, Gauge, Magnet, Minus, MoveHorizontal, Music, Plus, Redo2, Replace, Scissors, Sparkles, TriangleAlert, Undo2, Volume2, VolumeX, Group, Link2, ArrowRightFromLine, ArrowRightToLine, Drum, ChevronDown, Lock, Unlock } from 'lucide-react';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import {
  trSelId, type TrScope, type TrSide,
  attachedAudioIds, linkedAudioOf,
  KIND_OF, LIST, TRACK_H, fxLevel, itemSpeed, keyOf, laneOf, mediaUsable, parseKey, projectDuration, spansOf, stretchPatch, useStore, displayRows,
  type AnyItem, type AudioClip, type Clip, type DropFit, type FxItem, type ItemType, type Media, type PasteResult, type PlacementGhost, type TrackKind, type Tracks, type TimelineDropMode,
} from '../store';
import { sortClips, transitionWindow, makeCtx, type TrWindow } from '../engine/renderer';
import { nextStart, prevEnd, selectedItemsAtTime, spansOverlap, type Span } from '../engine/overlap';
import { snapTargetIfApplied } from '../engine/snap';
import { plainSpeed } from '../engine/remap';
import { audioBufferPeak, getAudioBuffer, setScrubbing, waveformLevels } from '../engine/audio';
import { PPS_MAX, PPS_MIN, rulerLabel, rulerSteps, snapFrame } from '../engine/rulerTicks';
import { undo, redo, useHistory, beginHistoryTransaction, endHistoryTransaction } from '../engine/history';
import { relinkWithPicker } from '../engine/media';
import { confirmDialog, openMenu, promptDialog, stopPreviewFx, toast, useDrag, useLayout, useReveal, useSnapLine, useMenu, type MenuItem } from './uiStore';
import { itemName } from './names';
import { useDock } from './Dock';
import { closeSource } from './SourcePanel';
import { beatSnapPoints, fitToBeats, getBeats, splitAtBeats, useBeats } from './beatGrid';

const SNAP_PX = 8;
/** 時間軸預設長度（秒）；專案比這個長才依專案長度延伸 */
const MIN_LEN = 60;
const NAMES: Record<TrackKind, string> = { fx: $t('特效'), video: $t('影片'), audio: $t('音訊') };
const ICONS: Record<TrackKind, React.ReactNode> = { fx: <Sparkles size={13} />, video: <Film size={13} />, audio: <Music size={13} /> };

const showSnap = (t: number | null) => useSnapLine.getState().t !== t && useSnapLine.setState({ t });
const usePlacementPreview = create<{ owner: string | null; items: PlacementGhost[] }>(() => ({ owner: null, items: [] }));
let placementMenuId = 0;

function placementChoices(fit: DropFit | null, choose: (mode: TimelineDropMode) => void, cancel: () => void): MenuItem[] {
  return [
    { label: $t('覆蓋'), action: () => choose('overwrite') },
    { label: $t('插入'), action: () => choose('insert') },
    { label: $t('插入並移動所有軌道'), action: () => choose('insertAll') },
    { label: $t('修剪以符合長度'), action: fit ? () => choose('trimFit') : undefined },
    { label: $t('加速以符合長度'), action: fit?.speed ? () => choose('speedFit') : undefined },
    { label: $t('取消'), action: cancel },
  ];
}

const openPlacementMenu = (x: number, y: number, items: MenuItem[], owner?: string) => openMenu(x + 32, y + 24, items, owner);

function showPendingPlacement(result: PasteResult, x: number, y: number, choose: (mode: TimelineDropMode) => void) {
  const owner = `timeline-placement-${++placementMenuId}`;
  const clear = () => {
    if (usePlacementPreview.getState().owner === owner) usePlacementPreview.setState({ owner: null, items: [] });
  };
  usePlacementPreview.setState({ owner, items: result.preview });
  const unsub = useMenu.subscribe((s) => {
    if (s.menu?.owner !== owner) queueMicrotask(() => {
      if (useMenu.getState().menu?.owner !== owner) { unsub(); clear(); }
    });
  });
  openPlacementMenu(x, y, placementChoices(result.fit, (mode) => { unsub(); clear(); choose(mode); }, () => { unsub(); clear(); }), owner);
}

/** 貼上遇到重疊時才讓使用者決定如何處理；取消時不修改時間軸。 */
export function pasteTimeline(at?: { time: number; track: number; kind: TrackKind }, point?: { x: number; y: number }) {
  const s = useStore.getState();
  const target = at ?? (s.activeTrack ? { time: s.time, track: s.activeTrack.idx, kind: s.activeTrack.kind } : undefined);
  const result = s.paste(target);
  if (!result?.conflict) return;
  const head = document.querySelector('.timeline .playhead')?.getBoundingClientRect();
  const row = document.querySelector('.timeline .tl-row.active .lane')?.getBoundingClientRect();
  const x = point?.x ?? head?.left ?? innerWidth / 2;
  const y = point?.y ?? row?.top ?? innerHeight / 2;
  showPendingPlacement(result, x, y, (mode) => { useStore.getState().paste(target, mode); });
}

/** 再製固定接在選取範圍尾端，重疊時沿用貼上的選擇。 */
export function duplicateTimeline() {
  const result = useStore.getState().duplicate();
  if (!result?.conflict) return;
  const selected = document.querySelector('.timeline [data-key].sel')?.getBoundingClientRect();
  const x = selected?.right ?? innerWidth / 2;
  const y = selected?.top ?? innerHeight / 2;
  showPendingPlacement(result, x, y, (mode) => { useStore.getState().duplicate(mode); });
}

function nearest(v: number, pts: number[], pps: number) {
  if (!useStore.getState().snap) return { v, d: Infinity };
  let best = v, bd = SNAP_PX / pps;
  for (const p of pts) {
    const d = Math.abs(p - v);
    if (d < bd) { bd = d; best = p; }
  }
  return { v: best, d: best === v ? Infinity : bd };
}

function snapPoints(exclude: Set<string>) {
  const s = useStore.getState();
  const pts = [0, s.time, ...beatSnapPoints()];
  (['clip', 'effect', 'audio'] as ItemType[]).forEach((type) => {
    for (const c of s[LIST[type]] as AnyItem[]) if (!exclude.has(keyOf(type, c.id))) pts.push(c.start, c.start + c.duration);
  });
  return pts;
}

function laneAt(ev: PointerEvent, kind: TrackKind): number | null {
  for (const el of document.elementsFromPoint(ev.clientX, ev.clientY)) {
    const d = (el as HTMLElement).dataset;
    if (d?.laneKind === kind) return Number(d.laneIdx);
  }
  return null;
}

function listen(onMove: (ev: PointerEvent) => void, onUp?: (ev: PointerEvent) => void) {
  const up = (ev: PointerEvent) => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', up);
    onUp?.(ev);
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', up);
}

/** 拖曳中顯示在片段上的提示 */
const useOp = create<{ op: { key: string; kind: 'stretch' | 'slip'; text: string; keys?: string[] } | null }>(() => ({ op: null }));
const useMovePreview = create<{ moving: Set<string>; affected: Record<string, { left: number; width: number }> }>(() => ({ moving: new Set(), affected: {} }));
const clearMovePreview = () => useMovePreview.setState({ moving: new Set(), affected: {} });
function movePreview(key: string) {
  const moving = useMovePreview((s) => s.moving.has(key));
  const affected = useMovePreview((s) => s.affected[key]);
  return { moving, affected };
}

/** 按住 Ctrl / Alt 時讓把手和游標有不同樣子 */
function trackModifiers() {
  const upd = (e: KeyboardEvent | MouseEvent) => {
    document.body.classList.toggle('key-ctrl', e.ctrlKey || e.metaKey);
    document.body.classList.toggle('key-alt', e.altKey);
  };
  window.addEventListener('keydown', upd);
  window.addEventListener('keyup', upd);
  window.addEventListener('pointermove', upd as (e: MouseEvent) => void);
  window.addEventListener('blur', () => document.body.classList.remove('key-ctrl', 'key-alt'));
}
trackModifiers();

/**
 * Alt + 拖曳片段：片段位置不動，滑動素材的起點（slip）
 */
function slipItem(e: React.PointerEvent, type: 'clip' | 'audio', it: AnyItem) {
  const S = useStore.getState();
  const m = S.media.find((x) => x.id === (it as Clip).mediaId);
  if (!m || m.missing || m.kind === 'image') return;
  S.select({ type, id: it.id });
  const pps = S.pps;
  const in0 = (it as Clip).in ?? 0;
  const speed = itemSpeed(type, it) ?? 1;
  const span = it.duration * speed; // 用掉的素材長度
  const maxIn = Math.max(0, m.duration - span);
  const x0 = e.clientX;
  const key = keyOf(type, it.id);
  document.body.classList.add('slipping');
  listen(
    (ev) => {
      // 往右拖 = 畫面往右移 = 看到更早的內容
      const v = Math.min(maxIn, Math.max(0, in0 - ((ev.clientX - x0) / pps) * speed));
      useStore.getState().patchItems({ [key]: { in: v } });
      useOp.setState({ op: { key, kind: 'slip', text: $t('素材起點 {0}s / {1}s', v.toFixed(2), m.duration.toFixed(1)) } });
    },
    () => {
      document.body.classList.remove('slipping');
      useOp.setState({ op: null });
    },
  );
}

/**
 * Ctrl + 拖曳頭尾：變速（跟威力導演一樣）。多選時影片 / 特效 / 音訊一起縮放，關鍵影格跟著變。
 */
function stretchItems(e: React.PointerEvent, type: ItemType, it: AnyItem, side: 'l' | 'r') {
  const S = useStore.getState();
  const key = keyOf(type, it.id);
  if (!S.selected.includes(key)) S.select({ type, id: it.id });
  const st = useStore.getState();
  const group = st.selected
    .map(parseKey)
    .map(({ type: t, id }) => ({ type: t, it: (st[LIST[t]] as AnyItem[]).find((x) => x.id === id)! }))
    .filter((g) => g.it);
  const start = Math.min(...group.map((g) => g.it.start));
  const end = Math.max(...group.map((g) => g.it.start + g.it.duration));
  const anchor = side === 'r' ? start : end;
  const edge0 = side === 'r' ? it.start + it.duration : it.start;
  const pps = st.pps;
  const pts = snapPoints(new Set(st.selected));
  const sp0 = itemSpeed(type, it) ?? 1;
  const x0 = e.clientX;
  const keys = group.map((g) => keyOf(g.type, g.it.id));
  const movingKeys = new Set(keys);
  let moved = false;
  document.body.classList.add('stretching');
  listen(
    (ev) => {
      if (!moved && Math.abs(ev.clientX - x0) < 3) return;
      if (!moved) beginHistoryTransaction();
      moved = true;
      const sn = nearest(edge0 + (ev.clientX - x0) / pps, pts, pps);
      showSnap(sn.d !== Infinity ? sn.v : null);
      const edge = sn.v;
      // 速度限制 0.1× ~ 10×
      const sc = Math.min(10, Math.max(0.1, (edge - anchor) / (edge0 - anchor || 1e-6)));
      const patches: Record<string, Partial<AnyItem>> = {};
      const spans: Span[] = [];
      for (const g of group) {
        const p = stretchPatch(g.type, g.it, anchor, sc);
        patches[keyOf(g.type, g.it.id)] = p;
        spans.push({ lane: laneOf(g.type, g.it.track), start: p.start!, duration: p.duration! });
      }
      useStore.getState().patchItems(patches);
      const affected: Record<string, { left: number; width: number }> = {};
      const now = useStore.getState();
      for (const t of ['clip', 'effect', 'audio'] as ItemType[]) for (const other of now[LIST[t]] as AnyItem[]) {
        const otherKey = keyOf(t, other.id);
        if (movingKeys.has(otherKey)) continue;
        const target = { lane: laneOf(t, other.track), start: other.start, duration: other.duration };
        for (const span of spans) {
          if (!spansOverlap(span, target)) continue;
          const left = Math.max(span.start, other.start);
          const right = Math.min(span.start + span.duration, other.start + other.duration);
          affected[otherKey] = { left: (left - other.start) * pps, width: (right - left) * pps };
        }
      }
      useMovePreview.setState({ moving: movingKeys, affected });
      useOp.setState({ op: { key, kind: 'stretch', text: `${(sp0 / sc).toFixed(2)}×`, keys } });
    },
    (ev) => {
      showSnap(null);
      document.body.classList.remove('stretching');
      useOp.setState({ op: null });
      if (!moved) return;
      if (!Object.keys(useMovePreview.getState().affected).length) {
        endHistoryTransaction(true);
        clearMovePreview();
        return;
      }
      const owner = `timeline-stretch-${Date.now()}`;
      let decided = false;
      const finish = (mode?: 'overwrite' | 'insert' | 'insertAll') => {
        if (decided) return;
        decided = true;
        unsub();
        if (mode) useStore.getState().resolveTimelineDrop(keys, mode);
        endHistoryTransaction(!!mode);
        clearMovePreview();
      };
      const unsub = useMenu.subscribe((s) => {
        if (s.menu?.owner !== owner) queueMicrotask(() => { if (useMenu.getState().menu?.owner !== owner) finish(); });
      });
      openPlacementMenu(ev.clientX, ev.clientY, [
        { label: $t('覆蓋'), action: () => finish('overwrite') },
        { label: $t('插入'), action: () => finish('insert') },
        { label: $t('插入並移動所有軌道'), action: () => finish('insertAll') },
        { label: $t('取消'), action: () => finish() },
      ], owner);
    },
  );
}

/** 片段最長可以拉到多長（一般變速：素材播完為止） */
function clipMaxDur(c: Clip): number {
  const s = useStore.getState();
  const m = s.media.find((x) => x.id === c.mediaId);
  if (!m || m.kind !== 'video' || m.missing) return Infinity;
  const sp = plainSpeed(c, makeCtx(s).modules);
  return sp ? c.in + (m.duration - c.in) / sp : Infinity;
}

/** 點擊 / 拖曳時間軸項目：處理 Ctrl / Shift 選取，以及整組移動（可跨軌） */
/** 雙擊片段 / 特效：選取並打開編輯視窗 */
function openItemEditor(type: 'clip' | 'effect', id: string) {
  const s = useStore.getState();
  if (s.selection?.type !== type || s.selection.id !== id) s.select({ type, id });
  openEditorWindow();
}

function itemPointerDown(e: React.PointerEvent, type: ItemType, it: AnyItem) {
  if (e.button !== 0) return;
  e.stopPropagation();
  e.preventDefault();
  if (useStore.getState().tracks[KIND_OF[type]][it.track]?.locked) return;
  stopPreviewFx();
  if (e.altKey && (type === 'clip' || type === 'audio')) return slipItem(e, type, it);
  const S = useStore.getState();
  const key = keyOf(type, it.id);
  if (e.ctrlKey || e.metaKey) return S.select({ type, id: it.id }, 'toggle');
  if (e.shiftKey) return S.select({ type, id: it.id }, 'range');
  const already = S.selected.includes(key);
  if (!already) S.select({ type, id: it.id });
  else useStore.setState({ selection: { type, id: it.id }, activeTrack: { kind: KIND_OF[type], idx: it.track }, leftTab: 'editor' });

  const st = useStore.getState();
  const timeBeforeDrag = st.time;
  const group = st.selected
    .map(parseKey)
    .map(({ type: t, id }) => ({ type: t, it: (st[LIST[t]] as AnyItem[]).find((x) => x.id === id)! }))
    .filter((g) => g.it);
  if (group.some((g) => st.tracks[KIND_OF[g.type]][g.it.track]?.locked)) return;
  const pps = st.pps;
  // 吸附點不含播放頭（播放頭會跟著片段走）
  const pts = snapPoints(new Set(st.selected)).slice(0);
  pts.splice(1, 1);
  const movingKeys = new Set(st.selected);
  // 按下就移動播放頭（不等放開，沒有延遲）：點未選中的片段 → 移到片段開頭，但播放頭已經在片段裡就不動；
  // 點已選中的片段 → 回到片段開頭。接著拖曳的話，播放頭在片段裡就跟著片段一起移動（看到的還是同一格）
  let inside = st.time >= it.start - 1e-6 && st.time < it.start + it.duration;
  if (already || !inside) {
    st.setTime(it.start);
    inside = true;
  }
  const head = useStore.getState().time;
  const minStart = Math.min(...group.map((g) => g.it.start));
  const kind = KIND_OF[type];
  const x0 = e.clientX, y0 = e.clientY;
  let moved = false;

  listen(
    (ev) => {
      if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 3) return;
      moved = true;
      let dt = (ev.clientX - x0) / pps;
      const a = nearest(it.start + dt, pts, pps);
      const b = nearest(it.start + it.duration + dt, pts, pps);
      if (a.d <= b.d && a.d !== Infinity) { dt = a.v - it.start; showSnap(a.v); }
      else if (b.d !== Infinity) { dt = b.v - it.start - it.duration; showSnap(b.v); }
      else showSnap(null);
      dt = Math.max(-minStart, dt);
      const lane = laneAt(ev, kind);
      let dTrack = lane === null ? 0 : lane - it.track;
      const n = useStore.getState().tracks[kind].length;
      for (const g of group) {
        if (KIND_OF[g.type] !== kind) continue;
        dTrack = Math.max(-g.it.track, Math.min(n - 1 - g.it.track, dTrack));
      }
      if (!useMovePreview.getState().moving.size) beginHistoryTransaction();
      const fdt = dt;
      const patches: Record<string, Partial<AnyItem>> = {};
      for (const g of group) {
        const p: Partial<AnyItem> = { start: g.it.start + fdt };
        if (KIND_OF[g.type] === kind) p.track = g.it.track + dTrack;
        patches[keyOf(g.type, g.it.id)] = p;
      }
      useStore.getState().patchItems(patches);
      if (dTrack) useStore.getState().setActiveTrack({ kind, idx: it.track + dTrack });
      if (inside) useStore.getState().setTime(head + fdt);
      const current = useStore.getState();
      const attached = attachedAudioIds(current);
      const visualLane = (t: ItemType, x: AnyItem) => {
        const parent = t === 'audio' && attached.has(x.id) ? current.clips.find((c) => c.link && c.link === x.link) : undefined;
        return parent ? laneOf('clip', parent.track) : laneOf(t, x.track);
      };
      const movedSpans = (['clip', 'effect', 'audio'] as ItemType[]).flatMap((t) =>
        (current[LIST[t]] as AnyItem[]).filter((x) => movingKeys.has(keyOf(t, x.id)))
          .map((x) => ({ lane: visualLane(t, x), start: x.start, duration: x.duration })));
      const affected: Record<string, { left: number; width: number }> = {};
      (['clip', 'effect', 'audio'] as ItemType[]).forEach((t) => {
        for (const other of current[LIST[t]] as AnyItem[]) {
          const k = keyOf(t, other.id);
          if (movingKeys.has(k)) continue;
          const o = { lane: visualLane(t, other), start: other.start, duration: other.duration };
          const hits = movedSpans.filter((m) => spansOverlap(m, o));
          if (!hits.length) continue;
          const left = Math.max(other.start, Math.min(...hits.map((h) => h.start)));
          const right = Math.min(other.start + other.duration, Math.max(...hits.map((h) => h.start + h.duration)));
          affected[k] = { left: (left - other.start) * pps, width: (right - left) * pps };
        }
      });
      useMovePreview.setState({ moving: movingKeys, affected });
    },
    (ev) => {
      showSnap(null);
      const preview = useMovePreview.getState();
      const overlaps = Object.keys(preview.affected).length > 0;
      if (moved && overlaps) {
        const owner = `timeline-drop-${Date.now()}`;
        let decided = false;
        const fit = useStore.getState().dropFit([...movingKeys]);
        const finish = (mode?: TimelineDropMode) => {
          if (decided) return;
          decided = true;
          unsub();
          if (mode) useStore.getState().resolveTimelineDrop([...movingKeys], mode);
          endHistoryTransaction(!!mode);
          if (!mode) useStore.getState().setTime(timeBeforeDrag);
          clearMovePreview();
        };
        const unsub = useMenu.subscribe((s) => {
          if (s.menu?.owner !== owner) queueMicrotask(() => { if (useMenu.getState().menu?.owner !== owner) finish(); });
        });
        openPlacementMenu(ev.clientX, ev.clientY, placementChoices(fit, (mode) => finish(mode), () => finish()), owner);
      } else if (moved) {
        endHistoryTransaction(true);
        clearMovePreview();
      }
      if (!moved && already && useStore.getState().selected.length > 1 && !it.link && !it.group) S.select({ type, id: it.id });
    },
  );
}

function resizeItem(e: React.PointerEvent, type: ItemType, it: AnyItem, side: 'l' | 'r', hasIn: boolean, maxEnd = Infinity) {
  if (e.button !== 0) return;
  e.stopPropagation();
  e.preventDefault();
  const before = useStore.getState();
  const key = keyOf(type, it.id);
  if ((e.ctrlKey || e.metaKey) && (type !== 'clip' || (before.selected.includes(key) && before.selected.length > 1))) return stretchItems(e, type, it, side);
  if (!before.selected.includes(key)) before.select({ type, id: it.id });
  else useStore.setState({ selection: { type, id: it.id }, activeTrack: { kind: KIND_OF[type], idx: it.track }, leftTab: 'editor' });
  const S = useStore.getState();
  const edge0 = side === 'r' ? it.start + it.duration : it.start;
  const showEffectiveSnap = (snap: { v: number; d: number }, edge: number) => {
    showSnap(snapTargetIfApplied(snap, edge));
  };
  const trimItems = (['clip', 'effect', 'audio'] as ItemType[]).flatMap((itemType) => {
    const selectedIds = S.selected.map(parseKey).filter((selected) => selected.type === itemType).map((selected) => selected.id);
    if (itemType === type) selectedIds.push(it.id);
    return selectedItemsAtTime(S[LIST[itemType]] as AnyItem[], selectedIds, edge0, side === 'r' ? 'end' : 'start')
      .map((item) => ({ type: itemType, item }));
  });
  const pps = S.pps;
  const movingKeys = new Set<string>();
  const addLinkedItems = (itemType: ItemType, item: AnyItem) => {
    movingKeys.add(keyOf(itemType, item.id));
    if (item.link) {
      for (const t of ['clip', 'audio'] as ItemType[]) {
        for (const linked of S[LIST[t]] as AnyItem[]) if (linked.link === item.link) movingKeys.add(keyOf(t, linked.id));
      }
    }
  };
  trimItems.forEach(({ type: itemType, item }) => addLinkedItems(itemType, item));
  const pts = snapPoints(movingKeys);
  const end = it.start + it.duration;
  const inT = (it as Clip).in ?? 0;
  const x0 = e.clientX;
  const timeBeforeDrag = S.time;
  const others = spansOf(S, movingKeys);
  const lane = laneOf(type, it.track);
  const limitR = nextStart(others, lane, end);
  const limitL = prevEnd(others, lane, it.start);
  const itemHasIn = (itemType: ItemType, item: AnyItem) => itemType === 'clip'
    ? item.id === it.id && itemType === type ? hasIn : S.media.find((media) => media.id === (item as Clip).mediaId)?.kind === 'video'
    : itemType === 'audio';
  const itemStartBounds = (itemType: ItemType, item: AnyItem) => {
    const speed = itemSpeed(itemType, item) ?? 1;
    return {
      min: itemHasIn(itemType, item) ? Math.max(0, item.start - ((item as Clip | AudioClip).in ?? 0) / speed) : 0,
      max: item.start + item.duration - 0.05,
    };
  };
  const itemEndBounds = (itemType: ItemType, item: AnyItem) => {
    const sourceMax = itemType === 'clip'
      ? item.id === it.id && itemType === type ? maxEnd : clipMaxDur(item as Clip)
      : itemType === 'audio'
        ? item.id === it.id && itemType === type ? maxEnd : S.media.find((media) => media.id === (item as AudioClip).mediaId)?.duration ?? Infinity
        : Infinity;
    const inPoint = itemType === 'effect' ? 0 : (item as Clip | AudioClip).in ?? 0;
    return { min: item.start + 0.05, max: item.start + sourceMax - inPoint };
  };
  const addLinkedAudioPatch = (patches: Record<string, Partial<AnyItem>>, clip: Clip, edge: number, reset = false) => {
    const audio = linkedAudioOf(S, clip);
    if (!audio) return;
    let patch: Partial<AudioClip>;
    if (side === 'r') {
      patch = { duration: Math.max(0.05, edge - audio.start) };
    } else {
      const delta = edge - clip.start;
      patch = {
        start: audio.start + delta,
        duration: Math.max(0.05, audio.duration - delta),
        in: Math.max(0, audio.in + delta * (audio.rate ?? 1)),
      };
    }
    patches[keyOf('audio', audio.id)] = reset ? { ...audio, ...patch } : patch;
  };
  let moved = false;
  let speedMode = false;
  let lastClientX = x0;
  const move = (ev: { clientX: number; ctrlKey: boolean; metaKey: boolean }) => {
    lastClientX = ev.clientX;
    if (!moved && Math.abs(ev.clientX - x0) < 3) return;
    if (!moved) beginHistoryTransaction();
    moved = true;
    const d = (ev.clientX - x0) / pps;
    let patch: Partial<Clip> = {};
    const patches: Record<string, Partial<AnyItem>> = {};
    const resizedSpans: Span[] = [];
    const speeding = type === 'clip' && (ev.ctrlKey || ev.metaKey);
    if (speeding) {
      const anchor = side === 'r' ? it.start : end;
      const edge0 = side === 'r' ? end : it.start;
      const sn = nearest(edge0 + d, pts, pps);
      const edge = side === 'r' ? Math.max(anchor + 0.05, sn.v) : Math.max(0, Math.min(anchor - 0.05, sn.v));
      showEffectiveSnap(sn, edge);
      const sc = Math.min(10, Math.max(0.1, (edge - anchor) / (edge0 - anchor || 1e-6)));
      patch = stretchPatch(type, it, anchor, sc) as Partial<Clip>;
      if (trimItems.length > 1) {
        for (const { type: itemType, item } of trimItems) {
          const itemPatch = stretchPatch(itemType, item, anchor, sc);
          patches[keyOf(itemType, item.id)] = speedMode !== speeding ? { ...item, ...itemPatch } : itemPatch;
          resizedSpans.push({ lane: laneOf(itemType, item.track), start: itemPatch.start!, duration: itemPatch.duration! });
          if (itemType === 'clip') {
            const audio = linkedAudioOf(S, item as Clip);
            if (!audio) continue;
            const audioPatch = stretchPatch('audio', audio, anchor, sc) as Partial<AudioClip>;
            patches[keyOf('audio', audio.id)] = speedMode !== speeding ? { ...audio, ...audioPatch } : audioPatch;
          }
        }
        patch = patches[key] as Partial<Clip>;
      } else {
        patches[key] = speedMode !== speeding ? { ...it, ...patch } : patch;
        resizedSpans.push({ lane, start: patch.start!, duration: patch.duration! });
      }
      useOp.setState({ op: { key, kind: 'stretch', text: `${((itemSpeed(type, it) ?? 1) / sc).toFixed(2)}×`, keys: [key] } });
      document.body.classList.add('stretching');
      useStore.getState().setTime(side === 'r' ? patch.start! + patch.duration! - 1 / 60 : patch.start!);
    } else if (trimItems.length > 1) {
      const sn = nearest(edge0 + d, pts, pps);
      const bounds = trimItems.map(({ type: itemType, item }) => side === 'r' ? itemEndBounds(itemType, item) : itemStartBounds(itemType, item));
      const minEdge = Math.max(...bounds.map((bound) => bound.min));
      const maxEdge = Math.min(...bounds.map((bound) => bound.max));
      const edge = Math.max(minEdge, Math.min(maxEdge, sn.v));
      showEffectiveSnap(sn, edge);
      for (const { type: itemType, item } of trimItems) {
        const itemEnd = item.start + item.duration;
        if (side === 'r') {
          const duration = Math.max(0.05, Math.min(itemEndBounds(itemType, item).max - item.start, edge - item.start));
          const itemPatch = { duration };
          patches[keyOf(itemType, item.id)] = speedMode !== speeding ? { ...item, ...itemPatch } : itemPatch;
          resizedSpans.push({ lane: laneOf(itemType, item.track), start: item.start, duration });
          if (itemType === 'clip') addLinkedAudioPatch(patches, item as Clip, edge, speedMode !== speeding);
        } else {
          const minStart = itemStartBounds(itemType, item).min;
          const start = Math.min(itemEnd - 0.05, Math.max(minStart, edge));
          const speed = itemSpeed(itemType, item) ?? 1;
          const itemPatch: Partial<AnyItem> = {
            start,
            duration: itemEnd - start,
            ...(itemHasIn(itemType, item) ? { in: Math.max(0, ((item as Clip | AudioClip).in ?? 0) + (start - item.start) * speed) } : {}),
          };
          patches[keyOf(itemType, item.id)] = speedMode !== speeding ? { ...item, ...itemPatch } : itemPatch;
          resizedSpans.push({ lane: laneOf(itemType, item.track), start, duration: itemPatch.duration! });
          if (itemType === 'clip') addLinkedAudioPatch(patches, item as Clip, start, speedMode !== speeding);
        }
      }
      patch = patches[key] as Partial<Clip>;
      useStore.getState().setTime(side === 'r' ? it.start + patch.duration! - 1 / 60 : patch.start!);
    } else if (side === 'r') {
      const sn = nearest(Math.max(it.start + 0.05, end + d), pts, pps);
      patch = { duration: Math.min(maxEnd - inT, Math.max(0.05, sn.v - it.start)) };
      showEffectiveSnap(sn, it.start + patch.duration!);
      useStore.getState().setTime(it.start + patch.duration! - 1 / 60);
      patches[key] = speedMode !== speeding ? { ...it, ...patch } : patch;
      resizedSpans.push({ lane, start: it.start, duration: patch.duration! });
    } else {
      const sn = nearest(it.start + d, pts, pps);
      let s = sn.v;
      const minS = hasIn ? Math.max(0, it.start - inT / (itemSpeed(type, it) ?? 1)) : 0;
      s = Math.min(end - 0.05, Math.max(minS, s));
      showEffectiveSnap(sn, s);
      patch = { start: s, duration: end - s };
      // 素材起點跟著移動（考慮速度：2× 時拉 1 秒 = 素材 2 秒）
      if (hasIn) patch.in = Math.max(0, inT + (s - it.start) * (itemSpeed(type, it) ?? 1));
      useStore.getState().setTime(s);
      patches[key] = speedMode !== speeding ? { ...it, ...patch } : patch;
      resizedSpans.push({ lane, start: patch.start!, duration: patch.duration! });
    }
    if (!speeding) {
      useOp.setState({ op: null });
      document.body.classList.remove('stretching');
    }
    useStore.getState().patchItems(patches);
    speedMode = speeding;
    const affected: Record<string, { left: number; width: number }> = {};
    for (const itemType of ['clip', 'effect', 'audio'] as ItemType[]) {
      for (const other of useStore.getState()[LIST[itemType]] as AnyItem[]) {
        const otherKey = keyOf(itemType, other.id);
        if (movingKeys.has(otherKey)) continue;
        for (const span of resizedSpans) {
          if (!spansOverlap(span, { lane: laneOf(itemType, other.track), start: other.start, duration: other.duration })) continue;
          const left = Math.max(span.start, other.start);
          const right = Math.min(span.start + span.duration, other.start + other.duration);
          affected[otherKey] = { left: (left - other.start) * pps, width: (right - left) * pps };
        }
      }
    }
    useMovePreview.setState({ moving: movingKeys, affected });
  };
  const onModifier = (ev: KeyboardEvent) => {
    if (type !== 'clip' || !moved || (ev.key !== 'Control' && ev.key !== 'Meta')) return;
    move({ clientX: lastClientX, ctrlKey: ev.ctrlKey, metaKey: ev.metaKey });
  };
  window.addEventListener('keydown', onModifier);
  window.addEventListener('keyup', onModifier);
  listen(move, (ev) => {
    window.removeEventListener('keydown', onModifier);
    window.removeEventListener('keyup', onModifier);
    showSnap(null);
    document.body.classList.remove('stretching');
    useOp.setState({ op: null });
    if (!moved) return;
    if (!Object.keys(useMovePreview.getState().affected).length) {
      endHistoryTransaction(true);
      clearMovePreview();
      return;
    }
    const owner = `timeline-resize-${Date.now()}`;
    let decided = false;
    const finish = (mode?: 'overwrite' | 'insert' | 'insertAll' | 'trimFit') => {
      if (decided) return;
      decided = true;
      unsub();
      if (mode === 'trimFit') {
        if (trimItems.length > 1) {
          const patches: Record<string, Partial<AnyItem>> = {};
          const edge = side === 'r'
            ? Math.min(...trimItems.map(({ type: itemType, item }) => Math.min(itemEndBounds(itemType, item).max, nextStart(others, laneOf(itemType, item.track), item.start + item.duration))))
            : Math.max(...trimItems.map(({ type: itemType, item }) => Math.max(itemStartBounds(itemType, item).min, prevEnd(others, laneOf(itemType, item.track), item.start))));
          for (const { type: itemType, item } of trimItems) {
            const itemEnd = item.start + item.duration;
            if (side === 'r') {
              const duration = Math.max(0.05, Math.min(itemEndBounds(itemType, item).max - item.start, edge - item.start));
              patches[keyOf(itemType, item.id)] = { ...item, duration };
              if (itemType === 'clip') addLinkedAudioPatch(patches, item as Clip, item.start + duration, true);
            } else {
              const speed = itemSpeed(itemType, item) ?? 1;
              const start = Math.max(edge, itemStartBounds(itemType, item).min);
              patches[keyOf(itemType, item.id)] = {
                ...item,
                start,
                duration: itemEnd - start,
                ...(itemHasIn(itemType, item) ? { in: Math.max(0, ((item as Clip | AudioClip).in ?? 0) + (start - item.start) * speed) } : {}),
              };
              if (itemType === 'clip') addLinkedAudioPatch(patches, item as Clip, start, true);
            }
          }
          useStore.getState().patchItems(patches);
          const primary = patches[key] as AnyItem;
          useStore.getState().setTime(side === 'r' ? it.start + primary.duration - 1 / 60 : primary.start);
        } else if (side === 'r') {
          const duration = Math.max(0.05, Math.min(maxEnd - inT, limitR - it.start));
          useStore.getState().patchItems({ [key]: { ...it, duration } });
          useStore.getState().setTime(it.start + duration - 1 / 60);
        } else {
          const start = Math.max(limitL, hasIn ? Math.max(0, it.start - inT / (itemSpeed(type, it) ?? 1)) : 0);
          useStore.getState().patchItems({ [key]: { ...it, start, duration: end - start, ...(hasIn ? { in: Math.max(0, inT + (start - it.start) * (itemSpeed(type, it) ?? 1)) } : {}) } });
          useStore.getState().setTime(start);
        }
      } else if (mode) {
        const current = (useStore.getState()[LIST[type]] as AnyItem[]).find((x) => x.id === it.id)!;
        const length = current.start + current.duration - end;
        useStore.getState().resolveTimelineDrop([...movingKeys], mode, side === 'r' && mode !== 'overwrite' ? { start: end, length } : undefined);
      }
      endHistoryTransaction(!!mode);
      if (!mode) useStore.getState().setTime(timeBeforeDrag);
      clearMovePreview();
    };
    const unsub = useMenu.subscribe((s) => {
      if (s.menu?.owner !== owner) queueMicrotask(() => { if (useMenu.getState().menu?.owner !== owner) finish(); });
    });
    const items: MenuItem[] = [
      { label: $t('覆蓋'), action: () => finish('overwrite') },
      ...(side === 'r' ? [
        { label: $t('插入'), action: () => finish('insert') },
        { label: $t('插入並移動所有軌道'), action: () => finish('insertAll') },
      ] : []),
      { label: $t('修剪以符合長度'), action: () => finish('trimFit') },
      { label: $t('取消'), action: () => finish() },
    ];
    openPlacementMenu(ev.clientX, ev.clientY, items, owner);
  });
}

/** 拖轉場的左右邊緣改長度（以剪接點為中心，兩邊對稱） */
/** 拖轉場邊緣改長度：剪接點的轉場兩邊對稱；開頭 / 結尾的轉場只拖內側那邊。邊緣會吸附 */
function resizeTransition(e: React.PointerEvent, c: Clip, side: TrSide, handle: 'l' | 'r', w: TrWindow) {
  e.stopPropagation();
  e.preventDefault();
  const S = useStore.getState();
  S.select({ type: 'transition', id: trSelId(c.id, side) });
  const pps = S.pps;
  const pts = snapPoints(new Set());
  // 轉場的固定點：剪接點的中心 / 開頭轉場的片段開頭 / 結尾轉場的片段結尾
  const anchor = w.mode === 'cut' ? w.t0 + w.d / 2 : w.mode === 'head' ? c.start : c.start + c.duration;
  const edge0 = handle === 'r' ? w.t0 + w.d : w.t0;
  const x0 = e.clientX;
  listen(
    (ev) => {
      const sn = nearest(edge0 + (ev.clientX - x0) / pps, pts.filter((p) => Math.abs(p - anchor) > 1e-4), pps);
      showSnap(sn.d !== Infinity ? sn.v : null);
      const half = Math.abs(sn.v - anchor);
      const d = w.mode === 'cut' ? half * 2 : half;
      useStore.getState().updateTransition(c.id, { duration: Math.round(Math.min(w.max, Math.max(0.05, d)) * 1000) / 1000 }, side);
    },
    () => showSnap(null),
  );
}

/** 轉場的右鍵選單：編輯 / 移除（批次套用在轉場卡片的右鍵選單、屬性面板） */
export function transitionMenu(x: number, y: number, c: Clip, side: TrSide) {
  const S = useStore.getState();
  const tr = side === 'out' ? c.transitionOut : c.transitionIn;
  if (!tr) return;
  openMenu(x, y, [
    {
      label: $t('編輯轉場'),
      action: () => {
        S.select({ type: 'transition', id: trSelId(c.id, side) });
        useDock.getState().activatePanel('inspector'); // 屬性分頁被關掉了也要打開
      },
    },
    { separator: true },
    { label: $t('移除轉場'), action: () => S.setTransition(c.id, null, side), danger: true },
  ]);
}

function itemMenu(e: React.MouseEvent, type: ItemType, it: AnyItem, media?: Media) {
  e.preventDefault();
  e.stopPropagation();
  const S = useStore.getState();
  if (!S.selected.includes(keyOf(type, it.id))) S.select({ type, id: it.id });
  const n = useStore.getState().selected.length;
  const items: MenuItem[] = [
    // 編輯視窗：屬性 + 預覽的對話框（影片 / 文字片段、特效軌的特效）
    ...(type !== 'audio' ? [{ label: $t('在編輯視窗中編輯…'), shortcut: $t('雙擊'), action: () => openItemEditor(type, it.id) }, { separator: true } as MenuItem] : []),
    { label: $t('在播放頭分割'), shortcut: 'S', action: S.split },
    { label: $t('修剪開頭到播放頭'), shortcut: 'Q', action: () => S.trim('start') },
    { label: $t('修剪結尾到播放頭'), shortcut: 'W', action: () => S.trim('end') },
    { label: $t('節拍'), submenu: beatMenuItems() },
    { separator: true },
    { label: n > 1 ? $t('複製 {0} 個項目', n) : $t('複製'), shortcut: 'Ctrl+C', action: S.copy },
    { label: $t('剪下'), shortcut: 'Ctrl+X', action: S.cut },
    { label: $t('貼上到播放頭'), shortcut: 'Ctrl+V', action: S.clipboard ? () => pasteTimeline() : undefined },
    { label: $t('再製'), shortcut: 'Ctrl+D', action: duplicateTimeline },
    { separator: true },
    {
      label: $t('重新命名…'),
      action: async () => {
        const st = useStore.getState();
        const v = await promptDialog({ title: $t('重新命名'), value: itemName(type, it, st.media, st.modules) });
        if (v !== null) useStore.getState().renameItem(type, it.id, v);
      },
    },
    {
      label: n > 1 ? $t('循環播放選取範圍') : $t('循環預覽此段'),
      action: () => {
        // 多選：從最早的開頭到最晚的結尾
        const st = useStore.getState();
        const its = st.selected.map(parseKey).map(({ type: t, id }) => (st[LIST[t]] as AnyItem[]).find((x) => x.id === id)).filter((x): x is AnyItem => !!x);
        const list = its.length ? its : [it];
        S.setLoop({ a: Math.min(...list.map((x) => x.start)), b: Math.max(...list.map((x) => x.start + x.duration)) });
      },
    },
    { separator: true },
  ];
  // 連結 / 群組 / 合併
  const st = useStore.getState();
  const sel = st.selected.map(parseKey);
  const linked = sel.some(({ type: t, id }) => (st[LIST[t]] as AnyItem[]).find((x) => x.id === id)?.link);
  const grouped = sel.some(({ type: t, id }) => (st[LIST[t]] as AnyItem[]).find((x) => x.id === id)?.group);
  if (linked) items.push({ label: $t('取消影音連結'), action: () => S.unlinkSelected() });
  else if (sel.some((x) => x.type === 'clip') && sel.some((x) => x.type === 'audio')) items.push({ label: $t('連結影片與音訊'), action: () => S.linkSelected() });
  if (type === 'clip' && media?.kind === 'video' && media.hasAudio && !(it as Clip).audioSplit) {
    items.push({
      label: $t('移除聲音'),
      action: () => {
        if (!useStore.getState().removeClipAudio(it.id)) toast($t('鎖定軌道無法移除聲音'), 'error');
      },
    });
  }
  if (n > 1) items.push({ label: $t('合併片段'), shortcut: 'Ctrl+J', action: () => mergeOrHint() });
  if (grouped) items.push({ label: $t('解除群組'), shortcut: 'Ctrl+Shift+G', action: () => S.ungroupSelected() });
  else if (n > 1) items.push({ label: $t('建立群組'), shortcut: 'Ctrl+G', action: () => S.groupSelected() });
  if ((type === 'clip' || type === 'audio') && media) {
    items.push({ label: mediaUsable(media) ? $t('替換素材…') : $t('重新連結素材…'), action: () => relinkWithPicker(media.id) });
  }
  items.push(
    { separator: true },
    { label: $t('刪除'), shortcut: 'Del', action: () => S.removeSelection() },
    { label: $t('波紋刪除'), shortcut: 'Shift+Del', action: () => S.removeSelection(true), danger: true },
    { label: $t('波紋刪除（所有軌道）'), shortcut: 'Alt+Del', action: () => S.removeSelection('all'), danger: true },
  );
  openMenu(e.clientX, e.clientY, items);
}

/** 節拍相關指令（片段右鍵選單、工具列的「節拍」選單共用） */
function beatMenuItems(): MenuItem[] {
  const has = getBeats().length > 0;
  const off = (f: () => void) => (has ? f : undefined);
  return [
    {
      label: $t('在節拍處分割'),
      submenu: [
        { label: $t('每拍'), action: off(() => splitAtBeats(1)) },
        { label: $t('每 2 拍'), action: off(() => splitAtBeats(2)) },
        { label: $t('每小節'), action: off(() => splitAtBeats(4)) },
      ],
    },
    {
      label: $t('依節拍排列'),
      submenu: [
        { label: $t('每段 1 拍'), action: off(() => fitToBeats(1)) },
        { label: $t('每段 2 拍'), action: off(() => fitToBeats(2)) },
        { label: $t('每段 1 小節'), action: off(() => fitToBeats(4)) },
        { label: $t('每段 2 小節'), action: off(() => fitToBeats(8)) },
      ],
    },
  ];
}

/** 合併選取的片段；接不起來（不是同一段素材的連續部分）就提示可以用群組 */
export function mergeOrHint() {
  const n = useStore.getState().mergeSelected();
  if (n) toast($t('已合併 {0} 處', n));
  else toast($t('只有首尾相接、而且是同一段素材連續部分的片段才能合併；不同片段可以用「建立群組」(Ctrl+G) 綁在一起'), 'error');
}

// ───────────────────────── 新增軌道面板 ─────────────────────────

interface AddTrackState { x: number; y: number; kind: TrackKind; above: number | null }

/** 依軌道類型列出「放在哪一軌上方」，並換算成插入的 index */
function positionOptions(kind: TrackKind, n: number) {
  // 影片 / 特效：index 大的在上面；音訊：index 小的在上面
  const order = kind === 'audio' ? [...Array(n).keys()] : [...Array(n).keys()].reverse();
  const opts = [{ label: kind === 'audio' ? $t('最上方') : $t('最上層'), at: kind === 'audio' ? 0 : n }];
  for (const i of order) {
    const at = kind === 'audio' ? i + 1 : i;
    opts.push({ label: kind === 'audio' ? $t('在「{0} {1}」之後', NAMES[kind], i + 1) : $t('在「{0} {1}」下層', NAMES[kind], i + 1), at });
  }
  // 去掉重複（最上層 = 第一條的上方）
  return opts.filter((o, i) => opts.findIndex((x) => x.at === o.at) === i);
}

const KINDS: TrackKind[] = ['video', 'fx', 'audio'];

/** 畫面最下方的插入位置：音訊 = 最後；影片 / 特效依顯示設定（上層在下方 → 最上層；上層在上方 → 最底層） */
export function bottomSlot(kind: TrackKind): { at: number; level?: number } {
  const s = useStore.getState();
  const n = s.tracks[kind].length;
  if (kind === 'audio') return { at: n };
  const upperAtBottom = useLayout.getState().upperLayerAt === 'bottom';
  if (kind === 'video') return { at: upperAtBottom ? n : 0 };
  return upperAtBottom ? { at: n, level: s.tracks.video.length } : { at: 0, level: 0 };
}

/** 一次可以新增好幾種、好幾條軌道 */
function AddTrackPanel({ state, close }: { state: AddTrackState; close: () => void }) {
  const tracks = useStore((s) => s.tracks);
  const [count, setCount] = useState<Record<TrackKind, number>>({ video: 0, fx: 0, audio: 0, [state.kind]: 1 } as Record<TrackKind, number>);
  const [at, setAt] = useState<Record<TrackKind, number>>(() => {
    const o = {} as Record<TrackKind, number>;
    for (const k of KINDS) o[k] = bottomSlot(k).at;
    if (state.above !== null) o[state.kind] = state.kind === 'audio' ? state.above + 1 : state.above + 1;
    return o;
  });
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: state.x, y: state.y });

  useEffect(() => {
    const r = ref.current!.getBoundingClientRect();
    setPos({ x: Math.max(8, Math.min(state.x, innerWidth - r.width - 8)), y: Math.max(8, Math.min(state.y, innerHeight - r.height - 8)) });
    const down = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && close();
    const key = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key);
    };
  }, [state, close]);

  const total = count.video + count.fx + count.audio;
  /** 從某條軌道開的（右鍵）：新軌道一律加在那條軌道下方，不用選位置 */
  const anchored = state.above !== null;
  const add = () => {
    const S = useStore.getState();
    if (anchored) {
      const before = displayRows(S.tracks, S.upperAt);
      const pos = before.findIndex((r) => r.kind === state.kind && r.idx === state.above);
      const added: { kind: TrackKind; idx: number }[] = [];
      for (const k of KINDS) {
        for (let i = 0; i < count[k]; i++) {
          added.push({ kind: k, idx: useStore.getState().tracks[k].length });
          useStore.getState().addTrack(k); // 加在清單最後：原本軌道的編號不會變
        }
      }
      const order = [...before];
      order.splice(pos < 0 ? order.length : pos + 1, 0, ...added);
      useStore.getState().reorderTracks(order);
      if (total) toast($t('已新增 {0} 條軌道', total));
      return close();
    }
    for (const k of KINDS) {
      const toBottom = at[k] === bottomSlot(k).at;
      for (let i = 0; i < count[k]; i++) {
        // 放在最下方：每加一條，下一條就接在它下面
        if (toBottom) {
          const b = bottomSlot(k);
          S.addTrack(k, b.at, b.level);
        } else S.addTrack(k, at[k]);
      }
    }
    if (total) toast($t('已新增 {0} 條軌道', total));
    close();
  };
  const setN = (k: TrackKind, n: number) => setCount({ ...count, [k]: Math.max(0, Math.min(8, n)) });

  return (
    <div ref={ref} className={`popover add-track-pop ${anchored ? 'anchored' : ''}`} style={{ left: pos.x, top: pos.y }}>
      <div className="pop-title">{$t('新增軌道')}</div>
      {KINDS.map((k) => (
        <div key={k} className={`at-row ${count[k] ? 'on' : ''}`}>
          <span className={`at-kind ${k}`}>{ICONS[k]} {NAMES[k]}</span>
          <div className="stepper">
            <button onClick={() => setN(k, count[k] - 1)} disabled={!count[k]}><Minus size={13} /></button>
            <span>{count[k]}</span>
            <button onClick={() => setN(k, count[k] + 1)}><Plus size={13} /></button>
          </div>
          {!anchored && (
            <select className="select" disabled={!count[k]} value={at[k]} onChange={(e) => setAt({ ...at, [k]: +e.target.value })}>
              {positionOptions(k, tracks[k].length).map((o) => <option key={o.label} value={o.at}>{o.label}</option>)}
            </select>
          )}
        </div>
      ))}
      <div className="dialog-actions">
        <button className="btn" onClick={close}>{$t('取消')}</button>
        <button className="btn primary" disabled={!total} onClick={add}>{total ? $t('新增 {0} 條', total) : $t('新增')}</button>
      </div>
    </div>
  );
}

// ───────────────────────── 時間軸項目（memo：只有自己變了才重畫） ─────────────────────────

/** 拖曳中：顯示倍率 / 素材起點 */
function OpBadge({ k }: { k: string }) {
  const op = useOp((s) => (s.op?.key === k ? s.op : null));
  if (!op) return null;
  return <span className={`op-badge ${op.kind}`}>{op.kind === 'stretch' ? <FastForward size={11} /> : <MoveHorizontal size={11} />} {op.text}</span>;
}

/** 目前拖曳 / 變速中的樣式 */
function useOpCls(k: string) {
  return useOp((s) => (s.op?.kind === 'stretch' && s.op.keys?.includes(k) ? 'op-stretch' : s.op?.kind === 'slip' && s.op.key === k ? 'op-slip' : ''));
}

interface ClipViewProps {
  c: Clip;
  m: Media | undefined;
  /** 連結的音訊（畫在片段下半部，跟影片一體） */
  la?: AudioClip;
  name: string;
  pps: number;
  sel: boolean;
  remapName: string | null;
  drop: 'relink' | 'replace' | 'transition' | 'transitionOut' | 'remap' | 'effect' | 'mask' | null;
  dropThumb?: string;
}

/** 依片段寬度切幾格檢查（每格約 3px，最多 240 格） */
const matteCells = (w: number) => Math.max(1, Math.min(240, Math.round(w / 3)));

/**
 * AI 去背：片段底部顯示哪些地方的遮罩已經好了（跟預覽用同一個查法，所以位置對得上）。
 * 全部好了就不顯示；失敗時沒好的部分是紅色。
 */
function MatteBar({ clip, media, width }: { clip: Clip; media: Media; width: number }) {
  useMatte((s) => s.ver);
  const job = useMatte((s) => s.jobs[media.id]);
  const err = useMatte((s) => s.errors[media.id]);
  const modules = useStore((s) => s.modules);
  const map = useMemo(() => new Map(modules.map((m) => [m.id, m])), [modules]);
  // 開了 AI 去背就開始算（不用等播放頭走到這個片段；同樣的範圍不會重複排）
  useEffect(() => requestMatte(clip, media, map), [clip, media, map]);
  const cov = matteCoverage(clip, media, map, matteCells(width));
  let ready = 0;
  for (const v of cov) ready += v;
  if (ready === cov.length) return null;
  // 連續的格子合併成漸層的一段
  const stops: string[] = [];
  const on = 'var(--accent2)', off = err && !job ? 'var(--err)' : 'transparent';
  for (let k = 0; k < cov.length; ) {
    let j = k;
    while (j < cov.length && cov[j] === cov[k]) j++;
    const c = cov[k] ? on : off;
    stops.push(`${c} ${((k / cov.length) * 100).toFixed(2)}%`, `${c} ${((j / cov.length) * 100).toFixed(2)}%`);
    k = j;
  }
  const pct = Math.round((ready / cov.length) * 100);
  return (
    <div
      className={`clip-matte ${job ? 'busy' : ''}`}
      style={{ backgroundImage: `linear-gradient(to right, ${stops.join(', ')})` }}
      title={err && !job ? err : $t('AI 去背 {0}%', pct)}
    />
  );
}

const ClipView = React.memo(function ClipView({ c, m, la, name: label, pps, sel, remapName, drop, dropThumb }: ClipViewProps) {
  const key = keyOf('clip', c.id);
  const preview = movePreview(key);
  const opCls = useOpCls(key);
  const isText = !!c.text;
  const ok = isText || mediaUsable(m);
  const relinkGhost = (drop === 'relink' || drop === 'replace') && dropThumb;
  const sp = itemSpeed('clip', c) ?? 1;
  const name = ok ? label : $t('遺失：{0}', label);
  return (
    <div
      data-key={key}
      className={`clip ${la ? 'av' : ''} ${isText ? 'textclip' : ''} ${sel ? 'sel' : ''} ${ok && !(drop === 'relink' && dropThumb) ? '' : 'missing'} ${drop ? 'drop-hint' : ''} ${preview.moving ? 'move-ghost' : ''} ${preview.affected ? 'move-affected' : ''} ${opCls}`}
      style={{
        left: c.start * pps,
        width: Math.max(4, c.duration * pps),
        '--overlap-left': `${preview.affected?.left ?? 0}px`, '--overlap-width': `${preview.affected?.width ?? 0}px`,
        backgroundImage: relinkGhost ? `url(${dropThumb})` : !isText && ok && m!.thumb ? `url(${m!.thumb})` : undefined,
      } as React.CSSProperties}
      title={ok ? undefined : $t('素材遺失：把素材拖到這裡、或右鍵「重新連結素材…」')}
      onPointerDown={(e) => itemPointerDown(e, 'clip', c)}
      onDoubleClick={() => openItemEditor('clip', c.id)}
      onContextMenu={(e) => itemMenu(e, 'clip', c, m)}
    >
      <div className="handle l" onPointerDown={(e) => resizeItem(e, 'clip', c, 'l', m?.kind === 'video')} />
      {isText && <span className="text-ico">T</span>}
      {!ok && <TriangleAlert size={12} className="warn-ico" />}
      {c.aiMatte && m && ok && (m.kind === 'video' || m.kind === 'image') && <MatteBar clip={c} media={m} width={c.duration * pps} />}
      {c.link && <Link2 size={11} className="link-ico" />}
      {c.group && <Group size={11} className="link-ico" />}
      <span className="clip-name" title={`${name} · ${c.duration.toFixed(2)}s`}>{name}</span>
      {remapName && <span className="badge"><Gauge size={10} /> {remapName}</span>}
      {!!c.effects?.some((f) => !f.base) && <span className="badge" title={$t('片段特效')}><Sparkles size={10} /> {c.effects!.filter((f) => !f.base).length}</span>}
      {drop === 'effect' && <span className="badge replace-tag"><Plus size={10} /> {$t('片段特效')}</span>}
      {drop === 'mask' && <span className="badge replace-tag"><Plus size={10} /> {$t('片段遮罩')}</span>}
      {drop === 'replace' && <span className="badge replace-tag"><Replace size={10} /> {$t('取代')}</span>}
      {Math.abs(sp - 1) > 1e-3 && <span className="badge">{+sp.toFixed(2)}×</span>}
      <OpBadge k={key} />
      {ok && !isText && m!.hasAudio && m!.kind === 'video' && (la ? la.volume === 0 : c.volume === 0 && !c.audioSplit) && <span className="badge"><VolumeX size={10} /></span>}
      {la && (
        <div className="av-strip" title={$t('連結的音訊（右鍵「取消影音連結」可以分開成獨立的音訊片段）')}>
          {ok && <Waveform media={m!} inT={la.in} dur={la.duration * (la.rate ?? 1)} width={Math.max(4, c.duration * pps)} gain={{ volume: la.volume, fadeIn: la.fadeIn, fadeOut: la.fadeOut, len: la.duration }} />}
          {la.fadeIn > 0 && <div className="fade in" style={{ width: la.fadeIn * pps }} />}
          {la.fadeOut > 0 && <div className="fade out" style={{ width: la.fadeOut * pps }} />}
        </div>
      )}
      <div className="handle r" onPointerDown={(e) => resizeItem(e, 'clip', c, 'r', m?.kind === 'video', clipMaxDur(c))} />
    </div>
  );
});

const TransitionView = React.memo(function TransitionView({ c, prev, next, side, pps, sel, name }: { c: Clip; prev: Clip | undefined; next: Clip | undefined; side: TrSide; pps: number; sel: boolean; name: string }) {
  const w = transitionWindow(prev, c, side, next);
  if (!w) return null;
  const S = useStore.getState();
  const hint = w.mode === 'head' ? $t('從透明轉入') : w.mode === 'tail' ? $t('轉到透明') : '';
  return (
    <div
      className={`transition ${w.mode} ${sel ? 'sel' : ''}`}
      title={$t('{0}（拖兩側調整長度）', name) + (hint ? ` · ${hint}` : '')}
      style={{ left: w.t0 * pps, width: Math.max(14, w.d * pps) }}
      onPointerDown={(e) => {
        e.stopPropagation();
        if (e.button === 0) { stopPreviewFx(); S.select({ type: 'transition', id: trSelId(c.id, side) }); }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        transitionMenu(e.clientX, e.clientY, c, side);
      }}
    >
      {w.mode !== 'head' && <div className="handle l" onPointerDown={(e) => resizeTransition(e, c, side, 'l', w)} />}
      <span>{w.mode === 'head' ? <ArrowRightFromLine size={11} /> : w.mode === 'tail' ? <ArrowRightToLine size={11} /> : <ArrowRightLeft size={11} />} {w.d * pps > 60 ? name : ''}</span>
      {w.mode !== 'tail' && <div className="handle r" onPointerDown={(e) => resizeTransition(e, c, side, 'r', w)} />}
    </div>
  );
});

const FxView = React.memo(function FxView({ f, pps, sel, name, drop, masked }: { f: FxItem; pps: number; sel: boolean; name: string; drop: boolean; masked: boolean }) {
  const key = keyOf('effect', f.id);
  const preview = movePreview(key);
  const opCls = useOpCls(key);
  return (
    <div
      data-key={key}
      className={`fxitem ${sel ? 'sel' : ''} ${drop ? 'drop-hint replace' : ''} ${preview.moving ? 'move-ghost' : ''} ${preview.affected ? 'move-affected' : ''} ${opCls}`}
      style={{ left: f.start * pps, width: Math.max(4, f.duration * pps), '--overlap-left': `${preview.affected?.left ?? 0}px`, '--overlap-width': `${preview.affected?.width ?? 0}px` } as React.CSSProperties}
      onPointerDown={(e) => itemPointerDown(e, 'effect', f)}
      onDoubleClick={() => openItemEditor('effect', f.id)}
      onContextMenu={(e) => itemMenu(e, 'effect', f)}
    >
      <div className="handle l" onPointerDown={(e) => resizeItem(e, 'effect', f, 'l', false)} />
      {f.group && <Group size={11} className="link-ico" />}
      <span className="clip-name" title={`${name} · ${f.duration.toFixed(2)}s`}>{name}</span>
      {masked && <span className="badge" title={$t('有遮罩')}><CircleDashed size={10} /></span>}
      {drop && <span className="badge replace-tag"><Replace size={10} /> {$t('取代')}</span>}
      <OpBadge k={key} />
      <div className="handle r" onPointerDown={(e) => resizeItem(e, 'effect', f, 'r', false)} />
    </div>
  );
});

const AudioView = React.memo(function AudioView({ a, m, pps, sel }: { a: AudioClip; m: Media | undefined; pps: number; sel: boolean }) {
  const label = a.name ?? m?.name ?? $t('未知素材');
  const key = keyOf('audio', a.id);
  const preview = movePreview(key);
  const opCls = useOpCls(key);
  const ok = mediaUsable(m);
  const w = Math.max(4, a.duration * pps);
  return (
    <div
      data-key={key}
      className={`audioitem ${sel ? 'sel' : ''} ${ok ? '' : 'missing'} ${preview.moving ? 'move-ghost' : ''} ${preview.affected ? 'move-affected' : ''} ${opCls}`}
      style={{ left: a.start * pps, width: w, '--overlap-left': `${preview.affected?.left ?? 0}px`, '--overlap-width': `${preview.affected?.width ?? 0}px` } as React.CSSProperties}
      title={ok ? undefined : $t('素材遺失：右鍵「重新連結素材…」')}
      onPointerDown={(e) => itemPointerDown(e, 'audio', a)}
      onContextMenu={(e) => itemMenu(e, 'audio', a, m)}
    >
      {ok && <Waveform media={m} inT={a.in} dur={a.duration * (a.rate ?? 1)} width={w} gain={{ volume: a.volume, fadeIn: a.fadeIn, fadeOut: a.fadeOut, len: a.duration }} />}
      {Math.abs((a.rate ?? 1) - 1) > 1e-3 && <span className="badge">{+(a.rate ?? 1).toFixed(2)}×</span>}
      <OpBadge k={key} />
      {a.fadeIn > 0 && <div className="fade in" style={{ width: a.fadeIn * pps }} />}
      {a.fadeOut > 0 && <div className="fade out" style={{ width: a.fadeOut * pps }} />}
      <div className="handle l" onPointerDown={(e) => resizeItem(e, 'audio', a, 'l', true)} />
      {!ok && <TriangleAlert size={12} className="warn-ico" />}
      {a.link && <Link2 size={11} className="link-ico" />}
      {a.group && <Group size={11} className="link-ico" />}
      <span className="clip-name" title={`${label} · ${a.duration.toFixed(2)}s`}>{ok ? label : $t('遺失：{0}', label)}</span>
      <div className="handle r" onPointerDown={(e) => resizeItem(e, 'audio', a, 'r', true, ok ? m.duration : Infinity)} />
    </div>
  );
});

// ───────────────────────── 軌道層級（特效軌插在影片軌之間） ─────────────────────────

const rowH = (tracks: Tracks, kind: TrackKind, idx: number) => tracks[kind][idx]?.height ?? TRACK_H[kind];

/** 軌道在畫面上往上 / 下移一格（任何種類的軌道都可以互相交錯）；to = 'top' / 'bottom' 直接移到最上 / 最下 */
function moveRow(kind: TrackKind, idx: number, to: -1 | 1 | 'top' | 'bottom') {
  const S = useStore.getState();
  const rows = displayRows(S.tracks, S.upperAt);
  const i = rows.findIndex((r) => r.kind === kind && r.idx === idx);
  if (i < 0) return;
  const rest = rows.filter((_, j) => j !== i);
  const at = to === 'top' ? 0 : to === 'bottom' ? rest.length : Math.max(0, Math.min(rest.length, i + to));
  if (at === i) return;
  rest.splice(at, 0, rows[i]);
  S.reorderTracks(rest);
}

function fxLevelLabel(tracks: Tracks, idx: number) {
  const lv = fxLevel(tracks, idx);
  if (lv >= tracks.video.length) return $t('作用於所有影片軌');
  if (lv === 0) return $t('在所有影片軌下方（不會作用到任何影片）');
  return $t('只作用於「影片 1 ~ {0}」', lv);
}

// ───────────────────────── 時間軸 ─────────────────────────

type TrackDrag = { kind: TrackKind; from: number; over: { kind: TrackKind; idx: number; edge: 'top' | 'bottom' } | null };

export function Timeline() {
  const clips = useStore((s) => s.clips);
  const effects = useStore((s) => s.effects);
  const audios = useStore((s) => s.audios);
  const tracks = useStore((s) => s.tracks);
  const labelW = 180 + Math.max(0, Math.max(...(['video', 'fx', 'audio'] as TrackKind[]).map((k) => String(tracks[k].length).length)) - 2) * 9;
  const media = useStore((s) => s.media);
  const modules = useStore((s) => s.modules);
  const pps = useStore((s) => s.pps);
  const sel = useStore((s) => s.selection);
  const selected = useStore((s) => s.selected);
  const drag = useDrag((s) => s.drag);
  const placement = usePlacementPreview((s) => s.items);
  const upperAt = useLayout((s) => s.upperLayerAt);
  // store 需要知道顯示方向（新增軌道 / 取消連結時判斷「下面」是哪裡）
  useEffect(() => {
    if (useStore.getState().upperAt !== upperAt) useStore.setState({ upperAt });
  }, [upperAt]);
  const activeTrack = useStore((s) => s.activeTrack);
  const S = useStore.getState();
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [addTrack, setAddTrack] = useState<AddTrackState | null>(null);
  const [trackDrag, setTrackDrag] = useState<TrackDrag | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const hbarRef = useRef<HTMLDivElement>(null);
  /** 看得到的時間軸寬度（秒）與垂直捲軸寬度（自訂水平捲軸要扣掉） */
  const [view, setView] = useState({ w: 800, sbw: 0 });
  // 時間軸長度：預設 MIN_LEN 秒；專案更長就是專案長度再多 10%（不會無限往右延伸）；至少填滿看得到的寬度
  const dur = projectDuration({ clips, effects, audios });
  const end = Math.max(MIN_LEN, dur * 1.1 + 2, view.w / pps);
  /** 縮放時要固定在畫面上同一個位置的時間點（滑鼠 / 播放頭 / 畫面中間） */
  const zoomAnchor = useRef<{ t: number; off: number } | null>(null);
  // 縮放後、畫面繪製前就把捲動位置對好：不會先閃一幀錯的位置
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const a = zoomAnchor.current;
    zoomAnchor.current = null;
    if (!el || !a) return;
    el.scrollLeft = Math.max(0, a.t * pps - a.off);
    if (hbarRef.current) hbarRef.current.scrollLeft = el.scrollLeft;
  }, [pps]);
  const selSet = new Set(selected);

  const timeAt = (clientX: number) => Math.max(0, (clientX - innerRef.current!.getBoundingClientRect().left - labelW) / pps);

  // 用按鈕 / 選單加入項目後：捲到它並閃一下
  const reveal = useReveal((s) => s.n);
  useEffect(() => {
    if (!reveal) return;
    const sel = useStore.getState().selection;
    if (!sel) return;
    const el = innerRef.current?.querySelector<HTMLElement>(`[data-key="${sel.type}:${sel.id}"]`);
    if (!el) return;
    // 時間軸自己管水平捲動（overflow-x: hidden），scrollIntoView 不可靠：自己算
    const box = scrollRef.current;
    const it = sel.type === 'clip' || sel.type === 'effect' || sel.type === 'audio' ? (useStore.getState()[LIST[sel.type]] as AnyItem[]).find((x) => x.id === sel.id) : undefined;
    if (box && it) {
      const pps = useStore.getState().pps;
      const viewW = box.clientWidth - labelW;
      const a = it.start * pps, b = (it.start + it.duration) * pps;
      if (a < box.scrollLeft || a > box.scrollLeft + viewW - 40) box.scrollLeft = Math.max(0, a - Math.min(80, viewW / 4));
      else if (b > box.scrollLeft + viewW && b - a < viewW) box.scrollLeft = b - viewW + 20;
      const r = el.getBoundingClientRect(), v = box.getBoundingClientRect();
      if (r.top < v.top + 26) box.scrollTop -= v.top + 26 - r.top; // 尺規那一列（sticky）不要擋到
      else if (r.bottom > v.bottom) box.scrollTop += r.bottom - v.bottom;
    }
    if (!useReveal.getState().flash) return;
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
    const t = setTimeout(() => el.classList.remove('flash'), 1300);
    return () => clearTimeout(t);
  }, [reveal]);

  useEffect(() => {
    const el = scrollRef.current!;
    const onWheel = (e: WheelEvent) => {
      // 水平捲動（Shift + 滾輪、觸控板左右滑）：時間軸本身的水平捲軸藏起來了，自己處理
      if (!e.ctrlKey) {
        const dx = e.shiftKey ? e.deltaY || e.deltaX : Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : 0;
        if (dx) {
          e.preventDefault();
          el.scrollLeft += dx;
        }
        return;
      }
      e.preventDefault();
      const s = useStore.getState();
      const rect = el.getBoundingClientRect();
      const off = e.clientX - rect.left - labelW;
      const np = Math.min(PPS_MAX, Math.max(PPS_MIN, s.pps * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      if (np === s.pps) return;
      zoomAnchor.current = { t: (el.scrollLeft + off) / s.pps, off }; // 滑鼠底下的時間點不動
      s.setPps(np);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    // 時間軸至少填滿看得到的寬度；自訂水平捲軸跟時間軸同步
    const updView = () => {
      const w = el.clientWidth - labelW;
      const sbw = el.offsetWidth - el.clientWidth;
      setView((v) => (v.w === w && v.sbw === sbw ? v : { w, sbw }));
    };
    updView();
    const syncBar = () => {
      const bar = hbarRef.current;
      if (bar && Math.abs(bar.scrollLeft - el.scrollLeft) > 0.5) bar.scrollLeft = el.scrollLeft;
    };
    el.addEventListener('scroll', syncBar, { passive: true });
    const ro = new ResizeObserver(updView);
    ro.observe(el);
    // 其他方式縮放（滑桿、= / - 鍵、選單）：播放頭在畫面內就固定播放頭，否則固定畫面中間
    const unsub = useStore.subscribe((s, p) => {
      if (s.pps === p.pps || zoomAnchor.current) return;
      const viewW = el.clientWidth - labelW;
      const px = s.time * p.pps - el.scrollLeft;
      const off = px >= 0 && px <= viewW ? px : viewW / 2;
      zoomAnchor.current = { t: (el.scrollLeft + off) / p.pps, off };
    });
    const fit = () => {
      const dur = Math.max(1, projectDuration(useStore.getState()));
      const np = Math.min(PPS_MAX, Math.max(PPS_MIN, (el.clientWidth - labelW - 40) / dur));
      if (np !== useStore.getState().pps) zoomAnchor.current = { t: 0, off: 0 }; // 縮放沒變就不會重畫，不能留下錨點
      useStore.getState().setPps(np);
      el.scrollLeft = 0;
    };
    window.addEventListener('timeline-fit', fit);
    const reveal = () => {
      const x = useStore.getState().time * useStore.getState().pps;
      const viewW = el.clientWidth - labelW;
      if (x > el.scrollLeft + viewW - 40 || x < el.scrollLeft) el.scrollLeft = x - viewW / 2;
    };
    window.addEventListener('timeline-reveal-playhead', reveal);
    return () => {
      el.removeEventListener('scroll', syncBar);
      ro.disconnect();
      unsub();
      el.removeEventListener('wheel', onWheel);
      window.removeEventListener('timeline-fit', fit);
      window.removeEventListener('timeline-reveal-playhead', reveal);
    };
  }, []);

  /** 在尺規拖曳定位播放頭：即時預覽 */
  const scrub = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    stopPreviewFx();
    // 播放頭對齊到 1/60 秒一格
    S.setTime(snapFrame(timeAt(e.clientX)));
    document.body.classList.add('resizing-v');
    listen(
      (ev) => {
        setScrubbing(true); // 真的拖了才播聲音（單擊不出聲）
        S.setTime(snapFrame(timeAt(ev.clientX)));
      },
      () => {
        setScrubbing(false);
        document.body.classList.remove('resizing-v');
      },
    );
  };

  /** 框選：在空白處按住拖曳 */
  const startMarquee = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    stopPreviewFx();
    const additive = e.ctrlKey || e.metaKey || e.shiftKey;
    const base = additive ? useStore.getState().selected : [];
    const x0 = e.clientX, y0 = e.clientY;
    let moved = false;
    listen(
      (ev) => {
        if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return;
        moved = true;
        const r = { x0, y0, x1: ev.clientX, y1: ev.clientY };
        setMarquee(r);
        const L = Math.min(r.x0, r.x1), R = Math.max(r.x0, r.x1), T = Math.min(r.y0, r.y1), B = Math.max(r.y0, r.y1);
        const hits: string[] = [];
        innerRef.current!.querySelectorAll<HTMLElement>('[data-key]').forEach((el) => {
          const b = el.getBoundingClientRect();
          if (b.right >= L && b.left <= R && b.bottom >= T && b.top <= B) hits.push(el.dataset.key!);
        });
        useStore.getState().selectKeys(Array.from(new Set([...base, ...hits])));
      },
      () => {
        setMarquee(null);
        if (!moved && !additive) useStore.getState().select(null);
      },
    );
  };

  /**
   * 拖曳軌道標籤改順序。影片 / 音訊：同類型之間；
   * 特效軌：可以拖到影片軌之間（決定它作用在哪些影片軌上）
   */
  const startTrackDrag = (e: React.PointerEvent, kind: TrackKind, idx: number) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button, .tl-resize')) return;
    e.preventDefault();
    const y0 = e.clientY;
    let moved = false;
    let over: TrackDrag['over'] = null;
    listen(
      (ev) => {
        if (!moved && Math.abs(ev.clientY - y0) < 4) return;
        moved = true;
        over = null;
        for (const el of document.elementsFromPoint(ev.clientX, ev.clientY)) {
          const d = (el as HTMLElement).dataset;
          if (!d?.rowKind) continue;
          // 任何軌道都可以拖到任何位置：滑鼠在目標軌道的上半 = 插在它上面、下半 = 下面
          const r = (el as HTMLElement).getBoundingClientRect();
          over = { kind: d.rowKind as TrackKind, idx: Number(d.rowIdx), edge: ev.clientY < r.top + r.height / 2 ? 'top' : 'bottom' };
          break;
        }
        setTrackDrag({ kind, from: idx, over });
      },
      () => {
        setTrackDrag(null);
        if (!moved) return useStore.getState().setActiveTrack({ kind, idx });
        if (!over) return;
        const st = useStore.getState();
        const rows = displayRows(st.tracks, st.upperAt);
        const from = rows.findIndex((r) => r.kind === kind && r.idx === idx);
        const target = rows.findIndex((r) => r.kind === over!.kind && r.idx === over!.idx);
        if (from < 0 || target < 0 || from === target) return;
        const rest = rows.filter((_, i) => i !== from);
        const at = Math.max(0, Math.min(rest.length, rest.indexOf(rows[target]) + (over.edge === 'bottom' ? 1 : 0)));
        rest.splice(at, 0, rows[from]);
        if (rest.every((r, i) => r === rows[i])) return;
        st.reorderTracks(rest);
      },
    );
  };

  /** 拖軌道標籤下緣：改軌道高度（雙擊恢復預設） */
  const startResize = (e: React.PointerEvent, kind: TrackKind, idx: number) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const h0 = rowH(useStore.getState().tracks, kind, idx);
    const y0 = e.clientY;
    document.body.classList.add('resizing-h');
    listen(
      (ev) => useStore.getState().setTrackHeight(kind, idx, h0 + ev.clientY - y0),
      () => document.body.classList.remove('resizing-h'),
    );
  };

  // 給 memo 的子元件一個固定的 callback
  const scrubRef = useRef(scrub);
  scrubRef.current = scrub;
  const stableScrub = useCallback((e: React.PointerEvent) => scrubRef.current(e), []);

  const openAddTrack = (x: number, y: number, kind: TrackKind, above: number | null) => setAddTrack({ x, y, kind, above });

  const laneMenu = (e: React.MouseEvent, kind: TrackKind, idx: number) => {
    e.preventDefault();
    const t = timeAt(e.clientX);
    openMenu(e.clientX, e.clientY, [
      { label: $t('貼上到這裡'), shortcut: 'Ctrl+V', action: S.clipboard ? () => pasteTimeline({ time: t, track: idx, kind }, { x: e.clientX, y: e.clientY }) : undefined },
      ...(useStore.getState().loop ? [{ label: $t('停止循環'), action: () => useStore.getState().setLoop(null) }] : []),
      ...(kind === 'video' ? [{ label: $t('在這裡加入文字'), action: () => S.addText('title', t, idx) }] : []),
      { separator: true },
      { label: $t('新增軌道…'), action: () => openAddTrack(e.clientX, e.clientY, kind, idx) },
    ]);
  };

  const labelMenu = (e: React.MouseEvent, kind: TrackKind, idx: number) => {
    e.preventDefault();
    const st = tracks[kind][idx];
    const items: MenuItem[] = [
      { label: $t('新增軌道…'), action: () => openAddTrack(e.clientX, e.clientY, kind, idx) },
      { separator: true },
      { label: st.hidden ? $t('顯示軌道') : $t('隱藏軌道'), action: kind !== 'audio' ? () => S.toggleTrack(kind, idx, 'hidden') : undefined },
      { label: st.muted ? $t('取消靜音') : $t('靜音'), action: kind !== 'fx' ? () => S.toggleTrack(kind, idx, 'muted') : undefined },
      { label: st.locked ? $t('解鎖軌道') : $t('鎖定軌道'), action: () => S.toggleTrack(kind, idx, 'locked') },
      { label: $t('恢復預設高度'), action: st.height ? () => S.setTrackHeight(kind, idx, undefined) : undefined },
    ];
    {
      const rows = displayRows(tracks, useStore.getState().upperAt);
      const i = rows.findIndex((r) => r.kind === kind && r.idx === idx);
      items.push(
        { separator: true },
        { label: $t('移到最上方'), action: i > 0 ? () => moveRow(kind, idx, 'top') : undefined },
        { label: $t('移到最下方'), action: i < rows.length - 1 ? () => moveRow(kind, idx, 'bottom') : undefined },
      );
    }
    items.push(
      { separator: true },
      {
        label: $t('刪除軌道'),
        danger: true,
        action: async () => {
          const st = useStore.getState();
          if (kind === 'video' && st.tracks.video.length <= 1) return toast($t('至少要保留一條影片軌'), 'error');
          const n = st.trackItemCount(kind, idx);
          if (n > 0) {
            const ok = await confirmDialog({
              title: $t('刪除軌道？'),
              message: $t('「{0} {1}」上還有 {2} 個項目，會一起被刪除（可以用 Ctrl+Z 復原）。', NAMES[kind], idx + 1, n),
              ok: $t('刪除'),
              danger: true,
            });
            if (!ok) return;
          }
          useStore.getState().deleteTrack(kind, idx);
        },
      },
    );
    openMenu(e.clientX, e.clientY, items);
  };

  const modName = (id: string) => { const m = modules.find((x) => x.id === id); return m ? displayName(m.name) : $t('（遺失模組）'); };
  const isSel = (type: ItemType, id: string) => selSet.has(keyOf(type, id));
  const mediaOf = (id: string) => media.find((m) => m.id === id);
  const dropClip = drag?.target?.kind === 'clip' ? drag.target : null;
  const dropFx = drag?.target?.kind === 'effect' ? drag.target.fxId : null;
  const dropThumb = drag?.payload.kind === 'media' ? mediaOf(drag.payload.id)?.thumb : undefined;

  // 影片 / 特效軌的上下順序：預設上層顯示在下方（可在設定切換）
  const attached = attachedAudioIds({ clips, audios });
  // 所有軌道的顯示順序：音訊軌可以排在任何位置（新增的軌道放在最下面）
  const rows = displayRows(tracks, upperAt);

  const renderLane = (kind: TrackKind, idx: number) => {
    if (kind === 'video') {
      const sorted = sortClips(clips.filter((c) => c.track === idx));
      return sorted.map((c, i) => {
        const isDrop = dropClip?.clipId === c.id ? dropClip.action : null;
        return (
          <React.Fragment key={c.id}>
            <ClipView
              c={c}
              m={c.text ? undefined : mediaOf(c.mediaId)}
              la={linkedAudioOf({ audios }, c)}
              name={itemName('clip', c, media, modules)}
              pps={pps}
              sel={isSel('clip', c.id)}
              remapName={c.remap.moduleId !== 'remap-speed' ? modName(c.remap.moduleId) : null}
              drop={isDrop}
              dropThumb={isDrop === 'relink' || isDrop === 'replace' ? dropThumb : undefined}
            />
            {c.transitionIn && (
              <TransitionView c={c} prev={sorted[i - 1]} next={sorted[i + 1]} side="in" pps={pps} sel={sel?.type === 'transition' && sel.id === c.id} name={modName(c.transitionIn.moduleId)} />
            )}
            {c.transitionOut && (
              <TransitionView c={c} prev={sorted[i - 1]} next={sorted[i + 1]} side="out" pps={pps} sel={sel?.type === 'transition' && sel.id === trSelId(c.id, 'out')} name={modName(c.transitionOut.moduleId)} />
            )}
            {isDrop === 'transition' && <div className="transition ghost" style={{ left: (c.start - 0.2) * pps, width: 0.4 * pps }}><ArrowRightLeft size={11} /></div>}
            {isDrop === 'transitionOut' && <div className="transition ghost" style={{ left: (c.start + c.duration - 0.4) * pps, width: 0.4 * pps }}><ArrowRightToLine size={11} /></div>}
          </React.Fragment>
        );
      });
    }
    if (kind === 'fx') {
      return effects
        .filter((f) => f.track === idx)
        .map((f) => (
          <FxView key={f.id} f={f} pps={pps} sel={isSel('effect', f.id)} name={f.name ?? modName(f.moduleId)} drop={dropFx === f.id} masked={!!f.mask && f.mask.shape !== 'none'} />
        ));
    }
    return audios.filter((a) => a.track === idx && !attached.has(a.id)).map((a) => <AudioView key={a.id} a={a} m={mediaOf(a.mediaId)} pps={pps} sel={isSel('audio', a.id)} />);
  };

  /** 拖曳中：在目標位置顯示淡淡的「放開後的樣子」 */
  const ghostFor = (kind: TrackKind, idx: number) => {
    const batch = drag?.target?.kind === 'lane' ? drag.target.items?.filter((g) => g.kind === kind && g.track === idx) : undefined;
    if (batch) return batch.map((g, i) => <div
      key={`${g.id}:${i}`}
      className={`${kind === 'video' ? 'clip' : 'audioitem'} drop-ghost`}
      style={{ left: g.start * pps, width: Math.max(8, g.duration * pps), backgroundImage: g.thumb ? `url(${g.thumb})` : undefined }}
    ><span className="clip-name">{g.label}</span></div>);
    const g = drag?.target?.kind === 'lane' && drag.target.lane === kind && drag.target.idx === idx ? drag.target : null;
    if (!g) return null;
    const cls = kind === 'video' ? 'clip' : kind === 'fx' ? 'fxitem' : 'audioitem';
    const color = drag?.payload.kind === 'color' ? drag.payload.color : undefined;
    return (
      <div
        className={`${cls} drop-ghost`}
        style={{
          left: g.time * pps,
          width: Math.max(8, g.duration * pps),
          backgroundImage: kind === 'video' && dropThumb ? `url(${dropThumb})` : undefined,
          background: color,
        }}
      >
        <span className="clip-name">{g.label}</span>
      </div>
    );
  };

  const pendingFor = (kind: TrackKind, idx: number) => placement
    .filter((g) => KIND_OF[g.type] === kind && g.track === idx)
    .map((g, i) => (
      <div
        key={`${g.type}:${g.track}:${g.start}:${i}`}
        className={`${kind === 'video' ? 'clip' : kind === 'fx' ? 'fxitem' : 'audioitem'} drop-ghost placement-ghost`}
        style={{ left: g.start * pps, width: Math.max(8, g.duration * pps), backgroundImage: g.thumb ? `url(${g.thumb})` : undefined }}
      >
        <span className="clip-name">{g.label}</span>
      </div>
    ));

  /** 特效軌的層級分隔：上一列是特效、這一列是影片時畫一條線，提示特效只作用到線以下 */
  const fxBoundary = (i: number) => !!rows[i - 1] && rows[i].kind !== 'audio' && rows[i - 1].kind !== 'audio' && rows[i].kind !== rows[i - 1].kind;

  return (
    <div
      className="timeline"
      style={{ '--tl-label-w': `${labelW}px` } as React.CSSProperties}
      onPointerDownCapture={(e) => {
        // 跟時間軸互動 → 其他輸入框（例如素材庫的搜尋）失去焦點，Ctrl+Z 等快捷鍵才會作用在時間軸
        const ae = document.activeElement as HTMLElement | null;
        if (ae && ae !== document.body && !(e.currentTarget as HTMLElement).contains(ae)) ae.blur();
        // 跟時間軸互動 → 預覽面板回到時間軸畫面
        stopPreviewFx();
        closeSource();
      }}
    >
      <TimelineToolbar />
      <div className="tl-scroll" ref={scrollRef}>
        <div className="tl-inner" ref={innerRef} style={{ width: labelW + end * pps }}>
          <div className="tl-row ruler-row">
            <div className="tl-label corner" />
            <Ruler end={end} pps={pps} onPointerDown={stableScrub} />
          </div>

          {rows.map(({ kind, idx }, i) => {
            const st = tracks[kind][idx];
            const h = rowH(tracks, kind, idx);
            const dragging = trackDrag?.kind === kind && trackDrag.from === idx;
            const ov = trackDrag?.over && trackDrag.over.kind === kind && trackDrag.over.idx === idx && !dragging ? trackDrag.over.edge : null;
            const compact = h < 34;
            return (
              <div
                key={kind + idx}
                className={`tl-row ${kind} ${st.locked ? 'locked' : ''} ${activeTrack?.kind === kind && activeTrack.idx === idx ? 'active' : ''} ${dragging ? 'row-dragging' : ''} ${ov ? `row-drop drop-${ov}` : ''} ${fxBoundary(i) ? 'fx-boundary' : ''} ${compact ? 'compact' : ''}`}
                style={{ height: h }}
                data-row-kind={kind}
                data-row-idx={idx}
              >
                <div
                  className="tl-label"
                  onPointerDown={(e) => startTrackDrag(e, kind, idx)}
                  onContextMenu={(e) => labelMenu(e, kind, idx)}
                  title={kind === 'fx' ? $t('{0}\n拖曳到影片軌之間改變作用範圍，右鍵更多選項', fxLevelLabel(tracks, idx)) : $t('拖曳到任何位置調整順序（影片 / 特效 / 音訊軌可以交錯），下緣拖曳調整高度，右鍵更多選項')}
                >
                  <span className="tl-name">{ICONS[kind]} {NAMES[kind]} {idx + 1}</span>
                  <span className="track-btns">
                    <button className={st.locked ? 'off' : ''} title={st.locked ? $t('解鎖軌道') : $t('鎖定軌道')} onPointerDown={(e) => e.stopPropagation()} onClick={() => S.toggleTrack(kind, idx, 'locked')}>{st.locked ? <Lock size={13} /> : <Unlock size={13} />}</button>
                    {kind !== 'audio' && (
                      <button className={st.hidden ? 'off' : ''} title={$t('顯示 / 隱藏')} onClick={() => S.toggleTrack(kind, idx, 'hidden')}>{st.hidden ? <EyeOff size={13} /> : <Eye size={13} />}</button>
                    )}
                    {kind !== 'fx' && (
                      <button className={st.muted ? 'off' : ''} title={$t('靜音')} onClick={() => S.toggleTrack(kind, idx, 'muted')}>{st.muted ? <VolumeX size={13} /> : <Volume2 size={13} />}</button>
                    )}
                  </span>
                  <div
                    className="tl-resize"
                    title={$t('拖曳調整軌道高度（雙擊恢復預設）')}
                    onPointerDown={(e) => startResize(e, kind, idx)}
                    onDoubleClick={() => S.setTrackHeight(kind, idx, undefined)}
                  />
                </div>
                <div
                  className={`lane ${st.hidden ? 'hidden' : ''} ${st.locked ? 'locked' : ''}`}
                  data-lane-kind={kind}
                  data-lane-idx={idx}
                  onPointerDown={(e) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.button === 0 && !st.locked) useStore.getState().setActiveTrack({ kind, idx });
                    if (st.locked) return;
                    startMarquee(e);
                  }}
                  onContextMenu={(e) => laneMenu(e, kind, idx)}
                >
                  {renderLane(kind, idx)}
                  {ghostFor(kind, idx)}
                  {pendingFor(kind, idx)}
                  {!drag && kind === 'video' && idx === 0 && clips.length === 0 && <div className="track-hint">{$t('把素材拖到這裡')}</div>}
                  {!drag && kind === 'fx' && idx === 0 && effects.length === 0 && <div className="track-hint">{$t('把特效拖到這裡')}</div>}
                  {!drag && kind === 'audio' && idx === 0 && audios.every((a) => attached.has(a.id)) && <div className="track-hint">{$t('把音樂拖到這裡')}</div>}
                </div>
              </div>
            );
          })}

          <div className="tl-row add-row">
            <div className="tl-label add">
              <button className="add-main" title={$t('新增軌道（可一次新增多條）')} onClick={(e) => openAddTrack(e.clientX, e.clientY - 200, 'video', null)}><Plus size={14} /> {$t('新增軌道')}</button>
            </div>
            <div className="lane add-lane" onPointerDown={(e) => e.target === e.currentTarget && startMarquee(e)}>
              <div className="quick-wrap">
              {KINDS.map((k) => (
                <button
                  key={k}
                  className={`quick-add ${k}`}
                  title={$t('新增一條{0}軌（{1}）', NAMES[k], $t('最下方'))}
                  onClick={() => {
                    const b = bottomSlot(k);
                    S.addTrack(k, b.at, b.level);
                    toast($t('已新增{0}軌', NAMES[k]));
                  }}
                >
                  <Plus size={12} /> {ICONS[k]} {NAMES[k]}
                </button>
              ))}
              </div>
            </div>
          </div>

          <div className="tl-overlay" style={{ left: labelW }}>
            <BeatLines pps={pps} />
            <Playhead pps={pps} labelW={labelW} scrollRef={scrollRef} />
            <SnapLine pps={pps} />
          </div>
        </div>
      </div>
      {marquee && (
        <div
          className="marquee"
          style={{
            left: Math.min(marquee.x0, marquee.x1),
            top: Math.min(marquee.y0, marquee.y1),
            width: Math.abs(marquee.x1 - marquee.x0),
            height: Math.abs(marquee.y1 - marquee.y0),
          }}
        />
      )}
      {addTrack && <AddTrackPanel state={addTrack} close={() => setAddTrack(null)} />}
      <div className="tl-hbar" ref={hbarRef} style={{ marginLeft: labelW, marginRight: view.sbw }} onScroll={(e) => {
        const el = scrollRef.current;
        const x = (e.currentTarget as HTMLDivElement).scrollLeft;
        if (el && Math.abs(el.scrollLeft - x) > 0.5) el.scrollLeft = x;
      }}>
        <div style={{ width: end * pps, height: 1 }} />
      </div>
    </div>
  );
}

// 縮放滑桿用對數刻度：5 ~ 1200 px/s（放到最大一格 1/60 秒 = 20px）
const ZMIN = PPS_MIN, ZMAX = PPS_MAX;
const toSlider = (pps: number) => (Math.log(pps / ZMIN) / Math.log(ZMAX / ZMIN)) * 1000;
const fromSlider = (v: number) => ZMIN * Math.pow(ZMAX / ZMIN, v / 1000);

function TimelineToolbar() {
  const { canUndo, canRedo } = useHistory();
  const snap = useStore((s) => s.snap);
  const pps = useStore((s) => s.pps);
  const beatsOn = useLayout((s) => s.beats);
  const S = useStore.getState();
  return (
    <div className="tl-toolbar">
      <button className="tbtn" disabled={!canUndo} onClick={undo} title={$t('復原 (Ctrl+Z)')}><Undo2 size={15} /></button>
      <button className="tbtn" disabled={!canRedo} onClick={redo} title={$t('重做 (Ctrl+Shift+Z)')}><Redo2 size={15} /></button>
      <span className="sep" />
      <button className="tbtn" onClick={S.split} title={$t('在播放頭分割 (S)')}><Scissors size={14} /> <span className="tb-lbl">{$t('分割')}</span></button>
      <button className={`tbtn ${snap ? 'on' : ''}`} onClick={() => S.setSnap(!snap)} title={$t('磁吸對齊 (N)')}><Magnet size={14} /> <span className="tb-lbl">{$t('磁吸')}</span></button>
      <button
        className={`tbtn ${beatsOn ? 'on' : ''}`}
        title={$t('節拍格線與節拍指令')}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          openMenu(r.left, r.bottom + 2, [
            { label: $t('顯示節拍格線'), checked: beatsOn, action: () => useLayout.getState().set({ beats: !beatsOn }) },
            {
              label: $t('節拍間隔'),
              submenu: [
                { label: $t('每拍'), checked: useLayout.getState().beatDivision === 1, action: () => useLayout.getState().set({ beatDivision: 1 }) },
                { label: $t('半拍'), checked: useLayout.getState().beatDivision === 2, action: () => useLayout.getState().set({ beatDivision: 2 }) },
                { label: $t('四分之一拍'), checked: useLayout.getState().beatDivision === 4, action: () => useLayout.getState().set({ beatDivision: 4 }) },
              ],
            },
            { separator: true },
            ...beatMenuItems(),
          ]);
        }}
      >
        <Drum size={14} /> <span className="tb-lbl">{$t('節拍')}</span> <ChevronDown size={11} />
      </button>
      <span className="spacer" />
      <input className="zoom" type="range" min={0} max={1000} value={toSlider(pps)} onChange={(e) => S.setPps(fromSlider(+e.target.value))} title={$t('時間軸縮放（Ctrl+滾輪）')} />
      <button className="tbtn" onClick={() => window.dispatchEvent(new Event('timeline-fit'))} title={$t('整個專案符合視窗 (\\)')}><ArrowLeftRight size={14} /> <span className="tb-lbl">{$t('符合')}</span></button>
    </div>
  );
}

/** 波形跟著音量走：音量 × 淡入淡出（跟 audio.ts 一樣是線性），音量 0 就是一條線 */
type Gain = { volume: number; fadeIn: number; fadeOut: number; len: number };
const gainAt = (g: Gain | undefined, local: number) => {
  if (!g) return 1;
  let f = 1;
  if (g.fadeIn > 0) f = Math.min(f, local / g.fadeIn);
  if (g.fadeOut > 0) f = Math.min(f, (g.len - local) / g.fadeOut);
  return g.volume * Math.min(1, Math.max(0, f));
};

function Waveform({ media, inT, dur, width, gain }: { media: Media; inT: number; dur: number; width: number; gain?: Gain }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const gv = gain?.volume, gi = gain?.fadeIn, go = gain?.fadeOut, gl = gain?.len;
  useEffect(() => {
    const c = ref.current;
    const peaks = media.peaks;
    if (!c) return;
    const W = Math.max(1, Math.min(8192, Math.round(width)));
    const H = 40;
    c.width = W;
    c.height = H;
    const g = c.getContext('2d')!;
    const draw = (levels: ArrayLike<number>) => {
      g.clearRect(0, 0, W, H);
      g.fillStyle = 'rgba(110, 231, 200, 0.75)';
      for (let x = 0; x < W; x++) {
        const k = gainAt(gain, gain ? ((x + 0.5) / W) * gain.len : 0);
        const h = Math.max(1, Math.min(1, (levels[x] ?? 0) * k) * H);
        g.fillRect(x, (H - h) / 2, 1, h);
      }
    };
    if (peaks && media.peaksPerSec) {
      const ps = media.peaksPerSec;
      const levels = new Array<number>(W);
      for (let x = 0; x < W; x++) {
        const i0 = Math.floor((inT + (x / W) * dur) * ps);
        const i1 = Math.max(i0, Math.floor((inT + ((x + 1) / W) * dur) * ps));
        let m = 0;
        for (let i = i0; i <= i1 && i < peaks.length; i++) m = Math.max(m, peaks[i]);
        levels[x] = m;
      }
      draw(levels);
    }
    let alive = true;
    void getAudioBuffer(media.url).then((buf) => {
      if (!alive || !buf) return;
      const channels = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i));
      draw(waveformLevels(channels, buf.sampleRate, inT, dur, W, audioBufferPeak(buf)));
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [media, inT, dur, width, gv, gi, go, gl]);
  return <canvas ref={ref} className="wave" />;
}

const Ruler = React.memo(function Ruler({ end, pps, onPointerDown }: { end: number; pps: number; onPointerDown: (e: React.PointerEvent) => void }) {
  // 放大到最後，最小的刻度是 1/60 秒（一格）；有數字的刻度用整數格數算，不會累積誤差
  const { major, minor } = rulerSteps(pps);
  const n = Math.round(major * 60);
  const ticks: number[] = [];
  for (let f = 0; f / 60 <= end; f += n) ticks.push(f / 60);
  const loop = useStore((s) => s.loop);
  const w = minor * pps;
  return (
    <div className="ruler" onPointerDown={onPointerDown} style={{ backgroundImage: `repeating-linear-gradient(90deg, #ffffff12 0 1px, transparent 1px ${w}px)` }}>
      {ticks.map((s) => (
        <div key={s} className="tick" style={{ left: s * pps }}>
          {rulerLabel(s, major)}
        </div>
      ))}
      {loop && <div className="loop-region" style={{ left: loop.a * pps, width: (loop.b - loop.a) * pps }} />}
      <BeatMarks pps={pps} />
      <RulerHead pps={pps} />
    </div>
  );
});

/** 播放頭在尺規上的頭；獨立訂閱時間，播放時不用重畫整排刻度 */
/** 太密的節拍不畫（每拍至少要隔這麼多 px） */
const BEAT_MIN_PX = 6;

/** 尺規上的節拍刻度：重拍比較長 */
function BeatMarks({ pps }: { pps: number }) {
  const beats = useBeats();
  if (!beats.length) return null;
  const dense = beats.length > 1 && ((beats[beats.length - 1].t - beats[0].t) / (beats.length - 1)) * pps < BEAT_MIN_PX;
  return (
    <>
      {beats.map((b) => (dense && !b.down ? null : <div key={b.t} className={`beat-mark ${b.down ? 'down' : ''}`} style={{ left: b.t * pps }} />))}
    </>
  );
}

/** 跨過所有軌道的節拍線（重拍；放大到夠寬時每一拍都畫） */
function BeatLines({ pps }: { pps: number }) {
  const beats = useBeats();
  if (!beats.length) return null;
  const spacing = beats.length > 1 ? ((beats[beats.length - 1].t - beats[0].t) / (beats.length - 1)) * pps : Infinity;
  return (
    <>
      {beats.map((b) => (b.down || spacing >= 24 ? <div key={b.t} className={`beat-line ${b.down ? 'down' : ''}`} style={{ transform: `translateX(${b.t * pps}px)` }} /> : null))}
    </>
  );
}

function RulerHead({ pps }: { pps: number }) {
  const t = useStore((s) => s.time);
  return <div className="ruler-playhead" style={{ transform: `translateX(${t * pps}px)` }} />;
}

/** 滑鼠按著（拖曳片段 / 播放頭）時，播放頭跑出畫面不要自動捲動 */
let pointerHeld = false;
window.addEventListener('pointerdown', () => (pointerHeld = true), true);
window.addEventListener('pointerup', () => (pointerHeld = false), true);
window.addEventListener('blur', () => (pointerHeld = false));

function Playhead({ pps, labelW, scrollRef }: { pps: number; labelW: number; scrollRef: React.RefObject<HTMLDivElement> }) {
  const t = useStore((s) => s.time);
  const playing = useStore((s) => s.playing);
  const x = t * pps;
  const ppsRef = useRef(pps);
  useEffect(() => {
    const el = scrollRef.current;
    // 縮放造成的位移不算（Ctrl+滾輪會自己對準滑鼠位置）
    const zoomed = ppsRef.current !== pps;
    ppsRef.current = pps;
    if (!el || zoomed) return;
    const viewW = el.clientWidth - labelW;
    const out = x > el.scrollLeft + viewW - 40 || x < el.scrollLeft;
    if (!out) return;
    if (playing) el.scrollLeft = x - 80;
    // 暫停時（Home / End、方向鍵、跳剪接點…）：播放頭跑出畫面就捲到置中；滑鼠拖曳中不動，避免畫面亂跳
    else if (!pointerHeld) el.scrollLeft = x - viewW / 2;
  }, [x, pps, labelW, playing, scrollRef]);
  return <div className="playhead" style={{ transform: `translateX(${x}px)` }} />;
}

/** 吸附時的垂直參考線（跨所有軌道） */
function SnapLine({ pps }: { pps: number }) {
  const t = useSnapLine((s) => s.t);
  if (t === null) return null;
  return <div className="snap-line" style={{ transform: `translateX(${t * pps}px)` }} />;
}
