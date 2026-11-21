/**
 * 遮罩形狀庫：內建形狀（SVG 路徑）＋ 自訂形狀（從圖片匯入 / 鋼筆工具畫的），以及「我的最愛」。
 *
 * 矩形 / 橢圓在 shader 裡直接算；其他形狀先畫成一張 256×256 的「距離場」貼圖
 * （每個像素 = 到形狀邊界的距離），shader 讀它就能做出平滑的羽化，跟矩形 / 橢圓一樣。
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { $t } from '../i18n';
import type { PenPt } from './penPath';

export type ShapeCat = 'basic' | 'symbol' | 'custom';

export interface ShapeInfo {
  id: string;
  name: string;
  cat: ShapeCat;
  /** 內建：SVG 路徑（viewBox 0 0 200 200，evenodd） */
  path?: string;
  /** 自訂：白色形狀、透明背景的 PNG（data URL） */
  png?: string;
  /** 形狀原本的寬高比（套用時用來決定遮罩框的比例） */
  aspect: number;
}

export interface CustomShape {
  id: string;
  name: string;
  aspect: number;
  /** 從圖片匯入 */
  png?: string;
  /** 鋼筆工具畫的：正規化到 200×200 的路徑 */
  path?: string;
  /** 鋼筆工具的原始錨點（再次編輯用） */
  pen?: PenPt[];
}

// ───────────── 內建形狀 ─────────────

