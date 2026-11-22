import type { RenderCtx } from '../engine/renderer';
import { makeClip, type Clip, type Media } from '../store';

/**
 * 特效 / 轉場試看用的示範畫面：A、B 兩張圖（跟模組縮圖同一套配色），照輸出比例產生。
 * 試看時換成只有這兩段的暫時時間軸，不動到專案。
 */

/** 每段長度：夠長，轉場（最長幾秒）才不會被截短 */
const SEG = 4;

function sampleCard(w: number, h: number, a: string, b: string, label: string) {
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
