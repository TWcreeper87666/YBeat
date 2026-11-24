import React, { useEffect, useRef, useState } from 'react';
import { useMonitor } from '../engine/audio';
import { create } from 'zustand';
import { Pause, Play, X } from 'lucide-react';
import { mediaUsable, useStore, type Media } from '../store';
import { $t } from '../i18n';
import { scrubFrame, warmScrub } from '../engine/scrubCache';
import { tc } from '../engine/rulerTicks';
import { useDock } from './Dock';
import { stopPreviewFx, useEditorWindow, usePreviewFx } from './uiStore';

/**
 * 素材庫試看（顯示在「預覽」面板裡，跟特效 / 轉場試看一樣）：
 * mediaId = 素材分頁點的素材、color = 色板分頁點的顏色（兩者只會有一個）
 * inspect：屬性面板顯示這個素材的資訊（從素材庫點開時；之後在時間軸選了別的就換回去）
 */
export const useSource = create<{ mediaId: string | null; color: string | null; open: boolean; inspect: boolean; range: [number, number] | null; label: string | null }>(() => ({ mediaId: null, color: null, open: false, inspect: false, range: null, label: null }));

/** 在「預覽」面板試看素材；range = 只循環播這一段（自動剪輯的片段）、label = 顯示的名稱 */
export function openSource(mediaId: string, range: [number, number] | null = null, label: string | null = null) {
  stopPreviewFx();
  useSource.setState({ mediaId, color: null, open: true, inspect: !range, range, label });
  useDock.getState().activatePanel('preview', true);
}

/** 在「預覽」面板試看顏色 */
export function openColor(color: string) {
  stopPreviewFx();
  useSource.setState({ mediaId: null, color, open: true, inspect: false, range: null, label: null });
  useDock.getState().activatePanel('preview', true);
}

/** 回到時間軸的預覽畫面 */
export const closeSource = () => useSource.getState().open && useSource.setState({ open: false });

// 特效試看、時間軸播放 / 移動播放頭、打開編輯視窗 → 回到時間軸的預覽畫面
usePreviewFx.subscribe((s, p) => {
  if ((s.fx && !p.fx) || (s.text && !p.text)) closeSource();
});
useStore.subscribe((s, p) => {
  if ((s.playing && !p.playing) || s.time !== p.time) closeSource();
  if (s.selection && s.selection !== p.selection && useSource.getState().inspect) useSource.setState({ inspect: false });
});
useEditorWindow.subscribe((s, p) => {
  if (s.open && !p.open) closeSource();
});

/** 結束素材庫的所有試看（特效 / 轉場 / 組合 / 文字 / 素材 / 顏色） */
export function stopLibraryPreview() {
  stopPreviewFx();
  closeSource();
}
// 時間軸上多了東西（放上 / 插入 / 貼上…）：試看的東西已經用上了，結束試看
useStore.subscribe((s, p) => {
  if (s.clips.length + s.effects.length + s.audios.length > p.clips.length + p.effects.length + p.audios.length) stopLibraryPreview();
});

const fmt = (t: number) => tc(t);

/** 預覽面板裡的素材 / 顏色試看（沒有打開時回傳 null） */
export function SourceOverlay() {
  const open = useSource((s) => s.open);
  const id = useSource((s) => s.mediaId);
  const color = useSource((s) => s.color);
  const media = useStore((s) => s.media.find((m) => m.id === id));
  const range = useSource((s) => s.range);
  const label = useSource((s) => s.label);
  if (!open) return null;
  if (color) return <ColorView color={color} />;
  if (!media || !mediaUsable(media)) return null;
  return <SourceView key={`${media.id}:${range?.join('-') ?? ''}`} media={media} range={range} label={label} />;
}

/** 試看標籤：跟特效試看的一樣 */
function TrialLabel({ name }: { name: string }) {
  return (
    <div className="fx-preview-label">
      {$t('預覽：')}{name}
      <button onClick={closeSource} title={$t('結束預覽 (Esc)')}><X size={12} /></button>
    </div>
  );
}

