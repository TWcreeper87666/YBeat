/**
 * 背景運算（AI 去背、臉部偵測、自訂目標追蹤）要不要繼續跑：
 * 每個要求的人（通常是片段）登記一個「還需要嗎」的檢查，全部都不需要了就停下來（已經算好的留著）。
 * 匯出、手動重試這種一定要算完的不給檢查 = 一直需要。
 */
import { useStore, type Clip, type Media, type Module } from '../store';
import { clipSource } from './remap';

export class Need {
  private by = new Map<string, () => boolean>();
  private always = false;
  /** id 一樣的只留最新的（預覽每一格都會要求一次）；沒給 = 一定要算完 */
  add(id?: string, fn?: () => boolean) {
    if (!id || !fn) this.always = true;
    else this.by.set(id, fn);
  }
  live(): boolean {
    if (this.always) return true;
    for (const f of this.by.values()) if (f()) return true;
    return false;
  }
}

/** 片段用到素材的哪一段（修剪、改速度就不一樣） */
export const rangeSig = (c: Clip) => `${c.in}|${c.duration}|${c.rate}|${JSON.stringify(c.remap)}`;

/** 片段還在、而且還需要（ok）：刪掉、修剪、關掉功能都算不需要 */
export function clipStill(clip: Clip, ok: (c: Clip) => boolean): () => boolean {
  const sig = rangeSig(clip);
  return () => {
    const c = useStore.getState().clips.find((x) => x.id === clip.id);
    return !!c && c.mediaId === clip.mediaId && rangeSig(c) === sig && ok(c);
  };
}

/** 片段實際用到的素材時間範圍（變速、曲線都算進去；圖片 = 0） */
export function sourceRange(clip: Clip, media: Media, modules: Map<string, Module>): { from: number; to: number } {
  if (media.kind === 'image') return { from: 0, to: 0 };
  let lo = Infinity, hi = -Infinity;
  const steps = Math.max(2, Math.ceil(clip.duration * 4));
  for (let k = 0; k <= steps; k++) {
    const t = clipSource(clip, (k / steps) * clip.duration, media, modules).src;
    lo = Math.min(lo, t);
    hi = Math.max(hi, t);
  }
  return { from: Math.max(0, lo - 0.1), to: Math.min(media.duration || hi + 0.1, hi + 0.1) };
}
