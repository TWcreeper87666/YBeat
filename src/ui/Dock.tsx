import { $t } from '../i18n';
import { Minimize2 } from 'lucide-react';
import React, { useEffect, useRef } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useStore } from '../store';
import { Slot } from './PreviewPanel';
import { useEditorWindow } from './EditorWindow';
import { openMenu, useLayout, type MenuItem } from './uiStore';
import {
  C, R, T, dragSash, findGroup, mapTabs, minSize, moveGroup, movePanel, panelsIn, removePanel, setSizes, showPanel,
  type DockNode, type DropTarget, type PanelId, type Side, type SplitNode, type TabsNode,
} from './dockTree';

export type { PanelId };

export const PANELS: { id: PanelId; title: string }[] = [
  { id: 'media', title: $t('素材') },
  { id: 'text', title: $t('文字') },
  { id: 'lyrics', title: $t('字幕／歌詞') },
  { id: 'transition', title: $t('轉場') },
  { id: 'effect', title: $t('特效') },
  { id: 'mask', title: $t('遮罩') },
  { id: 'remap', title: $t('變速') },
  { id: 'inspector', title: $t('屬性') },
  { id: 'code', title: $t('程式碼') },
  { id: 'ai', title: 'AI' },
  { id: 'preview', title: $t('預覽') },
  { id: 'timeline', title: $t('時間軸') },
];
const TITLE = Object.fromEntries(PANELS.map((p) => [p.id, p.title])) as Record<PanelId, string>;
const LIB: PanelId[] = ['media', 'text', 'lyrics', 'transition', 'effect', 'mask', 'remap'];

/** 內建版面 */
export const PRESETS: { id: string; name: string; build: () => DockNode }[] = [
  { id: 'edit', name: $t('剪輯'), build: () => C([R([T(LIB), T(['inspector', 'code', 'ai'], 'inspector'), T(['preview'])], [0.27, 0.33, 0.4]), T(['timeline'])], [0.6, 0.4]) },
  { id: 'right', name: $t('預覽在右'), build: () => R([C([R([T(LIB), T(['inspector', 'code', 'ai'], 'inspector')], [0.42, 0.58]), T(['timeline'])], [0.56, 0.44]), T(['preview'])], [0.72, 0.28]) },
  { id: 'code', name: $t('寫程式'), build: () => R([C([R([T(LIB), T(['inspector', 'code', 'ai'], 'code')], [0.3, 0.7]), T(['timeline'])], [0.68, 0.32]), T(['preview'])], [0.74, 0.26]) },
  { id: 'timeline', name: $t('大時間軸'), build: () => C([R([T([...LIB, 'inspector', 'code', 'ai'], 'media'), T(['preview'])], [0.62, 0.38]), T(['timeline'])], [0.42, 0.58]) },
];

interface Custom { id: string; name: string; layout: DockNode }

interface DockState {
  layout: DockNode | null;
  /** 目前套用的版面：preset id 或自訂 id */
  current: string;
  customs: Custom[];
  maximized: string | null;
  move(panel: PanelId, from: string, target: DropTarget): void;
  /** 整個群組一起移動 */
  moveGroup(from: string, target: DropTarget): void;
  setActive(group: string, panel: PanelId): void;
  activatePanel(panel: PanelId, onlyIfPresent?: boolean): void;
  closePanel(panel: PanelId): void;
  resize(split: string, sizes: number[]): void;
  toggleMax(group: string): void;
  applyPreset(id: string): void;
  applyCustom(id: string): void;
  saveCustom(name: string): void;
  overwriteCustom(id: string): void;
  deleteCustom(id: string): void;
  resetCurrent(): void;
}

