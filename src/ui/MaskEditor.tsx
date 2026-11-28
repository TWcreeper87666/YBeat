import React from 'react';
import { create } from 'zustand';
import { useStore } from '../store';
import { $t, displayName } from '../i18n';
import { DEFAULT_MASK, PATH_SHAPE, maskAt, maskKey, type Mask } from '../engine/mask';
import { CLIP_MASK_ID } from '../modules/extra';
import { upsertKey } from '../engine/keyframes';
import { animBeatAt, animBeatLen, animLayers, animMaskAt, animSecAt, layerBoxToScreen, layerMaskAt, screenBoxToLayer, type AnimItem, type AnimLayer } from '../engine/animation';
import { shapeInfo } from '../engine/maskShapes';
import { axisAligned, gridSnapLines, rotatedHalf, snapMoveAxis } from '../engine/snap';
import { useLayout } from './uiStore';

/** 吸附距離（px），跟片段變換框一樣 */
const SNAP_PX = 8;
import { cfxCh, clipHost, fxHost, hostFor } from './EffectControls';
import { ensureClipBaseMask } from './MaskPanel';

/** 正在預覽畫面上編輯的片段特效遮罩（特效軌的特效選取時一律可以編輯） */
export const useMaskEdit = create<{ key: string | null }>(() => ({ key: null }));
export const cfxMaskKey = (fxId: string) => `cfx:${fxId}`;
/** 動畫的整體遮罩 */
export const animMaskKey = (animId: string) => `anim:${animId}`;
/** 動畫屬性面板裡整體遮罩的 channel：`whole:mask.x` */
export const animMaskCh = (ch: string) => `whole:${ch}`;
const animOf = (key: string, s = useStore.getState()) => (key.startsWith('anim:') ? s.anims.find((a) => a.id === key.slice(5)) : undefined);
/** 動畫圖層自己的遮罩（跟著圖層動） */
export const layerMaskKey = (animId: string, layerId: string) => `alayer:${animId}:${layerId}`;
/** 動畫屬性面板裡圖層遮罩的 channel：`lmask:<圖層>:mask.x` */
export const layerMaskCh = (layerId: string, ch: string) => `lmask:${layerId}:${ch}`;
const layerOf = (key: string, s = useStore.getState()) => {
  if (!key.startsWith('alayer:')) return undefined;
  const [, animId, layerId] = key.split(':');
  const a = s.anims.find((x) => x.id === animId);
  const layer = a?.layers.find((l) => l.id === layerId);
  return a && layer ? { a, layer } : undefined;
};
/** 圖層遮罩在畫面上的樣子（local = 動畫內秒數；這一刻圖層沒出現 = null） */
function layerMaskNow(key: string, local: number, s = useStore.getState()) {
  const o = layerOf(key, s);
  if (!o) return null;
  const beat = animBeatAt(o.a, Math.max(0, Math.min(o.a.duration, local)));
  const m = layerMaskAt(o.layer, beat);
  const aspect = s.format.w / s.format.h;
  const d = animLayers(o.a, o.a.start + local, animBeatLen(o.a), aspect).find((x) => x.layer.id === o.layer.id);
  return m && d ? { mask: { ...m, ...layerBoxToScreen(m, d, aspect) }, local: m, d, aspect, ...o } : null;
}
/** 動畫內的秒數 → 整體遮罩這一刻的樣子 */
const animMaskNow = (a: AnimItem, local: number) => animMaskAt(a, animBeatAt(a, Math.max(0, Math.min(a.duration, local))));

type Vals = Partial<Record<'x' | 'y' | 'w' | 'h' | 'feather' | 'rotation', number>>;
interface Target { key: string; label: string; mask: Mask; set(v: Vals): void; active: boolean }

