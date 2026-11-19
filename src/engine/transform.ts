import { $t } from '../i18n';
import { ease } from './remap';
import { ANIM_PROPS, evalKeys, upsertKey, type AnimProp, type Keys } from './keyframes';

/** 片段在畫面中的變換。x/y 以畫面寬/高為 1（0 = 置中，y 向下為正），rotation 為度（順時針） */
export interface Transform {
  x: number;
  y: number;
  scale: number;
  rotation: number;
  opacity: number;
}
export const DEFAULT_TRANSFORM: Transform = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 };

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
