import { $t } from '../i18n';
import { Minimize2, Pause, PictureInPicture2, Play, Repeat, SkipBack, SkipForward, StepBack, StepForward } from 'lucide-react';
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { projectDuration, useStore } from '../store';
import { Preview } from './Preview';
import { useLayout } from './uiStore';
import { DragNumber } from './DragNumber';

const fmt = (t: number) => {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
};

/** 預覽面板 = 畫面 + 播放控制列（與時間軸同步） */
export function PreviewPanel() {
  return (
    <div className="preview-panel">
      <Preview />
      <Transport />
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
  const grid = useLayout((s) => s.grid);
  const S = useStore.getState();
  const barRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [gridPop, setGridPop] = useState<{ x: number; y: number } | null>(null);
  const total = Math.max(dur, 0.001);

  const cuts = useMemo(() => {
    const set = new Set<number>();
    for (const c of clips) {
      set.add(+c.start.toFixed(3));
      set.add(+(c.start + c.duration).toFixed(3));
    }
    return [...set].filter((t) => t > 0 && t < total);
  }, [clips, total]);

  const tAt = (x: number) => {
    const r = barRef.current!.getBoundingClientRect();
    return Math.min(total, Math.max(0, ((x - r.left) / r.width) * total));
  };

  const scrub = (e: React.PointerEvent) => {
    e.preventDefault();
    const wasPlaying = S.playing;
    S.setPlaying(false);
    S.setTime(tAt(e.clientX));
    const mv = (ev: PointerEvent) => S.setTime(tAt(ev.clientX));
    const up = () => {
      window.removeEventListener('pointermove', mv);
      window.removeEventListener('pointerup', up);
      if (wasPlaying) S.setPlaying(true);
    };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
  };

  const step = (d: number) => () => S.setTime(Math.max(0, S.time + d));

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
          {loop && <div className="scrub-loop" style={{ left: `${(loop.a / total) * 100}%`, width: `${((loop.b - loop.a) / total) * 100}%` }} />}
          <div className="scrub-fill" style={{ width: `${(Math.min(time, total) / total) * 100}%` }} />
          {cuts.map((c) => <div key={c} className="scrub-cut" style={{ left: `${(c / total) * 100}%` }} />)}
        </div>
        <div className="scrub-thumb" style={{ left: `${(Math.min(time, total) / total) * 100}%` }} />
        {hover !== null && <div className="scrub-tip" style={{ left: `${(hover / total) * 100}%` }}>{fmt(hover)}</div>}
      </div>
      <div className="transport-row">
        <button className="tp" title={$t('回到開頭 (Home)')} onClick={() => S.setTime(0)}><SkipBack size={15} /></button>
        <button className="tp" title={$t('上一格 (←)')} onClick={step(-1 / 60)}><StepBack size={15} /></button>
        <button className="tp play" title={$t('播放 / 暫停 (Space)')} onClick={S.togglePlay}>{playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}</button>
        <button className="tp" title={$t('下一格 (→)')} onClick={step(1 / 60)}><StepForward size={15} /></button>
        <button className="tp" title={$t('到結尾 (End)')} onClick={() => S.setTime(dur)}><SkipForward size={15} /></button>
        <span className="tp-time">{fmt(time)} <span className="muted">/ {fmt(dur)}</span></span>
        <span className="spacer" />
        {loop && <button className="tp on" title={$t('停止循環 (Esc)')} onClick={() => S.setLoop(null)}><Repeat size={15} /></button>}
        <button
          className={`tp ${grid ? 'on' : ''}`}
          title={$t('輔助網格（右鍵設定格數）')}
          onClick={() => useLayout.getState().set({ grid: !grid })}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setGridPop({ x: e.clientX, y: e.clientY });
          }}
        >
          #
        </button>
        {gridPop && <GridPopover at={gridPop} close={() => setGridPop(null)} />}
        <button
          className="tp"
          title={floating ? $t('停駐回主視窗') : $t('分離成浮動視窗')}
          onClick={() => useLayout.getState().set({ floating: !floating })}
        >
          {floating ? <Minimize2 size={15} /> : <PictureInPicture2 size={15} />}
        </button>
      </div>
    </div>
  );
}

/** 網格設定（右鍵網格按鈕） */
function GridPopover({ at, close }: { at: { x: number; y: number }; close: () => void }) {
  const L = useLayout();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(at);
  useLayoutEffect(() => {
    const r = ref.current!.getBoundingClientRect();
    setPos({ x: Math.max(8, Math.min(at.x - r.width, innerWidth - r.width - 8)), y: Math.max(8, Math.min(at.y - r.height - 8, innerHeight - r.height - 8)) });
  }, [at]);
  useEffect(() => {
    const down = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && close();
    const key = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key);
    };
  }, [close]);
  const presets: [number, number][] = [[3, 3], [4, 4], [2, 2], [6, 6], [8, 4], [12, 6]];
  return (
    <div ref={ref} className="popover" style={{ left: pos.x, top: pos.y }} onContextMenu={(e) => e.preventDefault()}>
      <div className="pop-title">{$t('輔助網格')}</div>
      <div className="pop-row"><span>{$t('列（橫線）')}</span><DragNumber value={L.gridRows} min={1} max={24} step={1} decimals={0} def={3} onChange={(v) => L.set({ gridRows: Math.round(v), grid: true })} /></div>
      <div className="pop-row"><span>{$t('欄（直線）')}</span><DragNumber value={L.gridCols} min={1} max={24} step={1} decimals={0} def={3} onChange={(v) => L.set({ gridCols: Math.round(v), grid: true })} /></div>
      <div className="chips">
        {presets.map(([r, c]) => (
          <button key={`${r}x${c}`} className={L.gridRows === r && L.gridCols === c ? 'on' : ''} onClick={() => L.set({ gridRows: r, gridCols: c, grid: true })}>{c}×{r}</button>
        ))}
      </div>
      <label className="check"><input type="checkbox" checked={L.gridCenter} onChange={(e) => L.set({ gridCenter: e.target.checked })} />{' '}{$t('中心十字')}</label>
      <label className="check"><input type="checkbox" checked={L.gridSafe} onChange={(e) => L.set({ gridSafe: e.target.checked })} />{' '}{$t('短影音安全區')}</label>
    </div>
  );
}

/** 把同一個 DOM 節點搬進這個位置（停駐 / 浮動切換時預覽不會重建） */
export function Slot({ host }: { host: HTMLElement }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current!;
    el.appendChild(host);
    return () => {
      if (host.parentElement === el) el.removeChild(host);
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
      if (mode.includes('r')) r.w = Math.max(220, r0.w + dx);
      if (mode.includes('l')) { r.w = Math.max(220, r0.w - dx); r.x = r0.x + r0.w - r.w; }
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
