import { $t } from '../i18n';
import { useStore } from '../store';
import { copyAnimImages, pasteAnimImages, slotClipboardCount, usedImageSlots } from '../engine/animPlace';
import { toast, type MenuItem } from './uiStore';

/**
 * 圖片的複製 / 貼上選單（屬性面板的圖片區塊、每一列、時間軸上的動畫方塊共用）：
 * 整個圖片列表一起複製 / 貼上；在某一列上另外有只複製這張 / 只換這張
 */
export function imageMenu(animIds: string[], slotId?: string): MenuItem[] {
  const one = animIds.length === 1 ? useStore.getState().anims.find((x) => x.id === animIds[0]) : undefined;
  const filled = one ? usedImageSlots(one).filter((s) => s.mediaId) : [];
  const n = slotClipboardCount();
  const paste = (only?: string) => () => { if (!pasteAnimImages(animIds, only)) toast($t('沒有可以貼上的圖片'), 'error'); };
  const items: MenuItem[] = [
    { label: $t('複製圖片（{0}）', filled.length), action: filled.length ? () => void copyAnimImages(one!.id) : undefined },
    { label: n ? $t('貼上圖片（{0}）', n) : $t('貼上圖片'), action: n ? paste() : undefined },
  ];
  if (slotId) items.push(
    { separator: true },
    { label: $t('複製這張'), action: filled.some((s) => s.id === slotId) ? () => void copyAnimImages(one!.id, slotId) : undefined },
    { label: $t('貼到這張'), action: n ? paste(slotId) : undefined },
  );
  return items;
}
