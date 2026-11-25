/**
 * 自動剪輯的內建風格：鏡頭節奏（RECIPES）+ 特效層 + 轉場權重（沒列的轉場 = 1）。
 * 每拍 / 剪接點的特效層是「整段一個方塊」，同一衝突組的兩層不要用在同一種能量（不然後面那層整段讓開）。
 */
import type { FxRule, RecipeId, RuleWhen } from './autoEdit';
import type { BeatEvery } from './trigger';

export interface StyleDef {
  rules: FxRule[];
  trWeights: Record<string, number>;
  /** 跟拍變速（沒有 = 不動面板上的設定） */
  speed?: { per32: number; intensity: number };
}

const r = (id: string, moduleId: string, when: RuleWhen, levels: (0 | 1 | 2)[], chance: number, x: { every?: BeatEvery; beats?: number } = {}): FxRule =>
  ({ id, moduleId, on: true, when, levels, chance, ...x });

/** 強烈的轉場（穩的時候少用） */
const STRONG = ['tr-whip', 'tr-glitch', 'tr-rgbsplit', 'tr-shake', 'tr-crashzoom', 'tr-flash', 'tr-spin', 'tr-shockwave'];

export const STYLES: Record<RecipeId, StyleDef> = {
  calm: {
    rules: [
      r('vignette', 'fx-vignette', 'section', [0, 1, 2], 1),
      r('letterbox', 'fx-letterbox', 'section', [0], 1),
      r('grain', 'fx-grain', 'section', [0, 1, 2], 1),
      r('leak', 'fx-lightleak', 'accent', [0, 1], 0.3, { beats: 2 }),
    ],
    trWeights: { 'tr-crossfade': 3, 'tr-luma': 2, 'tr-blur': 2, ...Object.fromEntries(STRONG.map((id) => [id, 0.2])) },
  },
  rhythm: {
    rules: [
      r('vignette', 'fx-vignette', 'section', [0, 1, 2], 1),
      r('pulse', 'fx-zoompulse', 'beat', [2], 1, { every: 2 }),
      r('rgb', 'fx-rgb', 'accent', [1, 2], 0.4),
      r('drop', 'fx-flash', 'drop', [0, 1, 2], 1),
      r('letterbox', 'fx-letterbox', 'section', [0], 1),
    ],
    trWeights: { 'tr-push': 2, 'tr-whip': 2, 'tr-flash': 1.5 },
  },
  hype: {
    rules: [
      r('vignette', 'fx-vignette', 'section', [0, 1, 2], 1),
      r('shake', 'fx-shake', 'beat', [2], 1, { every: 1 }),
      r('pulse', 'fx-zoompulse', 'beat', [1], 1, { every: 2 }),
      r('flash', 'fx-flash', 'cut', [1, 2], 0.6),
      r('rgb', 'fx-rgb', 'beat', [2], 0.4, { every: 1 }),
      r('drop', 'fx-shockwave', 'drop', [0, 1, 2], 1),
    ],
    trWeights: { 'tr-shake': 2, 'tr-crashzoom': 2, 'tr-flash': 2 },
  },
  velocity: {
    rules: [
      r('vignette', 'fx-vignette', 'section', [0, 1, 2], 1),
      r('pulse', 'fx-zoompulse', 'beat', [2], 1, { every: 1 }),
      r('shake', 'fx-shake', 'beat', [1, 2], 0.6, { every: 2 }),
      r('chroma', 'fx-chromazoom', 'accent', [1], 0.7),
      r('crash', 'fx-crashzoom', 'accent', [2], 0.5),
      r('rgb', 'fx-rgb', 'cut', [1, 2], 0.5),
      r('drop', 'fx-flash', 'drop', [0, 1, 2], 1),
    ],
    trWeights: { 'tr-whip': 3, 'tr-zoomblur': 3, 'tr-crashzoom': 2 },
    speed: { per32: 4, intensity: 0.7 },
  },
  glitch: {
    rules: [
      r('vignette', 'fx-vignette', 'section', [0, 1, 2], 1),
      r('glitch', 'fx-glitch', 'cut', [2], 0.5),
      r('rgb', 'fx-rgb', 'beat', [1], 0.5, { every: 1 }),
      r('twitch', 'fx-twitch', 'accent', [1, 2], 0.7),
      r('invert', 'fx-invert', 'beat', [2], 0.25, { every: 4 }),
      r('duotone', 'fx-duotone', 'section', [0], 1),
      r('vhs', 'fx-vhs', 'section', [0, 1], 1),
    ],
    trWeights: { 'tr-glitch': 3, 'tr-slice': 3, 'tr-rgbsplit': 3, 'tr-pixelate': 2 },
  },
  flash: {
    rules: [
      r('vignette', 'fx-vignette', 'section', [0, 1, 2], 1),
      r('flash', 'fx-flash', 'cut', [1, 2], 0.8),
      r('strobe', 'fx-strobe', 'drop', [0, 1, 2], 1, { beats: 4 }),
      r('blur', 'fx-blurpulse', 'beat', [2], 0.5, { every: 1 }),
      r('leak', 'fx-lightleak', 'accent', [0, 1], 0.4, { beats: 2 }),
    ],
    trWeights: { 'tr-flash': 3, 'tr-exposure': 3, 'tr-blur': 2 },
  },
};

export const STYLE_IDS = Object.keys(STYLES) as RecipeId[];
