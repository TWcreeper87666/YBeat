/**
 * 自動剪輯的素材清單：從素材分頁把影片 / 圖片拖到自動剪輯分頁 → 選範圍加入（按住 Alt = 整段）。
 * 同一支影片可以加很多段，片段可以改名。「全部素材」時清單列出素材庫每個素材；改了任何一列就變成自選清單（可以清空）。
 */
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { Crop as CropIcon, Images, Pencil, X } from 'lucide-react';
import { $t } from '../i18n';
import { mediaUsable, uid, useStore, type Media } from '../store';
import { tc } from '../engine/rulerTicks';
import { footage, useAutoEdit, wholeSeg, type AeSeg } from '../engine/autoEditSettings';
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
  if (!rows.length) return <div className="ae-empty">{list ? $t('把素材拖到這裡') : $t('沒有可用的素材')}</div>;
  return (
    <div className="ae-segs">
      {rows.map((row) => {
        const { seg: g, m } = row;
        const video = m.kind === 'video';
        const ranged = video && (g.a > 0 || g.b < m.duration - 0.01);
        const d = direction?.[row.implicit ? m.id : video ? `${m.id}@${g.id}` : m.id];
        const on = src === `${m.id}:${ranged ? `${g.a}-${g.b}` : ''}`;
        return (
          <div key={g.id} className={`ae-seg ${on ? 'on' : ''} ${d?.weight === 0 ? 'dim' : ''}`} onClick={() => preview(g, m, video)}>
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

export function AeRangeDialog() {
  const req = useRange((x) => x.req);
  const m = useStore((x) => (req ? x.media.find((y) => y.id === req.mediaId) : undefined));
  if (!req || !m || m.kind !== 'video') return null;
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