/** 依目前選取，收集要顯示的遮罩 */
function useTargets(): Target[] {
  const sel = useStore((s) => s.selection);
  const time = useStore((s) => s.time);
  const effects = useStore((s) => s.effects);
  const clips = useStore((s) => s.clips);
  const modules = useStore((s) => s.modules);
  const anims = useStore((s) => s.anims);
  const editKey = useMaskEdit((s) => s.key);
  const out: Target[] = [];
  const name = (id: string) => {
    const m = modules.find((x) => x.id === id);
    return m ? displayName(m.name) : '';
  };
  if (sel?.type === 'effect') {
    const fx = effects.find((f) => f.id === sel.id);
    if (fx) {
      const local = time - fx.start;
      const m = local >= 0 && local < fx.duration ? maskAt(fx.mask, fx.keys, local) : null;
      if (m) {
        out.push({
          key: `fx:${fx.id}`,
          label: name(fx.moduleId),
          mask: m,
          active: true,
          set: (vals) => writeMask(`fx:${fx.id}`, local, vals),
        });
      }
    }
  }
  if (sel?.type === 'clip') {
    const c = clips.find((x) => x.id === sel.id);
    if (c) {
      const local = time - c.start;
      for (const f of c.effects ?? []) {
        if (f.enabled === false || local < 0 || local >= c.duration) continue;
        const m = maskAt(f.mask, f.keys, local);
        if (!m) continue;
        out.push({
          key: cfxMaskKey(f.id),
          label: name(f.moduleId),
          mask: m,
          active: editKey === cfxMaskKey(f.id),
          set: (vals) => writeMask(cfxMaskKey(f.id), local, vals),
        });
      }
    }
  }
  if (sel?.type === 'anim') {
    const a = anims.find((x) => x.id === sel.id);
    const local = a ? time - a.start : -1;
    const m = a && local >= 0 && local < a.duration ? animMaskNow(a, local) : null;
    if (a && m) {
      const key = animMaskKey(a.id);
      out.push({ key, label: a.name ?? $t('動畫'), mask: m, active: editKey === key, set: (vals) => writeMask(key, local, vals) });
    }
    // 圖層遮罩：只顯示正在編輯的那一個（圖層多的時候框會疊在一起）
    const lk = editKey?.startsWith(`alayer:${sel.id}:`) ? editKey : null;
    const lm = a && lk && local >= 0 && local < a.duration ? layerMaskNow(lk, local) : null;
    if (lk && lm) out.push({ key: lk, label: $t('圖層遮罩'), mask: lm.mask, active: true, set: (vals) => writeMask(lk, local, vals) });
  }
  return out;
}

type S = ReturnType<typeof useStore.getState>;

/** 遮罩 key（`fx:<特效 id>` / `cfx:<片段特效 id>`）屬於哪個片段 / 特效 */
function ownerOf(key: string, s: S = useStore.getState()) {
  if (key.startsWith('fx:')) {
    const fx = s.effects.find((f) => f.id === key.slice(3));
    return fx ? { kind: 'fx' as const, fx } : null;
  }
  if (key.startsWith('cfx:')) {
    const id = key.slice(4);
    for (const c of s.clips) {
      const f = c.effects?.find((x) => x.id === id);
      if (f) return { kind: 'cfx' as const, clip: c, f };
    }
  }
  return null;
}

