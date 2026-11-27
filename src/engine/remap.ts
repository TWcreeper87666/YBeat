import { $t } from '../i18n';
import type { Clip, Media, Module } from '../store';
import { parseParams, resolveParams, type ParamValues } from './params';
import { evalKeys } from './keyframes';
import { CURVE_ID, evalCurve, type CurvePoint } from './remapCurve';

type Fn = (x: number) => number;
export const ease: Record<string, Fn> & { clamp: (x: number, a?: number, b?: number) => number } = {
  linear: (x) => x,
  inCubic: (x) => x * x * x,
  outCubic: (x) => 1 - Math.pow(1 - x, 3),
  inOutCubic: (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2),
  inExpo: (x) => (x <= 0 ? 0 : Math.pow(2, 10 * x - 10)),
  outExpo: (x) => (x >= 1 ? 1 : 1 - Math.pow(2, -10 * x)),
  outBack: (x) => {
    const c1 = 1.70158, c3 = c1 + 1;
    return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
  },
  inOutBack: (x) => {
    const c2 = 1.70158 * 1.525;
    return x < 0.5
      ? (Math.pow(2 * x, 2) * ((c2 + 1) * 2 * x - c2)) / 2
      : (Math.pow(2 * x - 2, 2) * ((c2 + 1) * (x * 2 - 2) + c2) + 2) / 2;
  },
  clamp: (x, a = 0, b = 1) => Math.min(b, Math.max(a, x)),
};

/** 變速模組程式碼裡的 ease：緩動函式 + ease.curve（素材庫裡存的曲線，x / 回傳值都是相對片段長度的比例） */
export const remapLib = { ...ease, curve: (c: CurvePoint[], x: number) => evalCurve(c, x) };

export interface RemapInfo { dur: number; srcDur: number; in: number }
type RemapFn = (t: number, p: ParamValues, info: RemapInfo) => number;

const cache = new Map<string, { code: string; fn: RemapFn | null }>();
let report: (id: string, msg: string | null) => void = () => {};
export function setRemapErrorReporter(f: typeof report) { report = f; }

export function getRemapFn(m: Module): RemapFn | null {
  let e = cache.get(m.id);
  if (!e || e.code !== m.code) {
    let fn: RemapFn | null = null;
    let error: string | null = null;
    try {
      fn = new Function('ease', `"use strict";\n${m.code}\n;return typeof remap === 'function' ? remap : null;`)(remapLib);
      if (!fn) error = $t('找不到 function remap(t, p, info)');
    } catch (err) {
      error = String(err);
    }
    e = { code: m.code, fn: fn ?? e?.fn ?? null };
    cache.set(m.id, e);
    report(m.id, error);
  }
  return e.fn;
}

/** 一般播放與內建變速的速度（用於原音播放 / 混音）；其他模式回傳 null */
export function plainSpeed(clip: Clip, modules: Map<string, Module>): number | null {
  if (clip.remap.moduleId === 'remap-none') return clip.rate ?? 1;
  if (clip.remap.moduleId !== 'remap-speed') return null;
  const m = modules.get('remap-speed');
  if (!m) return 1;
  const p = resolveParams(parseParams(m.code), clip.remap.params);
  return (Number(p.speed) || 1) * (clip.rate ?? 1);
}

/** 決定性時間映射：片段內時間 local → 素材時間 src（秒），並估計瞬時播放速率 */
export function clipSource(clip: Clip, local: number, media: Media, modules: Map<string, Module>) {
  const maxT = Math.max(0, media.duration - 0.02);
  // 曲線模式：素材時間直接由關鍵影格決定（不吃整體速率）
  const keys = clip.remap.moduleId === CURVE_ID ? clip.remap.keys : undefined;
  if (keys?.length) {
    const at = (t: number) => Math.min(maxT, Math.max(0, clip.in + evalKeys(keys, Math.min(clip.duration, Math.max(0, t)))));
    const dt = 1 / 60;
    const a = at(local);
    return { src: a, rate: (at(local + dt) - a) / dt };
  }
  const m = modules.get(clip.remap.moduleId);
  const fn = m ? getRemapFn(m) : null;
  const p = m ? resolveParams(parseParams(m.code), clip.remap.params) : {};
  const rate = clip.rate ?? 1;
  // 整體速率：把片段內時間先乘上 rate，再交給重映射函式
  const info: RemapInfo = { dur: clip.duration * rate, srcDur: media.duration, in: clip.in };
  const f = (t: number) => {
    if (!fn) return t;
    try {
      const v = fn(t, p, info);
      return Number.isFinite(v) ? v : 0;
    } catch (err) {
      report(m!.id, $t('執行錯誤：') + String(err));
      return t;
    }
  };
  const cl = (x: number) => Math.min(maxT, Math.max(0, clip.in + x));
  const dt = 1 / 60;
  const a = cl(f(local * rate));
  const b = cl(f((local + dt) * rate));
  return { src: a, rate: (b - a) / dt };
}
