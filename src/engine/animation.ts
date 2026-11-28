import { evalKeys, type Keyframe, type Keys } from './keyframes';
import { expandPop, POP_VARIANTS, type PopVariant } from './subjectPop';
import type { ClipFx } from '../store';
import type { Crop } from './transform';
import { DEFAULT_TRANSFORM, type Transform } from './transform';
import { maskAt, type Mask } from './mask';
import type { CutoutEdit } from './cutoutEdit';

export interface AnimSlot {
  id: string;
  role: 'subject' | 'background' | 'reveal' | 'copy' | 'other';
  label: string;
  mediaId: string | null;
  sourceTime: number;
  crop?: Crop;
  /** edit：手動修正（補上 / 擦掉、轉成路徑），只對 edit 記的那張圖、那一格有效 */
  cutout?: { mode: 'auto' | 'off'; outline?: string; edit?: CutoutEdit };
  /** 不顯示（用到這個位置的圖層都不畫；例如不要背景，看下面的軌道） */
  hidden?: true;
}

export interface AnimLayer {
  id: string;
  slotId: string;
  fromBeat: number;
  toBeat: number;
  /** 拍數以項目起點為零。 */
  keys: Keys;
  /** 沒有關鍵影格的屬性用這個值（沒有 = 預設：位置 0、縮放 1、透明度 1） */
  base?: Partial<Record<keyof Keys, number>>;
  blend?: 'normal' | 'add' | 'screen' | 'multiply' | 'subtract' | 'lighten';
  /** pivot：遮罩縮放的中心（畫面寬 / 高的比例，相對參考圖層的中心；沒有 = 參考圖層的中心） */
  mask?: { slotId: string; layerId?: string; mode: 'window' | 'hole'; scale?: Keyframe[]; pivot?: { x: number; y: number } };
  effects?: (ClipFx & { beatEvery?: 1 | 2; hitBeats?: number })[];
  text?: string;
  /** 圖層自己的遮罩：座標以圖層本身為準（圖層在原位、沒縮放時的畫面座標），圖層動遮罩跟著動；關鍵影格（mask.x…）用拍 */
  clipMask?: { mask: Mask; keys?: Record<string, Keyframe[]> };
}

export interface AnimItem {
  id: string;
  name?: string;
  track: number;
  start: number;
  duration: number;
  locked?: true;
  take?: string;
  group?: string;
  link?: string;
  slots: AnimSlot[];
  layers: AnimLayer[];
  transform?: Transform;
  keys?: Keys;
  beatTimes?: number[];
  presetId?: string;
  /** 所有圖片位置用同一張（換一張 = 全部一起換） */
  sameMedia?: true;
  /** 整體的遮罩（跟片段遮罩一樣：遮罩內保留、遮罩外透明）；關鍵影格（mask.x…）用拍 */
  mask?: { mask: Mask; keys?: Record<string, Keyframe[]> };
}

export interface AnimDrawLayer {
  id: string;
  slot: AnimSlot;
  layer: AnimLayer;
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  opacity: number;
  /** Pixel-space forward matrix, column-major. */
  matrix?: [number, number, number, number];
  mask?: AnimLayer['mask'];
}

const value = (keys: Keyframe[] | undefined, beat: number, fallback: number) => keys?.length ? evalKeys(keys, beat) : fallback;
export function animTransformAt(item: AnimItem, beat: number): Transform {
  const base = item.transform ?? DEFAULT_TRANSFORM;
  return { x: value(item.keys?.x, beat, base.x), y: value(item.keys?.y, beat, base.y),
    scaleX: value(item.keys?.scaleX, beat, base.scaleX), scaleY: value(item.keys?.scaleY, beat, base.scaleY),
    rotation: value(item.keys?.rotation, beat, base.rotation), opacity: value(item.keys?.opacity, beat, base.opacity) };
}

/** Combine positions in screen pixels, where x and y use different normalized axes. */
export function composeAnimTransform(layer: Transform, whole: Transform, aspect: number): Transform {
  const rad = whole.rotation * Math.PI / 180;
  const dx = layer.x * aspect * whole.scaleX, dy = layer.y * whole.scaleY;
  return { x: whole.x + (dx * Math.cos(rad) - dy * Math.sin(rad)) / aspect,
    y: whole.y + dx * Math.sin(rad) + dy * Math.cos(rad),
    scaleX: layer.scaleX * whole.scaleX, scaleY: layer.scaleY * whole.scaleY,
    rotation: layer.rotation + whole.rotation, opacity: layer.opacity * whole.opacity };
}