/** 寫入遮罩的數值：有關鍵影格的屬性在 local 打 key，沒有就改固定值 */
function writeMask(key: string, local: number, vals: Vals) {
  if (key.startsWith('alayer:')) {
    const now = layerMaskNow(key, local);
    if (!now) return;
    const host = hostFor(`anim:${now.a.id}`);
    const { feather, ...box } = vals;
    const loc: Vals = { ...screenBoxToLayer(box, now.d, now.aspect, now.local), ...(feather !== undefined ? { feather } : {}) };
    for (const [p, v] of Object.entries(loc)) {
      const cur = layerOf(key);
      if (!host || !cur) return;
      const k = cur.layer.clipMask?.keys?.[maskKey(p)];
      const ch = layerMaskCh(cur.layer.id, maskKey(p));
      if (k?.length) host.setKeys(ch, upsertKey(k.map((x) => ({ ...x, t: animSecAt(cur.a, x.t) })), local, v));
      else host.setBase(ch, v);
    }
    return;
  }
  if (key.startsWith('anim:')) {
    const host = hostFor(key);
    for (const [p, v] of Object.entries(vals)) {
      const a = animOf(key);
      if (!host || !a) return;
      const k = a.mask?.keys?.[maskKey(p)];
      if (k?.length) host.setKeys(animMaskCh(maskKey(p)), upsertKey(k.map((x) => ({ ...x, t: animSecAt(a, x.t) })), local, v));
      else host.setBase(animMaskCh(maskKey(p)), v);
    }
    return;
  }
  const o = ownerOf(key);
  if (!o) return;
  const host = o.kind === 'fx' ? fxHost(o.fx.id) : clipHost(o.clip.id);
  if (!host) return;
  for (const [p, v] of Object.entries(vals)) {
    const cur = ownerOf(key);
    if (!cur) return;
    const k = (cur.kind === 'fx' ? cur.fx.keys : cur.f.keys)?.[maskKey(p)];
    const ch = cur.kind === 'fx' ? maskKey(p) : cfxCh(cur.f.id, maskKey(p));
    if (k?.length) host.setKeys(ch, upsertKey(k, local, v));
    else host.setBase(ch, v);
  }
}

/** 片段在畫面上看不到（不透明度 0），其他都不變（影片照常同步） */
const hideClip = (s: S, id: string): S => ({
  ...s,
  clips: s.clips.map((c) => {
    if (c.id !== id) return c;
    const keys = { ...c.keys };
    delete keys.opacity;
    return { ...c, keys, transform: { ...c.transform, opacity: 0 } };
  }),
});
const patchCfx = (s: S, clipId: string, fxId: string, patch: object): S => ({
  ...s,
  clips: s.clips.map((c) => (c.id === clipId ? { ...c, effects: c.effects?.map((f) => (f.id === fxId ? { ...f, ...patch } : f)) } : c)),
});

/** 在畫面上繪製遮罩形狀時的對象 */
export interface DrawTarget {
  /** 這一格的遮罩；null = 還沒有遮罩 */
  mask: Mask | null;
  /** true = 片段遮罩（遮罩外變透明）；false = 特效遮罩（只在遮罩內套特效） */
  cut: boolean;
  /** 渲染用：這個遮罩的對象完全沒作用 / 不受遮罩限制（全畫面作用）時的專案 */
  off(s: S): S;
  on(s: S): S;
  /** 套用畫好的形狀（遮罩自己的路徑，不存進形狀庫），遮罩框 = 形狀在畫面上的範圍（旋轉歸零） */
  apply(shape: Pick<Mask, 'path' | 'pen'>, box: { x: number; y: number; w: number; h: number }): void;
}

