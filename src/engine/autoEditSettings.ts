/** 自動剪輯面板的設定；面板、套用端、AI 工具共用。風格類設定存在 localStorage（跨專案共用） */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { RECIPES, type FxRule, type PlanOptions, type Recipe, type RecipeId } from './autoEdit';
import { STYLES } from './autoEditStyles';
import type { MusicInfo, SectionKind } from './musicAnalysis';
import { attachedAudioIds, uid, type AudioClip, type Media, type useStore } from '../store';
import { beatSource, mediaBeats } from './beats';
import { FLAT_SHAPE, type EnergyShape } from './energyShape';
import { trackHistory } from './history';
import type { PopVariant } from './subjectPop';
import type { SpeedVariant } from './speedRamp';
import { isFullCrop, type Crop } from './transform';

type S = ReturnType<typeof useStore.getState>;


/** 面板的設定（見 PERSISTED：哪些存在 localStorage）；清單存「不用的」，新加的素材 / 模組預設就會用到 */
export interface AutoEditSettings {
  audioId: string | null;
  range: 'all' | 'loop';
  /** 內建風格 / 自訂（改過）/ 自己存的風格（my:<id>） */
  recipe: StyleKey;
  params: Recipe;
  /** 特效層（選風格時換成風格的那一組；改了之後風格變「自訂」） */
  rules: FxRule[];
  /** 轉場權重：0 = 不用；沒列的 = 1 */
  trWeights: Record<string, number>;
  /** 密度：所有特效層的機率一起乘（1 = 照設定） */
  density: number;
  /** 強度 0..1：特效的主要參數（見 autoEditPools 的 INTENSITY） */
  intensity: number;
  kenBurns: boolean;
  order: PlanOptions['order'];
  /** 'all' = 用素材庫全部（清單上顯示素材庫的每個素材，segs 不用）；'list' = 只用 segs（可以是空的） */
  pick: 'all' | 'list';
  /** 片段清單（從素材分頁拖進來） */
  segs: AeSeg[];
  /** 使用者調整的能量曲線（控制點的位置 = 整段音樂的比例） */
  shape: EnergyShape;
  /** 主體跳出：去背的圖片跟著節拍進場，揭露拍切到完整圖 */
  popOn: boolean;
  popVariants: PopVariant[];
  /** 每 32 拍最多幾次 */
  popsPer32: number;
  /** 「文字在主體後面」用的文字（空的 = 不用這種） */
  popText: string;
  /** 跟拍變速：影片片段的播放速度跟著節拍變化 */
  speedOn: boolean;
  speedVariants: SpeedVariant[];
  /** 每 32 拍最多幾次 */
  speedsPer32: number;
  /** 強度 0..1 */
  speedIntensity: number;
  /** 每個影片鏡頭都套用變速 */
  speedEvery: boolean;
  /** 整體加速（1 = 原速；變速的鏡頭素材用得更快） */
  speedBoost: number;
  /** 分析影片內容（運動量、畫質、原本的剪接點）來挑片段 */
  analyze: boolean;
  /** AI 導演：Gemini 看素材畫面，決定每個素材適合哪些段落、優先度、精彩時間點 */
  director: boolean;
  /** 給 AI 導演的指示 */
  directorNote: string;
  /** 自己存的風格（重設不清掉） */
  myStyles: MyStyle[];
  /** 最近一次的音樂分析（面板的段落條、AI 讀設定用；重設不清掉） */
  analysis: { audioId: string; info: MusicInfo } | null;
  /** 最近一次 AI 導演的結果（面板顯示用；重設不清掉） */
  direction: Record<string, { roles: SectionKind[]; weight: number; highlights: number[]; use?: [number, number][]; avoid?: [number, number][]; note: string; pop?: number }> | null;
}
export type StyleKey = RecipeId | 'custom' | `my:${string}`;
/** 自己存的風格：鏡頭節奏、特效層、轉場權重、密度、強度 */
export interface MyStyle { id: string; name: string; params: Recipe; rules: FxRule[]; trWeights: Record<string, number>; density: number; intensity: number }

/** 指定片段：影片的 a..b 秒（圖片 a = b = 0 = 整張） */
export interface AeSeg { id: string; mediaId: string; a: number; b: number; /** 使用者取的名稱（沒有 = 素材名稱） */ name?: string; /** 裁切框（沒有 = 整個畫面） */ crop?: Crop }

/** 整段（影片 0..長度、圖片 0..0） */
export const wholeSeg = (m: Media, id: string): AeSeg => ({ id, mediaId: m.id, a: 0, b: m.kind === 'video' ? m.duration : 0 });

/**
 * 自動剪輯用的素材：指定片段 = 虛擬素材（id 不同、duration = 片段長度、from = 在原素材的起點、srcId = 原素材）。
 * 編排器、抽樣、AI 導演都把它當一般素材；套用成時間軸片段時才換回原素材 + 加上 from。
 */
export type Footage = Media & { from?: number; srcId?: string; /** 只用畫面的這一塊（分析結果換到框內座標；放上時間軸時放大位移成只看得到框內） */ crop?: Crop };

/** 這次要剪的素材：有指定片段就用片段，沒有就用素材庫（扣掉取消勾選的） */
export function aeFootage(s: S, st: AutoEditSettings): Footage[] {
  const lib = footage(s);
  if (st.pick !== 'list') return lib;
  const out: Footage[] = [];
  for (const g of st.segs) {
    const m = lib.find((x) => x.id === g.mediaId);
    if (!m) continue;
    if (m.kind !== 'video') {
      if (!out.some((x) => x.id === m.id)) out.push(m);
      continue;
    }
    const a = Math.max(0, Math.min(g.a, m.duration)), b = Math.max(a, Math.min(g.b, m.duration));
    if (b - a < 0.2) continue;
    out.push({ ...m, id: `${m.id}@${g.id}`, srcId: m.id, from: a, duration: b - a, name: m.name, ...(isFullCrop(g.crop) ? {} : { crop: g.crop }) });
  }
  return out;
}

