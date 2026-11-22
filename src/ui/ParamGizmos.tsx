import React from 'react';
import { useStore, parseTrSel, type Clip } from '../store';
import { $t, displayName } from '../i18n';
import { paramAt, parseParams, pointCh, resolveParams, type ParamDef, type ParamValues } from '../engine/params';
import { upsertKey, type Keyframe } from '../engine/keyframes';
import { gridSnapLines, snapMoveAxis } from '../engine/snap';
import { sortClips, transitionWindow } from '../engine/renderer';
import { cfxCh, clipHost, fxHost, type Host } from './EffectControls';
import { useLayout } from './uiStore';

/**
 * 預覽畫面上的參數把手（特效、片段特效、轉場共用）：
 * - point 參數：十字把手，拖曳移動（Shift 吸附）
 * - float 參數加了 @box(點)：以該點為中心、縮放後的畫面框，拖角落改大小
 */

import { faceInFrame, followOf, withOffset, type Follow, type FollowMap } from '../engine/follow';
import { faceClipUnder, makeCtx } from '../engine/renderer';
import { fxLevel } from '../engine/tracks';
import { FollowIcon } from './followUi';
import { useFaces } from '../engine/face';

const SNAP_PX = 8;

interface Target {
  key: string;
  label: string;
  defs: ParamDef[];
  /** 這一格的值（已套用關鍵影格） */
  values: ParamValues;
  /** 寫入一個參數（point 傳 [x, y]） */
  set(name: string, v: number | number[]): void;
  /** 跟隨臉部的 point 參數：這一格臉的位置（沒偵測到 = 不在裡面）與設定；拖曳時改偏移 */
  follow?: Record<string, { face: [number, number]; f: Follow }>;
  setFollow?(name: string, f: Follow): void;
}

/** 跟隨臉部：每個跟隨中的 point 參數，這一格臉在畫面上的位置 */
function followInfo(defs: ParamDef[], map: FollowMap | undefined, src: (f: Follow) => { clip: Clip; local: number } | null | undefined) {
  const s = useStore.getState();
  const media = new Map(s.media.map((m) => [m.id, m]));
  const modules = new Map(s.modules.map((m) => [m.id, m]));
  const out: Record<string, { face: [number, number]; f: Follow }> = {};
  for (const d of defs) {
    const f = followOf(d, map);
    const c = f && src(f);
    const face = c && faceInFrame(c.clip, media.get(c.clip.mediaId), c.local, modules, s.format.w / s.format.h);
    if (f && face) out[d.name] = { face, f };
  }
  return out;
}

/** 特效（特效軌 / 片段特效）：有關鍵影格的在目前時間打 key，沒有就改固定值 */
function fxWriter(host: Host, ch: (c: string) => string, keysOf: () => Record<string, Keyframe[]> | undefined, local: number) {
  const one = (c: string, v: number) => {
    const k = keysOf()?.[c];
    if (k?.length) host.setKeys(ch(c), upsertKey(k, local, v));
    else host.setBase(ch(c), v);
  };
  return (name: string, v: number | number[]) => {
    if (Array.isArray(v)) v.forEach((x, a) => one(pointCh(name, a as 0 | 1), x));
    else one(name, v);
  };
}

const hasGizmo = (defs: ParamDef[]) => defs.some((d) => d.type === 'point');

