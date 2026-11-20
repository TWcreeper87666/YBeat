import type { Media } from '../store';

/** 隱藏但保留素材，讓時間軸的 Ctrl+Z 可以還原最後一個引用。 */
export const detachedMedia = new Map<string, Media>();
export const detachedMediaOrder = new Map<string, number>();

export function clearDetachedMedia() {
  for (const m of detachedMedia.values()) if (m.url.startsWith('blob:')) URL.revokeObjectURL(m.url);
  detachedMedia.clear();
  detachedMediaOrder.clear();
}
