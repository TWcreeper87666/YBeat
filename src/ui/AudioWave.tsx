import { useEffect, useRef, useState } from 'react';
import { audioBufferPeak, getAudioBuffer, PEAKS_PER_SEC, setScrubbing, waveformLevels } from '../engine/audio';
import { useStore } from '../store';
import { dragPan } from './middlePan';
import { useLayout } from './uiStore';
import { ViewScrollbar, wheelViewAction } from './wheelView';

/** 音訊編輯視窗的雙聲道波形與播放位置。 */
export function AudioWave({ id }: { id: string }) {
  const a = useStore((s) => s.audios.find((x) => x.id === id));
  const media = useStore((s) => s.media.find((m) => m.id === a?.mediaId));
  const time = useStore((s) => s.time);
  const [buf, setBuf] = useState<AudioBuffer | null>(null);
  const dur = a?.duration ?? 0;
  const [view, setView] = useState<[number, number]>([0, dur]);
  const viewRef = useRef(view);
  viewRef.current = view;
  const bar = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => { setView([0, dur]); }, [id, dur]);
  useEffect(() => {
    setBuf(null);
    if (!media?.url) return;
    let alive = true;
    void getAudioBuffer(media.url).then((b) => { if (alive) setBuf(b); });
    return () => { alive = false; };
  }, [media?.url]);

  useEffect(() => {
    const el = bar.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      const action = wheelViewAction(e, useLayout.getState().wheelScroll);
      if (action.kind !== 'zoom' && !action.delta) return;
      e.preventDefault();
      const [v0, v1] = viewRef.current, span = v1 - v0;
      const rect = el.getBoundingClientRect();
      if (action.kind !== 'zoom') {
        const n = Math.max(0, Math.min(dur - span, v0 + action.delta / rect.width * span));
        setView([n, n + span]);
      } else {
        const anchor = v0 + Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * span;
        const next = Math.max(Math.min(0.05, dur), Math.min(dur, span * 1.0015 ** action.delta));
        const n = Math.max(0, Math.min(dur - next, anchor - (anchor - v0) / span * next));
        setView([n, n + next]);
      }
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, [dur]);

  useEffect(() => {
    const el = canvas.current;
    if (!el || !a) return;
    const draw = () => {
      const rect = el.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      el.width = Math.max(1, Math.round(rect.width * dpr));
      el.height = Math.max(1, Math.round(rect.height * dpr));
      const ctx = el.getContext('2d');
      if (!ctx) return;
      ctx.scale(dpr, dpr);
      const w = Math.max(1, Math.round(rect.width)), h = rect.height;
      const [v0, v1] = view, span = v1 - v0;
      const style = getComputedStyle(el);
      const line = style.getPropertyValue('--line-strong').trim();
      const color = style.getPropertyValue('--accent').trim();
      ctx.strokeStyle = line;
      ctx.fillStyle = line;
      ctx.font = '11px sans-serif';
      const tick = Math.pow(10, Math.floor(Math.log10(Math.max(0.01, span / 6))));
      const step = [1, 2, 5, 10].map((n) => n * tick).find((n) => span / n <= 9) ?? tick * 10;
      for (let t = Math.ceil(v0 / step) * step; t <= v1; t += step) {
        const x = (t - v0) / span * w;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
        ctx.fillText(`${t.toFixed(step < 1 ? 1 : 0)}s`, x + 3, 13);
      }
      const n = buf && buf.numberOfChannels > 1 ? 2 : 1;
      const levels = buf
        ? Array.from({ length: n }, (_, ch) => waveformLevels([buf.getChannelData(ch)], buf.sampleRate, a.in + v0 * a.rate, span * a.rate, w, audioBufferPeak(buf)))
        : [Array.from({ length: w }, (_, x) => media?.peaks?.[Math.floor((a.in + (v0 + x / w * span) * a.rate) * PEAKS_PER_SEC)] ?? 0)];
      ctx.strokeStyle = color;
      levels.forEach((values, ch) => {
        const center = 20 + (h - 20) * (ch + 0.5) / n;
        const amp = (h - 24) / n * 0.46;
        ctx.beginPath();
        values.forEach((v, x) => { ctx.moveTo(x, center - v * amp); ctx.lineTo(x, center + v * amp); });
        ctx.stroke();
      });
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(el);
    return () => ro.disconnect();
  }, [a, buf, media?.peaks, view]);

  if (!a) return null;
  const seek = (x: number) => {
    const rect = bar.current!.getBoundingClientRect();
    const [v0, v1] = viewRef.current;
    useStore.getState().setTime(a.start + v0 + Math.max(0, Math.min(1, (x - rect.left) / rect.width)) * (v1 - v0));
  };
  const down = (e: React.PointerEvent) => {
    if (e.button === 1) {
      const [v0, v1] = viewRef.current, span = v1 - v0, w = bar.current!.getBoundingClientRect().width;
      return dragPan(e, (dx) => { const n = Math.max(0, Math.min(dur - span, v0 - dx / w * span)); setView([n, n + span]); });
    }
    if (e.button !== 0) return;
    e.preventDefault();
    seek(e.clientX);
    const el = e.currentTarget as HTMLDivElement;
    el.setPointerCapture(e.pointerId);
    let moved = false;
    const start = e.clientX;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - start) < 2) return;
      if (!moved) { moved = true; setScrubbing(true); }
      seek(ev.clientX);
    };
    const up = () => {
      setScrubbing(false);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
  const head = (time - a.start - view[0]) / Math.max(1e-6, view[1] - view[0]) * 100;
  return <div className="audio-wave" ref={bar} onPointerDown={down}>
    <canvas ref={canvas} className="wave" />
    {head >= 0 && head <= 100 && <i className="audio-wave-head" style={{ left: `${head}%` }} />}
    <ViewScrollbar a={view[0]} b={view[1]} dur={dur} onChange={setView} />
  </div>;
}
