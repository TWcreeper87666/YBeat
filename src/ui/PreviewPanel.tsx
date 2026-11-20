import { $t } from '../i18n';
import { Minimize2, Pause, PictureInPicture2, Play, Repeat, Repeat1, SkipBack, SkipForward, StepBack, StepForward } from 'lucide-react';
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { projectDuration, useStore } from '../store';
import { useEditorScope } from './EditorWindow';
import { Preview } from './Preview';
import { useLayout } from './uiStore';
import { GridButton } from './GridOverlay';
import { SourceOverlay, useSource } from './SourcePanel';

const fmt = (t: number) => {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
};

/** 預覽面板 = 畫面 + 播放控制列（與時間軸同步）；打開素材預覽時暫時蓋掉 */
export function PreviewPanel() {
  const src = useSource((s) => s.open);
  return (
    <div className={`preview-panel ${src ? 'src-on' : ''}`}>
      <Preview />
      <Transport />
      <SourceOverlay />
    </div>
  );
}

function Transport() {
  const playing = useStore((s) => s.playing);
  const time = useStore((s) => s.time);
  const loop = useStore((s) => s.loop);
  const dur = useStore((s) => projectDuration(s));
  const clips = useStore((s) => s.clips);
  const floating = useLayout((s) => s.floating);
  const repeat = useLayout((s) => s.repeat);
  const S = useStore.getState();
  const barRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  // 編輯視窗開著：播放列只看那個片段（時間從片段開頭算）；否則是整個專案
  const scope = useEditorScope();
  const t0 = scope?.a ?? 0;
  const total = Math.max(scope ? scope.b - scope.a : dur, 0.001);
  const local = Math.min(total, Math.max(0, time - t0));

  const cuts = useMemo(() => {
    const set = new Set<number>();
    for (const c of clips) {
      set.add(+(c.start - t0).toFixed(3));
      set.add(+(c.start + c.duration - t0).toFixed(3));
    }
    return [...set].filter((t) => t > 0 && t < total);
  }, [clips, total, t0]);

  /** 播放列上的位置 → 片段內 / 專案時間（回傳的是播放列上的時間，0 ~ total） */
  const tAt = (x: number) => {
    const r = barRef.current!.getBoundingClientRect();
    return Math.min(total - (scope ? 1 / 60 : 0), Math.max(0, ((x - r.left) / r.width) * total));
  };

  const scrub = (e: React.PointerEvent) => {
    e.preventDefault();
    const wasPlaying = S.playing;
    S.setPlaying(false);
    S.setTime(t0 + tAt(e.clientX));
    const mv = (ev: PointerEvent) => S.setTime(t0 + tAt(ev.clientX));
    const up = () => {
      window.removeEventListener('pointermove', mv);
      window.removeEventListener('pointerup', up);
      if (wasPlaying) S.setPlaying(true);
    };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
  };

  const step = (d: number) => () => S.setTime(scope ? Math.min(scope.b - 1 / 60, Math.max(scope.a, S.time + d)) : Math.max(0, S.time + d));

  return (
    <div className="transport">
      <div
        className="scrub"
        ref={barRef}
        onPointerDown={scrub}
        onPointerMove={(e) => setHover(tAt(e.clientX))}
        onPointerLeave={() => setHover(null)}
      >
        <div className="scrub-track">
          {loop && !scope && <div className="scrub-loop" style={{ left: `${(loop.a / total) * 100}%`, width: `${((loop.b - loop.a) / total) * 100}%` }} />}
          <div className="scrub-fill" style={{ width: `${(local / total) * 100}%` }} />
          {cuts.map((c) => <div key={c} className="scrub-cut" style={{ left: `${(c / total) * 100}%` }} />)}
        </div>
        <div className="scrub-thumb" style={{ left: `${(local / total) * 100}%` }} />
        {hover !== null && <div className="scrub-tip" style={{ left: `${(hover / total) * 100}%` }}>{fmt(hover)}</div>}
      </div>
      <div className="transport-row">
        <button className="tp skip" title={$t('回到開頭 (Home)')} onClick={() => S.setTime(t0)}><SkipBack size={15} /></button>
        <button className="tp step" title={$t('上一格 (←)')} onClick={step(-1 / 60)}><StepBack size={15} /></button>
        <button className="tp play" title={$t('播放 / 暫停 (Space)')} onClick={S.togglePlay}>{playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}</button>
        <button className="tp step" title={$t('下一格 (→)')} onClick={step(1 / 60)}><StepForward size={15} /></button>
        <button className="tp skip" title={$t('到結尾 (End)')} onClick={() => S.setTime(scope ? scope.b - 1 / 60 : dur)}><SkipForward size={15} /></button>
        <span className="tp-time">{fmt(scope ? local : time)} <span className="muted tp-total">/ {fmt(total)}</span></span>
        <span className="spacer" />
        {loop && !scope && <button className="tp on" title={$t('停止循環 (Esc)')} onClick={() => S.setLoop(null)}><Repeat1 size={15} /></button>}
        <button className={`tp ${repeat ? 'on' : ''}`} title={$t('循環播放')} onClick={() => useLayout.getState().set({ repeat: !repeat })}><Repeat size={15} /></button>
        <GridButton />
        {!scope && (
        <button
          className="tp"
          title={floating ? $t('停駐回主視窗') : $t('分離成浮動視窗')}
          onClick={() => useLayout.getState().set({ floating: !floating })}
        >
          {floating ? <Minimize2 size={15} /> : <PictureInPicture2 size={15} />}
        </button>
        )}
      </div>
    </div>
  );
}

