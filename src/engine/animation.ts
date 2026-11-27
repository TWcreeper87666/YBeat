import { evalKeys, type Keyframe, type Keys } from './keyframes';
import { expandPop, POP_VARIANTS, type PopVariant } from './subjectPop';
import type { ClipFx } from '../store';
import type { Crop } from './transform';

export interface AnimSlot {
  id: string;
  role: 'subject' | 'background' | 'reveal' | 'copy' | 'other';
  label: string;
  mediaId: string | null;
  sourceTime: number;
  crop?: Crop;
  cutout?: { mode: 'auto' | 'off'; outline?: string };
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
  mask?: { slotId: string; layerId?: string; mode: 'window' | 'hole'; scale?: Keyframe[] };
  effects?: (ClipFx & { beatEvery?: 1 | 2; hitBeats?: number })[];
  text?: string;
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
  beatTimes?: number[];
  presetId?: string;
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
  mask?: AnimLayer['mask'];
}

const value = (keys: Keyframe[] | undefined, beat: number, fallback: number) => keys?.length ? evalKeys(keys, beat) : fallback;
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

export function animLayers(item: AnimItem, t: number, beatTime: number): AnimDrawLayer[] {
  if (t < item.start || t >= item.start + item.duration || beatTime <= 0) return [];
  const beat = beatAt(item, t, beatTime);
  const slots = new Map(item.slots.map((s) => [s.id, s]));
  return item.layers.flatMap((layer) => {
    const slot = slots.get(layer.slotId);
    if (!slot || (!slot.mediaId && !layer.text) || beat < layer.fromBeat || beat >= layer.toBeat) return [];
    const b = beat, k = layer.keys, o = layer.base ?? {};
    return [{ id: layer.id, slot, layer,
      x: value(k.x, b, o.x ?? 0), y: value(k.y, b, o.y ?? 0),
      scaleX: value(k.scaleX, b, o.scaleX ?? 1), scaleY: value(k.scaleY, b, o.scaleY ?? 1),
      rotation: value(k.rotation, b, o.rotation ?? 0), opacity: value(k.opacity, b, o.opacity ?? 1),
      mask: layer.mask }];
  });
}

export function snapAnimBeats(item: AnimItem, grid: number[]): AnimItem {
  if (!item.beatTimes?.length || !grid.length) return item;
  const nearest = (t: number) => grid.reduce((a, b) => Math.abs(b - t) < Math.abs(a - t) ? b : a);
  return { ...item, beatTimes: item.beatTimes.map((b) => Math.max(0, nearest(item.start + b) - item.start)) };
}

const ease = (name: string): Keyframe['ease'] => name === 'hold' ? 'hold'
  : name === 'back' ? [0.34, 1.56, 0.64, 1] : name === 'out' ? [0, 0, 0.58, 1] : [0, 0, 1, 1];

/** 舊模板以四拍展開；淡出仍依最後半拍計算。 */
export function animTemplate(variant: PopVariant, opts: { id: string; start: number; duration: number; track?: number; subject?: string | null; reveal?: string | null; cx?: number; cy?: number; side?: -1 | 1; text?: string; outline?: string }): AnimItem {
  const subject = opts.subject ?? null, reveal = opts.reveal ?? null;
  const source = expandPop({ b0: 0, b1: 4, variant, mediaId: 'subject', revealMediaId: 'reveal', cx: opts.cx ?? 0, cy: opts.cy ?? 0, side: opts.side, text: opts.text, path: opts.outline }, (b) => b);
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
    const mask = l.mask ? { slotId: 'subject', mode: l.mask.invert ? 'hole' as const : 'window' as const,
      scale: l.mask.scale.map((k, j) => ({ id: `${i}-mask-${j}`, t: k.t + l.t0, v: k.v, ease: ease(k.ease) })) } : undefined;
    return { id: `layer-${i}`, slotId, fromBeat: l.t0, toBeat: l.t1, keys, blend: l.blend, mask,
      text: variant === 'textBehind' && i === 1 ? opts.text : undefined,
      effects: l.effects?.map((fx, j) => ({ id: `fx-${i}-${j}`, moduleId: fx.moduleId, params: fx.params,
        beatEvery: fx.beatEvery, hitBeats: fx.hitSec })) };
  });
  // 文字層採用字幕預設樣式，與舊版套用的字幕樣式可能不同。
  return { id: opts.id, track: opts.track ?? 0, start: opts.start, duration: opts.duration,
    slots, layers: layers.filter((_, i) => variant !== 'textBehind' || i !== 1 || !!opts.text),
    beatTimes: [0, 1, 2, 3, 4].map((b) => b * opts.duration / 4), presetId: variant };
}

export const ANIM_TEMPLATES = Object.fromEntries(POP_VARIANTS.map((variant) =>
  [variant, animTemplate(variant, { id: `template:${variant}`, start: 0, duration: 4 })])) as Record<PopVariant, AnimItem>;
