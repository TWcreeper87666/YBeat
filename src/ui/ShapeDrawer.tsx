import { $t } from '../i18n';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { Eye, Redo2, Trash2, Undo2 } from 'lucide-react';
import { fitPen, handleIn, handleOut, insertPoint, movePts, nearestOnPath, penBounds, penToPath, penToShape, ptsInRect, type PenPt } from '../engine/penPath';
import { DEFAULT_MASK } from '../engine/mask';
import { useMaskLib } from '../engine/maskShapes';
import { getRenderer, makeCtx } from '../engine/renderer';
import { useStore } from '../store';
import { drawTarget, timeInside, type DrawTarget } from './MaskEditor';
import { GridButton, GridOverlay } from './GridOverlay';
import { closePicker } from './Library';
import { toast, useLayout } from './uiStore';

/**
 * 鋼筆工具：在目前的畫面上畫遮罩形狀（存進遮罩形狀庫的「自訂」，有對象時順便套用到那個遮罩）。
 * 畫的時候：點一下 = 直角點、按住拖曳 = 拉出曲線把手、點第一個點 / Enter = 封閉。
 * 錨點：點選 / Ctrl、Shift 加選、拖空白處框選、Ctrl+A 全選，選取的點一起拖、方向鍵微調。
 * 「前後對照」按住 = 顯示套用前的畫面。
 */

interface DrawerState { open: boolean; id?: string; target?: string; onSaved?: (id: string) => void }
const useDrawer = create<DrawerState>(() => ({ open: false }));

/**
 * 打開鋼筆工具。
 * id：編輯既有的自訂形狀；target：畫好後套用到哪個遮罩（`fx:<id>` / `cfx:<id>` / `clip:<片段 id>`），也決定背景畫面怎麼算。
 */
export function openShapeDrawer(o: { id?: string; target?: string; onSaved?: (id: string) => void } = {}) {
  if (o.target) {
    const t = timeInside(o.target);
    if (t !== null && t !== useStore.getState().time) useStore.setState({ time: t, playing: false });
  }
  useStore.setState({ playing: false });
  closePicker(); // 從遮罩形狀的挑選視窗打開的：挑選視窗收起來
  useDrawer.setState({ open: true, ...o });
}

export function ShapeDrawerHost() {
  const s = useDrawer();
  if (!s.open) return null;
  return (
    <ShapeDrawer
      key={`${s.id ?? 'new'}|${s.target ?? ''}`}
      id={s.id}
      targetKey={s.target}
      onSaved={s.onSaved}
      close={() => useDrawer.setState({ open: false, id: undefined, target: undefined, onSaved: undefined })}
    />
  );
}

type Snap = { pts: PenPt[]; closed: boolean };

function listen(onMove: (ev: PointerEvent) => void, onUp?: (ev: PointerEvent) => void) {
  const up = (ev: PointerEvent) => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', up);
    onUp?.(ev);
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', up);
}

/** Shift：以 (ox, oy) 為中心把方向鎖在 45° 的倍數 */
function snap45(ox: number, oy: number, x: number, y: number): [number, number] {
  const dx = x - ox, dy = y - oy;
  const len = Math.hypot(dx, dy);
  const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  return [ox + Math.cos(a) * len, oy + Math.sin(a) * len];
}

// ───────────── 背景畫面 ─────────────

interface Frames { before: HTMLCanvasElement; off: HTMLCanvasElement; on: HTMLCanvasElement }

function copyCanvas(src: HTMLCanvasElement) {
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  c.getContext('2d')!.drawImage(src, 0, 0);
  return c;
}

/**
 * 用預覽的渲染器畫出：對象沒作用（off）/ 不受遮罩限制（on）兩張畫面，畫完立刻畫回原本的畫面。
 * 沒有對象 = 目前的畫面。
 */
