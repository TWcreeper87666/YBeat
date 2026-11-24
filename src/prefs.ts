import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ClipFx, FxItem, TransitionRef } from './store';
import type { Transform } from './engine/transform';
import type { TextStyle } from './engine/text';

/** 使用者存的文字樣式（文字素材庫的「我的樣式」）：連同位置、轉場、片段特效一起存 */
export interface UserTextStyle {
  id: string;
  name: string;
  style: TextStyle;
  transform: Transform;
  transitionIn: TransitionRef | null;
  transitionOut: TransitionRef | null;
  effects: ClipFx[];
}

/** 使用者存的特效組合（特效素材庫的「我的組合」）：主特效 + 疊加的特效 + 觸發，id 以 combo: 開頭 */
export interface FxCombo {
  id: string;
  name: string;
  fx: Omit<FxItem, 'id' | 'start' | 'track'>;
}
export const COMBO_PREFIX = 'combo:';
export const isCombo = (id: string) => id.startsWith(COMBO_PREFIX);

/** 使用者偏好（跟專案無關、跨專案保留）：新增項目的預設長度 */
interface Prefs {
  /** 圖片 / 色板 / 文字片段的預設長度（秒） */
  stillDur: number;
  /** 轉場的預設長度（秒） */
  transDur: number;
  /** 專案有變更就自動存檔（關掉 = 只有 Ctrl+S 才存） */
  autosave: boolean;
  /** 預覽代理檔（proxy.ts）：關鍵影格很稀的影片，預覽改用背景產生的小副本 */
  proxy: boolean;
  textStyles: UserTextStyle[];
  fxCombos: FxCombo[];
  set(p: Partial<Omit<Prefs, 'set'>>): void;
}

export const usePrefs = create<Prefs>()(
  persist((set) => ({ stillDur: 2, transDur: 0.4, autosave: true, proxy: true, textStyles: [], fxCombos: [], set: (p) => set(p) }), {
    name: 'ybeat-prefs',
    partialize: (s) => ({ stillDur: s.stillDur, transDur: s.transDur, autosave: s.autosave, proxy: s.proxy, textStyles: s.textStyles, fxCombos: s.fxCombos }),
  }),
);

export const stillDur = () => Math.max(0.1, usePrefs.getState().stillDur || 2);
export const transDur = () => Math.max(0.05, usePrefs.getState().transDur || 0.4);

/** 文字樣式 id → 預設樣式或「我的樣式」（user: 開頭） */
export const userTextStyle = (id: string) => (id.startsWith('user:') ? usePrefs.getState().textStyles.find((x) => x.id === id) : undefined);

/** combo: id → 特效組合 */
export const fxCombo = (id: string) => (isCombo(id) ? usePrefs.getState().fxCombos.find((x) => x.id === id) : undefined);
