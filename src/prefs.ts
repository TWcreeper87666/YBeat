import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ClipFx, FxItem, TransitionRef } from './store';
import type { Transform } from './engine/transform';
import type { TextStyle } from './engine/text';
import { BUILTIN_COMBOS } from './modules/combos';

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
  /** 內建組合（modules/combos.ts）：不能改名、刪除 */
  builtin?: boolean;
}
export const COMBO_PREFIX = 'combo:';
export const isCombo = (id: string) => id.startsWith(COMBO_PREFIX);

export type Theme = 'dark' | 'light' | 'system';
export type ProxyQuality = 'low' | 'medium' | 'high';
/** 預覽疊加框：遮罩、反轉遮罩、臉部 / 目標追蹤、特效參數、片段變換 */
export interface OverlayColors { mask: string; maskInv: string; track: string; param: string; clip: string }
export const OVERLAY_DEFAULT: OverlayColors = { mask: '#ffd27a', maskInv: '#ff8a3d', track: '#b98cff', param: '#29d3c2', clip: '#ffffff' };

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
  /** 代理檔畫質（proxy.ts 的 PROXY_BITRATE） */
  proxyQuality: ProxyQuality;
  textStyles: UserTextStyle[];
  fxCombos: FxCombo[];
  /** 介面主題 */
  theme: Theme;
  /** 疊在預覽上的框的顏色 */
  overlay: OverlayColors;
  set(p: Partial<Omit<Prefs, 'set'>>): void;
}

export const usePrefs = create<Prefs>()(
  persist((set) => ({ stillDur: 2, transDur: 0.4, autosave: true, proxy: true, proxyQuality: 'medium', textStyles: [], fxCombos: [], theme: 'dark', overlay: OVERLAY_DEFAULT, set: (p) => set(p) }), {
    name: 'ybeat-prefs',
    partialize: (s) => ({ stillDur: s.stillDur, transDur: s.transDur, autosave: s.autosave, proxy: s.proxy, proxyQuality: s.proxyQuality, textStyles: s.textStyles, fxCombos: s.fxCombos, theme: s.theme, overlay: s.overlay }),
  }),
);

export const stillDur = () => Math.max(0.1, usePrefs.getState().stillDur || 2);
export const transDur = () => Math.max(0.05, usePrefs.getState().transDur || 0.4);

/** 文字樣式 id → 預設樣式或「我的樣式」（user: 開頭） */
export const userTextStyle = (id: string) => (id.startsWith('user:') ? usePrefs.getState().textStyles.find((x) => x.id === id) : undefined);

/** combo: id → 特效組合（內建或我的組合） */
export const fxCombo = (id: string) => (isCombo(id) ? BUILTIN_COMBOS.find((x) => x.id === id) ?? usePrefs.getState().fxCombos.find((x) => x.id === id) : undefined);

/** 把主題與疊加色套到 <html>（data-theme + --ov-* 變數），偏好或系統主題變了就更新 */
export function applyAppearance() {
  if (typeof document === 'undefined') return;
  const mq = window.matchMedia?.('(prefers-color-scheme: light)');
  const apply = () => {
    const { theme, overlay } = usePrefs.getState();
    const o = { ...OVERLAY_DEFAULT, ...overlay };
    const root = document.documentElement;
    const t = theme === 'system' ? (mq?.matches ? 'light' : 'dark') : theme;
    root.dataset.theme = t;
    useResolvedTheme.setState({ theme: t });
    root.style.setProperty('--ov-mask', o.mask);
    root.style.setProperty('--ov-mask-dark', `color-mix(in srgb, ${o.mask} 72%, #000)`);
    root.style.setProperty('--ov-mask-inv', o.maskInv);
    root.style.setProperty('--ov-track', o.track);
    root.style.setProperty('--ov-param', o.param);
    root.style.setProperty('--ov-clip', o.clip);
  };
  apply();
  usePrefs.subscribe((s, p) => (s.theme !== p.theme || s.overlay !== p.overlay) && apply());
  mq?.addEventListener('change', apply);
}

/** 實際使用中的主題（system → 依系統） */
export const useResolvedTheme = create<{ theme: 'dark' | 'light' }>(() => ({ theme: 'dark' }));
