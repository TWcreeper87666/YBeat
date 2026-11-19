import { $t } from '../i18n';
import type { Module, ModuleKind } from './builtin';

/** 內建模組的分類（自訂模組一律歸在「自訂」） */
export const CATEGORIES: Record<ModuleKind, { id: string; label: string }[]> = {
  effect: [
    { id: 'motion', label: $t('運鏡 / 晃動') },
    { id: 'distort', label: $t('扭曲') },
    { id: 'color', label: $t('色彩') },
    { id: 'light', label: $t('光效 / 閃光') },
    { id: 'glitch', label: $t('故障 / 復古') },
    { id: 'frame', label: $t('畫面 / 構圖') },
    { id: 'style', label: $t('風格化') },
  ],
  transition: [
    { id: 'basic', label: $t('基本') },
    { id: 'motion', label: $t('動態') },
    { id: 'wipe', label: $t('擦除') },
    { id: 'style', label: $t('風格化') },
  ],
  remap: [
    { id: 'speed', label: $t('變速') },
    { id: 'special', label: $t('特殊') },
  ],
};

const MAP: Record<string, string> = {
  'fx-crashzoom': 'motion',
  'fx-shake': 'motion',
  'fx-entrance': 'motion',
  'fx-shakeblur': 'motion',
  'fx-motionblur': 'motion',
  'fx-zoompulse': 'motion',
  'fx-lens': 'distort',
  'fx-wave': 'distort',
  'fx-twirl': 'distort',
  'fx-grade': 'color',
  'fx-invert': 'color',
  'fx-hue': 'color',
  'fx-bw': 'color',
  'fx-flash': 'light',
  'fx-strobe': 'light',
  'fx-glow': 'light',
  'fx-lightleak': 'light',
  'fx-rgb': 'glitch',
  'fx-glitch': 'glitch',
  'fx-pixelate': 'glitch',
  'fx-vhs': 'glitch',
  'fx-grain': 'glitch',
  'fx-mirror': 'frame',
  'fx-split': 'frame',
  'fx-kaleido': 'frame',
  'fx-letterbox': 'frame',
  'fx-speedlines': 'style',
  'fx-outline': 'style',
  'fx-chromakey': 'color',
  'fx-clipmask': 'frame',
  'tr-crossfade': 'basic',
  'tr-flash': 'basic',
  'tr-crashzoom': 'motion',
  'tr-whip': 'motion',
  'tr-spin': 'motion',
  'tr-stretch': 'motion',
  'tr-zoomblur': 'motion',
  'tr-scalein': 'motion',
  'tr-scaleout': 'motion',
  'tr-push': 'motion',
  'tr-flip': 'motion',
  'tr-rewind': 'style',
  'tr-diagonal': 'wipe',
  'tr-iris': 'wipe',
  'tr-clock': 'wipe',
  'tr-pixelate': 'style',
  'tr-glitch': 'style',
  'remap-speed': 'speed',
  'remap-ramp': 'speed',
  'remap-boomerang': 'special',
  'remap-strobe': 'special',
};

/** 模組的分類 id；自訂模組回傳 'custom' */
export function categoryOf(m: Module): string {
  if (!m.builtin) return 'custom';
  return MAP[m.id] ?? 'other';
}
