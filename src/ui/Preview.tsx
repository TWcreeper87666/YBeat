import { $t, displayName } from '../i18n';
import { Diamond, X } from 'lucide-react';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { flushSync } from 'react-dom';
import { axisAligned, gridSnapLines, rotatedHalf, snapMoveAxis, snapScaleAxis } from '../engine/snap';
import { projectDuration, remapFor, srcAvail, useStore, type Clip, type Media } from '../store';
import { getRenderer, Renderer, computeFrame, makeCtx, setRenderer } from '../engine/renderer';
import { setRemapErrorReporter } from '../engine/remap';
import { syncAudioPreview, stopAudioPreview } from '../engine/audio';
import { parseDuration } from '../engine/params';
import { trialTransitionAt, withClip } from '../engine/trialTransition';
import { clipTransformAt, fitSize, isAnimated, setPropsAt, type Transform } from '../engine/transform';
import { textSize } from '../engine/text';
import { MaskGizmos, cfxMaskKey, useMaskEdit } from './MaskEditor';
import { GridOverlay } from './GridOverlay';
import { stopPreviewFx, toast, useColorPick, useLayout, usePreviewFx } from './uiStore';
import { useEditorWindow } from './EditorWindow';

const frameAspect = () => useStore.getState().format.w / useStore.getState().format.h;

/**
 * 預覽畫面的檢視縮放 / 平移（只在編輯視窗裡用）：z = 相對「符合視窗」的倍率，px / py = 平移（CSS px）。
 * 直接改 canvas 的顯示大小與位置（不用 CSS transform），變換框 / 遮罩框的座標計算不用改。
 */
export const usePreviewView = create<{ z: number; px: number; py: number }>(() => ({ z: 1, px: 0, py: 0 }));
const resetView = () => usePreviewView.setState({ z: 1, px: 0, py: 0 });
useEditorWindow.subscribe((s, p) => s.open !== p.open && resetView()); // 開 / 關編輯視窗都回到符合視窗
const ZMIN = 0.25, ZMAX = 8;
const PAD = 14; // .preview 的 padding
const TRANSITION_PREVIEW = 0.8;

