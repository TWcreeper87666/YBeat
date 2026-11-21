import React, { useRef } from 'react';
import { $t } from '../i18n';
import { EASE_PRESETS, bezierY, easeId, evalKeys, type Bez, type Ease } from '../engine/keyframes';

/** 小型緩動預設按鈕（直接看形狀選） */
export function EasePresetsMini({ current, onPick }: { current: string; onPick: (e: Ease) => void }) {
  return (
    <div className="ease-mini">
      {EASE_PRESETS.map((p) => {
        const d: string[] = [];
        for (let i = 0; i <= 16; i++) {
          const x = i / 16;
          const y = p.ease === 'hold' ? (x < 1 ? 0 : 1) : evalKeys([{ id: 'a', t: 0, v: 0, ease: p.ease }, { id: 'b', t: 1, v: 1, ease: p.ease }], x);
          d.push(`${2 + x * 20},${20 - y * 16}`);
        }
        return (
          <button key={p.id} className={current === p.id ? 'on' : ''} title={p.label} onClick={() => onPick(p.ease)}>
            <svg width={24} height={24}><polyline points={d.join(' ')} /></svg>
          </button>
        );
      })}
    </div>
  );
}

const W = 168, H = 96, PAD = 10;
const round = (n: number) => Math.round(n * 1000) / 1000;

/** curve 參數：cubic-bezier 曲線（拖兩個把手，或選預設） */
export function CurveEdit({ value, onChange }: { value: Bez; onChange: (v: Bez) => void }) {
  const ref = useRef<SVGSVGElement>(null);
  // 縱軸範圍跟著把手撐開（過衝回彈會超出 0..1）
  const lo = Math.min(0, value[1], value[3]), hi = Math.max(1, value[1], value[3]);
  const X = (x: number) => PAD + x * (W - PAD * 2);
  const Y = (y: number) => H - PAD - ((y - lo) / (hi - lo)) * (H - PAD * 2);
  const pts: string[] = [];
  for (let i = 0; i <= 48; i++) pts.push(`${X(i / 48).toFixed(1)},${Y(bezierY(value, i / 48)).toFixed(1)}`);
  const drag = (e: React.PointerEvent, which: 0 | 1) => {
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget as Element;
    el.setPointerCapture(e.pointerId);
    const r = ref.current!.getBoundingClientRect();
    // 拖曳期間縱軸範圍固定，不然把手會跟著範圍跑
    const l0 = lo, h0 = hi;
    const move = (ev: PointerEvent) => {
      const x = Math.min(1, Math.max(0, (ev.clientX - r.left - PAD) / (W - PAD * 2)));
      const y = l0 + ((H - PAD - (ev.clientY - r.top)) / (H - PAD * 2)) * (h0 - l0);
      const b = [...value] as Bez;
      b[which * 2] = round(x);
      b[which * 2 + 1] = round(y);
      onChange(b);
    };
    const up = () => {
      el.removeEventListener('pointermove', move as EventListener);
      el.removeEventListener('pointerup', up);
    };
    el.addEventListener('pointermove', move as EventListener);
    el.addEventListener('pointerup', up);
  };
  const id = easeId(value);
  return (
    <div className="curve-edit">
      <svg ref={ref} width={W} height={H} className="curve-edit-svg" onDoubleClick={() => onChange([0.42, 0, 0.58, 1])}>
        <line className="cg-grid" x1={X(0)} x2={X(1)} y1={Y(0)} y2={Y(0)} />
        <line className="cg-grid" x1={X(0)} x2={X(1)} y1={Y(1)} y2={Y(1)} />
        <polyline className="cg-curve" points={pts.join(' ')} />
        <g className="cg-handles">
          <line x1={X(0)} y1={Y(0)} x2={X(value[0])} y2={Y(value[1])} />
          <line x1={X(1)} y1={Y(1)} x2={X(value[2])} y2={Y(value[3])} />
          <circle r={6} cx={X(value[0])} cy={Y(value[1])} onPointerDown={(e) => drag(e, 0)} />
          <circle r={6} cx={X(value[2])} cy={Y(value[3])} onPointerDown={(e) => drag(e, 1)} />
        </g>
      </svg>
      <select className="select" value={id} onChange={(e) => { const p = EASE_PRESETS.find((x) => x.id === e.target.value); if (p && p.ease !== 'hold') onChange([...p.ease] as Bez); }}>
        {id === 'custom' && <option value="custom">{$t('自訂曲線')}</option>}
        {EASE_PRESETS.filter((p) => p.ease !== 'hold').map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
      </select>
    </div>
  );
}
