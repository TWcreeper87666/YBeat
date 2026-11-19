import { $t, displayName } from '../i18n';
import type { AnyItem, AudioClip, Clip, FxItem, ItemType, Media, Module } from '../store';

/** 時間軸項目顯示的名稱：使用者取的名字 > 文字內容 / 素材名稱 / 模組名稱 */
export function itemName(type: ItemType, it: AnyItem, media: Media[], modules: Module[]): string {
  if (it.name) return it.name;
  if (type === 'clip') {
    const c = it as Clip;
    if (c.text) return c.text.text.split('\n')[0] || ' ';
    return media.find((m) => m.id === c.mediaId)?.name ?? $t('未知素材');
  }
  if (type === 'audio') return media.find((m) => m.id === (it as AudioClip).mediaId)?.name ?? $t('未知素材');
  const m = modules.find((x) => x.id === (it as FxItem).moduleId);
  return m ? displayName(m.name) : $t('（遺失模組）');
}
