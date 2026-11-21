import { $t } from '../i18n';
/** 文字 / 字幕片段：用 canvas 畫成圖，再當成一般片段（可變換、打關鍵影格、套轉場） */

/** 填色：純色或雙色漸層（範圍是整塊文字，不是每個字各一段）。字本身與每一層外框共用 */
export interface Paint {
  type: 'solid' | 'linear' | 'radial';
  /** 純色，或漸層的起點色 */
  color: string;
  /** 漸層的終點色 */
  color2: string;
  /** 線性漸層的角度（度，0 = 由左到右，90 = 由上到下） */
  angle: number;
}

/** 一層外框：第一層最靠近字，後面每一層接在前一層外面（粗細累加） */
export interface Stroke {
  paint: Paint;
  /** 這一層的粗細（px，以輸出畫面計） */
  width: number;
  /** 轉角：round 圓角、miter 尖角（現代字幕常用）、bevel 斜切 */
  join: 'round' | 'miter' | 'bevel';
}

export const MAX_STROKES = 4;
export const solid = (color: string): Paint => ({ type: 'solid', color, color2: '#000000', angle: 90 });
export const newStroke = (color = '#000000', width = 8): Stroke => ({ paint: solid(color), width, join: 'round' });

export interface TextStyle {
  text: string;
  font: string;
  /** 字級（以 1080×1920 畫面的像素計） */
  size: number;
  fill: Paint;
  bold: boolean;
  italic: boolean;
  align: 'left' | 'center' | 'right';
  lineHeight: number;
  /** 外框（最多 MAX_STROKES 層） */
  strokes: Stroke[];
  /** 底框 */
  bg: string;
  bgOpacity: number;
  /** 陰影；null = 沒有陰影 */
  shadow: Shadow | null;
}

export interface Shadow {
  color: string;
  /** 不透明度 0..1 */
  opacity: number;
  /** 方向（度，0 = 往右、90 = 往下） */
  angle: number;
  /** 距離（px，以輸出畫面計） */
  distance: number;
  /** 模糊（px） */
  blur: number;
}

/** 預設陰影：黑色 80%、往下，距離與模糊依字級（跟以前寫死的效果一樣） */
export const defaultShadow = (size: number): Shadow => ({ color: '#000000', opacity: 0.8, angle: 90, distance: Math.round(size * 0.03), blur: Math.round(size * 0.15) });
/** 存檔裡的陰影不是設定（例如舊版的 true / false）就當成沒有陰影 */
export const shadowOf = (s: TextStyle): Shadow | null => (s.shadow && typeof s.shadow === 'object' ? s.shadow : null);

export const FONTS: { id: string; label: string }[] = [
  { id: 'system-ui, "Microsoft JhengHei", "PingFang TC", sans-serif', label: $t('黑體（系統）') },
  { id: '"Noto Serif TC", "PMingLiU", "Songti TC", serif', label: $t('明體') },
  { id: 'Impact, "Arial Black", sans-serif', label: 'Impact' },
  { id: '"Arial Black", Arial, sans-serif', label: 'Arial Black' },
  { id: 'Georgia, serif', label: 'Georgia' },
  { id: '"Courier New", ui-monospace, monospace', label: $t('等寬') },
  { id: '"Comic Sans MS", cursive', label: 'Comic' },
];

export const DEFAULT_TEXT: TextStyle = {
  text: $t('輸入文字'),
  font: FONTS[0].id,
  size: 96,
  fill: solid('#ffffff'),
  bold: true,
  italic: false,
  align: 'center',
  lineHeight: 1.2,
  strokes: [],
  bg: '#000000',
  bgOpacity: 0,
  shadow: defaultShadow(96),
};

export interface TextPreset {
  id: string;
  name: string;
  style: Partial<TextStyle>;
  /** 預設位置（畫面座標，0 = 置中，y 向下） */
  y: number;
  duration: number;
}

