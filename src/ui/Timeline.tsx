import React, { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import {
  KIND_OF, LIST, itemSpeed, keyOf, mediaUsable, parseKey, projectDuration, stretchPatch, useStore,
  type AnyItem, type AudioClip, type Clip, type FxItem, type ItemType, type Media, type TrackKind,
} from '../store';
import { sortClips, transitionWindow, makeCtx } from '../engine/renderer';
import { plainSpeed } from '../engine/remap';
import { undo, redo, useHistory } from '../engine/history';
import { relinkWithPicker } from '../engine/media';
import { openMenu, stopPreviewFx, toast, useDrag, type MenuItem } from './uiStore';

const SNAP_PX = 8;
const LABEL_W = 116;
const NAMES: Record<TrackKind, string> = { fx: '特效', video: '影片', audio: '音訊' };
const ICONS: Record<TrackKind, string> = { fx: '✨', video: '🎞', audio: '🎵' };

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
  const pts = [0, s.time];
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
      useOp.setState({ op: { key, kind: 'slip', text: `素材起點 ${v.toFixed(2)}s / ${m.duration.toFixed(1)}s` } });
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
  document.body.classList.add('stretching');
  listen(
    (ev) => {
      const edge = nearest(edge0 + (ev.clientX - x0) / pps, pts, pps).v;
      // 速度限制 0.1× ~ 10×
      const sc = Math.min(10, Math.max(0.1, (edge - anchor) / (edge0 - anchor || 1e-6)));
      const patches: Record<string, Partial<AnyItem>> = {};
      for (const g of group) patches[keyOf(g.type, g.it.id)] = stretchPatch(g.type, g.it, anchor, sc);
      useStore.getState().patchItems(patches);
      useOp.setState({ op: { key, kind: 'stretch', text: `${(sp0 / sc).toFixed(2)}×`, keys } });
    },
    () => {
      document.body.classList.remove('stretching');
      useOp.setState({ op: null });
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
function itemPointerDown(e: React.PointerEvent, type: ItemType, it: AnyItem) {
  if (e.button !== 0) return;
  e.stopPropagation();
  e.preventDefault();
  stopPreviewFx();
  if (e.altKey && (type === 'clip' || type === 'audio')) return slipItem(e, type, it);
  const S = useStore.getState();
  const key = keyOf(type, it.id);
  if (e.ctrlKey || e.metaKey) return S.select({ type, id: it.id }, 'toggle');
  if (e.shiftKey) return S.select({ type, id: it.id }, 'range');
  const already = S.selected.includes(key);
  if (!already) S.select({ type, id: it.id });
  else useStore.setState({ selection: { type, id: it.id }, leftTab: 'editor' });

  const st = useStore.getState();
  const group = st.selected
    .map(parseKey)
    .map(({ type: t, id }) => ({ type: t, it: (st[LIST[t]] as AnyItem[]).find((x) => x.id === id)! }))
    .filter((g) => g.it);
  const pps = st.pps;
  const pts = snapPoints(new Set(st.selected));
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
      if (a.d <= b.d && a.d !== Infinity) dt = a.v - it.start;
      else if (b.d !== Infinity) dt = b.v - it.start - it.duration;
      dt = Math.max(-minStart, dt);
      const lane = laneAt(ev, kind);
      let dTrack = lane === null ? 0 : lane - it.track;
      const n = useStore.getState().tracks[kind].length;
      for (const g of group) {
        if (KIND_OF[g.type] !== kind) continue;
        dTrack = Math.max(-g.it.track, Math.min(n - 1 - g.it.track, dTrack));
      }
      const patches: Record<string, Partial<AnyItem>> = {};
      for (const g of group) {
        const p: Partial<AnyItem> = { start: g.it.start + dt };
        if (KIND_OF[g.type] === kind) p.track = g.it.track + dTrack;
        patches[keyOf(g.type, g.it.id)] = p;
      }
      useStore.getState().patchItems(patches);
    },
    () => {
      if (!moved && already && useStore.getState().selected.length > 1) S.select({ type, id: it.id });
    },
  );
}

function resizeItem(e: React.PointerEvent, type: ItemType, it: AnyItem, side: 'l' | 'r', hasIn: boolean, maxEnd = Infinity) {
  if (e.button !== 0) return;
  e.stopPropagation();
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) return stretchItems(e, type, it, side);
  const S = useStore.getState();
  S.select({ type, id: it.id });
  const pps = S.pps;
  const pts = snapPoints(new Set([keyOf(type, it.id)]));
  const end = it.start + it.duration;
  const inT = (it as Clip).in ?? 0;
  const x0 = e.clientX;
  listen((ev) => {
    const d = (ev.clientX - x0) / pps;
    let patch: Partial<Clip>;
    if (side === 'r') {
      const ne = nearest(Math.max(it.start + 0.05, end + d), pts, pps).v;
      patch = { duration: Math.min(maxEnd - inT, Math.max(0.05, ne - it.start)) };
    } else {
      let s = nearest(it.start + d, pts, pps).v;
      const minS = hasIn ? Math.max(0, it.start - inT / (itemSpeed(type, it) ?? 1)) : 0;
      s = Math.min(end - 0.05, Math.max(minS, s));
      patch = { start: s, duration: end - s };
      // 素材起點跟著移動（考慮速度：2× 時拉 1 秒 = 素材 2 秒）
      if (hasIn) patch.in = Math.max(0, inT + (s - it.start) * (itemSpeed(type, it) ?? 1));
    }
    useStore.getState().patchItems({ [keyOf(type, it.id)]: patch });
  });
}

