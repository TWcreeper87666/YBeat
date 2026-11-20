import { $t, displayName } from '../i18n';
import { Filter, LayoutGrid, List, Search, Star, X } from 'lucide-react';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { useStore } from '../store';
import { useLayout } from './uiStore';

/**
 * 素材庫的共用底板：搜尋 + 檢視切換、分類籤、以及「挑選視窗」。
 * 分頁（特效、遮罩…）跟屬性面板裡的挑選視窗用同一套元件，只差在點了之後做什麼（onPick）。
 */

// ───────────── 搜尋 + 檢視切換 ─────────────

/**
 * filter：有分類籤的素材庫才給。搜尋列右邊多一個篩選按鈕，開關分類籤；
 * 收起來時一律顯示全部（呼叫 filter.reset 把分類改回「全部」）。
 */
export function LibToolbar({ id, query, setQuery, children, filter }: { id: string; query: string; setQuery: (q: string) => void; children?: React.ReactNode; filter?: { active: boolean; reset: () => void } }) {
  const view = useLayout((s) => s.libView[id] ?? 'grid');
  const open = useLayout((s) => !!s.libFilterOpen[id]);
  const toggleFilter = () => {
    const L = useLayout.getState();
    if (open) filter?.reset();
    L.set({ libFilterOpen: { ...L.libFilterOpen, [id]: !open } });
  };
  const setView = (v: 'list' | 'grid') => useLayout.getState().set({ libView: { ...useLayout.getState().libView, [id]: v } });
  return (
    <div className="lib-bar">
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
      <div className="lib-view">
        <button className={view === 'list' ? 'on' : ''} title={$t('清單')} onClick={() => setView('list')}><List size={14} /></button>
        <button className={view === 'grid' ? 'on' : ''} title={$t('格狀')} onClick={() => setView('grid')}><LayoutGrid size={14} /></button>
      </div>
    </div>
  );
}

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
}
const usePicker = create<{ req: PickerReq | null }>(() => ({ req: null }));
export const closePicker = () => usePicker.setState({ req: null });
/** 挑選視窗開著（Esc 先關它，別的 Esc 處理要讓開） */
export const pickerOpen = () => !!usePicker.getState().req;

/** 打開挑選視窗，出現在 anchor（按下的按鈕）旁邊 */
export function openPicker(anchor: Element | null, title: string, body: PickerReq['body']) {
  const r = anchor?.getBoundingClientRect();
  usePicker.setState({ req: { title, body, x: r ? r.left : innerWidth / 2 - 180, y: r ? r.bottom + 4 : 120 } });
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
    const x = Math.max(8, Math.min(req.x, innerWidth - PICK_W - 8));
    const y = req.y + PICK_H > innerHeight - 8 ? Math.max(8, innerHeight - PICK_H - 8) : req.y;
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
    <div ref={ref} className="float-win picker-win" style={{ left: pos.x, top: pos.y, width: PICK_W, height: PICK_H }}>
      <div className="float-title" onPointerDown={drag}>
        <span>{req.title}</span>
        <button title={$t('關閉 (Esc)')} onPointerDown={(e) => e.stopPropagation()} onClick={closePicker}><X size={14} /></button>
      </div>
      <div className="float-body picker-body">{req.body(closePicker)}</div>
    </div>
  );
}
