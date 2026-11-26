import { $t } from '../i18n';
import { ease } from './remap';
import { ANIM_PROPS, evalKeys, newKey, upsertKey, type AnimProp, type Keyframe, type Keys } from './keyframes';

/** 片段在畫面中的變換。x/y 以畫面寬/高為 1（0 = 置中，y 向下為正），rotation 為度（順時針） */
export interface Transform {
  x: number;
  y: number;
  /** 水平 / 垂直縮放（1 = 原始大小）；舊版只有 scale，載入時用 normalizeScale 轉成兩個 */
  scaleX: number;
  scaleY: number;
  rotation: number;
  opacity: number;
}
export const DEFAULT_TRANSFORM: Transform = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1 };

/** 舊版 transform.scale / keys.scale → scaleX + scaleY（兩邊一樣） */
export function normalizeScale<T extends { transform: Transform; keys?: Keys }>(c: T): T {
  const t = c.transform as Transform & { scale?: number };
  const k = c.keys as (Keys & { scale?: Keys['scaleX'] }) | undefined;
  if (t.scale === undefined && !k?.scale) return c;
  const transform = { ...t, scaleX: t.scaleX ?? t.scale ?? 1, scaleY: t.scaleY ?? t.scale ?? 1 };
  delete (transform as { scale?: number }).scale;
  let keys = c.keys;
  if (k?.scale) {
    const { scale, ...rest } = k;
    keys = { ...rest, scaleX: scale, scaleY: scale!.map((x) => ({ ...x, id: x.id + 'y' })) };
  }
  return { ...c, transform, keys };
}

/** 舊版「起點 → 終點」動態用的緩動名稱（只用於轉換舊專案） */
export type EaseName = 'linear' | 'in' | 'out' | 'inOut' | 'outBack';
export const EASES: Record<EaseName, { label: string; fn: (x: number) => number }> = {
  linear: { label: $t('線性'), fn: ease.linear },
  in: { label: $t('漸快 (In)'), fn: ease.inCubic },
  out: { label: $t('漸慢 (Out)'), fn: ease.outCubic },
  inOut: { label: $t('緩入緩出'), fn: ease.inOutCubic },
  outBack: { label: $t('過衝回彈'), fn: ease.outBack },
};

export type Fit = 'cover' | 'contain' | 'blur';
export const FITS: Record<Fit, string> = { cover: $t('填滿（裁切）'), contain: $t('完整顯示'), blur: $t('完整顯示 + 模糊背景') };

interface Animatable { transform: Transform; keys?: Keys }

/** 片段在 local 時的變換：有關鍵影格的屬性用曲線，其他用固定值 */
export function clipTransformAt(clip: Animatable, local: number): Transform {
  const out = { ...clip.transform };
  const keys = clip.keys;
  if (!keys) return out;
  for (const { prop } of ANIM_PROPS) {
    const k = keys[prop];
    if (k?.length) out[prop] = evalKeys(k, local);
  }
  return out;
}

export const isAnimated = (clip: Animatable, prop: AnimProp) => !!clip.keys?.[prop]?.length;

/** 設定屬性值：已有動畫的屬性在播放頭自動打 key，否則改固定值（跟 AE 一樣） */
export function setPropsAt<T extends Animatable>(clip: T, values: Partial<Transform>, local: number): Partial<T> {
  let transform = clip.transform;
  let keys = clip.keys ?? {};
  let keysChanged = false;
  for (const [p, v] of Object.entries(values) as [AnimProp, number][]) {
    if (keys[p]?.length) {
      keys = { ...keys, [p]: upsertKey(keys[p]!, local, v) };
      keysChanged = true;
    } else transform = { ...transform, [p]: v };
  }
  const patch: Partial<Animatable> = {};
  if (transform !== clip.transform) patch.transform = transform;
  if (keysChanged) patch.keys = keys;
  return patch as Partial<T>;
}

/** 素材在 scale=1 時的大小（以畫面高度為 1 的單位） */
export function fitSize(cover: boolean, srcAspect: number, frameAspect: number): [number, number] {
  const wide = srcAspect > frameAspect;
  if (cover) return wide ? [srcAspect, 1] : [frameAspect, frameAspect / srcAspect];
  return wide ? [frameAspect, frameAspect / srcAspect] : [srcAspect, 1];
}