/** key：`fx:<特效 id>`、`cfx:<片段特效 id>`、`clip:<片段 id>`（片段本身的遮罩，還沒有就在套用時建立） */
export function drawTarget(key: string): DrawTarget | null {
  const s = useStore.getState();
  const lo = layerOf(key, s);
  if (lo) {
    const local = Math.min(Math.max(0, s.time - lo.a.start), Math.max(0, lo.a.duration - 1e-4));
    const { a: la, layer: ll } = lo;
    const upd = (st: S, fn: (l: AnimLayer) => AnimLayer | null): S => ({ ...st, anims: st.anims.map((a) => (a.id === la.id
      ? { ...a, layers: a.layers.flatMap((l) => { if (l.id !== ll.id) return [l]; const n = fn(l); return n ? [n] : []; }) } : a)) });
    return {
      mask: layerMaskNow(key, local, s)?.mask ?? null,
      cut: true,
      off: (st) => upd(st, () => null),
      on: (st) => upd(st, (l) => ({ ...l, clipMask: undefined })),
      apply: (shape, box) => {
        const cur = layerOf(key);
        if (!cur) return;
        const clipMask = { ...cur.layer.clipMask, mask: { ...DEFAULT_MASK, ...cur.layer.clipMask?.mask, shape: PATH_SHAPE, ...shape } };
        useStore.getState().updateAnim(cur.a.id, { layers: cur.a.layers.map((l) => (l.id === cur.layer.id ? { ...l, clipMask } : l)) });
        writeMask(key, local, { ...box, rotation: 0 });
      },
    };
  }
  const anim = animOf(key, s);
  if (anim) {
    const local = Math.min(Math.max(0, s.time - anim.start), Math.max(0, anim.duration - 1e-4));
    return {
      mask: animMaskNow(anim, local),
      cut: true,
      off: (st) => ({ ...st, anims: st.anims.filter((a) => a.id !== anim.id) }),
      on: (st) => ({ ...st, anims: st.anims.map((a) => (a.id === anim.id ? { ...a, mask: undefined } : a)) }),
      apply: (shape, box) => {
        const cur = animOf(key);
        if (!cur) return;
        useStore.getState().updateAnim(cur.id, { mask: { ...cur.mask, mask: { ...DEFAULT_MASK, ...cur.mask?.mask, shape: PATH_SHAPE, ...shape } } });
        writeMask(key, local, { ...box, rotation: 0 });
      },
    };
  }
  if (key.startsWith('clip:')) {
    const clip = s.clips.find((c) => c.id === key.slice(5));
    if (!clip) return null;
    const base = clip.effects?.find((f) => f.base);
    if (base) return drawTarget(cfxMaskKey(base.id));
    return {
      mask: null,
      cut: true,
      off: (st) => hideClip(st, clip.id),
      on: (st) => st,
      apply: (shape, box) => {
        const id = ensureClipBaseMask(clip.id);
        if (id) drawTarget(cfxMaskKey(id))?.apply(shape, box);
      },
    };
  }
  const o = ownerOf(key, s);
  if (!o) return null;
  const item = o.kind === 'fx' ? o.fx : o.f;
  const start = o.kind === 'fx' ? o.fx.start : o.clip.start;
  const dur = o.kind === 'fx' ? o.fx.duration : o.clip.duration;
  const local = Math.min(Math.max(0, s.time - start), Math.max(0, dur - 1e-4));
  const cut = o.kind === 'cfx' && o.f.moduleId === CLIP_MASK_ID;
  const noMask = { mask: { ...DEFAULT_MASK, ...item.mask, shape: 'none' } };
  return {
    mask: maskAt(item.mask, item.keys, local),
    cut,
    off: (st) =>
      o.kind === 'fx' ? { ...st, effects: st.effects.filter((f) => f.id !== o.fx.id) } : cut ? hideClip(st, o.clip.id) : patchCfx(st, o.clip.id, o.f.id, { enabled: false }),
    on: (st) => (o.kind === 'fx' ? { ...st, effects: st.effects.map((f) => (f.id === o.fx.id ? { ...f, ...noMask } : f)) } : patchCfx(st, o.clip.id, o.f.id, noMask)),
    apply: (shape, box) => {
      const cur = ownerOf(key);
      if (!cur) return;
      const m: Mask = { ...DEFAULT_MASK, ...(cur.kind === 'fx' ? cur.fx.mask : cur.f.mask), shape: PATH_SHAPE, ...shape };
      if (cur.kind === 'fx') useStore.getState().updateEffect(cur.fx.id, { mask: m });
      else useStore.getState().updateClipFx(cur.clip.id, cur.f.id, { mask: m });
      writeMask(key, local, { ...box, rotation: 0 });
    },
  };
}

