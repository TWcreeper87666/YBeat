import { $t, displayName } from '../i18n';
import { Filter, LayoutGrid, List, Search, Star, X } from 'lucide-react';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { useStore } from '../store';
import { useLayout } from './uiStore';
import { reorderSubset } from './sortKeys';
import type { SortOpts } from './dnd';
import { useFavorites, type LibId } from './favorites';

/**
 * 素材庫的共用底板：搜尋 + 檢視切換、分類籤、以及「挑選視窗」。
 * 分頁（特效、遮罩…）跟屬性面板裡的挑選視窗用同一套元件，只差在點了之後做什麼（onPick）。
 */

// ───────────── 搜尋 + 檢視切換 ─────────────

/**
 * filter：有分類籤的素材庫才給。搜尋列右邊多一個篩選按鈕，開關分類籤；
 * 收起來時一律顯示全部（呼叫 filter.reset 把分類改回「全部」）。
 */
export function LibToolbar({ id, query, setQuery, children, filter, views = true }: { id: string; query: string; setQuery: (q: string) => void; children?: React.ReactNode; filter?: { active: boolean; reset: () => void }; views?: boolean }) {
  const view = useLayout((s) => s.libView[id] ?? 'grid');
  const open = useLayout((s) => !!s.libFilterOpen[id]);
  const toggleFilter = () => {
    const L = useLayout.getState();
    if (open) filter?.reset();
    L.set({ libFilterOpen: { ...L.libFilterOpen, [id]: !open } });
  };
  const setView = (v: 'list' | 'grid') => useLayout.getState().set({ libView: { ...useLayout.getState().libView, [id]: v } });
  return (
    <div className="lib-bar" data-views={views ? id : undefined}>
      <div className="lib-search">
        <Search size={13} />
        <input placeholder={$t('搜尋…')} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setQuery('')} />
        {query && <button onClick={() => setQuery('')}><X size={13} /></button>}
      </div>
      {filter && (
        <button className={`lib-add lib-filter-btn ${open ? 'on' : ''}`} title={open ? $t('收起分類（顯示全部）') : $t('依分類篩選')} onClick={toggleFilter}>
          <Filter size={14} />
          {filter.active && <span className="dot" />}
        </button>
      )}
      {children}
      {views && <div className="lib-view">
        <button className={view === 'list' ? 'on' : ''} title={$t('清單')} onClick={() => setView('list')}><List size={14} /></button>
        <button className={view === 'grid' ? 'on' : ''} title={$t('格狀')} onClick={() => setView('grid')}><LayoutGrid size={14} /></button>
      </div>}
    </div>
  );
}

// ───────────── 卡片大小（所有分頁共用） ─────────────

export const LIB_CARD_MIN = 44;
export const LIB_CARD_MAX = 220;
export const LIB_ROW_MIN = 16;
export const LIB_ROW_MAX = 44;
const applySizes = (card: number, row: number) => {
  document.documentElement.style.setProperty('--lib-card', `${card}px`);
  document.documentElement.style.setProperty('--lib-row', `${row}px`);
};
applySizes(useLayout.getState().libCard, useLayout.getState().libRow);
useLayout.subscribe((s, p) => (s.libCard !== p.libCard || s.libRow !== p.libRow) && applySizes(s.libCard, s.libRow));
/**
 * 素材庫裡 Ctrl+滾輪 = 縮放卡片（瀏覽器縮放已在 Menu.tsx 擋掉）。
 * 一條連續的縮放軸：格狀最大 → 格狀最小 → 切成清單（最大列）→ 清單最小；放大反過來。
 * 卡片 / 列的大小所有分頁共用，格狀 / 清單是各分頁自己的。
 */
window.addEventListener(
  'wheel',
  (e) => {
    if (!e.ctrlKey || !(e.target as Element).closest?.('.lib-body')) return;
    e.preventDefault();
    const id = (e.target as Element).closest('.lib')?.querySelector<HTMLElement>('.lib-bar[data-views]')?.dataset.views;
    const L = useLayout.getState();
    const up = e.deltaY < 0;
    const step = (v: number, min: number, max: number) => Math.round(Math.min(max, Math.max(min, v * (up ? 1.12 : 1 / 1.12))));
    const view = id ? L.libView[id] ?? 'grid' : 'grid';
    if (view === 'grid') {
      if (!up && L.libCard <= LIB_CARD_MIN && id) return L.set({ libView: { ...L.libView, [id]: 'list' }, libRow: LIB_ROW_MAX });
      const next = step(L.libCard, LIB_CARD_MIN, LIB_CARD_MAX);
      if (next !== L.libCard) L.set({ libCard: next });
    } else {
      if (up && L.libRow >= LIB_ROW_MAX && id) return L.set({ libView: { ...L.libView, [id]: 'grid' }, libCard: LIB_CARD_MIN });
      const next = step(L.libRow, LIB_ROW_MIN, LIB_ROW_MAX);
      if (next !== L.libRow) L.set({ libRow: next });
    }
  },
  { passive: false },
);

/** 只在素材庫空白處（不是項目 / 按鈕 / 輸入框上）觸發：單擊取消選取、雙擊新增 */
export const onBlank = (fn?: () => void) => (e: React.MouseEvent) => {
  if (!fn || (e.target as Element).closest('.lib-item, button, input, select, textarea, a')) return;
  e.preventDefault();
  fn();
};

export const match = (name: string, q: string) => !q || name.toLowerCase().includes(q.trim().toLowerCase()) || displayName(name).toLowerCase().includes(q.trim().toLowerCase());