/** 裁切框：相對素材畫面的比例 0~1（左上角 + 寬高） */
export interface Crop { x: number; y: number; w: number; h: number }
export const FULL_CROP: Crop = { x: 0, y: 0, w: 1, h: 1 };
export const isFullCrop = (c?: Crop | null) => !c || (c.x <= 0.001 && c.y <= 0.001 && c.w >= 0.999 && c.h >= 0.999);

/**
 * 裁切框放進畫面時的縮放與位移（片段要用 fit = cover）。
 * cover = 框內填滿畫面（比例不同就切掉一些）；false = 框內整個放進畫面（比例不同就留邊，框外的畫面要另外用遮罩擋掉）
 */
export function cropView(c: Crop, srcAspect: number, frameAspect: number, cover = true): { s: number; x: number; y: number } {
  const F = fitSize(true, srcAspect, frameAspect);
  const G = fitSize(cover, (srcAspect * c.w) / c.h, frameAspect);
  const s = G[0] / (c.w * F[0]);
  const cx = c.x + c.w / 2, cy = c.y + c.h / 2;
  return { s, x: ((0.5 - cx) * F[0] * s) / frameAspect, y: (0.5 - cy) * F[1] * s };
}

/**
 * 片段套上裁切：原本的縮放 / 位移（含關鍵影格）當作是對「裁切後的畫面」做的，換算成對整個素材的值。
 * 有動畫時在每個 key 的時間點重算（片段要用 fit = cover）。
 */
export function cropClip(clip: Animatable, crop: Crop, srcAspect: number, frameAspect: number, cover = true): { transform: Transform; keys: Keys } {
  const v = cropView(crop, srcAspect, frameAspect, cover);
  const map = (t: Transform) => ({ scaleX: t.scaleX * v.s, scaleY: t.scaleY * v.s, x: t.scaleX * v.x + t.x, y: t.scaleY * v.y + t.y });
  const keys = clip.keys ?? {};
  const props = ['scaleX', 'scaleY', 'x', 'y'] as const;
  if (!props.some((p) => keys[p]?.length)) return { transform: { ...clip.transform, ...map(clip.transform) }, keys };
  const all = props.flatMap((p) => keys[p] ?? []);
  const times = [...new Set(all.map((k) => k.t))].sort((a, b) => a - b);
  const easeAt = (t: number): Keyframe['ease'] => all.find((k) => k.t === t)?.ease ?? [0, 0, 1, 1];
  const vals = times.map((t) => map(clipTransformAt(clip, t)));
  const out: Keys = { ...keys };
  for (const p of props) out[p] = times.map((t, i) => newKey(t, vals[i][p], easeAt(t)));
  return { transform: clip.transform, keys: out };
}

/** 裁切框整個放進畫面（cropView 的 cover = false）時，框在畫面上的大小（畫面寬 / 高為 1） */
export function cropWindow(c: Crop, srcAspect: number, frameAspect: number): { w: number; h: number } {
  const G = fitSize(false, (srcAspect * c.w) / c.h, frameAspect);
  return { w: G[0] / frameAspect, h: G[1] };
}

/** 臉 / 框（素材畫面 0..1）換到裁切框裡的座標；中心在框外 = null */
export function intoCrop<T extends { x: number; y: number; h: number; w?: number }>(b: T, c: Crop): T | null {
  const x = (b.x - c.x) / c.w, y = (b.y - c.y) / c.h;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { ...b, x, y, h: b.h / c.h, ...(b.w !== undefined ? { w: b.w / c.w } : {}) };
}
/** intoCrop 的反向：裁切框裡的座標換回素材畫面 */
export function outOfCrop<T extends { x: number; y: number; h: number; w?: number }>(b: T, c: Crop): T {
  return { ...b, x: c.x + b.x * c.w, y: c.y + b.y * c.h, h: b.h * c.h, ...(b.w !== undefined ? { w: b.w * c.w } : {}) };
}
