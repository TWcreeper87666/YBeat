import { $t } from '../i18n';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { setFps, type TimeGrid } from '../engine/rulerTicks';
import type { DropFit, TrackKind } from '../store';
import type { MediaPlacement } from '../engine/mediaBatch';

// ───────────── 版面（記住在 localStorage）─────────────

export interface FloatRect { x: number; y: number; w: number; h: number }
interface Layout {
  leftW: number;
  timelineH: number;
  codeH: number;
  floating: boolean;
  floatRect: FloatRect;
  grid: boolean;
  gridRows: number;
  gridCols: number;
  gridCenter: boolean;
  gridSafe: boolean;
  /** 時間軸顯示節拍格線（也會吸附到節拍） */
  beats: boolean;
  /** 節拍格線細分：每拍、半拍或四分之一拍 */
  beatDivision: 1 | 2 | 4;
  codeOpen: boolean;
  clipTab: 'frame' | 'speed' | 'sound';
  /** 效果控制：收合的區塊 */
  ecCollapsed: Record<string, boolean>;
  /** 素材庫顯示方式 / 篩選 */
  libView: Record<string, 'list' | 'grid'>;
  mediaFilter: 'all' | 'video' | 'image' | 'audio';
  /** 預覽畫質（渲染解析度倍率；匯出一律全解析度） */
  previewScale: number;
  /** 循環播放：播到結尾（編輯視窗 = 片段結尾）回到開頭繼續播 */
  repeat: boolean;
  /** 暫停時拖播放頭也播聲音 */
  scrubAudio: boolean;
  /** 節拍提前（1/60 秒）：節拍格線 / 吸附 / 節拍分割都往前移這麼多，畫面先切、聲音後到，看起來才對拍 */
  beatLead: number;
  /** 時間軸格線：一格 1/30 或 1/60 秒 */
  timeGrid: TimeGrid;
  /** 時間軸滾輪：horizontal = 直接滾左右捲、Shift 上下捲；vertical = 直接滾上下捲、Shift 左右捲 */
  wheelScroll: 'horizontal' | 'vertical';
  /** 時間軸上，上層（蓋在上面的）軌道顯示在下方還是上方 */
  upperLayerAt: 'bottom' | 'top';
  /** 特效 / 轉場 / 變速分頁目前選的分類 */
  modCat: Record<string, string>;
  /** 素材庫的分類籤有沒有展開（搜尋列右邊的篩選按鈕；收起來 = 全部） */
  libFilterOpen: Record<string, boolean>;
  /** 編輯視窗：排版（auto = 依視窗比例；stacked = 預覽上、屬性下；side = 屬性左、預覽右）與分隔比例（預覽 / 屬性所佔比例） */
  editorLayout: 'auto' | 'stacked' | 'side';
  editorSplit: { stacked: number; side: number };
  /** 屬性表格左欄（名稱 + 數值）的寬度（px）：固定寬度，面板變窄時只縮右邊的關鍵影格時間軸；屬性分頁與編輯視窗共用 */
  ecLeftPx: number;
  /** 素材庫格狀檢視的卡片寬度（px）：所有分頁共用，Ctrl+滾輪縮放 */
  libCard: number;
  /** 素材庫清單檢視的縮圖大小（px）：所有分頁共用；格狀縮到最小再縮 = 切成清單 */
  libRow: number;
  /** 軌道預設高度（沒有自己調過高度的軌道） */
  trackSize: 's' | 'm' | 'l';
  /** 預覽周圍的底色（空字串 = 預設） */
  previewBg: string;
  set(p: Partial<Omit<Layout, 'set' | 'reset'>>): void;
  reset(): void;
}
const LAYOUT_DEFAULT = { leftW: 480, timelineH: 320, codeH: 320, floating: false, floatRect: { x: 120, y: 60, w: 360, h: 640 }, grid: false, gridRows: 3, gridCols: 3, gridCenter: true, gridSafe: true, beats: true, beatDivision: 1 as const, codeOpen: false, clipTab: 'frame' as const, ecCollapsed: {} as Record<string, boolean>, libView: { media: 'grid', transition: 'grid', effect: 'grid', remap: 'list', text: 'grid' } as Record<string, 'list' | 'grid'>, mediaFilter: 'all' as Layout['mediaFilter'], previewScale: 1, repeat: false, scrubAudio: true, beatLead: 4, timeGrid: 60 as TimeGrid, wheelScroll: 'horizontal' as Layout['wheelScroll'], upperLayerAt: 'bottom' as Layout['upperLayerAt'], modCat: {} as Record<string, string>, libFilterOpen: {} as Record<string, boolean>, editorLayout: 'auto' as Layout['editorLayout'], editorSplit: { stacked: 0.6, side: 0.42 }, ecLeftPx: 300, libCard: 84, libRow: 30, previewBg: '', trackSize: 'm' as Layout['trackSize'] };