export const TEXT_PRESETS: TextPreset[] = [
  { id: 'title', name: $t('大標題'), style: { text: $t('大標題'), size: 150, bold: true, shadow: defaultShadow(150) }, y: -0.1, duration: 3 },
  { id: 'subtitle', name: $t('字幕'), style: { text: $t('這裡是字幕'), size: 64, bold: true, strokes: [{ ...newStroke('#000000', 8), join: 'miter' }], shadow: null }, y: 0.3, duration: 3 },
  { id: 'boxed', name: $t('底框字幕'), style: { text: $t('底框字幕'), size: 60, bold: false, bg: '#000000', bgOpacity: 0.6, shadow: null }, y: 0.3, duration: 3 },
  { id: 'outline', name: $t('描邊大字'), style: { text: 'BEAT', size: 220, font: FONTS[2].id, fill: solid('#ffffff'), strokes: [{ ...newStroke('#ff3d6e', 14), join: 'miter' }, { ...newStroke('#000000', 10), join: 'miter' }], shadow: null }, y: 0, duration: 2 },
  { id: 'neon', name: $t('霓虹'), style: { text: 'NEON', size: 160, fill: { type: 'linear', color: '#29d3c2', color2: '#b06bff', angle: 0 }, strokes: [newStroke('#ffffff', 4)], shadow: { color: '#b06bff', opacity: 0.9, angle: 90, distance: 0, blur: 40 } }, y: 0, duration: 2 },
  { id: 'caption', name: $t('小註解'), style: { text: $t('小註解文字'), size: 44, bold: false, fill: solid('#ffe066'), shadow: defaultShadow(44) }, y: 0.4, duration: 3 },
];

const PAD = 24;

/** 粗體的字重（畫面渲染與預覽上直接改字共用，字寬才對得上） */
export const BOLD_WEIGHT = 800;

function fontOf(s: TextStyle) {
  return `${s.italic ? 'italic ' : ''}${s.bold ? BOLD_WEIGHT : 400} ${s.size}px ${s.font}`;
}

/** 文字四周的留白（輸出畫面像素）：描邊、陰影也算在內 */
export const strokeTotal = (s: TextStyle) => s.strokes.reduce((a, k) => a + Math.max(0, k.width), 0);
export const textPad = (s: TextStyle) => {
  const sh = shadowOf(s);
  // 陰影往任何方向都可能，四周都留「距離 + 模糊」
  return PAD + strokeTotal(s) + (sh && sh.opacity > 0 ? Math.max(0, sh.distance) + Math.max(0, sh.blur) : 0);
};

