/**
 * 自動剪輯的素材清單：從素材分頁把影片 / 圖片拖到自動剪輯分頁 → 選範圍加入（按住 Alt = 整段）。
 * 同一支影片可以加很多段，片段可以改名。「全部素材」時清單列出素材庫每個素材；改了任何一列就變成自選清單（可以清空）。
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { Crop as CropIcon, Images, Pencil, X } from 'lucide-react';
import { $t } from '../i18n';
import { mediaUsable, uid, useStore, type Clip, type Media } from '../store';
import { sourceRange } from '../engine/jobNeed';
import { tc } from '../engine/rulerTicks';
import { aeSong, footage, useAutoEdit, wholeSeg, type AeSeg } from '../engine/autoEditSettings';
import { revealMedia, useDock } from './Dock';
import { RangePicker, isFullCrop, type Crop } from './RangePicker';
import { openSource, pausePreviews, useSource } from './SourcePanel';
import { focusLibrary } from './uiStore';

export const roleName = (k: string) => ({ intro: $t('開頭'), build: $t('鋪陳'), drop: $t('高潮'), body: $t('主體'), outro: $t('結尾') } as Record<string, string>)[k] ?? k;

/** 選範圍的對話框：segId = 編輯既有的片段（沒有 = 新增）；queue = 接著要選的其他影片 */
interface RangeReq { mediaId: string; segId?: string; a: number; b: number; queue: string[]; /** 從「素材庫全部」那一列打開：確定時把清單展開、換掉這個素材的整段 */ implicit?: boolean }
const useRange = create<{ req: RangeReq | null }>(() => ({ req: null }));

const segsNow = () => useAutoEdit.getState().segs;
const setSegs = (segs: AeSeg[]) => { pausePreviews(); useAutoEdit.getState().set({ segs, pick: 'list' }); };
const listMode = () => useAutoEdit.getState().pick === 'list';
/** 「全部素材」時，先把素材庫展開成整段的片段，再做修改 */
const explicit = (): AeSeg[] => (listMode() ? segsNow() : footage(useStore.getState()).map((m) => wholeSeg(m, uid())));
/**
 * 加進清單：清單是空的（= 素材庫全部）時先展開成整段，同一個素材的那一列換成新加的（位置不變）；
 * 已經有一模一樣的（同素材、同範圍）就不重複加
 */
function addSegs(list: AeSeg[]) {
  const implicit = !listMode();
  const out: AeSeg[] = [];
  const rest = [...list];
  for (const g of explicit()) {
    const i = implicit ? rest.findIndex((n) => n.mediaId === g.mediaId) : -1;
    if (i >= 0) out.push(...rest.splice(i, 1));
    else out.push(g);
  }
  for (const n of rest) if (!out.some((g) => g.mediaId === n.mediaId && g.a === n.a && g.b === n.b && JSON.stringify(g.crop) === JSON.stringify(n.crop))) out.push(n);
  setSegs(out);
}

/** 素材拖進自動剪輯分頁：圖片 / 按住 Alt / 多選 → 整段加入；單一影片 → 選範圍 */
export function dropToAutoEdit(ids: string[], all: boolean) {
  const media = useStore.getState().media;
  const list = ids.map((id) => media.find((m) => m.id === id)).filter((m): m is Media => mediaUsable(m) && m.kind !== 'audio');
  if (!list.length) return;
  useDock.getState().activatePanel('auto');
  // 素材分頁也選中拖進來的；預覽先停
  focusLibrary(list.map((m) => m.id));
  pausePreviews();
  const videos = list.filter((m) => m.kind === 'video');
  if (all || list.length > 1 || !videos.length) return addSegs(list.map((m) => wholeSeg(m, uid())));
  openRange(videos[0]);
}

function openRange(m: Media, seg?: AeSeg, queue: string[] = [], implicit = false) {
  pausePreviews();
  useRange.setState({ req: { mediaId: m.id, segId: seg?.id, a: seg?.a ?? 0, b: seg?.b ?? m.duration, queue, implicit } });
}

const fmt = (t: number) => tc(t);

// ───────────── 從時間軸片段找回清單 ─────────────