/** 風格的特效層 + 轉場權重（複製一份，面板改了不會動到內建的） */
export const styleFields = (id: RecipeId): Pick<AutoEditSettings, 'rules' | 'trWeights'> =>
  ({ rules: structuredClone(STYLES[id].rules), trWeights: { ...STYLES[id].trWeights } });

/** 選風格：鏡頭節奏、特效層、轉場權重都換成風格的；速度感另外把跟拍變速調多 */
export function styleSettings(id: RecipeId): Partial<AutoEditSettings> {
  const sp = STYLES[id].speed;
  return { recipe: id, params: { ...RECIPES[id] }, ...styleFields(id), ...(sp ? { speedOn: true, speedsPer32: sp.per32, speedIntensity: sp.intensity } : {}) };
}

/** 選自己的風格 */
export function myStyleSettings(m: MyStyle): Partial<AutoEditSettings> {
  return { recipe: `my:${m.id}`, params: { ...m.params }, rules: structuredClone(m.rules), trWeights: { ...m.trWeights }, density: m.density, intensity: m.intensity };
}

/** 把目前的設定存成自己的風格（同名 = 覆蓋），並選中它 */
export function saveMyStyle(name: string) {
  const st = useAutoEdit.getState();
  const nm = name.trim();
  if (!nm) return;
  const old = st.myStyles.find((x) => x.name === nm);
  const m: MyStyle = {
    id: old?.id ?? uid(), name: nm, params: { ...st.params }, rules: structuredClone(st.rules), trWeights: { ...st.trWeights },
    density: st.density, intensity: st.intensity,
  };
  st.set({ myStyles: old ? st.myStyles.map((x) => (x.id === m.id ? m : x)) : [...st.myStyles, m], recipe: `my:${m.id}` });
}

export function renameMyStyle(id: string, name: string) {
  const st = useAutoEdit.getState();
  const nm = name.trim();
  if (nm) st.set({ myStyles: st.myStyles.map((x) => (x.id === id ? { ...x, name: nm } : x)) });
}

/** 刪掉自己的風格；正在用的話設定留著、變成「自訂」 */
export function deleteMyStyle(id: string) {
  const st = useAutoEdit.getState();
  st.set({ myStyles: st.myStyles.filter((x) => x.id !== id), ...(st.recipe === `my:${id}` ? { recipe: 'custom' as const } : {}) });
}

const DEFAULTS = (): Omit<AutoEditSettings, 'analysis' | 'direction' | 'myStyles'> => ({
  audioId: null, range: 'all', pick: 'all', segs: [], recipe: 'rhythm', params: { ...RECIPES.rhythm }, ...styleFields('rhythm'), density: 1, intensity: 0.5,
  kenBurns: true, order: 'library', analyze: true, director: false, directorNote: '', shape: FLAT_SHAPE(),
  popOn: true, popVariants: ['step'], popsPer32: 1, popText: '',
  speedOn: true, speedVariants: ['beatPulse'], speedsPer32: 2, speedIntensity: 0.5, speedEvery: false, speedBoost: 1,
});
/** 存在 localStorage 的欄位（個人口味）；音樂、範圍、素材勾選、能量曲線跟專案 / 歌曲有關，不存 */
const PERSISTED = [
  'recipe', 'params', 'rules', 'trWeights', 'density', 'intensity', 'kenBurns', 'order',
  'popOn', 'popVariants', 'popsPer32', 'popText', 'speedOn', 'speedVariants', 'speedsPer32', 'speedIntensity', 'speedEvery', 'speedBoost',
  'analyze', 'director', 'directorNote', 'myStyles',
] as const satisfies readonly (keyof AutoEditSettings)[];

export const useAutoEdit = create<AutoEditSettings & { set(p: Partial<AutoEditSettings>): void; reset(): void }>()(
  persist(
    (set) => ({
      ...DEFAULTS(),
      myStyles: [],
      analysis: null,
      direction: null,
      set: (p) => set(p),
      reset: () => set(DEFAULTS()),
    }),
    {
      name: 'ybeat-autoedit',
      partialize: (s) => Object.fromEntries(PERSISTED.map((k) => [k, s[k]])) as Partial<AutoEditSettings>,
    },
  ),
);


// 面板設定可以 Ctrl+Z（分析結果、AI 導演的結果是算出來的，不記錄；AI 導演開關在 AI 分頁，跟「自動套用」一樣是偏好，也不記錄）
trackHistory(
  'autoEdit',
  useAutoEdit,
  ({ analysis: _a, direction: _d, director: _dr, set: _s, reset: _r, ...rest }) => rest as Record<string, unknown>,
  (v) => useAutoEdit.setState(v as Partial<AutoEditSettings>),
);

/** 上一版還能不能被「再一版」換掉（autoEditApply 設定；給 AI 工具看，避免 import 循環） */
export const lastTake = { replaceable: () => false };

/** 可以當配樂的音訊片段：有節拍、不是影片連結的原音；長的排前面 */
export function musicClips(s: S): AudioClip[] {
  const att = attachedAudioIds(s);
  return s.audios
    .filter((a) => beatSource(a, att) && (mediaBeats(s.media.find((m) => m.id === a.mediaId))?.beats.length ?? 0) >= 8)
    .sort((a, b) => b.duration - a.duration);
}

/** 可以拿來剪的素材（影片 / 圖片，素材庫順序） */
export const footage = (s: S): Media[] => s.media.filter((m) => !m.missing && (m.kind === 'video' || m.kind === 'image'));

