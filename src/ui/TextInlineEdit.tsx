import { useEffect, useRef } from 'react';
import { useStore, type Clip } from '../store';
import { updateText } from '../engine/textAnchor';
import { BOLD_WEIGHT, textPad, textSize } from '../engine/text';

/**
 * 在預覽上直接改文字：雙擊文字片段後，在文字上疊一個透明的輸入框（字是透明的，看到的是畫面上真正渲染的文字，只多一個游標），
 * 邊打邊更新。輸入框的大小、留白、行高照畫面上文字的排版算，再套用片段的旋轉 / 縮放 / 翻轉，游標和反白才會落在對的字上。
 * Esc、Ctrl+Enter 或點外面結束。
 */
export function TextInlineEdit({ clip, box, scaleX, scaleY, H, onClose }: { clip: Clip; box: { cx: number; cy: number; rot: number }; scaleX: number; scaleY: number; H: number; onClose: () => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const frameH = useStore((s) => s.format.h);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);
  const t = clip.text!;
  // 先用「沒有縮放」的大小排版（輸出畫面像素 → 預覽像素），縮放 / 翻轉 / 旋轉交給 transform
  const k = H / frameH;
  const [sw, sh] = textSize(t, frameH); // 以畫面高度為 1
  const pad = textPad(t) * k;
  return (
    <textarea
      ref={ref}
      className="text-inline"
      value={t.text}
      spellCheck={false}
      style={{
        left: box.cx,
        top: box.cy,
        width: sw * H,
        height: sh * H,
        padding: pad,
        transform: `translate(-50%, -50%) rotate(${box.rot}deg) scale(${scaleX || 1}, ${scaleY || 1})`,
        fontFamily: t.font,
        fontSize: t.size * k,
        fontWeight: t.bold ? BOLD_WEIGHT : 400,
        fontStyle: t.italic ? 'italic' : 'normal',
        lineHeight: `${t.size * t.lineHeight * k}px`,
        textAlign: t.align,
      }}
      onChange={(e) => updateText(clip.id, { text: e.target.value })}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation(); // 不要觸發全域快捷鍵（Space 播放、Delete 刪除…）
        if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
          e.preventDefault();
          onClose();
        }
      }}
      onBlur={onClose}
    />
  );
}
