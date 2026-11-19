import { $t, displayName } from '../i18n';
import { Diamond, X } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import { projectDuration, useStore, type Clip, type Media } from '../store';
import { Renderer, computeFrame, makeCtx, setRenderer } from '../engine/renderer';
import { setRemapErrorReporter } from '../engine/remap';
import { syncAudioPreview, stopAudioPreview } from '../engine/audio';
import { parseDuration } from '../engine/params';
import { clipTransformAt, fitSize, isAnimated, setPropsAt, type Transform } from '../engine/transform';
import { textSize } from '../engine/text';
import { MaskGizmos } from './MaskEditor';
import { stopPreviewFx, useLayout, usePreviewFx } from './uiStore';
import { hasSourcePanel } from './SourcePanel';

const frameAspect = () => useStore.getState().format.w / useStore.getState().format.h;
const TRANSITION_PREVIEW = 0.8;

export function Preview() {
  const ref = useRef<HTMLCanvasElement>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let r: Renderer;
    try {
      r = new Renderer(ref.current!);
    } catch (e) {
      setErr(String(e));
      return;
    }
    setRenderer(r);
    const report = (id: string, msg: string | null) => useStore.getState().setError(id, msg);
    r.onError = report;
    setRemapErrorReporter(report);

    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const st = useStore.getState();
      if (!st.exporting) {
        let t = st.time;
        if (st.playing) {
          t += Math.min(0.1, (now - last) / 1000);
          const end = projectDuration(st);
          if (st.loop && t >= st.loop.b) t = st.loop.a;
          else if (!st.loop && t >= end) {
            t = end;
            useStore.setState({ playing: false });
          }
          useStore.setState({ time: t });
          stopPreviewFx();
        }
        // 輸出比例 / 預覽畫質
        const sc = useLayout.getState().previewScale || 1;
        r.setSize(st.format.w * sc, st.format.h * sc, st.format.h);
        const ctx = makeCtx(st);
        // 素材庫點選的特效 / 轉場：循環預覽
        let extra;
        const fx = usePreviewFx.getState().fx;
        const m = fx && ctx.modules.get(fx.moduleId);
        // 版面有「素材預覽」分頁時，試看顯示在那裡；沒有才疊在主預覽上
        if (fx && m && !hasSourcePanel()) {
          const dur = m.kind === 'transition' ? TRANSITION_PREVIEW : parseDuration(m.code, 0.5);
          const el = ((now - fx.t0) / 1000) % (dur + 0.6);
          extra = { module: m, progress: Math.min(1, el / dur), duration: dur };
        }
        r.render(ctx, t, 'preview', st.playing, extra);
        syncAudioPreview(st, t, st.playing);
        // 閒置時預先編譯 shader，播放時第一次遇到特效才不會卡
        if (!st.playing) r.warmup(ctx.modules);
      }
      last = now;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      r.pauseAll();
      stopAudioPreview();
      setRenderer(null);
    };
  }, []);

  return (
    <div className="preview">
      {err ? <div className="fatal">{err}</div> : <canvas ref={ref} />}
      <Gizmo canvasRef={ref} />
      <FxPreviewLabel />
    </div>
  );
}

function FxPreviewLabel() {
  const fx = usePreviewFx((s) => s.fx);
  const name = useStore((s) => (fx ? s.modules.find((m) => m.id === fx.moduleId)?.name : null));
  if (!fx || !name || hasSourcePanel()) return null;
  const label = displayName(name);
  return (
    <div className="fx-preview-label">
      {$t('預覽：')}{label}
      <button onClick={stopPreviewFx} title={$t('結束預覽 (Esc)')}><X size={12} /></button>
    </div>
  );
}

// ───────────────────────── 變換控制框 ─────────────────────────

interface Box { cx: number; cy: number; w: number; h: number; rot: number }

function boxOf(clip: Clip, media: Media | undefined, local: number, W: number, H: number): Box & { xf: Transform } {
  const xf = clipTransformAt(clip, local);
  const [sw, sh] = clip.text ? textSize(clip.text, useStore.getState().format.h) : fitSize(clip.fit === 'cover', media!.width / media!.height, frameAspect());
  return { xf, cx: (0.5 + xf.x) * W, cy: (0.5 + xf.y) * H, w: sw * xf.scale * H, h: sh * xf.scale * H, rot: xf.rotation };
}

function hit(b: Box, x: number, y: number) {
  const a = (-b.rot * Math.PI) / 180;
  const dx = x - b.cx, dy = y - b.cy;
  const lx = dx * Math.cos(a) - dy * Math.sin(a);
  const ly = dx * Math.sin(a) + dy * Math.cos(a);
  return Math.abs(lx) <= b.w / 2 && Math.abs(ly) <= b.h / 2;
}

