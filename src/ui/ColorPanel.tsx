import React, { useMemo, useRef, useState } from 'react';
import { CircleCheck, Palette, Pipette, Plus, X } from 'lucide-react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { $t } from '../i18n';
import { useStore } from '../store';
import { colorMedia } from '../engine/media';
import { startLibraryDrag } from './dnd';
import { useFavList, useFavorites } from './favorites';
import { FavButton, LibFilter, LibToolbar, favSortOpts, onBlank } from './Library';
import { openMenu, revealSelection, toast, useLayout } from './uiStore';

const SWATCHES = [
  '#000000', '#ffffff', '#1d1f27', '#3a3f4d', '#8a90a2', '#ff3d6e',
  '#ff5d5d', '#ff8a3d', '#ffb02e', '#ffe066', '#b8f35d', '#29d3c2',
  '#2ec4f1', '#3a7bff', '#6a4cff', '#9b6bff', '#f15bb5', '#7a2048',
];

// ── HSV 內部狀態（灰色時色相不會跑掉） ──
type Hsv = { h: number; s: number; v: number };
function hsvToHex({ h, s, v }: Hsv) {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    const c = v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
    return Math.round(c * 255).toString(16).padStart(2, '0');
  };
  return `#${f(5)}${f(3)}${f(1)}`;
}
function hexToHsv(hex: string, prevH = 0): Hsv | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const x = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(x.slice(i, i + 2), 16) / 255);
  const mx = Math.max(r, g, b), d = mx - Math.min(r, g, b);
  let h = prevH;
  if (d > 0) {
    h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  return { h, s: mx ? d / mx : 0, v: mx };
}

/** 色板庫（跨專案保留）：顏色清單、我的最愛（有順序）、調色盤目前的顏色 */
interface ColorLib {
  colors: string[];
  current: string;
  /** 右側調色盤開著沒（點最後一張調色盤卡片打開） */
  pickerOpen: boolean;
  setPickerOpen(v: boolean): void;
  add(c: string): boolean;
  remove(c: string): void;
  setCurrent(c: string): void;
}
export const useColorLib = create<ColorLib>()(
  persist(
    (set, get) => ({
      colors: [...SWATCHES],
      current: '#ff3d6e',
      pickerOpen: false,
      setPickerOpen: (v) => set({ pickerOpen: v }),
      add: (c) => {
        const x = c.toLowerCase();
        if (get().colors.includes(x)) return false;
        set({ colors: [...get().colors, x] });
        return true;
      },
      remove: (c) => {
        set({ colors: get().colors.filter((x) => x !== c) });
        useFavorites.getState().remove('color', c);
      },
      setCurrent: (c) => set({ current: c.toLowerCase() }),
    }),
    { name: 'ybeat-colors', partialize: (s) => ({ colors: s.colors, current: s.current, pickerOpen: s.pickerOpen }) },
  ),
);

/** 飽和度 / 明度方塊 */
function SvPad({ hsv, onChange }: { hsv: Hsv; onChange: (h: Hsv) => void }) {
  const down = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    const at = (ev: { clientX: number; clientY: number }) => {
      const r = el.getBoundingClientRect();
      onChange({ h: hsv.h, s: Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)), v: Math.min(1, Math.max(0, 1 - (ev.clientY - r.top) / r.height)) });
    };
    at(e);
    const mv = (ev: PointerEvent) => at(ev);
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
  };
  return (
    <div className="cpk-pad" style={{ backgroundColor: `hsl(${hsv.h} 100% 50%)` }} onPointerDown={down}>
      <i style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: hsvToHex(hsv) }} />
    </div>
  );
}

/** 插入到播放頭（選中的軌道有空位就放那裡） */
async function insertColor(c: string) {
  const m = await colorMedia(c);
  if (m) {
    useStore.getState().insertMedia(m.id);
    revealSelection();
  }
}

type Cat = 'all' | 'fav';

