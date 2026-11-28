/**
 * 焦點規則（全 App 共用，新增元件不用另外處理）：
 * - 只有「打字用」的欄位（文字輸入框、textarea、程式碼編輯器、contenteditable）可以攔住鍵盤快捷鍵。
 * - 其他可聚焦的控制項（滑桿、核取方塊、按鈕、下拉選單、顏色…）點完就不該留著焦點：
 *   按鍵時先把焦點拿掉，快捷鍵照常作用；方向鍵 / Space / Enter 也不會再去改那個控制項。
 */

/** 有開著的對話框（全螢幕遮罩裡的 .dialog，或自己處理按鍵的大視窗 .modal-window）：這時編輯器的快捷鍵一律不作用 */
export const modalOpen = () => !!document.querySelector('.overlay .dialog, .overlay .modal-window');

/** 不能打字的 input 類型（其他類型都當文字欄位） */
const NON_TEXT_INPUT = new Set(['range', 'checkbox', 'radio', 'color', 'button', 'submit', 'reset', 'file', 'image']);

/** 這個元素（或它的祖先）是不是打字用的欄位：只有這種欄位裡，鍵盤快捷鍵要讓給輸入 */
export function isTextField(el: EventTarget | Element | null | undefined): boolean {
  if (!(el instanceof Element)) return false;
  if (el.closest('textarea, .cm-editor, [contenteditable]:not([contenteditable=false])')) return true;
  const input = el.closest('input');
  return !!input && !NON_TEXT_INPUT.has(input.type);
}

/** 會讓控制項自己動作的按鍵（焦點拿掉後要擋掉它們的預設行為） */
const CONTROL_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', ' ', 'Enter']);

/** 目前焦點在「不是打字欄位」的控制項上 */
function strayFocus(): HTMLElement | null {
  const a = document.activeElement as HTMLElement | null;
  if (!a || a === document.body || a === document.documentElement || isTextField(a)) return null;
  return a;
}

export function installFocusGuard() {
  // 按鍵最先處理（capture）：焦點卡在滑桿 / 按鈕 / 下拉選單上 → 先拿掉，再交給全域快捷鍵
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Tab') return; // 保留鍵盤導覽
      const a = strayFocus();
      if (!a) return;
      // 對話框 / 選單裡的按鈕：Enter / Space 交給它們自己的處理
      if (a.closest('.dialog, .ctxmenu, .popover, [role=dialog]')) return;
      a.blur();
      if (CONTROL_KEYS.has(e.key)) e.preventDefault();
    },
    { capture: true },
  );
  // 點完就失焦（下拉選單、顏色選擇器點下去會開原生視窗，等改完值再失焦）
  window.addEventListener('pointerup', () => {
    const a = strayFocus();
    if (!a || a.tagName === 'SELECT' || (a as HTMLInputElement).type === 'color') return;
    a.blur();
  });
  window.addEventListener(
    'change',
    (e) => {
      const t = e.target as HTMLElement;
      if (t === document.activeElement && !isTextField(t)) t.blur();
    },
    { capture: true },
  );
}
