import React, { useLayoutEffect, useRef, useState } from 'react';
import { useStore, type Clip, type FxItem } from '../store';
import {
  ANIM_PROPS, EASE_PRESETS, easeId, evalKeys, keyAt, newKey, sortKeys, upsertKey,
  type AnimProp, type Bez, type Ease, type Keyframe,
} from '../engine/keyframes';
import { clipTransformAt } from '../engine/transform';
import { parseParams, resolveParams } from '../engine/params';
import { DragNumber } from './DragNumber';
import { openMenu, useKeySel, useLayout } from './uiStore';

// ───────────────────────── 資料介面 ─────────────────────────

/** 一個可動畫的數值屬性 */
export interface Channel {
  id: string;
  label: string;
  value: number;
  keys: Keyframe[];
  def: number;
  step?: number;
  min?: number;
  max?: number;
  suffix?: string;
  display?: number;
}

/** 擁有關鍵影格的對象（片段 / 特效） */
export interface Host {
  owner: string;
  start: number;
  duration: number;
  setKeys(ch: string, list: Keyframe[] | null, base?: number): void;
  setBase(ch: string, v: number): void;
}

export function clipHost(clipId: string): Host | null {
  const c = useStore.getState().clips.find((x) => x.id === clipId);
  if (!c) return null;
  return {
    owner: `clip:${c.id}`,
    start: c.start,
    duration: c.duration,
    setKeys(ch, list, base) {
      const cur = useStore.getState().clips.find((x) => x.id === clipId);
      if (!cur) return;
      const keys = { ...cur.keys };
      if (list?.length) keys[ch as AnimProp] = sortKeys(list);
      else delete keys[ch as AnimProp];
      const patch: Partial<Clip> = { keys };
      if (!list?.length && base !== undefined) patch.transform = { ...cur.transform, [ch]: base };
      useStore.getState().updateClip(clipId, patch);
    },
    setBase(ch, v) {
      const cur = useStore.getState().clips.find((x) => x.id === clipId);
      if (cur) useStore.getState().updateClip(clipId, { transform: { ...cur.transform, [ch]: v } });
    },
  };
}

export function fxHost(fxId: string): Host | null {
  const f = useStore.getState().effects.find((x) => x.id === fxId);
  if (!f) return null;
  return {
    owner: `effect:${f.id}`,
    start: f.start,
    duration: f.duration,
    setKeys(ch, list, base) {
      const cur = useStore.getState().effects.find((x) => x.id === fxId);
      if (!cur) return;
      const keys = { ...(cur.keys ?? {}) };
      if (list?.length) keys[ch] = sortKeys(list);
      else delete keys[ch];
      const patch: Partial<FxItem> = { keys };
      if (!list?.length && base !== undefined) patch.params = { ...cur.params, [ch]: base };
      useStore.getState().updateEffect(fxId, patch);
    },
    setBase(ch, v) {
      const cur = useStore.getState().effects.find((x) => x.id === fxId);
      if (cur) useStore.getState().updateEffect(fxId, { params: { ...cur.params, [ch]: v } });
    },
  };
}

function hostFor(owner: string) {
  const [type, id] = [owner.slice(0, owner.indexOf(':')), owner.slice(owner.indexOf(':') + 1)];
  return type === 'clip' ? clipHost(id) : type === 'effect' ? fxHost(id) : null;
}

function currentKeys(owner: string, ch: string): Keyframe[] {
  const s = useStore.getState();
  const [type, id] = [owner.slice(0, owner.indexOf(':')), owner.slice(owner.indexOf(':') + 1)];
  if (type === 'clip') return s.clips.find((c) => c.id === id)?.keys[ch as AnimProp] ?? [];
  return s.effects.find((f) => f.id === id)?.keys?.[ch] ?? [];
}

/** 片段的動畫屬性 */
export function clipChannels(c: Clip, local: number): Channel[] {
  const cur = clipTransformAt(c, local);
  return ANIM_PROPS.map(({ prop, label, step, suffix, min, max }) => ({
    id: prop,
    label,
    value: cur[prop],
    keys: c.keys[prop] ?? [],
    def: prop === 'scale' || prop === 'opacity' ? 1 : 0,
    step: prop === 'scale' || prop === 'opacity' ? 0.005 : step,
    min,
    max,
    // 位置用像素顯示（畫面 1080×1920），縮放 / 不透明度用 %
    suffix: prop === 'scale' || prop === 'opacity' ? '%' : prop === 'x' || prop === 'y' ? ' px' : suffix,
    display: prop === 'scale' || prop === 'opacity' ? 100 : prop === 'x' ? 1080 : prop === 'y' ? 1920 : 1,
  }));
}

