/**
 * 共用的開關 / 選擇元件（樣式都在 styles.css，新介面照用途挑一種，不要自己再刻）：
 * - Switch：屬性面板、設定裡的「開 / 關」（.switch）
 * - Check：彈出視窗 / 小視窗裡一串選項：左邊文字、右邊 Switch（.check）
 * - Seg：幾個選項選一個（.seg）；SegToggles：同樣外觀但每格各自開關（粗體 / 斜體、軌道）
 * - ToggleChip：輸入框上方「附加 xx」這種小標籤開關（.ai-chip.toggle）
 * 工具列的圖示按鈕（.tbtn / .ec-icon / .btn.on-accent）直接在按鈕加 on class，不另外包。
 */
import React from 'react';

/**
 * 拖曳連續切換（Check、SegToggles）：按下第一個 = 切換它，按著滑過其他項目 = 設成跟第一個一樣的狀態。
 * 鍵盤觸發的 click（detail = 0）照常切換；滑鼠的 click 已經在按下時處理，吞掉。
 */
let paint: boolean | null = null;
if (typeof window !== 'undefined') {
  const stop = () => { paint = null; };
  window.addEventListener('pointerup', stop);
  window.addEventListener('pointercancel', stop);
}
/** 按在項目裡的輸入框 / 按鈕 / 連結上（不是開關本身）：照它自己的行為，不拖曳切換 */
const ownControl = (e: React.PointerEvent) => {
  const el = (e.target as HTMLElement).closest('input, button, select, textarea, a');
  return !!el && el !== e.currentTarget && !el.closest('.switch');
};
export function paintProps(v: boolean, on: (v: boolean) => void) {
  return {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0 || ownControl(e)) return;
      e.preventDefault(); // 不要選取文字、不要搶焦點
      // 觸控會自動捕捉指標（滑過別的項目收不到 pointerenter）→ 放掉
      (e.target as Element).releasePointerCapture?.(e.pointerId);
      paint = !v;
      on(!v);
    },
    onPointerEnter: () => {
      if (paint !== null && v !== paint) on(paint);
    },
    onClickCapture: (e: React.MouseEvent) => {
      if (e.detail === 0) return;
      const el = (e.target as HTMLElement).closest('input, button, select, textarea, a');
      if (el && el !== e.currentTarget && !el.closest('.switch')) return;
      e.preventDefault();
      e.stopPropagation();
    },
  };
}

export const Switch = ({ v, on, title }: { v: boolean; on: (v: boolean) => void; title?: string }) => (
  <label className="switch" title={title}>
    <input type="checkbox" checked={v} onChange={(e) => on(e.target.checked)} />
    <span />
  </label>
);

export const Check = ({ v, on, children, title }: { v: boolean; on: (v: boolean) => void; children: React.ReactNode; title?: string }) => (
  <div className="check" title={title} {...paintProps(v, on)}>
    <span className="check-label">{children}</span>
    <Switch v={v} on={on} />
  </div>
);

export interface SegOpt<T> { v: T; label: React.ReactNode; title?: string }

export function Seg<T extends string | number | boolean>({ value, opts, on, className }: { value: T; opts: SegOpt<T>[]; on: (v: T) => void; className?: string }) {
  return (
    <div className={`seg ${className ?? ''}`}>
      {opts.map((o) => (
        <button key={String(o.v)} className={o.v === value ? 'on' : ''} title={o.title} onClick={() => on(o.v)}>{o.label}</button>
      ))}
    </div>
  );
}

/** hover：滑鼠移進 / 移出這格（null = 移出），例如顯示說明卡片 */
export interface SegToggle { key: string; v: boolean; on: (v: boolean) => void; label: React.ReactNode; title?: string; hover?: (el: HTMLElement | null) => void }

export const SegToggles = ({ items, className }: { items: SegToggle[]; className?: string }) => (
  <div className={`seg ${className ?? ''}`}>
    {items.map((i) => <button key={i.key} className={i.v ? 'on' : ''} title={i.title} {...paintProps(i.v, i.on)} onClick={(e) => e.detail === 0 && i.on(!i.v)}
      {...(i.hover ? { onMouseEnter: (e: React.MouseEvent<HTMLElement>) => i.hover!(e.currentTarget), onMouseLeave: () => i.hover!(null) } : {})}>{i.label}</button>)}
  </div>
);

export const ToggleChip = ({ v, on, title, children }: { v: boolean; on: (v: boolean) => void; title?: string; children: React.ReactNode }) => (
  <button className={`ai-chip toggle ${v ? 'on' : ''}`} title={title} onClick={() => on(!v)}>{children}</button>
);
