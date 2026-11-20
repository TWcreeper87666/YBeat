/** 版面樹（純函式，不依賴 React，方便測試） */

export type PanelId = 'media' | 'text' | 'lyrics' | 'transition' | 'effect' | 'mask' | 'remap' | 'inspector' | 'code' | 'ai' | 'preview' | 'timeline';
export interface TabsNode { type: 'tabs'; id: string; tabs: PanelId[]; active: PanelId }
export interface SplitNode { type: 'split'; id: string; dir: 'row' | 'col'; children: DockNode[]; sizes: number[] }
export type DockNode = TabsNode | SplitNode;
export type Side = 'left' | 'right' | 'top' | 'bottom';
export type DropTarget =
  | { kind: 'group'; group: string; zone: 'center' | Side } // 拖到某個群組：中間 = 併入、邊緣 = 分割
  | { kind: 'tabs'; group: string; index: number } // 拖到分頁列：插入到指定位置
  | { kind: 'root'; side: Side }; // 拖到整個視窗邊緣：佔滿整高 / 整寬

/**
 * 每種面板的最小尺寸（px，不含分頁列）：小於這個，裡面的按鈕 / 欄位就會被擠出去。
 * 同一組分頁取最大值（切換分頁時不會突然放不下）。
 */
export const PANEL_MIN: Record<PanelId, { w: number; h: number }> = {
  media: { w: 220, h: 160 },
  text: { w: 220, h: 160 },
  lyrics: { w: 300, h: 180 },
  transition: { w: 220, h: 160 },
  effect: { w: 220, h: 160 },
  mask: { w: 220, h: 160 },
  remap: { w: 220, h: 160 },
  inspector: { w: 320, h: 160 },
  code: { w: 300, h: 160 },
  ai: { w: 280, h: 200 },
  preview: { w: 280, h: 220 },
  timeline: { w: 420, h: 150 },
};
/** 分頁列高度 + 外框、分隔線寬度（跟 styles.css 一致） */
const TABBAR = 29, BORDER = 2, SASH = 4;

/** 節點的最小尺寸：分頁組 = 各分頁最大值 + 分頁列；分割 = 沿方向加總、另一方向取最大 */
export function minSize(n: DockNode): { w: number; h: number } {
  if (n.type === 'tabs') {
    const ms = n.tabs.map((t) => PANEL_MIN[t] ?? { w: 120, h: 80 });
    return { w: Math.max(...ms.map((m) => m.w)) + BORDER, h: Math.max(...ms.map((m) => m.h)) + TABBAR + BORDER };
  }
  const ks = n.children.map(minSize);
  const gaps = SASH * (ks.length - 1);
  return n.dir === 'row'
    ? { w: ks.reduce((a, k) => a + k.w, 0) + gaps, h: Math.max(...ks.map((k) => k.h)) }
    : { w: Math.max(...ks.map((k) => k.w)), h: ks.reduce((a, k) => a + k.h, 0) + gaps };
}

/**
 * 拖分隔線：第 i、i+1 格的新比例（d = 拖動量 / 總長），兩格都不小於最小尺寸（mins：各格最小 px，total：總長 px）。
 * 兩格加起來都放不下最小尺寸時，照最小尺寸的比例分。
 */
export function dragSash(sizes: number[], i: number, d: number, mins: number[], total: number): number[] {
  const pair = sizes[i] + sizes[i + 1];
  const lo = mins[i] / total, hi = pair - mins[i + 1] / total;
  const a = lo <= hi ? Math.min(hi, Math.max(lo, sizes[i] + d)) : (pair * mins[i]) / (mins[i] + mins[i + 1] || 1);
  const out = [...sizes];
  out[i] = a;
  out[i + 1] = pair - a;
  return out;
}