/** 特效的動畫屬性（只有數值型參數可以打 key） */
export function fxChannels(f: FxItem, code: string, local: number): Channel[] {
  const defs = parseParams(code);
  const base = resolveParams(defs, f.params);
  return defs
    .filter((d) => d.type === 'float' || d.type === 'int')
    .map((d) => {
      const keys = f.keys?.[d.name] ?? [];
      return {
        id: d.name,
        label: d.label,
        value: keys.length ? evalKeys(keys, local) : Number(base[d.name]),
        keys,
        def: Number(d.def),
        step: d.type === 'int' ? 1 : niceStep((d.max - d.min) / 200),
        min: undefined,
        max: undefined,
      };
    });
}

function niceStep(x: number) {
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(x, 1e-6))));
  const n = x / p;
  return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * p;
}

/** Delete 鍵：刪除選取的關鍵影格 */
export function deleteSelectedKey(): boolean {
  const sel = useKeySel.getState().sel;
  if (!sel) return false;
  const host = hostFor(sel.owner);
  const list = currentKeys(sel.owner, sel.ch);
  const k = list.find((x) => x.id === sel.id);
  if (!host || !k) return false;
  const rest = list.filter((x) => x !== k);
  host.setKeys(sel.ch, rest, rest.length ? undefined : k.v);
  useKeySel.setState({ sel: null });
  return true;
}

/** 緩動作用的區段：選取的 key → 下一個；如果是最後一個，就用前一段 */
function targetSegment(keys: Keyframe[], selId: string | undefined, lc: number): number {
  if (keys.length < 2) return -1;
  const i = selId ? keys.findIndex((k) => k.id === selId) : -1;
  if (i >= 0) return i < keys.length - 1 ? i : i - 1;
  for (let j = 0; j < keys.length - 1; j++) if (lc >= keys[j].t && lc < keys[j + 1].t) return j;
  return lc < keys[0].t ? 0 : keys.length - 2;
}

function setSegmentEase(host: Host, ch: string, seg: number, ease: Ease) {
  const list = currentKeys(host.owner, ch);
  if (seg < 0 || seg >= list.length - 1) return;
  host.setKeys(ch, list.map((k, i) => (i === seg ? { ...k, ease } : k)));
}

function listen(onMove: (ev: PointerEvent) => void, onUp?: () => void) {
  const up = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', up);
    onUp?.();
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', up);
}

// ───────────────────────── 效果控制面板 ─────────────────────────

export interface Section {
  id: string;
  title: string;
  channels?: Channel[];
  /** 不可動畫的列（下拉、開關、顏色…） */
  rows?: { label: string; node: React.ReactNode }[];
  /** 放在區塊最下面（例如程式碼） */
  footer?: React.ReactNode;
  onReset?: () => void;
}

