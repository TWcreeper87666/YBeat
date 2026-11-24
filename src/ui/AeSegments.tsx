/**
 * 自動剪輯的素材清單：從素材分頁把影片 / 圖片拖到自動剪輯分頁 → 選範圍加入（按住 Alt = 整段）。
 * 同一支影片可以加很多段，片段可以改名。清單是空的 = 用素材庫全部（清單上照樣列出每個素材）。
 */
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { Images, Pause, Pencil, Play, X } from 'lucide-react';
import { $t } from '../i18n';
import { mediaUsable, uid, useStore, type Media } from '../store';
import { tc } from '../engine/rulerTicks';
import { footage, useAutoEdit, wholeSeg, type AeSeg } from '../engine/autoEditSettings';
import { scrubFrame, warmScrub } from '../engine/scrubCache';
import { useLibFocus } from './uiStore';
import { useDock } from './Dock';
import { isTextField } from './focus';
import { openSource, useSource } from './SourcePanel';

export const roleName = (k: string) => ({ intro: $t('開頭'), build: $t('鋪陳'), drop: $t('高潮'), body: $t('主體'), outro: $t('結尾') } as Record<string, string>)[k] ?? k;

/** 選範圍的對話框：segId = 編輯既有的片段（沒有 = 新增）；queue = 接著要選的其他影片 */
interface RangeReq { mediaId: string; segId?: string; a: number; b: number; queue: string[]; /** 從「素材庫全部」那一列打開：確定時把清單展開、換掉這個素材的整段 */ implicit?: boolean }
const useRange = create<{ req: RangeReq | null }>(() => ({ req: null }));

const segsNow = () => useAutoEdit.getState().segs;
const setSegs = (segs: AeSeg[]) => useAutoEdit.getState().set({ segs });
/** 清單是空的（= 素材庫全部）時，先把素材庫展開成整段的片段，再做修改 */
const explicit = (): AeSeg[] => (segsNow().length ? segsNow() : footage(useStore.getState()).map((m) => wholeSeg(m, uid())));
/**
 * 加進清單：清單是空的（= 素材庫全部）時先展開成整段，同一個素材的那一列換成新加的（位置不變）；
 * 已經有一模一樣的（同素材、同範圍）就不重複加
 */
function addSegs(list: AeSeg[]) {
  const implicit = !segsNow().length;
  const out: AeSeg[] = [];
  const rest = [...list];
  for (const g of explicit()) {
    const i = implicit ? rest.findIndex((n) => n.mediaId === g.mediaId) : -1;
    if (i >= 0) out.push(...rest.splice(i, 1));
    else out.push(g);
  }
  for (const n of rest) if (!out.some((g) => g.mediaId === n.mediaId && g.a === n.a && g.b === n.b)) out.push(n);
  setSegs(out);
}

/** 素材拖進自動剪輯分頁：圖片 / 按住 Alt / 多選 → 整段加入；單一影片 → 選範圍 */
export function dropToAutoEdit(ids: string[], all: boolean) {
  const media = useStore.getState().media;
  const list = ids.map((id) => media.find((m) => m.id === id)).filter((m): m is Media => mediaUsable(m) && m.kind !== 'audio');
  if (!list.length) return;
  useDock.getState().activatePanel('auto');
  const videos = list.filter((m) => m.kind === 'video');
  if (all || list.length > 1 || !videos.length) return addSegs(list.map((m) => wholeSeg(m, uid())));
  openRange(videos[0]);
}

function openRange(m: Media, seg?: AeSeg, queue: string[] = [], implicit = false) {
  useRange.setState({ req: { mediaId: m.id, segId: seg?.id, a: seg?.a ?? 0, b: seg?.b ?? m.duration, queue, implicit } });
}

const fmt = (t: number) => tc(t);

// ───────────── 清單 ─────────────

