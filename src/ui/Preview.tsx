import { $t, displayName } from '../i18n';
import { Diamond, X } from 'lucide-react';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { flushSync } from 'react-dom';
import { axisAligned, gridSnapLines, rotatedHalf, snapMoveAxis, snapScaleAxis } from '../engine/snap';
import { makeClip, makeTextClip, projectDuration, remapFor, srcAvail, useStore, type Clip, type FxItem, type Media } from '../store';
import { fxCombo, stillDur, usePrefs } from '../prefs';
import { getRenderer, Renderer, computeFrame, makeCtx, setRenderer } from '../engine/renderer';
import { clipSource, setRemapErrorReporter } from '../engine/remap';
import { syncAudioPreview, stopAudioPreview } from '../engine/audio';
import { parseDuration } from '../engine/params';
import { trialTransitionAt, withClip } from '../engine/trialTransition';
import { clipTransformAt, DEFAULT_TRANSFORM, fitSize, isAnimated, setPropsAt, type Transform } from '../engine/transform';
import { animBeatAt, animBeatLen, animLayers, animTransformAt, composeAnimTransform, type AnimItem, type AnimLayer } from '../engine/animation';
import { evalKeys, upsertKey, type AnimProp, type Keyframe } from '../engine/keyframes';
import { textSize } from '../engine/text';
import { MaskGizmos, animMaskKey, cfxMaskKey, useMaskEdit } from './MaskEditor';
import { GridOverlay } from './GridOverlay';
import { ParamGizmos } from './ParamGizmos';
import { TextInlineEdit } from './TextInlineEdit';
import { stopPreviewFx, toast, useAnimPick, useColorPick, useKeySel, useLayout, usePreviewFx, useTrimView } from './uiStore';
import { matteAt, MATTE_SIZE, useMatte } from '../engine/matte';
import { scoreMatte } from '../engine/subjectPop';
import { focusSection } from './EffectControls';
import { slotNames } from './animNames';
import { useEditorWindow } from './EditorWindow';
import { fps } from '../engine/rulerTicks';
import { useFaces } from '../engine/face';
import { useBoxTracks, trackKey } from '../engine/boxTrack';
import { anchorTime, frameRectToBox, putAnchor, requestSubject, subjectAt, tracking } from '../engine/follow';
import { stopBoxPick, useBoxPick } from './subjectUi';
import { leadFromBox } from '../engine/leadPick';
import { sampledNow } from '../engine/mediaSampler';
import { useAutoEdit } from '../engine/autoEditSettings';
import { sampleCtx } from './previewSample';
import { animSampleMedia } from './previewSample';
import { animTrialCtx, withAnimPlaceholders, withPlaceholderSlots } from './animTrial';

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
    let trialText: { key: object; clip: Clip } | null = null;
    let trialCombo: { key: object; item: FxItem } | null = null;
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
              t = Math.max(st.loop.a, st.loop.b - 1 / fps());
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
        // 動畫還沒放圖的位置：先用示範圖（只有預覽）
        let ctx = withAnimPlaceholders(makeCtx(st), st.format);
        // 文字分頁點選的樣式：疊在目前畫面最上層（多一條暫時的軌道），整段循環播放
        const tx = usePreviewFx.getState().text;
        if (tx && !st.playing) {
          if (trialText?.key !== tx) {
            const dur = stillDur();
            trialText = { key: tx, clip: makeTextClip(tx.preset, st.modules, { id: 'trial-text', duration: dur }) };
          }
          const c = trialText.clip;
          const el = ((now - tx.t0) / 1000) % (c.duration + 0.6);
          const clip = { ...c, track: ctx.videoTracks.length, start: t - Math.min(el, c.duration - 1e-3) };
          ctx = { ...ctx, clips: [...ctx.clips, clip], videoTracks: [...ctx.videoTracks, [clip]] };
        } else trialText = null;
        // 動畫分頁點選的範本：示範畫面（Alt+點擊 = 疊在時間軸畫面上）循環播放
        const at = usePreviewFx.getState().anim;
        let animT: number | null = null;
        if (at && !st.playing) {
          const tr = animTrialCtx(ctx, at, t, now);
          if (tr) { ctx = tr.ctx; animT = tr.t; }
        }
        // 特效 / 轉場試看：預設換成示範的 A / B 畫面（右鍵「用時間軸畫面試看」才用目前的畫面）；變速一定要用時間軸上的影片
        const fx0 = usePreviewFx.getState().fx;
        const sample = fx0 && !fx0.timeline && !st.playing && ctx.modules.get(fx0.moduleId)?.kind !== 'remap' ? sampleCtx(ctx, st.format) : null;
        if (sample) ctx = sample.ctx;
        const ft = sample ? sample.mid : t;
        // 特效分頁點選的「我的組合」：放在最上層（多一條暫時的特效軌），整段循環播放
        const fxSel = usePreviewFx.getState().fx;
        const combo = fxSel && !st.playing ? fxCombo(fxSel.moduleId) : undefined;
        if (combo && fxSel) {
          if (trialCombo?.key !== combo) trialCombo = { key: combo, item: { ...structuredClone(combo.fx), id: 'trial-combo', start: 0, track: 0 } };
          const it = trialCombo.item;
          const el = ((now - fxSel.t0) / 1000) % (it.duration + 0.6);
          ctx = { ...ctx, effects: [...ctx.effects, { ...it, track: ctx.tracks.fx.length, start: ft - Math.min(el, it.duration - 1e-3) }] };
        } else trialCombo = null;
        // 素材庫點選的特效 / 轉場：循環預覽
        let extra;
        // 修剪片段時：預覽暫時顯示邊緣那一格（播放頭不動）
        const trimT = st.playing || sample || animT !== null ? null : useTrimView.getState().t;
        let rt = animT ?? trimT ?? ft, rPlaying = st.playing;
        const fx = usePreviewFx.getState().fx;
        const m = fx && ctx.modules.get(fx.moduleId);
        const trial = !fx || !m || st.playing
          ? null
          : m.kind === 'transition'
            ? sample
              ? trialTransitionAt(ctx, sample.cut, m, parseDuration(m.code, TRANSITION_PREVIEW), 0.1)
              : trialTransitionAt(ctx, t, m, parseDuration(m.code, TRANSITION_PREVIEW), 0.1, st.activeTrack?.kind === 'video' ? st.activeTrack.idx : undefined)
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

  // ── 滾輪縮放整個輸出畫面、拖空白處 / 中鍵平移 ──
  const boxRef = useRef<HTMLDivElement>(null);
  const view = usePreviewView();
  const bg = useLayout((s) => s.previewBg);
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
  const zoomed = (view.z !== 1 || view.px !== 0 || view.py !== 0);
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
    if (!el) return;
    // 2D 畫面：滾輪直接縮放（刻意跟時間軸類的「Ctrl + 滾輪縮放」不同，見 wheelView）
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
  }, []);

  /** 平移：中鍵任何地方、或左 / 右鍵拖畫面外的空白處 */
  const startPan = (e: React.PointerEvent) => {
    const onBlank = e.target === e.currentTarget;
    if (!(e.button === 1 || ((e.button === 0 || e.button === 2) && onBlank))) return;
    e.preventDefault();
    const x0 = e.clientX, y0 = e.clientY;
    let lx = x0, ly = y0;
    let moved = false;
    document.body.classList.add('panning');
    // 每次只加這次移動的量（以目前的檢視為準）：拖曳中用滾輪縮放改了 px / py 也不會被蓋回去
    const mv = (ev: PointerEvent) => {
      if (Math.abs(ev.clientX - x0) + Math.abs(ev.clientY - y0) > 3) moved = true;
      const v = usePreviewView.getState();
      usePreviewView.setState({ px: v.px + ev.clientX - lx, py: v.py + ev.clientY - ly });
      lx = ev.clientX;
      ly = ev.clientY;
    };
    const up = () => {
      // 左鍵點空白處（沒拖）= 取消選取；編輯視窗裡不取消（取消選取會關掉編輯視窗）
      if (!moved && e.button === 0 && !useEditorWindow.getState().open) useStore.getState().select(null);
      // 右鍵拖完：放開時不要跳出右鍵選單
      if (moved && e.button === 2) {
        const block = (ev: Event) => ev.preventDefault();
        window.addEventListener('contextmenu', block, { capture: true, once: true });
        setTimeout(() => window.removeEventListener('contextmenu', block, { capture: true }), 300);
      }
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
      className={`preview pannable ${pickingColor ? 'color-picking' : ''}`}
      style={bg ? { background: bg } : undefined}
      onPointerDownCapture={(e) => { if (!sampleColor(e) && e.button === 1) startPan(e); }}
      onPointerDown={(e) => (e.button === 0 || e.button === 2) && startPan(e)}
      onDoubleClick={(e) => e.target === e.currentTarget && resetView()}
    >
      {err ? <div className="fatal">{err}</div> : <canvas ref={ref} style={canvasStyle} />}
      <Gizmo canvasRef={ref} />
      <FxPreviewLabel />
      {zoomed && (
        <button className="view-zoom" title={$t('檢視縮放（滾輪縮放、拖曳空白處或中鍵平移；點一下回到符合視窗）')} onClick={resetView}>
          {Math.round(view.z * 100)}% · {$t('符合')}
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
  const text = usePreviewFx((s) => s.text?.name);
  const anim = usePreviewFx((s) => s.anim);
  const name = useStore((s) => (fx ? s.modules.find((m) => m.id === fx.moduleId)?.name : null));
  usePrefs((s) => s.fxCombos); // 改名後更新
  const combo = fx ? fxCombo(fx.moduleId)?.name : undefined;
  const label = name ? displayName(name) : combo ? displayName(combo) : text ?? anim?.name;
  if (!label) return null;
  return (
    <div className="fx-preview-label">
      {$t('預覽：')}{label}{fx?.timeline || anim?.timeline ? ` · ${$t('時間軸畫面')}` : ''}
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

/**
 * 追蹤框：選取的片段有追蹤時顯示（框跟著片段的縮放、位置、旋轉、翻轉走）。
 * 自訂目標：錨點那一格是實線，追出來的是虛線。
 */
function SubjectOverlay({ W, H }: { W: number; H: number }) {
  const sel = useStore((s) => s.selection);
  const time = useStore((s) => s.time);
  const clips = useStore((s) => s.clips);
  const mediaList = useStore((s) => s.media);
  const tracks = useStore((s) => s.tracks);
  const modulesList = useStore((s) => s.modules);
  useFaces((f) => f.ver);
  useBoxTracks((b) => b.ver);
  const faceJobs = useFaces((f) => f.jobs);
  const faceErrors = useFaces((f) => f.errors);
  const boxJobs = useBoxTracks((b) => b.jobs);
  const boxErrors = useBoxTracks((b) => b.errors);
  if (!W || !H || sel?.type !== 'clip') return null;
  const media = new Map(mediaList.map((m) => [m.id, m]));
  const modules = new Map(modulesList.map((m) => [m.id, m]));
  const c = clips.find((x) => x.id === sel.id);
  const m = c && media.get(c.mediaId);
  if (!c || !m || !tracking(c) || c.text || m.missing || (m.kind !== 'video' && m.kind !== 'image') || tracks.video[c.track]?.hidden || time < c.start || time >= c.start + c.duration) return null;
  requestSubject(c, m, modules);
  const s = c.subject!;
  const key = s.kind === 'box' ? trackKey(m.id, s.anchors) : m.id;
  const busy = s.kind === 'face' ? faceJobs[m.id] : boxJobs[key];
  const err = s.kind === 'face' ? faceErrors[m.id] : boxErrors[key];
  const local = time - c.start;
  const f = subjectAt(c, m, local, modules);
  let shape: { cx: number; cy: number; w: number; h: number; rot: number; anchor: boolean } | null = null;
  if (f) {
    const b = boxOf(c, m, local, W, H);
    const sx = Math.sign(b.xf.scaleX) || 1, sy = Math.sign(b.xf.scaleY) || 1;
    const dx = (f.x - 0.5) * b.w * sx, dy = (f.y - 0.5) * b.h * sy;
    const ang = (b.rot * Math.PI) / 180;
    const src = s.kind === 'box' ? anchorTime(c, m, local, modules) : 0;
    const anchor = s.kind === 'box' && s.anchors.some((x) => Math.abs(x.t - src) < 0.5 / 30);
    shape = { cx: b.cx + dx * Math.cos(ang) - dy * Math.sin(ang), cy: b.cy + dx * Math.sin(ang) + dy * Math.cos(ang), w: f.w * b.w, h: f.h * b.h, rot: b.rot, anchor };
  }
  const label = s.kind === 'face' ? (err ? $t('臉部偵測失敗') : $t('臉部偵測 {0}%', Math.round(((busy?.done ?? 0) / Math.max(1, busy?.total ?? 1)) * 100))) : err ? $t('追蹤失敗') : $t('追蹤 {0}%', Math.round(((busy?.done ?? 0) / Math.max(1, busy?.total ?? 1)) * 100));
  return (
    <>
      <svg className="face-overlay" width={W} height={H}>
        {shape && (
          <g transform={`translate(${shape.cx} ${shape.cy}) rotate(${shape.rot})`} className={s.kind === 'box' && !shape.anchor ? 'tracked' : ''}>
            <rect x={-shape.w / 2} y={-shape.h / 2} width={shape.w} height={shape.h} rx={4} />
            <circle r={3} />
          </g>
        )}
      </svg>
      {(busy || err) && (
        <div className={`face-status ${err ? 'error' : ''}`} title={err ?? undefined}>
          {label}
        </div>
      )}
    </>
  );
}

/** 框選目標：在預覽上拖一個框 → 在目前這一格加錨點（Esc 取消） */
function BoxPickLayer({ W, H }: { W: number; H: number }) {
  const clipId = useBoxPick((s) => s.clipId);
  const mode = useBoxPick((s) => s.mode);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  useEffect(() => {
    if (!clipId) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && (e.stopPropagation(), stopBoxPick());
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [clipId]);
  if (!clipId || !W || !H) return null;
  const finish = (d: { x0: number; y0: number; x1: number; y1: number }) => {
    const st = useStore.getState();
    const c = st.clips.find((x) => x.id === clipId);
    const m = c && st.media.find((x) => x.id === c.mediaId);
    if (!c || !m || st.time < c.start || st.time >= c.start + c.duration) return stopBoxPick();
    const modules = new Map(st.modules.map((x) => [x.id, x]));
    const local = st.time - c.start;
    const box = frameRectToBox(c, m, local, frameAspect(), [d.x0, d.y0], [d.x1, d.y1]);
    if (!box) return;
    if (mode === 'lead') {
      const source = anchorTime(c, m, local, modules);
      stopBoxPick();
      // 這支影片還沒分析過：要先整支分析（可能要一下子）
      if (!sampledNow.has(m.id)) toast($t('分析素材中…'));
      void leadFromBox(m, source, box).then((lead) => {
        if (lead) {
          useAutoEdit.getState().set({ lead });
          toast($t('已指定主角'));
        } else toast($t('這裡找不到臉'), 'error');
      }).catch(() => toast($t('這裡找不到臉'), 'error'));
      return;
    }
    const prev = c.subject?.kind === 'box' ? c.subject.anchors : [];
    st.updateClip(c.id, { subject: { kind: 'box', anchors: putAnchor(prev, { t: anchorTime(c, m, local, modules), box }) } });
    stopBoxPick();
  };
  // 存畫面比例 0..1（拖曳中縮放檢視也不會跑掉）
  const at = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const cl = (v: number) => Math.min(1, Math.max(0, v));
    return { x: cl((e.clientX - r.left) / (r.width || 1)), y: cl((e.clientY - r.top) / (r.height || 1)) };
  };
  return (
    <div
      className="box-pick"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        const p = at(e);
        setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
      }}
      onPointerMove={(e) => drag && setDrag({ ...drag, x1: at(e).x, y1: at(e).y })}
      onPointerUp={() => {
        if (drag) finish(drag);
        setDrag(null);
      }}
    >
      {drag && <div className="box-pick-rect" style={{ left: Math.min(drag.x0, drag.x1) * W, top: Math.min(drag.y0, drag.y1) * H, width: Math.abs(drag.x1 - drag.x0) * W, height: Math.abs(drag.y1 - drag.y0) * H }} />}
      <div className="face-status">{$t(mode === 'lead' ? '指定主角' : '框選目標')}</div>
    </div>
  );
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

function applyAnimAt(animId: string, values: Partial<Transform>, local: number) {
  const s = useStore.getState();
  const a = s.anims.find((x) => x.id === animId);
  if (!a) return;
  const patch = setPropsAt({ transform: a.transform ?? DEFAULT_TRANSFORM, keys: a.keys }, values,
    animBeatAt(a, Math.min(a.duration, Math.max(0, local))));
  s.updateAnim(animId, patch);
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
// ───────────────────────── 動畫裡的物件（圖層）：預覽上的框、拖曳 ─────────────────────────

interface LayerBox extends Box { layerId: string; name: string }

/** 去背遮罩的外框（素材的 0..1 座標）；還沒算好 / 沒有主體 = 整張 */
const matteBoxes = new Map<string, [number, number, number, number]>();
function subjectBox(media: Media, t: number): [number, number, number, number] {
  const m = matteAt(media, t);
  if (!m) return [0, 0, 1, 1];
  const key = `${media.id}:${m.idx}`;
  let b = matteBoxes.get(key);
  if (!b) {
    const sc = scoreMatte(m.data, MATTE_SIZE);
    b = sc.area ? sc.bbox : [0, 0, 1, 1];
    matteBoxes.set(key, b);
  }
  return b;
}

/** 動畫裡每個看得到的圖層在預覽上的框（去背的圖層只框住主體） */
/** 素材（含預覽用的示範圖） */
function mediaById(id: string | null): Media | undefined {
  if (!id) return undefined;
  const s = useStore.getState();
  const hit = s.media.find((m) => m.id === id);
  if (hit) return hit;
  const sm = animSampleMedia(s.format.w, s.format.h);
  return [sm.scene, ...sm.people, sm.reveal].find((m) => m.id === id);
}

/** 圖層畫在畫面上時，主體（去背的範圍；沒去背 = 整張）的中心與大小（畫面比例，以畫面中心為 0） */
function slotFrame(slot: AnimItem['slots'][number], W: number, H: number) {
  const media = mediaById(slot.mediaId);
  if (!media || media.missing) return null;
  // 素材 cover 到畫面上：素材座標 → 畫面比例座標
  const k = Math.max(W / media.width, H / media.height), sx = (media.width * k) / W, sy = (media.height * k) / H;
  const [u0, v0, u1, v1] = slot.cutout?.mode === 'auto' ? subjectBox(media, media.kind === 'image' ? 0 : slot.sourceTime) : [0, 0, 1, 1];
  return { cx: ((u0 + u1) / 2 - 0.5) * sx, cy: ((v0 + v1) / 2 - 0.5) * sy, w: (u1 - u0) * sx, h: (v1 - v0) * sy };
}

/** 圖層的變換套到畫面上的一點（畫面比例座標 → 像素）：以畫面中心縮放、旋轉，再位移 */
function placePoint(t: { x: number; y: number; scaleX: number; scaleY: number; rotation: number }, cx: number, cy: number, W: number, H: number) {
  const r = (t.rotation * Math.PI) / 180;
  const px = t.scaleX * cx * W, py = t.scaleY * cy * H;
  return { x: (0.5 + t.x) * W + px * Math.cos(r) - py * Math.sin(r), y: (0.5 + t.y) * H + px * Math.sin(r) + py * Math.cos(r) };
}

/** 動畫裡每個看得到的圖層在預覽上的框（去背的圖層只框住主體；還沒放圖的用示範圖） */
function animLayerBoxes(item0: AnimItem, time: number, W: number, H: number): LayerBox[] {
  if (!W || !H || time < item0.start || time >= item0.start + item0.duration) return [];
  const item = withPlaceholderSlots(item0);
  const names = slotNames(item0);
  const out: LayerBox[] = [];
  for (const d of animLayers(item, time, animBeatLen(item), W / H)) {
    if (d.layer.text) continue;
    const f = slotFrame(d.slot, W, H);
    if (!f) continue;
    const c = placePoint(d, f.cx, f.cy, W, H);
    out.push({ layerId: d.layer.id, name: names.get(d.slot.id) ?? '', cx: c.x, cy: c.y,
      w: Math.abs(d.scaleX) * f.w * W, h: Math.abs(d.scaleY) * f.h * H, rot: d.rotation });
  }
  return out;
}

/** 預覽上位移 (dx, dy)（畫面比例）→ 圖層自己的位移：整體有旋轉 / 縮放時，要先轉回整體的座標 */
function toLayerDelta(item: AnimItem, beat: number, dx: number, dy: number, aspect: number) {
  const all = animTransformAt(item, beat);
  const rad = (-all.rotation * Math.PI) / 180;
  const px = dx * aspect, py = dy;
  return { x: (px * Math.cos(rad) - py * Math.sin(rad)) / (aspect * (all.scaleX || 1)), y: (px * Math.sin(rad) + py * Math.cos(rad)) / (all.scaleY || 1) };
}

/** 圖層整個移動：位置有關鍵影格 = 每個關鍵影格一起移；沒有 = 改固定值 */
const shiftLayer = (l: AnimLayer, dx: number, dy: number): AnimLayer => {
  const keys = { ...l.keys };
  const base = { ...l.base };
  if (keys.x?.length) keys.x = keys.x.map((k) => ({ ...k, v: k.v + dx }));
  else base.x = (base.x ?? 0) + dx;
  if (keys.y?.length) keys.y = keys.y.map((k) => ({ ...k, v: k.v + dy }));
  else base.y = (base.y ?? 0) + dy;
  return { ...l, keys, base };
};

/** 選中預覽上的動畫物件：屬性面板捲到它的圖層、預覽顯示它的位置路徑 */
function pickAnimLayer(animId: string, layerId: string | null) {
  useAnimPick.setState({ animId, layerId });
  if (!layerId) return;
  useKeySel.setState({ owner: `anim:${animId}`, channel: `${layerId}:x`, keys: [], sel: null });
  focusSection(`layer.${layerId}`);
}

/** 拖預覽上的動畫物件：整個圖層（含所有位置關鍵影格）跟著滑鼠移動 */
function dragAnimLayer(e: React.PointerEvent, item: AnimItem, layerId: string, W: number, H: number) {
  e.stopPropagation();
  e.preventDefault();
  stopPreviewFx();
  pickAnimLayer(item.id, layerId);
  const orig = item.layers.find((l) => l.id === layerId);
  if (!orig) return;
  const beat = animBeatAt(item, Math.max(0, Math.min(item.duration, useStore.getState().time - item.start)));
  const x0 = e.clientX, y0 = e.clientY;
  dragWin((ev) => {
    const d = toLayerDelta(item, beat, (ev.clientX - x0) / W, (ev.clientY - y0) / H, W / H);
    const cur = useStore.getState().anims.find((a) => a.id === item.id);
    if (cur) useStore.getState().updateAnim(item.id, { layers: cur.layers.map((l) => (l.id === layerId ? shiftLayer(orig, d.x, d.y) : l)) });
  });
}

function Gizmo({ canvasRef }: { canvasRef: React.RefObject<HTMLCanvasElement> }) {
  const [rect, setRect] = useState({ left: 0, top: 0, width: 0, height: 0 });
  const [guides, setGuides] = useState<{ x: number | null; y: number | null }>({ x: null, y: null });
  /** 正在預覽上直接改字的文字片段 */
  const [editingText, setEditingText] = useState<string | null>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const sel = useStore((s) => s.selection);
  const clip = useStore((s) => (sel?.type === 'clip' ? s.clips.find((c) => c.id === sel.id) : undefined));
  const anim = useStore((s) => (sel?.type === 'anim' ? s.anims.find((a) => a.id === sel.id) : undefined));
  const keyFocus = useKeySel();
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
  const pick = useAnimPick();
  const pickedLayer = anim && pick.animId === anim.id ? pick.layerId : null;
  // 動畫裡的物件：去背遮罩算好時框會更新
  useMatte((m) => m.ver);
  const layerBoxes = anim ? animLayerBoxes(anim, time, W, H) : [];
  const animMedia = { width: W || 1, height: H || 1 } as Media;
  const animBoxClip = anim ? makeClip({ id: anim.id, mediaId: '', track: anim.track, start: anim.start,
    duration: anim.duration, in: 0, fit: 'contain', scaleUnlinked: true,
    transform: animTransformAt(anim, animBeatAt(anim, Math.max(0, time - anim.start))) }) : null;
  const local = clip ? time - clip.start : -1;
  const visible = !!clip && (!!clip.text || (!!media && media.kind !== 'audio')) && local >= 0 && local < clip.duration;
  // 正在預覽上編輯這個片段的遮罩：片段本身的變換框先藏起來，免得搶到滑鼠
  const maskKey = useMaskEdit((st) => st.key);
  const editingMask = !!maskKey && (!!clip?.effects?.some((f) => cfxMaskKey(f.id) === maskKey && f.enabled !== false && (f.mask?.shape ?? 'none') !== 'none')
    || (!!anim && !clip && maskKey === animMaskKey(anim.id) && (anim.mask?.mask.shape ?? 'none') !== 'none'));
  const animVisible = !!anim && !editingMask && time >= anim.start && time < anim.start + anim.duration;
  const box = visible && !editingMask ? boxOf(clip!, media, local, W, H)
    : animVisible && animBoxClip ? boxOf(animBoxClip, animMedia, time - anim!.start, W, H) : null;

  const pt = (ev: { clientX: number; clientY: number }) => {
    const r = layerRef.current!.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  };

  /** 開始拖曳：依 mode 改位置 / 縮放 / 旋轉。按住 Shift = 吸附 */
  const begin = (e: React.PointerEvent, c: Clip, m: Media | undefined, mode: 'move' | 'scale' | 'scaleX' | 'scaleY' | 'rotate', animId?: string) => {
    e.stopPropagation();
    e.preventDefault();
    stopPreviewFx();
    const s = useStore.getState();
    const l = s.time - c.start;
    const base = animId ? animTransformAt(useStore.getState().anims.find((a) => a.id === animId)!, animBeatAt(useStore.getState().anims.find((a) => a.id === animId)!, l))
      : clipTransformAt(c, Math.min(c.duration, Math.max(0, l)));
    // 畫面寬度用輸出比例算（canvas 量到的寬高是整數 px，比例會差一點，吸附到邊緣時縮放就變成 99.9%）
    const W = H * frameAspect();
    const b = boxOf(c, m, l, W, H);
    // 拖曳中可能用滾輪縮放 / 平移檢視：每次重新量圖層，換成開始拖時的像素尺度（不然下一次移動會跳）
    const H0 = H;
    const pt = (ev: { clientX: number; clientY: number }) => {
      const r = layerRef.current!.getBoundingClientRect();
      return { x: ((ev.clientX - r.left) / (r.width || 1)) * W, y: ((ev.clientY - r.top) / (r.height || 1)) * H0 };
    };
    const p0 = pt(e);
    const d0 = Math.hypot(p0.x - b.cx, p0.y - b.cy) || 1;
    const a0 = Math.atan2(p0.y - b.cy, p0.x - b.cx);
    const apply = (patch: Partial<Transform>) => animId ? applyAnimAt(animId, patch, l) : applyAt(c.id, patch, l);
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
              const ownSnap = (k: number, tol: number) => snapScaleAxis(screenX ? b.cx : b.cy, half, k, screenX ? lines.x : lines.y, tol);
              // 等比例：另一個方向也跟著變大小，它的邊碰到線也要吸
              const otherHalf = (mode === 'scaleX' ? b.h : b.w) / 2;
              const otherSnap = (k: number, tol: number) =>
                c.scaleUnlinked ? { f: k, line: null, dist: Infinity } : snapScaleAxis(screenX ? b.cy : b.cx, otherHalf, k, screenX ? lines.y : lines.x, tol);
              const s1 = ownSnap(Math.abs(f), SNAP_PX), s2 = otherSnap(Math.abs(f), SNAP_PX);
              const pick = s1.line !== null && (s2.line === null || s1.dist <= s2.dist) ? s1 : s2.line !== null ? s2 : null;
              if (pick) {
                f = Math.sign(f) * pick.f;
                // 兩個方向剛好都碰到線，都畫出來
                const on1 = ownSnap(pick.f, 1), on2 = otherSnap(pick.f, 1);
                const lx = screenX ? on1.line : on2.line, ly = screenX ? on2.line : on1.line;
                g = { x: lx !== null ? lx / W : null, y: ly !== null ? ly / H : null };
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
      if (animBoxClip && box && hit(box, p.x, p.y)) begin(e, animBoxClip, animMedia, 'move', anim!.id);
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

  return (
    <div ref={layerRef} className="gizmo-layer" style={{ left: rect.left, top: rect.top, width: W, height: H }} onPointerDown={onLayerDown}>
      <GridOverlay W={W} H={H} />
      <SubjectOverlay W={W} H={H} />
      {(guides.x !== null || guides.y !== null) && (
        <svg className="snap-guides" width={W} height={H}>
          {guides.x !== null && <line x1={guides.x * W} y1={0} x2={guides.x * W} y2={H} />}
          {guides.y !== null && <line x1={0} y1={guides.y * H} x2={W} y2={guides.y * H} />}
        </svg>
      )}
      <MaskGizmos W={W} H={H} />
      <ParamGizmos W={W} H={H} />
      <BoxPickLayer W={W} H={H} />
      {box && (clip || animBoxClip) && editingText !== clip?.id && (() => {
        const active = (clip ?? animBoxClip)!;
        const activeMedia = clip ? media : animMedia;
        const activeAnimId = clip ? undefined : anim?.id;
        const start = (e: React.PointerEvent, mode: 'move' | 'scale' | 'scaleX' | 'scaleY' | 'rotate') => begin(e, active, activeMedia, mode, activeAnimId);
        return (
        <div
          className="gizmo"
          style={{ left: box.cx - box.w / 2, top: box.cy - box.h / 2, width: box.w, height: box.h, transform: `rotate(${box.rot}deg)` }}
          onPointerDown={(e) => { if (e.button !== 0) return; if (anim && !clip) useAnimPick.setState({ animId: anim.id, layerId: null }); start(e, 'move'); }}
          onDoubleClick={() => clip?.text && setEditingText(clip.id)}
        >
          {(['x', 'y', 'scaleX', 'scaleY', 'rotation'] as const).some((p) => clip ? isAnimated(clip, p) : !!anim?.keys?.[p]?.length) && <span className="gizmo-tag"><Diamond size={10} fill="currentColor" /> {$t('關鍵影格')}</span>}
          {['tl', 'tr', 'bl', 'br'].map((k) => (
            <div key={k} className={`gh ${k}`} title={$t('等比縮放（Shift = 吸附到畫面邊緣 / 中線 / 網格）')} onPointerDown={(e) => start(e, 'scale')} />
          ))}
          {(['l', 'r', 't', 'b'] as const).map((k) => (
            <div key={k} className={`gh edge ${k}`} title={$t('只拉這個方向，拉過中心 = 翻轉（Shift = 吸附）')} onPointerDown={(e) => start(e, k === 'l' || k === 'r' ? 'scaleX' : 'scaleY')} />
          ))}
          <div className="grot" onPointerDown={(e) => start(e, 'rotate')} title={$t('拖曳旋轉（Shift = 15° 一格）')} />
        </div>
        );
      })()}
      {anim && !clip && !editingMask && layerBoxes.map((b) => (
        <div key={b.layerId} className={`anim-layer-box ${pickedLayer === b.layerId ? 'on' : ''}`}
          style={{ left: b.cx - b.w / 2, top: b.cy - b.h / 2, width: b.w, height: b.h, transform: `rotate(${b.rot}deg)` }}
          onPointerDown={(e) => e.button === 0 && dragAnimLayer(e, anim, b.layerId, W, H)}>
          <span className="anim-layer-name">{b.name}</span>
        </div>
      ))}
      {anim && <AnimMotionPath item={anim} channel={keyFocus.owner === `anim:${anim.id}` ? keyFocus.channel ?? keyFocus.sel?.ch ?? null : null} time={time} W={W} H={H} />}
      {box && clip?.text && editingText === clip.id && <TextInlineEdit clip={clip} box={box} scaleX={box.xf.scaleX} scaleY={box.xf.scaleY} H={H} onClose={() => setEditingText(null)} />}
    </div>
  );
}

function AnimMotionPath({ item, channel, time, W, H }: { item: AnimItem; channel: string | null; time: number; W: number; H: number }) {
  const ks = useKeySel();
  if (!channel || !/^(all|[^:]+):(x|y)$/.test(channel) || !W || !H) return null;
  const [layerId] = channel.split(':');
  const layer = layerId === 'all' ? null : item.layers.find((l) => l.id === layerId);
  if (layerId !== 'all' && !layer) return null;
  const keys = layer ? layer.keys : item.keys;
  const times = [...new Set([...(keys?.x ?? []), ...(keys?.y ?? [])].map((k) => k.t))].sort((a, b) => a - b)
    .filter((b) => b >= (layer?.fromBeat ?? 0) && b < (layer?.toBeat ?? Infinity));
  if (!times.length) return null;
  const aspect = W / H;
  const at = (beat: number) => {
    const whole = animTransformAt(item, beat);
    if (!layer) return whole;
    const base = layer.base ?? {};
    const value = (p: AnimProp, fallback: number) => layer.keys[p]?.length ? evalKeys(layer.keys[p]!, beat) : base[p] ?? fallback;
    return composeAnimTransform({ x: value('x', 0), y: value('y', 0), scaleX: value('scaleX', 1),
      scaleY: value('scaleY', 1), rotation: value('rotation', 0), opacity: 1 }, whole, aspect);
  };
  // 路徑走的是物件看得到的中心（去背的主體中心），跟預覽上的框對齊；整體 = 畫面中心
  const slot = layer ? withPlaceholderSlots(item).slots.find((sl) => sl.id === layer.slotId) : undefined;
  const f = slot ? slotFrame(slot, W, H) : null;
  const point = (beat: number) => placePoint(at(beat), f?.cx ?? 0, f?.cy ?? 0, W, H);
  const breaks = [...new Set([...times, ...(layer ? Object.values(item.keys ?? {}).flatMap((list) => list?.map((k) => k.t) ?? []) : [])])]
    .filter((b) => b >= times[0] && b <= times[times.length - 1]).sort((a, b) => a - b);
  const samples = breaks.flatMap((b, i) => i === breaks.length - 1 ? [b]
    : Array.from({ length: 13 }, (_, j) => b + (breaks[i + 1] - b) * j / 13));
  const current = point(animBeatAt(item, Math.max(0, Math.min(item.duration, time - item.start))));
  // 屬性面板選取的位置關鍵影格（x 或 y 任一個被選就算那一拍）
  const prefix = layer ? `${layer.id}:` : 'all:';
  const selected = new Set<number>();
  if (ks.owner === `anim:${item.id}`) for (const r of ks.keys) {
    if (r.ch !== `${prefix}x` && r.ch !== `${prefix}y`) continue;
    const k = (r.ch.endsWith('x') ? keys?.x : keys?.y)?.find((x) => x.id === r.id);
    if (k) selected.add(k.t);
  }
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
  /** 拖一個點：它被選了 = 選取的點全部一起移動；沒被選 = 只移它 */
  /** 這一拍的位置關鍵影格（x、y 各一個，有的話） */
  const refsAt = (beat: number) => (['x', 'y'] as const).flatMap((p) =>
    (keys?.[p] ?? []).filter((k) => near(k.t, beat)).map((k) => ({ ch: `${prefix}${p}`, id: k.id })));
  const drag = (e: React.PointerEvent, beat: number) => {
    e.stopPropagation(); e.preventDefault();
    const owner = `anim:${item.id}`;
    const on = [...selected].some((b) => near(b, beat));
    const mine = ks.owner === owner ? ks.keys : [];
    const refs = refsAt(beat);
    // Ctrl / ⌘：加選 / 取消這一點（不拖）
    if (e.ctrlKey || e.metaKey) {
      const next = on ? mine.filter((r) => !refs.some((x) => x.ch === r.ch && x.id === r.id)) : [...mine, ...refs];
      useKeySel.setState({ owner, keys: next, sel: next.length ? { owner, ...next[next.length - 1] } : null, focus: true, channel: channel });
      return;
    }
    // 點沒選的點 = 只選它
    if (!on && refs.length) useKeySel.setState({ owner, keys: refs, sel: { owner, ...refs[0] }, focus: true, channel: channel });
    const group = on ? [...selected] : [beat];
    const start = { x: e.clientX, y: e.clientY };
    const orig = group.map((b) => ({ b,
      x: keys?.x?.length ? evalKeys(keys.x, b) : layer?.base?.x ?? item.transform?.x ?? 0,
      y: keys?.y?.length ? evalKeys(keys.y, b) : layer?.base?.y ?? item.transform?.y ?? 0 }));
    dragWin((ev) => {
      const dx = (ev.clientX - start.x) / W, dy = (ev.clientY - start.y) / H;
      const d = layer ? toLayerDelta(item, beat, dx, dy, aspect) : { x: dx, y: dy };
      const s = useStore.getState();
      const fresh = s.anims.find((a) => a.id === item.id);
      if (!fresh) return;
      const put = (k: { x?: Keyframe[]; y?: Keyframe[] }) => {
        let x = k.x ?? [], y = k.y ?? [];
        for (const o of orig) { x = upsertKey(x, o.b, o.x + d.x); y = upsertKey(y, o.b, o.y + d.y); }
        return { x, y };
      };
      if (!layer) s.updateAnim(item.id, { keys: { ...fresh.keys, ...put(fresh.keys ?? {}) } });
      else s.updateAnim(item.id, { layers: fresh.layers.map((l) => l.id === layer.id ? { ...l, keys: { ...l.keys, ...put(l.keys) } } : l) });
    });
  };
  const pts = samples.map((b) => { const p = point(b); return `${p.x},${p.y}`; }).join(' ');
  return <svg className="anim-motion-path" width={W} height={H}>
    <polyline className="amp-shade" points={pts} />
    <polyline className="amp-line" points={pts} />
    {times.map((b) => {
      const p = point(b);
      const on = [...selected].some((x) => near(x, b));
      return <rect key={b} className={`amp-key ${on ? 'sel' : ''}`} x={p.x - 4.5} y={p.y - 4.5} width={9} height={9}
        transform={`rotate(45 ${p.x} ${p.y})`} onPointerDown={(e) => drag(e, b)} />;
    })}
    <circle className="amp-now" cx={current.x} cy={current.y} r={3.5} />
  </svg>;
}
