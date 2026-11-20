import type { Clip, Module } from '../store';
import type { RenderCtx } from './renderer';

/** 試看前後各多播一點，看得出轉場前後的樣子 */
const PAD = 0.5;
const ADJ_EPS = 0.01;

/** 把 ctx 裡的某個片段換成另一個版本（試看用，不改到專案） */
export function withClip(ctx: RenderCtx, c: Clip): RenderCtx {
  return { ...ctx, clips: ctx.clips.map((x) => (x.id === c.id ? c : x)), videoTracks: ctx.videoTracks.map((l) => l.map((x) => (x.id === c.id ? c : x))) };
}

export interface TrialCut {
  /** 暫時把轉場套到後一段片段上的 ctx */
  ctx: RenderCtx;
  track: number;
  cut: number;
  d: number;
  /** 循環範圍 */
  lo: number;
  hi: number;
}

/**
 * 播放頭停在某條影片軌兩個緊貼片段的剪接點上 → 用這兩段（前一段的尾巴、後一段的開頭）試看轉場。
 * prefer：先找這條軌道；其餘由上往下（軌道編號大的在上面）。
 */
export function trialTransitionAt(ctx: RenderCtx, t: number, module: Module, dur: number, tol: number, prefer?: number): TrialCut | null {
  const order = ctx.videoTracks.map((_, i) => i).reverse();
  if (prefer !== undefined && prefer >= 0 && prefer < order.length) order.sort((a, b) => (b === prefer ? 1 : 0) - (a === prefer ? 1 : 0));
  for (const ti of order) {
    if (ctx.tracks.video[ti]?.hidden) continue;
    const clips = ctx.videoTracks[ti];
    for (let i = 1; i < clips.length; i++) {
      const A = clips[i - 1], B = clips[i];
      if (Math.abs(A.start + A.duration - B.start) > ADJ_EPS || Math.abs(B.start - t) > tol) continue;
      const d = Math.max(0.05, Math.min(dur, A.duration, B.duration));
      const B2: Clip = { ...B, transitionIn: { moduleId: module.id, params: {}, duration: d } };
      const videoTracks = ctx.videoTracks.map((l, j) => (j === ti ? l.map((c) => (c === B ? B2 : c)) : l));
      const cut = B.start;
      return {
        ctx: { ...ctx, videoTracks, clips: ctx.clips.map((c) => (c.id === B.id ? B2 : c)) },
        track: ti,
        cut,
        d,
        lo: Math.max(A.start, cut - d / 2 - PAD),
        hi: Math.min(B.start + B.duration - 1e-3, cut + d / 2 + PAD),
      };
    }
  }
  return null;
}