export const useLayout = create<Layout>()(
  persist(
    (set) => ({
      ...LAYOUT_DEFAULT,
      set: (p) => set(p),
      reset: () => set(LAYOUT_DEFAULT),
    }),
    {
      name: 'ybeat-layout',
      // 存檔是 version 1；改掉的話 zustand 會因為版本不符丟掉存檔
      version: 1,
    },
  ),
);
// 時間軸格線：引擎不碰 UI 設定，由這裡同步過去
setFps(useLayout.getState().timeGrid);
useLayout.subscribe((s, p) => {
  if (s.timeGrid !== p.timeGrid) setFps(s.timeGrid);
});

// ───────────── 提示訊息 ─────────────

interface Toast { id: number; text: string; kind: 'info' | 'error' }
export const useToast = create<{ toasts: Toast[]; /** 進行中的工作（不會自動消失，null = 沒有） */ busy: string | null }>(() => ({ toasts: [], busy: null }));
export const setBusy = (busy: string | null) => useToast.setState({ busy });
let toastId = 0;
export function toast(text: string, kind: Toast['kind'] = 'info') {
  const id = ++toastId;
  useToast.setState((s) => ({ toasts: [...s.toasts, { id, text, kind }] }));
  setTimeout(() => useToast.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === 'error' ? 5000 : 2200);
}

// ───────────── 右鍵選單 / 下拉選單 ─────────────

export type MenuItem =
  | { label: string; shortcut?: string; action?: () => void; disabled?: boolean; checked?: boolean; danger?: boolean; /** 子選單（滑過去展開） */ submenu?: MenuItem[] }
  | { separator: true };
export interface MenuState { x: number; y: number; items: MenuItem[]; owner?: string }
export const useMenu = create<{ menu: MenuState | null }>(() => ({ menu: null }));
export function openMenu(x: number, y: number, items: MenuItem[], owner?: string) {
  useMenu.setState({ menu: { x, y, items, owner } });
}
export const closeMenu = () => useMenu.setState({ menu: null });

// ───────────── 確認對話框 ─────────────

export interface ConfirmReq { title: string; message: string; ok: string; danger?: boolean; input?: string; resolve: (v: boolean, text?: string) => void }
export const useConfirm = create<{ req: ConfirmReq | null }>(() => ({ req: null }));

/** 跳出輸入框，按確定回傳文字，取消回傳 null */
export function promptDialog(o: { title: string; message?: string; value: string; ok?: string }): Promise<string | null> {
  return new Promise((resolve) => {
    useConfirm.getState().req?.resolve(false);
    useConfirm.setState({ req: { ok: $t('確定'), message: '', ...o, input: o.value, resolve: (v, text) => resolve(v ? text ?? '' : null) } });
  });
}
/** 跳出確認視窗，按確定回傳 true */
export function confirmDialog(o: { title: string; message: string; ok?: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    useConfirm.getState().req?.resolve(false);
    useConfirm.setState({ req: { ok: $t('確定'), ...o, resolve } });
  });
}

// ───────────── 拖曳（素材庫 → 時間軸）─────────────

export type DragPayload =
  | { kind: 'media'; id: string }
  | { kind: 'mediaBatch'; ids: string[] }
  | { kind: 'module'; id: string; moduleKind: 'effect' | 'transition' | 'remap' }
  | { kind: 'color'; color: string }
  | { kind: 'text'; preset: string }
  | { kind: 'mask'; shape: string }
  | { kind: 'files'; count: number };