/** 編輯中的時間要在項目範圍內（繪製前把播放頭移進來） */
export function timeInside(key: string): number | null {
  const s = useStore.getState();
  let a: number, b: number;
  const anim = animOf(key, s) ?? layerOf(key, s)?.a;
  if (anim) [a, b] = [anim.start, anim.start + anim.duration];
  else if (key.startsWith('clip:')) {
    const c = s.clips.find((x) => x.id === key.slice(5));
    if (!c) return null;
    [a, b] = [c.start, c.start + c.duration];
  } else {
    const o = ownerOf(key, s);
    if (!o) return null;
    [a, b] = o.kind === 'fx' ? [o.fx.start, o.fx.start + o.fx.duration] : [o.clip.start, o.clip.start + o.clip.duration];
  }
  return s.time >= a && s.time < b ? s.time : a;
}

const HANDLES: { k: string; sx: -1 | 0 | 1; sy: -1 | 0 | 1 }[] = [
  { k: 'nw', sx: -1, sy: -1 }, { k: 'n', sx: 0, sy: -1 }, { k: 'ne', sx: 1, sy: -1 }, { k: 'e', sx: 1, sy: 0 },
  { k: 'se', sx: 1, sy: 1 }, { k: 's', sx: 0, sy: 1 }, { k: 'sw', sx: -1, sy: 1 }, { k: 'w', sx: -1, sy: 0 },
];

/** 形狀庫的形狀：在框裡畫出輪廓（框本身是外接矩形） */
function ShapeOutline({ id, path }: { id: string; path?: string }) {
  const info = id === 'path' ? (path ? { path, png: undefined } : undefined) : shapeInfo(id);
  if (!info) return null;
  if (info.path)
    return (
      <svg className="mask-outline" viewBox="0 0 200 200" preserveAspectRatio="none">
        <path d={info.path} fillRule="evenodd" vectorEffect="non-scaling-stroke" />
      </svg>
    );
  return <span className="mask-outline png" style={{ WebkitMaskImage: `url(${info.png})`, maskImage: `url(${info.png})` }} />;
}

type Guides = { x: number | null; y: number | null };

