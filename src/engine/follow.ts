/**
 * point 參數跟著畫面裡的臉（第 2 階段）。
 * - 模組在 point 參數後面加 @follow(face)：預設就跟隨（素材有偵測結果時；沒有就照原本的值）。
 * - 使用者可以在每個特效 / 轉場上關掉（null）或打開（Follow），並調整相對臉的偏移。
 * 座標一律是畫面座標 0..1（y 向下），跟 point 參數一樣。
 */
import type { Clip, Media, Module } from '../store';
import type { ParamDef } from './params';
import { clipSource } from './remap';
import { clipTransformAt, fitSize } from './transform';
import { ensureFaces, faceAt, faceRange, requestFaces } from './face';
import { parseParams } from './params';

/** 一個 point 參數跟著臉 */
export interface Follow {
  target: 'face';
  /** 相對臉中心的偏移（畫面 0..1） */
  offset?: [number, number];
  /** 轉場：跟前一段（from）還是後一段（to）的臉；沒有 = from */
  side?: 'from' | 'to';
}

/** 每個 point 參數的設定；null = 使用者關掉（蓋過模組的 @follow 預設） */
export type FollowMap = Record<string, Follow | null>;

/** 這個參數實際的跟隨設定（使用者設定優先，其次模組預設） */
export function followOf(d: ParamDef, map: FollowMap | undefined): Follow | null {
  if (d.type !== 'point') return null;
  const f = map?.[d.name];
  if (f === null) return null;
  if (f) return f;
  return d.follow ? { target: d.follow } : null;
}

/**
 * 片段在 local 這一刻，畫面裡那張臉的中心（畫面座標）；片段沒開臉部追蹤 / 沒有臉 / 還沒偵測 = null（還沒偵測的順便排進背景）。
 * aspect = 畫面寬 / 高。跟渲染一樣：素材依 fit 放大、照片段的位置 / 縮放（負的 = 翻轉）/ 旋轉擺到畫面上。
 */
export function faceInFrame(clip: Clip, media: Media | undefined, local: number, modules: Map<string, Module>, aspect: number): [number, number] | null {
  if (!clip.faceTrack || !media || clip.text || media.missing || (media.kind !== 'video' && media.kind !== 'image')) return null;
  const src = media.kind === 'image' ? local : clipSource(clip, local, media, modules).src;
  const f = faceAt(media, src);
  if (!f) {
    requestFaces(clip, media, modules);
    return null;
  }
  return mediaToFrame(clip, media, local, aspect, f.x, f.y);
}

/** 素材畫面上的一點（0..1，y 向下）→ 畫面座標 */
export function mediaToFrame(clip: Clip, media: { width: number; height: number }, local: number, aspect: number, u: number, v: number): [number, number] {
  const xf = clipTransformAt(clip, Math.min(clip.duration, Math.max(0, local)));
  // 以畫面高度為 1 的單位
  const [sw, sh] = fitSize(clip.fit === 'cover', (media.width || 1) / (media.height || 1), aspect);
  const dx = (u - 0.5) * sw * xf.scaleX, dy = (v - 0.5) * sh * xf.scaleY;
  const a = (xf.rotation * Math.PI) / 180;
  const rx = dx * Math.cos(a) - dy * Math.sin(a), ry = dx * Math.sin(a) + dy * Math.cos(a);
  return [(0.5 + xf.x) + rx / aspect, 0.5 + xf.y + ry];
}

/** 跟隨時參數的值 = 臉的位置 + 偏移 */
export const withOffset = (p: [number, number], f: Follow): number[] => [p[0] + (f.offset?.[0] ?? 0), p[1] + (f.offset?.[1] ?? 0)];

/** 這個特效 / 轉場有沒有任何參數在跟著臉 */
export function followsAny(m: Module | undefined, map: FollowMap | undefined): boolean {
  return !!m && parseParams(m.code).some((d) => !!followOf(d, map));
}

/** 匯出前：開了臉部追蹤的片段都要先偵測完（不然前面幾格會照原本的值） */
export async function prepareFaces(clips: Clip[], media: Map<string, Media>, modules: Map<string, Module>) {
  for (const c of clips) {
    if (!c.faceTrack) continue;
    const m = media.get(c.mediaId);
    if (!m || c.text || m.missing || (m.kind !== 'video' && m.kind !== 'image')) continue;
    const r = faceRange(c, m, modules);
    await ensureFaces(m, r.from, r.to);
  }
}
