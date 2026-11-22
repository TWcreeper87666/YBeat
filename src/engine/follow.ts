/**
 * point 參數跟著片段追蹤的目標（臉部或自訂框選的目標）。
 * - 片段屬性 `Clip.subject`：追蹤什麼（沒有 = 不追蹤）。
 * - 模組在 point 參數後面加 @follow：預設就跟隨（片段有追蹤結果時；沒有就照原本的值）。
 * - 使用者可以在每個特效 / 轉場上關掉（null）或打開（Follow），並調整相對目標的偏移。
 * 座標一律是畫面座標 0..1（y 向下），跟 point 參數一樣。
 */
import type { Clip, Media, Module } from '../store';
import type { ParamDef } from './params';
import type { TrackPoint } from './faceTrack';
import { clipSource } from './remap';
import { clipTransformAt, fitSize } from './transform';
import { ensureFaces, faceAt, faceRange, requestFaces } from './face';
import { boxAt, prepareBoxTrack, requestBoxTrack } from './boxTrack';
import { animImage } from './animImage';
import { parseParams } from './params';

/** 自訂目標的錨點：t = 素材時間（秒；動態圖片 = 動畫內時間）；box = 素材畫面 0..1 的中心 x, y 與寬、高 */
export interface Anchor { t: number; box: [number, number, number, number] }

/** 片段追蹤的目標 */
export type Subject = { kind: 'face' } | { kind: 'box'; anchors: Anchor[] };

/** 一個 point 參數跟著目標 */
export interface Follow {
  /** 相對目標中心的偏移（畫面 0..1） */
  offset?: [number, number];
  /** 轉場：跟前一段（from）還是後一段（to）的目標；沒有 = from */
  side?: 'from' | 'to';
}

/** 每個 point 參數的設定；null = 使用者關掉（蓋過模組的 @follow 預設） */
export type FollowMap = Record<string, Follow | null>;

/** 這個參數實際的跟隨設定（使用者設定優先，其次模組預設） */
export function followOf(d: ParamDef, map: FollowMap | undefined): Follow | null {
  if (d.type !== 'point' || d.fit) return null;
  const f = map?.[d.name];
  if (f === null) return null;
  if (f) return f;
  return d.follow ? {} : null;
}

/** 片段有在追蹤東西（臉部，或至少框了一個目標） */
export const tracking = (c: Clip | undefined | null): boolean => !!c?.subject && (c.subject.kind === 'face' || c.subject.anchors.length > 0);

const visual = (c: Clip, m: Media | undefined): m is Media => !!m && !c.text && !m.missing && (m.kind === 'video' || m.kind === 'image');

/** 片段在 local 這一刻對應的素材時間（圖片 = 片段內時間） */
export const sourceTime = (clip: Clip, media: Media, local: number, modules: Map<string, Module>) =>
  media.kind === 'image' ? local : clipSource(clip, local, media, modules).src;

/** 錨點要存的時間：素材時間；動態圖片 = 動畫內時間（循環） */
export function anchorTime(clip: Clip, media: Media, local: number, modules: Map<string, Module>): number {
  if (media.kind === 'image') {
    const a = animImage(media);
    return a ? +(((local % a.total) + a.total) % a.total).toFixed(4) : 0;
  }
  return +clipSource(clip, local, media, modules).src.toFixed(4);
}

/** 片段在 local 這一刻追蹤的目標（素材畫面 0..1）；沒有 / 還沒算好 = null（還沒算的順便排進背景） */
export function subjectAt(clip: Clip, media: Media | undefined, local: number, modules: Map<string, Module>): TrackPoint | null {
  if (!tracking(clip) || !visual(clip, media)) return null;
  const src = sourceTime(clip, media, local, modules);
  const s = clip.subject!;
  if (s.kind === 'face') {
    const f = faceAt(media, src);
    if (!f) requestFaces(clip, media, modules);
    return f;
  }
  const b = boxAt(media, s.anchors, src);
  if (!b) requestBoxTrack(clip, media, s.anchors, modules);
  return b;
}

/** 開始在背景算這個片段的追蹤（臉部偵測 / 自訂目標追蹤） */
export function requestSubject(clip: Clip, media: Media | undefined, modules: Map<string, Module>) {
  if (!tracking(clip) || !visual(clip, media)) return;
  const s = clip.subject!;
  if (s.kind === 'face') requestFaces(clip, media, modules);
  else requestBoxTrack(clip, media, s.anchors, modules);
}

/**
 * 片段在 local 這一刻，追蹤目標的中心（畫面座標）；aspect = 畫面寬 / 高。
 * 跟渲染一樣：素材依 fit 放大、照片段的位置 / 縮放（負的 = 翻轉）/ 旋轉擺到畫面上。
 */
