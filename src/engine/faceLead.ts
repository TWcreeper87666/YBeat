/**
 * 主角辨識的純計算部分（測試得到）：SFace 對齊、臉的特徵分群、找出主角、每個取樣點有沒有主角。
 * 特徵（128 維）由 face.ts 的 embedFace 算；這裡只處理數字。
 */
import type { FaceBox, MediaInfo, Span } from './mediaAnalysis';

/** SFace 對齊用的 5 點樣板（112×112）：右眼、左眼、鼻尖、右嘴角、左嘴角（跟 YuNet 特徵點的順序一樣） */
export const SFACE_DST: [number, number][] = [[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041]];

/**
 * 相似變換（等比縮放 + 旋轉 + 平移，最小平方）：src 的點 → dst 的點。
 * 回傳 canvas setTransform 的 [a, b, c, d, e, f]（x' = a x + c y + e，y' = b x + d y + f）。
 */
export function similarity(src: [number, number][], dst: [number, number][]): [number, number, number, number, number, number] {
  const n = Math.min(src.length, dst.length);
  let sx = 0, sy = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { sx += src[i][0]; sy += src[i][1]; dx += dst[i][0]; dy += dst[i][1]; }
  sx /= n; sy /= n; dx /= n; dy /= n;
  let num1 = 0, num2 = 0, den = 0;
  for (let i = 0; i < n; i++) {
    const px = src[i][0] - sx, py = src[i][1] - sy, qx = dst[i][0] - dx, qy = dst[i][1] - dy;
    num1 += px * qx + py * qy;
    num2 += px * qy - py * qx;
    den += px * px + py * py;
  }
  const a = den ? num1 / den : 1, b = den ? num2 / den : 0;
  return [a, b, -b, a, dx - (a * sx - b * sy), dy - (b * sx + a * sy)];
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) { ab += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
  return aa && bb ? ab / Math.sqrt(aa * bb) : 0;
}

/** 一張有特徵的臉（素材畫面 0..1） */
export interface FaceEmb extends FaceBox { emb: number[] }
/** 一個取樣點偵測到的臉（null = 這格沒取樣） */
export type FacesAt = (FaceBox & { emb?: number[] })[] | null;

/** 同一個人的門檻（OpenCV SFace 建議的 cosine 0.363）；認主角時放寬一點（側臉、比較糊的） */
export const SAME_PERSON = 0.363;
export const IS_LEAD = 0.3;

export interface Lead {
  /** 主角的平均特徵 */
  centroid: number[];
  /** 主角出現幾次 / 所有有特徵的臉佔幾成 / 第二多的人出現幾次 */
  count: number; share: number; second: number;
}

/**
 * 找主角：臉的特徵分群（大的臉先，跟哪一群的平均夠像就加進去，不然自己一群），出現最多次的那群。
 * 沒有臉 = null。
 */
export function findLead(faces: { h: number; emb: number[] }[], thr = SAME_PERSON): Lead | null {
  const groups: { sum: number[]; n: number }[] = [];
  for (const f of [...faces].sort((a, b) => b.h - a.h)) {
    let best = -1, bestSim = thr;
    groups.forEach((g, k) => {
      const s = cosine(f.emb, g.sum);
      if (s >= bestSim) { bestSim = s; best = k; }
    });
    if (best < 0) groups.push({ sum: [...f.emb], n: 1 });
    else {
      const g = groups[best];
      // 特徵先正規化再加，平均不會被大的向量拉走
      const len = Math.hypot(...f.emb) || 1;
      g.sum = g.sum.map((v, i) => v + f.emb[i] / len);
      g.n++;
    }
  }
  if (!groups.length) return null;
  groups.sort((a, b) => b.n - a.n);
  return { centroid: groups[0].sum, count: groups[0].n, share: groups[0].n / faces.length, second: groups[1]?.n ?? 0 };
}

export const isLead = (f: { emb?: number[] }, lead: Lead, thr = IS_LEAD) => !!f.emb && cosine(f.emb, lead.centroid) >= thr;

/** 有認得出來的臉的那幾格裡，有幾成有主角（群眾畫面一格幾十張臉，用張數算會被稀釋，所以用格數） */
export function leadShare(frames: FacesAt[], lead: Lead): number {
  const withFaces = frames.filter((l) => l?.some((f) => f.emb));
  return withFaces.length ? withFaces.filter((l) => l!.some((f) => isLead(f, lead))).length / withFaces.length : 0;
}

