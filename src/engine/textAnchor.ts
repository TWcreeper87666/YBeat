import { useStore, type Clip } from '../store';
import { textSize, type TextStyle } from './text';
import { clipTransformAt } from './transform';
import type { Keyframe } from './keyframes';

/**
 * 改文字片段的內容 / 樣式。靠左、靠右對齊時，對齊的那一邊在畫面上固定不動：
 * 文字框以中心定位，寬度一變中心不變、兩邊一起縮；這裡把寬度的變化補回位置（含旋轉、縮放、翻轉），
 * 位置有關鍵影格時整條曲線一起平移。置中對齊維持原樣。
 */
export function updateText(clipId: string, patch: Partial<TextStyle>) {
  const s = useStore.getState();
  const c = s.clips.find((x) => x.id === clipId);
  if (!c?.text) return;
  const next: TextStyle = { ...c.text, ...patch };
  const upd: Partial<Clip> = { text: next };
  const shift = anchorShift(c, c.text, next);
  if (shift) {
    const [dx, dy] = shift;
    const move = (l: Keyframe[] | undefined, d: number) => l?.map((k) => ({ ...k, v: k.v + d }));
    upd.transform = { ...c.transform, x: c.transform.x + dx, y: c.transform.y + dy };
    if (c.keys.x || c.keys.y) upd.keys = { ...c.keys, ...(c.keys.x ? { x: move(c.keys.x, dx) } : {}), ...(c.keys.y ? { y: move(c.keys.y, dy) } : {}) };
  }
  s.updateClip(clipId, upd);
}

/** 對齊邊固定不動時，位置要移多少（畫面寬 / 高為 1）；不用移就回傳 null */
export function anchorShift(c: Clip, prev: TextStyle, next: TextStyle): [number, number] | null {
  // 對齊方式本身改了：照原本的中心，不補償
  if (next.align === 'center' || next.align !== prev.align) return null;
  const s = useStore.getState();
  const H = s.format.h, aspect = s.format.w / s.format.h;
  const w0 = textSize(prev, H)[0], w1 = textSize(next, H)[0];
  if (Math.abs(w1 - w0) < 1e-6) return null;
  const xf = clipTransformAt(c, Math.min(c.duration, Math.max(0, s.time - c.start)));
  // 沿著文字自己的 x 軸移動（畫面高度單位）；靠右 = 往右補、靠左 = 往左補；負的縮放（翻轉）方向相反
  const d = ((next.align === 'right' ? 1 : -1) * (w0 - w1) * xf.scaleX) / 2;
  const r = (xf.rotation * Math.PI) / 180;
  return [(d * Math.cos(r)) / aspect, d * Math.sin(r)];
}
