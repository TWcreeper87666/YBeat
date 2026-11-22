/**
 * 給 AI 看的畫面：目前預覽畫面、模組套在預覽畫面上跑出來的幾格。
 * 一律縮到長邊 ≤ 384px 的 JPEG：Gemini 對這個大小的圖一張只算 258 token（更大會切塊、倍數增加）。
 */
import type { ModuleKind } from '../store';
import { Renderer, getRenderer } from '../engine/renderer';
import { card } from '../engine/thumbs';

export const MAX_SIDE = 384;

/** 給 API 的圖（base64，不含 data: 前綴）與給介面顯示的 data URL */
export interface Shot { mime: 'image/jpeg'; data: string; url: string }

const shot = (c: HTMLCanvasElement): Shot => {
  const url = c.toDataURL('image/jpeg', 0.8);
  return { mime: 'image/jpeg', data: url.slice(url.indexOf(',') + 1), url };
};

/** 把一張畫面縮到長邊 ≤ MAX_SIDE */
function scaled(src: CanvasImageSource, w: number, h: number): HTMLCanvasElement {
  const k = Math.min(1, MAX_SIDE / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(2, Math.round(w * k));
  c.height = Math.max(2, Math.round(h * k));
  c.getContext('2d')!.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

/** 目前預覽畫面（縮小後的 canvas）；預覽還沒建立 = null */
function previewCanvas(): HTMLCanvasElement | null {
  const r = getRenderer();
  if (!r) return null;
  return scaled(r.canvas, r.canvas.width, r.canvas.height);
}

/** 目前預覽畫面的截圖 */
export function previewShot(): Shot | null {
  const c = previewCanvas();
  return c ? shot(c) : null;
}

/** 檢查模組時取樣的進度：特效頭中尾；轉場看過程中 */
export const SAMPLE_AT: Record<'effect' | 'transition', number[]> = { effect: [0.05, 0.5, 0.95], transition: [0.25, 0.5, 0.75] };

let checker: { r: Renderer; c: HTMLCanvasElement } | null = null;

/**
 * 模組套在目前預覽畫面上（轉場：前一段 = 預覽畫面、後一段 = 測試卡），在 SAMPLE_AT 的進度各算一格。
 * 第一張是原始畫面。變速模組、編譯失敗 = null。
 */
export function moduleShots(kind: ModuleKind, code: string, duration = 1): { shots: Shot[]; at: number[] } | null {
  if (kind === 'remap') return null;
  const base = previewCanvas() ?? scaled(card('#ff3d6e', '#6a2c70', 'A'), 160, 160);
  const other = scaled(card('#29d3c2', '#3a0ca3', 'B'), 160, 160);
  if (!checker) {
    const c = document.createElement('canvas');
    checker = { r: new Renderer(c, { w: base.width, h: base.height }), c };
  }
  const { r, c } = checker;
  r.setSize(base.width, base.height);
  const m = { id: 'ai-check', kind, name: 'ai-check', code };
  const at = SAMPLE_AT[kind];
  const shots: Shot[] = [shot(base)];
  for (const p of at) {
    if (!r.thumb(m, p, base, other, duration)) return null;
    shots.push(shot(c));
  }
  return { shots, at };
}
