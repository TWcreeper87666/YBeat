/**
 * 選範圍的視窗（共用）：自動剪輯加入影片片段、錄製分頁後挑要留的段落。
 */
import React, { useEffect, useRef, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import { $t } from '../i18n';
import { useStore, type Media } from '../store';
import { Seg } from './Toggle';
import { tc } from '../engine/rulerTicks';
import { holdScrubFor, scrubFrame, warmScrub } from '../engine/scrubCache';
import { isTextField } from './focus';
import { FULL_CROP, isFullCrop, type Crop } from '../engine/transform';

export { isFullCrop, type Crop };

const fmt = (t: number) => tc(t);

export type AB = { a: number; b: number };

const FULL = FULL_CROP;

/** 裁切比例：free = 自由；out = 專案輸出比例；其他 = 寬 / 高 */
type Ratio = 'free' | 'out' | '9:16' | '1:1' | '4:5' | '16:9';
const RATIOS: Ratio[] = ['free', 'out', '9:16', '1:1', '4:5', '16:9'];
/** 記住上次選的比例（同一次開啟內） */
let lastRatio: Ratio = 'free';

/** 比例 → 框在 0~1 座標裡的寬高比 k（= 框寬 / 框高，已經換算素材的長寬）；free = null */
function ratioK(r: Ratio, m: { width: number; height: number }, out: { w: number; h: number }): number | null {
  if (r === 'free') return null;
  const [w, h] = r === 'out' ? [out.w, out.h] : r.split(':').map(Number);
  return (w / h) * ((m.height || 1) / (m.width || 1));
}

/** 照比例能放進畫面的最大框，中心盡量對準 (cx, cy) */
function maxCrop(k: number, cx = 0.5, cy = 0.5): Crop {
  const w = Math.min(1, k), h = w / k;
  return { x: Math.max(0, Math.min(1 - w, cx - w / 2)), y: Math.max(0, Math.min(1 - h, cy - h / 2)), w, h };
}

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
  const out = useStore((s) => s.format);
  const [ratio, setRatioState] = useState<Ratio>(initCrop && !isFullCrop(initCrop) ? 'free' : lastRatio);
  const k = ratioK(ratio, m, out);
  const setRatio = (r: Ratio) => {
    lastRatio = r;
    setRatioState(r);
    const kk = ratioK(r, m, out);
    if (!kk) return;
    const c = cropRef.current;
    remember();
    setCrop(maxCrop(kk, c.x + c.w / 2, c.y + c.h / 2));
  };
  // 開啟時記著的比例：框先套上
  useEffect(() => { if (cropOn && k && (!initCrop || isFullCrop(initCrop))) setCrop(maxCrop(k)); }, []); // eslint-disable-line react-hooks/exhaustive-deps
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
  const cropRef = useRef(crop);
  cropRef.current = crop;
  // 視窗內的復原 / 重做（範圍、裁切框）
  type Snap = { ab: AB; crop: Crop };
  const past = useRef<Snap[]>([]);
  const future = useRef<Snap[]>([]);
  const snap = (): Snap => ({ ab: cur.current, crop: cropRef.current });
  const remember = (s0: Snap = snap()) => { past.current.push(s0); future.current = []; };
  const restore = (x: Snap) => { setAB(x.ab); cur.current = x.ab; setCrop(x.crop); cropRef.current = x.crop; };
  const undo = () => { const p = past.current.pop(); if (p) { future.current.push(snap()); restore(p); } };
  const redo = () => { const f = future.current.pop(); if (f) { past.current.push(snap()); restore(f); } };

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
      if (target.current === null) setT((x) => (Math.abs(x - v.currentTime) > 1 / 60 ? v.currentTime : x));
      // 拖曳中精準畫面還沒出來 → 先畫快取的小張影格
      const ov = overlay.current;
      if (ov) {
        const want = target.current;
        const stale = want !== null && (v.seeking || Math.abs(v.currentTime - want) > 0.08);
        // 拖曳中、或放開後 seek 還沒完成：蓋著快取影格；附近還沒抽好就留著上一張（不要閃回舊畫面）
        const bm = stale ? scrubFrame(m, want!) : null;
        if (bm) {
          if (ov.width !== bm.width || ov.height !== bm.height) { ov.width = bm.width; ov.height = bm.height; }
          const g = ov.getContext('2d')!;
          g.setTransform(1, 0, 0, -1, 0, bm.height); // 快取影格是上下翻轉存的（給 WebGL 用）
          g.drawImage(bm, 0, 0);
          ov.style.display = 'block';
        } else if (!stale) ov.style.display = 'none';
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    // 播放中不在背景抽拖曳用的影格（解碼器給播放用，不然會越播越卡）
    const on = () => { setPlaying(!v.paused); holdScrubFor(v, !v.paused); };
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
      holdScrubFor(v, false);
      // 馬上放掉解碼器（等垃圾回收的話，開過很多次後會越來越卡）
      v.removeAttribute('src');
      v.load();
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
      else if (e.key === 'Home') seek(cur.current.a);
      else if (e.key === 'End') seek(cur.current.b);
      else if ('iIqQ'.includes(e.key)) { remember(); setAB(clampIn(t, cur.current)); }
      else if ('oOwW'.includes(e.key)) { remember(); setAB(clampOut(t, cur.current)); }
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  });

  // 範圍條的顯示範圍（滾輪縮放、Shift + 滾輪 / 水平捲動平移；長影片才調得到細的範圍）
  const [view, setView] = useState<[number, number]>([0, dur]);
  const viewRef = useRef(view);
  viewRef.current = view;
  const span = Math.max(1e-6, view[1] - view[0]);
  useEffect(() => {
    const el = bar.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const [v0, v1] = viewRef.current;
      const sp = v1 - v0;
      const r = el.getBoundingClientRect();
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        const d = ((e.shiftKey ? e.deltaY : e.deltaX) / r.width) * sp;
        const n0 = Math.max(0, Math.min(dur - sp, v0 + d));
        return setView([n0, n0 + sp]);
      }
      const at = v0 + Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * sp;
      const ns = Math.max(Math.min(1, dur), Math.min(dur, sp * Math.pow(1.0015, e.deltaY)));
      const n0 = Math.max(0, Math.min(dur - ns, at - ((at - v0) / sp) * ns));
      setView([n0, n0 + ns]);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [dur]);
  // 播放 / 跳轉跑出顯示範圍：捲過去
  useEffect(() => {
    const [v0, v1] = viewRef.current;
    if (t >= v0 && t <= v1) return;
    const sp = v1 - v0;
    const n0 = Math.max(0, Math.min(dur - sp, t - sp * 0.1));
    setView([n0, n0 + sp]);
  }, [t, dur]);

  // 範圍條：拖把手 = 調入點 / 出點（畫面跟著跳），其他地方 = 移動播放位置
  const timeAt = (x: number) => {
    const r = bar.current!.getBoundingClientRect();
    const [v0, v1] = viewRef.current;
    return v0 + Math.max(0, Math.min(1, (x - r.left) / r.width)) * (v1 - v0);
  };
  /** 滑鼠離播放頭幾 px 內 = 碰到播放頭 */
  const nearHead = (x: number) => {
    const r = bar.current!.getBoundingClientRect();
    const [v0, v1] = viewRef.current;
    return Math.abs(x - (r.left + ((t - v0) / Math.max(1e-6, v1 - v0)) * r.width)) <= 6;
  };
  const [headHover, setHeadHover] = useState(false);
  const down = (e: React.PointerEvent, what: 'a' | 'b' | 't') => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const wasPlaying = !!video.current && !video.current.paused;
    video.current?.pause();
    scrubbing.current = true;
    const start = cur.current;
    const s0 = snap();
    // 在播放頭上按一下（沒拖）：比較近的入點 / 出點設到播放頭
    const onHead = what === 't' && nearHead(e.clientX);
    const sx = e.clientX;
    let moved = false;
    const apply = (x: number) => {
      const v = timeAt(x);
      if (what === 'a') { const r = clampIn(v, cur.current); setAB(r); cur.current = r; seek(r.a); }
      else if (what === 'b') { const r = clampOut(v, cur.current); setAB(r); cur.current = r; seek(r.b); }
      else seek(v);
    };
    if (!onHead) apply(e.clientX);
    const move = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - sx) < 3) return;
      moved = true;
      apply(ev.clientX);
    };
    const up = () => {
      scrubbing.current = false;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (onHead && !moved) {
        const r = cur.current, x = t;
        const next = Math.abs(x - r.a) <= Math.abs(x - r.b) ? clampIn(x, r) : clampOut(x, r);
        setAB(next);
        cur.current = next;
      }
      if (start.a !== cur.current.a || start.b !== cur.current.b) remember(s0);
      // 拖之前在播：放開接著播
      if (wasPlaying) toggle();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  /** 時間點 → 範圍條上的位置；pw = 長度 → 寬度（跟著縮放） */
  const pc = (x: number) => `${((x - view[0]) / span) * 100}%`;
  const pw = (d: number) => `${(d / span) * 100}%`;

  return (
    <div className="overlay" style={{ zIndex: 300 }} onPointerDown={(e) => outsideClose && e.target === e.currentTarget && close()}>
      <div className="dialog wide ae-range">
        <h3 title={m.name}>{m.name}</h3>
        <div className={`ae-range-video ${cropOn ? 'cropping' : ''}`}>
          <video ref={video} src={m.url} playsInline preload="auto" onClick={toggle} />
          <canvas ref={overlay} />
          {cropOn && <CropBox crop={crop} set={setCrop} k={k} onStart={() => remember()} onClick={toggle} />}
        </div>
        <div className="ae-range-bar" ref={bar} onPointerDown={(e) => down(e, 't')} onPointerMove={(e) => setHeadHover(nearHead(e.clientX))} onPointerLeave={() => setHeadHover(false)}>
          {others.map((g, i) => <i key={i} className="other" style={{ left: pc(g.a), width: pw(g.b - g.a) }} />)}
          <i className="sel" style={{ left: pc(a), width: pw(b - a) }} />
          <i className={`head ${headHover ? 'hover' : ''}`} style={{ left: pc(t) }} />
          <b style={{ left: pc(a) }} onPointerDown={(e) => down(e, 'a')} />
          <b style={{ left: pc(b) }} onPointerDown={(e) => down(e, 'b')} />
        </div>
        <div className="ae-line">
          <button className="ec-icon" title={playing ? $t('暫停') : $t('播放')} onClick={toggle}>{playing ? <Pause size={14} /> : <Play size={14} />}</button>
          <span className="ae-stat">{fmt(t)}</span>
          <span className="spacer" />
          {cropOn && !isFullCrop(crop) && <span className="ae-stat">{Math.round(crop.w * m.width)}×{Math.round(crop.h * m.height)}</span>}
          {span < dur - 0.01 && <button className="link" title={$t('顯示整段')} onClick={() => setView([0, dur])}>{(dur / span).toFixed(1)}×</button>}
          <span className="ae-stat">{fmt(a)} – {fmt(b)} · {(b - a).toFixed(1)}s</span>
        </div>
        <div className="dialog-actions">
          {cropOn && (
            <Seg className="ae-ratio" value={ratio} on={setRatio} opts={RATIOS.map((r) => ({ v: r, label: r === 'free' ? $t('自由') : r === 'out' ? $t('輸出比例') : r, title: r === 'out' ? `${$t('裁切比例')} · ${out.w} × ${out.h}` : $t('裁切比例') }))} />
          )}
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

/** 鎖比例：角 = 對角固定、照比例縮放；邊 = 對邊固定、另一個方向從中心長；碰到畫面邊緣就整個縮小 */
function lockRatio(c0: Crop, l: number, r: number, t: number, b: number, edge: Edge, k: number): Crop {
  const horiz = !!(edge.l || edge.r), vert = !!(edge.t || edge.b);
  let w = r - l, h = b - t;
  if (horiz && vert) { if (w / k >= h) h = w / k; else w = h * k; }
  else if (horiz) h = w / k;
  else w = h * k;
  // 固定的那一邊（沒拖的方向 = 從框的中心長）
  const ax = edge.l ? c0.x + c0.w : edge.r ? c0.x : null;
  const ay = edge.t ? c0.y + c0.h : edge.b ? c0.y : null;
  const roomW = ax === null ? 1 : edge.l ? ax : 1 - ax;
  const roomH = ay === null ? 1 : edge.t ? ay : 1 - ay;
  const sc = Math.min(1, roomW / w, roomH / h);
  w *= sc; h *= sc;
  const grow = Math.max(1, MIN / w, MIN / h);
  w = Math.min(1, w * grow); h = Math.min(1, h * grow);
  const cx = c0.x + c0.w / 2, cy = c0.y + c0.h / 2;
  const x = ax === null ? Math.max(0, Math.min(1 - w, cx - w / 2)) : edge.l ? Math.max(0, ax - w) : Math.min(ax, 1 - w);
  const y = ay === null ? Math.max(0, Math.min(1 - h, cy - h / 2)) : edge.t ? Math.max(0, ay - h) : Math.min(ay, 1 - h);
  return { x, y, w, h };
}

/** Alt 拖把手：中心固定，兩邊一起長 / 縮（k = 鎖定的比例） */
function centerResize(c0: Crop, dx: number, dy: number, edge: Edge, k: number | null): Crop {
  const cx = c0.x + c0.w / 2, cy = c0.y + c0.h / 2;
  const maxW = 2 * Math.min(cx, 1 - cx), maxH = 2 * Math.min(cy, 1 - cy);
  let w = c0.w + 2 * (edge.l ? -dx : edge.r ? dx : 0);
  let h = c0.h + 2 * (edge.t ? -dy : edge.b ? dy : 0);
  if (k) {
    const horiz = !!(edge.l || edge.r), vert = !!(edge.t || edge.b);
    if (horiz && vert) { if (w / k >= h) h = w / k; else w = h * k; }
    else if (horiz) h = w / k;
    else w = h * k;
    const sc = Math.min(1, maxW / w, maxH / h);
    w *= sc; h *= sc;
    const grow = Math.max(1, MIN / w, MIN / h);
    w *= grow; h *= grow;
  } else {
    w = Math.max(MIN, Math.min(maxW, w));
    h = Math.max(MIN, Math.min(maxH, h));
  }
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

/** 拖框內 = 移動、拖把手 = 調大小（Alt = 從中心）（k = 鎖定的比例）、雙擊 = 回到整個畫面（鎖比例時 = 最大的框）；框內點一下（沒拖）= 播放 / 暫停 */
function CropBox({ crop, set, k, onStart, onClick }: { crop: Crop; set: (c: Crop) => void; k: number | null; onStart: () => void; onClick: () => void }) {
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
      if (!moved && Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 3) { moved = true; onStart(); }
      if (!moved) return;
      if (!edge) {
        set({ ...c0, x: Math.max(0, Math.min(1 - c0.w, c0.x + dx)), y: Math.max(0, Math.min(1 - c0.h, c0.y + dy)) });
        return;
      }
      if (ev.altKey) return set(centerResize(c0, dx, dy, edge, k));
      let l = c0.x, r = c0.x + c0.w, t = c0.y, b = c0.y + c0.h;
      if (edge.l) l = Math.max(0, Math.min(r - MIN, l + dx));
      if (edge.r) r = Math.min(1, Math.max(l + MIN, r + dx));
      if (edge.t) t = Math.max(0, Math.min(b - MIN, t + dy));
      if (edge.b) b = Math.min(1, Math.max(t + MIN, b + dy));
      set(k ? lockRatio(c0, l, r, t, b, edge, k) : { x: l, y: t, w: r - l, h: b - t });
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
      <div ref={box} className="crop-box" style={rect} onPointerDown={(e) => down(e, null)} onDoubleClick={() => { onStart(); set(k ? maxCrop(k) : FULL); }}>
        {HANDLES.map(([k, edge]) => <b key={k} className={k} onPointerDown={(e) => down(e, edge)} />)}
      </div>
    </>
  );
}
