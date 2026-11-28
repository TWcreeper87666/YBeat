/**
 * 覆蓋式捲軸（全域）：原生捲軸全部藏起來（styles.css），內容不會因為出現捲軸而變窄、抖動；
 * 滑鼠在可以捲動的區塊裡、或剛捲動過時，在邊緣畫一條浮在內容上面的捲軸（可以拖），離開 / 停一下就淡掉。
 * 水平捲軸的左邊可以用 CSS 變數 --osb-left 內縮（例如時間軸左邊的軌道標籤）；加 .osb-thin 的區塊用細捲軸。
 * 自己畫捲軸的範圍條（只有一段顯示範圍、沒有真的捲動）用 wheelView 的 ViewScrollbar，外觀一樣。
 */
type Axis = 'v' | 'h';

/** 捲動後還顯示多久（ms） */
const IDLE = 900;
/** 捲軸把手最短（px） */
const MIN_THUMB = 24;
/** 捲軸區的粗細（px；把手在裡面，滑過時變粗） */
const SIZE = 10;
/** .osb-thin 區塊的捲軸粗細（px；不會變粗） */
const THIN = 4;
const thin = (el: HTMLElement) => !!el.closest('.osb-thin');

interface Bar {
  axis: Axis;
  root: HTMLDivElement;
  thumb: HTMLDivElement;
  /** 目前對著的捲動區塊 */
  el: HTMLElement | null;
  /** 捲動過：顯示到這個時間 */
  until: number;
  drag: boolean;
}

const bars: Record<Axis, Bar | null> = { v: null, h: null };
let pointer: { x: number; y: number } | null = null;
let raf = 0;

function canScroll(el: Element, axis: Axis): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  if (axis === 'v' ? el.scrollHeight <= el.clientHeight + 1 : el.scrollWidth <= el.clientWidth + 1) return false;
  const cs = getComputedStyle(el);
  const o = axis === 'v' ? cs.overflowY : cs.overflowX;
  return o === 'auto' || o === 'scroll';
}

function scroller(start: Element | null, axis: Axis): HTMLElement | null {
  for (let e = start; e && e !== document.body && e !== document.documentElement; e = e.parentElement) if (canScroll(e, axis)) return e;
  return null;
}

/** 最近的可以捲動的區塊（上下或左右都算；中鍵拖曳用） */
export const scrollerAt = (start: Element | null): HTMLElement | null => {
  for (let e = start; e && e !== document.body && e !== document.documentElement; e = e.parentElement) if (canScroll(e, 'v') || canScroll(e, 'h')) return e as HTMLElement;
  return null;
};

function bar(axis: Axis): Bar {
  const have = bars[axis];
  if (have) return have;
  const root = document.createElement('div');
  root.className = `osb ${axis}`;
  const thumb = document.createElement('div');
  thumb.className = 'osb-thumb';
  root.appendChild(thumb);
  document.body.appendChild(root);
  const b: Bar = { axis, root, thumb, el: null, until: 0, drag: false };
  thumb.addEventListener('pointerdown', (e) => {
    const el = b.el;
    if (e.button !== 0 || !el) return;
    e.preventDefault();
    e.stopPropagation();
    thumb.setPointerCapture(e.pointerId);
    b.drag = true;
    root.classList.add('drag');
    const v = axis === 'v';
    const p0 = v ? e.clientY : e.clientX;
    const s0 = v ? el.scrollTop : el.scrollLeft;
    const g = geom(b)!;
    const k = g.room > 0 ? g.range / g.room : 0;
    const move = (ev: PointerEvent) => {
      const d = ((v ? ev.clientY : ev.clientX) - p0) * k;
      if (v) el.scrollTop = s0 + d;
      else el.scrollLeft = s0 + d;
    };
    const up = () => {
      b.drag = false;
      root.classList.remove('drag');
      b.until = performance.now() + IDLE;
      thumb.removeEventListener('pointermove', move);
      thumb.removeEventListener('pointerup', up);
      thumb.removeEventListener('pointercancel', up);
      kick();
    };
    thumb.addEventListener('pointermove', move);
    thumb.addEventListener('pointerup', up);
    thumb.addEventListener('pointercancel', up);
    kick();
  });
  bars[axis] = b;
  return b;
}

