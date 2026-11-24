export type PopVariant = 'step' | 'mono' | 'fly' | 'shake'
  | 'crossShot' | 'textBehind' | 'trail' | 'grid' | 'spin' | 'dim' | 'halo' | 'blur'
  | 'silhouetteWindow' | 'subjectHole';
export const POP_VARIANTS: PopVariant[] = ['step', 'mono', 'fly', 'shake',
  'crossShot', 'textBehind', 'trail', 'grid', 'spin', 'dim', 'halo', 'blur',
  'silhouetteWindow', 'subjectHole'];

type Point = [number, number];

/** 去背遮罩 → SVG 路徑（200×200 座標，evenodd）：每一塊主體的外框與裡面的洞各一條封閉路徑。
 * 太小的碎片（< minArea 比例）略過；用 Douglas–Peucker 簡化（tolerance：遮罩像素）。 */
export function traceMatte(mask: ArrayLike<number>, size: number,
  opts?: { threshold?: number; tolerance?: number; minArea?: number }): string {
  if (!Number.isInteger(size) || size <= 0 || mask.length < size * size) return '';
  const threshold = opts?.threshold ?? 128;
  const tolerance = Math.max(0, opts?.tolerance ?? 1.2);
  const minArea = Math.max(0, opts?.minArea ?? 0.002) * size * size;
  const filled = (x: number, y: number) => x >= 0 && x < size && y >= 0 && y < size &&
    (mask[y * size + x] ?? 0) > threshold;
  const stride = size + 1;
  const starts: number[] = [], ends: number[] = [], dirs: number[] = [];
  const outgoing = new Map<number, number[]>();
  const edge = (x0: number, y0: number, x1: number, y1: number, dir: number) => {
    const a = y0 * stride + x0, b = y1 * stride + x1, i = starts.length;
    starts.push(a); ends.push(b); dirs.push(dir);
    const list = outgoing.get(a);
    if (list) list.push(i); else outgoing.set(a, [i]);
  };
  // 沿二值遮罩的像素邊界追蹤等值線，前景固定在行進方向右側。
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (!filled(x, y)) continue;
    if (!filled(x, y - 1)) edge(x, y, x + 1, y, 0);
    if (!filled(x + 1, y)) edge(x + 1, y, x + 1, y + 1, 1);
    if (!filled(x, y + 1)) edge(x + 1, y + 1, x, y + 1, 2);
    if (!filled(x - 1, y)) edge(x, y + 1, x, y, 3);
  }
  const point = (id: number): Point => [id % stride, Math.floor(id / stride)];
  const dist2 = (p: Point, a: Point, b: Point) => {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const t = dx || dy ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy))) : 0;
    return (p[0] - a[0] - t * dx) ** 2 + (p[1] - a[1] - t * dy) ** 2;
  };
  const simplifyOpen = (pts: Point[]): Point[] => {
    const keep = new Uint8Array(pts.length);
    keep[0] = keep[pts.length - 1] = 1;
    const stack: [number, number][] = [[0, pts.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop()!;
      let far = -1, max = tolerance * tolerance;
      for (let i = a + 1; i < b; i++) {
        const d = dist2(pts[i], pts[a], pts[b]);
        if (d > max) { max = d; far = i; }
      }
      if (far >= 0) { keep[far] = 1; stack.push([a, far], [far, b]); }
    }
    return pts.filter((_, i) => keep[i]);
  };
  const visited = new Uint8Array(starts.length);
  const contours: string[] = [];
  for (let first = 0; first < starts.length; first++) {
    if (visited[first]) continue;
    const vertices: number[] = [starts[first]];
    let current = first;
    while (!visited[current]) {
      visited[current] = 1;
      const next = ends[current];
      vertices.push(next);
      if (next === starts[first]) break;
      const choices = (outgoing.get(next) ?? []).filter((i) => !visited[i]);
      if (!choices.length) break;
      // 斜角相接時先右轉，讓兩塊主體保持獨立輪廓。
      choices.sort((a, b) => ((dirs[a] - dirs[current] + 4) % 4 - 1 + 4) % 4 -
        (((dirs[b] - dirs[current] + 4) % 4 - 1 + 4) % 4));
      current = choices[0];
    }
    if (vertices.at(-1) !== vertices[0] || vertices.length < 5) continue;
    const pts = vertices.slice(0, -1).map(point);
    const area = Math.abs(pts.reduce((sum, p, i) => {
      const q = pts[(i + 1) % pts.length];
      return sum + p[0] * q[1] - q[0] * p[1];
    }, 0)) / 2;
    if (area < minArea) continue;
    let opposite = 1, farthest = -1;
    for (let i = 1; i < pts.length; i++) {
      const d = (pts[i][0] - pts[0][0]) ** 2 + (pts[i][1] - pts[0][1]) ** 2;
      if (d > farthest) { farthest = d; opposite = i; }
    }
    const reduced = [...simplifyOpen(pts.slice(0, opposite + 1)),
      ...simplifyOpen([...pts.slice(opposite), pts[0]]).slice(1, -1)];
    if (reduced.length < 3) continue;
    const coord = (v: number) => Number((v * 200 / size).toFixed(2));
    contours.push(`M${reduced.map(([x, y]) => `${coord(x)} ${coord(y)}`).join('L')}Z`);
  }
  return contours.join('');
}

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
  revealMediaId?: string; text?: string; path?: string;
}
type PopEase = 'hold' | 'linear' | 'out' | 'back';
type PopKey = { t: number; v: number; ease: PopEase };
export interface PopLayer {
  layer: number; mediaId: string; t0: number; t1: number; matte: boolean;
  keys?: Partial<Record<'x' | 'y' | 'scaleX' | 'scaleY' | 'rotation' | 'opacity', PopKey[]>>;
  effects?: { moduleId: string; params: Record<string, number | boolean | string>; beatEvery?: 1 | 2; hitSec?: number }[];
  /** 片段自己的遮罩（fx-clipmask base）：path 為 A 的輪廓；scale 由套用端換成以主體中心縮放的 mask.x/y/w/h 關鍵影格。 */
  mask?: { path: string; invert: boolean; scale: PopKey[] };
  /** 文字層由套用端建立，mediaId 不使用。 */
  text?: string;
  blend?: 'normal' | 'add' | 'screen' | 'multiply' | 'subtract' | 'lighten';
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
  const key = (t: number, v: number, ease: PopEase = 'hold'): PopKey => ({ t, v, ease });
  const aligned = () => ({
    scaleX: [key(0, 1), key(end, 1)], scaleY: [key(0, 1), key(end, 1)],
    x: [key(0, 0), key(end, 0)], y: [key(0, 0), key(end, 0)],
    rotation: [key(0, 0), key(end, 0)], opacity: [key(0, 1), key(end, 1)],
  });
  const finalAlignment = (keys: NonNullable<PopLayer['keys']>) => {
    keys.rotation = [key(0, 0), key(end, 0)];
    keys.opacity ??= [key(0, 1), key(end, 1)];
    return keys;
  };
  if (pop.variant === 'silhouetteWindow' || pop.variant === 'subjectHole') {
    const full = layer(1, false);
    const masked = layer(2, false);
    if (pop.variant === 'silhouetteWindow') masked.mediaId = pop.revealMediaId ?? pop.mediaId;
    else full.mediaId = pop.revealMediaId ?? pop.mediaId;
    masked.mask = { path: pop.path ?? '', invert: pop.variant === 'subjectHole',
      scale: [1, ...(pop.variant === 'silhouetteWindow' ? [1.25, 1.6, 2.2] : [1.3, 1.8, 2.6])]
        .map((v, i) => key(T(pop.b0 + i) - t0, v)).concat(key(end,
          pop.variant === 'silhouetteWindow' ? 2.2 : 2.6)) };
    return [full, masked];
  }
  if (pop.variant === 'crossShot') {
    const full = layer(1, false);
    full.mediaId = pop.revealMediaId ?? pop.mediaId;
    const subject = layer(2, true);
    subject.keys = finalAlignment(steps([0.8, 0.86, 0.93, 1]));
    subject.keys.opacity = [key(0, 0, 'linear'), key((T(pop.b0 + 1) - t0) / 2, 1), key(end, 1)];
    return [full, subject];
  }
  if (pop.variant === 'textBehind') {
    const full = layer(1, false);
    const words = layer(2, false);
    words.text = pop.text;
    words.keys = { opacity: [key(0, 0, 'linear'), key(T(pop.b0 + 1) - t0, 1), key(end, 1)] };
    const subject = layer(3, true);
    subject.keys = aligned();
    return [full, words, subject];
  }
  if (pop.variant === 'trail') {
    return [1, 2, 3].map((n) => {
      const copy = layer(n, true);
      copy.t0 = T(pop.b0 + n);
      const scale = 0.7 + 0.1 * n;
      const copyEnd = copy.t1 - copy.t0;
      const opacity = [0.35, 0.6, 1][n - 1];
      copy.keys = {
        scaleX: [key(0, scale), key(copyEnd, n === 3 ? 1 : scale)],
        scaleY: [key(0, scale), key(copyEnd, n === 3 ? 1 : scale)],
        x: [key(0, pop.cx * (1 - scale)), key(copyEnd, n === 3 ? 0 : pop.cx * (1 - scale))],
        y: [key(0, pop.cy * (1 - scale)), key(copyEnd, n === 3 ? 0 : pop.cy * (1 - scale))],
        rotation: [key(0, 0), key(copyEnd, 0)],
        opacity: n === 3 ? [key(0, 1), key(copyEnd, 1)] :
          [key(0, opacity), key(copyEnd - (t1 - T(pop.b1 - 1)) / 2, opacity, 'linear'), key(copyEnd, 0)],
      };
      if (n < 3) copy.blend = 'screen';
      return copy;
    });
  }
  if (pop.variant === 'grid') {
    const corners: [number, number][] = [[-0.25, -0.25], [0.25, -0.25], [-0.25, 0.25], [0.25, 0.25]];
    const copies = corners.map(([x, y], i) => {
      const copy = layer(i + 1, true);
      const appear = T(pop.b0 + i) - t0;
      const fade = end - (t1 - T(pop.b1 - 1)) / 2;
      copy.keys = {
        scaleX: [key(0, 0.45), key(end, 0.45)], scaleY: [key(0, 0.45), key(end, 0.45)],
        // 縮小 0.45 後主體在 0.45·c + 位移：要讓主體落在角落，位移 = 角落 − 0.45·c
        x: [key(0, x - pop.cx * 0.45), key(end, x - pop.cx * 0.45)],
        y: [key(0, y - pop.cy * 0.45), key(end, y - pop.cy * 0.45)],
        rotation: [key(0, 0), key(end, 0)],
        opacity: [key(0, i === 0 ? 1 : 0), key(appear, 1), key(fade, 1, 'linear'), key(end, 0)],
      };
      return copy;
    });
    const centre = layer(5, true);
    centre.t0 = T(pop.b1 - 1);
    const centreEnd = centre.t1 - centre.t0;
    centre.keys = { scaleX: [key(0, 1), key(centreEnd, 1)], scaleY: [key(0, 1), key(centreEnd, 1)],
      x: [key(0, 0), key(centreEnd, 0)], y: [key(0, 0), key(centreEnd, 0)],
      rotation: [key(0, 0), key(centreEnd, 0)], opacity: [key(0, 1), key(centreEnd, 1)] };
    return [...copies, centre];
  }
  if (pop.variant === 'spin') {
    return [-15, 15, 0].map((angle, i) => {
      const copy = layer(i + 1, true);
      copy.keys = finalAlignment(steps([0.85, 0.9, 0.95, 1]));
      copy.keys.rotation = [key(0, angle), key(end, 0)];
      if (i < 2) {
        const fade = end - (t1 - T(pop.b1 - 1)) / 2;
        copy.keys.opacity = [key(0, 0.5), key(fade, 0.5, 'linear'), key(end, 0)];
      }
      return copy;
    });
  }
  if (pop.variant === 'dim' || pop.variant === 'blur') {
    const full = layer(1, false);
    full.effects = pop.variant === 'dim'
      ? [{ moduleId: 'fx-grade', params: { contrast: 0.8, saturation: 0.25, vignette: 0.9 } }]
      : [{ moduleId: 'fx-blur', params: { amount: 14 } }];
    const subject = layer(2, true);
    subject.keys = finalAlignment(steps([0.9, 0.93, 0.97, 1]));
    return [full, subject];
  }
  if (pop.variant === 'halo') {
    const subject = layer(1, true);
    subject.keys = finalAlignment(steps([0.7, 0.8, 0.9, 1]));
    subject.effects = [{ moduleId: 'fx-matteoutline',
      params: { width: 14, glow: 1.3, intensity: 1.2, pulse: true }, beatEvery: 1,
      hitSec: 0.8 * (T(pop.b0 + 1) - t0) }];
    return [subject];
  }
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
