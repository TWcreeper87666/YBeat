/**
 * 時間軸類元件（主時間軸、屬性的關鍵影格時間軸、選範圍視窗的範圍條…）共用的滾輪 / 捲軸規則：
 * 滾輪 = 捲動（方向照「滾輪捲動方向」設定，Shift / Alt 換方向）、Ctrl + 滾輪 = 以游標為中心縮放、
 * 捲軸用覆蓋式的（overlayScrollbar；只有顯示範圍的用 ViewScrollbar）、中鍵拖曳 = 平移（middlePan）。
 * 新的時間軸類元件照這套做。預覽畫面、繪圖區這種 2D 畫面不一樣：滾輪直接縮放是刻意的。
 */
import React, { useRef } from 'react';

export type WheelViewAction = { kind: 'zoom' | 'scrollX' | 'scrollY'; delta: number };

/** Match the main timeline's wheel setting, including Chrome's swapped Shift delta. */
export function wheelViewAction(e: Pick<WheelEvent, 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey' | 'deltaX' | 'deltaY'>, wheelScroll: 'horizontal' | 'vertical', zoomWithMeta = true): WheelViewAction {
  if (e.ctrlKey || (zoomWithMeta && e.metaKey)) return { kind: 'zoom', delta: e.deltaY };
  const swap = e.shiftKey || e.altKey;
  const swipeX = Math.abs(e.deltaX) > Math.abs(e.deltaY) && !swap;
  const horizontalFirst = wheelScroll !== 'vertical';
  const wantX = swipeX || (horizontalFirst ? !swap : swap);
  const delta = swap ? e.deltaY || e.deltaX : swipeX ? e.deltaX : e.deltaY;
  return { kind: wantX ? 'scrollX' : 'scrollY', delta };
}

/**
 * 顯示範圍 [a, b]（總長 dur）的捲軸：浮在父元素最下面（vertical = 最右邊；父元素要 position: relative），外觀跟全域的覆蓋式捲軸一樣。
 * 只有放大時出現；拖把手 = 平移，點空白處 = 跳過去
 */
export function ViewScrollbar({ a, b, dur, onChange, className = '', vertical = false }: {
  a: number; b: number; dur: number; onChange: (view: [number, number]) => void; className?: string; vertical?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const span = b - a;
  const zoomed = dur > 0 && span > 0 && span < dur - 1e-6;
  if (!zoomed) return null;
  const clamp = (x: number) => Math.max(0, Math.min(dur - span, x));
  const down = (e: React.PointerEvent, onThumb: boolean) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const r = ref.current!.getBoundingClientRect();
    const at = (ev: { clientX: number; clientY: number }) => (vertical ? ev.clientY - r.top : ev.clientX - r.left);
    const k = dur / (vertical ? r.height : r.width);
    let a0 = a;
    // 點空白處：那裡放到中間
    if (!onThumb) { a0 = clamp(at(e) * k - span / 2); onChange([a0, a0 + span]); }
    const x0 = at(e);
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    ref.current!.classList.add('drag');
    const move = (ev: PointerEvent) => { const na = clamp(a0 + (at(ev) - x0) * k); onChange([na, na + span]); };
    const up = () => {
      ref.current?.classList.remove('drag');
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
  return (
    <div ref={ref} className={`osb-track ${vertical ? 'v' : ''} ${className}`.trim()} onPointerDown={(e) => down(e, false)}>
      <div className="osb-thumb" style={vertical
        ? { top: `${(a / dur) * 100}%`, height: `max(24px, ${(span / dur) * 100}%)` }
        : { left: `${(a / dur) * 100}%`, width: `max(24px, ${(span / dur) * 100}%)` }} onPointerDown={(e) => down(e, true)} />
    </div>
  );
}