let seq = 0;
export const nid = () => `n${Date.now().toString(36)}${(seq++).toString(36)}`;
export const T = (tabs: PanelId[], active?: PanelId): TabsNode => ({ type: 'tabs', id: nid(), tabs, active: active ?? tabs[0] });
export const R = (children: DockNode[], sizes: number[]): SplitNode => ({ type: 'split', id: nid(), dir: 'row', children, sizes });
export const C = (children: DockNode[], sizes: number[]): SplitNode => ({ type: 'split', id: nid(), dir: 'col', children, sizes });

const dirOf = (side: Side) => (side === 'left' || side === 'right' ? 'row' : 'col');
const isFirst = (side: Side) => side === 'left' || side === 'top';
const norm = (sizes: number[]) => {
  const sum = sizes.reduce((a, b) => a + b, 0) || 1;
  return sizes.map((x) => x / sum);
};

export function panelsIn(node: DockNode | null): PanelId[] {
  if (!node) return [];
  return node.type === 'tabs' ? node.tabs : node.children.flatMap(panelsIn);
}

export function findGroup(node: DockNode | null, pred: (t: TabsNode) => boolean): TabsNode | null {
  if (!node) return null;
  if (node.type === 'tabs') return pred(node) ? node : null;
  for (const c of node.children) {
    const r = findGroup(c, pred);
    if (r) return r;
  }
  return null;
}

export function mapTabs(node: DockNode | null, fn: (t: TabsNode) => TabsNode): DockNode | null {
  if (!node) return null;
  return node.type === 'tabs' ? fn(node) : { ...node, children: node.children.map((c) => mapTabs(c, fn)!) };
}

export function setSizes(node: DockNode | null, id: string, sizes: number[]): DockNode | null {
  if (!node || node.type === 'tabs') return node;
  if (node.id === id) return { ...node, sizes };
  return { ...node, children: node.children.map((c) => setSizes(c, id, sizes)!) };
}

/** 整理：移除只有一個子節點的分割、把同方向的巢狀分割攤平 */
export function normalize(node: DockNode | null): DockNode | null {
  if (!node || node.type === 'tabs') return node;
  const kids: DockNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((c0, i) => {
    const c = normalize(c0);
    if (!c) return;
    if (c.type === 'split' && c.dir === node.dir) {
      c.children.forEach((cc, j) => {
        kids.push(cc);
        sizes.push(node.sizes[i] * c.sizes[j]);
      });
    } else {
      kids.push(c);
      sizes.push(node.sizes[i]);
    }
  });
  if (!kids.length) return null;
  if (kids.length === 1) return kids[0];
  return { ...node, children: kids, sizes: norm(sizes) };
}

export function removePanel(node: DockNode | null, panel: PanelId): DockNode | null {
  if (!node) return null;
  if (node.type === 'tabs') {
    if (!node.tabs.includes(panel)) return node;
    const tabs = node.tabs.filter((t) => t !== panel);
    if (!tabs.length) return null;
    const active = node.active === panel ? tabs[Math.max(0, node.tabs.indexOf(panel) - 1)] : node.active;
    return { ...node, tabs, active };
  }
  const kids: DockNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((c, i) => {
    const r = removePanel(c, panel);
    if (r) {
      kids.push(r);
      sizes.push(node.sizes[i]);
    }
  });
  return normalize({ ...node, children: kids, sizes: norm(sizes) });
}

function insertIntoGroup(node: DockNode, groupId: string, panels: PanelId[], active: PanelId, zone: 'center' | Side, index?: number): DockNode {
  if (node.type === 'tabs') {
    if (node.id !== groupId) return node;
    if (zone === 'center') {
      const tabs = node.tabs.filter((t) => !panels.includes(t));
      const i = index === undefined ? tabs.length : Math.max(0, Math.min(tabs.length, index));
      tabs.splice(i, 0, ...panels);
      return { ...node, tabs, active };
    }
    const fresh = T([...panels], active);
    return { type: 'split', id: nid(), dir: dirOf(zone), children: isFirst(zone) ? [fresh, node] : [node, fresh], sizes: [0.5, 0.5] };
  }
  return { ...node, children: node.children.map((c) => insertIntoGroup(c, groupId, panels, active, zone, index)) };
}

