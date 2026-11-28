/**
 * 主體跳出的種類：滑過按鈕時顯示的示意動畫卡片（跟跟拍變速的曲線卡片一樣）
 */
import React, { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { $t } from '../i18n';
import { POP_VARIANTS, type PopVariant } from '../engine/subjectPop';
import { isCombo, type ComboId } from '../engine/animCombos';
import { PERSON_PATH } from './previewSample';

/** 按鈕的順序：原位放大 → 背景 → 進場 → 換畫面 */
export const POP_ORDER: PopVariant[] = ['step', 'shake', 'trail', 'halo', 'spin', 'grid', 'mono', 'dim', 'blur', 'fly', 'textBehind', 'crossShot', 'silhouetteWindow', 'subjectHole'];

/** 人形：跟預覽的示範畫面同一個（座標 0..64 × -24..40，下緣切在畫面底） */
const PERSON = PERSON_PATH;

/** 漸層、斜條紋：跟特效縮圖的示範畫面（A 粉紫、B 青藍）同一套；每張卡片都放一份（id 一樣，內容也一樣） */
const Defs = () => (
  <defs>
    <linearGradient id="pp-ga" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#ff3d6e" /><stop offset="1" stopColor="#6a2c70" /></linearGradient>
    <linearGradient id="pp-gb" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#29d3c2" /><stop offset="1" stopColor="#3a0ca3" /></linearGradient>
    <pattern id="pp-st" width="9" height="9" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="3.2" height="9" fill="#fff" opacity=".16" /></pattern>
  </defs>
);

/** 畫面 A / B（B 中間有個大字 B，看得出換到下一個鏡頭） */
const Bg = ({ b, cls = '' }: { b?: boolean; cls?: string }) => (
  <g className={`pp-bg ${b ? 'b' : 'a'} ${cls}`}>
    <rect x="0" y="-24" width="64" height="64" fill={`url(#pp-g${b ? 'b' : 'a'})`} />
    <rect x="0" y="-24" width="64" height="64" fill="url(#pp-st)" />
    {b && <text className="pp-letter" x="32" y="8">B</text>}
  </g>
);

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

/** 組合動畫範本的名稱 */
export const comboName = (v: ComboId) => ({
  tripleSlide: $t('三人滑入'), duoClash: $t('雙人對撞'), relay: $t('接力換人'), vFormation: $t('V 字排陣'),
  floorLaunch: $t('底部彈出'), diagonalSnap: $t('斜切入鏡'), shadowFirst: $t('影子先到'), zoomEcho: $t('縮放殘影'),
  monoBurst: $t('黑白爆色'), whipSwap: $t('甩鏡換畫'), bodyPortal: $t('人形開門'),
})[v];

/** 內建範本（主體跳出 / 組合）的名稱；不是內建範本 = undefined */
export const templateName = (id: string | undefined) =>
  isCombo(id) ? comboName(id) : id && (POP_VARIANTS as string[]).includes(id) ? animName(id as PopVariant) : undefined;

/** 範本的分組（素材庫的分類籤） */
export const ANIM_GROUPS: { id: string; label: () => string; items: (PopVariant | ComboId)[] }[] = [
  { id: 'multi', label: () => $t('多人'), items: ['tripleSlide', 'duoClash', 'relay', 'vFormation'] },
  { id: 'grow', label: () => $t('原位放大'), items: ['step', 'shake', 'trail', 'halo', 'spin', 'grid', 'zoomEcho'] },
  { id: 'bg', label: () => $t('背景'), items: ['mono', 'dim', 'blur', 'monoBurst'] },
  { id: 'enter', label: () => $t('進場'), items: ['fly', 'floorLaunch', 'diagonalSnap', 'shadowFirst', 'textBehind'] },
  { id: 'swap', label: () => $t('換畫面'), items: ['crossShot', 'whipSwap', 'silhouetteWindow', 'subjectHole', 'bodyPortal'] },
];

/** 範本的示意動畫（正方形；素材庫卡片、滑過的卡片共用） */
export function AnimDemo({ v, size }: { v: string; size?: number }) {
  const id = React.useId().replace(/:/g, '');
  return <svg width={size} height={size} viewBox="0 -24 64 64" className={`pp-demo pp-${v}`} aria-hidden><Defs /><Demo v={v} id={`ppd-${id}`} /></svg>;
}

function Demo({ v, id }: { v: string; id: string }) {
  const bgA = <Bg />;
  const bgB = <Bg b />;
  switch (v) {
    case 'mono': return <><Bg cls="gray" /><Person cls="grow" /></>;
    case 'dim': return <><Bg cls="dark" /><Person cls="grow" /></>;
    case 'blur': return <><Bg cls="soft" /><Person cls="grow" /></>;
    case 'fly': return <>{bgA}<Person cls="fly" /></>;
    case 'textBehind': return <>{bgA}<text className="pp-text" x="32" y="25">TEXT</text><Person cls="grow" /></>;
    case 'trail': return <>{bgA}<Person cls="echo e2" /><Person cls="echo e1" /><Person cls="step" /></>;
    case 'halo': return <>{bgA}<Person cls="halo" /><Person cls="step" /></>;
    case 'spin': return <>{bgA}<Person cls="twin l" x={-14} s={0.7} rot={-18} /><Person cls="twin r" x={14} s={0.7} rot={18} /><Person /></>;
    case 'grid': return <>{bgA}{[0, 1, 2, 3].map((i) => <Person key={i} cls={`quad q${i}`} x={i % 2 ? 16 : -16} y={i < 2 ? -30 : 0} s={0.48} />)}</>;
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
        <defs><mask id={`${id}-h`}><rect x="0" y="-24" width="64" height="64" fill="#fff" /><g className="pp-p win hole"><path d={PERSON} /></g></mask></defs>
        {bgB}<g mask={`url(#${id}-h)`}>{bgA}<Person /></g>
      </>
    );
    // ── 組合 ──
    case 'tripleSlide': return <>{bgA}{[-17, 0, 17].map((x, i) => <Person key={i} cls={`slide s${i}`} x={x} s={0.55} />)}</>;
    case 'duoClash': return <>{bgA}<Person cls="clash l" x={-8} s={0.75} /><Person cls="clash r c2" x={8} s={0.75} /><rect className="pp-hit" x="0" y="-24" width="64" height="64" /></>;
    case 'relay': return <>{bgA}<Person cls="relay r1" /><Person cls="relay r2 c2" /><Person cls="relay r3 c3" /></>;
    case 'vFormation': return <>{bgA}<Person cls="slide s1" x={-17} s={0.55} /><Person cls="slide s2 c3" x={17} s={0.55} /><Person cls="rise c2" s={0.8} /></>;
    case 'floorLaunch': return <>{bgA}<Person cls="launch" /></>;
    case 'diagonalSnap': return <>{bgA}<Person cls="diag" /></>;
    case 'shadowFirst': return <>{bgA}<Person cls="slide s0 shadow" x={-6} /><Person cls="slide s1" /></>;
    case 'zoomEcho': return <>{bgA}<Person cls="zecho z1" s={1.3} /><Person cls="zecho z2" s={1.15} /><Person cls="zpop" /></>;
    case 'monoBurst': return <><Bg cls="gray" /><Person cls="halo" /><Person cls="step" /></>;
    case 'whipSwap': return <><g className="pp-whip out">{bgA}<Person /></g><g className="pp-whip in">{bgB}</g></>;
    case 'bodyPortal': return (
      <>
        <defs><mask id={`${id}-p`}><rect x="0" y="-24" width="64" height="64" fill="#000" /><g className="pp-p portal" fill="#fff"><path d={PERSON} /></g></mask></defs>
        {bgA}<Person /><g mask={`url(#${id}-p)`}>{bgB}</g>
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
      <svg width={96} height={96} viewBox="0 -24 64 64" className={`pp-demo pp-${variant}`} aria-hidden><Defs /><Demo v={variant} id={`ppc-${variant}`} /></svg>
    </div>,
    document.body,
  );
}