/** 拖轉場的左右邊緣改長度（以剪接點為中心，兩邊對稱） */
function resizeTransition(e: React.PointerEvent, c: Clip, side: 'l' | 'r', maxD: number) {
  e.stopPropagation();
  e.preventDefault();
  const S = useStore.getState();
  S.select({ type: 'transition', id: c.id });
  const d0 = Math.min(c.transitionIn!.duration, maxD);
  const x0 = e.clientX;
  listen((ev) => {
    const dx = ((ev.clientX - x0) / S.pps) * 2 * (side === 'r' ? 1 : -1);
    useStore.getState().updateTransition(c.id, { duration: Math.round(Math.min(maxD, Math.max(0.05, d0 + dx)) * 100) / 100 });
  });
}

function itemMenu(e: React.MouseEvent, type: ItemType, it: AnyItem, media?: Media) {
  e.preventDefault();
  e.stopPropagation();
  const S = useStore.getState();
  if (!S.selected.includes(keyOf(type, it.id))) S.select({ type, id: it.id });
  const n = useStore.getState().selected.length;
  const items: MenuItem[] = [
    { label: '在播放頭分割', shortcut: 'S', action: S.split },
    { label: '修剪開頭到播放頭', shortcut: 'Q', action: () => S.trim('start') },
    { label: '修剪結尾到播放頭', shortcut: 'W', action: () => S.trim('end') },
    { separator: true },
    { label: n > 1 ? `複製 ${n} 個項目` : '複製', shortcut: 'Ctrl+C', action: S.copy },
    { label: '剪下', shortcut: 'Ctrl+X', action: S.cut },
    { label: '貼上到播放頭', shortcut: 'Ctrl+V', action: S.clipboard ? () => S.paste() : undefined },
    { label: '再製', shortcut: 'Ctrl+D', action: S.duplicate },
    { separator: true },
    { label: '循環預覽此段', action: () => S.setLoop({ a: it.start, b: it.start + it.duration }) },
  ];
  if ((type === 'clip' || type === 'audio') && media) {
    items.push({ label: mediaUsable(media) ? '替換素材…' : '重新連結素材…', action: () => relinkWithPicker(media.id) });
  }
  items.push(
    { separator: true },
    { label: '刪除', shortcut: 'Del', action: () => S.removeSelection() },
    { label: '波紋刪除', shortcut: 'Shift+Del', action: () => S.removeSelection(true), danger: true },
  );
  openMenu(e.clientX, e.clientY, items);
}

