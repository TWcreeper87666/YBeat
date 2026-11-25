/**
 * 選範圍的視窗（共用）：自動剪輯加入影片片段、錄製分頁後挑要留的段落。
 */
import React, { useEffect, useRef, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import { $t } from '../i18n';
import type { Media } from '../store';
import { tc } from '../engine/rulerTicks';
import { scrubFrame, warmScrub } from '../engine/scrubCache';
import { isTextField } from './focus';
import { FULL_CROP, isFullCrop, type Crop } from '../engine/transform';

export { isFullCrop, type Crop };

const fmt = (t: number) => tc(t);

export type AB = { a: number; b: number };

const FULL = FULL_CROP;

export interface RangePickerProps {
  /** 要選範圍的影片（只用到 url / duration / name，也用來抽拖曳時的快取影格） */
  m: Media;
  init: AB;
  /** 已經選過的其他範圍（範圍條上淡淡標出） */
  others?: AB[];
  /** 編輯既有的範圍：按鈕是「確定」，沒有「再加一段」 */
  editing?: boolean;
  /** 點視窗外面要不要關掉（錄影這種關掉就沒了的，不要） */
  outsideClose?: boolean;
  /** 顯示裁切框：commit 時一起回傳，比例 0~1 */
  crop?: boolean;
  /** 裁切框的初始值（編輯既有的範圍） */
  initCrop?: Crop;
  onCommit: (a: number, b: number, crop?: Crop) => void;
  onClose: () => void;
}

/** 選範圍的視窗：播放 / 拖把手調入點出點（I / O）/ 復原重做；自動剪輯加素材、錄製分頁共用 */
export function RangePicker({ m, init, others = [], editing, outsideClose = true, crop: cropOn, initCrop, onCommit, onClose }: RangePickerProps) {
  const [crop, setCrop] = useState<Crop>(initCrop ?? FULL);
  const req = init;
  const dur = m.duration;
  const [ab, setAB] = useState<AB>({ a: req.a, b: req.b });
  const { a, b } = ab;
  const [t, setT] = useState(req.a);
  const [playing, setPlaying] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const bar = useRef<HTMLDivElement>(null);
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
    onClose();
  };
  const commit = () => {
    if (b - a < 0.2) return;
    onCommit(a, b, cropOn ? crop : undefined);
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
    <div className="overlay" style={{ zIndex: 300 }} onPointerDown={(e) => outsideClose && e.target === e.currentTarget && close()}>
      <div className="dialog wide ae-range">
        <h3 title={m.name}>{m.name}</h3>
        <div className={`ae-range-video ${cropOn ? 'cropping' : ''}`}>
          <video ref={video} src={m.url} playsInline preload="auto" onClick={toggle} />
          <canvas ref={overlay} />
          {cropOn && <CropBox crop={crop} set={setCrop} onClick={toggle} />}
        </div>
        <div className="ae-range-bar" ref={bar} onPointerDown={(e) => down(e, 't')}>
          {others.map((g, i) => <i key={i} className="other" style={{ left: pc(g.a), width: pc(g.b - g.a) }} />)}
          <i className="sel" style={{ left: pc(a), width: pc(b - a) }} />
          <i className="head" style={{ left: pc(t) }} />
          <b style={{ left: pc(a) }} onPointerDown={(e) => down(e, 'a')} />
          <b style={{ left: pc(b) }} onPointerDown={(e) => down(e, 'b')} />
        </div>
        <div className="ae-line">
          <button className="ec-icon" title={playing ? $t('暫停') : $t('播放')} onClick={toggle}>{playing ? <Pause size={14} /> : <Play size={14} />}</button>
          <span className="ae-stat">{fmt(t)}</span>
          <span className="spacer" />
          {cropOn && !isFullCrop(crop) && <span className="ae-stat">{Math.round(crop.w * m.width)}×{Math.round(crop.h * m.height)}</span>}
          <span className="ae-stat">{fmt(a)} – {fmt(b)} · {(b - a).toFixed(1)}s</span>
        </div>
        <div className="dialog-actions">
          <button className="btn" onClick={close}>{$t('取消')}</button>
          {!editing && <button className="btn" onClick={addMore}>{$t('再加一段')}</button>}
          <button className="btn primary" onClick={() => (commit(), close())}>{editing ? $t('確定') : $t('加入')}</button>
        </div>
      </div>
    </div>
  );
}

// ───────────── 裁切框 ─────────────

const MIN = 0.05;
type Edge = { l?: 1; r?: 1; t?: 1; b?: 1 };
const HANDLES: [string, Edge][] = [
  ['nw', { l: 1, t: 1 }], ['n', { t: 1 }], ['ne', { r: 1, t: 1 }], ['e', { r: 1 }],
  ['se', { r: 1, b: 1 }], ['s', { b: 1 }], ['sw', { l: 1, b: 1 }], ['w', { l: 1 }],
];

/** 拖框內 = 移動、拖把手 = 調大小、雙擊 = 回到整個畫面；框內點一下（沒拖）= 播放 / 暫停 */
function CropBox({ crop, set, onClick }: { crop: Crop; set: (c: Crop) => void; onClick: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const down = (e: React.PointerEvent, edge: Edge | null) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const host = box.current!.parentElement!.getBoundingClientRect();
    const sx = e.clientX, sy = e.clientY;
    const c0 = crop;
    let moved = false;
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - sx) / host.width, dy = (ev.clientY - sy) / host.height;
      if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 3) moved = true;
      if (!moved) return;
      if (!edge) {
        set({ ...c0, x: Math.max(0, Math.min(1 - c0.w, c0.x + dx)), y: Math.max(0, Math.min(1 - c0.h, c0.y + dy)) });
        return;
      }
      let l = c0.x, r = c0.x + c0.w, t = c0.y, b = c0.y + c0.h;
      if (edge.l) l = Math.max(0, Math.min(r - MIN, l + dx));
      if (edge.r) r = Math.min(1, Math.max(l + MIN, r + dx));
      if (edge.t) t = Math.max(0, Math.min(b - MIN, t + dy));
      if (edge.b) b = Math.min(1, Math.max(t + MIN, b + dy));
      set({ x: l, y: t, w: r - l, h: b - t });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (!moved && !edge) onClick();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const pc = (v: number) => `${v * 100}%`;
  const rect = { left: pc(crop.x), top: pc(crop.y), width: pc(crop.w), height: pc(crop.h) };
  return (
    <>
      {/* 框外變暗：放在自己的裁切層裡，把手才不會被一起切掉 */}
      <div className="crop-mask"><i style={rect} /></div>
      <div ref={box} className="crop-box" style={rect} onPointerDown={(e) => down(e, null)} onDoubleClick={() => set(FULL)}>
        {HANDLES.map(([k, edge]) => <b key={k} className={k} onPointerDown={(e) => down(e, edge)} />)}
      </div>
    </>
  );
}
