/** 自動剪輯的內建風格：鏡頭節奏、特效層和固定的轉場語彙。 */
import type { FxRule, RecipeId, RuleWhen } from './autoEdit';

export interface StyleDef {
  rules: FxRule[];
  trWeights: Record<string, number>;
  /** 跟拍變速（沒有 = 不動面板上的設定） */
  speed?: { per32: number; intensity: number };
}

const r = (id: string, moduleId: string, when: RuleWhen, levels: (0 | 1 | 2)[], chance: number, x: Pick<FxRule, 'every' | 'beats' | 'drive'> = {}): FxRule =>
  ({ id, moduleId, on: true, when, levels, chance, ...x });

const VIGNETTE = r('vignette', 'fx-vignette', 'section', [0, 1, 2], 1);
/** 微弱的隨機頻閃，整段維持質感。 */
const FLICKER = r('flicker', 'fx-strobe', 'section', [0, 1, 2], 1,
  { drive: { depth: { source: 'random', min: 0.02, max: 0.16, rate: 8 } } });
const SHAKE = r('shake', 'fx-shake', 'cut', [0, 1, 2], 1);

/** 只用這一個轉場：'*' = 沒列到的（之後新增、自訂的轉場）一律不用；改成自訂、另存風格時跟著帶走 */
const transition = (id: string): Record<string, number> => ({ '*': 0, [id]: 1 });

export const STYLES: Record<RecipeId, StyleDef> = {
  calm: {
    rules: [VIGNETTE, FLICKER, SHAKE,
      r('grain', 'fx-grain', 'section', [0, 1, 2], 1),
      r('leak', 'fx-lightleak', 'accent', [0, 1], 0.25, { beats: 2 })],
    trWeights: transition('tr-crossfade'),
  },
  rhythm: {
    rules: [VIGNETTE, FLICKER, SHAKE,
      r('pulse', 'fx-zoompulse', 'beat', [1, 2], 1, { every: 2 }),
      r('rgb', 'fx-rgb', 'accent', [1, 2], 0.5),
      r('drop', 'fx-flash', 'drop', [0, 1, 2], 1)],
    trWeights: transition('tr-push'),
  },
  hype: {
    rules: [VIGNETTE, FLICKER, SHAKE,
      r('pulse', 'fx-zoompulse', 'beat', [2], 1, { every: 1 }),
      r('flash', 'fx-flash', 'cut', [1, 2], 1),
      r('rgb', 'fx-rgb', 'accent', [1, 2], 0.6),
      r('drop', 'fx-shockwave', 'drop', [0, 1, 2], 1)],
    trWeights: transition('tr-crashzoom'),
  },
  velocity: {
    rules: [VIGNETTE, FLICKER, SHAKE,
      r('pulse', 'fx-zoompulse', 'beat', [2], 1, { every: 1 }),
      r('chroma', 'fx-chromazoom', 'accent', [1, 2], 0.7),
      r('rgb', 'fx-rgb', 'cut', [1, 2], 0.6),
      r('drop', 'fx-flash', 'drop', [0, 1, 2], 1)],
    trWeights: transition('tr-zoomblur'),
    speed: { per32: 4, intensity: 0.75 },
  },
  glitch: {
    rules: [VIGNETTE, FLICKER, SHAKE,
      r('glitch', 'fx-glitch', 'cut', [1, 2], 1),
      r('rgb', 'fx-rgb', 'beat', [2], 0.6, { every: 2 }),
      r('invert', 'fx-invert', 'accent', [2], 0.3),
      r('vhs', 'fx-vhs', 'section', [0, 1, 2], 1)],
    trWeights: transition('tr-glitch'),
  },
  flash: {
    rules: [VIGNETTE, FLICKER, SHAKE,
      r('flash', 'fx-flash', 'cut', [1, 2], 1),
      r('strobe', 'fx-strobe', 'drop', [0, 1, 2], 1, { beats: 2 }),
      r('blur', 'fx-blurpulse', 'beat', [2], 0.6, { every: 1 })],
    trWeights: transition('tr-flash'),
  },
};

export const STYLE_IDS = Object.keys(STYLES) as RecipeId[];