const poly = (pts: [number, number][]) => `M${pts.map(([x, y]) => `${+x.toFixed(2)} ${+y.toFixed(2)}`).join('L')}Z`;
/** 正多邊形 / 星形：n 個角，外半徑 100，內半徑 inner（不給 = 正多邊形），第一個角朝上 */
function radial(n: number, inner?: number, cy = 100) {
  const pts: [number, number][] = [];
  const k = inner === undefined ? n : n * 2;
  for (let i = 0; i < k; i++) {
    const r = inner === undefined || i % 2 === 0 ? 100 : inner;
    const a = -Math.PI / 2 + (i * Math.PI * 2) / k;
    pts.push([100 + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return poly(pts);
}
const RECT = 'M0 0H200V200H0Z';
const ELLIPSE = 'M100 0A100 100 0 1 1 100 200A100 100 0 1 1 100 0Z';

const BUILTIN = (): ShapeInfo[] => [
  { id: 'rect', name: $t('矩形'), cat: 'basic', path: RECT, aspect: 1 },
  { id: 'ellipse', name: $t('橢圓'), cat: 'basic', path: ELLIPSE, aspect: 1 },
  { id: 'roundrect', name: $t('圓角矩形'), cat: 'basic', path: 'M40 0H160A40 40 0 0 1 200 40V160A40 40 0 0 1 160 200H40A40 40 0 0 1 0 160V40A40 40 0 0 1 40 0Z', aspect: 1 },
  { id: 'triangle', name: $t('三角形'), cat: 'basic', path: poly([[100, 0], [200, 200], [0, 200]]), aspect: 1 },
  { id: 'diamond', name: $t('菱形'), cat: 'basic', path: poly([[100, 0], [200, 100], [100, 200], [0, 100]]), aspect: 1 },
  { id: 'pentagon', name: $t('五邊形'), cat: 'basic', path: radial(5, undefined, 110), aspect: 1 },
  { id: 'hexagon', name: $t('六邊形'), cat: 'basic', path: radial(6), aspect: 1 },
  { id: 'octagon', name: $t('八邊形'), cat: 'basic', path: radial(8), aspect: 1 },
  { id: 'parallelogram', name: $t('平行四邊形'), cat: 'basic', path: poly([[50, 0], [200, 0], [150, 200], [0, 200]]), aspect: 1 },
  { id: 'halfcircle', name: $t('半圓'), cat: 'basic', path: 'M0 200A100 200 0 0 1 200 200Z', aspect: 2 },
  { id: 'star', name: $t('星形'), cat: 'symbol', path: radial(5, 40, 110), aspect: 1 },
  { id: 'star4', name: $t('四角星'), cat: 'symbol', path: radial(4, 28), aspect: 1 },
  { id: 'burst', name: $t('爆炸'), cat: 'symbol', path: radial(12, 74), aspect: 1 },
  { id: 'heart', name: $t('愛心'), cat: 'symbol', path: 'M100 196C35 150 0 108 0 62C0 26 27 0 60 0C78 0 92 9 100 24C108 9 122 0 140 0C173 0 200 26 200 62C200 108 165 150 100 196Z', aspect: 1 },
  { id: 'cross', name: $t('十字'), cat: 'symbol', path: poly([[65, 0], [135, 0], [135, 65], [200, 65], [200, 135], [135, 135], [135, 200], [65, 200], [65, 135], [0, 135], [0, 65], [65, 65]]), aspect: 1 },
  { id: 'arrow', name: $t('箭頭'), cat: 'symbol', path: poly([[0, 60], [120, 60], [120, 0], [200, 100], [120, 200], [120, 140], [0, 140]]), aspect: 1.6 },
  { id: 'ring', name: $t('圓環'), cat: 'symbol', path: `${ELLIPSE}M100 50A50 50 0 1 0 100 150A50 50 0 1 0 100 50Z`, aspect: 1 },
  { id: 'speech', name: $t('對話框'), cat: 'symbol', path: 'M30 0H170A30 30 0 0 1 200 30V120A30 30 0 0 1 170 150H90L40 200L50 150H30A30 30 0 0 1 0 120V30A30 30 0 0 1 30 0Z', aspect: 1.3 },
];
let builtinCache: ShapeInfo[] | null = null;
export const builtinShapes = () => (builtinCache ??= BUILTIN());

// ───────────── 自訂形狀 / 我的最愛（存在 localStorage，跟自訂模組一樣不跟專案走）─────────────

interface MaskLib {
  customs: CustomShape[];
  add(s: Omit<CustomShape, 'id'>): string;
  remove(id: string): void;
  rename(id: string, name: string): void;
  update(id: string, patch: Partial<Omit<CustomShape, 'id'>>): void;
}

export const useMaskLib = create<MaskLib>()(
  persist(
    (set, get) => ({
      customs: [],
      add: (s) => {
        const id = `custom:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        set({ customs: [...get().customs, { ...s, id }] });
        return id;
      },
      remove: (id) => set({ customs: get().customs.filter((c) => c.id !== id) }),
      rename: (id, name) => set({ customs: get().customs.map((c) => (c.id === id ? { ...c, name } : c)) }),
      update: (id, patch) => {
        fields.delete(id); // 形狀改了：距離場重算
        set({ customs: get().customs.map((c) => (c.id === id ? { ...c, ...patch } : c)) });
      },
    }),
    { name: 'ybeat-masks', partialize: (s) => ({ customs: s.customs }) },
  ),
);

export function allShapes(): ShapeInfo[] {
  return [...builtinShapes(), ...useMaskLib.getState().customs.map((c) => ({ ...c, cat: 'custom' as const }))];
}
export function shapeInfo(id: string): ShapeInfo | undefined {
  return builtinShapes().find((s) => s.id === id) ?? useMaskLib.getState().customs.map((c) => ({ ...c, cat: 'custom' as const })).find((s) => s.id === id);
}
/** 遮罩形狀的顯示名稱（找不到 = 自訂形狀被刪掉了） */
export const shapeName = (id: string) => (id === 'none' ? $t('無') : id === 'path' ? $t('自訂路徑') : shapeInfo(id)?.name ?? $t('（形狀遺失）'));

/** 遮罩用的距離場 key：遮罩自己的路徑 = `path:<路徑>`，其他 = 形狀 id */
export const maskFieldKey = (m: { shape: string; path?: string }) => (m.shape === 'path' ? (m.path ? `path:${m.path}` : 'rect') : m.shape);

// ───────────── 距離場 ─────────────

export const FIELD = 256;
/** 距離場的值域：±FIELD_RANGE 個「半寬」，存成 0~255（128 = 邊界） */
export const FIELD_RANGE = 2;

export interface ShapeField { data: Uint8Array; size: number }

/** 一維精確距離轉換（Felzenszwalb & Huttenlocher） */
function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array) {
  const inter = (q: number, p: number) => (f[q] + q * q - (f[p] + p * p)) / (2 * q - 2 * p);
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = inter(q, v[k]);
    while (s <= z[k]) {
      k--;
      s = inter(q, v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

/** 每個像素到最近「目標像素」的距離平方（二維，可分離） */
function edt2d(target: (i: number) => boolean, n: number): Float64Array {
  const INF = 1e20;
  const g = new Float64Array(n * n);
  for (let i = 0; i < n * n; i++) g[i] = target(i) ? 0 : INF;
  const f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) f[y] = g[y * n + x];
    edt1d(f, n, d, v, z);
    for (let y = 0; y < n; y++) g[y * n + x] = d[y];
  }
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) f[x] = g[y * n + x];
    edt1d(f, n, d, v, z);
    for (let x = 0; x < n; x++) g[y * n + x] = d[x];
  }
  return g;
}

/** 由覆蓋率（0~1，列優先、第一列在上）做出有號距離場；純函式，方便測試 */
export function fieldFromCoverage(cov: Float32Array | number[], n: number): ShapeField {
  const inside = (i: number) => cov[i] >= 0.5;
  const toInside = edt2d(inside, n);
  const toOutside = edt2d((i) => !inside(i), n);
  const half = n / 2;
  const data = new Uint8Array(n * n);
  for (let i = 0; i < n * n; i++) {
    // 像素中心到邊界約差半格
    const dist = inside(i) ? -(Math.sqrt(toOutside[i]) - 0.5) : Math.sqrt(toInside[i]) - 0.5;
    const v = dist / half / FIELD_RANGE; // -1 ~ 1
    data[i] = Math.max(0, Math.min(255, Math.round(127.5 + v * 127.5)));
  }
  return { data, size: n };
}

function canvas(n: number) {
  const c = document.createElement('canvas');
  c.width = c.height = n;
  return c;
}
function coverageOf(c: HTMLCanvasElement): Float32Array {
  const px = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
  const out = new Float32Array(c.width * c.height);
  for (let i = 0; i < out.length; i++) out[i] = px[i * 4 + 3] / 255;
  return out;
}

const fields = new Map<string, ShapeField | 'loading' | 'error'>();

function buildBuiltin(path: string): ShapeField {
  const c = canvas(FIELD);
  const g = c.getContext('2d')!;
  g.scale(FIELD / 200, FIELD / 200);
  g.fillStyle = '#fff';
  g.fill(new Path2D(path), 'evenodd');
  return fieldFromCoverage(coverageOf(c), FIELD);
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error('image'));
    img.src = src;
  });
}

async function buildCustom(png: string): Promise<ShapeField> {
  const img = await loadImage(png);
  const c = canvas(FIELD);
  c.getContext('2d')!.drawImage(img, 0, 0, FIELD, FIELD);
  return fieldFromCoverage(coverageOf(c), FIELD);
}

/** 取得形狀的距離場；自訂形狀第一次會在背景解碼（回傳 null，下一幀再拿） */
export function getShapeField(id: string): ShapeField | null {
  const cur = fields.get(id);
  if (cur && typeof cur !== 'string') return cur;
  if (cur) return null;
  if (id.startsWith('path:')) {
    // 遮罩自己的路徑：改一次就是新的 key，舊的留太多就清掉
    if (fields.size > 200) for (const k of [...fields.keys()].filter((k) => k.startsWith('path:')).slice(0, 50)) fields.delete(k);
    const f = buildBuiltin(id.slice(5));
    fields.set(id, f);
    return f;
  }
  const info = shapeInfo(id);
  if (!info) return null;
  if (info.path) {
    const f = buildBuiltin(info.path);
    fields.set(id, f);
    return f;
  }
  if (info.png) {
    fields.set(id, 'loading');
    buildCustom(info.png).then(
      (f) => fields.set(id, f),
      () => fields.set(id, 'error'),
    );
  }
  return null;
}

/** 匯出前：確定用到的形狀都準備好了 */
export async function ensureShapes(ids: Iterable<string>) {
  for (const id of new Set(ids)) {
    if (id === 'none' || id === 'rect' || id === 'ellipse') continue;
    const info = shapeInfo(id);
    if (!info) continue;
    if (info.path) getShapeField(id);
    else if (info.png && typeof fields.get(id) !== 'object') {
      try {
        fields.set(id, await buildCustom(info.png));
      } catch {
        fields.set(id, 'error');
      }
    }
  }
}

// ───────────── 匯入自訂形狀 ─────────────

/**
 * 從圖片（PNG / SVG / JPG…）做出遮罩形狀：有透明背景就用透明度，沒有就用亮度（白 = 保留）。
 * 會裁掉四周空白，讓形狀剛好填滿遮罩框。
 */
export async function shapeFromImage(file: File): Promise<Omit<CustomShape, 'id'> | null> {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const W0 = img.naturalWidth || 512, H0 = img.naturalHeight || 512;
    const k = Math.min(1, 1024 / Math.max(W0, H0));
    const w = Math.max(1, Math.round(W0 * k)), h = Math.max(1, Math.round(H0 * k));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d')!;
    g.drawImage(img, 0, 0, w, h);
    const px = g.getImageData(0, 0, w, h).data;
    let transparent = false;
    for (let i = 3; i < px.length; i += 4) if (px[i] < 250) { transparent = true; break; }
    const a = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const al = px[i * 4 + 3] / 255;
      a[i] = transparent ? al : (0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]) / 255;
    }
    // 形狀的範圍（裁掉空白）
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (a[y * w + x] >= 0.5) {
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    if (x1 < 0) return null;
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    // 輸出：白色 + 透明度，拉成正方形（比例另外記）
    const out = canvas(FIELD);
    const og = out.getContext('2d')!;
    const tmp = document.createElement('canvas');
    tmp.width = bw;
    tmp.height = bh;
    const tg = tmp.getContext('2d')!;
    const id = tg.createImageData(bw, bh);
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
      const o = (y * bw + x) * 4;
      id.data[o] = id.data[o + 1] = id.data[o + 2] = 255;
      id.data[o + 3] = Math.round(a[(y + y0) * w + x + x0] * 255);
    }
    tg.putImageData(id, 0, 0);
    og.imageSmoothingQuality = 'high';
    og.drawImage(tmp, 0, 0, FIELD, FIELD);
    return { name: file.name.replace(/\.[^.]+$/, ''), png: out.toDataURL('image/png'), aspect: bw / bh };
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}