export const useDock = create<DockState>()(
  persist(
    (set, get) => ({
      layout: PRESETS[0].build(),
      current: 'edit',
      customs: [],
      maximized: null,
      move: (panel, from, target) => set({ layout: movePanel(get().layout, panel, from, target), maximized: null }),
      moveGroup: (from, target) => set({ layout: moveGroup(get().layout, from, target), maximized: null }),
      setActive: (group, panel) => set({ layout: mapTabs(get().layout, (t) => (t.id === group ? { ...t, active: panel } : t)) }),
      activatePanel: (panel, onlyIfPresent) => {
        const l = get().layout;
        if (onlyIfPresent && !panelsIn(l).includes(panel)) return;
        const g = findGroup(l, (t) => t.tabs.includes(panel));
        if (g && g.active === panel) return;
        set({ layout: showPanel(l, panel) });
      },
      closePanel: (panel) => set({ layout: removePanel(get().layout, panel), maximized: null }),
      resize: (split, sizes) => set({ layout: setSizes(get().layout, split, sizes) }),
      toggleMax: (group) => set({ maximized: get().maximized === group ? null : group }),
      applyPreset: (id) => set({ layout: (PRESETS.find((p) => p.id === id) ?? PRESETS[0]).build(), current: id, maximized: null }),
      applyCustom: (id) => {
        const c = get().customs.find((x) => x.id === id);
        if (c) set({ layout: structuredClone(c.layout), current: id, maximized: null });
      },
      saveCustom: (name) => {
        const l = get().layout;
        if (!l) return;
        const c: Custom = { id: `c${Date.now().toString(36)}`, name, layout: structuredClone(l) };
        set({ customs: [...get().customs, c], current: c.id });
      },
      overwriteCustom: (id) => {
        const l = get().layout;
        if (l) set({ customs: get().customs.map((c) => (c.id === id ? { ...c, layout: structuredClone(l) } : c)) });
      },
      deleteCustom: (id) => set({ customs: get().customs.filter((c) => c.id !== id), current: get().current === id ? 'edit' : get().current }),
      resetCurrent: () => {
        const cur = get().current;
        if (get().customs.some((c) => c.id === cur)) get().applyCustom(cur);
        else get().applyPreset(cur);
      },
    }),
    {
      name: 'ybeat-dock',
      partialize: (s) => ({ layout: s.layout, current: s.current, customs: s.customs }),
      // 舊版存的版面沒有「文字」分頁：加在「素材」旁邊
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<DockState>;
        const addText = (l: DockNode | null | undefined) =>
          l && !panelsIn(l).includes('text')
            ? mapTabs(l, (t) => (t.tabs.includes('media') ? { ...t, tabs: t.tabs.flatMap((x) => (x === 'media' ? ['media', 'text'] : [x])) as PanelId[] } : t))
            : l;
        // 「素材預覽」分頁已併回「預覽」：舊版面裡的拿掉
        const dropSource = (l: DockNode | null | undefined) => (l ? removePanel(l, 'source' as PanelId) : l);
        // 「遮罩」加在「特效」後面
        const addMask = (l: DockNode | null | undefined) =>
          l && !panelsIn(l).includes('mask')
            ? mapTabs(l, (t) => (t.tabs.includes('effect') ? { ...t, tabs: t.tabs.flatMap((x) => (x === 'effect' ? ['effect', 'mask'] : [x])) as PanelId[] } : t))
            : l;
        // 「程式碼」加在「屬性」後面
        const addCode = (l: DockNode | null | undefined) =>
          l && !panelsIn(l).includes('code')
            ? mapTabs(l, (t) => (t.tabs.includes('inspector') ? { ...t, tabs: t.tabs.flatMap((x) => (x === 'inspector' ? ['inspector', 'code'] : [x])) as PanelId[] } : t))
            : l;
        // 「AI」加在「程式碼」後面
        const addAi = (l: DockNode | null | undefined) =>
          l && !panelsIn(l).includes('ai')
            ? mapTabs(l, (t) => (t.tabs.includes('code') ? { ...t, tabs: t.tabs.flatMap((x) => (x === 'code' ? ['code', 'ai'] : [x])) as PanelId[] } : t))
            : l;
        const addLyrics = (l: DockNode | null | undefined) =>
          l && !panelsIn(l).includes('lyrics')
            ? mapTabs(l, (t) => (t.tabs.includes('text') ? { ...t, tabs: t.tabs.flatMap((x) => (x === 'text' ? ['text', 'lyrics'] : [x])) as PanelId[] } : t))
            : l;
        const fix = (l: DockNode | null | undefined) => addLyrics(addAi(addCode(addMask(addText(dropSource(l))))));
        return {
          ...current,
          ...p,
          layout: p.layout === undefined ? current.layout : fix(p.layout) ?? null,
          customs: (p.customs ?? current.customs).map((c) => ({ ...c, layout: fix(c.layout)! })),
        };
      },
    },
  ),
);

