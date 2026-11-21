/** 滑鼠 / 觸控按住中（拖曳進行中）：復原紀錄與自動存檔都等放開才結算 */
let held = 0;
const waiters = new Set<() => void>();

export const pointerHeld = () => held > 0;

/** 放開後（所有 pointerup 處理完）呼叫一次 */
export function afterRelease(fn: () => void) {
  waiters.add(fn);
}

if (typeof window !== 'undefined') {
  window.addEventListener('pointerdown', () => (held = 1), true);
  const up = () => {
    if (!held) return;
    held = 0;
    // 等拖曳本身的 pointerup 處理完（最後一次變更）再結算
    setTimeout(() => {
      if (held) return;
      const fns = [...waiters];
      waiters.clear();
      for (const f of fns) f();
    }, 0);
  };
  window.addEventListener('pointerup', up, true);
  window.addEventListener('pointercancel', up, true);
  window.addEventListener('blur', up);
}