/** #rrggbb + 不透明度 → rgba() */
function hexAlpha(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${Math.min(1, Math.max(0, a))})`;
}

/** 把 Paint 變成 canvas 的填色；漸層範圍是整塊文字（rect） */
function paintStyle(g: CanvasRenderingContext2D, p: Paint, r: { x: number; y: number; w: number; h: number }): string | CanvasGradient {
  if (p.type === 'solid') return p.color;
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  let gr: CanvasGradient;
  if (p.type === 'radial') {
    gr = g.createRadialGradient(cx, cy, 0, cx, cy, Math.hypot(r.w, r.h) / 2);
  } else {
    const a = (p.angle * Math.PI) / 180, dx = Math.cos(a), dy = Math.sin(a);
    const half = (Math.abs(dx) * r.w + Math.abs(dy) * r.h) / 2; // 漸層線剛好蓋住整塊文字
    gr = g.createLinearGradient(cx - dx * half, cy - dy * half, cx + dx * half, cy + dy * half);
  }
  gr.addColorStop(0, p.color);
  gr.addColorStop(1, p.color2);
  return gr;
}

/** 文字片段的 canvas（以 style 為 key 快取） */
const cache = new Map<string, HTMLCanvasElement>();

export function textKey(s: TextStyle) {
  return JSON.stringify(s);
}

export function renderText(s: TextStyle): HTMLCanvasElement {
  const key = textKey(s);
  const hit = cache.get(key);
  if (hit) return hit;
  const lines = (s.text || ' ').split('\n');
  const probe = document.createElement('canvas').getContext('2d')!;
  probe.font = fontOf(s);
  const widths = lines.map((l) => probe.measureText(l || ' ').width);
  const lh = s.size * s.lineHeight;
  const extra = textPad(s);
  const W = Math.ceil(Math.max(...widths) + extra * 2);
  const H = Math.ceil(lh * lines.length + extra * 2);
  const c = document.createElement('canvas');
  c.width = Math.max(2, Math.min(4096, W));
  c.height = Math.max(2, Math.min(4096, H));
  const g = c.getContext('2d')!;
  g.font = fontOf(s);
  g.textBaseline = 'middle';
  g.textAlign = s.align;
  g.miterLimit = 3; // 尖角太尖的地方（很銳利的筆畫）自動改成斜切，避免刺出來
  const x = s.align === 'left' ? extra : s.align === 'right' ? c.width - extra : c.width / 2;
  if (s.bgOpacity > 0) {
    g.globalAlpha = s.bgOpacity;
    g.fillStyle = s.bg;
    const r = Math.min(24, s.size * 0.25);
    lines.forEach((_, i) => {
      const w = widths[i] + PAD * 2;
      const left = s.align === 'left' ? extra - PAD : s.align === 'right' ? c.width - extra - widths[i] - PAD : (c.width - w) / 2;
      const top = extra + i * lh - PAD * 0.3;
      g.beginPath();
      g.roundRect(left, top, w, lh + PAD * 0.6, r);
      g.fill();
    });
    g.globalAlpha = 1;
  }
  // 漸層的範圍：整塊文字（每層外框各自往外多一點，讓漸層也蓋到外框）
  const maxW = Math.max(...widths);
  const block = { x: s.align === 'left' ? extra : s.align === 'right' ? c.width - extra - maxW : (c.width - maxW) / 2, y: extra, w: maxW, h: lh * lines.length };
  const grow = (r: typeof block, d: number) => ({ x: r.x - d, y: r.y - d, w: r.w + d * 2, h: r.h + d * 2 });
  const lineY = (i: number) => extra + i * lh + lh / 2;
  // 陰影只畫在最先畫的那一層（最外層外框，沒有外框就是字本身）
  let shadow = shadowOf(s);
  const useShadow = () => {
    if (!shadow) return;
    const a = (shadow.angle * Math.PI) / 180;
    g.shadowColor = hexAlpha(shadow.color, shadow.opacity);
    g.shadowBlur = Math.max(0, shadow.blur);
    g.shadowOffsetX = Math.cos(a) * shadow.distance;
    g.shadowOffsetY = Math.sin(a) * shadow.distance;
    shadow = null;
  };
  // 外框：最外層先畫、往內畫；每一層的線寬 = 這層和裡面所有層的粗細加總（canvas 的描邊一半在字外面）
  const layers = s.strokes.filter((k) => k.width > 0);
  for (let i = layers.length - 1; i >= 0; i--) {
    const k = layers[i];
    const reach = layers.slice(0, i + 1).reduce((a, x) => a + x.width, 0);
    useShadow();
    g.lineJoin = k.join;
    g.lineWidth = reach * 2;
    g.strokeStyle = paintStyle(g, k.paint, grow(block, reach));
    lines.forEach((l, j) => g.strokeText(l, x, lineY(j)));
    g.shadowColor = 'transparent';
  }
  useShadow();
  g.fillStyle = paintStyle(g, s.fill, block);
  lines.forEach((l, j) => g.fillText(l, x, lineY(j)));
  g.shadowColor = 'transparent';
  if (cache.size > 200) cache.clear();
  cache.set(key, c);
  return c;
}

/** 文字片段在畫面上的大小（以畫面高度為 1） */
export function textSize(s: TextStyle, frameH = 1920): [number, number] {
  const c = renderText(s);
  return [c.width / frameH, c.height / frameH];
}