export function Preview() {
  const ref = useRef<HTMLCanvasElement>(null);
  const [err, setErr] = useState<string | null>(null);
  const pickingColor = useColorPick((s) => !!s.pick);

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
    // 播放時鐘：時間軸時間 = 開始播放的時間 + 真實經過的時間（不是每幀累加）。
    // 渲染慢、掉幀時時間軸也不會落後，影片 / 聲音（照真實時間在播）就不用一直被拉回來對時。
    let clock: { t: number; perf: number } | null = null;
    let lastSet = NaN;
    let trialLoop = -1; // 剪接點試看轉場：第幾圈（換圈時影片要重新對時）
    const loop = (now: number) => {
      const st = useStore.getState();
      if (!st.exporting) {
        let t = st.time;
        if (st.playing) {
          // 剛開始播放，或時間被別的地方改了（拖播放頭、Home / End…）→ 重新對準
          if (!clock || Math.abs(st.time - lastSet) > 1e-9) clock = { t: st.time, perf: now };
          t = clock.t + (now - clock.perf) / 1000;
          const end = projectDuration(st);
          // 循環播放開關：時間軸播到專案結尾、編輯視窗播到片段結尾 → 回到開頭，或停下來
          // （時間軸上自己設的 A-B 循環一律循環）
          const repeat = useLayout.getState().repeat;
          const editorScope = useEditorWindow.getState().open;
          if (st.loop && t >= st.loop.b) {
            if (editorScope && !repeat) {
              t = Math.max(st.loop.a, st.loop.b - 1 / 60);
              useStore.setState({ playing: false });
            } else {
              t = st.loop.a;
              clock = { t, perf: now };
            }
          } else if (!st.loop && t >= end) {
            if (repeat && end > 0) {
              t = 0;
              clock = { t, perf: now };
            } else {
              t = end;
              useStore.setState({ playing: false });
            }
          }
          lastSet = t;
          useStore.setState({ time: t });
          stopPreviewFx();
        } else clock = null;
        // 輸出比例 / 預覽畫質
        const sc = useLayout.getState().previewScale || 1;
        r.setSize(st.format.w * sc, st.format.h * sc, st.format.h);
        let ctx = makeCtx(st);
        // 素材庫點選的特效 / 轉場：循環預覽
        let extra;
        let rt = t, rPlaying = st.playing;
        const fx = usePreviewFx.getState().fx;
        const m = fx && ctx.modules.get(fx.moduleId);
        const trial = !fx || !m || st.playing
          ? null
          : m.kind === 'transition'
            ? trialTransitionAt(ctx, t, m, parseDuration(m.code, TRANSITION_PREVIEW), 0.1, st.activeTrack?.kind === 'video' ? st.activeTrack.idx : undefined)
            : m.kind === 'remap'
              ? trialRemap(st, ctx, m.id, t)
              : null;
        if (fx && m?.kind === 'remap' && !trial) {
          trialLoop = -1; // 變速：沒有可以試看的影片片段就不顯示
        } else if (fx && trial) {
          // 轉場：播放頭在剪接點上，用前一段的尾巴、後一段的開頭試看
          // 變速：選取的（或播放頭底下的）影片片段套上這個變速，整段循環播放
          const span = Math.max(0.1, trial.hi - trial.lo);
          const el = (now - fx.t0) / 1000;
          const lap = Math.floor(el / span);
          if (lap !== trialLoop) r.pauseAll(); // 換圈：影片重新 seek
          trialLoop = lap;
          ctx = trial.ctx;
          rt = trial.lo + (el - lap * span);
          rPlaying = true;
        } else if (fx && m) {
          trialLoop = -1;
          const dur = m.kind === 'transition' ? TRANSITION_PREVIEW : parseDuration(m.code, 0.5);
          const el = ((now - fx.t0) / 1000) % (dur + 0.6);
          extra = { module: m, progress: Math.min(1, el / dur), duration: dur };
        } else trialLoop = -1;
        r.render(ctx, rt, 'preview', rPlaying, extra);
        syncAudioPreview(st, t, st.playing, useLayout.getState().scrubAudio);
        // 閒置時預先編譯 shader，播放時第一次遇到特效才不會卡
        if (!st.playing) r.warmup(ctx.modules);
      }
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

  // ── 編輯視窗：滾輪縮放整個輸出畫面、拖空白處 / 中鍵平移 ──
  const boxRef = useRef<HTMLDivElement>(null);
  const editor = useEditorWindow((s) => s.open);
  const view = usePreviewView();
  const fmt = useStore((s) => s.format);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    // ResizeObserver 在繪製前通知：flushSync 讓 canvas 跟外框同一幀更新
    const upd = () => flushSync(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    setBox({ w: el.clientWidth, h: el.clientHeight });
    const ro = new ResizeObserver(upd);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // 「符合視窗」時 canvas 的大小
  const aspect = fmt.w / fmt.h;
  const availW = Math.max(1, box.w - PAD * 2), availH = Math.max(1, box.h - PAD * 2);
  const fitW = Math.min(availW, availH * aspect), fitH = fitW / aspect;
  const zoomed = editor && (view.z !== 1 || view.px !== 0 || view.py !== 0);
  useEffect(() => {
    if (!pickingColor) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') useColorPick.setState({ pick: null });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pickingColor]);

  const sampleColor = (e: React.PointerEvent) => {
    const pick = useColorPick.getState().pick;
    if (!pick || e.button !== 0) return false;
    const canvas = ref.current;
    const rect = canvas?.getBoundingClientRect();
    if (!canvas || !rect || e.clientX < rect.left || e.clientX >= rect.right || e.clientY < rect.top || e.clientY >= rect.bottom) return false;
    e.preventDefault();
    e.stopPropagation();
    const color = getRenderer()?.sampleColor((e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height);
    useColorPick.setState({ pick: null });
    if (color) pick(color);
    else toast($t('無法取樣顏色'), 'error');
    return true;
  };
  const canvasStyle: React.CSSProperties | undefined = zoomed
    ? { position: 'absolute', maxWidth: 'none', maxHeight: 'none', width: fitW * view.z, height: fitH * view.z, left: (box.w - fitW * view.z) / 2 + view.px, top: (box.h - fitH * view.z) / 2 + view.py }
    : undefined;

  useEffect(() => {
    const el = boxRef.current;
    if (!el || !editor) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = usePreviewView.getState();
      const r = el.getBoundingClientRect();
      // 滑鼠底下的點保持不動
      const mx = e.clientX - r.left - r.width / 2, my = e.clientY - r.top - r.height / 2;
      const z = Math.min(ZMAX, Math.max(ZMIN, v.z * Math.pow(1.0015, -e.deltaY)));
      const k = z / v.z;
      usePreviewView.setState({ z, px: mx - (mx - v.px) * k, py: my - (my - v.py) * k });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [editor]);

  /** 平移：中鍵任何地方、或左鍵拖畫面外的空白處 */
  const startPan = (e: React.PointerEvent) => {
    if (!editor) return;
    const onBlank = e.target === e.currentTarget;
    if (!(e.button === 1 || (e.button === 0 && onBlank))) return;
    e.preventDefault();
    const x0 = e.clientX, y0 = e.clientY, v0 = usePreviewView.getState();
    document.body.classList.add('panning');
    const mv = (ev: PointerEvent) => usePreviewView.setState({ px: v0.px + ev.clientX - x0, py: v0.py + ev.clientY - y0 });
    const up = () => {
      document.body.classList.remove('panning');
      window.removeEventListener('pointermove', mv);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
  };

  return (
    <div
      ref={boxRef}
      className={`preview ${editor ? 'pannable' : ''} ${pickingColor ? 'color-picking' : ''}`}
      onPointerDownCapture={(e) => { if (!sampleColor(e) && e.button === 1) startPan(e); }}
      onPointerDown={(e) => e.button === 0 && startPan(e)}
      onDoubleClick={(e) => editor && e.target === e.currentTarget && resetView()}
    >
      {err ? <div className="fatal">{err}</div> : <canvas ref={ref} style={canvasStyle} />}
      <Gizmo canvasRef={ref} />
      <FxPreviewLabel />
      {editor && (
        <button className="view-zoom" title={$t('檢視縮放（滾輪縮放、拖曳空白處或中鍵平移；點一下回到符合視窗）')} onClick={resetView}>
          {Math.round(view.z * 100)}%{zoomed ? ` · ${$t('符合')}` : ''}
        </button>
      )}
    </div>
  );
}

/** 變速試看的對象：選取的影片片段，沒有就用播放頭底下最上層的影片片段 */
function trialRemap(st: ReturnType<typeof useStore.getState>, ctx: ReturnType<typeof makeCtx>, moduleId: string, t: number) {
  let c = st.selection?.type === 'clip' ? ctx.clips.find((x) => x.id === st.selection!.id) : undefined;
  if (!c) {
    for (let i = ctx.videoTracks.length - 1; i >= 0 && !c; i--) {
      if (st.tracks.video[i]?.hidden) continue;
      c = ctx.videoTracks[i].find((x) => t >= x.start && t < x.start + x.duration && !x.text);
    }
  }
  if (!c || ctx.media.get(c.mediaId)?.kind !== 'video') return null;
  const c2 = { ...c, remap: remapFor(c, moduleId, st.modules, srcAvail(c, st.media)) };
  return { ctx: withClip(ctx, c2), lo: c.start, hi: c.start + c.duration - 1e-3 };
}

function FxPreviewLabel() {
  const fx = usePreviewFx((s) => s.fx);
  const name = useStore((s) => (fx ? s.modules.find((m) => m.id === fx.moduleId)?.name : null));
  if (!fx || !name) return null;
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
  return { xf, cx: (0.5 + xf.x) * W, cy: (0.5 + xf.y) * H, w: sw * Math.abs(xf.scaleX) * H, h: sh * Math.abs(xf.scaleY) * H, rot: xf.rotation };
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

// 按住旋轉把手時，整個畫面都顯示旋轉游標
window.addEventListener('pointerdown', (e) => {
  if (!(e.target as HTMLElement).closest?.('.grot, .mask-rot')) return;
  document.body.classList.add('rotating');
  const up = () => {
    document.body.classList.remove('rotating');
    window.removeEventListener('pointerup', up, true);
  };
  window.addEventListener('pointerup', up, true);
}, true);

function dragWin(onMove: (ev: PointerEvent) => void, onUp?: () => void) {
  const up = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', up);
    onUp?.();
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', up);
}

/** 吸附距離（px） */
const SNAP_PX = 8;
const snapLines = (W: number, H: number) => gridSnapLines(W, H, useLayout.getState());
type Rect = { left: number; top: number; width: number; height: number };
const sameRect = (a: Rect, b: Rect) => a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
function Gizmo({ canvasRef }: { canvasRef: React.RefObject<HTMLCanvasElement> }) {
  const [rect, setRect] = useState({ left: 0, top: 0, width: 0, height: 0 });
  const [guides, setGuides] = useState<{ x: number | null; y: number | null }>({ x: null, y: null });
  const layerRef = useRef<HTMLDivElement>(null);
  const sel = useStore((s) => s.selection);
  const clip = useStore((s) => (sel?.type === 'clip' ? s.clips.find((c) => c.id === sel.id) : undefined));
  const media = useStore((s) => (clip ? s.media.find((m) => m.id === clip.mediaId) : undefined));
  const time = useStore((s) => s.time);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const measure = () => ({ left: c.offsetLeft, top: c.offsetTop, width: c.clientWidth, height: c.clientHeight });
    // ResizeObserver 在繪製前通知：flushSync 讓框跟 canvas 同一幀更新（之前會慢一幀）
    const upd = () => flushSync(() => setRect((r) => (sameRect(r, measure()) ? r : measure())));
    const ro = new ResizeObserver(upd);
    ro.observe(c);
    ro.observe(c.parentElement!);
    setRect(measure());
    return () => ro.disconnect();
  }, [canvasRef]);
  // 檢視平移只改 canvas 位置、大小不變（ResizeObserver 不會通知）：canvas 改完樣式、繪製前量一次
  const view = usePreviewView();
  useLayoutEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const m = { left: c.offsetLeft, top: c.offsetTop, width: c.clientWidth, height: c.clientHeight };
    setRect((r) => (sameRect(r, m) ? r : m));
  }, [view, canvasRef]);

  const W = rect.width, H = rect.height;
  const local = clip ? time - clip.start : -1;
  const visible = !!clip && (!!clip.text || (!!media && media.kind !== 'audio')) && local >= 0 && local < clip.duration;
  // 正在預覽上編輯這個片段的遮罩：片段本身的變換框先藏起來，免得搶到滑鼠
  const maskKey = useMaskEdit((st) => st.key);
  const editingMask = !!maskKey && !!clip?.effects?.some((f) => cfxMaskKey(f.id) === maskKey && f.enabled !== false && (f.mask?.shape ?? 'none') !== 'none');
  const box = visible && !editingMask ? boxOf(clip!, media, local, W, H) : null;

  const pt = (ev: { clientX: number; clientY: number }) => {
    const r = layerRef.current!.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  };

  /** 開始拖曳：依 mode 改位置 / 縮放 / 旋轉。按住 Shift = 吸附 */
  const begin = (e: React.PointerEvent, c: Clip, m: Media | undefined, mode: 'move' | 'scale' | 'scaleX' | 'scaleY' | 'rotate') => {
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
            // 中心、框的四邊（含旋轉的外接框）都能吸到每一條線
            const lines = snapLines(W, H);
            const { hx, hy } = rotatedHalf(b.w, b.h, b.rot);
            const sx = snapMoveAxis((0.5 + x) * W, hx, lines.x, SNAP_PX);
            const sy = snapMoveAxis((0.5 + y) * H, hy, lines.y, SNAP_PX);
            x = sx.center / W - 0.5;
            y = sy.center / H - 0.5;
            g = { x: sx.line !== null ? sx.line / W : null, y: sy.line !== null ? sy.line / H : null };
          }
          setGuides(g);
          apply({ x, y });
        } else if (mode === 'scale' || mode === 'scaleX' || mode === 'scaleY') {
          const r3 = (v: number) => Math.round(v * 1000) / 1000;
          const al = axisAligned(b.rot);
          const lines = snapLines(W, H);
          let g = { x: null as number | null, y: null as number | null };
          if (mode === 'scale') {
            // 角：等比縮放（投影到拖曳方向；越過中心不翻轉）
            const v0x = p0.x - b.cx, v0y = p0.y - b.cy;
            let f = Math.max(0.02, ((p.x - b.cx) * v0x + (p.y - b.cy) * v0y) / (v0x * v0x + v0y * v0y || 1));
            if (ev.shiftKey && al) {
              // 框在畫面上的半寬 / 半高（旋轉 90° 時對調）
              const hx = (al.swapped ? b.h : b.w) / 2, hy = (al.swapped ? b.w : b.h) / 2;
              const sx = snapScaleAxis(b.cx, hx, f, lines.x, SNAP_PX);
              const sy = snapScaleAxis(b.cy, hy, f, lines.y, SNAP_PX);
              const pick = sx.line !== null && (sy.line === null || sx.dist <= sy.dist) ? sx : sy.line !== null ? sy : null;
              if (pick) {
                f = pick.f;
                // 另一個軸剛好也碰到線，也一起畫出來
                const onX = snapScaleAxis(b.cx, hx, f, lines.x, 1), onY = snapScaleAxis(b.cy, hy, f, lines.y, 1);
                g = { x: onX.line !== null ? onX.line / W : null, y: onY.line !== null ? onY.line / H : null };
              }
            }
            apply({ scaleX: r3(base.scaleX * f), scaleY: r3(base.scaleY * f) });
          } else {
            // 邊：只拉一個方向；拉過中心 = 翻轉（負的縮放）
            const a = (-b.rot * Math.PI) / 180;
            const local = (q: { x: number; y: number }) => {
              const dx = q.x - b.cx, dy = q.y - b.cy;
              return mode === 'scaleX' ? dx * Math.cos(a) - dy * Math.sin(a) : dx * Math.sin(a) + dy * Math.cos(a);
            };
            const l0 = local(p0) || 1;
            let f = local(p) / l0;
            if (Math.abs(f) < 0.02) f = f < 0 ? -0.02 : 0.02;
            if (ev.shiftKey && al) {
              // 這個方向在畫面上是水平還是垂直（旋轉 90° 時對調）
              const screenX = (mode === 'scaleX') !== al.swapped;
              const half = (mode === 'scaleX' ? b.w : b.h) / 2;
              const s = snapScaleAxis(screenX ? b.cx : b.cy, half, Math.abs(f), screenX ? lines.x : lines.y, SNAP_PX);
              if (s.line !== null) {
                f = Math.sign(f) * s.f;
                g = screenX ? { x: s.line / W, y: null } : { x: null, y: s.line / H };
              }
            }
            const own = mode === 'scaleX' ? 'scaleX' : 'scaleY';
            const other = mode === 'scaleX' ? 'scaleY' : 'scaleX';
            const patch: Partial<Transform> = { [own]: r3(base[own] * f) };
            if (!c.scaleUnlinked) patch[other] = r3(base[other] * Math.abs(f)); // 等比例：另一軸跟著變大小、保留正負號
            apply(patch);
          }
          setGuides(g);
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
    // 編輯遮罩中：點遮罩框外面 = 結束編輯（不會拖到片段）
    if (editingMask) return useMaskEdit.setState({ key: null });
    const s = useStore.getState();
    const ctx = makeCtx(s);
    const p = pt(e);
    // 編輯視窗：只能動正在編輯的那個片段（其他片段鎖住，不會被點選或拖走；被別的片段蓋住也點得到）
    if (useEditorWindow.getState().open) {
      const sel = s.selection;
      const c = sel?.type === 'clip' ? s.clips.find((x) => x.id === sel.id) : undefined;
      if (!c) return;
      const m = ctx.media.get(c.mediaId);
      const l = s.time - c.start;
      if ((m || c.text) && l >= 0 && l < c.duration && hit(boxOf(c, m, l, W, H), p.x, p.y)) begin(e, c, m, 'move');
      return;
    }
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
    if (useEditorWindow.getState().open) return; // 編輯視窗：滾輪是縮放整個畫面（由外層處理）
    if (!clip || !visible) return;
    const base = clipTransformAt(clip, local);
    const k = e.deltaY < 0 ? 1.05 : 1 / 1.05;
    applyAt(clip.id, { scaleX: base.scaleX * k, scaleY: base.scaleY * k }, local);
  };

  return (
    <div ref={layerRef} className="gizmo-layer" style={{ left: rect.left, top: rect.top, width: W, height: H }} onPointerDown={onLayerDown} onWheel={onWheel}>
      <GridOverlay W={W} H={H} />
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
          {(['x', 'y', 'scaleX', 'scaleY', 'rotation'] as const).some((p) => isAnimated(clip, p)) && <span className="gizmo-tag"><Diamond size={10} fill="currentColor" /> {$t('關鍵影格')}</span>}
          {['tl', 'tr', 'bl', 'br'].map((k) => (
            <div key={k} className={`gh ${k}`} title={$t('等比縮放（Shift = 吸附到畫面邊緣 / 中線 / 網格）')} onPointerDown={(e) => begin(e, clip, media, 'scale')} />
          ))}
          {(['l', 'r', 't', 'b'] as const).map((k) => (
            <div key={k} className={`gh edge ${k}`} title={$t('只拉這個方向，拉過中心 = 翻轉（Shift = 吸附）')} onPointerDown={(e) => begin(e, clip, media, k === 'l' || k === 'r' ? 'scaleX' : 'scaleY')} />
          ))}
          <div className="grot" onPointerDown={(e) => begin(e, clip, media, 'rotate')} title={$t('拖曳旋轉（Shift = 15° 一格）')} />
        </div>
      )}
    </div>
  );
}
