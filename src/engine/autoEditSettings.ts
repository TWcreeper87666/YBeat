/** 自動剪輯面板的設定（只在記憶體）；面板、套用端、AI 工具共用 */
import { create } from 'zustand';
import { RECIPES, type PlanOptions, type Recipe, type RecipeId } from './autoEdit';
import { ACCENT_OFF_BY_DEFAULT } from './autoEditPools';
import type { MusicInfo, SectionKind } from './musicAnalysis';
import { attachedAudioIds, type AudioClip, type Media, type useStore } from '../store';
import { beatSource, mediaBeats } from './beats';
import { FLAT_SHAPE, type EnergyShape } from './energyShape';
import { trackHistory } from './history';

type S = ReturnType<typeof useStore.getState>;


/** 面板的設定（只在記憶體，重新整理就回到預設）；清單存「不用的」，新加的素材 / 模組預設就會用到 */
export interface AutoEditSettings {
  audioId: string | null;
  range: 'all' | 'loop';
  recipe: RecipeId | 'custom';
  params: Recipe;
  mediaOff: string[];
  trOff: string[];
  fxOff: string[];
  dropHit: string | null;
  kenBurns: boolean;
  order: PlanOptions['order'];
  /** 使用者調整的能量曲線（控制點的位置 = 整段音樂的比例） */
  shape: EnergyShape;
  /** 分析影片內容（運動量、畫質、原本的剪接點）來挑片段 */
  analyze: boolean;
  /** AI 導演：Gemini 看素材畫面，決定每個素材適合哪些段落、優先度、精彩時間點 */
  director: boolean;
  /** 給 AI 導演的指示 */
  directorNote: string;
  /** 最近一次的音樂分析（面板的段落條、AI 讀設定用；重設不清掉） */
  analysis: { audioId: string; info: MusicInfo } | null;
  /** 最近一次 AI 導演的結果（面板顯示用；重設不清掉） */
  direction: Record<string, { roles: SectionKind[]; weight: number; highlights: number[]; note: string }> | null;
}
const DEFAULTS = (): Omit<AutoEditSettings, 'analysis' | 'direction'> => ({
  audioId: null, range: 'all', recipe: 'rhythm', params: { ...RECIPES.rhythm }, mediaOff: [], trOff: [], fxOff: [...ACCENT_OFF_BY_DEFAULT],
  dropHit: 'fx-flash', kenBurns: true, order: 'library', analyze: true, director: false, directorNote: '', shape: FLAT_SHAPE(),
});
export const useAutoEdit = create<AutoEditSettings & { set(p: Partial<AutoEditSettings>): void; reset(): void }>((set) => ({
  ...DEFAULTS(),
  analysis: null,
  direction: null,
  set: (p) => set(p),
  reset: () => set(DEFAULTS()),
}));


// 面板設定可以 Ctrl+Z（分析結果、AI 導演的結果是算出來的，不記錄）
trackHistory(
  'autoEdit',
  useAutoEdit,
  ({ analysis: _a, direction: _d, set: _s, reset: _r, ...rest }) => rest as Record<string, unknown>,
  (v) => useAutoEdit.setState(v as Partial<AutoEditSettings>),
);

/** 可以當配樂的音訊片段：有節拍、不是影片連結的原音；長的排前面 */
export function musicClips(s: S): AudioClip[] {
  const att = attachedAudioIds(s);
  return s.audios
    .filter((a) => beatSource(a, att) && (mediaBeats(s.media.find((m) => m.id === a.mediaId))?.beats.length ?? 0) >= 8)
    .sort((a, b) => b.duration - a.duration);
}

/** 可以拿來剪的素材（影片 / 圖片，素材庫順序） */
export const footage = (s: S): Media[] => s.media.filter((m) => !m.missing && (m.kind === 'video' || m.kind === 'image'));

