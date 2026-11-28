/**
 * 素材庫的動畫範本試看：在「預覽」循環播放，不放進專案。
 * 預設用示範畫面（A 畫面上的人、B = 下一個鏡頭；多人範本每個人不同顏色）；
 * timeline = 用時間軸畫面：從播放頭開始，圖片位置照放到時間軸時的規則從底下的片段填。
 */
import type { RenderCtx } from '../engine/renderer';
import { makeClip, useStore, type AnimItem, type Clip, type Media } from '../store';
import { buildAnim, subjectCenter } from '../engine/animPlace';
import { animSampleMedia } from './previewSample';
import type { AnimTrial } from './uiStore';

/** 每圈播完停一下再重播 */
const GAP = 0.6;


type Fmt = { w: number; h: number };
const items = new WeakMap<AnimTrial, AnimItem>();

function trialItem(trial: AnimTrial, time: number, fmt: Fmt): AnimItem | null {
  const hit = items.get(trial);
  if (hit) return hit;
  const s = useStore.getState();
  const track = s.activeTrack?.kind === 'video' ? s.activeTrack.idx : 0;
  const sample = trial.timeline ? null : animSampleMedia(fmt.w, fmt.h);
  // 示範畫面：縮放以示範的人為中心（跟放到時間軸時以主體為中心一樣）
  let item = buildAnim(trial.source, track, time, false, sample ? { center: subjectCenter(sample.people[0], 0, fmt) } : undefined)?.item ?? null;
  if (item && sample) {
    // 示範畫面：主體依序用不同顏色的人、分身用第一個人，背景是空的 A，揭露用 B
    const { scene, people, reveal } = sample;
    let n = 0;
    const pick = (role: string) => role === 'reveal' ? reveal : role === 'background' ? scene : role === 'subject' ? people[n++ % people.length] : people[0];
    item = { ...item, slots: item.slots.map((sl) => sl.role === 'other' ? sl : { ...sl, sourceTime: 0, crop: undefined, mediaId: pick(sl.role).id }) };
  }
  if (item) items.set(trial, item);
  return item;
}

/**
 * 試看畫面：回傳要畫的 ctx 和時間；範本不存在 = null。
 * fmt = 畫面大小（預設專案的輸出比例；素材庫卡片用正方形）。預覽分頁和素材庫卡片都用這個畫，兩邊才會一樣
 */
export function animTrialCtx(base: RenderCtx, trial: AnimTrial, t: number, now: number, fmt: Fmt = useStore.getState().format): { ctx: RenderCtx; t: number } | null {
  const item = trialItem(trial, t, fmt);
  if (!item) return null;
  const el = ((now - trial.t0) / 1000) % (item.duration + GAP);
  const local = Math.min(el, item.duration - 1e-3);
  if (trial.timeline) {
    // 疊在目前畫面最上層（多一條暫時的影片軌），播放頭不動
    const top = base.videoTracks.length;
    const a = { ...item, track: top, start: t - local };
    return { ctx: { ...base, anims: [...base.anims, a], videoTracks: [...base.videoTracks, []] }, t };
  }
  const { scene, people, reveal } = animSampleMedia(fmt.w, fmt.h);
  const under: Clip = { ...makeClip({ mediaId: scene.id, start: 0, duration: item.duration + GAP }), id: 'sample-anim-under', fit: 'cover' };
  const a = { ...item, track: 1, start: 0 };
  return {
    ctx: {
      ...base,
      clips: [under],
      audios: [],
      effects: [],
      anims: [a],
      videoTracks: [[under], []],
      tracks: { video: [{}, {}], fx: [], audio: [] },
      media: new Map([...base.media, ...[scene, ...people, reveal].map((m) => [m.id, m] as const)]),
      linked: new Set(),
    },
    t: local,
  };
}

// ───────────── 還沒放圖的位置：預覽先用示範圖 ─────────────

/** 這個位置沒放圖時，預覽用哪一張示範圖（主體依序用不同顏色的人、分身用第一個人、背景是空的 A、揭露用 B）；文字 = null */
export function placeholderFor(item: AnimItem, slotId: string, fmt: Fmt = useStore.getState().format): Media | null {
  const { scene, people, reveal } = animSampleMedia(fmt.w, fmt.h);
  const slot = item.slots.find((s) => s.id === slotId);
  if (!slot || slot.role === 'other') return null;
  if (slot.role === 'reveal') return reveal;
  if (slot.role === 'background') return scene;
  if (slot.role !== 'subject') return people[0];
  const n = item.slots.filter((s) => s.role === 'subject').findIndex((s) => s.id === slotId);
  return people[Math.max(0, n) % people.length];
}

const filled = new WeakMap<AnimItem, AnimItem>();

/** 一個動畫：還沒放圖的位置換成示範圖（預覽、預覽上的物件框用） */
export function withPlaceholderSlots(a: AnimItem, fmt: Fmt = useStore.getState().format): AnimItem {
  if (!a.slots.some((s) => !s.mediaId && s.role !== 'other')) return a;
  let f = filled.get(a);
  if (!f) {
    f = { ...a, slots: a.slots.map((s) => (s.mediaId || s.role === 'other' ? s : { ...s, mediaId: placeholderFor(a, s.id, fmt)!.id, sourceTime: 0, crop: undefined })) };
    filled.set(a, f);
  }
  return f;
}
const filledCtx = new WeakMap<RenderCtx, RenderCtx>();

/**
 * 預覽用：還沒放圖的位置（待補）畫成示範圖，放上去就看得到動作；只影響預覽，存檔和匯出不變（匯出時待補的位置照樣不畫）。
 */
export function withAnimPlaceholders(ctx: RenderCtx, fmt: Fmt): RenderCtx {
  const hit = filledCtx.get(ctx);
  if (hit) return hit;
  if (!ctx.anims.some((a) => a.slots.some((s) => !s.mediaId && s.role !== 'other'))) return ctx;
  const sample = animSampleMedia(fmt.w, fmt.h);
  const anims = ctx.anims.map((a) => withPlaceholderSlots(a, fmt));
  const out = { ...ctx, anims, media: new Map([...ctx.media, ...[sample.scene, ...sample.people, sample.reveal].map((m) => [m.id, m] as const)]) };
  filledCtx.set(ctx, out);
  return out;
}