function useTargets(): Target[] {
  useFaces((f) => f.ver); // 臉部偵測有新結果：把手位置要更新
  const sel = useStore((s) => s.selection);
  const time = useStore((s) => s.time);
  const effects = useStore((s) => s.effects);
  const clips = useStore((s) => s.clips);
  const modules = useStore((s) => s.modules);
  const out: Target[] = [];
  const mod = (id: string) => modules.find((m) => m.id === id);
  const at = (defs: ParamDef[], params: ParamValues, keys: Record<string, Keyframe[]> | undefined, local: number) => {
    const base = resolveParams(defs, params);
    const o: ParamValues = {};
    for (const d of defs) o[d.name] = paramAt(d, base, keys, local);
    return o;
  };
  if (sel?.type === 'effect') {
    const fx = effects.find((f) => f.id === sel.id);
    const m = fx && mod(fx.moduleId);
    const local = fx ? time - fx.start : 0;
    if (fx && m && local >= 0 && local < fx.duration) {
      const defs = parseParams(m.code);
      const host = fxHost(fx.id);
      if (host && hasGizmo(defs))
        out.push({
          key: `fx:${fx.id}`,
          label: displayName(m.name),
          defs,
          values: at(defs, fx.params, fx.keys, local),
          set: fxWriter(host, (c) => c, () => useStore.getState().effects.find((f) => f.id === fx.id)?.keys, local),
          follow: followInfo(defs, fx.follow, () => faceClipUnder(makeCtx(useStore.getState()), fxLevel(useStore.getState().tracks, fx.track), time, fx.faceFrom)),
          setFollow: (name, f) => {
            const cur = useStore.getState().effects.find((x) => x.id === fx.id);
            if (cur) useStore.getState().updateEffect(fx.id, { follow: { ...(cur.follow ?? {}), [name]: f } });
          },
        });
    }
  }
  if (sel?.type === 'clip') {
    const c = clips.find((x) => x.id === sel.id);
    const local = c ? time - c.start : 0;
    if (c && local >= 0 && local < c.duration) {
      const host = clipHost(c.id);
      for (const f of c.effects ?? []) {
        const m = mod(f.moduleId);
        if (!m || !host || f.enabled === false) continue;
        const defs = parseParams(m.code);
        if (!hasGizmo(defs)) continue;
        const keysOf = () => useStore.getState().clips.find((x) => x.id === c.id)?.effects?.find((x) => x.id === f.id)?.keys;
        out.push({
          key: `cfx:${f.id}`,
          label: displayName(m.name),
          defs,
          values: at(defs, f.params, f.keys, local),
          set: fxWriter(host, (ch) => cfxCh(f.id, ch), keysOf, local),
          follow: followInfo(defs, f.follow, () => ({ clip: c, local })),
          setFollow: (name, fo) => {
            const cur = useStore.getState().clips.find((x) => x.id === c.id)?.effects?.find((x) => x.id === f.id);
            if (cur) useStore.getState().updateClipFx(c.id, f.id, { follow: { ...(cur.follow ?? {}), [name]: fo } });
          },
        });
      }
    }
  }
  if (sel?.type === 'transition') {
    const { clipId, side } = parseTrSel(sel.id);
    const c = clips.find((x) => x.id === clipId);
    const tr = side === 'out' ? c?.transitionOut : c?.transitionIn;
    const m = tr && mod(tr.moduleId);
    if (c && tr && m && trVisible(clips, c, side, time)) {
      const defs = parseParams(m.code);
      if (hasGizmo(defs))
        out.push({
          key: `tr:${sel.id}`,
          label: displayName(m.name),
          defs,
          values: resolveParams(defs, tr.params),
          set: (name, v) => {
            const cur = useStore.getState().clips.find((x) => x.id === clipId);
            const t = side === 'out' ? cur?.transitionOut : cur?.transitionIn;
            if (t) useStore.getState().updateTransition(clipId, { params: { ...t.params, [name]: v } }, side);
          },
          // 轉入：前一段 = 同軌前一個片段、後一段 = 這個片段；轉出：前一段 = 這個片段（後面沒有片段）
          follow: followInfo(defs, tr.follow, (f) => {
            const sorted = sortClips(clips.filter((x) => x.track === c.track));
            const i = sorted.findIndex((x) => x.id === c.id);
            const from = side === 'out' ? c : sorted[i - 1] ?? c;
            const pick = f.side === 'to' ? c : from;
            return { clip: pick, local: time - pick.start };
          }),
          setFollow: (name, f) => {
            const cur = useStore.getState().clips.find((x) => x.id === clipId);
            const t = side === 'out' ? cur?.transitionOut : cur?.transitionIn;
            if (t) useStore.getState().updateTransition(clipId, { follow: { ...(t.follow ?? {}), [name]: f } }, side);
          },
        });
    }
  }
  return out;
}

/** 播放頭在轉場範圍內才顯示（畫面上看得到效果時才好對位置） */
function trVisible(clips: Clip[], c: Clip, side: 'in' | 'out', time: number) {
  const sorted = sortClips(clips.filter((x) => x.track === c.track));
  const i = sorted.findIndex((x) => x.id === c.id);
  const w = transitionWindow(sorted[i - 1], c, side, sorted[i + 1]);
  return !!w && time >= w.t0 && time < w.t0 + w.d;
}

type Guides = { x: number | null; y: number | null };

function drag(e: React.PointerEvent, move: (p: { x: number; y: number }, ev: PointerEvent) => void, done: () => void) {
  if (e.button !== 0) return;
  e.stopPropagation();
  e.preventDefault();
  const layer = (e.currentTarget as HTMLElement).closest('.gizmo-layer')!.getBoundingClientRect();
  document.body.classList.add('mask-dragging');
  const mv = (ev: PointerEvent) => move({ x: ev.clientX - layer.left, y: ev.clientY - layer.top }, ev);
  const up = () => {
    done();
    document.body.classList.remove('mask-dragging');
    window.removeEventListener('pointermove', mv);
    window.removeEventListener('pointerup', up);
  };
  window.addEventListener('pointermove', mv);
  window.addEventListener('pointerup', up);
}