export function ColorPanel() {
  const lib = useColorLib();
  const view = useLayout((s) => s.libView.color ?? 'grid');
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<Cat>('all');
  const [hsv, setHsvState] = useState<Hsv>(() => hexToHsv(useColorLib.getState().current) ?? hexToHsv('#ff3d6e')!);
  const [draft, setDraft] = useState<string | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const current = hsvToHex(hsv);
  const setHsv = (n: Hsv) => {
    setHsvState(n);
    useColorLib.getState().setCurrent(hsvToHex(n));
  };
  const pick = (c: string) => { const n = hexToHsv(c, hsv.h); if (n) setHsv(n); };

  // 時間軸上用到的顏色
  const media = useStore((s) => s.media);
  const clips = useStore((s) => s.clips);
  const used = useMemo(() => {
    const byId = new Map(media.filter((m) => m.color).map((m) => [m.id, m.color!]));
    return new Set(clips.map((c) => byId.get(c.mediaId)).filter(Boolean) as string[]);
  }, [media, clips]);

  const favorites = useFavList('color');
  const favSet = new Set(favorites);
  const toggleFav = (c: string) => useFavorites.getState().toggle('color', c);
  const qq = q.trim().replace(/^#/, '').toLowerCase();
  const source = cat === 'fav' ? favorites.filter((c) => lib.colors.includes(c)) : lib.colors;
  const list = source.filter((c) => !qq || c.includes(qq));
  const inLib = lib.colors.includes(current);
  // 我的最愛：可以拖曳調整順序（共用的排序拖曳）
  const sortable = cat === 'fav' && !qq;
  const sortOpts = (c: string) => (sortable ? favSortOpts(gridRef.current, c, list, 'color') : undefined);

  const addCurrent = () => {
    if (useColorLib.getState().add(current)) toast($t('已加入色板'));
  };
  const itemMenu = (e: React.MouseEvent, c: string) => {
    e.preventDefault();
    e.stopPropagation();
    openMenu(e.clientX, e.clientY, [
      { label: $t('插入到播放頭'), action: () => insertColor(c) },
      { label: favSet.has(c) ? $t('從我的最愛移除') : $t('加入我的最愛'), action: () => toggleFav(c) },
      { separator: true },
      { label: $t('從色板移除'), danger: true, action: () => lib.remove(c) },
    ]);
  };
  const pickerMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    openMenu(e.clientX, e.clientY, [
      { label: $t('插入到播放頭'), action: () => insertColor(current) },
      { label: $t('加入色板'), action: inLib ? undefined : addCurrent },
    ]);
  };
  const commitDraft = () => {
    if (draft !== null) pick(draft.startsWith('#') ? draft : `#${draft}`);
    setDraft(null);
  };

  const empty = cat === 'fav' && !favorites.length ? $t('還沒有我的最愛') : $t('沒有符合的顏色');

  return (
    <div className="lib color-lib" onContextMenu={(e) => e.preventDefault()}>
      <LibToolbar id="color" query={q} setQuery={setQ} filter={{ active: cat !== 'all', reset: () => setCat('all') }}>
        <button className="lib-add" title={$t('加入色板')} disabled={inLib} onClick={addCurrent}><Plus size={15} /></button>
      </LibToolbar>
      <LibFilter
        id="color"
        cats={[{ id: 'all', label: $t('全部'), count: lib.colors.length }, { id: 'fav', label: $t('我的最愛'), count: favSet.size }]}
        cur={cat}
        set={(v) => setCat(v as Cat)}
      />
      <div className="color-split">
        <div className="lib-body" onDoubleClick={onBlank(() => insertColor(current))}>
          {!list.length && <p className="muted small center">{empty}</p>}
          <div ref={gridRef} className={view === 'grid' ? 'lib-grid swatch-grid' : 'lib-list'}>
            {list.map((c) => (
              <div
                key={c}
                data-sort-key={sortable ? c : undefined}
                className={`lib-item swatch-item ${c === current ? 'current' : ''}`}
                onPointerDown={(e) => { if (e.button === 0) pick(c); startLibraryDrag(e, { kind: 'color', color: c }, c, undefined, sortOpts(c)); }}
                onDoubleClick={() => insertColor(c)}
                onContextMenu={(e) => itemMenu(e, c)}
                title={c.toUpperCase()}
              >
                <div className="lib-thumb swatch-thumb" style={{ background: c }}>
                  {used.has(c) && <span className="used" title={$t('已在時間軸上使用')}><CircleCheck size={11} /></span>}
                </div>
                <FavButton on={favSet.has(c)} toggle={() => toggleFav(c)} />
                {view === 'list' && <div className="lib-meta"><div className="lib-name">{c.toUpperCase()}</div></div>}
              </div>
            ))}
            {/* 調色盤目前的顏色：固定在最後一個，用調色盤圖示區分 */}
            <div
              className={`lib-item swatch-item picker-item ${lib.pickerOpen ? 'current' : ''}`}
              onPointerDown={(e) => startLibraryDrag(e, { kind: 'color', color: current }, current)}
              onClick={() => lib.setPickerOpen(true)}
              onDoubleClick={() => insertColor(current)}
              onContextMenu={pickerMenu}
              title={current.toUpperCase()}
            >
              <div className="lib-thumb swatch-thumb" style={{ background: current }}>
                <span className="picker-mark"><Palette size={12} /></span>
              </div>
              {view === 'list' && <div className="lib-meta"><div className="lib-name">{current.toUpperCase()}</div><div className="lib-sub">{$t('調色盤')}</div></div>}
            </div>
          </div>
        </div>
        {lib.pickerOpen && <div className="color-side">
          <div className="cpk">
            <div className="cpk-head">
              <span className="muted small"><Palette size={12} /> {$t('調色盤')}</span>
              <button className="ec-icon" title={$t('關閉')} onClick={() => lib.setPickerOpen(false)}><X size={13} /></button>
            </div>
            <SvPad hsv={hsv} onChange={setHsv} />
            <input
              type="range"
              className="cpk-hue"
              min={0}
              max={359}
              value={Math.round(hsv.h)}
              onChange={(e) => setHsv({ ...hsv, h: +e.target.value })}
              style={{ '--thumb': `hsl(${hsv.h} 100% 50%)` } as React.CSSProperties}
            />
            <div className="cpk-row">
              <label className="cpk-hex">
                <span>#</span>
                <input
                  value={draft ?? current.slice(1).toUpperCase()}
                  maxLength={7}
                  spellCheck={false}
                  onChange={(e) => { setDraft(e.target.value); const n = hexToHsv(e.target.value, hsv.h); if (n && /^#?[0-9a-f]{6}$/i.test(e.target.value.trim())) setHsv(n); }}
                  onBlur={commitDraft}
                  onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') { commitDraft(); (e.target as HTMLInputElement).blur(); } if (e.key === 'Escape') { setDraft(null); (e.target as HTMLInputElement).blur(); } }}
                />
              </label>
              <label className="cpk-native" title={$t('系統顏色選擇器')}>
                <Pipette size={14} />
                <input type="color" value={current} onChange={(e) => pick(e.target.value)} />
              </label>
              <button className="cpk-native cpk-addbtn" disabled={inLib} title={inLib ? $t('已在色板中') : $t('加入色板')} onClick={addCurrent}><Plus size={15} /></button>
            </div>
          </div>
        </div>}
      </div>
    </div>
  );
}
