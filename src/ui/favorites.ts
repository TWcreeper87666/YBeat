import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * 我的最愛（跨專案保留）：每個素材庫分頁一個有順序的清單，跟介面版面設定分開存。
 * 拖曳排序直接整個換掉那個分頁的清單。
 */
export type LibId = 'transition' | 'effect' | 'remap' | 'mask' | 'color' | 'text' | 'anim';

interface Favorites {
  lists: Partial<Record<LibId, string[]>>;
  toggle(lib: LibId, id: string): void;
  set(lib: LibId, list: string[]): void;
  remove(lib: LibId, id: string): void;
}

export const useFavorites = create<Favorites>()(
  persist(
    (set, get) => ({
      lists: {},
      toggle: (lib, id) => {
        const cur = get().lists[lib] ?? [];
        set({ lists: { ...get().lists, [lib]: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] } });
      },
      set: (lib, list) => set({ lists: { ...get().lists, [lib]: list } }),
      remove: (lib, id) => {
        const cur = get().lists[lib];
        if (cur?.includes(id)) set({ lists: { ...get().lists, [lib]: cur.filter((x) => x !== id) } });
      },
    }),
    { name: 'ybeat-favorites', partialize: (s) => ({ lists: s.lists }) },
  ),
);

const EMPTY: string[] = [];
/** 某個分頁的我的最愛（有順序） */
export const useFavList = (lib: LibId) => useFavorites((s) => s.lists[lib] ?? EMPTY);
