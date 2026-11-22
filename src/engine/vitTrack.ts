/**
 * VitTrack（OpenCV Zoo object_tracking_vittrack_2023sep，Apache 2.0）的前 / 後處理，照 OpenCV `TrackerVit`：
 * - 初始化：以框為中心、邊長 ceil(sqrt(w × h) × 2) 的正方形裁切（超出畫面補黑）→ 128² 當模板（之後不更新）。
 * - 每一格：以上一格的框為中心、× 4 裁切 → 256²；輸出 16 × 16 的分數圖（乘上 Hann 窗）、大小、偏移。
 * - 正規化：(像素 − mean × 255) / (std × 255)，通道順序 BGR（OpenCV 讀進來的順序，第 0 個通道配 0.485 / 0.229）。
 * 座標是像素（畫面 w × h），框 = 左上 x, y + 寬高。
 */

export interface PxBox { x: number; y: number; w: number; h: number }

export const TEMPLATE = 128;
export const SEARCH = 256;
const MAP = 16;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
/** OpenCV 的預設門檻（過濾全黑的畫面）；低於這個 = 這一格追丟，框不動 */
export const SCORE_THR = 0.2;

/** 正方形裁切的邊長與左上角（跟 OpenCV crop_image 一樣以框中心為中心） */
export function cropRegion(b: PxBox, factor: number) {
  const size = Math.ceil(Math.sqrt(Math.max(1, b.w * b.h)) * factor);
  return { size, x0: b.x + (b.w - size) / 2, y0: b.y + (b.h - size) / 2 };
}

/** 裁切 + 雙線性縮放到 out × out + 正規化（NCHW、BGR）；超出畫面的部分當成黑色 */
export function cropBlob(rgba: ArrayLike<number>, W: number, H: number, b: PxBox, factor: number, out: number): { blob: Float32Array; size: number } {
  const { size, x0, y0 } = cropRegion(b, factor);
  const n = out * out;
  const blob = new Float32Array(3 * n);
  const k = size / out;
  const px = (x: number, y: number, c: number) => (x < 0 || y < 0 || x >= W || y >= H ? 0 : rgba[(y * W + x) * 4 + c]);
  for (let j = 0; j < out; j++) {
    const sy = y0 + (j + 0.5) * k - 0.5;
    const yi = Math.floor(sy), fy = sy - yi;
    for (let i = 0; i < out; i++) {
      const sx = x0 + (i + 0.5) * k - 0.5;
      const xi = Math.floor(sx), fx = sx - xi;
      const o = j * out + i;
      for (let ch = 0; ch < 3; ch++) {
        const c = 2 - ch; // BGR
        const v =
          (px(xi, yi, c) * (1 - fx) + px(xi + 1, yi, c) * fx) * (1 - fy) +
          (px(xi, yi + 1, c) * (1 - fx) + px(xi + 1, yi + 1, c) * fx) * fy;
        blob[ch * n + o] = (v - MEAN[ch] * 255) / (STD[ch] * 255);
      }
    }
  }
  return { blob, size };
}

/** 16 × 16 的 Hann 窗（OpenCV hann2d，centered） */
export const HANN: Float32Array = (() => {
  const w = Array.from({ length: MAP }, (_, i) => 0.5 * (1 - Math.cos(((2 * Math.PI) / (MAP + 1)) * (i + 1))));
  const out = new Float32Array(MAP * MAP);
  for (let r = 0; r < MAP; r++) for (let c = 0; c < MAP; c++) out[r * MAP + c] = w[r] * w[c];
  return out;
})();

/**
 * 模型輸出 → 新的框（畫面像素）與分數。prev = 這次搜尋用的框（上一格的結果），size = 搜尋裁切的邊長。
 * conf = output1 (1×1×16×16)、sizeMap = output2 (1×2×16×16)、offset = output3 (1×2×16×16)。
 */
export function decodeVit(conf: ArrayLike<number>, sizeMap: ArrayLike<number>, offset: ArrayLike<number>, prev: PxBox, size: number, W: number, H: number): { box: PxBox; score: number } {
  const N = MAP * MAP;
  let best = 0, score = -Infinity;
  for (let i = 0; i < N; i++) {
    const v = conf[i] * HANN[i];
    if (v > score) (score = v), (best = i);
  }
  const r = Math.floor(best / MAP), c = best % MAP;
  const cx = (c + offset[best]) / MAP, cy = (r + offset[N + best]) / MAP;
  const w = sizeMap[best], h = sizeMap[N + best];
  const { x0, y0 } = cropRegion(prev, 4);
  const box = clipBox({ x: (cx - w / 2) * size + x0, y: (cy - h / 2) * size + y0, w: w * size, h: h * size }, W, H, 10);
  return { box, score };
}

/** 框限制在畫面裡（至少 margin 像素寬高，OpenCV clipRect） */
export function clipBox(b: PxBox, W: number, H: number, margin: number): PxBox {
  const mx = Math.min(margin, W), my = Math.min(margin, H);
  const x1 = Math.min(Math.max(0, b.x), W - mx), y1 = Math.min(Math.max(0, b.y), H - my);
  const x2 = Math.min(Math.max(mx, b.x + b.w), W), y2 = Math.min(Math.max(my, b.y + b.h), H);
  return { x: x1, y: y1, w: Math.max(mx, x2 - x1), h: Math.max(my, y2 - y1) };
}

/** 素材畫面 0..1 的中心 + 寬高 ↔ 像素框 */
export const toPx = (b: readonly [number, number, number, number], W: number, H: number): PxBox => ({ x: (b[0] - b[2] / 2) * W, y: (b[1] - b[3] / 2) * H, w: b[2] * W, h: b[3] * H });
export const fromPx = (b: PxBox, W: number, H: number): [number, number, number, number] => [(b.x + b.w / 2) / W, (b.y + b.h / 2) / H, b.w / W, b.h / H];
