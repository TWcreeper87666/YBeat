import React, { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { Clapperboard, Pause, Play, SkipBack, X } from 'lucide-react';
import { mediaUsable, useStore, type Media } from '../store';
import { $t, displayName } from '../i18n';
import { Renderer, getRenderer } from '../engine/renderer';
import { parseDuration } from '../engine/params';
import { scrubFrame } from '../engine/scrubCache';
import { panelsIn } from './dockTree';
import { useDock } from './Dock';
import { revealSelection, stopPreviewFx, usePreviewFx } from './uiStore';

/** 素材預覽：目前顯示的素材與入點 / 出點 */
export const useSource = create<{ mediaId: string | null; inT: number; outT: number | null }>(() => ({ mediaId: null, inT: 0, outT: null }));

/** 在「素材預覽」分頁打開素材 */
export function openSource(mediaId: string, activate = true) {
  stopPreviewFx();
  if (useSource.getState().mediaId !== mediaId) useSource.setState({ mediaId, inT: 0, outT: null });
  if (activate) useDock.getState().activatePanel('source');
}

/** 版面裡有沒有「素材預覽」分頁（沒有的話特效試看就疊在主預覽上） */
export const hasSourcePanel = () => panelsIn(useDock.getState().layout).includes('source');

// 特效 / 轉場試看開始時切到「素材預覽」；時間軸開始播放時切回「預覽」
usePreviewFx.subscribe((s, p) => {
  if (s.fx && !p.fx && hasSourcePanel()) useDock.getState().activatePanel('source');
});
useStore.subscribe((s, p) => {
  if (s.playing && !p.playing) useDock.getState().activatePanel('preview', true);
});

const fmt = (t: number) => {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
};

export function SourcePanel() {
  const fx = usePreviewFx((s) => s.fx);
  const id = useSource((s) => s.mediaId);
  const media = useStore((s) => s.media.find((m) => m.id === id));
  if (fx) return <ModulePreview moduleId={fx.moduleId} t0={fx.t0} />;
  if (!media || !mediaUsable(media)) {
    return (
      <div className="source-panel empty">
        <p className="muted">{$t('在素材上按右鍵 →「預覽素材」，或按一下素材，就會在這裡顯示')}</p>
      </div>
    );
  }
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
    const S = useStore.getState();
    const kind = media.kind === 'audio' ? 'audio' : 'video';
    const dur = range?.duration ?? 2;
    S.addClip(media.id, S.time, S.trackForInsert(kind, S.time, dur), range);
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

// ───────────────────────── 特效 / 轉場試看 ─────────────────────────

const TRANSITION_PREVIEW = 0.8;

/** 轉場的「下一段」示意畫面 */
function sampleB(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, '#29d3c2');
  grad.addColorStop(1, '#3a0ca3');
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  g.fillStyle = '#fff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `900 ${Math.round(Math.min(w, h) * 0.4)}px system-ui, sans-serif`;
  g.fillText('B', w / 2, h / 2);
  return c;
}

/**
 * 試看用的渲染器：整個 App 只建一個、一直重複使用。
 * 每次切換都新建 WebGL context 的話，瀏覽器同時能開的數量有限，舊的會被強制回收，
 * 新的 shader 就會「編譯失敗」。
 */
let shared: { canvas: HTMLCanvasElement; r: Renderer; B: HTMLCanvasElement | null; bw: number; bh: number } | null = null;
function sharedRenderer() {
  if (!shared || shared.r.gl.isContextLost()) {
    const canvas = document.createElement('canvas');
    shared = { canvas, r: new Renderer(canvas, { w: 360, h: 640 }), B: null, bw: 0, bh: 0 };
  }
  return shared;
}

/** 把目前的畫面（主預覽）套上點選的特效 / 轉場，循環播放 */
function ModulePreview({ moduleId, t0 }: { moduleId: string; t0: number }) {
  const holder = useRef<HTMLDivElement>(null);
  const mod = useStore((s) => s.modules.find((m) => m.id === moduleId));
  const fmtW = useStore((s) => s.format.w);
  const fmtH = useStore((s) => s.format.h);
  const [err, setErr] = useState<string | null>(null);
  const compileErr = useStore((s) => s.errors[moduleId] ?? null);

  useEffect(() => {
    const el = holder.current;
    if (!el || !mod) return;
    let sh: ReturnType<typeof sharedRenderer>;
    try {
      sh = sharedRenderer();
    } catch (e) {
      setErr(String(e));
      return;
    }
    setErr(null);
    const sc = Math.min(1, 720 / Math.max(fmtW, fmtH));
    const w = Math.round(fmtW * sc), h = Math.round(fmtH * sc);
    sh.r.setSize(w, h);
    if (!sh.B || sh.bw !== w || sh.bh !== h) {
      sh.B = sampleB(w, h);
      sh.bw = w;
      sh.bh = h;
    }
    sh.r.onError = (id, msg) => useStore.getState().setError(id, msg);
    el.appendChild(sh.canvas);
    let raf = 0;
    const loop = (now: number) => {
      const m = useStore.getState().modules.find((x) => x.id === moduleId);
      const main = getRenderer()?.canvas;
      if (m && main && !sh.r.gl.isContextLost()) {
        const dur = m.kind === 'transition' ? TRANSITION_PREVIEW : parseDuration(m.code, 0.5);
        const e = ((now - t0) / 1000) % (dur + 0.6);
        sh.r.thumb(m, Math.min(1, e / dur), main, sh.B!, dur);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      sh.canvas.remove();
    };
  }, [moduleId, t0, fmtW, fmtH, mod]);

  if (!mod) return null;
  return (
    <div className="source-panel">
      <div className="source-view" ref={holder}>
        {err && <div className="fatal">{err}</div>}
        {compileErr && <pre className="err src-err">{compileErr}</pre>}
      </div>
      <div className="transport-row">
        <span className={`kind ${mod.kind === 'transition' ? 'k-tr' : 'k-fx'}`}>{mod.kind === 'transition' ? $t('轉場') : $t('特效')}</span>
        <span className="source-name">{displayName(mod.name)}</span>
        <span className="spacer" />
        <span className="muted small">{$t('循環試看中（套用在目前的畫面上）')}</span>
        <button className="tp" title={$t('結束預覽 (Esc)')} onClick={stopPreviewFx}><X size={14} /></button>
      </div>
    </div>
  );
}
