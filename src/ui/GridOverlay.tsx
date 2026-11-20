import { $t } from '../i18n';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLayout } from './uiStore';
import { DragNumber } from './DragNumber';

/**
 * 輔助網格：預覽與鋼筆工具共用同一組設定（開關、列 / 欄、中心十字、短影音安全區）。
 */

/** 網格線（W × H = 畫面在螢幕上的大小；沒開網格 = 不畫） */
export function GridOverlay({ W, H }: { W: number; H: number }) {
  const L = useLayout();
  if (!L.grid) return null;
  return (
    <svg className="grid-overlay" width={W} height={H}>
      {Array.from({ length: L.gridCols - 1 }, (_, i) => (i + 1) / L.gridCols).map((f) => <line key={'c' + f} x1={f * W} y1={0} x2={f * W} y2={H} />)}
      {Array.from({ length: L.gridRows - 1 }, (_, i) => (i + 1) / L.gridRows).map((f) => <line key={'r' + f} x1={0} y1={f * H} x2={W} y2={f * H} />)}
      {L.gridCenter && (
        <>
          <line className="center" x1={W / 2} y1={H / 2 - 10} x2={W / 2} y2={H / 2 + 10} />
          <line className="center" x1={W / 2 - 10} y1={H / 2} x2={W / 2 + 10} y2={H / 2} />
        </>
      )}
      {/* 短影音安全區：右側按鈕、下方標題 */}
      {L.gridSafe && <rect className="safe" x={W * 0.04} y={H * 0.08} width={W * 0.8} height={H * 0.7} />}
    </svg>
  );
}

/** 網格開關（右鍵設定格數） */
export function GridButton() {
  const grid = useLayout((s) => s.grid);
  const [pop, setPop] = useState<{ x: number; y: number } | null>(null);
  return (
    <>
      <button
        className={`tp ${grid ? 'on' : ''}`}
        title={$t('輔助網格（右鍵設定格數）')}
        onClick={() => useLayout.getState().set({ grid: !grid })}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setPop({ x: e.clientX, y: e.clientY });
        }}
      >
        #
      </button>
      {pop && <GridPopover at={pop} close={() => setPop(null)} />}
    </>
  );
}

/** 網格設定（右鍵網格按鈕） */
function GridPopover({ at, close }: { at: { x: number; y: number }; close: () => void }) {
  const L = useLayout();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(at);
  useLayoutEffect(() => {
    const r = ref.current!.getBoundingClientRect();
    setPos({ x: Math.max(8, Math.min(at.x - r.width, innerWidth - r.width - 8)), y: Math.max(8, Math.min(at.y - r.height - 8, innerHeight - r.height - 8)) });
  }, [at]);
  useEffect(() => {
    const down = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && close();
    const key = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key);
    };
  }, [close]);
  const presets: [number, number][] = [[3, 3], [4, 4], [2, 2], [6, 6], [8, 4], [12, 6]];
  return (
    <div ref={ref} className="popover" style={{ left: pos.x, top: pos.y }} onContextMenu={(e) => e.preventDefault()}>
      <div className="pop-title">{$t('輔助網格')}</div>
      <div className="pop-row"><span>{$t('列')}</span><DragNumber value={L.gridRows} min={1} max={24} step={1} decimals={0} def={3} onChange={(v) => L.set({ gridRows: Math.round(v), grid: true })} /></div>
      <div className="pop-row"><span>{$t('欄')}</span><DragNumber value={L.gridCols} min={1} max={24} step={1} decimals={0} def={3} onChange={(v) => L.set({ gridCols: Math.round(v), grid: true })} /></div>
      <div className="chips">
        {presets.map(([r, c]) => (
          <button key={`${r}x${c}`} className={L.gridRows === r && L.gridCols === c ? 'on' : ''} onClick={() => L.set({ gridRows: r, gridCols: c, grid: true })}>{c}×{r}</button>
        ))}
      </div>
      <label className="check"><input type="checkbox" checked={L.gridCenter} onChange={(e) => L.set({ gridCenter: e.target.checked })} />{' '}{$t('中心十字')}</label>
      <label className="check"><input type="checkbox" checked={L.gridSafe} onChange={(e) => L.set({ gridSafe: e.target.checked })} />{' '}{$t('短影音安全區')}</label>
    </div>
  );
}