// 選取時間軸上的東西 → 「屬性」分頁切到前面（如果它跟別的分頁疊在一起）
useStore.subscribe((s, p) => {
  if (s.selection && s.selection !== p.selection) useDock.getState().activatePanel('inspector', true);
});

/** 「版面」選單 */
export function layoutMenuItems(onSaveAs: () => void): MenuItem[] {
  const d = useDock.getState();
  const cur = d.current;
  const isCustom = d.customs.some((c) => c.id === cur);
  return [
    ...PRESETS.map((p) => ({ label: p.name, checked: cur === p.id, action: () => d.applyPreset(p.id) })),
    ...(d.customs.length ? [{ separator: true } as MenuItem] : []),
    ...d.customs.map((c) => ({ label: c.name, checked: cur === c.id, action: () => d.applyCustom(c.id) })),
    { separator: true },
    { label: $t('另存目前版面…'), action: onSaveAs },
    { label: $t('更新目前的自訂版面'), action: isCustom ? () => d.overwriteCustom(cur) : undefined },
    { label: $t('刪除目前的自訂版面'), danger: true, action: isCustom ? () => d.deleteCustom(cur) : undefined },
    { separator: true },
    { label: $t('重設為目前版面的原始樣子'), action: d.resetCurrent },
  ];
}

/** 「檢視」選單：面板開關 */
export function panelMenuItems(): MenuItem[] {
  const d = useDock.getState();
  const present = panelsIn(d.layout);
  return PANELS.map((p) => ({ label: p.title, checked: present.includes(p.id), action: () => (present.includes(p.id) ? d.closePanel(p.id) : d.activatePanel(p.id)) }));
}

// ───────────────────────── 拖曳分頁（VS Code 行為） ─────────────────────────

const useTabDrag = create<{ drag: { panel: PanelId | null; label: string; from: string; x: number; y: number; target: DropTarget | null } | null }>(() => ({ drag: null }));

const ROOT_EDGE = 22; // 靠近整個版面邊緣多少 px 算「放到最外側」
const SPLIT_EDGE = 0.3; // 靠近群組邊緣多少比例算「分割」

function targetAt(x: number, y: number, rootEl: HTMLElement): DropTarget | null {
  const els = document.elementsFromPoint(x, y) as HTMLElement[];
  const groupEl = els.find((e) => e.dataset?.dockGroup);
  const bar = els.find((e) => e.classList?.contains('dock-tabs'));
  // 分頁列優先（跟 VS Code 一樣），其次才是整個版面的邊緣
  if (!bar) {
    const r = rootEl.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
      if (x - r.left < ROOT_EDGE) return { kind: 'root', side: 'left' };
      if (r.right - x < ROOT_EDGE) return { kind: 'root', side: 'right' };
      if (y - r.top < ROOT_EDGE) return { kind: 'root', side: 'top' };
      if (r.bottom - y < ROOT_EDGE) return { kind: 'root', side: 'bottom' };
    }
  }
  if (!groupEl) return null;
  const group = groupEl.dataset.dockGroup!;
  if (bar) {
    // 分頁列：依滑鼠位置決定插入點
    const tabs = Array.from(bar.querySelectorAll<HTMLElement>('[data-dock-tab]'));
    let index = tabs.length;
    for (let i = 0; i < tabs.length; i++) {
      const b = tabs[i].getBoundingClientRect();
      if (x < b.left + b.width / 2) { index = i; break; }
    }
    return { kind: 'tabs', group, index };
  }
  const b = groupEl.getBoundingClientRect();
  const fx = (x - b.left) / b.width, fy = (y - b.top) / b.height;
  const d = { left: fx, right: 1 - fx, top: fy, bottom: 1 - fy };
  const side = (Object.entries(d) as [Side, number][]).sort((a, c) => a[1] - c[1])[0];
  return { kind: 'group', group, zone: side[1] < SPLIT_EDGE ? side[0] : 'center' };
}

