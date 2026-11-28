/**
 * 素材庫的動畫範本試看：在「預覽」循環播放，不放進專案。
 * 預設用示範畫面（A 畫面上的人、B = 下一個鏡頭；多人範本每個人不同顏色）；
 * timeline = 用時間軸畫面：從播放頭開始，圖片位置照放到時間軸時的規則從底下的片段填。
 */
import type { RenderCtx } from '../engine/renderer';
import { makeClip, useStore, type AnimItem, type Clip } from '../store';
import { buildAnim } from '../engine/animPlace';
import { animSampleMedia } from './previewSample';
import type { AnimTrial } from './uiStore';

/** 每圈播完停一下再重播 */
const GAP = 0.6;

let cache: { key: AnimTrial; item: AnimItem } | null = null;

function trialItem(trial: AnimTrial, time: number): AnimItem | null {
  if (cache?.key === trial) return cache.item;
  const s = useStore.getState();
  const track = s.activeTrack?.kind === 'video' ? s.activeTrack.idx : 0;
  let item = buildAnim(trial.source, track, time, false)?.item ?? null;
  if (item && !trial.timeline) {
    // 示範畫面：主體依序用不同顏色的人、分身用第一個人，背景是空的 A，揭露用 B
    const { scene, people, reveal } = animSampleMedia(s.format.w, s.format.h);
    let n = 0;
    const pick = (role: string) => role === 'reveal' ? reveal : role === 'background' ? scene : role === 'subject' ? people[n++ % people.length] : people[0];
    item = { ...item, slots: item.slots.map((sl) => sl.role === 'other' ? sl : { ...sl, sourceTime: 0, crop: undefined, mediaId: pick(sl.role).id }) };
  }
  if (item) cache = { key: trial, item };
  return item;
}

/** 試看畫面：回傳要畫的 ctx 和時間；範本不存在 = null */
export function animTrialCtx(base: RenderCtx, trial: AnimTrial, t: number, now: number): { ctx: RenderCtx; t: number } | null {
  const item = trialItem(trial, t);
  if (!item) return null;
  const el = ((now - trial.t0) / 1000) % (item.duration + GAP);
  const local = Math.min(el, item.duration - 1e-3);
  if (trial.timeline) {
    // 疊在目前畫面最上層（多一條暫時的影片軌），播放頭不動
    const top = base.videoTracks.length;
    const a = { ...item, track: top, start: t - local };
    return { ctx: { ...base, anims: [...base.anims, a], videoTracks: [...base.videoTracks, []] }, t };
  }
  const { scene, people, reveal } = animSampleMedia(useStore.getState().format.w, useStore.getState().format.h);
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
