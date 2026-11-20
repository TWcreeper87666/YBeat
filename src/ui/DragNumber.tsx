import { $t } from '../i18n';
import React, { useEffect, useRef, useState } from 'react';
import { openMenu, toast } from './uiStore';

/**
 * Blender 風格數值欄：
 * - 按住左右拖曳改數值（游標會鎖定，可以一直拖）；Shift = 微調，Ctrl = 對齊刻度
 * - 單擊進入輸入模式，可輸入算式（例如 1/3、2*0.5），Enter 確定、Esc 取消
 * - 兩側箭頭一次加減一格；右鍵可重設為預設值
 */
export function DragNumber({
  label,
  value,
  onChange,
  min = -Infinity,
  max = Infinity,
  step,
  def,
  decimals,
  suffix = '',
  bar = false,
  variant = 'box',
  display,
}: {
  label?: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  def?: number;
  decimals?: number;
  suffix?: string;
  /** 顯示填色進度條（預設不顯示，只是可拖曳的數字欄） */
  bar?: boolean;
  /** box = 欄位、text = Premiere 風格的藍色可拖曳數字 */
  variant?: 'box' | 'text';
  /** 顯示倍率（例如縮放 1.0 顯示成 100%） */
  display?: number;
}) {
  const mul = display ?? 1;
  const ranged = Number.isFinite(min) && Number.isFinite(max);
  const st = step ?? (ranged ? niceStep((max - min) / 100) : 0.01);
  const dec = decimals ?? Math.max(0, Math.min(4, Math.ceil(-Math.log10(st))));
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [dragging, setDragging] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  const round = (v: number) => Number(v.toFixed(Math.max(dec, 0) + 1));

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || editing) return;
    e.preventDefault();
    const el = ref.current!;
    const start = value;
    let acc = 0;
    let moved = false;
    let locked = false;
    // 每像素變化量：有範圍時拖 ~300px 走完全程
    const perPx = ranged ? (max - min) / 300 : st / 2;
    const move = (ev: PointerEvent) => {
      // 剛鎖定游標時 Chrome 偶爾會回報一次超大的位移，忽略它
      if (Math.abs(ev.movementX) > 80) return;
      acc += ev.movementX;
      if (!moved && Math.abs(acc) < 3) return;
      if (!moved) {
        moved = true;
        setDragging(true);
        el.requestPointerLock?.()?.catch?.(() => {});
        locked = true;
      }
      let v = start + acc * perPx * (ev.shiftKey ? 0.1 : 1);
      if (ev.ctrlKey) v = Math.round(v / (st * 10)) * st * 10;
      onChange(round(clamp(v)));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (locked && document.pointerLockElement) document.exitPointerLock();
      setDragging(false);
      if (!moved) {
        setText(String(Number((value * mul).toFixed(dec + 2))));
        setEditing(true);
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const commit = () => {
    const v = evalExpr(text);
    if (v !== null) onChange(round(clamp(v / mul)));
    setEditing(false);
  };

  const stepBy = (dir: number) => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    onChange(round(clamp(value + dir * st)));
  };

  const pct = ranged ? Math.min(1, Math.max(0, (value - min) / (max - min))) : 0;

  return (
    <div
      ref={ref}
      className={`dragnum ${variant} ${dragging ? 'dragging' : ''} ${editing ? 'editing' : ''} ${def !== undefined && Math.abs(value - def) > 1e-9 ? 'modified' : ''}`}
      onPointerDown={onPointerDown}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        openMenu(e.clientX, e.clientY, [
          { label: $t('重設為預設值'), action: def !== undefined ? () => onChange(def) : undefined },
          { label: $t('複製數值'), action: () => navigator.clipboard?.writeText(String(Number((value * mul).toFixed(dec + 2)))) },
          {
            label: $t('貼上數值'),
            action: async () => {
              try {
                const pasted = evalExpr(await navigator.clipboard.readText());
                if (pasted === null) {
                  toast($t('剪貼簿內容不是有效數值'), 'error');
                  return;
                }
                onChange(round(clamp(pasted / mul)));
              } catch {
                toast($t('無法讀取剪貼簿'), 'error');
              }
            },
          },
        ]);
      }}
    >
      {ranged && bar && !editing && <div className="dn-fill" style={{ width: `${pct * 100}%` }} />}
      {editing ? (
        <input
          ref={inputRef}
          className="dn-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') commit();
            else if (e.key === 'Escape') setEditing(false);
          }}
        />
      ) : (
        <>
          <span className="dn-arrow l" onPointerDown={stepBy(-1)}>‹</span>
          {label && <span className="dn-label">{label}</span>}
          <span className="dn-value">{(value * mul).toFixed(Math.max(0, dec - Math.round(Math.log10(mul))))}{suffix}</span>
          <span className="dn-arrow r" onPointerDown={stepBy(1)}>›</span>
        </>
      )}
    </div>
  );
}

function niceStep(x: number) {
  const p = Math.pow(10, Math.floor(Math.log10(x)));
  const n = x / p;
  return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * p;
}

/** 只允許數字與 + - * / ( ) 的簡單算式 */
function evalExpr(s: string): number | null {
  const t = s.trim();
  if (!/^[\d+\-*/().\s eE]+$/.test(t)) return null;
  try {
    const v = Function(`"use strict";return (${t})`)();
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}