function captureFrames(t: DrawTarget | null): Frames | null {
  const r = getRenderer();
  const st = useStore.getState();
  if (!r || st.exporting) return null;
  const shot = (s: typeof st) => {
    r.render(makeCtx(s), st.time, 'preview', false);
    return copyCanvas(r.canvas);
  };
  const off = t ? shot(t.off(st)) : null;
  const on = t ? shot(t.on(st)) : null;
  const now = shot(st);
  if (!t) return { before: now, off: now, on: now };
  // 套用前：片段遮罩 = 整個片段都看得到；特效遮罩 = 沒有這個特效
  return { before: t.cut ? on! : off!, off: off!, on: on! };
}

/** 對話框裡畫面的大小（照輸出比例塞進視窗） */
function useStageSize(W: number, H: number) {
  const calc = () => {
    const maxW = Math.min(window.innerWidth - 64, 1100), maxH = window.innerHeight * 0.7;
    const k = Math.min(maxW / W, maxH / H);
    return { w: Math.max(120, W * k), h: Math.max(120, H * k) };
  };
  const [sz, setSz] = useState(calc);
  useEffect(() => {
    const f = () => setSz(calc());
    window.addEventListener('resize', f);
    return () => window.removeEventListener('resize', f);
  });
  return sz;
}

