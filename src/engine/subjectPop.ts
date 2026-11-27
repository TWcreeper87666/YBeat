export type PopVariant = 'step' | 'mono' | 'fly' | 'shake'
  | 'crossShot' | 'textBehind' | 'trail' | 'grid' | 'spin' | 'dim' | 'halo' | 'blur'
  | 'silhouetteWindow' | 'subjectHole';
export const POP_VARIANTS: PopVariant[] = ['step', 'mono', 'fly', 'shake',
  'crossShot', 'textBehind', 'trail', 'grid', 'spin', 'dim', 'halo', 'blur',
  'silhouetteWindow', 'subjectHole'];

type Point = [number, number];

/** 人的那一塊：至少要有幾張臉那麼大；往臉下面延伸至少幾個臉高，或一路連到畫面下緣（上半身被畫面切掉也算） */
const BODY_AREA = 2;
const BODY_BELOW = 0.5;

/**
 * 去背遮罩只留這張臉所在的那一塊（頭連著身體）：去背模型找的是「顯眼的東西」，背景的樹、招牌也會被框進來。
 * face = 原圖座標的臉（中心 + 寬高，0..1）。回傳 null = 臉的位置沒有主體，或只有一顆頭（身體被擋住、沒去背到）。
 */
export function keepFace(mask: ArrayLike<number>, size: number, face: { x: number; y: number; h: number; w?: number }): Uint8Array | null {
  const fw = face.w ?? face.h;
  const on = (i: number) => (mask[i] ?? 0) > 128;
  const x0 = Math.max(0, Math.floor((face.x - fw * 0.6) * size)), x1 = Math.min(size - 1, Math.ceil((face.x + fw * 0.6) * size));
  const y0 = Math.max(0, Math.floor((face.y - face.h * 0.6) * size)), y1 = Math.min(size - 1, Math.ceil((face.y + face.h * 0.6) * size));
  const out = new Uint8Array(size * size);
  const stack: number[] = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const i = y * size + x;
    if (on(i) && !out[i]) { out[i] = 255; stack.push(i); }
  }
  if (!stack.length) return null;
  let count = 0, maxY = 0;
  while (stack.length) {
    const i = stack.pop()!;
    count++;
    const x = i % size, y = (i - x) / size;
    if (y > maxY) maxY = y;
    for (const j of [x > 0 ? i - 1 : -1, x < size - 1 ? i + 1 : -1, y > 0 ? i - size : -1, y < size - 1 ? i + size : -1])
      if (j >= 0 && !out[j] && on(j)) { out[j] = 255; stack.push(j); }
  }
  const faceArea = fw * face.h * size * size;
  const below = maxY / size - (face.y + face.h / 2);
  const body = maxY >= size - 2 || below >= face.h * BODY_BELOW;
  return count >= faceArea * BODY_AREA && body ? out : null;
}

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

/** 剪影窗 / 主體挖洞能用的主體大小（佔原圖的比例；裁到畫面外的部分不影響） */
export const LOOSE_MIN = 0.03, LOOSE_MAX = 0.75;

/** cover 後主體在畫面上的位置及可用性。 */
export function popFraming(score: MatteScore, mediaW: number, mediaH: number, frameW: number, frameH: number):
  { ok: boolean; loose: boolean; centered: boolean; cx: number; cy: number; area: number } {
  if (Math.min(mediaW, mediaH, frameW, frameH) <= 0) return { ok: false, loose: false, centered: false, cx: 0, cy: 0, area: 0 };
  const k = Math.max(frameW / mediaW, frameH / mediaH);
  const sx = mediaW * k / frameW, sy = mediaH * k / frameH;
  const cx = (score.cu - 0.5) * sx, cy = (score.cv - 0.5) * sy;
  const [u0, v0, u1, v1] = score.bbox;
  const inFrame = (u0 - 0.5) * sx >= -0.46 && (u1 - 0.5) * sx <= 0.46 &&
    (v0 - 0.5) * sy >= -0.46 && (v1 - 0.5) * sy <= 0.46;
  const area = score.area * sx * sy;
  const centered = Math.abs(cx) <= 0.3 && Math.abs(cy) <= 0.3;
  const sized = area >= 0.08 && area <= 0.65;
  const ok = sized && inFrame && score.edge < 0.02;
  // 剪影窗 / 主體挖洞從原尺寸往外放大：主體大、碰到邊（人像的身體、直式畫面裁掉的左右）都不會露出切口，只要大小合理
  const loose = ok || (score.area >= LOOSE_MIN && score.area <= LOOSE_MAX && Math.abs(cx) < 0.45 && Math.abs(cy) < 0.45);
  return { ok, loose, centered, cx, cy, area };
}

export interface PlanPop {
  b0: number; b1: number; variant: PopVariant; mediaId: string;
  cx: number; cy: number; side?: -1 | 1;
  revealMediaId?: string; text?: string;
  /** 主體輪廓（只留臉連著的那一塊）：剪影窗 / 主體挖洞的遮罩；逐拍放大 / 震閃用它把人以外的東西濾掉 */
  path?: string;
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

/** 剪影窗 / 主體挖洞：第 2～4 拍的遮罩倍率（第 1 拍 = 原尺寸） */
const MASK_GROW = { silhouetteWindow: [1.1, 1.2, 1.35], subjectHole: [1.15, 1.35, 1.6] };

/** 將一個跳出計畫展開為疊加片段；有主體輪廓時，去背層再加上輪廓遮罩（只留這個人） */
export function expandPop(pop: PlanPop, T: (beat: number) => number): PopLayer[] {
  const layers = expandLayers(pop, T);
  return pop.path && pop.variant !== 'silhouetteWindow' && pop.variant !== 'subjectHole' ? layers.map((l) => withOutline(l, pop)) : layers;
}

/**
 * 去背層加上主體輪廓遮罩：AI 去背會連背景顯眼的東西（樹、招牌）一起留下，輪廓只有臉連著的那一塊。
 * 遮罩的位置是畫面座標，只對得上「以主體中心縮放」的層（位移 = cx·(1 − 縮放)、不旋轉）；飛入、旋轉、四格這類跳過。
 */
function withOutline(l: PopLayer, pop: PlanPop): PopLayer {
  if (!l.matte || l.mask || l.mediaId !== pop.mediaId) return l;
  const k = l.keys ?? {};
  if (k.rotation?.some((x) => Math.abs(x.v) > 1e-6)) return l;
  const sc = k.scaleX ?? [{ t: 0, v: 1, ease: 'hold' as const }];
  if (k.scaleY && k.scaleY.map((x) => x.v).join() !== sc.map((x) => x.v).join()) return l;
  const follows = (keys: PopKey[] | undefined, c: number) => keys
    ? keys.every((x) => { const s = sc.find((y) => Math.abs(y.t - x.t) < 1e-6)?.v; return s !== undefined && Math.abs(x.v - c * (1 - s)) < 1e-4; })
    : sc.every((s) => Math.abs(s.v - 1) < 1e-6);
  if (!follows(k.x, pop.cx) || !follows(k.y, pop.cy)) return l;
  return { ...l, mask: { path: pop.path!, invert: false, scale: sc } };
}

function expandLayers(pop: PlanPop, T: (beat: number) => number): PopLayer[] {
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
      // 每拍放大一點就好：放太大看不出人形
      scale: [1, ...MASK_GROW[pop.variant]].map((v, i) => key(T(pop.b0 + i) - t0, v)).concat(key(end, MASK_GROW[pop.variant].at(-1)!)) };
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
    // 從小放大到原尺寸：最後跟完整圖對齊，揭露拍那一格直接接下去
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
