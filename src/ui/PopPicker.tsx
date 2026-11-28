/**
 * 動畫範本的名稱、分組；自動剪輯「主體跳出」按鈕滑過時的示意卡片（跟預覽、素材庫卡片同一套畫法）
 */
import React, { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { $t } from '../i18n';
import { POP_VARIANTS, type PopVariant } from '../engine/subjectPop';
import { isCombo, type ComboId } from '../engine/animCombos';
import { AnimLive } from './AnimThumb';

/** 按鈕的順序：原位放大 → 背景 → 進場 → 換畫面 */
export const POP_ORDER: PopVariant[] = ['step', 'shake', 'trail', 'halo', 'spin', 'grid', 'mono', 'dim', 'blur', 'fly', 'textBehind', 'crossShot', 'silhouetteWindow', 'subjectHole'];

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
      <div className="pop-card-live"><AnimLive source={variant} /></div>
    </div>,
    document.body,
  );
}