function ShapeDrawer({ id, targetKey, onSaved, close }: { id?: string; targetKey?: string; onSaved?: (id: string) => void; close: () => void }) {
  const lib = useMaskLib();
  const { w: W, h: H } = useStore((s) => s.format);
  const [target] = useState(() => (targetKey ? drawTarget(targetKey) : null));
  const editing = id ? lib.customs.find((c) => c.id === id) : undefined;
  const [snap, setSnap] = useState<Snap>(() => {
    // 有對象：接著編輯它目前的路徑（遮罩自己的，或形狀庫裡鋼筆畫的），放回遮罩框在畫面上的位置
    const m = target?.mask;
    const own = m?.shape === 'path' ? m.pen : m ? lib.customs.find((c) => c.id === m.shape)?.pen : undefined;
    if (m && own?.length) {
      const cx = (0.5 + m.x) * W, cy = (0.5 + m.y) * H, hw = (m.w * W) / 2, hh = (m.h * H) / 2;
      return { pts: fitPen(own, { x0: cx - hw, y0: cy - hh, x1: cx + hw, y1: cy + hh }, m.rotation), closed: true };
    }
    // 編輯形狀庫的形狀：放在畫面中央
    const pen = editing?.pen;
    if (!pen?.length) return { pts: [], closed: false };
    let h = H * 0.5, w = h * (editing!.aspect || 1);
    if (w > W * 0.8) [w, h] = [W * 0.8, (W * 0.8) / (editing!.aspect || 1)];
    return { pts: fitPen(pen, { x0: (W - w) / 2, y0: (H - h) / 2, x1: (W + w) / 2, y1: (H + h) / 2 }), closed: true };
  });
  const [sel, setSelState] = useState<number[]>([]);
  const [hover, setHover] = useState<[number, number] | null>(null);
  const [marquee, setMarquee] = useState<[number, number, number, number] | null>(null);
  const [before, setBefore] = useState(false);
  const [frames, setFrames] = useState<Frames | null>(null);
  const [name, setName] = useState(editing?.name ?? $t('形狀 {0}', lib.customs.length + 1));
  const svgRef = useRef<SVGSVGElement>(null);
  const viewRef = useRef<HTMLCanvasElement>(null);
  const cur = useRef(snap);
  cur.current = snap;
  const selRef = useRef(sel);
  selRef.current = sel;
  const past = useRef<Snap[]>([]);
  const future = useRef<Snap[]>([]);
  const { pts, closed } = snap;
  const stage = useStageSize(W, H);

  // ── 檢視縮放 / 平移：滾輪縮放（以滑鼠為中心）、中鍵或按住空白鍵拖曳平移 ──
  const [view, setView] = useState({ z: 1, px: 0, py: 0 });
  const viewRefState = useRef(view);
  viewRefState.current = view;
  const stageRef = useRef<HTMLDivElement>(null);
  const space = useRef(false);
  const resetView = () => setView({ z: 1, px: 0, py: 0 });
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = viewRefState.current;
      const r = el.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      const z = Math.min(16, Math.max(0.5, v.z * Math.pow(1.0015, -e.deltaY)));
      const k = z / v.z;
      setView({ z, px: mx - (mx - v.px) * k, py: my - (my - v.py) * k });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);
  const onStageDownCapture = (e: React.PointerEvent) => {
    if (e.button !== 1 && !(e.button === 0 && space.current)) return;
    e.preventDefault();
    e.stopPropagation();
    const v0 = viewRefState.current, x0 = e.clientX, y0 = e.clientY;
    document.body.classList.add('panning');
    listen(
      (ev) => setView({ ...v0, px: v0.px + ev.clientX - x0, py: v0.py + ev.clientY - y0 }),
      () => document.body.classList.remove('panning'),
    );
  };
  useEffect(() => {
    const up = (e: KeyboardEvent) => e.code === 'Space' && (space.current = false);
    window.addEventListener('keyup', up, true);
    return () => window.removeEventListener('keyup', up, true);
  }, []);

  const setSel = (l: number[]) => {
    const v = [...new Set(l)].sort((a, b) => a - b);
    selRef.current = v;
    setSelState(v);
  };

  // 背景畫面：影片 seek 需要一點時間，開啟後再補抓幾次
  useEffect(() => {
    const grab = () => {
      const f = captureFrames(target);
      if (f) setFrames(f);
    };
    grab();
    const ts = [150, 500, 1200].map((ms) => setTimeout(grab, ms));
    return () => ts.forEach(clearTimeout);
  }, [target]);

  // 合成：套用後 = off 上面疊「遮罩範圍內的 on」（羽化、反轉照遮罩設定）
  const mask = target?.mask ?? DEFAULT_MASK;
  useLayoutEffect(() => {
    const c = viewRef.current;
    if (!c || !frames) return;
    const { off, on } = frames;
    if (c.width !== off.width || c.height !== off.height) {
      c.width = off.width;
      c.height = off.height;
    }
    const g = c.getContext('2d')!;
    g.clearRect(0, 0, c.width, c.height);
    // 套用前 / 沒有對象 / 還不成形狀：原本的畫面
    // 路徑封閉之前遮罩還沒生效：照原本的畫面畫（才看得到要描的東西）
    if (before || !target || !closed) {
      g.drawImage(frames.before, 0, 0);
      return;
    }
    const k = c.width / W;
    const m = document.createElement('canvas');
    m.width = c.width;
    m.height = c.height;
    const mg = m.getContext('2d')!;
    const blur = mask.feather * H * k * 0.5;
    if (blur > 0.3) mg.filter = `blur(${blur}px)`;
    mg.setTransform(k, 0, 0, k, 0, 0);
    mg.fillStyle = '#fff';
    mg.fill(new Path2D(penToPath(pts, true)), 'evenodd');
    const lay = document.createElement('canvas');
    lay.width = c.width;
    lay.height = c.height;
    const lg = lay.getContext('2d')!;
    lg.drawImage(on, 0, 0);
    lg.globalCompositeOperation = mask.invert ? 'destination-out' : 'destination-in';
    lg.drawImage(m, 0, 0);
    g.drawImage(off, 0, 0);
    g.drawImage(lay, 0, 0);
  }, [frames, pts, closed, before, target, mask.feather, mask.invert, W, H]);

  /** 開始一個會改內容的動作前先記下來（復原用） */
  const commit = () => {
    past.current.push(cur.current);
    if (past.current.length > 200) past.current.shift();
    future.current = [];
  };
  const set = (s: Snap) => {
    cur.current = s;
    setSnap(s);
  };
  const undo = () => {
    const p = past.current.pop();
    if (!p) return;
    future.current.push(cur.current);
    set(p);
    setSel([]);
  };
  const redo = () => {
    const f = future.current.pop();
    if (!f) return;
    past.current.push(cur.current);
    set(f);
    setSel([]);
  };

  const at = (e: { clientX: number; clientY: number }, clamp = true): [number, number] => {
    const r = svgRef.current!.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * W, y = ((e.clientY - r.top) / r.height) * H;
    if (!clamp) return [x, y];
    return [Math.min(W, Math.max(0, x)), Math.min(H, Math.max(0, y))];
  };
  /** 螢幕 1px = 幾個單位（把手 / 拖曳門檻用） */
  const unit = () => W / (svgRef.current?.getBoundingClientRect().width || W);

  const updatePt = (j: number, f: (p: PenPt) => PenPt) => {
    const s = cur.current;
    set({ ...s, pts: s.pts.map((p, k) => (k === j ? f(p) : p)) });
  };

  const close_ = () => {
    if (cur.current.pts.length < 3) return;
    commit();
    set({ ...cur.current, closed: true });
    setSel([]);
  };

  const removePts = (js: number[]) => {
    if (!js.length) return;
    commit();
    const drop = new Set(js);
    const rest = cur.current.pts.filter((_, k) => !drop.has(k));
    set({ pts: rest, closed: cur.current.closed && rest.length >= 3 });
    setSel([]);
  };

  /** 拖曳選取的點（一起移動；Shift = 鎖 45° 方向） */
  const dragSel = (e: React.PointerEvent | PointerEvent) => {
    commit();
    const base = cur.current.pts;
    const ids = selRef.current;
    const [sx, sy] = at(e, false);
    listen((ev) => {
      const [x, y] = at(ev, false);
      let dx = x - sx, dy = y - sy;
      if (ev.shiftKey) [dx, dy] = snap45(0, 0, dx, dy);
      set({ ...cur.current, pts: movePts(base, ids, dx, dy) });
    });
  };

  // ── 滑鼠 ──
  const onBgDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const mod = e.ctrlKey || e.metaKey;
    // 封閉後（或畫的時候按著 Ctrl）拖空白處 = 框選；Ctrl / Shift = 加選
    if (closed || mod) {
      const add = mod || e.shiftKey;
      const keep = add ? selRef.current : [];
      const [x0, y0] = at(e, false);
      const c0x = e.clientX, c0y = e.clientY;
      let moved = false;
      listen(
        (ev) => {
          if (!moved && Math.hypot(ev.clientX - c0x, ev.clientY - c0y) < 3) return;
          moved = true;
          const [x1, y1] = at(ev, false);
          setMarquee([c0x, c0y, ev.clientX, ev.clientY]); // 螢幕座標（跟時間軸一樣用 .marquee）
          setSel([...keep, ...ptsInRect(cur.current.pts, x0, y0, x1, y1)]);
        },
        () => {
          setMarquee(null);
          if (!moved && !add) setSel([]);
        },
      );
      return;
    }
    // 雙擊 = 結束（封閉），不要多加一個重疊的點
    if (e.detail >= 2) return close_();
    commit();
    const last = pts[pts.length - 1];
    let [x, y] = at(e);
    if (e.shiftKey && last) [x, y] = snap45(last.x, last.y, x, y);
    const j = pts.length;
    set({ ...cur.current, pts: [...cur.current.pts, { x, y }] });
    setSel([j]);
    const x0 = e.clientX, y0 = e.clientY;
    let drag = false;
    listen((ev) => {
      if (!drag && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 3) return;
      drag = true;
      let [hx, hy] = at(ev);
      if (ev.shiftKey) [hx, hy] = snap45(x, y, hx, hy);
      // 拖曳方向 = 出去的把手，進來的把手自動對稱
      updatePt(j, (p) => ({ x: p.x, y: p.y, o: [hx - x, hy - y] }));
    });
  };

  const onAnchorDown = (e: React.PointerEvent, j: number) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const mod = e.ctrlKey || e.metaKey || e.shiftKey;
    if (!closed && j === 0 && pts.length >= 3 && !mod && !e.altKey) return close_();
    // Alt + 拖曳錨點：重新拉出對稱把手（只對這一點）
    if (e.altKey) {
      setSel([j]);
      commit();
      const p0 = pts[j];
      listen((ev) => {
        let [hx, hy] = at(ev);
        if (ev.shiftKey) [hx, hy] = snap45(p0.x, p0.y, hx, hy);
        updatePt(j, (p) => ({ x: p.x, y: p.y, o: [hx - p.x, hy - p.y] }));
      });
      return;
    }
    const cur0 = selRef.current;
    if (mod) {
      // Ctrl / Shift + 點：加選 / 取消選取（取消的就不拖）
      if (cur0.includes(j)) return setSel(cur0.filter((k) => k !== j));
      setSel([...cur0, j]);
    } else if (!cur0.includes(j)) setSel([j]);
    dragSel(e);
  };

  const onHandleDown = (e: React.PointerEvent, j: number, which: 'out' | 'in') => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    commit();
    const breakIt = e.altKey;
    listen((ev) => {
      updatePt(j, (p) => {
        let [x, y] = at(ev);
        if (ev.shiftKey) [x, y] = snap45(p.x, p.y, x, y);
        const v: [number, number] = [x - p.x, y - p.y];
        const broken = breakIt || !!p.i;
        if (!broken) return { x: p.x, y: p.y, o: which === 'out' ? v : [-v[0], -v[1]] };
        // 各自獨立（Alt 拆開，之後就一直是獨立的）
        return which === 'out' ? { ...p, o: v, i: handleIn(p) } : { ...p, i: v, o: handleOut(p) };
      });
    });
  };

  /** 雙擊錨點：直角 ↔ 平滑 */
  const toggleSmooth = (e: React.MouseEvent, j: number) => {
    e.stopPropagation();
    commit();
    const s = cur.current;
    const p = s.pts[j];
    if (p.o || p.i) return updatePt(j, (q) => ({ x: q.x, y: q.y }));
    const n = s.pts.length;
    const prev = s.pts[(j - 1 + n) % n], next = s.pts[(j + 1) % n];
    const dx = (next.x - prev.x) / 6, dy = (next.y - prev.y) / 6;
    updatePt(j, (q) => ({ x: q.x, y: q.y, o: [dx || 40 * unit(), dy] }));
  };

  /** 雙擊線段：插入錨點 */
  const onPathDbl = (e: React.MouseEvent) => {
    if (!closed) return;
    const [x, y] = at(e);
    const hit = nearestOnPath(pts, x, y);
    if (hit.d > 14 * unit()) return;
    commit();
    set({ ...cur.current, pts: insertPoint(cur.current.pts, hit.k, Math.min(0.98, Math.max(0.02, hit.t))) });
    setSel([hit.k + 1]);
  };

  const ready = closed && pts.length >= 3;

  /** 套用到對象的遮罩：路徑存在遮罩裡，不進形狀庫 */
  const apply = () => {
    const shape = penToShape(cur.current.pts);
    if (!shape || !cur.current.closed || !targetKey) return;
    const pen = cur.current.pts.map((p) => ({ ...p }));
    // 遮罩框 = 形狀在畫面上的範圍
    const b = penBounds(pen);
    drawTarget(targetKey)?.apply({ path: shape.path, pen }, { x: (b.x0 + b.x1) / 2 / W - 0.5, y: (b.y0 + b.y1) / 2 / H - 0.5, w: (b.x1 - b.x0) / W, h: (b.y1 - b.y0) / H });
    close();
  };

  /** 存進形狀庫（編輯形狀庫的形狀 = 更新它）；有對象時不關閉，還可以接著套用 */
  const saveToLib = () => {
    const shape = penToShape(cur.current.pts);
    if (!shape || !cur.current.closed) return;
    const nm = name.trim() || $t('自訂形狀');
    const pen = cur.current.pts.map((p) => ({ ...p }));
    let sid = id;
    if (editing && id) lib.update(id, { name: nm, path: shape.path, aspect: shape.aspect, pen, png: undefined });
    else sid = lib.add({ name: nm, path: shape.path, aspect: shape.aspect, pen });
    const L = useLayout.getState();
    L.set({ modCat: { ...L.modCat, mask: 'custom' }, libFilterOpen: { ...L.libFilterOpen, mask: true } });
    toast(editing ? $t('已更新形狀') : $t('已加入自訂形狀'));
    if (sid) onSaved?.(sid);
    if (!targetKey) close();
  };

  // ── 鍵盤（輸入框裡只處理 Esc） ──
  const keyRef = useRef<(e: KeyboardEvent) => void>();
  keyRef.current = (e: KeyboardEvent) => {
    // 網格設定的小視窗開著：Esc 交給它關
    if (e.key === 'Escape' && document.querySelector('.popover')) return;
    const inInput = (e.target as HTMLElement)?.tagName === 'INPUT';
    const mod = e.ctrlKey || e.metaKey;
    const s = selRef.current;
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    let handled = true;
    if (e.code === 'Space' && !inInput) space.current = true;
    else if (mod && e.key === '0') resetView();
    else if (e.key === 'Escape') {
      if (inInput) (e.target as HTMLElement).blur();
      else if (s.length) setSel([]);
      else close();
    } else if (inInput) handled = false;
    else if (mod && e.key.toLowerCase() === 'z') (e.shiftKey ? redo : undo)();
    else if (mod && e.key.toLowerCase() === 'y') redo();
    else if (mod && e.key.toLowerCase() === 'a') setSel(cur.current.pts.map((_, k) => k));
    else if (mod && e.key.toLowerCase() === 'd') setSel([]);
    else if (e.key === 'Enter') closed ? (targetKey ? apply() : saveToLib()) : close_();
    else if (e.key === 'Delete' || e.key === 'Backspace') {
      if (s.length) removePts(s);
      else if (!closed && pts.length) removePts([pts.length - 1]);
    } else if (arrows[e.key] && s.length) {
      // 方向鍵微調：1 單位，Shift = 10；連按只記一次復原
      if (!e.repeat) commit();
      const step = e.shiftKey ? 10 : 1;
      const [dx, dy] = arrows[e.key];
      set({ ...cur.current, pts: movePts(cur.current.pts, s, dx * step, dy * step) });
    } else handled = mod; // 其他 Ctrl 快捷鍵不要穿到編輯器
    if (handled) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  };
  useEffect(() => {
    const k = (e: KeyboardEvent) => keyRef.current?.(e);
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, []);

  const u = W / ((stage.w || W) * view.z);
  const R = 6 * u;
  const d = penToPath(pts, closed);
  const last = pts[pts.length - 1];
  const selSet = new Set(sel);
  // 顯示把手：選取的點；畫的時候也顯示最後一點的
  const showHandles = new Set<number>([...sel, ...(!closed && last ? [pts.length - 1] : [])]);

  return (
    <div className="overlay" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="dialog shape-drawer">
        <div className="sd-head">
          <h3>{editing ? $t('編輯形狀') : $t('畫遮罩形狀')}</h3>
          <span className="spacer" />
          {target && (
            <button
              className={`btn small-h sd-compare ${before ? 'on-accent' : ''}`}
              title={$t('按住顯示套用前的畫面')}
              onPointerDown={(e) => {
                e.preventDefault();
                setBefore(true);
                listen(() => {}, () => setBefore(false));
              }}
            >
              <Eye size={12} /> {$t('前後對照')}
            </button>
          )}
          <GridButton />
          <button className="ec-icon" title={$t('復原 (Ctrl+Z)')} disabled={!past.current.length} onClick={undo}><Undo2 size={15} /></button>
          <button className="ec-icon" title={$t('重做 (Ctrl+Y)')} disabled={!future.current.length} onClick={redo}><Redo2 size={15} /></button>
          <button className="ec-icon" title={$t('清除')} disabled={!pts.length} onClick={() => { commit(); set({ pts: [], closed: false }); setSel([]); }}><Trash2 size={15} /></button>
        </div>
        <div ref={stageRef} className={`sd-stage ${before ? 'before' : ''}`} style={{ width: stage.w, height: stage.h }} onPointerDownCapture={onStageDownCapture} onDoubleClick={(e) => e.target === e.currentTarget && resetView()}>
          <div className="sd-view" style={{ width: stage.w, height: stage.h, transform: `translate(${view.px}px, ${view.py}px) scale(${view.z})` }}>
          <canvas ref={viewRef} className="sd-frame" />
          {/* 網格跟預覽同一組設定；放在路徑層外面，按住「前後對照」時也看得到 */}
          <GridOverlay W={stage.w} H={stage.h} />
          <svg
            ref={svgRef}
            className={`sd-canvas ${closed ? 'closed' : 'drawing'} ${target ? '' : 'plain'}`}
            viewBox={`0 0 ${W} ${H}`}
            onPointerDown={onBgDown}
            onPointerMove={(e) => !closed && setHover(at(e))}
            onPointerLeave={() => setHover(null)}
            onDoubleClick={onPathDbl}
          >
            {d && <path className="sd-path" d={d} fillRule="evenodd" strokeWidth={2 * u} />}
            {!closed && last && hover && (
              <line className="sd-rubber" x1={last.x} y1={last.y} x2={hover[0]} y2={hover[1]} strokeWidth={1.5 * u} />
            )}
            {[...showHandles].map((j) => {
              const p = pts[j];
              if (!p || (!p.o && !p.i)) return null;
              const [ox, oy] = handleOut(p), [ix, iy] = handleIn(p);
              return (
                <g key={`h${j}`} className="sd-handle">
                  <line x1={p.x + ix} y1={p.y + iy} x2={p.x + ox} y2={p.y + oy} strokeWidth={u} />
                  <circle cx={p.x + ox} cy={p.y + oy} r={R * 0.8} strokeWidth={1.5 * u} onPointerDown={(e) => onHandleDown(e, j, 'out')} />
                  <circle cx={p.x + ix} cy={p.y + iy} r={R * 0.8} strokeWidth={1.5 * u} onPointerDown={(e) => onHandleDown(e, j, 'in')} />
                </g>
              );
            })}
            {pts.map((p, j) => (
              <rect
                key={j}
                className={`sd-anchor ${selSet.has(j) ? 'sel' : ''} ${!closed && j === 0 && pts.length >= 3 ? 'first' : ''} ${p.o || p.i ? 'smooth' : ''}`}
                x={p.x - R}
                y={p.y - R}
                width={R * 2}
                height={R * 2}
                rx={p.o || p.i ? R : 0}
                strokeWidth={1.5 * u}
                onPointerDown={(e) => onAnchorDown(e, j)}
                onDoubleClick={(e) => toggleSmooth(e, j)}
              />
            ))}
          </svg>
          </div>
          {marquee && (
            <div
              className="marquee"
              style={{
                left: Math.min(marquee[0], marquee[2]),
                top: Math.min(marquee[1], marquee[3]),
                width: Math.abs(marquee[2] - marquee[0]),
                height: Math.abs(marquee[3] - marquee[1]),
              }}
            />
          )}
          <button className="view-zoom sd-zoom" title={$t('檢視縮放（滾輪縮放、中鍵或空白鍵拖曳平移；點一下回到符合視窗）')} onClick={resetView}>
            {Math.round(view.z * 100)}%
          </button>
        </div>
        <div className="dialog-actions sd-foot">
          <input className="sd-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={$t('名稱')} />
          {targetKey && (
            <button className="btn" disabled={!ready} onClick={saveToLib} title={$t('存進遮罩形狀庫的「自訂」')}>
              {$t('加入形狀庫')}
            </button>
          )}
          <span className="spacer" />
          <button className="btn" onClick={close}>{$t('取消')}</button>
          {targetKey ? (
            <button className="btn primary" disabled={!ready} onClick={apply}>{$t('套用')}</button>
          ) : (
            <button className="btn primary" disabled={!ready} onClick={saveToLib}>{editing ? $t('儲存') : $t('加入形狀庫')}</button>
          )}
        </div>
      </div>
    </div>
  );
}