// ───────────────────────── 新增軌道面板 ─────────────────────────

interface AddTrackState { x: number; y: number; kind: TrackKind; above: number | null }

/** 依軌道類型列出「放在哪一軌上方」，並換算成插入的 index */
function positionOptions(kind: TrackKind, n: number) {
  // 影片 / 特效：index 大的在上面；音訊：index 小的在上面
  const order = kind === 'audio' ? [...Array(n).keys()] : [...Array(n).keys()].reverse();
  const opts = order.map((i) => ({ label: `「${NAMES[kind]} ${i + 1}」上方`, at: kind === 'audio' ? i : i + 1 }));
  opts.push({ label: '最下方', at: kind === 'audio' ? n : 0 });
  return opts;
}

function AddTrackPanel({ state, close }: { state: AddTrackState; close: () => void }) {
  const tracks = useStore((s) => s.tracks);
  const [kind, setKind] = useState<TrackKind>(state.kind);
  const opts = positionOptions(kind, tracks[kind].length);
  const defAt = kind === state.kind && state.above !== null ? (kind === 'audio' ? state.above : state.above + 1) : opts[0].at;
  const [at, setAt] = useState<number>(defAt);
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

  return (
    <div ref={ref} className="popover" style={{ left: pos.x, top: pos.y }}>
      <div className="pop-title">新增軌道</div>
      <div className="seg">
        {(['video', 'fx', 'audio'] as TrackKind[]).map((k) => (
          <button
            key={k}
            className={kind === k ? 'on' : ''}
            onClick={() => {
              setKind(k);
              setAt(positionOptions(k, tracks[k].length)[0].at);
            }}
          >
            {ICONS[k]} {NAMES[k]}
          </button>
        ))}
      </div>
      <label className="pop-row">
        <span>位置</span>
        <select className="select" value={at} onChange={(e) => setAt(+e.target.value)}>
          {opts.map((o) => <option key={o.label} value={o.at}>{o.label}</option>)}
        </select>
      </label>
      <div className="dialog-actions">
        <button className="btn" onClick={close}>取消</button>
        <button className="btn primary" onClick={() => { useStore.getState().addTrack(kind, at); close(); }}>新增</button>
      </div>
    </div>
  );
}

// ───────────────────────── 時間軸 ─────────────────────────

/** 拖曳中：顯示倍率 / 素材起點 */
function OpBadge({ k }: { k: string }) {
  const op = useOp((s) => (s.op?.key === k ? s.op : null));
  if (!op) return null;
  return <span className={`op-badge ${op.kind}`}>{op.kind === 'stretch' ? `⏩ ${op.text}` : `⇆ ${op.text}`}</span>;
}

