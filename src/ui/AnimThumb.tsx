/**
 * 動畫範本的卡片：跟「預覽」的試看用同一套畫法（真的渲染器 + 同一份示範畫面），卡片和預覽才會一模一樣。
 * 平常顯示一格（閒置時一張一張算好、快取起來），滑過時即時播放。
 */
import React, { useEffect, useRef } from 'react';
import { create } from 'zustand';
import { useStore } from '../store';
import { usePrefs } from '../prefs';
import { makeCtx } from '../engine/renderer';
import { THUMB_H, THUMB_W, thumbRenderer } from '../engine/thumbs';
import { animTrialCtx } from './animTrial';
import type { AnimTrial } from './uiStore';

const FMT = { w: THUMB_W, h: THUMB_H };
/** 靜態縮圖用第幾成的那一格（大部分範本這時候都已經動起來了） */
const STILL = 0.72;
/** 播完停一下再重播（秒） */
const GAP = 0.5;

const useAnimThumbs = create<{ map: Record<string, string> }>(() => ({ map: {} }));
/** 每個範本固定一份試看設定（建好的動畫跟著它快取）；我的動畫內容改了要重建 */
const trials = new Map<string, { sig: string; trial: AnimTrial }>();
function trialOf(source: string): AnimTrial {
  const sig = source.startsWith('my:') ? JSON.stringify(usePrefs.getState().animPresets.find((p) => `my:${p.id}` === source)?.item ?? null) : '';
  let t = trials.get(source);
  if (!t || t.sig !== sig) {
    t = { sig, trial: { source, name: source, t0: 0 } };
    trials.set(source, t);
  }
  return t.trial;
}
const keyOf = (source: string) => `${source}:${trials.get(source)?.sig.length ?? 0}`;

/** 第 el 秒那一格要畫的東西與動畫長度（範本不存在 = null） */
function frameAt(source: string, el: number) {
  const { r } = thumbRenderer();
  const st = useStore.getState();
  // 文字等以「輸出畫面的高度」為準的大小：照專案的輸出高度縮到卡片上（不然文字會大到塞滿卡片）
  r.setSize(THUMB_W, THUMB_H, st.format.h);
  const base = makeCtx(st);
  const trial = trialOf(source);
  const probe = animTrialCtx(base, trial, 0, 0, FMT);
  if (!probe) return null;
  const dur = probe.ctx.anims[0]?.duration ?? 1;
  const res = animTrialCtx(base, trial, 0, Math.min(el, dur - 1e-3) * 1000, FMT)!;
  return { r, res, dur };
}

// 靜態縮圖：一次算一個（要等圖片載入），算好通知卡片
const queue: string[] = [];
let busy = false;
async function pump() {
  if (busy) return;
  busy = true;
  while (queue.length) {
    const source = queue.shift()!;
    try {
      const f = frameAt(source, 0);
      if (!f) continue;
      const g = frameAt(source, STILL * f.dur)!;
      await g.r.prepareExact(g.res.ctx, g.res.t);
      g.r.render(g.res.ctx, g.res.t, 'export');
      const url = thumbRenderer().canvas.toDataURL('image/jpeg', 0.85);
      useAnimThumbs.setState((s) => ({ map: { ...s.map, [keyOf(source)]: url } }));
    } catch (e) {
      console.warn('anim thumb', source, e);
    }
    await new Promise((r) => setTimeout(r, 0));
  }
  busy = false;
}

function useAnimThumb(source: string): string | undefined {
  trialOf(source);
  const key = keyOf(source);
  const url = useAnimThumbs((s) => s.map[key]);
  if (!url && !queue.includes(source)) {
    queue.push(source);
    void pump();
  }
  return url;
}

/** 即時播放到 out（滑過卡片、自動剪輯的示意卡片） */
function LivePlay({ source }: { source: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const out = ref.current;
    if (!out) return;
    const g = out.getContext('2d')!;
    const t0 = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const f = frameAt(source, 0);
      if (!f) return;
      const fr = frameAt(source, ((now - t0) / 1000) % (f.dur + GAP))!;
      fr.r.render(fr.res.ctx, fr.res.t, 'preview');
      g.drawImage(thumbRenderer().canvas, 0, 0, out.width, out.height);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [source]);
  return <canvas ref={ref} className="thumb-live" width={THUMB_W} height={THUMB_H} />;
}

/** 素材庫卡片的縮圖：靜態一格，live = 即時播放（滑過時） */
export function AnimThumb({ source, live }: { source: string; live?: boolean }) {
  const url = useAnimThumb(source);
  return (
    <>
      {url ? <img className="anim-still" src={url} alt="" draggable={false} /> : <span className="loading" />}
      {live && <LivePlay source={source} />}
    </>
  );
}

/** 一直播放的版本（自動剪輯「主體跳出」按鈕滑過時的示意卡片） */
export const AnimLive = LivePlay;
