import React, { useEffect, useRef, useState } from 'react';
import { useMonitor } from '../engine/audio';
import { create } from 'zustand';
import { Clapperboard, Pause, Play, SkipBack, X } from 'lucide-react';
import { mediaUsable, useStore, type Media } from '../store';
import { $t } from '../i18n';
import { scrubFrame } from '../engine/scrubCache';
import { tc } from '../engine/rulerTicks';
import { useDock } from './Dock';
import { revealSelection, stopPreviewFx, useEditorWindow, usePreviewFx } from './uiStore';

/** 素材預覽（顯示在「預覽」面板裡）：目前的素材、入點 / 出點、是否正在顯示 */
export const useSource = create<{ mediaId: string | null; open: boolean; inT: number; outT: number | null }>(() => ({ mediaId: null, open: false, inT: 0, outT: null }));

/** 在「預覽」面板打開素材 */
export function openSource(mediaId: string) {
  stopPreviewFx();
  if (useSource.getState().mediaId !== mediaId) useSource.setState({ mediaId, inT: 0, outT: null });
  useSource.setState({ open: true });
  useDock.getState().activatePanel('preview', true);
}

/** 回到時間軸的預覽畫面 */
export const closeSource = () => useSource.getState().open && useSource.setState({ open: false });

// 特效試看、時間軸播放 / 移動播放頭、打開編輯視窗 → 回到時間軸的預覽畫面
usePreviewFx.subscribe((s, p) => {
  if (s.fx && !p.fx) closeSource();
});
useStore.subscribe((s, p) => {
  if ((s.playing && !p.playing) || s.time !== p.time) closeSource();
});
useEditorWindow.subscribe((s, p) => {
  if (s.open && !p.open) closeSource();
});

const fmt = (t: number) => tc(t);

/** 預覽面板裡的素材預覽（沒有打開時回傳 null） */
export function SourceOverlay() {
  const open = useSource((s) => s.open);
  const id = useSource((s) => s.mediaId);
  const media = useStore((s) => s.media.find((m) => m.id === id));
  if (!open || !media || !mediaUsable(media)) return null;
  return <SourceView key={media.id} media={media} />;
}

// ───────────────────────── 素材 ─────────────────────────

type Keys = { toggle(): void; setIn(): void; setOut(): void };
/** 滑鼠目前在哪個素材預覽上（給全域快捷鍵用） */
let activeKeys: React.MutableRefObject<Keys | null> | null = null;

/** App 的快捷鍵先問這裡：滑鼠在素材預覽上時，Space / I / O 給它用 */
export function sourceHotkey(e: KeyboardEvent): boolean {
  const k = activeKeys?.current;
  if (!k || e.ctrlKey || e.metaKey || e.altKey) return false;
  const key = e.key.toLowerCase();
  if (key === ' ') k.toggle();
  else if (key === 'i') k.setIn();
  else if (key === 'o') k.setOut();
  else return false;
  e.preventDefault();
  return true;
}