/** panel = null：拖整個群組（按住分頁列右側空白處） */
function startTabDrag(e: React.PointerEvent, panel: PanelId | null, from: string, rootEl: HTMLElement | null, label: string) {
  if (e.button === 1 && panel) {
    e.preventDefault();
    return useDock.getState().closePanel(panel); // 中鍵關閉
  }
  if (e.button !== 0) return;
  const x0 = e.clientX, y0 = e.clientY;
  let started = false;
  const mv = (ev: PointerEvent) => {
    if (!started && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 6) return;
    started = true;
    document.body.classList.add('dock-dragging');
    useTabDrag.setState({ drag: { panel, label, from, x: ev.clientX, y: ev.clientY, target: rootEl ? targetAt(ev.clientX, ev.clientY, rootEl) : null } });
  };
  const up = () => {
    window.removeEventListener('pointermove', mv);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('keydown', esc);
    document.body.classList.remove('dock-dragging');
    const d = useTabDrag.getState().drag;
    useTabDrag.setState({ drag: null });
    if (started && d?.target) {
      if (panel) useDock.getState().move(panel, from, d.target);
      else useDock.getState().moveGroup(from, d.target);
    } else if (!started && panel) useDock.getState().setActive(from, panel);
  };
  const esc = (ev: KeyboardEvent) => {
    if (ev.key !== 'Escape') return;
    started = false;
    useTabDrag.setState({ drag: null });
    up();
  };
  window.addEventListener('pointermove', mv);
  window.addEventListener('pointerup', up);
  window.addEventListener('keydown', esc);
}

// ───────────────────────── 繪製 ─────────────────────────

const RootCtx = React.createContext<React.RefObject<HTMLDivElement> | null>(null);

export function DockRoot({ hosts }: { hosts: Record<PanelId, HTMLElement> }) {
  const layout = useDock((s) => s.layout);
  const maximized = useDock((s) => s.maximized);
  const drag = useTabDrag((s) => s.drag);
  const ref = useRef<HTMLDivElement>(null);
  const maxGroup = maximized ? findGroup(layout, (g) => g.id === maximized) : null;
  const rootSide = drag?.target?.kind === 'root' ? drag.target.side : null;
  return (
    <RootCtx.Provider value={ref}>
      <div className="dock-root" ref={ref}>
        {maxGroup ? (
          <Group node={maxGroup} hosts={hosts} />
        ) : layout ? (
          <NodeView node={layout} hosts={hosts} />
        ) : (
          <div className="dock-empty">
            <p>{$t('所有面板都關掉了')}</p>
            <button className="btn" onClick={() => useDock.getState().applyPreset('edit')}>{$t('恢復預設版面')}</button>
          </div>
        )}
        {rootSide && <div className={`dock-drop root ${rootSide}`} />}
        {drag && <div className="dock-ghost" style={{ left: drag.x + 12, top: drag.y + 10 }}>{drag.label}</div>}
      </div>
    </RootCtx.Provider>
  );
}

function NodeView({ node, hosts }: { node: DockNode; hosts: Record<PanelId, HTMLElement> }) {
  return node.type === 'tabs' ? <Group node={node} hosts={hosts} /> : <Split node={node} hosts={hosts} />;
}

