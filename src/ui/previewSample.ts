import type { RenderCtx } from '../engine/renderer';
import { makeClip, type Clip, type Media } from '../store';
import { MATTE_SIZE, seedMatte } from '../engine/matte';

/**
 * 特效 / 轉場試看用的示範畫面：A、B 兩張圖（跟模組縮圖同一套配色），照輸出比例產生。
 * 試看時換成只有這兩段的暫時時間軸，不動到專案。
 */

/** 每段長度：夠長，轉場（最長幾秒）才不會被截短 */
const SEG = 4;

/** 背景：漸層 + 斜條紋（跟模組縮圖同一套） */
function backdrop(w: number, h: number, a: string, b: string) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, a);
  grad.addColorStop(1, b);
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  // 斜條紋：看得出畫面的移動、縮放、扭曲
  const u = Math.min(w, h);
  g.globalAlpha = 0.18;
  g.fillStyle = '#fff';
  g.save();
  g.translate(w / 2, h / 2);
  g.rotate(-Math.PI / 4);
  const r = Math.hypot(w, h);
  for (let x = -r; x < r; x += u * 0.14) g.fillRect(x, -r, u * 0.05, r * 2);
  g.restore();
  g.globalAlpha = 1;
  return { c, g, u };
}

function sampleCard(w: number, h: number, a: string, b: string, label: string) {
  const { c, g, u } = backdrop(w, h, a, b);
  g.strokeStyle = '#fff';
  g.lineWidth = u * 0.03;
  g.beginPath();
  g.arc(w / 2, h / 2, u * 0.26, 0, Math.PI * 2);
  g.stroke();
  g.fillStyle = '#fff';
  g.font = `900 ${Math.round(u * 0.29)}px system-ui, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(label, w / 2, h / 2 + u * 0.01);
  return c.toDataURL('image/png');
}

const cache = new Map<string, [Media, Media]>();

function sampleMedia(fw: number, fh: number): [Media, Media] {
  // 長邊 960 就夠預覽用
  const k = 960 / Math.max(fw, fh);
  const w = Math.max(1, Math.round(fw * k)), h = Math.max(1, Math.round(fh * k));
  const key = `${w}x${h}`;
  let hit = cache.get(key);
  if (!hit) {
    const mk = (id: string, url: string, name: string): Media => ({ id, name, kind: 'image', url, width: w, height: h, duration: 3600, thumb: '', hasAudio: false });
    hit = [
      mk(`sample-a-${key}`, sampleCard(w, h, '#ff3d6e', '#6a2c70', 'A'), 'A'),
      mk(`sample-b-${key}`, sampleCard(w, h, '#29d3c2', '#3a0ca3', 'B'), 'B'),
    ];
    cache.set(key, hit);
  }
  return hit;
}

/** 示範時間軸：A（0 ~ SEG）接 B（SEG ~ 2·SEG）。mid = A 中間（試看特效）、cut = 剪接點（試看轉場） */
export function sampleCtx(base: RenderCtx, format: { w: number; h: number }): { ctx: RenderCtx; mid: number; cut: number } {
  const [ma, mb] = sampleMedia(format.w, format.h);
  const a: Clip = { ...makeClip({ mediaId: ma.id, start: 0, duration: SEG }), id: 'sample-a', fit: 'cover' };
  const b: Clip = { ...makeClip({ mediaId: mb.id, start: SEG, duration: SEG }), id: 'sample-b', fit: 'cover' };
  return {
    ctx: {
      ...base,
      clips: [a, b],
      audios: [],
      videoTracks: [[a, b]],
      effects: [],
      tracks: { video: [{}], fx: [], audio: [] },
      media: new Map([...base.media, [ma.id, ma], [mb.id, mb]]),
      linked: new Set(),
    },
    mid: SEG / 2,
    cut: SEG,
  };
}

// ───────────── 動畫範本試看：有人的示範畫面 ─────────────

/** 人形（半圓的身體 + 貼在上面的圓頭，座標 0..64 × -24..40，下緣切在畫面底）：素材庫卡片和試看畫面共用 */
export const PERSON_PATH = 'M15 40A17 17 0 0 1 49 40Z M32 7a8 8 0 1 1 0 16a8 8 0 1 1 0-16Z';
/** 三個人的顏色（多人範本的示意也用這三個） */
export const PERSON_TONES = ['#ffffff', '#ffd2a1', '#cfe9ff'];

/** 人形畫在 w×h 的畫面上：高度照畫面高，水平置中 */
function drawPerson(g: CanvasRenderingContext2D, w: number, h: number, fill: string, shadow: boolean) {
  const u = h / 64;
  g.save();
  g.translate(w / 2 - 32 * u, 24 * u);
  g.scale(u, u);
  const path = new Path2D(PERSON_PATH);
  if (shadow) { g.shadowColor = '#0008'; g.shadowBlur = 6; g.shadowOffsetY = 1.5; }
  g.fillStyle = fill;
  g.fill(path);
  // 黑色外框（遮罩也畫外框：去背時外框跟著人一起留下）
  g.shadowColor = 'transparent';
  g.lineJoin = 'round';
  g.lineWidth = 0.5;
  g.strokeStyle = shadow ? '#000' : fill;
  g.stroke(path);
  g.restore();
}

/** 人的去背遮罩（MATTE_SIZE 見方，對應整張圖） */
function personMatte(w: number, h: number): Uint8Array {
  const c = document.createElement('canvas');
  c.width = c.height = MATTE_SIZE;
  const g = c.getContext('2d')!;
  g.scale(MATTE_SIZE / w, MATTE_SIZE / h);
  drawPerson(g, w, h, '#fff', false);
  const px = g.getImageData(0, 0, MATTE_SIZE, MATTE_SIZE).data;
  const out = new Uint8Array(MATTE_SIZE * MATTE_SIZE);
  for (let i = 0; i < out.length; i++) out[i] = px[i * 4 + 3];
  return out;
}

/** scene = 只有背景（背景位置、底下的片段用）；people = 站著一個人的（主體 / 分身用，已經有去背遮罩） */
export interface AnimSample { scene: Media; people: Media[]; reveal: Media }
const animCache = new Map<string, AnimSample>();

/** A 畫面（空的 / 站著一個人，三種顏色各一張）；B = 下一個鏡頭 */
export function animSampleMedia(fw: number, fh: number): AnimSample {
  const k = 960 / Math.max(fw, fh);
  const w = Math.max(1, Math.round(fw * k)), h = Math.max(1, Math.round(fh * k));
  const key = `${w}x${h}`;
  let hit = animCache.get(key);
  if (!hit) {
    const mk = (id: string, url: string, name: string): Media => ({ id, name, kind: 'image', url, width: w, height: h, duration: 3600, thumb: '', hasAudio: false });
    const matte = personMatte(w, h);
    const people = PERSON_TONES.map((tone, i) => {
      const { c, g } = backdrop(w, h, '#ff3d6e', '#6a2c70');
      drawPerson(g, w, h, tone, true);
      const m = mk(`sample-person${i}-${key}`, c.toDataURL('image/png'), 'A');
      seedMatte(m.id, matte);
      return m;
    });
    hit = { scene: mk(`sample-scene-${key}`, backdrop(w, h, '#ff3d6e', '#6a2c70').c.toDataURL('image/png'), 'A'), people, reveal: mk(`sample-b-${key}`, sampleCard(w, h, '#29d3c2', '#3a0ca3', 'B'), 'B') };
    animCache.set(key, hit);
  }
  return hit;
}