export function EffectControls({ host, sections, title }: { host: Host; sections: Section[]; title?: React.ReactNode }) {
  const time = useStore((s) => s.time);
  const split = useLayout((s) => s.ecSplit);
  const collapsed = useLayout((s) => s.ecCollapsed);
  const sel = useKeySel((s) => s.sel);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const rulerRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  const S = useStore.getState();
  const dur = host.duration;
  const local = time - host.start;
  const inside = local >= -1e-6 && local <= dur + 1e-6;
  const lc = Math.min(dur, Math.max(0, local));
  const mySel = sel && sel.owner === host.owner ? sel : null;

  const seek = (l: number) => S.setTime(host.start + Math.min(dur, Math.max(0, l)));
  const localAt = (clientX: number) => {
    const r = rulerRef.current!.getBoundingClientRect();
    return Math.min(dur, Math.max(0, ((clientX - r.left) / r.width) * dur));
  };
  const scrub = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    useKeySel.setState({ sel: null });
    seek(localAt(e.clientX));
    listen((ev) => seek(localAt(ev.clientX)));
  };

  const setValue = (ch: Channel, v: number) => {
    if (ch.keys.length) host.setKeys(ch.id, upsertKey(currentKeys(host.owner, ch.id), lc, v));
    else host.setBase(ch.id, v);
  };
  const toggleAnim = (ch: Channel) => {
    if (ch.keys.length) host.setKeys(ch.id, null, ch.value);
    else {
      host.setKeys(ch.id, [newKey(lc, ch.value)]);
      if (!inside) seek(lc);
    }
  };
  const toggleKeyHere = (ch: Channel) => {
    const list = currentKeys(host.owner, ch.id);
    const hit = keyAt(list, lc);
    if (hit) {
      const rest = list.filter((k) => k !== hit);
      host.setKeys(ch.id, rest, rest.length ? undefined : hit.v);
    } else host.setKeys(ch.id, upsertKey(list, lc, ch.value));
    if (!inside) seek(lc);
  };
  const jump = (ch: Channel, dir: -1 | 1) => {
    const k = dir < 0 ? [...ch.keys].reverse().find((x) => x.t < lc - 1e-3) : ch.keys.find((x) => x.t > lc + 1e-3);
    if (k) seek(k.t);
  };

  const dragKey = (e: React.PointerEvent, ch: Channel, k: Keyframe) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    useKeySel.setState({ sel: { owner: host.owner, ch: ch.id, id: k.id } });
    const r = rulerRef.current!.getBoundingClientRect();
    let moved = false;
    listen(
      (ev) => {
        moved = true;
        let t = localAt(ev.clientX);
        if (Math.abs(t - lc) * (r.width / dur) < 6) t = lc;
        host.setKeys(ch.id, currentKeys(host.owner, ch.id).map((x) => (x.id === k.id ? { ...x, t } : x)));
      },
      () => void moved,
    );
  };

  const keyMenu = (e: React.MouseEvent, ch: Channel, k: Keyframe) => {
    e.preventDefault();
    e.stopPropagation();
    useKeySel.setState({ sel: { owner: host.owner, ch: ch.id, id: k.id } });
    const list = currentKeys(host.owner, ch.id);
    const seg = targetSegment(list, k.id, lc);
    const cur = seg >= 0 ? easeId(list[seg].ease) : '';
    const isLast = list.indexOf(list.find((x) => x.id === k.id)!) === list.length - 1;
    openMenu(e.clientX, e.clientY, [
      ...(seg >= 0
        ? [{ label: isLast ? '（套用到前一段）' : '（套用到下一段）', action: undefined }, ...EASE_PRESETS.map((p) => ({ label: p.label, checked: cur === p.id, action: () => setSegmentEase(host, ch.id, seg, p.ease) }))]
        : [{ label: '需要兩個以上的關鍵影格才能設定緩動', action: undefined }]),
      { separator: true },
      { label: '播放頭移到這裡', action: () => seek(k.t) },
      { label: '刪除關鍵影格', shortcut: 'Del', danger: true, action: deleteSelectedKey },
    ]);
  };

  const dragSplit = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const r = tableRef.current!.getBoundingClientRect();
    listen((ev) => useLayout.getState().set({ ecSplit: Math.min(0.75, Math.max(0.35, (ev.clientX - r.left) / r.width)) }));
  };

  const toggleSection = (id: string) => useLayout.getState().set({ ecCollapsed: { ...collapsed, [id]: !collapsed[id] } });
  const ticks = niceTicks(dur);
  const pct = (t: number) => `${(t / dur) * 100}%`;

  return (
    <div className="ec" ref={tableRef} style={{ '--ec-left': `${split * 100}%` } as React.CSSProperties}>
      {/* 表頭：名稱 + 片段內時間尺規 */}
      <div className="ec-row ec-header">
        <div className="ec-left">
          {title}
          <span className="ec-time">{inside ? `${lc.toFixed(2)}s` : '—'}</span>
          <div className="ec-split" onPointerDown={dragSplit} title="拖曳調整左右寬度" />
        </div>
        <div className="ec-right ec-ruler" ref={rulerRef} onPointerDown={scrub}>
          {ticks.map((t) => <span key={t} className="ec-tick" style={{ left: pct(t) }}>{fmtT(t, dur)}</span>)}
        </div>
      </div>

      {sections.map((sec) => {
        const isCol = collapsed[sec.id];
        return (
          <React.Fragment key={sec.id}>
            <div className="ec-row ec-section">
              <div className="ec-left" onClick={() => toggleSection(sec.id)}>
                <span className="twirl">{isCol ? '▸' : '▾'}</span>
                <span className="ec-sec-title">{sec.title}</span>
                {sec.onReset && <button className="ec-icon" title="重設這個區塊" onClick={(e) => { e.stopPropagation(); sec.onReset!(); }}>↺</button>}
              </div>
              <div className="ec-right" onPointerDown={scrub} />
            </div>
            {!isCol && (
              <>
                {sec.rows?.map((r) => (
                  <div key={r.label} className="ec-row">
                    <div className="ec-left ec-plain"><span className="ec-label">{r.label}</span><div className="ec-node">{r.node}</div></div>
                    <div className="ec-right ec-dim" onPointerDown={scrub} />
                  </div>
                ))}
                {sec.channels?.map((ch) => {
                  const animated = ch.keys.length > 0;
                  const here = keyAt(ch.keys, lc);
                  const rowKey = `${sec.id}.${ch.id}`;
                  const isOpen = open[rowKey];
                  return (
                    <React.Fragment key={ch.id}>
                      <div className={`ec-row ${animated ? 'anim' : ''}`}>
                        <div className="ec-left">
                          <span className="twirl small" onClick={() => setOpen({ ...open, [rowKey]: !isOpen })} title="展開曲線">{isOpen ? '▾' : '▸'}</span>
                          <button className={`ec-watch ${animated ? 'on' : ''}`} title={animated ? '關閉動畫（移除所有關鍵影格）' : '開啟動畫（在播放頭加關鍵影格）'} onClick={() => toggleAnim(ch)}>⏱</button>
                          <span className="ec-label" title={ch.label}>{ch.label}</span>
                          <DragNumber variant="text" value={ch.value} step={ch.step} min={ch.min} max={ch.max} suffix={ch.suffix} display={ch.display} def={ch.def} onChange={(v) => setValue(ch, v)} />
                          <span className="ec-nav">
                            {animated && (
                              <>
                                <button onClick={() => jump(ch, -1)} title="上一個關鍵影格">◂</button>
                                <button className={here ? 'on' : ''} onClick={() => toggleKeyHere(ch)} title={here ? '移除關鍵影格' : '加入關鍵影格'}>{here ? '◆' : '◇'}</button>
                                <button onClick={() => jump(ch, 1)} title="下一個關鍵影格">▸</button>
                              </>
                            )}
                          </span>
                          <button className="ec-icon" title="重設" onClick={() => setValue(ch, ch.def)}>↺</button>
                        </div>
                        <div className="ec-right ec-lane" onPointerDown={scrub}>
                          {ch.keys.length > 1 && <div className="ec-span" style={{ left: pct(ch.keys[0].t), width: pct(ch.keys[ch.keys.length - 1].t - ch.keys[0].t) }} />}
                          {ch.keys.map((k) => (
                            <div
                              key={k.id}
                              className={`ec-key ${mySel?.id === k.id ? 'sel' : ''} ${k.ease === 'hold' ? 'hold' : ''}`}
                              style={{ left: pct(k.t) }}
                              title={`${k.t.toFixed(2)}s（拖曳移動、右鍵緩動）`}
                              onPointerDown={(e) => dragKey(e, ch, k)}
                              onDoubleClick={() => seek(k.t)}
                              onContextMenu={(e) => keyMenu(e, ch, k)}
                            />
                          ))}
                        </div>
                      </div>
                      {isOpen && <GraphRow host={host} ch={ch} lc={lc} selId={mySel?.ch === ch.id ? mySel.id : undefined} />}
                    </React.Fragment>
                  );
                })}
                {sec.footer && <div className="ec-footer">{sec.footer}</div>}
              </>
            )}
          </React.Fragment>
        );
      })}

      {/* 播放頭（蓋住右側所有列） */}
      {inside && <div className="ec-playhead" style={{ left: `calc(var(--ec-left) + (100% - var(--ec-left)) * ${lc / dur})` }} />}
    </div>
  );
}