export function subjectInFrame(clip: Clip, media: Media | undefined, local: number, modules: Map<string, Module>, aspect: number): [number, number] | null {
  const p = subjectAt(clip, media, local, modules);
  return p ? mediaToFrame(clip, media!, local, aspect, p.x, p.y) : null;
}

/** 片段在 local 這一刻，追蹤目標在畫面上的框：中心與寬、高（畫面 0..1；有旋轉時取外框） */
export function subjectRectInFrame(clip: Clip, media: Media | undefined, local: number, modules: Map<string, Module>, aspect: number): { c: [number, number]; s: [number, number] } | null {
  const p = subjectAt(clip, media, local, modules);
  if (!p) return null;
  const pts = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => mediaToFrame(clip, media!, local, aspect, p.x + (a * p.w) / 2, p.y + (b * p.h) / 2));
  const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
  return { c: mediaToFrame(clip, media!, local, aspect, p.x, p.y), s: [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)] };
}

/** @fit 參數現在跟著目標大小（它的點在跟隨） */
export function fitOf(d: ParamDef, defs: ParamDef[], map: FollowMap | undefined): boolean {
  if (d.type !== 'point' || !d.fit) return false;
  const c = defs.find((x) => x.name === d.fit!.of);
  return !!c && !!followOf(c, map);
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

/** 畫面座標 → 素材畫面上的一點（mediaToFrame 的反函數） */
export function frameToMedia(clip: Clip, media: { width: number; height: number }, local: number, aspect: number, x: number, y: number): [number, number] {
  const xf = clipTransformAt(clip, Math.min(clip.duration, Math.max(0, local)));
  const [sw, sh] = fitSize(clip.fit === 'cover', (media.width || 1) / (media.height || 1), aspect);
  const rx = (x - 0.5 - xf.x) * aspect, ry = y - 0.5 - xf.y;
  const a = (-xf.rotation * Math.PI) / 180;
  const dx = rx * Math.cos(a) - ry * Math.sin(a), dy = rx * Math.sin(a) + ry * Math.cos(a);
  return [0.5 + dx / (sw * (xf.scaleX || 1e-9)), 0.5 + dy / (sh * (xf.scaleY || 1e-9))];
}

/**
 * 畫面上的一個框（兩個對角，畫面座標）→ 錨點的框（素材畫面 0..1，中心 + 寬高）。
 * 片段有旋轉時取四個角換算後的外框；限制在素材畫面裡。
 */
export function frameRectToBox(clip: Clip, media: { width: number; height: number }, local: number, aspect: number, a: [number, number], b: [number, number]): [number, number, number, number] | null {
  const pts = [[a[0], a[1]], [b[0], a[1]], [a[0], b[1]], [b[0], b[1]]].map(([x, y]) => frameToMedia(clip, media, local, aspect, x, y));
  const cl = (v: number) => Math.min(1, Math.max(0, v));
  const x0 = cl(Math.min(...pts.map((p) => p[0]))), x1 = cl(Math.max(...pts.map((p) => p[0])));
  const y0 = cl(Math.min(...pts.map((p) => p[1]))), y1 = cl(Math.max(...pts.map((p) => p[1])));
  if (x1 - x0 < 0.005 || y1 - y0 < 0.005) return null;
  return [(x0 + x1) / 2, (y0 + y1) / 2, x1 - x0, y1 - y0];
}

/** 加 / 換一個錨點（同一格附近的換掉） */
export function putAnchor(anchors: Anchor[], a: Anchor): Anchor[] {
  return [...anchors.filter((x) => Math.abs(x.t - a.t) > 0.5 / 30), a].sort((x, y) => x.t - y.t);
}

/** 跟隨時參數的值 = 目標的位置 + 偏移 */
export const withOffset = (p: [number, number], f: Follow): number[] => [p[0] + (f.offset?.[0] ?? 0), p[1] + (f.offset?.[1] ?? 0)];

/** 這個特效 / 轉場有沒有任何參數在跟著目標 */
export function followsAny(m: Module | undefined, map: FollowMap | undefined): boolean {
  return !!m && parseParams(m.code).some((d) => !!followOf(d, map));
}

/** 匯出前：有追蹤的片段都要先算完（不然前面幾格會照原本的值） */
export async function prepareSubjects(clips: Clip[], media: Map<string, Media>, modules: Map<string, Module>) {
  for (const c of clips) {
    const m = media.get(c.mediaId);
    if (!tracking(c) || !visual(c, m)) continue;
    const s = c.subject!;
    if (s.kind === 'face') {
      const r = faceRange(c, m, modules);
      await ensureFaces(m, r.from, r.to);
    } else await prepareBoxTrack(c, m, s.anchors, modules);
  }
}
