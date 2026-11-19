import { $t } from '../i18n';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { TrackKind } from '../store';

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
  codeOpen: boolean;
  clipTab: 'frame' | 'speed' | 'sound';
  /** 效果控制：左右分隔比例、收合的區塊 */
  ecSplit: number;
  ecCollapsed: Record<string, boolean>;
  /** 素材庫顯示方式 / 篩選 */
  libView: Record<string, 'list' | 'grid'>;
  mediaFilter: 'all' | 'video' | 'image' | 'audio' | 'color';
  /** 預覽畫質（渲染解析度倍率；匯出一律全解析度） */
  previewScale: number;
  /** 時間軸上，上層（蓋在上面的）軌道顯示在下方還是上方 */
  upperLayerAt: 'bottom' | 'top';
  /** 我的最愛（模組 id） */
  favorites: string[];
  /** 特效 / 轉場 / 變速分頁目前選的分類 */
  modCat: Record<string, string>;
  set(p: Partial<Omit<Layout, 'set' | 'reset'>>): void;
  reset(): void;
}
const LAYOUT_DEFAULT = { leftW: 480, timelineH: 320, codeH: 320, floating: false, floatRect: { x: 120, y: 60, w: 360, h: 640 }, grid: false, gridRows: 3, gridCols: 3, gridCenter: true, gridSafe: true, codeOpen: false, clipTab: 'frame' as const, ecSplit: 0.56, ecCollapsed: {} as Record<string, boolean>, libView: { media: 'grid', transition: 'grid', effect: 'grid', remap: 'list', text: 'grid' } as Record<string, 'list' | 'grid'>, mediaFilter: 'all' as Layout['mediaFilter'], favorites: [] as string[], previewScale: 1, upperLayerAt: 'bottom' as Layout['upperLayerAt'], modCat: {} as Record<string, string> };

export const useLayout = create<Layout>()(
  persist(
    (set) => ({
      ...LAYOUT_DEFAULT,
      set: (p) => set(p),
      reset: () => set(LAYOUT_DEFAULT),
    }),
    { name: 'beatsync-layout' },
  ),
);

// ───────────── 提示訊息 ─────────────

interface Toast { id: number; text: string; kind: 'info' | 'error' }
export const useToast = create<{ toasts: Toast[] }>(() => ({ toasts: [] }));
let toastId = 0;
export function toast(text: string, kind: Toast['kind'] = 'info') {
  const id = ++toastId;
  useToast.setState((s) => ({ toasts: [...s.toasts, { id, text, kind }] }));
  setTimeout(() => useToast.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === 'error' ? 5000 : 2200);
}

// ───────────── 右鍵選單 / 下拉選單 ─────────────

export type MenuItem =
  | { label: string; shortcut?: string; action?: () => void; disabled?: boolean; checked?: boolean; danger?: boolean }
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
  | { kind: 'module'; id: string; moduleKind: 'effect' | 'transition' | 'remap' }
  | { kind: 'color'; color: string }
  | { kind: 'text'; preset: string }
  | { kind: 'files'; count: number };

export type DropTarget =
  | { kind: 'lane'; lane: TrackKind; idx: number; time: number; duration: number; label: string }
  | { kind: 'clip'; clipId: string; action: 'transition' | 'transitionOut' | 'remap' | 'relink' | 'effect'; valid: boolean }
  | { kind: 'effect'; fxId: string }
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

export const usePreviewFx = create<{ fx: { moduleId: string; t0: number } | null }>(() => ({ fx: null }));
export const stopPreviewFx = () => usePreviewFx.getState().fx && usePreviewFx.setState({ fx: null });

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

export const useReveal = create<{ n: number }>(() => ({ n: 0 }));
/** 讓時間軸捲動到目前選取的項目並閃一下（用按鈕 / 選單加入時，才知道放到哪裡） */
export const revealSelection = () => setTimeout(() => useReveal.setState((s) => ({ n: s.n + 1 })), 30);