function MaskBox({ t, W, H, setGuides }: { t: Target; W: number; H: number; setGuides: (g: Guides) => void }) {
  const m = t.mask;
  const cx = (0.5 + m.x) * W, cy = (0.5 + m.y) * H;
  const w = Math.max(2, m.w * W), h = Math.max(2, m.h * H);
  const f = m.feather * H;
  const kind = m.shape === 'rect' || m.shape === 'ellipse' ? m.shape : 'shape';

  /** 拖曳：移動 / 旋轉 / 羽化 / 8 個把手（對邊固定；角 = 等比、Ctrl 自由、Alt 以中心縮放、Shift 吸附） */
  const begin = (e: React.PointerEvent, mode: 'move' | 'rot' | 'feather' | { sx: number; sy: number }) => {
    if (e.button !== 0 || !t.active) return;
    e.stopPropagation();
    e.preventDefault();
    // 每次重新量圖層、換成開始拖時的像素尺度：拖曳中縮放 / 平移檢視不會跳
    const el = (e.currentTarget as HTMLElement).closest('.gizmo-layer')!;
    const P = (ev: { clientX: number; clientY: number }) => {
      const r = el.getBoundingClientRect();
      return { x: ((ev.clientX - r.left) / (r.width || 1)) * W, y: ((ev.clientY - r.top) / (r.height || 1)) * H };
    };
    const m0 = { ...m };
    const th = (m0.rotation * Math.PI) / 180, c = Math.cos(th), s = Math.sin(th);
    const C0 = { x: (0.5 + m0.x) * W, y: (0.5 + m0.y) * H };
    const hw0 = (m0.w * W) / 2, hh0 = (m0.h * H) / 2;
    const toLocal = (p: { x: number; y: number }) => {
      const dx = p.x - C0.x, dy = p.y - C0.y;
      return { x: c * dx + s * dy, y: -s * dx + c * dy };
    };
    const toScreen = (l: { x: number; y: number }) => ({ x: C0.x + c * l.x - s * l.y, y: C0.y + s * l.x + c * l.y });
    const p0 = P(e);
    const a0 = Math.atan2(p0.y - C0.y, p0.x - C0.x);
    document.body.classList.add('mask-dragging');
    const move = (ev: PointerEvent) => {
      const p = P(ev);
      if (mode === 'move') {
        let x = m0.x + (p.x - p0.x) / W, y = m0.y + (p.y - p0.y) / H;
        let g: Guides = { x: null, y: null };
        if (ev.shiftKey) {
          // 跟片段的變換框一樣：中心、框的四邊（含旋轉的外接框）吸到畫面邊、中線、每一條網格線
          const lines = gridSnapLines(W, H, useLayout.getState());
          const { hx, hy } = rotatedHalf(m0.w * W, m0.h * H, m0.rotation);
          const sx = snapMoveAxis((0.5 + x) * W, hx, lines.x, SNAP_PX);
          const sy = snapMoveAxis((0.5 + y) * H, hy, lines.y, SNAP_PX);
          x = sx.center / W - 0.5;
          y = sy.center / H - 0.5;
          g = { x: sx.line, y: sy.line };
        }
        setGuides(g);
        return t.set({ x, y });
      }
      if (mode === 'rot') {
        let r = m0.rotation + ((Math.atan2(p.y - C0.y, p.x - C0.x) - a0) * 180) / Math.PI;
        if (ev.shiftKey) r = Math.round(r / 15) * 15;
        return t.set({ rotation: Math.round(r * 10) / 10 });
      }
      const L = toLocal(p);
      if (mode === 'feather') return t.set({ feather: Math.max(0, (L.x - hw0) / H) });
      const { sx, sy } = mode;
      // 角：預設等比（跟片段的變換框一樣），Ctrl = 自由縮放；Alt = 以中心縮放；Shift = 吸附
      const alt = ev.altKey;
      const prop = !!(sx && sy) && !(ev.ctrlKey || ev.metaKey);
      const ox = alt ? 0 : -sx * hw0, oy = alt ? 0 : -sy * hh0; // 固定不動的點（對邊 / 中心）
      const span = alt ? 1 : 2; // 半寬 = |拖的邊 - 固定點| / span
      const dx = Math.sign(L.x - ox) || sx || 1, dy = Math.sign(L.y - oy) || sy || 1; // 拖的邊在哪一側
      let hw = sx ? Math.abs(L.x - ox) / span : hw0;
      let hh = sy ? Math.abs(L.y - oy) / span : hh0;
      if (prop) {
        const k = Math.max(hw / hw0, hh / hh0);
        hw = hw0 * k;
        hh = hh0 * k;
      }
      let g: Guides = { x: null, y: null };
      // Shift：拖的邊吸到畫面邊、中線、網格線（框要跟畫面對齊：旋轉 0 / 90 / 180 / 270°）
      if (ev.shiftKey && axisAligned(m0.rotation)) {
        const lines = gridSnapLines(W, H, useLayout.getState());
        const snapEdge = (isX: boolean) => {
          const e = isX ? ox + dx * hw * span : oy + dy * hh * span; // 拖的邊（框的座標）
          const dir = isX ? { x: c, y: s } : { x: -s, y: c }; // 這個軸在畫面上的方向
          const screenX = Math.abs(dir.x) > 0.5;
          const d = Math.round(screenX ? dir.x : dir.y);
          const base = screenX ? C0.x : C0.y;
          const v = base + e * d;
          let best: number | null = null;
          for (const ln of screenX ? lines.x : lines.y) if (Math.abs(ln - v) <= SNAP_PX && (best === null || Math.abs(ln - v) < Math.abs(best - v))) best = ln;
          if (best === null) return null;
          return { half: Math.abs((best - base) / d - (isX ? ox : oy)) / span, line: best, screenX, dist: Math.abs(best - v) };
        };
        const rx = sx ? snapEdge(true) : null, ry = sy ? snapEdge(false) : null;
        const mark = (r: NonNullable<typeof rx>) => (r.screenX ? (g.x = r.line) : (g.y = r.line));
        if (prop) {
          const r = rx && (!ry || rx.dist <= ry.dist) ? rx : ry;
          if (r) {
            const k = r === rx ? r.half / hw0 : r.half / hh0;
            hw = hw0 * k;
            hh = hh0 * k;
            mark(r);
          }
        } else {
          if (rx) { hw = rx.half; mark(rx); }
          if (ry) { hh = ry.half; mark(ry); }
        }
      }
      setGuides(g);
      const lx = sx && !alt ? ox + dx * hw : 0, ly = sy && !alt ? oy + dy * hh : 0;
      const C = toScreen({ x: lx, y: ly });
      t.set({ x: C.x / W - 0.5, y: C.y / H - 0.5, w: Math.max(4, 2 * hw) / W, h: Math.max(4, 2 * hh) / H });
    };
    const up = () => {
      setGuides({ x: null, y: null });
      document.body.classList.remove('mask-dragging');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div
      className={`mask-gizmo ${kind} ${m.invert ? 'inv' : ''} ${t.active ? 'active' : 'passive'}`}
      style={{ left: cx - w / 2, top: cy - h / 2, width: w, height: h, transform: `rotate(${m.rotation}deg)` }}
      title={t.active ? $t('拖曳移動、拖把手調整大小（角 = 等比，Ctrl 自由縮放、Alt 以中心縮放；Shift 吸附到中線 / 邊緣 / 網格線）、上方圓點旋轉、右側菱形羽化') : t.label}
      onPointerDown={(e) => t.active && begin(e, 'move')}
    >
      {kind === 'shape' && <ShapeOutline id={m.shape} path={m.path} />}
      {f > 0.5 && <div className={`mask-feather ${kind}`} style={{ inset: -f }} />}
      {f > 0.5 && <div className={`mask-feather in ${kind}`} style={{ inset: Math.min(f, Math.min(w, h) / 2 - 1) }} />}
      <span className="mask-tag">
        {t.label} · {$t('遮罩')}
        {m.invert ? $t('（反轉）') : ''}
      </span>
      {t.active && (
        <>
          {HANDLES.map((hd) => (
            <div key={hd.k} className={`mask-h ${hd.k}`} onPointerDown={(e) => begin(e, { sx: hd.sx, sy: hd.sy })} />
          ))}
          <div className="mask-rot" onPointerDown={(e) => begin(e, 'rot')} title={$t('拖曳旋轉（Shift = 15° 一格）')} />
          <div className="mask-fh" style={{ left: `calc(100% + ${f}px)` }} onPointerDown={(e) => begin(e, 'feather')} title={$t('拖曳調整羽化')} />
        </>
      )}
    </div>
  );
}

/** 預覽畫面上的遮罩框 */
export function MaskGizmos({ W, H }: { W: number; H: number }) {
  const targets = useTargets();
  const [guides, setGuides] = React.useState<Guides>({ x: null, y: null });
  if (!W || !targets.length) return null;
  return (
    <>
      {targets.map((t) => (
        <MaskBox key={t.key} t={t} W={W} H={H} setGuides={setGuides} />
      ))}
      {(guides.x !== null || guides.y !== null) && (
        <svg className="snap-guides" width={W} height={H}>
          {guides.x !== null && <line x1={guides.x} y1={0} x2={guides.x} y2={H} />}
          {guides.y !== null && <line x1={0} y1={guides.y} x2={W} y2={guides.y} />}
        </svg>
      )}
    </>
  );
}
