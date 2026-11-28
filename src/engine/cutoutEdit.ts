/**
 * 去背的手動修正：在 AI 遮罩上「補上 / 擦掉」。
 * 座標都是素材自己的 0~1（跟著素材，不管片段 / 圖層怎麼縮放、移動）；影片、動態圖片每一格都套同樣的修正。
 */
import type { Clip } from '../store';
import type { AnimSlot } from './animation';

export type Pt = [number, number];

/** 一筆修正：brush = 筆刷粗細（素材高度的比例，pts 是筆畫）；沒有 brush = 套索圍起來的區域（pts 是多邊形） */
export interface CutoutFix { op: 'add' | 'erase'; pts: Pt[]; brush?: number }

export interface CutoutEdit {
  /** 修正是對這個素材做的（換了素材就不套用，換回來又會用） */
  mediaId: string;
  fix: CutoutFix[];
}

/** 修正後的遮罩解析度（正方形，拉伸蓋住整個素材，跟 AI 遮罩一樣） */
export const EDIT_SIZE = 512;

/** 現在要用的修正（素材對不上 / 沒有修正 = null） */
export function editFor(mediaId: string | null | undefined, e: CutoutEdit | undefined): CutoutEdit | null {
  return e && mediaId && e.mediaId === mediaId && e.fix?.length ? e : null;
}

/** 片段的修正（沒開 AI 去背 = null） */
export const clipEdit = (c: Pick<Clip, 'mediaId' | 'aiMatte' | 'matteEdit'>) => (c.aiMatte ? editFor(c.mediaId, c.matteEdit) : null);

const keys = new WeakMap<CutoutEdit, string>();
/** 快取用的 key（同一個物件只算一次） */
export function editKey(e: CutoutEdit): string {
  let k = keys.get(e);
  if (!k) keys.set(e, (k = JSON.stringify(e.fix)));
  return k;
}

const out = new Map<string, Uint8Array>();
/**
 * 修正後的遮罩（EDIT_SIZE²，一個 byte 一格）。base = AI 遮罩。
 * aspect = 素材寬 / 高（筆刷才會是圓的）。cacheKey：同一格 AI 遮罩的 key（有給才快取）
 */
export function editedMatte(base: { data: Uint8Array; size: number }, fix: CutoutFix[], aspect: number, cacheKey?: string): Uint8Array {
  const key = cacheKey && `${cacheKey}|${aspect.toFixed(4)}|${JSON.stringify(fix)}`;
  const hit = key && out.get(key);
  if (hit) return hit;
  const S = EDIT_SIZE;
  const c = new OffscreenCanvas(S, S);
  const g = c.getContext('2d', { willReadFrequently: true })!;
  const src = new OffscreenCanvas(base.size, base.size);
  const img = new ImageData(base.size, base.size);
  for (let i = 0; i < base.data.length; i++) {
    const v = base.data[i];
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  src.getContext('2d')!.putImageData(img, 0, 0);
  g.imageSmoothingEnabled = true;
  g.drawImage(src, 0, 0, S, S);
  // 筆刷 / 套索：在「以素材高度為單位」的座標畫（x 乘上寬高比），筆刷才是圓的
  g.setTransform(S / aspect, 0, 0, S, 0, 0);
  g.lineCap = 'round';
  g.lineJoin = 'round';
  for (const f of fix) {
    if (!f.pts.length) continue;
    g.fillStyle = g.strokeStyle = f.op === 'add' ? '#fff' : '#000';
    g.beginPath();
    f.pts.forEach(([x, y], i) => (i ? g.lineTo(x * aspect, y) : g.moveTo(x * aspect, y)));
    if (f.brush) {
      if (f.pts.length === 1) g.lineTo(f.pts[0][0] * aspect + 1e-4, f.pts[0][1]);
      g.lineWidth = f.brush;
      g.stroke();
    } else if (f.pts.length > 2) {
      g.closePath();
      g.fill();
    }
  }
  const px = g.getImageData(0, 0, S, S).data;
  const data = new Uint8Array(S * S);
  for (let i = 0; i < data.length; i++) data[i] = px[i * 4];
  if (key) {
    // 動態圖片 / 影片每一格各一張：留多一點
    if (out.size > 96) out.delete(out.keys().next().value!);
    out.set(key, data);
  }
  return data;
}

/** 動畫圖片位置的修正（沒開去背 = null） */
export const slotEdit = (s: Pick<AnimSlot, 'mediaId' | 'cutout'>) => (s.cutout?.mode === 'auto' ? editFor(s.mediaId, s.cutout.edit) : null);