/** 時間軸片段用到的素材範圍（圖片 = null） */
function clipSpan(c: Clip, m: Media): { from: number; to: number } | null {
  if (m.kind !== 'video') return null;
  const s = useStore.getState();
  return sourceRange(c, m, new Map(s.modules.map((x) => [x.id, x])));
}
const overlap = (g: AeSeg, r: { from: number; to: number }) => Math.min(g.b, r.to) - Math.max(g.a, r.from);

/** 片段用到的素材在自動剪輯清單裡的那一列（全部素材 = 素材 id；自選清單 = 重疊最多的那段）；不在清單裡 = null */
export function aeRowOf(c: Clip): { mediaId: string; segId?: string } | null {
  const s = useStore.getState();
  const m = footage(s).find((x) => x.id === c.mediaId);
  if (!m) return null;
  if (!listMode()) return { mediaId: m.id };
  const r = clipSpan(c, m);
  let best: AeSeg | null = null, most = 0;
  for (const g of segsNow()) {
    if (g.mediaId !== m.id) continue;
    const o = r ? overlap(g, r) : 1;
    if (o > most) { most = o; best = g; }
  }
  return best ? { mediaId: m.id, segId: best.id } : null;
}

/** 把這些片段用到的範圍從清單扣掉（同一段的其他部分留著；太短的剩餘丟掉）；回傳扣了幾個片段 */
export function removeClipsFromAutoEdit(clips: Clip[]): number {
  const s = useStore.getState();
  let list = explicit();
  let n = 0;
  for (const c of clips) {
    const m = footage(s).find((x) => x.id === c.mediaId);
    if (!m) continue;
    const r = clipSpan(c, m);
    const next: AeSeg[] = [];
    let hit = false;
    for (const g of list) {
      if (g.mediaId !== m.id || (r && overlap(g, r) <= 0)) { next.push(g); continue; }
      hit = true;
      if (!r) continue; // 圖片：整個拿掉
      if (r.from - g.a >= 0.2) next.push({ ...g, b: r.from });
      if (g.b - r.to >= 0.2) next.push({ ...g, id: r.from - g.a >= 0.2 ? uid() : g.id, a: r.to });
    }
    if (hit) { list = next; n++; }
  }
  if (n) setSegs(list);
  return n;
}

/** 要清單捲到、選中的那一列；n 變了才動作 */
export const useAeFocus = create<{ mediaId: string; segId?: string; n: number }>(() => ({ mediaId: '', n: 0 }));
/** 已經處理過的 n（切到分頁時清單才掛上，掛上時再處理） */
let focusDone = 0;

export function revealInAutoEdit(c: Clip) {
  const row = aeRowOf(c);
  if (!row) return;
  useDock.getState().activatePanel('auto');
  useAeFocus.setState((x) => ({ ...row, n: x.n + 1 }));
}

// ───────────── 清單 ─────────────

