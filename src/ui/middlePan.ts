/**
 * 中鍵拖曳平移（共用）：dragPan = 拖曳迴圈（游標變抓手；中鍵放開的事件被別的按鍵吃掉也會結束），
 * panScroll = 拖一個捲動區塊，installMiddlePan = 全域：任何可以捲動的地方都能用中鍵拖。
 * 自己處理中鍵的地方（時間軸、預覽、繪圖區、範圍條）先 preventDefault，全域的就不會再處理。
 */
import { scrollerAt } from './overlayScrollbar';

type PtrEvent = Pick<PointerEvent, 'clientX' | 'clientY' | 'button' | 'preventDefault' | 'stopPropagation'>;

/** onMove(dx, dy) = 從按下到現在移動了多少 px */
export function dragPan(e: PtrEvent, onMove: (dx: number, dy: number) => void, onEnd?: () => void) {
  e.preventDefault();
  e.stopPropagation();
  const x0 = e.clientX, y0 = e.clientY;
  const button = e.button;
  const mask = button === 1 ? 4 : button === 2 ? 2 : 1;
  document.body.classList.add('panning');
  const end = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('blur', end);
    document.body.classList.remove('panning');
    onEnd?.();
  };
  const move = (ev: PointerEvent) => {
    if (!(ev.buttons & mask)) return end();
    onMove(ev.clientX - x0, ev.clientY - y0);
  };
  const up = (ev: PointerEvent) => { if (ev.button === button || !(ev.buttons & mask)) end(); };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('blur', end);
}

/** 拖一個捲動區塊（上下左右） */
export function panScroll(e: PtrEvent, el: HTMLElement) {
  const sl = el.scrollLeft, st = el.scrollTop;
  dragPan(e, (dx, dy) => { el.scrollLeft = sl - dx; el.scrollTop = st - dy; });
}

export function installMiddlePan() {
  window.addEventListener('pointerdown', (e) => {
    if (e.button !== 1 || e.defaultPrevented) return;
    const el = scrollerAt(e.target as Element);
    if (el) panScroll(e, el);
  });
}
