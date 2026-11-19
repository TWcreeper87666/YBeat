import { $t } from '../i18n';
/** 文字 / 字幕片段：用 canvas 畫成圖，再當成一般片段（可變換、打關鍵影格、套轉場） */

export interface TextStyle {
  text: string;
  font: string;
  /** 字級（以 1080×1920 畫面的像素計） */
  size: number;
  color: string;
  bold: boolean;
  italic: boolean;
  align: 'left' | 'center' | 'right';
  lineHeight: number;
  /** 描邊 */
  stroke: string;
  strokeW: number;
  /** 描邊轉角：round 圓角、miter 尖角（現代字幕常用）、bevel 斜切；沒設定 = 圓角 */
  strokeJoin?: 'round' | 'miter' | 'bevel';
  /** 底框 */
  bg: string;
  bgOpacity: number;
  /** 陰影 */
  shadow: boolean;
}

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
  color: '#ffffff',
  bold: true,
  italic: false,
  align: 'center',
  lineHeight: 1.2,
  stroke: '#000000',
  strokeW: 0,
  bg: '#000000',
  bgOpacity: 0,
  shadow: true,
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
  { id: 'title', name: $t('大標題'), style: { text: $t('大標題'), size: 150, bold: true, shadow: true }, y: -0.1, duration: 3 },
  { id: 'subtitle', name: $t('字幕'), style: { text: $t('這裡是字幕'), size: 64, bold: true, strokeW: 8, stroke: '#000000', strokeJoin: 'miter', shadow: false }, y: 0.3, duration: 3 },
  { id: 'boxed', name: $t('底框字幕'), style: { text: $t('底框字幕'), size: 60, bold: false, bg: '#000000', bgOpacity: 0.6, shadow: false }, y: 0.3, duration: 3 },
  { id: 'outline', name: $t('描邊大字'), style: { text: 'BEAT', size: 220, font: FONTS[2].id, color: '#ffffff', stroke: '#ff3d6e', strokeW: 14, strokeJoin: 'miter', shadow: false }, y: 0, duration: 2 },
  { id: 'neon', name: $t('霓虹'), style: { text: 'NEON', size: 160, color: '#29d3c2', stroke: '#ffffff', strokeW: 4, shadow: true }, y: 0, duration: 2 },
  { id: 'caption', name: $t('小註解'), style: { text: $t('小註解文字'), size: 44, bold: false, color: '#ffe066', shadow: true }, y: 0.4, duration: 3 },
];

const PAD = 24;

function fontOf(s: TextStyle) {
  return `${s.italic ? 'italic ' : ''}${s.bold ? '800' : '400'} ${s.size}px ${s.font}`;
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
  const extra = PAD + s.strokeW + (s.shadow ? s.size * 0.12 : 0);
  const W = Math.ceil(Math.max(...widths) + extra * 2);
  const H = Math.ceil(lh * lines.length + extra * 2);
  const c = document.createElement('canvas');
  c.width = Math.max(2, Math.min(4096, W));
  c.height = Math.max(2, Math.min(4096, H));
  const g = c.getContext('2d')!;
  g.font = fontOf(s);
  g.textBaseline = 'middle';
  g.textAlign = s.align;
  g.lineJoin = s.strokeJoin ?? 'round';
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
  lines.forEach((l, i) => {
    const y = extra + i * lh + lh / 2;
    if (s.shadow) {
      g.shadowColor = '#000000cc';
      g.shadowBlur = s.size * 0.15;
      g.shadowOffsetY = s.size * 0.03;
    }
    if (s.strokeW > 0) {
      g.strokeStyle = s.stroke;
      g.lineWidth = s.strokeW * 2;
      g.strokeText(l, x, y);
      g.shadowColor = 'transparent';
    }
    g.fillStyle = s.color;
    g.fillText(l, x, y);
    g.shadowColor = 'transparent';
  });
  if (cache.size > 200) cache.clear();
  cache.set(key, c);
  return c;
}

/** 文字片段在畫面上的大小（以畫面高度為 1） */
export function textSize(s: TextStyle, frameH = 1920): [number, number] {
  const c = renderText(s);
  return [c.width / frameH, c.height / frameH];
}