export function Timeline() {
  const op = useOp((s) => s.op);
  const opCls = (k: string) => (op?.kind === 'stretch' && op.keys?.includes(k) ? 'op-stretch' : op?.kind === 'slip' && op.key === k ? 'op-slip' : '');
  const clips = useStore((s) => s.clips);
  const effects = useStore((s) => s.effects);
  const audios = useStore((s) => s.audios);
  const tracks = useStore((s) => s.tracks);
  const media = useStore((s) => s.media);
  const modules = useStore((s) => s.modules);
  const pps = useStore((s) => s.pps);
  const sel = useStore((s) => s.selection);
  const selected = useStore((s) => s.selected);
  const drag = useDrag((s) => s.drag);
  const S = useStore.getState();
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [addTrack, setAddTrack] = useState<AddTrackState | null>(null);
  const [trackDrag, setTrackDrag] = useState<{ kind: TrackKind; from: number; over: number } | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const end = Math.max(projectDuration({ clips, effects, audios }) + 8, 20);
  const selSet = new Set(selected);

  const timeAt = (clientX: number) => Math.max(0, (clientX - innerRef.current!.getBoundingClientRect().left - LABEL_W) / pps);

  useEffect(() => {
    const el = scrollRef.current!;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const s = useStore.getState();
      const rect = el.getBoundingClientRect();
      const off = e.clientX - rect.left - LABEL_W;
      const tAt = (el.scrollLeft + off) / s.pps;
      const np = Math.min(800, Math.max(5, s.pps * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      s.setPps(np);
      requestAnimationFrame(() => (el.scrollLeft = tAt * np - off));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    const fit = () => {
      const dur = Math.max(1, projectDuration(useStore.getState()));
      useStore.getState().setPps((el.clientWidth - LABEL_W - 40) / dur);
      el.scrollLeft = 0;
    };
    window.addEventListener('timeline-fit', fit);
    return () => {
      el.removeEventListener('wheel', onWheel);
      window.removeEventListener('timeline-fit', fit);
    };
  }, []);

  /** 拖播放頭（尺規或播放頭本身）：即時預覽 */
  const scrub = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    stopPreviewFx();
    S.setTime(timeAt(e.clientX));
    document.body.classList.add('resizing-v');
    listen(
      (ev) => S.setTime(timeAt(ev.clientX)),
      () => document.body.classList.remove('resizing-v'),
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

  /** 拖曳軌道標籤改順序（同類型之間） */
  const startTrackDrag = (e: React.PointerEvent, kind: TrackKind, idx: number) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    const y0 = e.clientY;
    let moved = false;
    let over = idx;
    listen(
      (ev) => {
        if (!moved && Math.abs(ev.clientY - y0) < 4) return;
        moved = true;
        for (const el of document.elementsFromPoint(ev.clientX, ev.clientY)) {
          const d = (el as HTMLElement).dataset;
          if (d?.rowKind === kind) {
            over = Number(d.rowIdx);
            break;
          }
        }
        setTrackDrag({ kind, from: idx, over });
      },
      () => {
        setTrackDrag(null);
        if (moved && over !== idx) S.moveTrack(kind, idx, over);
      },
    );
  };

  const openAddTrack = (x: number, y: number, kind: TrackKind, above: number | null) => setAddTrack({ x, y, kind, above });

  const laneMenu = (e: React.MouseEvent, kind: TrackKind, idx: number) => {
    e.preventDefault();
    const t = timeAt(e.clientX);
    openMenu(e.clientX, e.clientY, [
      { label: '貼上到這裡', shortcut: 'Ctrl+V', action: S.clipboard ? () => S.paste({ time: t, track: idx, kind }) : undefined },
      { label: '播放頭移到這裡', action: () => S.setTime(t) },
      { label: '全選', shortcut: 'Ctrl+A', action: S.selectAll },
      { separator: true },
      { label: '新增軌道…', action: () => openAddTrack(e.clientX, e.clientY, kind, idx) },
    ]);
  };

  const labelMenu = (e: React.MouseEvent, kind: TrackKind, idx: number) => {
    e.preventDefault();
    const st = tracks[kind][idx];
    openMenu(e.clientX, e.clientY, [
      { label: '新增軌道…', action: () => openAddTrack(e.clientX, e.clientY, kind, idx) },
      { separator: true },
      { label: st.hidden ? '顯示軌道' : '隱藏軌道', action: kind !== 'audio' ? () => S.toggleTrack(kind, idx, 'hidden') : undefined },
      { label: st.muted ? '取消靜音' : '靜音', action: kind !== 'fx' ? () => S.toggleTrack(kind, idx, 'muted') : undefined },
      { separator: true },
      {
        label: '刪除軌道',
        danger: true,
        action: () => !S.deleteTrack(kind, idx) && toast('只能刪除空的軌道，而且每種至少要留一條', 'error'),
      },
    ]);
  };

  const modName = (id: string) => modules.find((m) => m.id === id)?.name ?? '（遺失模組）';
  const isSel = (type: ItemType, id: string) => selSet.has(keyOf(type, id));
  const mediaOf = (id: string) => media.find((m) => m.id === id);
  const dropClip = drag?.target?.kind === 'clip' ? drag.target : null;
  const dropThumb = drag?.payload.kind === 'media' ? mediaOf(drag.payload.id)?.thumb : undefined;

  const rows: { kind: TrackKind; idx: number }[] = [
    ...tracks.fx.map((_, i) => ({ kind: 'fx' as const, idx: i })).reverse(),
    ...tracks.video.map((_, i) => ({ kind: 'video' as const, idx: i })).reverse(),
    ...tracks.audio.map((_, i) => ({ kind: 'audio' as const, idx: i })),
  ];

  const renderLane = (kind: TrackKind, idx: number) => {
    if (kind === 'video') {
      const sorted = sortClips(clips.filter((c) => c.track === idx));
      return sorted.map((c, i) => {
        const m = mediaOf(c.mediaId);
        const ok = mediaUsable(m);
        const prev = sorted[i - 1];
        const w = c.transitionIn ? transitionWindow(prev, c) : null;
        const isDrop = dropClip?.clipId === c.id;
        const relinkGhost = isDrop && dropClip!.action === 'relink' && dropThumb;
        return (
          <React.Fragment key={c.id}>
            <div
              data-key={keyOf('clip', c.id)}
              className={`clip ${isSel('clip', c.id) ? 'sel' : ''} ${ok && !relinkGhost ? '' : 'missing'} ${isDrop ? 'drop-hint' : ''} ${opCls(keyOf('clip', c.id))}`}
              style={{
                left: c.start * pps,
                width: Math.max(4, c.duration * pps),
                backgroundImage: relinkGhost ? `url(${dropThumb})` : ok && m.thumb ? `url(${m.thumb})` : undefined,
              }}
              title={ok ? undefined : '素材遺失：把素材拖到這裡、或右鍵「重新連結素材…」'}
              onPointerDown={(e) => itemPointerDown(e, 'clip', c)}
              onContextMenu={(e) => itemMenu(e, 'clip', c, m)}
            >
              <div className="handle l" onPointerDown={(e) => resizeItem(e, 'clip', c, 'l', m?.kind === 'video')} />
              <span className="clip-name">{ok ? m.name : `⚠ 遺失：${(m as Media | undefined)?.name ?? '未知素材'}`}</span>
              {c.remap.moduleId !== 'remap-speed' && <span className="badge">⏱ {modName(c.remap.moduleId)}</span>}
              {Math.abs((itemSpeed('clip', c) ?? 1) - 1) > 1e-3 && <span className="badge">{+(itemSpeed('clip', c) ?? 1).toFixed(2)}×</span>}
              <OpBadge k={keyOf('clip', c.id)} />
              {ok && m.hasAudio && m.kind === 'video' && c.volume === 0 && <span className="badge">🔇</span>}
              <div className="handle r" onPointerDown={(e) => resizeItem(e, 'clip', c, 'r', m?.kind === 'video', clipMaxDur(c))} />
            </div>
            {c.transitionIn && (
              <div
                className={`transition ${sel?.type === 'transition' && sel.id === c.id ? 'sel' : ''} ${w ? '' : 'invalid'}`}
                title={w ? `${modName(c.transitionIn.moduleId)}（拖兩側調整長度）` : '轉場需要前一個片段緊貼在這個片段前面'}
                style={w ? { left: w.t0 * pps, width: Math.max(14, w.d * pps) } : { left: c.start * pps - 7, width: 14 }}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  if (e.button === 0) { stopPreviewFx(); S.select({ type: 'transition', id: c.id }); }
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  openMenu(e.clientX, e.clientY, [
                    { label: '編輯轉場', action: () => S.select({ type: 'transition', id: c.id }) },
                    { label: '移除轉場', action: () => S.setTransition(c.id, null), danger: true },
                  ]);
                }}
              >
                {w && <div className="handle l" onPointerDown={(e) => resizeTransition(e, c, 'l', Math.min(prev.duration, c.duration))} />}
                <span>⧓ {w && w.d * pps > 60 ? modName(c.transitionIn.moduleId) : ''}</span>
                {w && <div className="handle r" onPointerDown={(e) => resizeTransition(e, c, 'r', Math.min(prev.duration, c.duration))} />}
              </div>
            )}
            {isDrop && dropClip!.action === 'transition' && (
              <div className="transition ghost" style={{ left: (c.start - 0.2) * pps, width: 0.4 * pps }}>⧓</div>
            )}
          </React.Fragment>
        );
      });
    }
    if (kind === 'fx') {
      return effects.filter((f) => f.track === idx).map((f: FxItem) => (
        <div
          key={f.id}
          data-key={keyOf('effect', f.id)}
          className={`fxitem ${isSel('effect', f.id) ? 'sel' : ''} ${opCls(keyOf('effect', f.id))}`}
          style={{ left: f.start * pps, width: Math.max(4, f.duration * pps) }}
          onPointerDown={(e) => itemPointerDown(e, 'effect', f)}
          onContextMenu={(e) => itemMenu(e, 'effect', f)}
        >
          <div className="handle l" onPointerDown={(e) => resizeItem(e, 'effect', f, 'l', false)} />
          <span className="clip-name">{modName(f.moduleId)}</span>
          <OpBadge k={keyOf('effect', f.id)} />
          <div className="handle r" onPointerDown={(e) => resizeItem(e, 'effect', f, 'r', false)} />
        </div>
      ));
    }
    return audios.filter((a) => a.track === idx).map((a: AudioClip) => {
      const m = mediaOf(a.mediaId);
      const ok = mediaUsable(m);
      const w = Math.max(4, a.duration * pps);
      return (
        <div
          key={a.id}
          data-key={keyOf('audio', a.id)}
          className={`audioitem ${isSel('audio', a.id) ? 'sel' : ''} ${ok ? '' : 'missing'} ${opCls(keyOf('audio', a.id))}`}
          style={{ left: a.start * pps, width: w }}
          title={ok ? undefined : '素材遺失：右鍵「重新連結素材…」'}
          onPointerDown={(e) => itemPointerDown(e, 'audio', a)}
          onContextMenu={(e) => itemMenu(e, 'audio', a, m)}
        >
          {ok && <Waveform media={m} inT={a.in} dur={a.duration * (a.rate ?? 1)} width={w} />}
          {Math.abs((a.rate ?? 1) - 1) > 1e-3 && <span className="badge">{+(a.rate ?? 1).toFixed(2)}×</span>}
          <OpBadge k={keyOf('audio', a.id)} />
          {a.fadeIn > 0 && <div className="fade in" style={{ width: a.fadeIn * pps }} />}
          {a.fadeOut > 0 && <div className="fade out" style={{ width: a.fadeOut * pps }} />}
          <div className="handle l" onPointerDown={(e) => resizeItem(e, 'audio', a, 'l', true)} />
          <span className="clip-name">{ok ? m.name : `⚠ 遺失：${(m as Media | undefined)?.name ?? '未知素材'}`}</span>
          <div className="handle r" onPointerDown={(e) => resizeItem(e, 'audio', a, 'r', true, ok ? m.duration : Infinity)} />
        </div>
      );
    });
  };

  /** 拖曳中：在目標位置顯示淡淡的「放開後的樣子」 */
  const ghostFor = (kind: TrackKind, idx: number) => {
    const g = drag?.target?.kind === 'lane' && drag.target.lane === kind && drag.target.idx === idx ? drag.target : null;
    if (!g) return null;
    const cls = kind === 'video' ? 'clip' : kind === 'fx' ? 'fxitem' : 'audioitem';
    return (
      <div
        className={`${cls} drop-ghost`}
        style={{ left: g.time * pps, width: Math.max(8, g.duration * pps), backgroundImage: kind === 'video' && dropThumb ? `url(${dropThumb})` : undefined }}
      >
        <span className="clip-name">{g.label}</span>
      </div>
    );
  };

  return (
    <div className="timeline">
      <TimelineToolbar />
      <div className="tl-scroll" ref={scrollRef}>
        <div className="tl-inner" ref={innerRef} style={{ width: LABEL_W + end * pps }}>
          <div className="tl-row ruler-row">
            <div className="tl-label corner" />
            <Ruler end={end} pps={pps} onPointerDown={scrub} />
          </div>

          {rows.map(({ kind, idx }) => {
            const st = tracks[kind][idx];
            const td = trackDrag && trackDrag.kind === kind && trackDrag.over === idx && trackDrag.from !== idx;
            return (
              <div key={kind + idx} className={`tl-row ${kind} ${trackDrag?.kind === kind && trackDrag.from === idx ? 'row-dragging' : ''} ${td ? 'row-drop' : ''}`} data-row-kind={kind} data-row-idx={idx}>
                <div className="tl-label" onPointerDown={(e) => startTrackDrag(e, kind, idx)} onContextMenu={(e) => labelMenu(e, kind, idx)} title="拖曳調整順序，右鍵更多選項">
                  <span>{ICONS[kind]} {NAMES[kind]} {idx + 1}</span>
                  <span className="track-btns">
                    {kind !== 'audio' && (
                      <button className={st.hidden ? 'off' : ''} title="顯示 / 隱藏" onClick={() => S.toggleTrack(kind, idx, 'hidden')}>{st.hidden ? '◌' : '👁'}</button>
                    )}
                    {kind !== 'fx' && (
                      <button className={st.muted ? 'off' : ''} title="靜音" onClick={() => S.toggleTrack(kind, idx, 'muted')}>{st.muted ? '🔇' : '🔊'}</button>
                    )}
                  </span>
                </div>
                <div
                  className={`lane ${st.hidden ? 'hidden' : ''}`}
                  data-lane-kind={kind}
                  data-lane-idx={idx}
                  onPointerDown={(e) => e.target === e.currentTarget && startMarquee(e)}
                  onContextMenu={(e) => laneMenu(e, kind, idx)}
                >
                  {renderLane(kind, idx)}
                  {ghostFor(kind, idx)}
                  {!drag && kind === 'video' && idx === 0 && clips.length === 0 && <div className="track-hint">把素材拖到這裡（或在素材上雙擊）</div>}
                  {!drag && kind === 'fx' && idx === 0 && effects.length === 0 && <div className="track-hint">把特效拖到這裡</div>}
                  {!drag && kind === 'audio' && idx === 0 && audios.length === 0 && <div className="track-hint">把音樂拖到這裡</div>}
                </div>
              </div>
            );
          })}

          <div className="tl-row add-row">
            <div className="tl-label add">
              <button title="新增軌道" onClick={(e) => openAddTrack(e.clientX, e.clientY - 160, 'video', null)}>＋</button>
            </div>
            <div className="lane" onPointerDown={startMarquee} />
          </div>

          <div className="tl-overlay" style={{ left: LABEL_W }}>
            <Playhead pps={pps} scrollRef={scrollRef} onPointerDown={scrub} />
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
    </div>
  );
}