export function animMatrix(layer: Transform, whole: Transform): [number, number, number, number] {
  const a = layer.rotation * Math.PI / 180, b = whole.rotation * Math.PI / 180;
  const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b);
  const m00 = whole.scaleX * ca * layer.scaleX, m10 = whole.scaleY * sa * layer.scaleX;
  const m01 = -whole.scaleX * sa * layer.scaleY, m11 = whole.scaleY * ca * layer.scaleY;
  return [cb * m00 - sb * m10, sb * m00 + cb * m10,
    cb * m01 - sb * m11, sb * m01 + cb * m11];
}
/** 整體遮罩在第 beat 拍的樣子（沒有形狀 = null） */
export const animMaskAt = (item: AnimItem, beat: number) => maskAt(item.mask?.mask, item.mask?.keys, beat);

/** 時間軸時間 t → 項目內的拍（照項目自己的拍點；拍點外用 beatTime 外插） */
export const animBeatAtTime = (item: AnimItem, t: number, beatTime: number) => beatAt(item, t, beatTime);
const beatAt = (item: AnimItem, t: number, beatTime: number) => {
  const local = t - item.start;
  const grid = item.beatTimes;
  if (!grid?.length) return local / beatTime;
  const points = grid[0] === 0 ? grid : [0, ...grid];
  for (let i = 1; i < points.length; i++) if (local <= points[i])
    return i - 1 + (local - points[i - 1]) / Math.max(points[i] - points[i - 1], 1e-6);
  return points.length - 1 + (local - points.at(-1)!) / beatTime;
};

/** 一拍幾秒：照項目自己的拍點平均（沒有 = 長度 / 4） */
export function animBeatLen(item: Pick<AnimItem, 'beatTimes' | 'duration'>): number {
  const g = item.beatTimes;
  return g && g.length > 1 ? Math.max(1e-3, (g[g.length - 1] - g[0]) / (g.length - 1)) : Math.max(1e-3, item.duration / 4);
}
/** 項目內的秒數 → 拍（照拍點分段內插） */
export const animBeatAt = (item: AnimItem, local: number) => beatAt({ ...item, start: 0 }, local, animBeatLen(item));
/** 拍 → 項目內的秒數 */
export function animSecAt(item: Pick<AnimItem, 'beatTimes' | 'duration'>, beat: number): number {
  const len = animBeatLen(item);
  const g = item.beatTimes?.length ? (item.beatTimes[0] === 0 ? item.beatTimes : [0, ...item.beatTimes]) : null;
  if (!g) return beat * len;
  const i = Math.floor(beat);
  if (i < 0) return beat * len;
  if (i + 1 < g.length) return g[i] + (beat - i) * (g[i + 1] - g[i]);
  return g[g.length - 1] + (beat - (g.length - 1)) * len;
}

export function animLayers(item: AnimItem, t: number, beatTime: number, aspect = 1): AnimDrawLayer[] {
  if (t < item.start || t >= item.start + item.duration || beatTime <= 0) return [];
  const beat = beatAt(item, t, beatTime);
  const whole = animTransformAt(item, beat);
  const slots = new Map(item.slots.map((s) => [s.id, s]));
  return item.layers.flatMap((layer) => {
    const slot = slots.get(layer.slotId);
    if (!slot || slot.hidden || (!slot.mediaId && !layer.text) || beat < layer.fromBeat || beat >= layer.toBeat) return [];
    const b = beat, k = layer.keys, o = layer.base ?? {};
    const own: Transform = {
      x: value(k.x, b, o.x ?? 0), y: value(k.y, b, o.y ?? 0),
      scaleX: value(k.scaleX, b, o.scaleX ?? 1), scaleY: value(k.scaleY, b, o.scaleY ?? 1),
      rotation: value(k.rotation, b, o.rotation ?? 0), opacity: value(k.opacity, b, o.opacity ?? 1),
    };
    const xf = !item.transform && !item.keys ? own : composeAnimTransform(own, whole, aspect);
    return [{ id: layer.id, slot, layer, ...xf,
      ...(!item.transform && !item.keys ? {} : { matrix: animMatrix(own, whole) }), mask: layer.mask }];
  });
}