function fmtT(t: number, dur: number) {
  return dur < 10 ? `${t.toFixed(t % 1 ? 1 : 0)}s` : `${Math.round(t)}s`;
}

function niceTicks(dur: number) {
  const raw = dur / 4;
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-6))));
  const step = [1, 2, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let t = 0; t <= dur + 1e-6; t += step) out.push(+t.toFixed(4));
  return out;
}

// ───────────────────────── 曲線列（展開在屬性下方） ─────────────────────────

const GH = 120;
const PAD = 10;

function GraphRow({ host, ch, lc, selId }: { host: Host; ch: Channel; lc: number; selId?: string }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(200);
  const frozen = useRef<{ min: number; max: number } | null>(null);
  const keys = ch.keys;
  const dur = host.duration;
  const mul = ch.display ?? 1;

  useLayoutEffect(() => {
    const el = wrapRef.current!;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  let range = frozen.current;
  if (!range) {
    const vals = keys.length ? keys.map((k) => k.v) : [ch.value];
    if (keys.length > 1) for (let i = 0; i <= 60; i++) vals.push(evalKeys(keys, (i / 60) * dur));
    let mn = Math.min(...vals), mx = Math.max(...vals);
    if (mx - mn < 1e-6) {
      const p = Math.max(Math.abs(mx) * 0.5, ch.step ? ch.step * 20 : 0.25);
      mn -= p;
      mx += p;
    }
    const p = (mx - mn) * 0.15;
    range = { min: mn - p, max: mx + p };
  }
  const { min, max } = range;
  const X = (t: number) => (t / dur) * W;
  const Y = (v: number) => PAD + (1 - (v - min) / (max - min)) * (GH - PAD * 2);
  const T = (x: number) => Math.min(dur, Math.max(0, (x / W) * dur));
  const V = (y: number) => min + (1 - (y - PAD) / (GH - PAD * 2)) * (max - min);

  const seg = targetSegment(keys, selId, lc);
  const a = seg >= 0 ? keys[seg] : undefined;
  const b = seg >= 0 ? keys[seg + 1] : undefined;
  const dv = a && b ? b.v - a.v : 0;
  const dt = a && b ? b.t - a.t : 0;
  const ez = a && a.ease !== 'hold' && Math.abs(dv) > 1e-9 ? (a.ease as Bez) : null;

  // 曲線每次重算（改緩動會立刻反映）
  const pts: string[] = [];
  if (keys.length) for (let i = 0; i <= 200; i++) { const t = (i / 200) * dur; pts.push(`${X(t).toFixed(1)},${Y(evalKeys(keys, t)).toFixed(1)}`); }
  else pts.push(`0,${Y(ch.value)}`, `${W},${Y(ch.value)}`);
  // 目前作用中的區段另外加亮
  const segPts: string[] = [];
  if (a && b) for (let i = 0; i <= 60; i++) { const t = a.t + (i / 60) * dt; segPts.push(`${X(t).toFixed(1)},${Y(evalKeys(keys, t)).toFixed(1)}`); }

  const pt = (e: { clientX: number; clientY: number }) => {
    const r = wrapRef.current!.querySelector('svg')!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const dragPoint = (e: React.PointerEvent, k: Keyframe) => {
    e.preventDefault();
    e.stopPropagation();
    useKeySel.setState({ sel: { owner: host.owner, ch: ch.id, id: k.id } });
    frozen.current = range;
    const p0 = pt(e);
    listen(
      (ev) => {
        const p = pt(ev);
        const t = ev.shiftKey ? k.t : T(X(k.t) + p.x - p0.x);
        const v = V(Y(k.v) + p.y - p0.y);
        host.setKeys(ch.id, currentKeys(host.owner, ch.id).map((x) => (x.id === k.id ? { ...x, t, v } : x)));
      },
      () => (frozen.current = null),
    );
  };

  const dragHandle = (e: React.PointerEvent, which: 0 | 1) => {
    e.preventDefault();
    e.stopPropagation();
    if (!a || !b) return;
    frozen.current = range;
    listen(
      (ev) => {
        const p = pt(ev);
        const ex = Math.min(1, Math.max(0, (T(p.x) - a.t) / dt));
        const ey = (V(p.y) - a.v) / dv;
        const list = currentKeys(host.owner, ch.id);
        const cur = list.find((x) => x.id === a.id);
        if (!cur || cur.ease === 'hold') return;
        const bz = [...cur.ease] as Bez;
        if (which === 0) { bz[0] = ex; bz[1] = ey; } else { bz[2] = ex; bz[3] = ey; }
        host.setKeys(ch.id, list.map((x) => (x.id === a.id ? { ...x, ease: bz.map((n) => Math.round(n * 1000) / 1000) as Bez } : x)));
      },
      () => (frozen.current = null),
    );
  };

  /** 點曲線：選取那一段；雙擊：在那裡加關鍵影格 */
  const onDown = (e: React.PointerEvent) => {
    const t = T(pt(e).x);
    if (keys.length < 2) return useKeySel.setState({ sel: null });
    let i = keys.findIndex((k, j) => j < keys.length - 1 && t >= k.t && t < keys[j + 1].t);
    if (i < 0) i = t < keys[0].t ? 0 : keys.length - 2;
    useKeySel.setState({ sel: { owner: host.owner, ch: ch.id, id: keys[i].id } });
  };
  const onDbl = (e: React.MouseEvent) => {
    const t = T(pt(e).x);
    const v = keys.length ? evalKeys(keys, t) : ch.value;
    host.setKeys(ch.id, upsertKey(currentKeys(host.owner, ch.id), t, v));
  };

  const curEase = a ? easeId(a.ease) : '';

  return (
    <div className="ec-row ec-graph-row">
      <div className="ec-left ec-graph-side">
        {a && b ? (
          <>
            <div className="muted small">區段 {a.t.toFixed(2)}s → {b.t.toFixed(2)}s</div>
            <select className="select wide" value={curEase} onChange={(e) => { const p = EASE_PRESETS.find((x) => x.id === e.target.value); if (p) setSegmentEase(host, ch.id, seg, p.ease); }}>
              {curEase === 'custom' && <option value="custom">自訂曲線</option>}
              {EASE_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
            <EasePresetsMini current={curEase} onPick={(e) => setSegmentEase(host, ch.id, seg, e)} />
          </>
        ) : (
          <div className="muted small">{keys.length ? '再加一個關鍵影格就能調緩動' : '按 ⏱ 開啟動畫，或雙擊曲線加關鍵影格'}</div>
        )}
        <div className="ec-range muted small">{(max * mul).toFixed(1)} / {(min * mul).toFixed(1)}</div>
      </div>
      <div className="ec-right ec-graph" ref={wrapRef}>
        <svg width={W} height={GH} onPointerDown={onDown} onDoubleClick={onDbl}>
          {[0.25, 0.5, 0.75].map((f) => <line key={f} className="cg-grid" x1={0} x2={W} y1={PAD + f * (GH - PAD * 2)} y2={PAD + f * (GH - PAD * 2)} />)}
          <polyline className={`cg-curve ${keys.length ? '' : 'flat'}`} points={pts.join(' ')} />
          {segPts.length > 0 && <polyline className="cg-seg" points={segPts.join(' ')} />}
          <line className="cg-playhead" x1={X(lc)} x2={X(lc)} y1={0} y2={GH} />
          {ez && a && (
            <g className="cg-handles">
              <line x1={X(a.t)} y1={Y(a.v)} x2={X(a.t + ez[0] * dt)} y2={Y(a.v + ez[1] * dv)} />
              <line x1={X(b!.t)} y1={Y(b!.v)} x2={X(a.t + ez[2] * dt)} y2={Y(a.v + ez[3] * dv)} />
              <circle r={5} cx={X(a.t + ez[0] * dt)} cy={Y(a.v + ez[1] * dv)} onPointerDown={(e) => dragHandle(e, 0)} />
              <circle r={5} cx={X(a.t + ez[2] * dt)} cy={Y(a.v + ez[3] * dv)} onPointerDown={(e) => dragHandle(e, 1)} />
            </g>
          )}
          {keys.map((k) => (
            <rect
              key={k.id}
              className={`cg-key ${selId === k.id ? 'sel' : ''}`}
              x={X(k.t) - 5}
              y={Y(k.v) - 5}
              width={10}
              height={10}
              transform={`rotate(45 ${X(k.t)} ${Y(k.v)})`}
              onPointerDown={(e) => dragPoint(e, k)}
            />
          ))}
        </svg>
      </div>
    </div>
  );
}

/** 小型緩動預設按鈕（直接看形狀選） */
function EasePresetsMini({ current, onPick }: { current: string; onPick: (e: Ease) => void }) {
  return (
    <div className="ease-mini">
      {EASE_PRESETS.map((p) => {
        const d: string[] = [];
        for (let i = 0; i <= 16; i++) {
          const x = i / 16;
          const y = p.ease === 'hold' ? (x < 1 ? 0 : 1) : evalKeys([{ id: 'a', t: 0, v: 0, ease: p.ease }, { id: 'b', t: 1, v: 1, ease: p.ease }], x);
          d.push(`${2 + x * 20},${20 - y * 16}`);
        }
        return (
          <button key={p.id} className={current === p.id ? 'on' : ''} title={p.label} onClick={() => onPick(p.ease)}>
            <svg width={24} height={24}><polyline points={d.join(' ')} /></svg>
          </button>
        );
      })}
    </div>
  );
}