/** 改變換：有關鍵影格的屬性會在播放頭打 key */
function applyAt(clipId: string, values: Partial<Transform>, local: number) {
  const s = useStore.getState();
  const c = s.clips.find((x) => x.id === clipId);
  if (c) s.updateClip(clipId, setPropsAt(c, values, Math.min(c.duration, Math.max(0, local))));
}

function dragWin(onMove: (ev: PointerEvent) => void, onUp?: () => void) {
  const up = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', up);
    onUp?.();
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', up);
}

const SNAP = 0.025;
/** Shift 吸附：中心、三分線、畫面邊緣；回傳吸附後的值與參考線位置（0~1） */
function snapAxis(v: number, half: number): { v: number; guide: number | null } {
  const cands: [number, number][] = [
    [0, 0.5],
    [-1 / 6, 1 / 3],
    [1 / 6, 2 / 3],
    [-0.5 + half, 0], // 左 / 上邊貼齊
    [0.5 - half, 1], // 右 / 下邊貼齊
  ];
  let best: [number, number] | null = null;
  for (const c of cands) if (Math.abs(v - c[0]) < SNAP && (!best || Math.abs(v - c[0]) < Math.abs(v - best[0]))) best = c;
  return best ? { v: best[0], guide: best[1] } : { v, guide: null };
}

