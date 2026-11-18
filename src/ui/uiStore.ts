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
  mediaFilter: 'all' | 'video' | 'image' | 'audio';
  set(p: Partial<Omit<Layout, 'set' | 'reset'>>): void;
  reset(): void;
}
const LAYOUT_DEFAULT = { leftW: 480, timelineH: 320, codeH: 320, floating: false, floatRect: { x: 120, y: 60, w: 360, h: 640 }, grid: false, gridRows: 3, gridCols: 3, gridCenter: true, gridSafe: true, codeOpen: false, clipTab: 'frame' as const, ecSplit: 0.56, ecCollapsed: {} as Record<string, boolean>, libView: { media: 'grid', transition: 'grid', effect: 'grid', remap: 'list' } as Record<string, 'list' | 'grid'>, mediaFilter: 'all' as const };

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

// ───────────── 拖曳（素材庫 → 時間軸）─────────────

export type DragPayload =
  | { kind: 'media'; id: string }
  | { kind: 'module'; id: string; moduleKind: 'effect' | 'transition' | 'remap' }
  | { kind: 'files'; count: number };

export type DropTarget =
  | { kind: 'lane'; lane: TrackKind; idx: number; time: number; duration: number; label: string }
  | { kind: 'clip'; clipId: string; action: 'transition' | 'remap' | 'relink'; valid: boolean }
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

export const useKeySel = create<{ sel: { owner: string; ch: string; id: string } | null }>(() => ({ sel: null }));
