import { $t } from '../i18n';
import type { AnimItem, AnimSlot } from '../engine/animation';

/** i = 同一種的第幾個（0 = 只有一個，不編號） */
const roleName = (s: AnimSlot, i: number) => ({
  subject: i ? $t('主體 {0}', i) : $t('主體'), background: $t('背景'), reveal: $t('揭露'), copy: $t('分身 {0}', i), other: $t('文字'),
} as Record<AnimSlot['role'], string>)[s.role];

/** 每個圖片位置顯示的名稱（屬性面板、預覽上的框共用）：分身一律編號；主體有好幾個才編號 */
export function slotNames(a: AnimItem): Map<string, string> {
  const nth: Partial<Record<AnimSlot['role'], number>> = {};
  const manySubjects = a.slots.filter((s) => s.role === 'subject').length > 1;
  return new Map(a.slots.map((s) => {
    const n = (nth[s.role] = (nth[s.role] ?? 0) + 1);
    return [s.id, roleName(s, s.role === 'copy' || (s.role === 'subject' && manySubjects) ? n : 0)];
  }));
}