// 縮放滑桿用對數刻度：5 ~ 800 px/s
const ZMIN = 5, ZMAX = 800;
const toSlider = (pps: number) => (Math.log(pps / ZMIN) / Math.log(ZMAX / ZMIN)) * 1000;
const fromSlider = (v: number) => ZMIN * Math.pow(ZMAX / ZMIN, v / 1000);

function TimelineToolbar() {
  const { canUndo, canRedo } = useHistory();
  const snap = useStore((s) => s.snap);
  const pps = useStore((s) => s.pps);
  const S = useStore.getState();
  return (
    <div className="tl-toolbar">
      <button className="tbtn" disabled={!canUndo} onClick={undo} title="復原 (Ctrl+Z)">↶</button>
      <button className="tbtn" disabled={!canRedo} onClick={redo} title="重做 (Ctrl+Shift+Z)">↷</button>
      <span className="sep" />
      <button className="tbtn" onClick={S.split} title="在播放頭分割 (S)">✂ 分割</button>
      <button className={`tbtn ${snap ? 'on' : ''}`} onClick={() => S.setSnap(!snap)} title="磁吸對齊 (N)">🧲 磁吸</button>
      <span className="spacer" />
      <input className="zoom" type="range" min={0} max={1000} value={toSlider(pps)} onChange={(e) => S.setPps(fromSlider(+e.target.value))} title="時間軸縮放（Ctrl+滾輪）" />
      <button className="tbtn" onClick={() => window.dispatchEvent(new Event('timeline-fit'))} title="整個專案符合視窗 (\)">⇔ 符合</button>
    </div>
  );
}

