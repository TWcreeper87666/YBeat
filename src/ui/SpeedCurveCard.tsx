/**
 * 跟拍變速的種類：滑過時顯示的曲線卡片（橫軸 = 時間、縱軸 = 播到素材的哪裡；虛線 = 正常速度）。
 */
import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { speedCurve, speedSourceAt, type SpeedVariant } from '../engine/speedRamp';

/** 示範用：4 拍、每拍 0.5 秒 */
const BEATS = 4;
const T = (b: number) => b * 0.5;

function curvePath(variant: SpeedVariant, intensity: number, W: number, H: number): { line: string; ref: string; beats: number[] } | null {
  const sp = speedCurve(variant, 0, BEATS, T, intensity, { hitBeat: 2 });
  if (!sp) return null;
  const D = T(BEATS);
  const lo = Math.min(0, sp.sourceMin), hi = Math.max(D, sp.sourceMax);
  const pad = 6;
  const x = (t: number) => pad + (t / D) * (W - 2 * pad);
  const y = (v: number) => H - pad - ((v - lo) / Math.max(1e-6, hi - lo)) * (H - 2 * pad);
  const pts: string[] = [];
  const N = 120;
  for (let i = 0; i <= N; i++) {
    const t = (i / N) * D;
    pts.push(`${i ? 'L' : 'M'}${x(t).toFixed(1)},${y(speedSourceAt(sp, 0, T, t)).toFixed(1)}`);
  }
  return { line: pts.join(''), ref: `M${x(0)},${y(0)}L${x(D)},${y(D)}`, beats: Array.from({ length: BEATS + 1 }, (_, i) => x(T(i))) };
}

/** anchor = 要貼著的元素（按鈕）；在它上方（放不下就下方）顯示 */
export function SpeedCurveCard({ anchor, variant, name, intensity }: { anchor: HTMLElement; variant: SpeedVariant; name: string; intensity: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect();
    const card = ref.current!.getBoundingClientRect();
    const left = Math.max(8, Math.min(innerWidth - card.width - 8, r.left + r.width / 2 - card.width / 2));
    const top = r.top - card.height - 8 >= 8 ? r.top - card.height - 8 : r.bottom + 8;
    setPos({ left, top });
  }, [anchor]);
  const W = 96, H = 96;
  const c = curvePath(variant, intensity, W, H);
  return createPortal(
    <div ref={ref} className="speed-card" style={pos ?? { left: -9999, top: -9999 }}>
      <div className="speed-card-name">{name}</div>
      {c && (
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
          {c.beats.map((bx, i) => <line key={i} className="beat" x1={bx} x2={bx} y1={0} y2={H} />)}
          <path className="ref" d={c.ref} />
          <path className="curve" d={c.line} />
        </svg>
      )}
    </div>,
    document.body,
  );
}
