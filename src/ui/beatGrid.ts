/**
 * 時間軸的節拍格線：取得目前專案的節拍、在節拍處分割、依節拍排列片段。
 */
import { $t } from '../i18n';
import { attachedAudioIds, keyOf, laneOf, parseKey, spansOf, useStore, type AnyItem, type Clip } from '../store';
import { beatIndexAtOrAfter, layoutOnBeats, timelineBeats, type Beat } from '../engine/beats';
import { spansOverlap, type Span } from '../engine/overlap';
import { plainSpeed } from '../engine/remap';
import { makeCtx } from '../engine/renderer';
import { toast, useLayout } from './uiStore';

type S = ReturnType<typeof useStore.getState>;

let memo: { audios: S['audios']; clips: S['clips']; media: S['media']; lead: number; beats: Beat[] } | null = null;
/** 節拍提前（秒）：設定裡是 1/60 秒為單位 */
export const beatLead = () => Math.max(0, useLayout.getState().beatLead ?? 5) / 60;
/** 目前專案的節拍（時間軸秒數，已經往前移「節拍提前」）；音訊 / 素材沒變就用上次算好的 */
export function getBeats(s: S = useStore.getState()): Beat[] {
  const lead = beatLead();
  if (memo && memo.audios === s.audios && memo.clips === s.clips && memo.media === s.media && memo.lead === lead) return memo.beats;
  const beats = timelineBeats(s, attachedAudioIds(s), lead);
  memo = { audios: s.audios, clips: s.clips, media: s.media, lead, beats };
  return beats;
}

/** React 用：格線開著才回傳節拍 */
export function useBeats(): Beat[] {
  const on = useLayout((l) => l.beats);
  useLayout((l) => l.beatLead); // 改了節拍提前要重畫
  const audios = useStore((s) => s.audios);
  const clips = useStore((s) => s.clips);
  const media = useStore((s) => s.media);
  if (!on) return [];
  return getBeats({ ...useStore.getState(), audios, clips, media });
}

/** 吸附用的節拍時間（格線關著 = 沒有） */
export const beatSnapPoints = (): number[] => (useLayout.getState().beats ? getBeats().map((b) => b.t) : []);

/** every 拍取一個（以第一個重拍對齊；every = 4 就是每小節） */
function pick(beats: Beat[], every: number): Beat[] {
  if (every <= 1) return beats;
  const d0 = Math.max(0, beats.findIndex((b) => b.down));
  return beats.filter((_, i) => (((i - d0) % every) + every) % every === 0);
}

function noBeats() {
  toast($t('沒有節拍：先在音訊軌放音樂'), 'error');
}

/** 選取的項目在節拍處切開（every：每幾拍切一刀） */
export function splitAtBeats(every: number) {
  const beats = getBeats();
  if (!beats.length) return noBeats();
  if (!useStore.getState().selected.length) return toast($t('先選取要分割的片段'), 'error');
  const n = useStore.getState().splitAtTimes(pick(beats, every).map((b) => b.t));
  toast(n ? $t('已在節拍處切 {0} 刀', n) : $t('選取的片段裡沒有節拍'), n ? undefined : 'error');
}

/** 片段最長多長（一般變速的影片：素材播完為止；圖片 / 文字 / 其他重映射：不限） */
function maxDurOf(c: Clip, s: S): number {
  const m = s.media.find((x) => x.id === c.mediaId);
  if (c.text || !m || m.kind !== 'video' || m.missing) return Infinity;
  const sp = plainSpeed(c, makeCtx(s).modules);
  return sp ? Math.max(0.05, (m.duration - c.in) / sp) : Infinity;
}

/**
 * 依節拍排列選取的片段：每條軌道各自從最接近第一個片段開頭的那一拍開始，每段 every 拍、依序接上。
 * 連結的原音跟著移動 / 修剪。排不下（會撞到沒選的片段）就不動。
 */
export function fitToBeats(every: number) {
  const beats = getBeats();
  if (!beats.length) return noBeats();
  const s = useStore.getState();
  const clips = s.selected.map(parseKey).filter((k) => k.type === 'clip').map((k) => s.clips.find((c) => c.id === k.id)).filter((c): c is Clip => !!c);
  if (!clips.length) return toast($t('先選取要排列的片段'), 'error');

  const patches: Record<string, Partial<AnyItem>> = {};
  const moving = new Set<string>();
  const spans: Span[] = [];
  const byTrack = new Map<number, Clip[]>();
  for (const c of clips) byTrack.set(c.track, [...(byTrack.get(c.track) ?? []), c]);
  for (const list of byTrack.values()) {
    list.sort((a, b) => a.start - b.start);
    // 從最接近第一個片段開頭的那一拍開始
    let b0 = beatIndexAtOrAfter(beats, list[0].start);
    if (b0 > 0 && (b0 >= beats.length || list[0].start - beats[b0 - 1].t < beats[b0].t - list[0].start)) b0--;
    const lay = layoutOnBeats(beats, b0, every, list.map((c) => maxDurOf(c, s)));
    list.forEach((c, i) => {
      const [start, duration] = lay[i];
      patches[keyOf('clip', c.id)] = { start, duration };
      moving.add(keyOf('clip', c.id));
      spans.push({ lane: laneOf('clip', c.track), start, duration });
      // 連結的原音：一起移動、一起修剪（不超過素材長度）
      if (c.link) {
        for (const a of s.audios) {
          if (a.link !== c.link) continue;
          const am = s.media.find((m) => m.id === a.mediaId);
          const amax = am ? (am.duration - a.in) / (a.rate || 1) : Infinity;
          patches[keyOf('audio', a.id)] = { start: a.start + (start - c.start), duration: Math.min(duration, amax) };
          moving.add(keyOf('audio', a.id));
        }
      }
    });
  }
  const others = spansOf(s, moving);
  if (spans.some((m) => others.some((o) => spansOverlap(m, o)))) return toast($t('排不下：會蓋到其他片段'), 'error');
  s.patchItems(patches);
  toast($t('已依節拍排列 {0} 個片段', clips.length));
}