export type DropTarget =
  | { kind: 'lane'; lane: TrackKind; idx: number; time: number; duration: number; label: string; items?: MediaPlacement[]; overlap?: { fit: DropFit | null; replaceId?: string } }
  | { kind: 'clip'; clipId: string; action: 'transition' | 'transitionOut' | 'remap' | 'relink' | 'replace' | 'effect' | 'mask'; valid: boolean }
  /** stack = 疊加到這個特效方塊上（沒有 = 取代） */
  | { kind: 'effect'; fxId: string; stack?: boolean }
  | null;

export interface DragState {
  payload: DragPayload;
  label: string;
  thumb?: string;
  x: number;
  y: number;
  target: DropTarget;
}
export const useDrag = create<{ drag: DragState | null }>(() => ({ drag: null }));

// ───────────── 素材庫點擊預覽（特效 / 轉場）─────────────

/** 素材庫試看：fx = 特效 / 轉場 / 變速模組、text = 文字樣式（疊在目前畫面最上層循環播放）；兩者只會有一個 */
export const usePreviewFx = create<{ fx: { moduleId: string; t0: number } | null; text: { preset: string; name: string; t0: number } | null }>(() => ({ fx: null, text: null }));
export const stopPreviewFx = () => {
  const s = usePreviewFx.getState();
  if (s.fx || s.text) usePreviewFx.setState({ fx: null, text: null });
};

export const useColorPick = create<{ pick: ((hex: string) => void) | null }>(() => ({ pick: null }));

// ───────────── 屬性面板中選取的關鍵影格 ─────────────

export interface KeyRef { ch: string; id: string }
/**
 * 屬性面板中選取的關鍵影格。sel = 主選取（決定曲線上要調哪一段），keys = 全部選取的；
 * focus = 最後點的是屬性面板的關鍵影格區（快捷鍵要作用在關鍵影格上）
 */
export const useKeySel = create<{ owner: string | null; keys: KeyRef[]; sel: { owner: string; ch: string; id: string } | null; focus: boolean }>(() => ({
  owner: null,
  keys: [],
  sel: null,
  focus: false,
}));

// ───────────── 時間軸吸附參考線 ─────────────

/** 吸附中的時間點（時間軸畫一條跨軌道的垂直線） */
export const useSnapLine = create<{ t: number | null }>(() => ({ t: null }));

// ───────────── 加入項目後，時間軸捲到它並閃一下 ─────────────

export const useReveal = create<{ n: number; flash: boolean; target?: { type: string; id: string } }>(() => ({ n: 0, flash: true }));
/**
 * 讓時間軸捲動到目前選取的項目。
 * flash = true（預設）：再閃一下（用按鈕 / 選單加入時，才知道放到哪裡）；鍵盤換片段只要捲過去就好。
 * target：要捲到的項目（沒給 = 主選取）；延伸選取時捲到正在移動的那一端
 */
export const revealSelection = (flash = true, target?: { type: string; id: string }) => setTimeout(() => useReveal.setState((s) => ({ n: s.n + 1, flash, target })), 30);

// ───────────── 編輯視窗（狀態放這裡：屬性表格、預覽、視窗本身都要用） ─────────────

export const useEditorWindow = create<{ open: boolean }>(() => ({ open: false }));

/** 編輯視窗目前的排版；沒開回傳 null。自動 = 看輸出尺寸：橫式上下排、直式左右排 */
export function useEditorMode(landscape: boolean): 'stacked' | 'side' | null {
  const open = useEditorWindow((s) => s.open);
  const pref = useLayout((s) => s.editorLayout);
  if (!open) return null;
  return pref === 'auto' ? (landscape ? 'stacked' : 'side') : pref;
}

/** 修剪片段時預覽暫時顯示的時間（拖結尾 = 最後一格、拖開頭 = 第一格）；null = 照播放頭。播放頭本身不動 */
export const useTrimView = create<{ t: number | null }>(() => ({ t: null }));
