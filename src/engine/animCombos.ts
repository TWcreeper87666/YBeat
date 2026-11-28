/**
 * 組合動畫範本（多人進場、甩鏡換畫…）：直接寫成動畫的圖層 + 關鍵影格（拍）。
 * 跟主體跳出（subjectPop）的範本分開：自動剪輯不會用到這些。
 * 座標：x / y = 畫面寬 / 高的比例（0 = 跟原圖對齊），縮放以畫面中心為準。
 */
import type { Keyframe, Keys } from './keyframes';
import type { AnimItem, AnimLayer, AnimSlot } from './animation';

export type ComboId = 'tripleSlide' | 'duoClash' | 'relay' | 'vFormation'
  | 'floorLaunch' | 'diagonalSnap' | 'shadowFirst' | 'zoomEcho' | 'monoBurst' | 'whipSwap' | 'bodyPortal';
export const COMBO_IDS: ComboId[] = ['tripleSlide', 'duoClash', 'relay', 'vFormation',
  'floorLaunch', 'diagonalSnap', 'shadowFirst', 'zoomEcho', 'monoBurst', 'whipSwap', 'bodyPortal'];
export const isCombo = (id: string | undefined): id is ComboId => !!id && (COMBO_IDS as string[]).includes(id);

type E = 'hold' | 'lin' | 'out' | 'fast' | 'back';
const EASE: Record<E, Keyframe['ease']> = {
  hold: 'hold', lin: [0, 0, 1, 1], out: [0, 0, 0.58, 1], fast: [0.16, 1, 0.3, 1], back: [0.34, 1.56, 0.64, 1],
};
/** [拍, 值, 這一格到下一格的緩動] */
type K = [number, number, E?];
type Fx = NonNullable<AnimLayer['effects']>[number];
interface L {
  id: string; slot: string; from: number; to: number;
  x?: K[]; y?: K[]; s?: K[]; r?: K[]; o?: K[];
  /** 固定值（沒有關鍵影格的屬性） */
  base?: { x?: number; y?: number; s?: number; r?: number; o?: number };
  blend?: AnimLayer['blend'];
  mask?: { slotId: string; layerId: string; mode: 'window' | 'hole'; scale: K[] };
  fx?: Omit<Fx, 'id'>[];
  /** 縮放以主體為中心（位移跟著縮放補回去，主體停在原位）；放的時候知道主體在哪才有用 */
  pivot?: true;
}

const keyList = (layer: string, prop: string, ks: K[]): Keyframe[] =>
  ks.map(([t, v, e], j) => ({ id: `${layer}-${prop}-${j}`, t, v, ease: EASE[e ?? 'hold'] }));

function toLayer(l: L, center?: { cx: number; cy: number }): AnimLayer {
  const keys: Keys = {};
  // 以主體為中心縮放：縮放 s 時位移 c·(1 − s)
  if (l.pivot && center && l.s && !l.x && !l.y) l = { ...l,
    x: l.s.map(([t, v, e]): K => [t, center.cx * (1 - v), e]),
    y: l.s.map(([t, v, e]): K => [t, center.cy * (1 - v), e]) };
  if (l.x) keys.x = keyList(l.id, 'x', l.x);
  if (l.y) keys.y = keyList(l.id, 'y', l.y);
  if (l.s) { keys.scaleX = keyList(l.id, 'scaleX', l.s); keys.scaleY = keyList(l.id, 'scaleY', l.s); }
  if (l.r) keys.rotation = keyList(l.id, 'rotation', l.r);
  if (l.o) keys.opacity = keyList(l.id, 'opacity', l.o);
  const b = l.base ?? {};
  const base: AnimLayer['base'] = {};
  if (b.x !== undefined) base.x = b.x;
  if (b.y !== undefined) base.y = b.y;
  if (b.s !== undefined) { base.scaleX = b.s; base.scaleY = b.s; }
  if (b.r !== undefined) base.rotation = b.r;
  if (b.o !== undefined) base.opacity = b.o;
  return {
    id: l.id, slotId: l.slot, fromBeat: l.from, toBeat: l.to, keys,
    ...(Object.keys(base).length ? { base } : {}),
    ...(l.blend ? { blend: l.blend } : {}),
    ...(l.mask ? { mask: { slotId: l.mask.slotId, layerId: l.mask.layerId, mode: l.mask.mode, scale: keyList(l.id, 'mask', l.mask.scale) } } : {}),
    ...(l.fx ? { effects: l.fx.map((f, i) => ({ ...f, id: `${l.id}-fx-${i}` })) } : {}),
  };
}

/** 縮小 s 倍時腳底留在畫面下緣的位移 */
const ground = (s: number) => (1 - s) / 2;
const OFF = 1.1;

