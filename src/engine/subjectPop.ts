export type PopVariant = 'step' | 'mono' | 'fly' | 'shake';
export const POP_VARIANTS: PopVariant[] = ['step', 'mono', 'fly', 'shake'];

/** 遮罩摘要，座標以原圖為準。 */
export interface MatteScore {
  area: number;
  bbox: [number, number, number, number];
  cu: number; cv: number;
  edge: number;
}

export function scoreMatte(mask: ArrayLike<number>, size: number): MatteScore {
  if (size <= 0 || !Number.isFinite(size)) return { area: 0, bbox: [0, 0, 0, 0], cu: 0.5, cv: 0.5, edge: 0 };
  let count = 0, edgeCount = 0, edgeTotal = 0, sumX = 0, sumY = 0;
  let minX = size, minY = size, maxX = -1, maxY = -1;
  const band = size * 0.03;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const edge = x < band || y < band || x >= size - band || y >= size - band;
    if (edge) edgeTotal++;
    if ((mask[y * size + x] ?? 0) <= 128) continue;
    count++; sumX += x + 0.5; sumY += y + 0.5;
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    if (edge) edgeCount++;
  }
  return {
    area: count / (size * size),
    bbox: count ? [minX / size, minY / size, (maxX + 1) / size, (maxY + 1) / size] : [0, 0, 0, 0],
    cu: count ? sumX / count / size : 0.5,
    cv: count ? sumY / count / size : 0.5,
    edge: edgeTotal ? edgeCount / edgeTotal : 0,
  };
}

/** cover 後主體在畫面上的位置及可用性。 */
export function popFraming(score: MatteScore, mediaW: number, mediaH: number, frameW: number, frameH: number):
  { ok: boolean; centered: boolean; cx: number; cy: number; area: number } {
  if (Math.min(mediaW, mediaH, frameW, frameH) <= 0) return { ok: false, centered: false, cx: 0, cy: 0, area: 0 };
  const k = Math.max(frameW / mediaW, frameH / mediaH);
  const sx = mediaW * k / frameW, sy = mediaH * k / frameH;
  const cx = (score.cu - 0.5) * sx, cy = (score.cv - 0.5) * sy;
  const [u0, v0, u1, v1] = score.bbox;
  const inFrame = (u0 - 0.5) * sx >= -0.46 && (u1 - 0.5) * sx <= 0.46 &&
    (v0 - 0.5) * sy >= -0.46 && (v1 - 0.5) * sy <= 0.46;
  const area = score.area * sx * sy;
  const centered = Math.abs(cx) <= 0.3 && Math.abs(cy) <= 0.3;
  return { ok: area >= 0.08 && area <= 0.65 && inFrame && score.edge < 0.02, centered, cx, cy, area };
}

export interface PlanPop {
  b0: number; b1: number; variant: PopVariant; mediaId: string;
  cx: number; cy: number; side?: -1 | 1;
}
type PopEase = 'hold' | 'linear' | 'out' | 'back';
type PopKey = { t: number; v: number; ease: PopEase };
export interface PopLayer {
  layer: number; mediaId: string; t0: number; t1: number; matte: boolean;
  keys?: Partial<Record<'x' | 'y' | 'scaleX' | 'scaleY' | 'rotation' | 'opacity', PopKey[]>>;
  effects?: { moduleId: string; params: Record<string, number | boolean | string>; beatEvery?: 1 | 2; hitSec?: number }[];
}

/** 將一個跳出計畫展開為疊加片段。 */
export function expandPop(pop: PlanPop, T: (beat: number) => number): PopLayer[] {
  const t0 = T(pop.b0), t1 = T(pop.b1), end = t1 - t0;
  const layer = (index: number, matte: boolean): PopLayer => ({ layer: index, mediaId: pop.mediaId, t0, t1, matte });
  const steps = (values: number[]) => {
    const times = values.map((_, i) => T(pop.b0 + i) - t0).concat(end);
    const vals = values.concat(values.at(-1)!);
    const key = (v: number, i: number): PopKey => ({ t: times[i], v, ease: 'hold' });
    return {
      scaleX: vals.map(key), scaleY: vals.map(key),
      x: vals.map((v, i) => key(pop.cx * (1 - v), i)),
      y: vals.map((v, i) => key(pop.cy * (1 - v), i)),
    };
  };
  if (pop.variant === 'mono') {
    const full = layer(1, false);
    full.effects = [{ moduleId: 'fx-bw', params: { contrast: 1.4, amount: 1, decay: 0 } }];
    const cutout = layer(2, true);
    cutout.keys = steps([0.92, 0.95, 0.98, 1]);
    return [full, cutout];
  }
  const cutout = layer(1, true);
  if (pop.variant === 'fly') {
    const side = pop.side ?? -1;
    const beat = T(pop.b0 + 1) - t0;
    // 位移 0、縮放 1 = 跟完整圖對齊（主體在原本的位置），所以飛到 0 停住
    cutout.keys = {
      x: [{ t: 0, v: side * 1.1, ease: 'back' }, { t: beat, v: 0, ease: 'hold' }, { t: end, v: 0, ease: 'hold' }],
      rotation: [{ t: 0, v: side * 12, ease: 'out' }, { t: beat, v: 0, ease: 'hold' }, { t: end, v: 0, ease: 'hold' }],
      scaleX: [{ t: 0, v: 0.8, ease: 'out' }, { t: beat, v: 1, ease: 'hold' }, { t: end, v: 1, ease: 'hold' }],
      scaleY: [{ t: 0, v: 0.8, ease: 'out' }, { t: beat, v: 1, ease: 'hold' }, { t: end, v: 1, ease: 'hold' }],
      opacity: [{ t: 0, v: 0, ease: 'linear' }, { t: beat / 3, v: 1, ease: 'hold' }, { t: end, v: 1, ease: 'hold' }],
    };
  } else {
    cutout.keys = steps([0.55, 0.7, 0.85, 1]);
    if (pop.variant === 'shake') {
      const hitSec = Math.min(0.18, (T(pop.b0 + 1) - t0) * 0.8);
      cutout.effects = [
        { moduleId: 'fx-shake', params: { strength: 0.03, rotation: 0.04, freq: 30, decay: 3 }, beatEvery: 1, hitSec },
        { moduleId: 'fx-flash', params: { intensity: 0.5, decay: 4 }, beatEvery: 1, hitSec },
      ];
    }
  }
  return [cutout];
}