const CORNERS = [
  { k: 'nw', cx: 0, cy: 0 }, { k: 'ne', cx: 1, cy: 0 }, { k: 'se', cx: 1, cy: 1 }, { k: 'sw', cx: 0, cy: 1 },
] as const;

function TargetGizmos({ t, W, H, setGuides }: { t: Target; W: number; H: number; setGuides: (g: Guides) => void }) {
  return (
    <>
      {t.defs.map((d) => {
        if (d.type === 'float' && d.box) {
          const pd = t.defs.find((x) => x.name === d.box && x.type === 'point');
          if (!pd) return null;
          const [px, py] = t.values[pd.name] as number[];
          const s = Number(t.values[d.name]);
          // 以 point 為固定點縮放整個畫面後的範圍
          const L = px * (1 - s) * W, T = py * (1 - s) * H;
          const onCorner = (e: React.PointerEvent, cx: number, cy: number) =>
            drag(e, (p) => {
              const dx = (cx - px) * W, dy = (cy - py) * H;
              const len = dx * dx + dy * dy;
              if (len < 1) return;
              const k = ((p.x - px * W) * dx + (p.y - py * H) * dy) / len;
              t.set(d.name, Math.round(Math.min(d.max, Math.max(d.min, k)) * 1000) / 1000);
            }, () => {});
          return (
            <div key={d.name} className="mask-gizmo param-box" style={{ left: L, top: T, width: Math.max(2, s * W), height: Math.max(2, s * H) }}>
              <span className="mask-tag">{t.label} · {$t(d.label)}</span>
              {CORNERS.map((c) => <div key={c.k} className={`mask-h ${c.k}`} onPointerDown={(e) => onCorner(e, c.cx, c.cy)} />)}
            </div>
          );
        }
        if (d.type === 'point') {
          // 跟隨臉部：把手在「臉 + 偏移」，拖曳改偏移
          const fol = t.follow?.[d.name];
          const [x, y] = fol ? withOffset(fol.face, fol.f) : (t.values[d.name] as number[]);
          const onDown = (e: React.PointerEvent) =>
            drag(e, (p, ev) => {
              let nx = p.x, ny = p.y;
              let g: Guides = { x: null, y: null };
              if (ev.shiftKey) {
                const lines = gridSnapLines(W, H, useLayout.getState());
                const sx = snapMoveAxis(nx, 0, lines.x, SNAP_PX), sy = snapMoveAxis(ny, 0, lines.y, SNAP_PX);
                nx = sx.center;
                ny = sy.center;
                g = { x: sx.line, y: sy.line };
              }
              setGuides(g);
              const pt = [Math.round((nx / W) * 10000) / 10000, Math.round((ny / H) * 10000) / 10000];
              if (fol && t.setFollow) {
                const r4 = (v: number) => Math.round(v * 10000) / 10000;
                const off: [number, number] = [r4(pt[0] - fol.face[0]), r4(pt[1] - fol.face[1])];
                t.setFollow(d.name, { ...fol.f, offset: off[0] || off[1] ? off : undefined });
              } else t.set(d.name, pt);
            }, () => setGuides({ x: null, y: null }));
          return (
            <div key={d.name} className={`param-pt ${fol ? 'follow' : ''}`} style={{ left: x * W, top: y * H }} onPointerDown={onDown} title={`${t.label} · ${$t(d.label)}`}>
              <span className="mask-tag">{$t(d.label)}{fol && <FollowIcon />}</span>
            </div>
          );
        }
        return null;
      })}
    </>
  );
}

/** 預覽畫面上的參數把手 */
export function ParamGizmos({ W, H }: { W: number; H: number }) {
  const targets = useTargets();
  const [guides, setGuides] = React.useState<Guides>({ x: null, y: null });
  if (!W || !targets.length) return null;
  return (
    <>
      {targets.map((t) => <TargetGizmos key={t.key} t={t} W={W} H={H} setGuides={setGuides} />)}
      {(guides.x !== null || guides.y !== null) && (
        <svg className="snap-guides" width={W} height={H}>
          {guides.x !== null && <line x1={guides.x} y1={0} x2={guides.x} y2={H} />}
          {guides.y !== null && <line x1={0} y1={guides.y} x2={W} y2={guides.y} />}
        </svg>
      )}
    </>
  );
}
