/**
 * 共用的開關 / 選擇元件（樣式都在 styles.css，新介面照用途挑一種，不要自己再刻）：
 * - Switch：屬性面板、設定裡的「開 / 關」（.switch）
 * - Check：彈出視窗 / 小視窗裡一串選項：左邊文字、右邊 Switch（.check）
 * - Seg：幾個選項選一個（.seg）；SegToggles：同樣外觀但每格各自開關（粗體 / 斜體、軌道）
 * - ToggleChip：輸入框上方「附加 xx」這種小標籤開關（.ai-chip.toggle）
 * 工具列的圖示按鈕（.tbtn / .ec-icon / .btn.on-accent）直接在按鈕加 on class，不另外包。
 */
import React from 'react';

export const Switch = ({ v, on, title }: { v: boolean; on: (v: boolean) => void; title?: string }) => (
  <label className="switch" title={title}>
    <input type="checkbox" checked={v} onChange={(e) => on(e.target.checked)} />
    <span />
  </label>
);

export const Check = ({ v, on, children, title }: { v: boolean; on: (v: boolean) => void; children: React.ReactNode; title?: string }) => (
  <div className="check" title={title}>
    <span className="check-label" onClick={() => on(!v)}>{children}</span>
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

export interface SegToggle { key: string; v: boolean; on: (v: boolean) => void; label: React.ReactNode; title?: string }

export const SegToggles = ({ items, className }: { items: SegToggle[]; className?: string }) => (
  <div className={`seg ${className ?? ''}`}>
    {items.map((i) => <button key={i.key} className={i.v ? 'on' : ''} title={i.title} onClick={() => i.on(!i.v)}>{i.label}</button>)}
  </div>
);

export const ToggleChip = ({ v, on, title, children }: { v: boolean; on: (v: boolean) => void; title?: string; children: React.ReactNode }) => (
  <button className={`ai-chip toggle ${v ? 'on' : ''}`} title={title} onClick={() => on(!v)}>{children}</button>
);
