/**
 * 讓面板對齊整數「實體像素」。
 *
 * Windows / 瀏覽器縮放不是 100% 時（例如 devicePixelRatio = 1.25），停駐區依比例分配的面板常常落在半個實體像素上。
 * 面板捲到最底時，滑鼠滑過按鈕、數值欄位，Chrome 只重畫被 hover 的那一塊，那一塊會對齊到隔壁的像素，
 * 看起來就是「一塊一塊上下差一個像素」地抖。排版位置本身沒有變（量過），所以從 CSS 排版下手修不好。
 *
 * 做法：面板外框依父層（.slot）的位置往右下挪不到 1 個實體像素、寬高收到整數實體像素，面板內容就都對齊了。
 */

const snappers = new WeakMap<HTMLElement, () => void>();

export function snapToDevicePixels(host: HTMLElement) {
  let raf = 0;
  const apply = () => {
    raf = 0;
    const p = host.parentElement;
    if (!p) return;
    const d = window.devicePixelRatio || 1;
    const r = p.getBoundingClientRect();
    const up = (v: number) => Math.ceil(v * d - 0.01) / d;
    const top = up(r.top), left = up(r.left);
    const h = Math.max(0, Math.floor((r.bottom - top) * d + 0.01) / d);
    const w = Math.max(0, Math.floor((r.right - left) * d + 0.01) / d);
    const s = host.style;
    s.position = 'relative';
    s.top = `${top - r.top}px`;
    s.left = `${left - r.left}px`;
    s.maxHeight = `${h}px`;
    s.maxWidth = `${w}px`;
  };
  // 面板 / 父層大小改變（拖分隔線、視窗縮放、編輯視窗換排版）→ 重算；只改自己的 max 尺寸，父層不受影響，不會反覆觸發。
  // ResizeObserver 在繪製前通知：當場套用，不等下一幀（等的話會先畫出一幀舊大小，畫面和框閃一下舊位置）
  const ro = new ResizeObserver(() => {
    watch();
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    apply();
  });
  let watched: Element | null = null;
  const watch = () => {
    const p = host.parentElement;
    if (p && p !== watched) {
      if (watched) ro.unobserve(watched);
      ro.observe(p);
      watched = p;
    }
  };
  const schedule = () => {
    watch();
    if (!raf) raf = requestAnimationFrame(apply);
  };
  // 搬到新位置（Slot 的 layout effect 裡呼叫）：也當場套用
  snappers.set(host, () => {
    watch();
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    apply();
  });
  ro.observe(host);
  window.addEventListener('resize', schedule);
}

/** 面板搬到新位置（停駐 / 浮動 / 編輯視窗）後重新對齊 */
export function resnap(host: HTMLElement) {
  snappers.get(host)?.();
}
