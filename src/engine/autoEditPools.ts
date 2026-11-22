/**
 * 自動剪輯可以用的轉場 / 點綴：從模組（內建 + 自訂）和「我的組合」產生，附上編排器要的標記
 * （轉場的強度、點綴是衝擊型 / 持續型、適合的能量）。內建模組照下面的表；自訂模組用分類與 @hit 猜。
 */
import type { Module } from '../modules/builtin';
import type { FxCombo } from '../prefs';
import { categoryOf } from '../modules/categories';
import { isHitFx } from './params';
import type { AccentOpt, TransitionOpt } from './autoEdit';

/** 轉場強度：0 柔和 … 1 強烈 */
const TR_STRENGTH: Record<string, number> = {
  'tr-crossfade': 0.1, 'tr-blur': 0.2, 'tr-luma': 0.25, 'tr-exposure': 0.35, 'tr-diagonal': 0.35, 'tr-iris': 0.35, 'tr-clock': 0.3,
  'tr-slice': 0.45, 'tr-split': 0.45, 'tr-push': 0.55, 'tr-scalein': 0.5, 'tr-scaleout': 0.5, 'tr-lens': 0.5, 'tr-liquid': 0.45,
  'tr-pixelate': 0.55, 'tr-flip': 0.6, 'tr-twirl': 0.6, 'tr-stretch': 0.65, 'tr-rewind': 0.6, 'tr-spin': 0.7, 'tr-zoomblur': 0.75,
  'tr-whip': 0.8, 'tr-rgbsplit': 0.8, 'tr-glitch': 0.8, 'tr-shockwave': 0.85, 'tr-shake': 0.85, 'tr-crashzoom': 0.9, 'tr-flash': 1,
};
const TR_CAT_STRENGTH: Record<string, number> = { basic: 0.25, wipe: 0.4, distort: 0.55, style: 0.65, motion: 0.75 };

/** 內建特效當點綴的方式（沒列的照分類猜） */
const FX_ACCENT: Record<string, Omit<AccentOpt, 'id'>> = {
  'fx-letterbox': { hit: false, mood: 'any', beats: 6 },
  'fx-zoompulse': { hit: false, everyBeat: true, mood: 'intense' },
  'fx-blurpulse': { hit: false, everyBeat: true, mood: 'intense' },
  'fx-strobe': { hit: false, mood: 'intense', beats: 2 },
  'fx-rgb': { hit: false, mood: 'intense', beats: 2 },
  'fx-glitch': { hit: false, mood: 'intense', beats: 2 },
  'fx-twitch': { hit: false, mood: 'intense', beats: 2 },
  'fx-vhs': { hit: false, mood: 'calm', beats: 8 },
  'fx-grain': { hit: false, mood: 'calm', beats: 8 },
  'fx-bw': { hit: false, mood: 'calm', beats: 4 },
  'fx-duotone': { hit: false, mood: 'calm', beats: 4 },
  'fx-lightleak': { hit: false, mood: 'calm', beats: 4 },
  'fx-handheld': { hit: false, mood: 'calm', beats: 8 },
  'fx-invert': { hit: false, mood: 'intense', beats: 1 },
};

/** 不適合自動放的工具型特效（去背、遮罩、跟隨、調色…）：預設不勾 */
export const ACCENT_OFF_BY_DEFAULT = new Set([
  'fx-chromakey', 'fx-clipmask', 'fx-mosaic', 'fx-followzoom', 'fx-grade', 'fx-entrance', 'fx-outline', 'fx-kaleido', 'fx-mirror', 'fx-tilezoom', 'fx-hue',
]);

export function transitionOpt(m: Module): TransitionOpt {
  return { id: m.id, strength: TR_STRENGTH[m.id] ?? TR_CAT_STRENGTH[categoryOf(m)] ?? 0.5 };
}

export function accentOpt(m: Module): AccentOpt {
  const known = FX_ACCENT[m.id];
  if (known) return { id: m.id, ...known };
  if (isHitFx(m)) return { id: m.id, hit: true, mood: categoryOf(m) === 'light' ? 'intense' : 'any' };
  const cat = categoryOf(m);
  return { id: m.id, hit: false, mood: cat === 'color' ? 'calm' : cat === 'glitch' ? 'intense' : 'any', beats: cat === 'glitch' ? 2 : 4 };
}

/** 我的組合：有節拍觸發 = 每拍型；主特效是衝擊型 = 衝擊型；其他 = 持續型 */
export function comboAccentOpt(c: FxCombo, modules: Module[]): AccentOpt {
  const main = modules.find((m) => m.id === c.fx.moduleId);
  if (c.fx.trigger?.kind === 'beat') return { id: c.id, hit: false, everyBeat: true, mood: 'intense' };
  if (main && isHitFx(main)) return { id: c.id, hit: true, mood: 'any' };
  return { id: c.id, hit: false, mood: main ? accentOpt(main).mood : 'any', beats: 4 };
}
