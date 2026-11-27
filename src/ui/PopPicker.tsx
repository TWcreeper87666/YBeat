/**
 * 主體跳出的種類：滑過按鈕時顯示的示意動畫卡片（跟跟拍變速的曲線卡片一樣）
 */
import React, { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { $t } from '../i18n';
import type { PopVariant } from '../engine/subjectPop';

/** 按鈕的順序：原位放大 → 背景 → 進場 → 換畫面 */
export const POP_ORDER: PopVariant[] = ['step', 'shake', 'trail', 'halo', 'spin', 'grid', 'mono', 'dim', 'blur', 'fly', 'textBehind', 'crossShot', 'silhouetteWindow', 'subjectHole'];

/** 人形：頭 + 肩膀（座標 0..64 × 0..40，腳底在畫面下緣） */
const PERSON = 'M32 9a6 6 0 1 1 0 12a6 6 0 1 1 0-12Z M19 40c0-10 6-16 13-16s13 6 13 16Z';

const Person = ({ cls = '', x = 0, y = 0, s = 1, rot = 0 }: { cls?: string; x?: number; y?: number; s?: number; rot?: number }) => (
  <g className={`pp-p ${cls}`} style={{ '--dx': `${x}px`, '--dy': `${y}px`, '--s': s, '--r': `${rot}deg` } as React.CSSProperties}>
    <path d={PERSON} />
  </g>
);

/** 每一種的示意畫面（class 決定動畫，見 styles.css 的 .pp-*） */
/** 內建動畫範本（舊的主體跳出種類）的名稱 */
export const animName = (v: PopVariant) => ({
  step: $t('逐拍放大'), mono: $t('黑白背景'), fly: $t('飛入'), shake: $t('震閃'),
  crossShot: $t('跨畫面'), textBehind: $t('文字在後'), trail: $t('殘影'), grid: $t('四格'),
  spin: $t('旋轉分身'), dim: $t('暗背景'), halo: $t('描邊光暈'), blur: $t('背景模糊'),
  silhouetteWindow: $t('剪影窗'), subjectHole: $t('主體挖洞'),
})[v];

/** 範本的分組（素材庫的分類籤） */
export const ANIM_GROUPS: { id: string; label: () => string; items: PopVariant[] }[] = [
  { id: 'grow', label: () => $t('原位放大'), items: ['step', 'shake', 'trail', 'halo', 'spin', 'grid'] },
  { id: 'bg', label: () => $t('背景'), items: ['mono', 'dim', 'blur'] },
  { id: 'enter', label: () => $t('進場'), items: ['fly', 'textBehind'] },
  { id: 'swap', label: () => $t('換畫面'), items: ['crossShot', 'silhouetteWindow', 'subjectHole'] },
];

/** 範本的示意動畫（正方形；素材庫卡片、滑過的卡片共用） */
export function AnimDemo({ v, size }: { v: PopVariant; size?: number }) {
  const id = React.useId().replace(/:/g, '');
  return <svg width={size} height={size} viewBox="0 -24 64 64" className={`pp-demo pp-${v}`} aria-hidden><Demo v={v} id={`ppd-${id}`} /></svg>;
}

function Demo({ v, id }: { v: PopVariant; id: string }) {
  const bgA = <rect className="pp-bg a" x="0" y="-24" width="64" height="64" />;
  const bgB = <rect className="pp-bg b" x="0" y="-24" width="64" height="64" />;
  switch (v) {
    case 'mono': return <>{<rect className="pp-bg a gray" x="0" y="-24" width="64" height="64" />}<Person cls="grow" /></>;
    case 'dim': return <>{<rect className="pp-bg a dark" x="0" y="-24" width="64" height="64" />}<Person cls="grow" /></>;
    case 'blur': return <>{<rect className="pp-bg a soft" x="0" y="-24" width="64" height="64" />}<Person cls="grow" /></>;
    case 'fly': return <>{bgA}<Person cls="fly" /></>;
    case 'textBehind': return <>{bgA}<text className="pp-text" x="32" y="25">TEXT</text><Person cls="grow" /></>;
    case 'trail': return <>{bgA}<Person cls="echo e2" /><Person cls="echo e1" /><Person cls="step" /></>;
    case 'halo': return <>{bgA}<Person cls="halo" /><Person cls="step" /></>;
    case 'spin': return <>{bgA}<Person cls="twin l" x={-14} s={0.7} rot={-18} /><Person cls="twin r" x={14} s={0.7} rot={18} /><Person /></>;
    case 'grid': return <>{bgA}{[0, 1, 2, 3].map((i) => <Person key={i} cls={`quad q${i}`} x={i % 2 ? 16 : -16} y={i < 2 ? -20 : 0} s={0.48} />)}</>;
    case 'shake': return <>{bgA}<Person cls="step shake" /><rect className="pp-flash" x="0" y="-24" width="64" height="64" /></>;
    // 這張的主體疊在下一張上面長大，揭露時切成下一張（主體不見）
    case 'crossShot': return <>{bgB}<Person cls="step vanish" /></>;
    case 'silhouetteWindow': return (
      <>
        <defs><mask id={`${id}-w`}><rect x="0" y="-24" width="64" height="64" fill="#000" /><g className="pp-p win" fill="#fff"><path d={PERSON} /></g></mask></defs>
        {bgA}<g mask={`url(#${id}-w)`}>{bgB}</g>
      </>
    );
    case 'subjectHole': return (
      <>
        <defs><mask id={`${id}-h`}><rect x="0" y="-24" width="64" height="64" fill="#fff" /><g className="pp-p win" fill="#000"><path d={PERSON} /></g></mask></defs>
        {bgB}<g mask={`url(#${id}-h)`}>{bgA}<Person /></g>
      </>
    );
    default: return <>{bgA}<Person cls="step" /></>;
  }
}

/** anchor = 要貼著的按鈕；在它上方（放不下就下方）顯示 */
export function PopDemoCard({ anchor, variant, name }: { anchor: HTMLElement; variant: PopVariant; name: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect();
    const card = ref.current!.getBoundingClientRect();
    const left = Math.max(8, Math.min(innerWidth - card.width - 8, r.left + r.width / 2 - card.width / 2));
    const top = r.top - card.height - 8 >= 8 ? r.top - card.height - 8 : r.bottom + 8;
    setPos({ left, top });
  }, [anchor]);
  return createPortal(
    <div ref={ref} className="speed-card pop-card" style={pos ?? { left: -9999, top: -9999 }}>
      <div className="speed-card-name">{name}</div>
      <svg width={96} height={96} viewBox="0 -24 64 64" className={`pp-demo pp-${variant}`} aria-hidden><Demo v={variant} id={`ppc-${variant}`} /></svg>
    </div>,
    document.body,
  );
}
