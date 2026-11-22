/**
 * 臉部偵測的純計算部分（測試得到）：YuNet 輸出解碼、NMS、挑出要跟的那張臉、平滑、依時間查詢。
 * 座標一律是「素材畫面」0..1（y 向下），跟素材的寬高比無關。
 */

export interface Face {
  /** 臉框中心 */
  x: number;
  y: number;
  w: number;
  h: number;
  score: number;
}

/** 一次取樣（素材時間，秒）偵測到的所有臉 */
export interface FaceSample { t: number; faces: Face[] }

/** 平滑後要跟的那張臉（沒有臉的時間不會有點） */
export interface TrackPoint { t: number; x: number; y: number; w: number; h: number }

const STRIDES = [8, 16, 32];

/**
 * YuNet（OpenCV Zoo，2023mar）的輸出解碼。輸入是 inW × inH（32 的倍數），素材畫在左上角 imgW × imgH 的範圍。
 * 每個 stride 一組輸出：cls / obj（每格一個分數）、bbox（dx, dy, log w, log h）；分數 = sqrt(cls × obj)。
 */
export function decodeYunet(out: Record<string, ArrayLike<number>>, inW: number, inH: number, imgW: number, imgH: number, thr = 0.6): Face[] {
  const faces: Face[] = [];
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  for (const s of STRIDES) {
    const cls = out[`cls_${s}`], obj = out[`obj_${s}`], bbox = out[`bbox_${s}`];
    if (!cls || !obj || !bbox) throw new Error(`YuNet output cls_${s} / obj_${s} / bbox_${s} missing`);
    const cols = Math.floor(inW / s), rows = Math.floor(inH / s);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const score = Math.sqrt(clamp(cls[i]) * clamp(obj[i]));
        if (score < thr) continue;
        const cx = (c + bbox[i * 4]) * s, cy = (r + bbox[i * 4 + 1]) * s;
        const w = Math.exp(bbox[i * 4 + 2]) * s, h = Math.exp(bbox[i * 4 + 3]) * s;
        faces.push({ x: cx / imgW, y: cy / imgH, w: w / imgW, h: h / imgH, score });
      }
    }
  }
  return nms(faces, 0.3);
}

export function iou(a: Face | TrackPoint, b: Face | TrackPoint): number {
  const ix = Math.max(0, Math.min(a.x + a.w / 2, b.x + b.w / 2) - Math.max(a.x - a.w / 2, b.x - b.w / 2));
  const iy = Math.max(0, Math.min(a.y + a.h / 2, b.y + b.h / 2) - Math.max(a.y - a.h / 2, b.y - b.h / 2));
  const inter = ix * iy;
  return inter > 0 ? inter / (a.w * a.h + b.w * b.h - inter) : 0;
}

/** 非極大值抑制：分數高的先留，跟留下來的重疊太多的丟掉 */
export function nms(faces: Face[], thr: number): Face[] {
  const keep: Face[] = [];
  for (const f of [...faces].sort((a, b) => b.score - a.score)) if (keep.every((k) => iou(k, f) < thr)) keep.push(f);
  return keep;
}

/** 超過這麼久沒偵測到 → 當成跟丟了（中間不內插，之後重新挑最大的那張） */
export const MAX_GAP = 1;

/**
 * 挑出要跟的那張臉：一開始挑最大的；之後每次取樣選跟上一個位置最接近的（重疊最多、或中心最近）。
 * 跟丟超過 MAX_GAP 秒就重新挑最大的。
 */
export function pickTrack(samples: FaceSample[]): TrackPoint[] {
  const sorted = [...samples].sort((a, b) => a.t - b.t);
  const out: TrackPoint[] = [];
  let prev: TrackPoint | null = null;
  for (const s of sorted) {
    if (!s.faces.length) continue;
    if (prev && s.t - prev.t > MAX_GAP) prev = null;
    let best: Face;
    if (!prev) best = s.faces.reduce((a, b) => (b.w * b.h > a.w * a.h ? b : a));
    else {
      const p = prev;
      const cost = (f: Face) => -iou(p, f) * 4 + Math.hypot(f.x - p.x, f.y - p.y) / Math.max(0.05, p.w);
      best = s.faces.reduce((a, b) => (cost(b) < cost(a) ? b : a));
      // 離太遠（超過兩個臉寬）就不是同一個人：這次當成沒偵測到
      if (Math.hypot(best.x - p.x, best.y - p.y) > Math.max(p.w, p.h) * 2.5 && iou(p, best) === 0) continue;
    }
    prev = { t: s.t, x: best.x, y: best.y, w: best.w, h: best.h };
    out.push(prev);
  }
  return out;
}

/** 平滑：時間上的高斯加權平均（整段已經算好，不用即時濾波，所以不會延遲）；跟丟的前後不混在一起 */
export function smoothTrack(pts: TrackPoint[], sigma = 0.12): TrackPoint[] {
  const out: TrackPoint[] = [];
  let seg = 0;
  const segOf: number[] = pts.map((p, i) => (i > 0 && p.t - pts[i - 1].t > MAX_GAP ? ++seg : seg));
  for (let i = 0; i < pts.length; i++) {
    let sw = 0, x = 0, y = 0, w = 0, h = 0;
    for (let j = i; j >= 0 && segOf[j] === segOf[i] && pts[i].t - pts[j].t <= sigma * 3; j--) acc(j);
    for (let j = i + 1; j < pts.length && segOf[j] === segOf[i] && pts[j].t - pts[i].t <= sigma * 3; j++) acc(j);
    out.push({ t: pts[i].t, x: x / sw, y: y / sw, w: w / sw, h: h / sw });
    function acc(j: number) {
      const d = (pts[j].t - pts[i].t) / sigma;
      const k = Math.exp(-0.5 * d * d);
      sw += k;
      x += pts[j].x * k;
      y += pts[j].y * k;
      w += pts[j].w * k;
      h += pts[j].h * k;
    }
  }
  return out;
}

/** 時間 t 的臉（前後兩點內插；離最近的點超過半個 MAX_GAP、或兩點中間跟丟了 → null） */
export function trackAt(track: TrackPoint[], t: number): TrackPoint | null {
  if (!track.length) return null;
  let lo = 0, hi = track.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (track[mid].t <= t) lo = mid + 1;
    else hi = mid;
  }
  const a = track[lo - 1], b = track[lo];
  const near = MAX_GAP / 2;
  if (a && b && b.t - a.t <= MAX_GAP) {
    const k = (t - a.t) / (b.t - a.t || 1);
    return { t, x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, w: a.w + (b.w - a.w) * k, h: a.h + (b.h - a.h) * k };
  }
  const n = a && t - a.t <= near ? a : b && b.t - t <= near ? b : null;
  return n ? { ...n, t } : null;
}