// ───────────── 分類籤（全部 / 我的最愛 / …） ─────────────

export function LibFilter({ id, cats, cur, set }: { id: string; cats: { id: string; label: string; count?: number; icon?: React.ReactNode }[]; cur: string; set: (id: string) => void }) {
  const open = useLayout((s) => !!s.libFilterOpen[id]);
  if (!open) return null;
  return (
    <div className="lib-filter">
      {cats.map((c) => (
        <button key={c.id} className={cur === c.id ? 'on' : ''} onClick={() => set(c.id)}>
          {c.id === 'fav' ? <Star size={11} fill="currentColor" /> : c.icon}
          {c.label}
          {c.count !== undefined && <span>{c.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** 星號按鈕（加入 / 移出我的最愛） */
export function FavButton({ on, toggle }: { on: boolean; toggle: () => void }) {
  return (
    <button
      className={`fav-btn ${on ? 'on' : ''}`}
      title={on ? $t('從我的最愛移除') : $t('加入我的最愛')}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        toggle();
      }}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <Star size={13} fill={on ? 'currentColor' : 'none'} />
    </button>
  );
}

// ───────────── 挑選視窗（小的浮動視窗，裡面放素材庫）─────────────

interface PickerReq {
  title: string;
  /** 每次重畫都呼叫（裡面讀到的選取 / 目前值永遠是最新的） */
  body: (close: () => void) => React.ReactNode;
  x: number;
  y: number;
  /** 視窗寬度；有給 = 小視窗，高度跟著內容 */
  w?: number;
}
const usePicker = create<{ req: PickerReq | null }>(() => ({ req: null }));
export const closePicker = () => usePicker.setState({ req: null });
/** 挑選視窗開著（Esc 先關它，別的 Esc 處理要讓開） */
export const pickerOpen = () => !!usePicker.getState().req;

/** 打開挑選視窗，出現在 anchor（按下的按鈕）旁邊 */
export function openPicker(anchor: Element | null, title: string, body: PickerReq['body'], size?: { w: number }) {
  const r = anchor?.getBoundingClientRect();
  usePicker.setState({ req: { title, body, x: r ? r.left : innerWidth / 2 - 180, y: r ? r.bottom + 4 : 120, ...(size ? { w: size.w } : {}) } });
}

const PICK_W = 380, PICK_H = 440;

export function PickerHost() {
  const req = usePicker((s) => s.req);
  // 選取 / 片段改變時重畫（body 裡讀的是最新狀態）
  useStore((s) => s.clips);
  useStore((s) => s.effects);
  useStore((s) => s.selection);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  useLayoutEffect(() => {
    if (!req) return;
    // 放得下就在按鈕下方，不然往上 / 往左移
    const w = req.w ?? PICK_W;
    const h = req.w ? ref.current?.offsetHeight ?? 200 : PICK_H;
    const x = Math.max(8, Math.min(req.x, innerWidth - w - 8));
    const y = req.y + h > innerHeight - 8 ? Math.max(8, innerHeight - h - 8) : req.y;
    setPos({ x, y });
  }, [req]);

  useEffect(() => {
    if (!req) return;
    const down = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      // 視窗裡、右鍵選單、確認對話框：不關
      if (ref.current?.contains(t) || t.closest?.('.ctxmenu, .overlay .dialog, .popover')) return;
      closePicker();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      closePicker();
    };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key, true);
    };
  }, [req]);

  if (!req) return null;
  const drag = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const x0 = e.clientX - pos.x, y0 = e.clientY - pos.y;
    const mv = (ev: PointerEvent) => setPos({ x: Math.min(innerWidth - 80, Math.max(-PICK_W + 80, ev.clientX - x0)), y: Math.min(innerHeight - 30, Math.max(0, ev.clientY - y0)) });
    const up = () => {
      window.removeEventListener('pointermove', mv);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
  };
  return (
    <div ref={ref} className={`float-win picker-win ${req.w ? 'small' : ''}`} style={{ left: pos.x, top: pos.y, width: req.w ?? PICK_W, height: req.w ? undefined : PICK_H }}>
      <div className="float-title" onPointerDown={drag}>
        <span>{req.title}</span>
        <button title={$t('關閉 (Esc)')} onPointerDown={(e) => e.stopPropagation()} onClick={closePicker}><X size={14} /></button>
      </div>
      <div className="float-body picker-body">{req.body(closePicker)}</div>
    </div>
  );
}

// ───────────── 我的最愛：照加入 / 拖曳排好的順序，可以拖曳排序（各分頁共用） ─────────────

/** 「我的最愛」分類裡的項目照 favorites 的順序排 */
export function byFavOrder<T>(items: T[], id: (t: T) => string, favorites: string[]): T[] {
  const pos = new Map(favorites.map((f, i) => [f, i]));
  return [...items].sort((a, b) => (pos.get(id(a)) ?? 0) - (pos.get(id(b)) ?? 0));
}

/**
 * 我的最愛的拖曳排序設定（給 startLibraryDrag）：container 是放卡片的格子（卡片要有 data-sort-key）。
 * keys = 目前顯示的項目；清單裡如果還有已經刪掉、沒顯示的項目，留在原位。
 */
export function favSortOpts(container: HTMLElement | null, key: string, keys: string[], lib: LibId): SortOpts | undefined {
  if (!container) return undefined;
  return { container, key, keys, apply: (next) => useFavorites.getState().set(lib, reorderSubset(useFavorites.getState().lists[lib] ?? [], next)) };
}