function ColorView({ color }: { color: string }) {
  const format = useStore((s) => s.format);
  return (
    <div className="source-panel">
      <div className="source-view">
        <TrialLabel name={color.toUpperCase()} />
        <svg className="src-color" viewBox={`0 0 ${format.w} ${format.h}`}><rect width={format.w} height={format.h} rx={Math.min(format.w, format.h) * 0.02} fill={color} /></svg>
      </div>
    </div>
  );
}

// ───────────────────────── 素材 ─────────────────────────

type Keys = { toggle(): void };
/** 滑鼠目前在哪個素材預覽上（給全域快捷鍵用） */
let activeKeys: React.MutableRefObject<Keys | null> | null = null;

/** App 的快捷鍵先問這裡：滑鼠在素材預覽上時，Space 給它用 */
export function sourceHotkey(e: KeyboardEvent): boolean {
  const k = activeKeys?.current;
  if (!k || e.ctrlKey || e.metaKey || e.altKey || e.key !== ' ') return false;
  k.toggle();
  e.preventDefault();
  return true;
}

function SourceView({ media, range, label }: { media: Media; range: [number, number] | null; label: string | null }) {
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

  /**
   * 拖曳中的跳轉：上一次 seek 還沒完成就先記著，完成後再跳到最新位置
   * （每格都 seek 的話瀏覽器會一直中斷前一次，結果一張畫面都出不來）
   */
  const target = useRef<number | null>(null);
  const scrubbing = useRef(false);

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
      // 片段：只循環播範圍內
      if (range && !el.paused && target.current === null && (el.currentTime >= range[1] - 0.01 || el.currentTime < range[0] - 0.05)) el.currentTime = range[0];
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
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const on = () => setPlaying(!el.paused);
    el.addEventListener('play', on);
    el.addEventListener('pause', on);
    // 先在背景抽拖曳用的小張影格
    if (media.kind === 'video') warmScrub(media, range?.[0] ?? 0);
    // 打開就從頭（片段的開頭）循環播放
    el.currentTime = range?.[0] ?? 0;
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
  const seek = (v: number) => {
    const el = ref.current;
    target.current = v;
    setT(v);
    if (el && !el.seeking) el.currentTime = v;
  };
  // 拖進度條：跟主預覽一樣，播放中拖曳不會停下來
  const scrub = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    scrubbing.current = true;
    seek(timeAt(e.clientX));
    const mv = (ev: PointerEvent) => seek(timeAt(ev.clientX));
    const up = () => {
      scrubbing.current = false;
      window.removeEventListener('pointermove', mv);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
  };

  const toggle = () => {
    const el = ref.current;
    if (!el) return;
    if (el.paused) el.play().catch(() => {});
    else el.pause();
  };

  // 滑鼠在這個分頁上時，Space 作用在素材預覽（不是時間軸）
  keys.current = { toggle };
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
        <TrialLabel name={label ?? media.name} />
        {media.kind === 'video' && (
          <div className="src-video-wrap">
            <video ref={ref} src={media.url} playsInline loop preload="auto" onClick={toggle} />
            <canvas ref={overlay} className="src-scrub-frame" />
          </div>
        )}
        {media.kind === 'image' && <img src={media.url} alt={media.name} />}
        {media.kind === 'audio' && (
          <>
            <audio ref={ref} src={media.url} loop preload="auto" />
            <SourceWave media={media} />
          </>
        )}
      </div>
      {timed && (
        <div className="transport-row">
          <button className="tp play" title={$t('播放 / 暫停 (Space)')} onClick={toggle}>{playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}</button>
          <div className="scrub src-scrub" ref={barRef} onPointerDown={scrub}>
            <div className="scrub-track"><div className="scrub-fill" style={{ width: pct(t) }} />{range && <div className="src-range" style={{ left: pct(range[0]), width: pct(range[1] - range[0]) }} />}</div>
            <div className="scrub-thumb" style={{ left: pct(t) }} />
          </div>
          <span className="tp-time">{fmt(t)} / {fmt(dur)}</span>
        </div>
      )}
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