export function SegList() {
  const segs = useAutoEdit((x) => x.segs);
  const direction = useAutoEdit((x) => (x.director ? x.direction : null));
  const media = useStore((x) => x.media);
  const src = useSource((x) => (x.open ? `${x.mediaId}:${x.range?.join('-') ?? ''}` : null));
  const [renaming, setRenaming] = useState<string | null>(null);
  // 清單空的 = 素材庫全部（每個素材一列，id = 素材 id）
  const rows: { seg: AeSeg; m: Media; implicit: boolean }[] = segs.length
    ? segs.flatMap((g) => { const m = media.find((x) => x.id === g.mediaId); return m ? [{ seg: g, m, implicit: false }] : []; })
    : footage({ ...useStore.getState(), media }).map((m) => ({ seg: wholeSeg(m, m.id), m, implicit: true }));

  /** 對清單空的狀態做修改：先展開，再找到同一個素材的那一列 */
  const edit = (row: { seg: AeSeg; implicit: boolean }, fn: (list: AeSeg[], g: AeSeg) => AeSeg[]) => {
    const list = row.implicit ? explicit() : segsNow();
    const g = row.implicit ? list.find((x) => x.mediaId === row.seg.mediaId) : list.find((x) => x.id === row.seg.id);
    if (g) setSegs(fn(list, g));
  };
  const preview = (g: AeSeg, m: Media, video: boolean) =>
    openSource(m.id, video && (g.a > 0 || g.b < m.duration - 0.01) ? [g.a, g.b] : null, g.name ?? null);
  const reveal = (m: Media) => {
    useDock.getState().activatePanel('media');
    useLibFocus.setState((s) => ({ id: m.id, n: s.n + 1 }));
  };
  if (!rows.length) return <div className="ae-empty">{$t('沒有可用的素材')}</div>;
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
            <span className="ae-stat">{!video ? $t('圖片') : ranged ? `${fmt(g.a)} – ${fmt(g.b)}` : fmt(m.duration)}</span>
            <span className="ae-seg-btns" onClick={(e) => e.stopPropagation()}>
              {video && <button className="ec-icon" title={$t('調整範圍')} onClick={() => openRange(m, row.implicit ? undefined : g, [], row.implicit)}><Pencil size={12} /></button>}
              <button className="ec-icon" title={$t('在素材分頁顯示')} onClick={() => reveal(m)}><Images size={12} /></button>
              <button className="ec-icon" title={$t('移除')} disabled={rows.length <= 1} onClick={() => edit(row, (list, x) => list.filter((y) => y !== x))}><X size={12} /></button>
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

type AB = { a: number; b: number };

function RangeDialog({ req, m }: { req: RangeReq; m: Media }) {
  const dur = m.duration;
  const [ab, setAB] = useState<AB>({ a: req.a, b: req.b });
  const { a, b } = ab;
  const [t, setT] = useState(req.a);
  const [playing, setPlaying] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const others = useAutoEdit((x) => x.segs.filter((g) => g.mediaId === m.id && g.id !== req.segId));
  const cur = useRef(ab);
  cur.current = ab;
  // 視窗內的復原 / 重做（範圍的調整）
  const past = useRef<AB[]>([]);
  const future = useRef<AB[]>([]);
  const remember = () => { past.current.push(cur.current); future.current = []; };
  const undo = () => { const p = past.current.pop(); if (p) { future.current.push(cur.current); setAB(p); } };
  const redo = () => { const f = future.current.pop(); if (f) { past.current.push(cur.current); setAB(f); } };

  /** 拖曳中的跳轉：上一次 seek 還沒完成就先記著，完成後再跳到最新位置（跟素材預覽一樣） */
  const target = useRef<number | null>(null);
  const scrubbing = useRef(false);
  const seek = (x: number) => {
    const v = video.current;
    const c = Math.max(0, Math.min(dur, x));
    target.current = c;
    setT(c);
    if (v && !v.seeking) v.currentTime = c;
  };

  useEffect(() => {
    const v = video.current;
    if (!v) return;
    let raf = 0;
    const onSeeked = () => {
      const want = target.current;
      if (want !== null && Math.abs(v.currentTime - want) > 0.03) v.currentTime = want;
      else target.current = null;
    };
    v.addEventListener('seeked', onSeeked);
    const tick = () => {
      const { a: lo, b: hi } = cur.current;
      // 播放：只循環播選取的範圍
      if (!v.paused && target.current === null && (v.currentTime >= hi - 0.01 || v.currentTime < lo - 0.05)) v.currentTime = lo;
      if (target.current === null) setT(v.currentTime);
      // 拖曳中精準畫面還沒出來 → 先畫快取的小張影格
      const ov = overlay.current;
      if (ov) {
        const want = target.current;
        const stale = want !== null && (v.seeking || Math.abs(v.currentTime - want) > 0.08);
        const bm = stale && scrubbing.current ? scrubFrame(m, want!) : null;
        if (bm) {
          if (ov.width !== bm.width || ov.height !== bm.height) { ov.width = bm.width; ov.height = bm.height; }
          const g = ov.getContext('2d')!;
          g.setTransform(1, 0, 0, -1, 0, bm.height); // 快取影格是上下翻轉存的（給 WebGL 用）
          g.drawImage(bm, 0, 0);
          ov.style.display = 'block';
        } else ov.style.display = 'none';
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const on = () => setPlaying(!v.paused);
    v.addEventListener('play', on);
    v.addEventListener('pause', on);
    warmScrub(m, req.a);
    seek(req.a);
    return () => {
      cancelAnimationFrame(raf);
      v.removeEventListener('seeked', onSeeked);
      v.removeEventListener('play', on);
      v.removeEventListener('pause', on);
      v.pause();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = () => {
    const v = video.current;
    if (!v) return;
    if (v.paused) {
      if (v.currentTime < a || v.currentTime >= b - 0.01) v.currentTime = a;
      void v.play().catch(() => {});
    } else v.pause();
  };

  const close = () => {
    video.current?.pause();
    const next = req.queue[0] && useStore.getState().media.find((x) => x.id === req.queue[0]);
    if (next) openRange(next, undefined, req.queue.slice(1));
    else useRange.setState({ req: null });
  };
  const commit = () => {
    if (b - a < 0.2) return;
    if (req.segId) setSegs(segsNow().map((g) => (g.id === req.segId ? { ...g, a, b } : g)));
    else if (req.implicit && !segsNow().length) setSegs(explicit().map((g) => (g.mediaId === m.id ? { ...g, a, b } : g)));
    else addSegs([{ id: uid(), mediaId: m.id, a, b }]);
  };
  /** 加入這段、留著視窗再選下一段（從這段結尾開始） */
  const addMore = () => {
    commit();
    past.current = [];
    future.current = [];
    const na = Math.min(b, dur - 0.2);
    setAB({ a: na, b: dur });
    seek(na);
  };
  const clampIn = (x: number, r: AB): AB => ({ ...r, a: Math.max(0, Math.min(x, r.b - 0.2)) });
  const clampOut = (x: number, r: AB): AB => ({ ...r, b: Math.min(dur, Math.max(x, r.a + 0.2)) });

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (isTextField(e.target)) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') (e.shiftKey ? redo : undo)();
      else if (mod && e.key.toLowerCase() === 'y') redo();
      else if (mod) return;
      else if (e.key === 'Escape') close();
      else if (e.key === 'Enter') { commit(); close(); }
      else if (e.key === ' ') toggle();
      else if (e.key === 'i' || e.key === 'I') { remember(); setAB(clampIn(t, cur.current)); }
      else if (e.key === 'o' || e.key === 'O') { remember(); setAB(clampOut(t, cur.current)); }
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  });

  // 範圍條：拖把手 = 調入點 / 出點（畫面跟著跳），其他地方 = 移動播放位置
  const timeAt = (x: number) => {
    const r = bar.current!.getBoundingClientRect();
    return Math.max(0, Math.min(1, (x - r.left) / r.width)) * dur;
  };
  const down = (e: React.PointerEvent, what: 'a' | 'b' | 't') => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    video.current?.pause();
    scrubbing.current = true;
    const start = cur.current;
    const apply = (x: number) => {
      const v = timeAt(x);
      if (what === 'a') { const r = clampIn(v, cur.current); setAB(r); cur.current = r; seek(r.a); }
      else if (what === 'b') { const r = clampOut(v, cur.current); setAB(r); cur.current = r; seek(r.b); }
      else seek(v);
    };
    apply(e.clientX);
    const move = (ev: PointerEvent) => apply(ev.clientX);
    const up = () => {
      scrubbing.current = false;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (what !== 't' && (start.a !== cur.current.a || start.b !== cur.current.b)) { past.current.push(start); future.current = []; }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const pc = (x: number) => `${(x / Math.max(1e-6, dur)) * 100}%`;

  return (
    <div className="overlay" style={{ zIndex: 300 }} onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="dialog wide ae-range">
        <h3 title={m.name}>{m.name}</h3>
        <div className="ae-range-video">
          <video ref={video} src={m.url} playsInline preload="auto" onClick={toggle} />
          <canvas ref={overlay} />
        </div>
        <div className="ae-range-bar" ref={bar} onPointerDown={(e) => down(e, 't')}>
          {others.map((g) => <i key={g.id} className="other" style={{ left: pc(g.a), width: pc(g.b - g.a) }} />)}
          <i className="sel" style={{ left: pc(a), width: pc(b - a) }} />
          <i className="head" style={{ left: pc(t) }} />
          <b style={{ left: pc(a) }} onPointerDown={(e) => down(e, 'a')} />
          <b style={{ left: pc(b) }} onPointerDown={(e) => down(e, 'b')} />
        </div>
        <div className="ae-line">
          <button className="ec-icon" title={playing ? $t('暫停') : $t('播放')} onClick={toggle}>{playing ? <Pause size={14} /> : <Play size={14} />}</button>
          <span className="ae-stat">{fmt(t)}</span>
          <span className="spacer" />
          <span className="ae-stat">{fmt(a)} – {fmt(b)} · {(b - a).toFixed(1)}s</span>
        </div>
        <div className="dialog-actions">
          <button className="btn" onClick={close}>{$t('取消')}</button>
          {!req.segId && <button className="btn" onClick={addMore}>{$t('再加一段')}</button>}
          <button className="btn primary" onClick={() => (commit(), close())}>{req.segId ? $t('確定') : $t('加入')}</button>
        </div>
      </div>
    </div>
  );
}