function Waveform({ media, inT, dur, width }: { media: Media; inT: number; dur: number; width: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    const peaks = media.peaks;
    if (!c || !peaks || !media.peaksPerSec) return;
    const W = Math.max(1, Math.min(4096, Math.round(width)));
    const H = 40;
    c.width = W;
    c.height = H;
    const g = c.getContext('2d')!;
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(110, 231, 200, 0.75)';
    const ps = media.peaksPerSec;
    for (let x = 0; x < W; x++) {
      const i0 = Math.floor((inT + (x / W) * dur) * ps);
      const i1 = Math.max(i0, Math.floor((inT + ((x + 1) / W) * dur) * ps));
      let m = 0;
      for (let i = i0; i <= i1 && i < peaks.length; i++) m = Math.max(m, peaks[i]);
      const h = Math.max(1, m * H);
      g.fillRect(x, (H - h) / 2, 1, h);
    }
  }, [media, inT, dur, width]);
  return <canvas ref={ref} className="wave" />;
}

function Ruler({ end, pps, onPointerDown }: { end: number; pps: number; onPointerDown: (e: React.PointerEvent) => void }) {
  const step = pps >= 200 ? 0.5 : pps >= 60 ? 1 : pps >= 25 ? 2 : pps >= 10 ? 5 : 10;
  const ticks = [];
  for (let s = 0; s <= end; s += step) ticks.push(s);
  const loop = useStore((s) => s.loop);
  const t = useStore((s) => s.time);
  return (
    <div className="ruler" onPointerDown={onPointerDown}>
      {ticks.map((s) => (
        <div key={s} className="tick" style={{ left: s * pps }}>
          {Number.isInteger(s) ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : ''}
        </div>
      ))}
      {loop && <div className="loop-region" style={{ left: loop.a * pps, width: (loop.b - loop.a) * pps }} />}
      {/* 播放頭在尺規上的頭（覆蓋在刻度上面，可直接拖） */}
      <div className="ruler-playhead" style={{ transform: `translateX(${t * pps}px)` }} />
    </div>
  );
}

function Playhead({ pps, scrollRef, onPointerDown }: { pps: number; scrollRef: React.RefObject<HTMLDivElement>; onPointerDown: (e: React.PointerEvent) => void }) {
  const t = useStore((s) => s.time);
  const playing = useStore((s) => s.playing);
  const x = t * pps;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !playing) return;
    const viewW = el.clientWidth - LABEL_W;
    if (x > el.scrollLeft + viewW - 40 || x < el.scrollLeft) el.scrollLeft = x - 80;
  }, [x, playing, scrollRef]);
  return (
    <div className="playhead" style={{ transform: `translateX(${x}px)` }}>
      <div className="playhead-hit" onPointerDown={onPointerDown} />
    </div>
  );
}