type Def = { beats: number; slots: Omit<AnimSlot, 'mediaId' | 'sourceTime'>[]; layers: L[] };
const bg = { id: 'background', role: 'background' as const, label: 'Background' };
const reveal = { id: 'reveal', role: 'reveal' as const, label: 'Reveal' };
const subj = (id = 'subject') => ({ id, role: 'subject' as const, label: 'Subject', cutout: { mode: 'auto' as const } });
const copy = (id: string) => ({ id, role: 'copy' as const, label: 'Copy', cutout: { mode: 'auto' as const } });
const bgLayer = (to: number, fx?: L['fx']): L => ({ id: 'bg', slot: 'background', from: 0, to, fx });

const DEFS: Record<ComboId, () => Def> = {
  // 三個人一拍一個從左邊滑進來（先快後慢），排成一排
  tripleSlide: () => ({
    beats: 4,
    slots: [bg, subj('p1'), subj('p2'), subj('p3')],
    layers: [bgLayer(4), ...[-0.3, 0, 0.3].map((p, i): L => ({
      id: `p${i + 1}`, slot: `p${i + 1}`, from: i, to: 4,
      x: [[i, -OFF, 'fast'], [i + 0.7, p]], base: { s: 0.55, y: ground(0.55) },
    }))],
  }),
  // 兩個人從左右衝到中間，撞上的那一下震動 + 閃光
  duoClash: () => {
    const hit = 0.8;
    const side = (n: 1 | 2, dir: -1 | 1): L[] => [
      { id: `p${n}`, slot: `p${n}`, from: 0, to: hit, x: [[0, dir * OFF, 'fast'], [hit, dir * 0.2]], base: { s: 0.75, y: ground(0.75) } },
      { id: `p${n}-hit`, slot: `p${n}`, from: hit, to: 2, base: { x: dir * 0.2, s: 0.75, y: ground(0.75) },
        fx: [{ moduleId: 'fx-shake', params: { strength: 0.025, rotation: 0.02, freq: 30, decay: 4 }, beatEvery: 2, hitBeats: 0.4 }] },
    ];
    return {
      beats: 2,
      slots: [bg, subj('p1'), subj('p2')],
      layers: [
        bgLayer(hit),
        { id: 'bg-hit', slot: 'background', from: hit, to: 2, fx: [{ moduleId: 'fx-flash', params: { intensity: 0.6, decay: 5 }, beatEvery: 2, hitBeats: 0.3 }] },
        ...side(1, -1), ...side(2, 1),
      ],
    };
  },
  // 每拍換一個人：下一個從左邊把上一個推出去
  relay: () => {
    const s = { s: 0.9, y: ground(0.9) };
    return {
      beats: 4,
      slots: [bg, subj('p1'), subj('p2'), subj('p3')],
      layers: [
        bgLayer(4),
        { id: 'p1', slot: 'p1', from: 0, to: 1.4, x: [[0, 0], [1, 0, 'fast'], [1.4, OFF]], base: s },
        { id: 'p2', slot: 'p2', from: 1, to: 2.4, x: [[1, -OFF, 'fast'], [1.4, 0], [2, 0, 'fast'], [2.4, OFF]], base: s },
        { id: 'p3', slot: 'p3', from: 2, to: 4, x: [[2, -OFF, 'fast'], [2.4, 0]], base: s },
      ],
    };
  },
  // 中間的人從下面彈上來，左右兩個人逐拍滑進來排成 V 字
  vFormation: () => ({
    beats: 4,
    slots: [bg, subj('p1'), subj('p2'), subj('p3')],
    layers: [
      bgLayer(4),
      { id: 'p2', slot: 'p2', from: 1, to: 4, x: [[1, -OFF, 'fast'], [1.7, -0.3]], base: { s: 0.55, y: ground(0.55) } },
      { id: 'p3', slot: 'p3', from: 2, to: 4, x: [[2, OFF, 'fast'], [2.7, 0.3]], base: { s: 0.55, y: ground(0.55) } },
      { id: 'p1', slot: 'p1', from: 0, to: 4, y: [[0, 0.8, 'back'], [0.7, ground(0.8)]], base: { s: 0.8 } },
    ],
  }),
  // 從畫面下面彈出來，稍微衝過頭再站穩
  floorLaunch: () => ({
    beats: 2,
    slots: [bg, subj()],
    layers: [bgLayer(2), {
      id: 'subject', slot: 'subject', from: 0, to: 2,
      y: [[0, OFF, 'back'], [0.75, 0]], s: [[0, 0.7, 'out'], [0.75, 1]], r: [[0, -10, 'out'], [0.75, 0]],
    }],
  }),
  // 從左上斜衝進來，帶一點動態模糊
  diagonalSnap: () => ({
    beats: 2,
    slots: [bg, subj()],
    layers: [bgLayer(2), {
      id: 'subject', slot: 'subject', from: 0, to: 2,
      x: [[0, -OFF, 'fast'], [0.65, 0]], y: [[0, -0.65, 'fast'], [0.65, 0]],
      r: [[0, -18, 'out'], [0.65, 0]], s: [[0, 0.75, 'out'], [0.65, 1]],
      fx: [{ moduleId: 'fx-motionblur', params: { amount: 0.1, angle: 30, decay: 4 }, beatEvery: 2, hitBeats: 0.65 }],
    }],
  }),
  // 黑白的影子先滑到位，彩色的本人半拍後追上
  shadowFirst: () => ({
    beats: 2,
    slots: [bg, copy('shadow'), subj()],
    layers: [
      bgLayer(2),
      { id: 'shadow', slot: 'shadow', from: 0, to: 1, x: [[0, -OFF, 'fast'], [0.55, 0]], base: { o: 0.4 },
        fx: [{ moduleId: 'fx-bw', params: { contrast: 1.4, amount: 1, decay: 0 } }] },
      { id: 'subject', slot: 'subject', from: 0.5, to: 2, x: [[0.5, -OFF, 'fast'], [1, 0]] },
    ],
  }),
  // 兩道放大的殘影往內收，主體彈回原尺寸
  zoomEcho: () => ({
    beats: 2,
    slots: [bg, copy('echo1'), copy('echo2'), subj()],
    layers: [
      bgLayer(2),
      { id: 'echo1', slot: 'echo1', from: 0, to: 0.6, s: [[0, 1.45, 'out'], [0.6, 1]], o: [[0, 0.4, 'lin'], [0.6, 0]], blend: 'screen', pivot: true },
      { id: 'echo2', slot: 'echo2', from: 0.2, to: 0.8, s: [[0.2, 1.25, 'out'], [0.8, 1]], o: [[0.2, 0.4, 'lin'], [0.8, 0]], blend: 'screen', pivot: true },
      { id: 'subject', slot: 'subject', from: 0, to: 2, s: [[0, 0.8, 'back'], [0.7, 1]], pivot: true },
    ],
  }),
  // 黑白背景、彩色主體逐拍放大，第三拍衝一下，每拍描邊亮一次
  monoBurst: () => ({
    beats: 4,
    slots: [bg, subj()],
    layers: [
      bgLayer(4, [{ moduleId: 'fx-bw', params: { contrast: 1.4, amount: 1, decay: 0 } }]),
      { id: 'subject', slot: 'subject', from: 0, to: 4,
        s: [[0, 0.85], [1, 0.9], [2, 0.95, 'back'], [3, 1.08, 'out'], [3.5, 1]], pivot: true,
        fx: [{ moduleId: 'fx-matteoutline', params: { width: 10, glow: 1, intensity: 1, pulse: true }, beatEvery: 1, hitBeats: 0.3 }] },
    ],
  }),
  // 畫面往左甩出去，下一個鏡頭從右邊接上（甩的時候動態模糊）
  whipSwap: () => {
    const a = 0.7, b = 1.15;
    const blur = (): L['fx'] => [{ moduleId: 'fx-motionblur', params: { amount: 0.12, angle: 0, decay: 3 }, beatEvery: 2, hitBeats: b - a }];
    return {
      beats: 2,
      slots: [bg, reveal],
      layers: [
        bgLayer(a),
        { id: 'bg-out', slot: 'background', from: a, to: b, x: [[a, 0, 'fast'], [b, -1]], fx: blur() },
        { id: 'next-in', slot: 'reveal', from: a, to: b, x: [[a, 1, 'fast'], [b, 0]], fx: blur() },
        { id: 'next', slot: 'reveal', from: b, to: 2 },
      ],
    };
  },
  // 人形變成一扇門：主體的輪廓裡露出下一個鏡頭，越開越大直到滿版
  bodyPortal: () => ({
    beats: 4,
    slots: [bg, subj(), reveal],
    layers: [
      bgLayer(4),
      { id: 'subject', slot: 'subject', from: 0, to: 2.5, s: [[0, 0.85, 'out'], [1, 1]] },
      { id: 'portal', slot: 'reveal', from: 1, to: 4,
        mask: { slotId: 'subject', layerId: 'subject', mode: 'window', scale: [[1, 0.2, 'out'], [2, 1.2, 'fast'], [3, 3.5]] } },
    ],
  }),
};

export interface ComboFill { mediaId: string | null; sourceTime: number }

/** 建立組合動畫：揭露位置用 next，其他位置用 under（沒有 = 待補） */
export function comboItem(combo: ComboId, opts: { id: string; start: number; duration: number; track: number; under?: ComboFill; next?: ComboFill; center?: { cx: number; cy: number } }): AnimItem {
  const d = DEFS[combo]();
  const slots: AnimSlot[] = d.slots.map((s) => {
    const fill = (s.role === 'reveal' ? opts.next : opts.under) ?? { mediaId: null, sourceTime: 0 };
    return { ...s, mediaId: fill.mediaId, sourceTime: fill.sourceTime };
  });
  return {
    id: opts.id, track: opts.track, start: opts.start, duration: opts.duration,
    slots, layers: d.layers.map((l) => toLayer(l, opts.center)),
    beatTimes: Array.from({ length: d.beats + 1 }, (_, b) => b * opts.duration / d.beats),
    presetId: combo,
  };
}

/** 幾拍 */
export const comboBeats = (combo: ComboId) => DEFS[combo]().beats;