function Split({ node, hosts }: { node: SplitNode; hosts: Record<PanelId, HTMLElement> }) {
  const ref = useRef<HTMLDivElement>(null);
  const sash = (e: React.PointerEvent, i: number) => {
    e.preventDefault();
    const r = ref.current!.getBoundingClientRect();
    const total = node.dir === 'row' ? r.width : r.height;
    const p0 = node.dir === 'row' ? e.clientX : e.clientY;
    const s0 = [...node.sizes];
    // 每格的最小尺寸（裡面所有分頁的按鈕都放得下）
    const mins = node.children.map((c) => (node.dir === 'row' ? minSize(c).w : minSize(c).h));
    document.body.classList.add(node.dir === 'row' ? 'resizing-v' : 'resizing-h');
    const mv = (ev: PointerEvent) => {
      const d = ((node.dir === 'row' ? ev.clientX : ev.clientY) - p0) / total;
      useDock.getState().resize(node.id, dragSash(s0, i, d, mins, total));
    };
    const up = () => {
      document.body.classList.remove('resizing-v', 'resizing-h');
      window.removeEventListener('pointermove', mv);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
  };
  return (
    <div ref={ref} className={`dock-split dir-${node.dir}`}>
      {node.children.map((c, i) => (
        <React.Fragment key={c.id}>
          <div className="dock-cell" style={{ flex: `${node.sizes[i]} 1 0`, minWidth: minSize(c).w, minHeight: minSize(c).h }}>
            <NodeView node={c} hosts={hosts} />
          </div>
          {i < node.children.length - 1 && <div className={`dock-sash dir-${node.dir}`} onPointerDown={(e) => sash(e, i)} />}
        </React.Fragment>
      ))}
    </div>
  );
}

function Group({ node, hosts }: { node: TabsNode; hosts: Record<PanelId, HTMLElement> }) {
  const rootRef = React.useContext(RootCtx);
  const drag = useTabDrag((s) => s.drag);
  const floating = useLayout((s) => s.floating);
  const editorOpen = useEditorWindow((s) => s.open);
  const maximized = useDock((s) => s.maximized === node.id);
  const t = drag?.target;
  const zone = t?.kind === 'group' && t.group === node.id ? t.zone : null;
  const insertAt = t?.kind === 'tabs' && t.group === node.id ? t.index : -1;
  const active = node.tabs.includes(node.active) ? node.active : node.tabs[0];

  // 分頁列放不下時：滑鼠滾輪水平捲動（要攔下來，不然會捲到外層）
  const barRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth) return;
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (!d) return;
      e.preventDefault();
      el.scrollLeft += e.deltaMode === 1 ? d * 30 : d;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);
  // 切換分頁時，把目前的分頁捲進看得到的範圍
  useEffect(() => {
    barRef.current?.querySelector<HTMLElement>(`[data-dock-tab="${active}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active]);

  const tabMenu = (e: React.MouseEvent, p: PanelId) => {
    e.preventDefault();
    e.stopPropagation();
    const d = useDock.getState();
    const items: MenuItem[] = [
      { label: $t('關閉'), shortcut: $t('中鍵'), action: () => d.closePanel(p) },
      { label: $t('關閉其他分頁'), action: node.tabs.length > 1 ? () => node.tabs.filter((x) => x !== p).forEach((x) => d.closePanel(x)) : undefined },
      { separator: true },
      { label: maximized ? $t('還原') : $t('最大化'), shortcut: $t('雙擊'), action: () => d.toggleMax(node.id) },
    ];
    if (p === 'preview') items.push({ label: floating ? $t('停駐預覽') : $t('分離成浮動視窗'), action: () => useLayout.getState().set({ floating: !floating }) });
    openMenu(e.clientX, e.clientY, items);
  };

  return (
    <div className="dock-group" data-dock-group={node.id}>
      <div
        ref={barRef}
        className={`dock-tabs ${drag && !drag.panel && drag.from === node.id ? 'dragging' : ''}`}
        onDoubleClick={(e) => e.target === e.currentTarget && useDock.getState().toggleMax(node.id)}
        onPointerDown={(e) => e.target === e.currentTarget && e.button === 0 && startTabDrag(e, null, node.id, rootRef?.current ?? null, node.tabs.map((x) => TITLE[x]).join(' · '))}
      >
        {node.tabs.map((p, i) => (
          <React.Fragment key={p}>
            {insertAt === i && <div className="dock-insert" />}
            <div
              data-dock-tab={p}
              className={`dock-tab ${p === active ? 'on' : ''} ${drag?.panel === p ? 'dragging' : ''}`}
              onPointerDown={(e) => startTabDrag(e, p, node.id, rootRef?.current ?? null, TITLE[p])}
              onDoubleClick={() => useDock.getState().toggleMax(node.id)}
              onContextMenu={(e) => tabMenu(e, p)}
            >
              {TITLE[p]}
            </div>
          </React.Fragment>
        ))}
        {insertAt === node.tabs.length && <div className="dock-insert" />}
        {maximized && <button className="dock-restore" onClick={() => useDock.getState().toggleMax(node.id)} title={$t('還原')}><Minimize2 size={12} /> {$t('還原')}</button>}
      </div>
      <div className="dock-body">
        {editorOpen && (active === 'preview' || active === 'inspector') ? (
          // 編輯視窗開著：屬性 / 預覽暫時搬到視窗裡
          <div className="dock-placeholder">
            <p className="muted">{$t('目前在編輯視窗中')}</p>
          </div>
        ) : active === 'preview' && floating ? (
          <div className="dock-placeholder">
            <p className="muted">{$t('預覽目前是浮動視窗')}</p>
            <button className="btn" onClick={() => useLayout.getState().set({ floating: false })}>{$t('停駐回這裡')}</button>
          </div>
        ) : (
          <Slot key={active} host={hosts[active]} />
        )}
      </div>
      {zone && <div className={`dock-drop ${zone}`} />}
    </div>
  );
}