/** 捲軸區和把手的位置（螢幕座標）；range = 能捲的距離、room = 把手能移動的距離 */
function geom(b: Bar) {
  const el = b.el;
  if (!el || !el.isConnected) return null;
  const r = el.getBoundingClientRect();
  if (b.axis === 'v') {
    const top = r.top + el.clientTop, h = el.clientHeight;
    const th = Math.max(MIN_THUMB, (h * h) / el.scrollHeight);
    const range = el.scrollHeight - h, room = h - th;
    return { x: r.left + el.clientLeft + el.clientWidth - SIZE, y: top, w: SIZE, h, pos: range > 0 ? (el.scrollTop / range) * room : 0, len: th, range, room };
  }
  const inset = Math.min(el.clientWidth * 0.8, parseFloat(getComputedStyle(el).getPropertyValue('--osb-left')) || 0);
  const left = r.left + el.clientLeft + inset, w = el.clientWidth - inset;
  const tw = Math.max(MIN_THUMB, (w * el.clientWidth) / el.scrollWidth);
  const range = el.scrollWidth - el.clientWidth, room = w - tw;
  const size = thin(el) ? THIN : SIZE;
  return { x: left, y: r.top + el.clientTop + el.clientHeight - size, w, h: size, pos: range > 0 ? (el.scrollLeft / range) * room : 0, len: tw, range, room };
}

const inside = (el: HTMLElement, p: { x: number; y: number } | null) => {
  if (!p) return false;
  const r = el.getBoundingClientRect();
  return p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;
};

/**
 * 捲軸要疊在哪一層：一般面板 = BASE（在面板內容上面、浮動視窗 / 對話框 / 選單下面）；
 * 捲動區塊在浮動的層（對話框、挑選視窗、編輯視窗…）裡 = 那一層再上面一點。
 */
let baseZ = 0;
const layerZ = new WeakMap<HTMLElement, number>();
function zFor(el: HTMLElement): number {
  let z = layerZ.get(el);
  if (z !== undefined) return z;
  baseZ ||= parseInt(getComputedStyle(document.documentElement).getPropertyValue('--z-scrollbar')) || 45;
  z = baseZ;
  for (let p: HTMLElement | null = el; p; p = p.parentElement) {
    const cs = getComputedStyle(p);
    const n = Number(cs.zIndex);
    if (cs.position === 'fixed' && Number.isFinite(n)) z = Math.max(z, n + 1);
  }
  layerZ.set(el, z);
  return z;
}

/** 每一格更新位置；都看不到了就停 */
function frame() {
  raf = 0;
  const now = performance.now();
  let alive = false;
  for (const axis of ['v', 'h'] as const) {
    const b = bars[axis];
    if (!b) continue;
    const g = geom(b);
    const show = !!g && g.range > 1 && (b.drag || now < b.until || inside(b.el!, pointer));
    b.root.classList.toggle('on', show);
    if (b.el) {
      b.root.classList.toggle('thin', thin(b.el));
      b.root.style.zIndex = String(zFor(b.el));
    }
    if (g) {
      Object.assign(b.root.style, { left: `${g.x}px`, top: `${g.y}px`, width: `${g.w}px`, height: `${g.h}px` });
      if (axis === 'v') Object.assign(b.thumb.style, { top: `${g.pos}px`, height: `${g.len}px` });
      else Object.assign(b.thumb.style, { left: `${g.pos}px`, width: `${g.len}px` });
    }
    if (show) alive = true;
    else if (!g) b.el = null;
  }
  if (alive) kick();
}

function kick() {
  if (!raf) raf = requestAnimationFrame(frame);
}

export function installOverlayScrollbars() {
  let pending: Element | null = null;
  let hover = 0;
  window.addEventListener('pointermove', (e) => {
    pointer = { x: e.clientX, y: e.clientY };
    // 拖著捲軸時不換對象
    if (bars.v?.drag || bars.h?.drag) return;
    pending = e.target as Element;
    if (hover) return;
    hover = requestAnimationFrame(() => {
      hover = 0;
      // 滑在捲軸上：留著原本的對象
      if (pending instanceof Element && pending.closest('.osb')) return kick();
      for (const axis of ['v', 'h'] as const) {
        const el = scroller(pending, axis);
        if (el) bar(axis).el = el;
        else if (bars[axis] && !bars[axis]!.drag) bars[axis]!.el = null;
      }
      kick();
    });
  }, { passive: true });
  document.addEventListener('pointerleave', () => { pointer = null; kick(); });
  window.addEventListener('blur', () => { pointer = null; kick(); });
  // 捲動：捲的那個區塊（滑鼠不在上面也顯示一下，例如程式捲動、鍵盤捲動）
  document.addEventListener('scroll', (e) => {
    const el = e.target;
    if (!(el instanceof HTMLElement)) return;
    const now = performance.now();
    for (const axis of ['v', 'h'] as const) {
      if (!canScroll(el, axis)) continue;
      const b = bar(axis);
      if (b.drag && b.el !== el) continue;
      // 滑鼠在別的捲動區塊上：不搶（巢狀的內層捲動時外層不用跳出來）
      if (b.el && b.el !== el && inside(b.el, pointer)) continue;
      b.el = el;
      b.until = now + IDLE;
    }
    kick();
  }, { capture: true, passive: true });
  window.addEventListener('resize', kick);
}