/** 放到整個版面的邊緣（佔滿整高 / 整寬） */
function insertAtRoot(node: DockNode, panels: PanelId[], active: PanelId, side: Side): DockNode {
  const fresh = T([...panels], active);
  const dir = dirOf(side);
  const NEW = 0.28;
  if (node.type === 'split' && node.dir === dir) {
    const scaled = node.sizes.map((s) => s * (1 - NEW));
    return isFirst(side)
      ? { ...node, children: [fresh, ...node.children], sizes: [NEW, ...scaled] }
      : { ...node, children: [...node.children, fresh], sizes: [...scaled, NEW] };
  }
  return { type: 'split', id: nid(), dir, children: isFirst(side) ? [fresh, node] : [node, fresh], sizes: isFirst(side) ? [NEW, 1 - NEW] : [1 - NEW, NEW] };
}

/** 把面板從 from 群組移到目標（VS Code 的拖曳行為） */
export function movePanel(layout: DockNode | null, panel: PanelId, from: string, target: DropTarget): DockNode | null {
  const src = findGroup(layout, (g) => g.id === from);
  // 同一個群組內換順序
  if (target.kind === 'tabs' && target.group === from && src) {
    const old = src.tabs.indexOf(panel);
    const tabs = src.tabs.filter((t) => t !== panel);
    const i = Math.max(0, Math.min(tabs.length, target.index > old ? target.index - 1 : target.index));
    tabs.splice(i, 0, panel);
    return mapTabs(layout, (g) => (g.id === from ? { ...g, tabs, active: panel } : g));
  }
  // 拖回自己的中間、或自己只有一個分頁還想分割自己 → 不動
  if (target.kind === 'group' && target.group === from && (target.zone === 'center' || (src && src.tabs.length === 1))) {
    return mapTabs(layout, (g) => (g.id === from ? { ...g, active: panel } : g));
  }
  const removed = removePanel(layout, panel);
  if (!removed) return T([panel]);
  let out: DockNode;
  if (target.kind === 'root') out = insertAtRoot(removed, [panel], panel, target.side);
  else if (!findGroup(removed, (g) => g.id === target.group)) out = insertAtRoot(removed, [panel], panel, 'right');
  else if (target.kind === 'tabs') out = insertIntoGroup(removed, target.group, [panel], panel, 'center', target.index);
  else out = insertIntoGroup(removed, target.group, [panel], panel, target.zone);
  return normalize(out);
}

/** 整個群組（所有分頁）一起移到目標；拖到自己身上不動 */
export function moveGroup(layout: DockNode | null, from: string, target: DropTarget): DockNode | null {
  const src = findGroup(layout, (g) => g.id === from);
  if (!src || (target.kind !== 'root' && target.group === from)) return layout;
  let removed: DockNode | null = layout;
  for (const p of src.tabs) removed = removePanel(removed, p);
  if (!removed) return layout; // 只有這一個群組，移動沒有意義
  let out: DockNode;
  if (target.kind === 'root') out = insertAtRoot(removed, src.tabs, src.active, target.side);
  else if (!findGroup(removed, (g) => g.id === target.group)) return layout;
  else if (target.kind === 'tabs') out = insertIntoGroup(removed, target.group, src.tabs, src.active, 'center', target.index);
  else out = insertIntoGroup(removed, target.group, src.tabs, src.active, target.zone);
  return normalize(out);
}

/** 打開面板：已在版面上就切到它；不在就加到「屬性」所在群組（或第一個群組） */
export function showPanel(layout: DockNode | null, panel: PanelId): DockNode {
  const g = findGroup(layout, (t) => t.tabs.includes(panel));
  if (g) return mapTabs(layout, (t) => (t.id === g.id ? { ...t, active: panel } : t))!;
  if (!layout) return T([panel]);
  const target = findGroup(layout, (t) => t.tabs.includes('inspector')) ?? findGroup(layout, () => true)!;
  return insertIntoGroup(layout, target.id, [panel], panel, 'center');
}
