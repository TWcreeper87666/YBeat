/**
 * 片段追蹤（臉部 / 自訂目標）共用的介面狀態：進度 / 錯誤 / 重試、預覽上的框選模式。
 */
import { useEffect, useMemo } from 'react';
import { create } from 'zustand';
import { useStore, type Clip, type Media } from '../store';
import { requestFaces, useFaces } from '../engine/face';
import { retryBoxTrack, trackKey, useBoxTracks } from '../engine/boxTrack';
import { requestSubject, tracking } from '../engine/follow';

/** 預覽上框選目標中的片段（null = 沒有在框選） */
export const useBoxPick = create<{ clipId: string | null; mode: 'subject' | 'lead' }>(() => ({ clipId: null, mode: 'subject' }));

/** 開始框選：停止播放、選取片段，時間不在片段裡就移到片段開頭 */
export function startBoxPick(clipId: string, mode: 'subject' | 'lead' = 'subject') {
  const s = useStore.getState();
  const c = s.clips.find((x) => x.id === clipId);
  if (!c) return;
  const inside = s.time >= c.start && s.time < c.start + c.duration;
  useStore.setState({ playing: false, ...(inside ? {} : { time: c.start }) });
  s.select({ type: 'clip', id: clipId });
  useBoxPick.setState({ clipId, mode });
}
export const startLeadPick = (clipId: string) => startBoxPick(clipId, 'lead');
export const stopBoxPick = () => useBoxPick.getState().clipId && useBoxPick.setState({ clipId: null });

/** 片段追蹤的進度 / 錯誤（開著就在背景算）；retry = 清掉錯誤重算 */
export function useSubjectStatus(clip: Clip, media: Media | undefined) {
  const modules = useStore((s) => s.modules);
  const map = useMemo(() => new Map(modules.map((m) => [m.id, m])), [modules]);
  const s = clip.subject;
  const key = media && s?.kind === 'box' ? trackKey(media.id, s.anchors) : '';
  const faceJob = useFaces((f) => (s?.kind === 'face' && media ? f.jobs[media.id] : undefined));
  const faceErr = useFaces((f) => (s?.kind === 'face' && media ? f.errors[media.id] : undefined));
  const boxJob = useBoxTracks((b) => (key ? b.jobs[key] : undefined));
  const boxErr = useBoxTracks((b) => (key ? b.errors[key] : undefined));
  useEffect(() => requestSubject(clip, media, map), [clip, media, map]);
  const retry = () => {
    if (!media || !s) return;
    if (s.kind === 'box') return retryBoxTrack(clip, media, s.anchors, map);
    const e = { ...useFaces.getState().errors };
    delete e[media.id];
    useFaces.setState({ errors: e });
    requestFaces(clip, media, map);
  };
  const job = faceJob ?? boxJob;
  return { on: tracking(clip), job, pct: job ? Math.round((job.done / Math.max(1, job.total)) * 100) : null, err: faceErr ?? boxErr, retry };
}
