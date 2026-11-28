/**
 * 2D 畫面的檢視縮放（共用：預覽、繪圖區、修正去背）：滾輪以滑鼠為中心縮放、平移、右下角的倍率標籤。
 * 2D 畫面滾輪直接縮放，刻意跟時間軸類的「Ctrl + 滾輪縮放」不同（見 wheelView.tsx）。
 */
import React, { useEffect, useRef, useState } from 'react';
import { $t } from '../i18n';

export interface View2D { z: number; px: number; py: number }
export const FIT_VIEW: View2D = { z: 1, px: 0, py: 0 };
export const isFitView = (v: View2D) => v.z === 1 && v.px === 0 && v.py === 0;

/**
 * 滾輪縮放後的檢視（滑鼠底下的點保持不動）。
 * origin：px / py 是相對什麼的位移：'center' = 相對外框中心（畫面置中）；'corner' = 相對外框左上角
 */
export function zoomAt(v: View2D, e: { clientX: number; clientY: number; deltaY: number }, rect: DOMRect,
  o: { min: number; max: number; origin: 'center' | 'corner' }): View2D {
  const mx = e.clientX - rect.left - (o.origin === 'center' ? rect.width / 2 : 0);
  const my = e.clientY - rect.top - (o.origin === 'center' ? rect.height / 2 : 0);
  const z = Math.min(o.max, Math.max(o.min, v.z * Math.pow(1.0015, -e.deltaY)));
  const k = z / v.z;
  return { z, px: mx - (mx - v.px) * k, py: my - (my - v.py) * k };
}

/**
 * 在 ref 上裝滾輪縮放。get / set 讓呼叫的地方自己決定存在哪（state 或 zustand）。
 * intercept：回傳 true = 這次滾輪自己處理掉（例如 Shift + 滾輪改筆刷大小），不縮放
 */
export function useWheelZoom(ref: React.RefObject<HTMLElement | null>, get: () => View2D, set: (v: View2D) => void,
  o: { min: number; max: number; origin: 'center' | 'corner'; intercept?: (e: WheelEvent) => boolean }) {
  const opts = useRef(o);
  opts.current = o;
  const fns = useRef({ get, set });
  fns.current = { get, set };
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (opts.current.intercept?.(e)) return;
      fns.current.set(zoomAt(fns.current.get(), e, el.getBoundingClientRect(), opts.current));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [ref]);
}

/** 檢視存在元件自己的 state（預覽用全域的 store，不用這個） */
export function useLocalView() {
  const [view, setViewState] = useState<View2D>(FIT_VIEW);
  const ref = useRef(view);
  const setView = (v: View2D) => { ref.current = v; setViewState(v); };
  return { view, get: () => ref.current, setView, reset: () => setView(FIT_VIEW) };
}

/** 右下角的倍率標籤：點一下回到符合視窗 */
export function ZoomBadge({ z, onReset, title, fit, className }: { z: number; onReset: () => void; title: string; fit?: boolean; className?: string }) {
  return (
    <button className={`view-zoom ${className ?? ''}`} title={title} onClick={onReset} onPointerDown={(e) => e.stopPropagation()}>
      {Math.round(z * 100)}%{fit ? ` · ${$t('符合')}` : ''}
    </button>
  );
}
