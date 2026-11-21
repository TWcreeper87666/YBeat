import { $t } from '../i18n';
import { create } from 'zustand';
import type { Module } from '../modules/builtin';
import { Renderer } from './renderer';
import { parseDuration, parseParams, resolveParams } from './params';
import { remapLib } from './remap';

/** 特效 / 轉場 / 變速的預覽縮圖：閒置時一張一張算，依程式碼快取 */

export const THUMB_W = 160;
export const THUMB_H = 160;

export const useThumbs = create<{ map: Record<string, string> }>(() => ({ map: {} }));

const keyOf = (m: Module) => `${m.id}:${hash(m.code)}`;
function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h.toString(36);
}

let renderer: Renderer | null = null;
let canvas: HTMLCanvasElement | null = null;
let samples: [HTMLCanvasElement, HTMLCanvasElement] | null = null;
const queue = new Map<string, Module>();
let scheduled = false;

function card(a: string, b: string, label: string) {
  const c = document.createElement('canvas');
  c.width = THUMB_W;
  c.height = THUMB_H;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, THUMB_W, THUMB_H);
  grad.addColorStop(0, a);
  grad.addColorStop(1, b);
  g.fillStyle = grad;
  g.fillRect(0, 0, THUMB_W, THUMB_H);
  g.globalAlpha = 0.18;
  g.fillStyle = '#fff';
  for (let i = -10; i < 20; i++) g.fillRect(i * 22, 0, 8, THUMB_H);
  g.globalAlpha = 1;
  g.strokeStyle = '#fff';
  g.lineWidth = 5;
  g.beginPath();
  g.arc(THUMB_W / 2, THUMB_H / 2, 42, 0, Math.PI * 2);
  g.stroke();
  g.fillStyle = '#fff';
  g.font = '900 46px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(label, THUMB_W / 2, THUMB_H / 2 + 2);
  return c;
}

/** 變速模組：畫「素材時間 vs 片段時間」曲線 */
function remapThumb(m: Module): string {
  const c = document.createElement('canvas');
  c.width = THUMB_W;
  c.height = THUMB_H;
  const g = c.getContext('2d')!;
  g.fillStyle = '#111419';
  g.fillRect(0, 0, THUMB_W, THUMB_H);
  g.strokeStyle = '#ffffff14';
  for (let i = 1; i < 4; i++) {
    g.beginPath(); g.moveTo((THUMB_W * i) / 4, 0); g.lineTo((THUMB_W * i) / 4, THUMB_H); g.stroke();
    g.beginPath(); g.moveTo(0, (THUMB_H * i) / 4); g.lineTo(THUMB_W, (THUMB_H * i) / 4); g.stroke();
  }
  try {
    const fn = new Function('ease', `"use strict";\n${m.code}\n;return typeof remap === 'function' ? remap : null;`)(remapLib);
    if (fn) {
      const p = resolveParams(parseParams(m.code), {});
      const info = { dur: 1, srcDur: 10, in: 0 };
      const pts: number[] = [];
      for (let i = 0; i <= 80; i++) pts.push(Number(fn(i / 80, p, info)) || 0);
      const mx = Math.max(1, ...pts.map(Math.abs));
      g.strokeStyle = '#29d3c2';
      g.lineWidth = 3;
      g.beginPath();
      pts.forEach((v, i) => {
        const x = 8 + (i / 80) * (THUMB_W - 16);
        const y = THUMB_H - 12 - (v / mx) * (THUMB_H - 24);
        if (i) g.lineTo(x, y); else g.moveTo(x, y);
      });
      g.stroke();
    }
  } catch {
    /* 程式碼有錯就畫空白 */
  }
  return c.toDataURL('image/png');
}

function process() {
  scheduled = false;
  const first = queue.entries().next();
  if (first.done) return;
  const [key, m] = first.value;
  queue.delete(key);
  let url = '';
  try {
    if (m.kind === 'remap') url = remapThumb(m);
    else {
      if (!renderer) {
        canvas = document.createElement('canvas');
        renderer = new Renderer(canvas, { w: THUMB_W, h: THUMB_H });
        samples = [card('#ff3d6e', '#6a2c70', 'A'), card('#29d3c2', '#3a0ca3', 'B')];
      }
      const dur = m.kind === 'transition' ? 0.8 : parseDuration(m.code, 0.5);
      const prog = m.kind === 'transition' ? 0.42 : 0.18;
      if (renderer.thumb(m, prog, samples![0], samples![1], dur)) url = canvas!.toDataURL('image/jpeg', 0.85);
    }
  } catch (e) {
    console.warn($t('縮圖失敗'), m.name, e);
  }
  if (url) useThumbs.setState((s) => ({ map: { ...s.map, [key]: url } }));
  schedule();
}

function schedule() {
  if (scheduled || !queue.size) return;
  scheduled = true;
  const ric = (window as unknown as { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback;
  if (ric) ric(process);
  else setTimeout(process, 30);
}

/** 取得縮圖（還沒算好就排進佇列，算好後元件會自動更新） */
export function useModuleThumb(m: Module): string | undefined {
  const key = keyOf(m);
  const url = useThumbs((s) => s.map[key]);
  if (!url && !queue.has(key)) {
    queue.set(key, m);
    schedule();
  }
  return url;
}
