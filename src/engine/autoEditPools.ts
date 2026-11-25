/**
 * 自動剪輯可以用的轉場 / 點綴：從模組（內建 + 自訂）和「我的組合」產生，附上編排器要的標記
 * （轉場的強度、點綴是衝擊型 / 持續型、適合的能量）。內建模組照下面的表；自訂模組用分類與 @hit 猜。
 */
import type { Module } from '../modules/builtin';
import type { FxCombo } from '../prefs';
import { categoryOf } from '../modules/categories';
import { isHitFx } from './params';
import type { AccentOpt, FxGroup, TransitionOpt } from './autoEdit';

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
  'fx-vignette': { hit: false, mood: 'any', beats: 8 },
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
  'fx-chromakey', 'fx-clipmask', 'fx-mosaic', 'fx-followzoom', 'fx-grade', 'fx-entrance', 'fx-outline', 'fx-kaleido', 'fx-mirror', 'fx-tilezoom', 'fx-hue', 'fx-matteoutline', 'fx-blur',
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

/** 特效層的衝突組：先照分類推，再用這張表修正（分類太粗：晃動、縮放都在「運鏡」） */
const FX_GROUP: Record<string, FxGroup> = {
  'fx-crashzoom': 'zoom', 'fx-zoompulse': 'zoom', 'fx-chromazoom': 'zoom', 'fx-spinkick': 'zoom', 'fx-squash': 'zoom', 'fx-tilt3d': 'zoom',
  'fx-blurpulse': 'zoom', 'fx-zoomecho': 'zoom', 'fx-tilezoom': 'zoom', 'fx-lens': 'zoom', 'fx-wave': 'zoom', 'fx-twirl': 'zoom', 'fx-shockwave': 'zoom',
  'fx-shake': 'shake', 'fx-shakeblur': 'shake', 'fx-handheld': 'shake', 'fx-twitch': 'shake', 'fx-motionblur': 'shake',
  'fx-flash': 'flash', 'fx-strobe': 'flash', 'fx-invert': 'flash',
  'fx-rgb': 'glitch', 'fx-glitch': 'glitch', 'fx-pixelate': 'glitch', 'fx-slice': 'glitch',
  'fx-bw': 'color', 'fx-duotone': 'color', 'fx-hue': 'color', 'fx-grade': 'color',
  'fx-grain': 'ambient', 'fx-vhs': 'ambient', 'fx-lightleak': 'ambient', 'fx-glow': 'ambient', 'fx-letterbox': 'ambient', 'fx-vignette': 'ambient',
};
const CAT_GROUP: Record<string, FxGroup> = { motion: 'zoom', distort: 'zoom', light: 'flash', color: 'color', glitch: 'glitch' };

export function fxGroup(m: Module): FxGroup {
  return FX_GROUP[m.id] ?? CAT_GROUP[categoryOf(m)] ?? 'other';
}

/** 「強度」0..1 調的參數：特效 → [參數, 強度 0 的值, 強度 1 的值]（其他參數維持預設；沒列的特效不受影響） */
const INTENSITY: Record<string, [string, number, number]> = {
  'fx-crashzoom': ['amount', 0.15, 1.2], 'fx-zoompulse': ['amount', 0.04, 0.28],
  'fx-shake': ['strength', 0.015, 0.1], 'fx-shakeblur': ['strength', 0.02, 0.12],
  'fx-flash': ['intensity', 0.3, 1.8], 'fx-strobe': ['depth', 0.25, 0.9],
  'fx-rgb': ['amount', 0.008, 0.06], 'fx-glitch': ['amount', 0.2, 0.9], 'fx-twitch': ['amount', 0.2, 0.9],
  'fx-shockwave': ['strength', 0.02, 0.12], 'fx-chromazoom': ['amount', 0.03, 0.2], 'fx-blurpulse': ['amount', 0.008, 0.08],
  'fx-duotone': ['strength', 0.25, 1], 'fx-lightleak': ['intensity', 0.2, 1.3], 'fx-grain': ['amount', 0.03, 0.2],
  'fx-vignette': ['amount', 0.3, 0.8],
};

/**
 * 自動剪輯放這些特效時，參數跟著音樂音量動（min = 安靜時、max = 最大聲時）。
 * 暗角：越大聲，中間亮的範圍越小（外圍的暗往內收）。
 */
export const AUDIO_DRIVE: Record<string, { param: string; min: number; max: number }> = {
  'fx-vignette': { param: 'size', min: 0.65, max: 0.28 },
};

export function intensityParams(id: string, v: number): Record<string, number> | undefined {
  const x = INTENSITY[id];
  if (!x) return undefined;
  const k = Math.min(1, Math.max(0, v));
  return { [x[0]]: x[1] + (x[2] - x[1]) * k };
}