/** 主角夠明顯（出現夠多次、至少是第二名的兩倍、有臉的畫面三成五以上有他）才拿來避開別人 / 對準 */
export const confidentLead = (l: Lead | null, frameShare: number): l is Lead => !!l && l.count >= 3 && l.count >= 2 * l.second && frameShare >= 0.35;

/** 主角不夠明顯、但出現得比其他人多：只拿來決定追誰（不避開別人） */
export const followableLead = (l: Lead | null): l is Lead => !!l && l.count >= 3 && l.count > l.second;

/** 使用者指定的主角（一張臉的特徵）當成最明顯的主角 */
export const pickedLead = (emb: number[]): Lead => ({ centroid: emb, count: Infinity, share: 1, second: 0 });

/** 擴充指定主角時，收進來的臉要多像（比 SAME_PERSON 嚴，免得收到別人） */
export const REFINE_SAME = 0.42;
/** 指定的那張臉在平均裡佔幾張的份量（不讓收進來的臉把平均拉走） */
const PICKED_WEIGHT = 3;

/**
 * 指定主角只有一張臉：在所有素材裡找很像的臉一起平均（跑兩輪），換角度、光線也比對得到。
 * 一張都找不到就用原本那張。
 */
export function refineLead(emb: number[], faces: { emb: number[] }[], thr = REFINE_SAME): number[] {
  const unit = (v: ArrayLike<number>) => { const n = Math.hypot(...Array.from(v)) || 1; return Array.from(v, (x) => x / n); };
  const picked = unit(emb);
  let c = picked;
  for (let round = 0; round < 2; round++) {
    const hits = faces.filter((x) => cosine(x.emb, c) >= thr);
    if (!hits.length) break;
    const sum = picked.map((v) => v * PICKED_WEIGHT);
    for (const h of hits) unit(h.emb).forEach((v, i) => (sum[i] += v));
    c = unit(sum);
  }
  return c;
}

/** 每個取樣點：主角在（lead）/ 只有別人（others）/ 沒人或認不出來（none）/ 沒取樣（null） */
export type LeadState = 'lead' | 'others' | 'none';
export function leadStates(facesAt: FacesAt[], lead: Lead): (LeadState | null)[] {
  return facesAt.map((list) => {
    if (!list) return null;
    if (list.some((f) => isLead(f, lead))) return 'lead';
    // 只算認得出來的臉（有特徵的）：太小的臉不能確定是不是主角
    return list.some((f) => f.emb) ? 'others' : 'none';
  });
}

/**
 * 依主角改寫影片分析：faces = 主角的臉（取最近的取樣點）、people = 主角的分數、ban = 只有別人的範圍。
 * 只有別人的取樣點 → 從跟前一個取樣點的中間到跟下一個的中間都避開。
 */
export function leadInfo(info: MediaInfo, facesAt: FacesAt[], lead: Lead): { faces: (FaceBox | null)[]; people: number[]; ban: Span[]; states: (LeadState | null)[] } {
  const states = leadStates(facesAt, lead);
  const sampled = states.map((s, i) => (s ? i : -1)).filter((i) => i >= 0);
  const leadBox = (i: number) => facesAt[i]?.filter((f) => isLead(f, lead)).sort((a, b) => b.h - a.h)[0] ?? null;
  const near = (i: number) => sampled.reduce((best, x) => (Math.abs(x - i) < Math.abs(best - i) ? x : best), sampled[0] ?? 0);
  const n = info.quality.length;
  const faces = Array.from({ length: n }, (_, i) => {
    const b = sampled.length ? leadBox(near(i)) : null;
    return b ? { x: b.x, y: b.y, w: b.w, h: b.h } : null;
  });
  const people = faces.map((b) => (b ? Math.min(1, b.h / 0.25) : 0));
  const ban: Span[] = [];
  sampled.forEach((i, k) => {
    if (states[i] !== 'others') return;
    const prev = k > 0 ? sampled[k - 1] : null, next = k + 1 < sampled.length ? sampled[k + 1] : null;
    const a = prev === null ? 0 : ((prev + i) / 2) * info.step;
    const b = next === null ? info.duration : ((i + next) / 2) * info.step;
    const last = ban[ban.length - 1];
    if (last && a <= last[1] + 1e-6) last[1] = b;
    else ban.push([a, b]);
  });
  return { faces, people, ban, states };
}