/** 把同一個 DOM 節點搬進這個位置（停駐 / 浮動切換時預覽不會重建） */
/** 面板搬家前記下裡面各個捲動區的位置（DOM 節點一搬動，捲軸就會回到最上面） */
const scrolls = new WeakMap<HTMLElement, [Element, number, number][]>();
function saveScroll(host: HTMLElement) {
  if (!host.isConnected) return;
  const list: [Element, number, number][] = [];
  for (const el of [host, ...host.querySelectorAll('*')]) if (el.scrollTop || el.scrollLeft) list.push([el, el.scrollTop, el.scrollLeft]);
  scrolls.set(host, list);
}
function restoreScroll(host: HTMLElement) {
  const list = scrolls.get(host);
  if (!list) return;
  for (const [el, t, l] of list) {
    el.scrollTop = t;
    el.scrollLeft = l;
  }
}

export function Slot({ host }: { host: HTMLElement }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current!;
    saveScroll(host);
    el.appendChild(host);
    restoreScroll(host);
    // 新位置的大小可能下一幀才定：再補一次
    const raf = requestAnimationFrame(() => restoreScroll(host));
    return () => {
      cancelAnimationFrame(raf);
      if (host.parentElement === el) {
        saveScroll(host);
        el.removeChild(host);
      }
    };
  }, [host]);
  return <div ref={ref} className="slot" />;
}

/** 可拖曳移動、縮放的浮動視窗 */
export function FloatingWindow({ title, children }: { title: string; children: React.ReactNode }) {
  const saved = useLayout((s) => s.floatRect);
  const set = useLayout((s) => s.set);
  const [, force] = useState(0);
  useEffect(() => {
    const r = () => force((n) => n + 1);
    window.addEventListener('resize', r);
    return () => window.removeEventListener('resize', r);
  }, []);
  // 永遠保持在視窗內（視窗縮小時也一樣）
  const w = Math.min(saved.w, innerWidth - 16);
  const h = Math.min(saved.h, innerHeight - 16);
  const rect = { w, h, x: Math.min(Math.max(saved.x, 8 - w + 120), innerWidth - 120), y: Math.min(Math.max(saved.y, 8), innerHeight - h - 8) };

  const drag = (e: React.PointerEvent, mode: 'move' | 'r' | 'b' | 'rb' | 'l' | 'lb') => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX, y0 = e.clientY, r0 = { ...rect };
    const mv = (ev: PointerEvent) => {
      const dx = ev.clientX - x0, dy = ev.clientY - y0;
      const r = { ...r0 };
      if (mode === 'move') {
        r.x = Math.min(innerWidth - 80, Math.max(-r0.w + 80, r0.x + dx));
        r.y = Math.min(innerHeight - 40, Math.max(0, r0.y + dy));
      }
      // 最小寬度跟停駐的預覽一樣（播放列的按鈕放得下）
      if (mode.includes('r')) r.w = Math.max(280, r0.w + dx);
      if (mode.includes('l')) { r.w = Math.max(280, r0.w - dx); r.x = r0.x + r0.w - r.w; }
      if (mode.includes('b')) r.h = Math.max(260, r0.h + dy);
      set({ floatRect: r });
    };
    const up = () => {
      window.removeEventListener('pointermove', mv);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
  };

  return (
    <div className="float-win" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}>
      <div className="float-title" onPointerDown={(e) => drag(e, 'move')} onDoubleClick={() => set({ floating: false })}>
        <span>{title}</span>
        <button title={$t('停駐回主視窗')} onPointerDown={(e) => e.stopPropagation()} onClick={() => set({ floating: false })}><Minimize2 size={14} /></button>
      </div>
      <div className="float-body">{children}</div>
      <div className="rz r" onPointerDown={(e) => drag(e, 'r')} />
      <div className="rz l" onPointerDown={(e) => drag(e, 'l')} />
      <div className="rz b" onPointerDown={(e) => drag(e, 'b')} />
      <div className="rz rb" onPointerDown={(e) => drag(e, 'rb')} />
      <div className="rz lb" onPointerDown={(e) => drag(e, 'lb')} />
    </div>
  );
}

/** 面板之間可拖曳的分隔線 */
export function Splitter({
  dir,
  value,
  onChange,
  min,
  max,
  invert,
  onReset,
}: {
  dir: 'v' | 'h';
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: () => number;
  invert?: boolean;
  onReset?: () => void;
}) {
  const [active, setActive] = useState(false);
  return (
    <div
      className={`splitter ${dir} ${active ? 'active' : ''}`}
      onDoubleClick={onReset}
      title={$t('拖曳調整大小，雙擊重設')}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const p0 = dir === 'v' ? e.clientX : e.clientY;
        const v0 = value;
        setActive(true);
        document.body.classList.add(dir === 'v' ? 'resizing-v' : 'resizing-h');
        const mv = (ev: PointerEvent) => {
          const d = ((dir === 'v' ? ev.clientX : ev.clientY) - p0) * (invert ? -1 : 1);
          onChange(Math.round(Math.min(max(), Math.max(min, v0 + d))));
        };
        const up = () => {
          setActive(false);
          document.body.classList.remove('resizing-v', 'resizing-h');
          window.removeEventListener('pointermove', mv);
          window.removeEventListener('pointerup', up);
        };
        window.addEventListener('pointermove', mv);
        window.addEventListener('pointerup', up);
      }}
    />
  );
}