export function SegList() {
  const segs = useAutoEdit((x) => x.segs);
  const list = useAutoEdit((x) => x.pick === 'list');
  const direction = useAutoEdit((x) => (x.director ? x.direction : null));
  const media = useStore((x) => x.media);
  const src = useSource((x) => (x.open ? `${x.mediaId}:${x.range?.join('-') ?? ''}` : null));
  const [renaming, setRenaming] = useState<string | null>(null);
  // 全部素材：每個素材一列（id = 素材 id）
  const rows: { seg: AeSeg; m: Media; implicit: boolean }[] = list
    ? segs.flatMap((g) => { const m = media.find((x) => x.id === g.mediaId); return m ? [{ seg: g, m, implicit: false }] : []; })
    : footage({ ...useStore.getState(), media }).map((m) => ({ seg: wholeSeg(m, m.id), m, implicit: true }));

  /** 對清單空的狀態做修改：先展開，再找到同一個素材的那一列 */
  const edit = (row: { seg: AeSeg; implicit: boolean }, fn: (list: AeSeg[], g: AeSeg) => AeSeg[]) => {
    const list = row.implicit ? explicit() : segsNow();
    const g = row.implicit ? list.find((x) => x.mediaId === row.seg.mediaId) : list.find((x) => x.id === row.seg.id);
    if (g) setSegs(fn(list, g));
  };
  /** 選取一列 = 在預覽面板看（片段只循環播那一段，有裁切就顯示框）；autoplay = false：只選取、不播（例如按鉛筆編輯） */
  const preview = (g: AeSeg, m: Media, video: boolean, autoplay = true) =>
    openSource(m.id, video && (g.a > 0 || g.b < m.duration - 0.01) ? [g.a, g.b] : null, g.name ?? null, { crop: g.crop && !isFullCrop(g.crop) ? g.crop : null, autoplay });
  // 從時間軸跳過來：捲到那一列、亮一下、在預覽面板看
  const focus = useAeFocus((x) => x.n);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focus || focus === focusDone) return;
    focusDone = focus;
    const f = useAeFocus.getState();
    const row = rows.find((r) => (r.implicit ? r.m.id === f.mediaId : r.seg.id === f.segId));
    if (!row) return;
    preview(row.seg, row.m, row.m.kind === 'video', false);
    const el = box.current?.querySelector<HTMLElement>(`[data-seg="${CSS.escape(row.seg.id)}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'nearest' });
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1300);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);
  if (!rows.length) return <div className="ae-empty">{list ? $t('把素材拖到這裡') : $t('沒有可用的素材')}</div>;
  return (
    <div className="ae-segs" ref={box}>
      {rows.map((row) => {
        const { seg: g, m } = row;
        const video = m.kind === 'video';
        const ranged = video && (g.a > 0 || g.b < m.duration - 0.01);
        const d = direction?.[row.implicit ? m.id : video ? `${m.id}@${g.id}` : m.id];
        const on = src === `${m.id}:${ranged ? `${g.a}-${g.b}` : ''}`;
        return (
          <div key={g.id} data-seg={g.id} className={`ae-seg ${on ? 'on' : ''} ${d?.weight === 0 ? 'dim' : ''}`} onClick={() => preview(g, m, video)}>
            {m.thumb && <img src={m.thumb} alt="" />}
            {renaming === g.id ? (
              <input
                className="text-input ae-seg-name" autoFocus defaultValue={g.name ?? m.name}
                onClick={(e) => e.stopPropagation()}
                onFocus={(e) => e.currentTarget.select()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                  else if (e.key === 'Escape') setRenaming(null);
                  e.stopPropagation();
                }}
                onBlur={(e) => {
                  if (renaming !== g.id) return;
                  const v = e.currentTarget.value.trim();
                  setRenaming(null);
                  if (v !== (g.name ?? m.name)) edit(row, (list, x) => list.map((y) => (y === x ? { ...y, name: v && v !== m.name ? v : undefined } : y)));
                }}
              />
            ) : (
              <span className="ae-seg-name" title={m.name} onDoubleClick={(e) => (e.stopPropagation(), setRenaming(g.id))}>{g.name ?? m.name}</span>
            )}
            {d && <em className="ae-role" title={d.note}>{d.weight === 0 ? $t('不用') : d.roles.map(roleName).join(' · ')}</em>}
            {g.crop && <CropIcon size={11} className="ae-crop" aria-label={$t('已裁切')} />}
            <span className="ae-stat">{!video ? $t('圖片') : ranged ? `${fmt(g.a)} – ${fmt(g.b)}` : fmt(m.duration)}</span>
            <span className="ae-seg-btns" onClick={(e) => e.stopPropagation()}>
              {video && <button className="ec-icon" title={$t('調整範圍')} onClick={() => { preview(g, m, video, false); openRange(m, row.implicit ? undefined : g, [], row.implicit); }}><Pencil size={12} /></button>}
              <button className="ec-icon" title={$t('在素材分頁顯示')} onClick={() => revealMedia(m.id)}><Images size={12} /></button>
              <button className="ec-icon" title={$t('移除')} onClick={() => edit(row, (list, x) => list.filter((y) => y !== x))}><X size={12} /></button>
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ───────────── 選範圍 ─────────────

/** 選歌的範圍的視窗：mediaId = 換成這首歌（沒有 = 改目前這首） */
const useSongRange = create<{ mediaId: string | null }>(() => ({ mediaId: null }));

/** 選範圍的視窗（素材或歌）開著：面板的試聽不要跟視窗的播放搶快捷鍵 */
export const aeDialogOpen = () => !!useRange.getState().req || !!useSongRange.getState().mediaId;
/** 選範圍的視窗打開時通知（面板的試聽先停） */
export function onAeDialogOpen(cb: () => void) {
  useRange.subscribe((s, p) => { if (s.req && !p.req) cb(); });
  useSongRange.subscribe((s, p) => { if (s.mediaId && !p.mediaId) cb(); });
}
export const openSongRange = (mediaId?: string) => {
  const m = mediaId ?? aeSong(useStore.getState(), useAutoEdit.getState())?.mediaId;
  if (m) { pausePreviews(); useSongRange.setState({ mediaId: m }); }
};

/** 歌拖進自動剪輯分頁：按住 Alt = 整首；不然選範圍 */
export function dropSong(mediaId: string, whole: boolean) {
  const m = useStore.getState().media.find((x) => x.id === mediaId);
  if (!m) return;
  useDock.getState().activatePanel('auto');
  if (whole) useAutoEdit.getState().set({ song: { mediaId, a: 0, b: m.duration } });
  else openSongRange(mediaId);
}

function SongRangeDialog() {
  const mediaId = useSongRange((x) => x.mediaId);
  const m = useStore((x) => (mediaId ? x.media.find((y) => y.id === mediaId) : undefined));
  if (!mediaId || !m) return null;
  const cur = aeSong(useStore.getState(), useAutoEdit.getState());
  // 換歌：從整首開始、副歌重新標；同一首：手動標的副歌留著（範圍外的不算）
  const song = cur?.mediaId === m.id ? cur : { mediaId: m.id, a: 0, b: m.duration };
  const close = () => useSongRange.setState({ mediaId: null });
  const commit = (a: number, b: number) => {
    const chorus = (song.chorus ?? []).filter((t) => t >= a - 0.5 && t <= b + 0.5);
    // 分段：範圍外的丟掉、跨出去的截掉
    const zones = (song.zones ?? []).filter((z) => z.t1 > a + 0.05 && z.t0 < b - 0.05).map((z) => ({ ...z, t0: Math.max(a, z.t0), t1: Math.min(b, z.t1) }));
    useAutoEdit.getState().set({ song: { mediaId: m.id, a, b, ...(chorus.length ? { chorus } : {}), ...(zones.length ? { zones } : {}) } });
  };
  return createPortal(<RangePicker key={m.id} m={m} init={{ a: song.a, b: song.b }} editing onCommit={commit} onClose={close} />, document.body);
}

export function AeRangeDialog() {
  const req = useRange((x) => x.req);
  const m = useStore((x) => (req ? x.media.find((y) => y.id === req.mediaId) : undefined));
  if (!req || !m || m.kind !== 'video') return <SongRangeDialog />;
  // 放到 body：自動剪輯分頁有 container-type（會變成 fixed 元素的定位框）和 overflow: hidden，放在裡面會被框住、裁掉
  return createPortal(<RangeDialog key={`${req.mediaId}:${req.segId ?? ''}`} req={req} m={m} />, document.body);
}

function RangeDialog({ req, m }: { req: RangeReq; m: Media }) {
  const others = useAutoEdit((x) => x.segs.filter((g) => g.mediaId === m.id && g.id !== req.segId));
  const close = () => {
    const next = req.queue[0] && useStore.getState().media.find((x) => x.id === req.queue[0]);
    if (next) openRange(next, undefined, req.queue.slice(1));
    else useRange.setState({ req: null });
  };
  const commit = (a: number, b: number, c?: Crop) => {
    const crop = isFullCrop(c) ? undefined : c;
    if (req.segId) setSegs(segsNow().map((g) => (g.id === req.segId ? { ...g, a, b, crop } : g)));
    else if (req.implicit && !listMode()) setSegs(explicit().map((g) => (g.mediaId === m.id ? { ...g, a, b, crop } : g)));
    else addSegs([{ id: uid(), mediaId: m.id, a, b, ...(crop ? { crop } : {}) }]);
    // 預覽面板正在看這個片段（按鉛筆編輯時選取的）：換成改好的範圍 / 裁切框
    if (req.segId || req.implicit) {
      const src = useSource.getState();
      if (src.open && src.mediaId === m.id) openSource(m.id, a > 0 || b < m.duration - 0.01 ? [a, b] : null, src.label, { crop: crop ?? null, autoplay: false });
    }
  };
  const initCrop = req.segId ? segsNow().find((g) => g.id === req.segId)?.crop : undefined;
  return <RangePicker m={m} init={{ a: req.a, b: req.b }} initCrop={initCrop} crop others={others} editing={!!req.segId} onCommit={commit} onClose={close} />;
}
