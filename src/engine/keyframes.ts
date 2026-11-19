import { $t } from '../i18n';
/** 關鍵影格：每個屬性一串 key，區段之間用 cubic-bezier 緩動（跟 CSS / AE 一樣的概念） */

export type AnimProp = 'x' | 'y' | 'scale' | 'rotation' | 'opacity';
export type Bez = [number, number, number, number];
export type Ease = Bez | 'hold';
export interface Keyframe {
  id: string;
  /** 片段內時間（秒） */
  t: number;
  v: number;
  /** 從這個 key 到下一個 key 的緩動 */
  ease: Ease;
}
export type Keys = Partial<Record<AnimProp, Keyframe[]>>;

export const ANIM_PROPS: { prop: AnimProp; label: string; step: number; suffix?: string; min?: number; max?: number }[] = [
  { prop: 'scale', label: $t('縮放'), step: 0.01, min: 0 },
  { prop: 'x', label: $t('位置 X'), step: 0.005 },
  { prop: 'y', label: $t('位置 Y'), step: 0.005 },
  { prop: 'rotation', label: $t('旋轉'), step: 0.5, suffix: '°' },
  { prop: 'opacity', label: $t('不透明度'), step: 0.01, min: 0, max: 1 },
];

export const EASE_PRESETS: { id: string; label: string; ease: Ease }[] = [
  { id: 'linear', label: $t('線性'), ease: [0, 0, 1, 1] },
  { id: 'inOut', label: $t('緩入緩出'), ease: [0.42, 0, 0.58, 1] },
  { id: 'in', label: $t('漸快 (Ease In)'), ease: [0.42, 0, 1, 1] },
  { id: 'out', label: $t('漸慢 (Ease Out)'), ease: [0, 0, 0.58, 1] },
  { id: 'expoOut', label: $t('急停 (Expo Out)'), ease: [0.16, 1, 0.3, 1] },
  { id: 'expoIn', label: $t('急衝 (Expo In)'), ease: [0.7, 0, 0.84, 0] },
  { id: 'back', label: $t('過衝回彈 (Back)'), ease: [0.34, 1.56, 0.64, 1] },
  { id: 'hold', label: $t('定格 (Hold)'), ease: 'hold' },
];
export const DEFAULT_EASE: Ease = [0.42, 0, 0.58, 1];

export function easeId(e: Ease) {
  const p = EASE_PRESETS.find((x) => JSON.stringify(x.ease) === JSON.stringify(e));
  return p?.id ?? 'custom';
}

const kid = () => Math.random().toString(36).slice(2, 9);

/** cubic-bezier(x1,y1,x2,y2) 在 x 時的 y */
export function bezierY(b: Bez, x: number) {
  const [x1, y1, x2, y2] = b;
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bx = (t: number) => 3 * (1 - t) * (1 - t) * t * x1 + 3 * (1 - t) * t * t * x2 + t * t * t;
  const by = (t: number) => 3 * (1 - t) * (1 - t) * t * y1 + 3 * (1 - t) * t * t * y2 + t * t * t;
  // 二分法求 bx(t) = x（x1, x2 在 0..1 內時單調）
  let lo = 0, hi = 1, t = x;
  for (let i = 0; i < 24; i++) {
    const v = bx(t);
    if (Math.abs(v - x) < 1e-5) break;
    if (v < x) lo = t;
    else hi = t;
    t = (lo + hi) / 2;
  }
  return by(t);
}

export function evalKeys(keys: Keyframe[], t: number): number {
  const n = keys.length;
  if (t <= keys[0].t) return keys[0].v;
  if (t >= keys[n - 1].t) return keys[n - 1].v;
  let i = 0;
  while (i < n - 2 && keys[i + 1].t <= t) i++;
  const a = keys[i], b = keys[i + 1];
  if (a.ease === 'hold') return a.v;
  const u = (t - a.t) / Math.max(1e-6, b.t - a.t);
  return a.v + (b.v - a.v) * bezierY(a.ease, u);
}

export const sortKeys = (k: Keyframe[]) => [...k].sort((a, b) => a.t - b.t);

const EPS = 1 / 120;

/** 在 t 設定數值：已有 key 就改，沒有就插入 */
export function upsertKey(keys: Keyframe[], t: number, v: number): Keyframe[] {
  const hit = keys.find((k) => Math.abs(k.t - t) < EPS);
  if (hit) return keys.map((k) => (k === hit ? { ...k, v } : k));
  const prev = [...keys].reverse().find((k) => k.t < t);
  return sortKeys([...keys, { id: kid(), t, v, ease: prev?.ease ?? DEFAULT_EASE }]);
}

export const keyAt = (keys: Keyframe[] | undefined, t: number) => keys?.find((k) => Math.abs(k.t - t) < EPS);

/** 把關鍵影格在 local 切成兩段（分割片段用） */
export function splitKeys(keys: Keys, local: number): [Keys, Keys] {
  const a: Keys = {}, b: Keys = {};
  for (const [p, list] of Object.entries(keys) as [AnimProp, Keyframe[]][]) {
    if (!list?.length) continue;
    const v = evalKeys(list, local);
    const prev = [...list].reverse().find((k) => k.t <= local);
    a[p] = [...list.filter((k) => k.t < local - EPS), { id: kid(), t: local, v, ease: prev?.ease ?? DEFAULT_EASE }];
    b[p] = [{ id: kid(), t: 0, v, ease: prev?.ease ?? DEFAULT_EASE }, ...list.filter((k) => k.t > local + EPS).map((k) => ({ ...k, t: k.t - local }))];
  }
  return [a, b];
}

export const newKey = (t: number, v: number, ease: Ease = DEFAULT_EASE): Keyframe => ({ id: kid(), t, v, ease });

/** 時間縮放（變速時關鍵影格跟著伸縮） */
export function scaleKeyList(list: Keyframe[], s: number): Keyframe[] {
  return list.map((k) => ({ ...k, t: k.t * s }));
}
export function scaleKeyMap<K extends string>(keys: Partial<Record<K, Keyframe[]>> | undefined, s: number): Partial<Record<K, Keyframe[]>> {
  const out: Partial<Record<K, Keyframe[]>> = {};
  if (!keys) return out;
  for (const [k, list] of Object.entries(keys) as [K, Keyframe[]][]) if (list) out[k] = scaleKeyList(list, s);
  return out;
}