export function snapAnimBeats(item: AnimItem, grid: number[]): AnimItem {
  if (!item.beatTimes?.length || !grid.length) return item;
  const nearest = (t: number) => grid.reduce((a, b) => Math.abs(b - t) < Math.abs(a - t) ? b : a);
  return { ...item, beatTimes: item.beatTimes.map((b) => Math.max(0, nearest(item.start + b) - item.start)) };
}

const ease = (name: string): Keyframe['ease'] => name === 'hold' ? 'hold'
  : name === 'back' ? [0.34, 1.56, 0.64, 1] : name === 'out' ? [0, 0, 0.58, 1] : [0, 0, 1, 1];

/** 舊模板以四拍展開（beats = 其他拍數，例如飛入 2 拍）；淡出仍依最後半拍計算。 */
export function animTemplate(variant: PopVariant, opts: { id: string; start: number; duration: number; track?: number; subject?: string | null; reveal?: string | null; cx?: number; cy?: number; side?: -1 | 1; text?: string; outline?: string; beats?: number }): AnimItem {
  const subject = opts.subject ?? null, reveal = opts.reveal ?? null;
  const nb = Math.max(1, Math.round(opts.beats ?? 4));
  const source = expandPop({ b0: 0, b1: nb, variant, mediaId: 'subject', revealMediaId: 'reveal', cx: opts.cx ?? 0, cy: opts.cy ?? 0, side: opts.side, text: opts.text, path: opts.outline }, (b) => b);
  const slots: AnimSlot[] = [
    { id: 'subject', role: 'subject', label: 'Subject', mediaId: subject, sourceTime: 0, cutout: { mode: 'auto', outline: opts.outline } },
    { id: 'background', role: 'background', label: 'Background', mediaId: subject, sourceTime: 0 },
    { id: 'reveal', role: 'reveal', label: 'Reveal', mediaId: reveal, sourceTime: 0 },
  ];
  const layers: AnimLayer[] = source.map((l, i) => {
    let slotId = l.mediaId === 'reveal' ? 'reveal' : l.matte ? 'subject' : 'background';
    if (variant === 'textBehind' && i === 1) {
      slotId = 'text';
      slots.push({ id: 'text', role: 'other', label: 'Text', mediaId: null, sourceTime: 0 });
    }
    if (l.matte && (variant === 'trail' || variant === 'grid' || variant === 'spin')) {
      slotId = `copy:${i}`;
      slots.push({ id: slotId, role: 'copy', label: `Copy ${i + 1}`, mediaId: subject, sourceTime: 0,
        cutout: { mode: 'auto', outline: opts.outline } });
    }
    const keys: Keys = {};
    for (const [prop, list] of Object.entries(l.keys ?? {}))
      keys[prop as keyof Keys] = list.map((k, j) => ({ id: `${i}-${prop}-${j}`, t: k.t + l.t0, v: k.v, ease: ease(k.ease) }));
    // 去背層自己的輪廓（逐拍放大、黑白背景…）：遮罩跟著這一層本身（縮放、位移都一樣），不另外縮放
    const self = l.mask && l.matte;
    const mask = l.mask ? { slotId: 'subject', mode: l.mask.invert ? 'hole' as const : 'window' as const,
      // 剪影窗 / 主體挖洞：以主體中心逐拍放大
      ...(self ? { layerId: `layer-${i}` } : {
        scale: l.mask.scale.map((k, j) => ({ id: `${i}-mask-${j}`, t: k.t + l.t0, v: k.v, ease: ease(k.ease) })),
        pivot: { x: opts.cx ?? 0, y: opts.cy ?? 0 } }) } : undefined;
    return { id: `layer-${i}`, slotId, fromBeat: l.t0, toBeat: l.t1, keys, blend: l.blend, mask,
      text: variant === 'textBehind' && i === 1 ? opts.text : undefined,
      // 文字放在畫面偏上（主體的頭附近）
      ...(variant === 'textBehind' && i === 1 && !keys.y ? { base: { y: -0.12 } } : {}),
      effects: l.effects?.map((fx, j) => ({ id: `fx-${i}-${j}`, moduleId: fx.moduleId, params: fx.params,
        beatEvery: fx.beatEvery, hitBeats: fx.hitSec })) };
  });
  return { id: opts.id, track: opts.track ?? 0, start: opts.start, duration: opts.duration,
    slots, layers: layers.filter((_, i) => variant !== 'textBehind' || i !== 1 || !!opts.text),
    beatTimes: Array.from({ length: nb + 1 }, (_, b) => b * opts.duration / nb), presetId: variant };
}