function SourceView({ media }: { media: Media }) {
  const { inT, outT } = useSource();
  const keys = useRef<Keys | null>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const ref = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  // 預覽音量也套用在素材預覽
  const level = useMonitor((m) => (m.muted ? 0 : m.volume));
  useEffect(() => {
    if (ref.current) ref.current.volume = level;
  }, [level, media.id]);
  const barRef = useRef<HTMLDivElement>(null);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const timed = media.kind !== 'image';
  const dur = timed ? media.duration : 0;
  const out = outT ?? dur;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let raf = 0;
    const onSeeked = () => {
      const want = target.current;
      if (want !== null && Math.abs(el.currentTime - want) > 0.03) el.currentTime = want;
      else target.current = null;
    };
    el.addEventListener('seeked', onSeeked);
    const tick = () => {
      if (target.current === null) setT(el.currentTime);
      // 拖曳中、精準畫面還沒出來 → 先畫快取的小張影格
      const ov = overlay.current;
      if (ov && media.kind === 'video') {
        const want = target.current;
        const stale = want !== null && (el.seeking || Math.abs(el.currentTime - want) > 0.08);
        const bm = stale && scrubbing.current ? scrubFrame(media, want!) : null;
        if (bm) {
          if (ov.width !== bm.width || ov.height !== bm.height) {
            ov.width = bm.width;
            ov.height = bm.height;
          }
          const g = ov.getContext('2d')!;
          g.setTransform(1, 0, 0, -1, 0, bm.height); // 快取影格是上下翻轉存的（給 WebGL 用）
          g.drawImage(bm, 0, 0);
          ov.style.display = 'block';
        } else ov.style.display = 'none';
      }
      // 播到出點就停
      const o = useSource.getState().outT;
      if (!el.paused && o !== null && el.currentTime >= o) {
        el.pause();
        el.currentTime = o;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const on = () => setPlaying(!el.paused);
    el.addEventListener('play', on);
    el.addEventListener('pause', on);
    // 打開就自動播放（從入點開始）
    el.currentTime = useSource.getState().inT;
    el.play().catch(() => {});
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener('seeked', onSeeked);
      el.removeEventListener('play', on);
      el.removeEventListener('pause', on);
      el.pause();
    };
  }, []);

  const timeAt = (x: number) => {
    const r = barRef.current!.getBoundingClientRect();
    return Math.min(dur, Math.max(0, ((x - r.left) / r.width) * dur));
  };
  /**
   * 拖曳中的跳轉：上一次 seek 還沒完成就先記著，完成後再跳到最新位置
   * （每格都 seek 的話瀏覽器會一直中斷前一次，結果一張畫面都出不來）
   */
  const target = useRef<number | null>(null);
  const scrubbing = useRef(false);
  const seek = (v: number) => {
    const el = ref.current;
    target.current = v;
    setT(v);
    if (el && !el.seeking) el.currentTime = v;
  };
  const drag = (e: React.PointerEvent, on: (v: number, ev: { shiftKey: boolean }) => void) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    scrubbing.current = true;
    on(timeAt(e.clientX), e);
    const mv = (ev: PointerEvent) => on(timeAt(ev.clientX), ev);
    const up = () => {
      scrubbing.current = false;
      window.removeEventListener('pointermove', mv);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
  };
  // 拖進度條：跟主預覽一樣，播放中拖曳不會停下來
  // Shift：吸附到入點 / 出點
  const snapTol = () => (12 / (barRef.current?.getBoundingClientRect().width || 1)) * dur;
  const scrub = (e: React.PointerEvent) =>
    drag(e, (v, ev) => {
      if (ev.shiftKey) {
        const st = useSource.getState();
        for (const p of [st.inT, st.outT ?? dur]) if (Math.abs(p - v) < snapTol()) v = p;
      }
      seek(v);
    });
  // 拖入點 / 出點時，播放位置跟著走，畫面同步
  const dragIn = (e: React.PointerEvent) =>
    drag(e, (v) => {
      const x = Math.min(v, (useSource.getState().outT ?? dur) - 0.05);
      useSource.setState({ inT: x });
      seek(x);
    });
  const dragOut = (e: React.PointerEvent) =>
    drag(e, (v) => {
      const x = Math.max(v, useSource.getState().inT + 0.05);
      useSource.setState({ outT: x });
      seek(x);
    });

  const toggle = () => {
    const el = ref.current;
    if (!el) return;
    if (el.paused) {
      if (el.currentTime >= out - 0.02 || el.currentTime < inT - 0.02) el.currentTime = inT;
      el.play().catch(() => {});
    } else el.pause();
  };
  const setIn = () => useSource.setState({ inT: Math.min(t, out - 0.05) });
  const setOut = () => useSource.setState({ outT: Math.max(t, inT + 0.05) });
  const range = timed ? { in: inT, duration: Math.max(0.05, out - inT) } : undefined;
  const insert = () => {
    useStore.getState().insertMedia(media.id, range);
    revealSelection();
  };

  // 滑鼠在這個分頁上時，Space / I / O 作用在素材預覽（不是時間軸）
  keys.current = { toggle, setIn, setOut };
  useEffect(() => () => {
    if (activeKeys === keys) activeKeys = null;
  }, []);

  const pct = (v: number) => `${dur ? (v / dur) * 100 : 0}%`;

  return (
    <div
      className="source-panel"
      onPointerEnter={() => (activeKeys = keys)}
      onPointerLeave={() => activeKeys === keys && (activeKeys = null)}
    >
      <div className="source-view">
        {media.kind === 'video' && (
          <div className="src-video-wrap">
            <video ref={ref} src={media.url} playsInline preload="auto" onClick={toggle} />
            <canvas ref={overlay} className="src-scrub-frame" />
          </div>
        )}
        {media.kind === 'image' && <img src={media.url} alt={media.name} />}
        {media.kind === 'audio' && (
          <>
            <audio ref={ref} src={media.url} preload="auto" />
            <SourceWave media={media} />
          </>
        )}
      </div>
      <div className="source-name" title={media.name}>
        {media.name}
        <span className="muted"> · {media.kind === 'image' ? `${media.width}×${media.height}` : `${media.width ? `${media.width}×${media.height} · ` : ''}${fmt(dur)}`}</span>
      </div>
      {timed && (
        <div className="scrub src-scrub" ref={barRef} onPointerDown={scrub}>
          <div className="scrub-track">
            <div className="src-range" style={{ left: pct(inT), width: pct(out - inT) }} />
            <div className="scrub-fill" style={{ width: pct(t) }} />
          </div>
          <div className="scrub-thumb" style={{ left: pct(t) }} />
          <div className="src-mark in" style={{ left: pct(inT) }} onPointerDown={dragIn} title={$t('入點 {0}（拖曳調整，I 設在播放位置）', fmt(inT))} />
          <div className="src-mark out" style={{ left: pct(out) }} onPointerDown={dragOut} title={$t('出點 {0}（拖曳調整，O 設在播放位置）', fmt(out))} />
        </div>
      )}
      <div className="transport-row">
        {timed && (
          <>
            <button className="tp" title={$t('回到入點')} onClick={() => seek(inT)}><SkipBack size={15} /></button>
            <button className="tp play" title={$t('播放 / 暫停 (Space)')} onClick={toggle}>{playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}</button>
            <span className="tp-time">{fmt(t)}</span>
            {(inT > 0 || outT !== null) && (
              <span className="src-len muted small">
                {$t('長度 {0}s', (out - inT).toFixed(2))}
                <button className="tp" title={$t('清除入點 / 出點')} onClick={() => useSource.setState({ inT: 0, outT: null })}><X size={13} /></button>
              </span>
            )}
          </>
        )}
        <span className="spacer" />
        <button className="btn primary small-h" title={$t('把入點~出點這段插入到時間軸的播放頭')} onClick={insert}>
          <Clapperboard size={14} /> {$t('插入片段')}
        </button>
        <button className="tp" title={$t('回到時間軸 (Esc)')} onClick={closeSource}><X size={14} /></button>
      </div>
    </div>
  );
}

function SourceWave({ media }: { media: Media }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    const peaks = media.peaks;
    if (!c || !peaks) return;
    const W = 800, H = 160;
    c.width = W;
    c.height = H;
    const g = c.getContext('2d')!;
    g.fillStyle = 'rgba(110, 231, 200, 0.8)';
    for (let x = 0; x < W; x++) {
      const i0 = Math.floor((x / W) * peaks.length);
      const i1 = Math.max(i0, Math.floor(((x + 1) / W) * peaks.length));
      let m = 0;
      for (let i = i0; i <= i1 && i < peaks.length; i++) m = Math.max(m, peaks[i]);
      const h = Math.max(1, m * H);
      g.fillRect(x, (H - h) / 2, 1, h);
    }
  }, [media]);
  return <canvas ref={ref} className="source-wave" />;
}