function Gizmo({ canvasRef }: { canvasRef: React.RefObject<HTMLCanvasElement> }) {
  const [rect, setRect] = useState({ left: 0, top: 0, width: 0, height: 0 });
  const [guides, setGuides] = useState<{ x: number | null; y: number | null }>({ x: null, y: null });
  const layerRef = useRef<HTMLDivElement>(null);
  const sel = useStore((s) => s.selection);
  const clip = useStore((s) => (sel?.type === 'clip' ? s.clips.find((c) => c.id === sel.id) : undefined));
  const media = useStore((s) => (clip ? s.media.find((m) => m.id === clip.mediaId) : undefined));
  const time = useStore((s) => s.time);
  const grid = useLayout((s) => s.grid);
  const gridCfg = { rows: useLayout((s) => s.gridRows), cols: useLayout((s) => s.gridCols), center: useLayout((s) => s.gridCenter), safe: useLayout((s) => s.gridSafe) };

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const upd = () => setRect({ left: c.offsetLeft, top: c.offsetTop, width: c.clientWidth, height: c.clientHeight });
    const ro = new ResizeObserver(upd);
    ro.observe(c);
    ro.observe(c.parentElement!);
    upd();
    return () => ro.disconnect();
  }, [canvasRef]);

  const W = rect.width, H = rect.height;
  const local = clip ? time - clip.start : -1;
  const visible = !!clip && (!!clip.text || (!!media && media.kind !== 'audio')) && local >= 0 && local < clip.duration;
  const box = visible ? boxOf(clip!, media, local, W, H) : null;

  const pt = (ev: { clientX: number; clientY: number }) => {
    const r = layerRef.current!.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  };

  /** 開始拖曳：依 mode 改位置 / 縮放 / 旋轉。按住 Shift = 吸附 */
  const begin = (e: React.PointerEvent, c: Clip, m: Media | undefined, mode: 'move' | 'scale' | 'rotate') => {
    e.stopPropagation();
    e.preventDefault();
    stopPreviewFx();
    const s = useStore.getState();
    const l = s.time - c.start;
    const base = clipTransformAt(c, Math.min(c.duration, Math.max(0, l)));
    const b = boxOf(c, m, l, W, H);
    const p0 = pt(e);
    const d0 = Math.hypot(p0.x - b.cx, p0.y - b.cy) || 1;
    const a0 = Math.atan2(p0.y - b.cy, p0.x - b.cx);
    const apply = (patch: Partial<Transform>) => applyAt(c.id, patch, l);
    dragWin(
      (ev) => {
        const p = pt(ev);
        if (mode === 'move') {
          let x = base.x + (p.x - p0.x) / W;
          let y = base.y + (p.y - p0.y) / H;
          let g = { x: null as number | null, y: null as number | null };
          if (ev.shiftKey) {
            const sx = snapAxis(x, b.w / 2 / W);
            const sy = snapAxis(y, b.h / 2 / H);
            x = sx.v;
            y = sy.v;
            g = { x: sx.guide, y: sy.guide };
          }
          setGuides(g);
          apply({ x, y });
        } else if (mode === 'scale') {
          let sc = Math.max(0.02, base.scale * (Math.hypot(p.x - b.cx, p.y - b.cy) / d0));
          if (ev.shiftKey) sc = Math.max(0.05, Math.round(sc / 0.05) * 0.05);
          apply({ scale: Math.round(sc * 1000) / 1000 });
        } else {
          let r = base.rotation + ((Math.atan2(p.y - b.cy, p.x - b.cx) - a0) * 180) / Math.PI;
          if (ev.shiftKey) r = Math.round(r / 15) * 15;
          apply({ rotation: Math.round(r * 10) / 10 });
        }
      },
      () => setGuides({ x: null, y: null }),
    );
  };

  /** 點畫面：選取最上層、被點到的片段，並直接開始拖曳 */
  const onLayerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    stopPreviewFx();
    const s = useStore.getState();
    const ctx = makeCtx(s);
    const p = pt(e);
    for (let ti = ctx.videoTracks.length - 1; ti >= 0; ti--) {
      if (s.tracks.video[ti]?.hidden) continue;
      const fr = computeFrame(ctx.videoTracks[ti], s.time);
      const c = fr.kind === 'clip' ? fr.clip : fr.kind === 'transition' ? (fr.progress < 0.5 ? fr.A ?? fr.B : fr.B ?? fr.A) : null;
      const m = c ? ctx.media.get(c.mediaId) : undefined;
      if (!c || (!m && !c.text)) continue;
      const l = Math.min(c.duration - 1e-3, Math.max(0, s.time - c.start));
      if (hit(boxOf(c, m, l, W, H), p.x, p.y)) {
        s.select({ type: 'clip', id: c.id });
        begin(e, c, m, 'move');
        return;
      }
    }
    s.select(null);
  };

  const onWheel = (e: React.WheelEvent) => {
    if (!clip || !visible) return;
    const base = clipTransformAt(clip, local);
    let sc = Math.max(0.02, base.scale * (e.deltaY < 0 ? 1.05 : 1 / 1.05));
    if (e.shiftKey) sc = Math.max(0.05, Math.round(sc / 0.05) * 0.05);
    applyAt(clip.id, { scale: sc }, local);
  };

  return (
    <div ref={layerRef} className="gizmo-layer" style={{ left: rect.left, top: rect.top, width: W, height: H }} onPointerDown={onLayerDown} onWheel={onWheel}>
      {grid && (
        <svg className="grid-overlay" width={W} height={H}>
          {Array.from({ length: gridCfg.cols - 1 }, (_, i) => (i + 1) / gridCfg.cols).map((f) => <line key={'c' + f} x1={f * W} y1={0} x2={f * W} y2={H} />)}
          {Array.from({ length: gridCfg.rows - 1 }, (_, i) => (i + 1) / gridCfg.rows).map((f) => <line key={'r' + f} x1={0} y1={f * H} x2={W} y2={f * H} />)}
          {gridCfg.center && (
            <>
              <line className="center" x1={W / 2} y1={H / 2 - 10} x2={W / 2} y2={H / 2 + 10} />
              <line className="center" x1={W / 2 - 10} y1={H / 2} x2={W / 2 + 10} y2={H / 2} />
            </>
          )}
          {/* 短影音安全區：右側按鈕、下方標題 */}
          {gridCfg.safe && <rect className="safe" x={W * 0.04} y={H * 0.08} width={W * 0.8} height={H * 0.7} />}
        </svg>
      )}
      {(guides.x !== null || guides.y !== null) && (
        <svg className="snap-guides" width={W} height={H}>
          {guides.x !== null && <line x1={guides.x * W} y1={0} x2={guides.x * W} y2={H} />}
          {guides.y !== null && <line x1={0} y1={guides.y * H} x2={W} y2={guides.y * H} />}
        </svg>
      )}
      <MaskGizmos W={W} H={H} />
      {box && clip && (
        <div
          className="gizmo"
          style={{ left: box.cx - box.w / 2, top: box.cy - box.h / 2, width: box.w, height: box.h, transform: `rotate(${box.rot}deg)` }}
          onPointerDown={(e) => e.button === 0 && begin(e, clip, media, 'move')}
        >
          {(['x', 'y', 'scale', 'rotation'] as const).some((p) => isAnimated(clip, p)) && <span className="gizmo-tag"><Diamond size={10} fill="currentColor" /> {$t('關鍵影格')}</span>}
          {['tl', 'tr', 'bl', 'br'].map((k) => (
            <div key={k} className={`gh ${k}`} onPointerDown={(e) => begin(e, clip, media, 'scale')} />
          ))}
          <div className="grot" onPointerDown={(e) => begin(e, clip, media, 'rotate')} title={$t('拖曳旋轉（Shift = 15° 一格）')} />
        </div>
      )}
    </div>
  );
}
