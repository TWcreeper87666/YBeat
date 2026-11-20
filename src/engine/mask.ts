/** 特效遮罩：限制特效只作用在畫面的某個區域（矩形 / 橢圓 / 形狀庫裡的任何形狀，可羽化、反轉、打關鍵影格） */

import { $t } from '../i18n';
import { evalKeys, type Keyframe } from './keyframes';
import type { PenPt } from './penPath';

/** 'none' / 'rect' / 'ellipse'、'path'（這個遮罩自己的鋼筆路徑），或形狀庫的 id（見 maskShapes.ts，例如 'star'、'custom:…'） */
export type MaskShape = string;

export interface Mask {
  shape: MaskShape;
  invert: boolean;
  /** 中心位置（0 = 置中，以畫面寬 / 高為 1，y 向下） */
  x: number;
  y: number;
  /** 大小（以畫面寬 / 高為 1） */
  w: number;
  h: number;
  /** 羽化（以畫面高度為 1） */
  feather: number;
  /** 旋轉（度） */
  rotation: number;
  /** shape = 'path'：只屬於這個遮罩的路徑（鋼筆畫的，沒存進形狀庫），正規化到 200×200 */
  path?: string;
  /** shape = 'path'：鋼筆的原始錨點（再次編輯用，畫面像素座標） */
  pen?: PenPt[];
}

/** 遮罩自己的鋼筆路徑 */
export const PATH_SHAPE = 'path';

export const DEFAULT_MASK: Mask = { shape: 'none', invert: false, x: 0, y: 0, w: 0.6, h: 0.35, feather: 0.03, rotation: 0 };

export const MASK_PROPS: { prop: 'x' | 'y' | 'w' | 'h' | 'feather' | 'rotation'; label: string; step: number; suffix?: string; display?: number; min?: number; max?: number }[] = [
  { prop: 'x', label: $t('中心 X'), step: 0.005, suffix: ' px', display: 1080 },
  { prop: 'y', label: $t('中心 Y'), step: 0.005, suffix: ' px', display: 1920 },
  { prop: 'w', label: $t('寬'), step: 0.005, suffix: '%', display: 100, min: 0 },
  { prop: 'h', label: $t('高'), step: 0.005, suffix: '%', display: 100, min: 0 },
  { prop: 'feather', label: $t('羽化'), step: 0.002, suffix: '%', display: 100, min: 0 },
  { prop: 'rotation', label: $t('旋轉'), step: 0.5, suffix: '°' },
];

/** 關鍵影格 key 的名稱：`mask.x` */
export const maskKey = (p: string) => `mask.${p}`;

/** 遮罩在特效內時間 local 的值 */
export function maskAt(mask: Mask | undefined, keys: Record<string, Keyframe[]> | undefined, local: number): Mask | null {
  if (!mask || mask.shape === 'none') return null;
  const out = { ...mask };
  for (const { prop } of MASK_PROPS) {
    const k = keys?.[maskKey(prop)];
    if (k?.length) out[prop] = evalKeys(k, local);
  }
  return out;
}
