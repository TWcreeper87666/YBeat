import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/** 使用者偏好（跟專案無關、跨專案保留）：新增項目的預設長度 */
interface Prefs {
  /** 圖片 / 色板 / 文字片段的預設長度（秒） */
  stillDur: number;
  /** 轉場的預設長度（秒） */
  transDur: number;
  set(p: Partial<Omit<Prefs, 'set'>>): void;
}

export const usePrefs = create<Prefs>()(
  persist((set) => ({ stillDur: 2, transDur: 0.4, set: (p) => set(p) }), {
    name: 'ybeat-prefs',
    partialize: (s) => ({ stillDur: s.stillDur, transDur: s.transDur }),
  }),
);

export const stillDur = () => Math.max(0.1, usePrefs.getState().stillDur || 2);
export const transDur = () => Math.max(0.05, usePrefs.getState().transDur || 0.4);