export const ANIM_TEMPLATES = Object.fromEntries(POP_VARIANTS.map((variant) =>
  [variant, animTemplate(variant, { id: `template:${variant}`, start: 0, duration: 4 })])) as Record<PopVariant, AnimItem>;

// ───── 圖層自己的遮罩（跟著圖層動） ─────

type LayerXf = Pick<AnimDrawLayer, 'x' | 'y' | 'scaleX' | 'scaleY' | 'rotation' | 'matrix'>;
/** 圖層的 2×2 變換（以畫面高度為單位，column-major）：有整體變換時用 matrix，沒有 = 旋轉 × 縮放 */
export function layerMatrix(d: LayerXf): [number, number, number, number] {
  if (d.matrix) return d.matrix;
  const r = (d.rotation * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  return [c * d.scaleX, s * d.scaleX, -s * d.scaleY, c * d.scaleY];
}

/** 圖層遮罩在第 beat 拍的樣子（圖層座標；沒有形狀 = null） */
export const layerMaskAt = (layer: AnimLayer, beat: number) => maskAt(layer.clipMask?.mask, layer.clipMask?.keys, beat);

/** 圖層座標的遮罩 → 畫面上的遮罩（渲染用，含變換矩陣，非等比縮放也正確） */
export function layerMaskToScreen(m: Mask, d: LayerXf, aspect: number): Mask {
  const M = layerMatrix(d);
  const cu = m.x * aspect, cv = m.y;
  const r = (m.rotation * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  const B = [c * m.w, s * m.w, -s * m.h, c * m.h];
  const matrix: [number, number, number, number] = [
    M[0] * B[0] + M[2] * B[1], M[1] * B[0] + M[3] * B[1],
    M[0] * B[2] + M[2] * B[3], M[1] * B[2] + M[3] * B[3]];
  return { ...m, x: d.x + (M[0] * cu + M[2] * cv) / aspect, y: d.y + M[1] * cu + M[3] * cv, matrix };
}

type Box = Pick<Mask, 'x' | 'y' | 'w' | 'h' | 'rotation'>;
/** 預覽上的編輯框：圖層座標 → 畫面（旋轉 / 等比縮放準確；非等比縮放加上旋轉時是近似的外框） */
export function layerBoxToScreen(m: Box, d: LayerXf, aspect: number): Box {
  const M = layerMatrix(d);
  const sx = Math.hypot(M[0], M[1]), sy = Math.hypot(M[2], M[3]);
  const th = (Math.atan2(M[1], M[0]) * 180) / Math.PI;
  const cu = m.x * aspect, cv = m.y;
  return { x: d.x + (M[0] * cu + M[2] * cv) / aspect, y: d.y + M[1] * cu + M[3] * cv, w: m.w * sx, h: m.h * sy, rotation: m.rotation + th };
}

/** 反過來：畫面上改了哪些值 → 圖層座標的值（只換算有給的那幾個） */
export function screenBoxToLayer(v: Partial<Box>, d: LayerXf, aspect: number, cur: Box): Partial<Box> {
  const M = layerMatrix(d);
  const sx = Math.hypot(M[0], M[1]) || 1, sy = Math.hypot(M[2], M[3]) || 1;
  const th = (Math.atan2(M[1], M[0]) * 180) / Math.PI;
  const out: Partial<Box> = {};
  if (v.x !== undefined || v.y !== undefined) {
    const scr = layerBoxToScreen(cur, d, aspect);
    const X = ((v.x ?? scr.x) - d.x) * aspect, Y = (v.y ?? scr.y) - d.y;
    const det = M[0] * M[3] - M[2] * M[1] || 1e-9;
    out.x = ((M[3] * X - M[2] * Y) / det) / aspect;
    out.y = (-M[1] * X + M[0] * Y) / det;
  }
  if (v.w !== undefined) out.w = v.w / sx;
  if (v.h !== undefined) out.h = v.h / sy;
  if (v.rotation !== undefined) out.rotation = v.rotation - th;
  return out;
}
