/**
 * 磁吸的暫時反轉：拖曳中按住 Shift = 磁吸開著時暫時不吸、關著時暫時吸附（N 是開關）。
 * Shift 在按下滑鼠那一刻是範圍選取；拖曳開始後才當成反轉。
 */
import { useStore } from '../store';

let shift = false;
let last: { x: number; y: number; buttons: number; ctrl: boolean; meta: boolean; alt: boolean } | null = null;

/** 現在要不要吸附 */
export const snapActive = () => useStore.getState().snap !== shift;

if (typeof window !== 'undefined') {
  const track = (e: PointerEvent) => {
    if (!e.isTrusted) return;
    shift = e.shiftKey;
    last = { x: e.clientX, y: e.clientY, buttons: e.buttons, ctrl: e.ctrlKey, meta: e.metaKey, alt: e.altKey };
  };
  for (const t of ['pointermove', 'pointerdown', 'pointerup', 'pointercancel'] as const) window.addEventListener(t, track, true);
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Shift' || shift === e.shiftKey) return;
    shift = e.shiftKey;
    // 拖曳中：用同一個位置再送一次移動，吸附馬上換過來（不用等滑鼠動）
    if (last?.buttons) {
      window.dispatchEvent(new PointerEvent('pointermove', {
        clientX: last.x, clientY: last.y, buttons: last.buttons, bubbles: true,
        shiftKey: shift, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey,
      }));
    }
  };
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('keyup', onKey, true);
  window.addEventListener('blur', () => { shift = false; });
}
