import React, { useEffect, useMemo, useState } from 'react';
import { create } from 'zustand';
import { ChevronDown, ChevronRight, Flag, Pause, Pencil, Play, RotateCcw, Save, Trash2, Wand2, X } from 'lucide-react';
import { isTextField } from './focus';
import { $t, displayName } from '../i18n';
import { uid, useStore, type Media } from '../store';
import { usePrefs } from '../prefs';
import { mediaBeats } from '../engine/beats';
import { categoryOf, CATEGORIES } from '../modules/categories';
import { BUILTIN_COMBOS } from '../modules/combos';
import { type FxRule, type Recipe, type RecipeId } from '../engine/autoEdit';
import { STYLE_IDS } from '../engine/autoEditStyles';
import { deleteMyStyle, myStyleSettings, renameMyStyle, saveMyStyle, styleSettings, type StyleKey } from '../engine/autoEditSettings';
import type { MusicInfo } from '../engine/musicAnalysis';
import { FLAT_SHAPE, LOW_MAX, MID_MAX, isFlat, offsetAt, shapeMusic, type EnergyShape } from '../engine/energyShape';
import { presample } from '../engine/mediaSampler';
import { aeFootage, aeSong, analyzeSource, canReplaceLast, cancelAutoEdit, editChorus, footage, generateAutoEdit, songChorus, songMedia, songSource, useAutoEdit, useAutoEditRun, type AutoEditSettings } from '../engine/autoEditApply';
import { songKey } from '../engine/autoEditSettings';
import { tc } from '../engine/rulerTicks';
import { useHistory } from '../engine/history';
import { Check, Seg, SegToggles, Switch } from './Toggle';
import { POP_VARIANTS, type PopVariant } from '../engine/subjectPop';
import { SPEED_VARIANTS, type SpeedVariant } from '../engine/speedRamp';
import { DragNumber } from './DragNumber';
import { AeRangeDialog, SegList, openSongRange, roleName, useAeFocus } from './AeSegments';
import { pausePreviews } from './SourcePanel';
import { SpeedCurveCard } from './SpeedCurveCard';
import { useDrag } from './uiStore';

/** 面板上改設定：預覽先停（不然一邊播一邊改） */
const set = (p: Partial<AutoEditSettings>) => { pausePreviews(); useAutoEdit.getState().set(p); };
/** 改特效層 / 轉場權重 = 風格變「自訂」（數字照舊） */
const setCustom = (p: Partial<AutoEditSettings>) => {
  const st = useAutoEdit.getState();
  set({ ...p, recipe: 'custom', params: { ...st.params, id: 'custom' } });
};

/** 卡片裡可收合的細節：▸ 標題（數量）……右邊動作 */
function Fold({ title, count, actions, open, toggle, children }: {
  title: string; count?: string; actions?: React.ReactNode; open: boolean; toggle: () => void; children: React.ReactNode;
}) {
  return (
    <div className={`ae-sub ${open ? 'open' : ''}`}>
      <div className="ae-sub-head" onClick={toggle}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <span>{title}{count && <span className="ae-count">{count}</span>}</span>
        {actions && <span className="ae-head-actions" onClick={(e) => e.stopPropagation()}>{actions}</span>}
      </div>
      {open && <div className="ae-sub-body">{children}</div>}
    </div>
  );
}

/** 加料的一項：標題 + 開關，打開才展開設定 */
function Addon({ title, count, right, on, children }: { title: string; count?: string; right: React.ReactNode; on: boolean; children: React.ReactNode }) {
  return (
    <div className={`ae-addon ${on ? '' : 'off'}`}>
      <div className="ae-addon-head"><span>{title}{count && <span className="ae-count">{count}</span>}</span>{right}</div>
      {on && <div className="ae-addon-body">{children}</div>}
    </div>
  );
}

/** 轉場權重（依分類收合）：0 = 不用、1 = 一般、3 = 常出現 */
function WeightList({ groups, weights, open, toggle }: {
  groups: { id: string; label: string; items: { id: string; label: React.ReactNode }[] }[];
  weights: Record<string, number>; open: Set<string>; toggle: (id: string) => void;
}) {
  const w = (id: string) => weights[id] ?? 1;
  const setW = (ids: string[], v: number) => setCustom({ trWeights: { ...useAutoEdit.getState().trWeights, ...Object.fromEntries(ids.map((id) => [id, v])) } });
  return (
    <>
      {groups.filter((g) => g.items.length).map((g) => {
        const on = g.items.filter((i) => w(i.id) > 0).length;
        const isOpen = open.has(g.id);
        return (
          <React.Fragment key={g.id}>
            <div className="ec-row sub ae-group">
              <div className="ec-left ec-plain">
                <span className="twirl small" onClick={() => toggle(g.id)}>{isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</span>
                <span className="ec-label" onClick={() => toggle(g.id)}>{g.label}<span className="ae-count">{on}/{g.items.length}</span></span>
                <div className="ec-node"><Switch v={on > 0} on={(v) => setW(g.items.map((i) => i.id), v ? 1 : 0)} /></div>
              </div>
            </div>
            {isOpen && (
              <div className="ae-picks">
                {g.items.map((i) => (
                  <div key={i.id} className={'check' + (w(i.id) > 0 ? '' : ' ae-dim')}>
                    <span className="check-label">{i.label}</span>
                    <DragNumber value={w(i.id)} min={0} max={3} step={0.5} decimals={1} suffix="×" onChange={(v) => setW([i.id], Math.round(v * 2) / 2)} />
                  </div>
                ))}
              </div>
            )}
          </React.Fragment>
        );
      })}
    </>
  );
}

/** 特效層的時機（select 的值 → 規則） */
const WHENS: { v: string; label: () => string; rule: Pick<FxRule, 'when' | 'every'> }[] = [
  { v: 'b0.5', label: () => $t('每半拍'), rule: { when: 'beat', every: 0.5 } },
  { v: 'b1', label: () => $t('每拍'), rule: { when: 'beat', every: 1 } },
  { v: 'b2', label: () => $t('每 2 拍'), rule: { when: 'beat', every: 2 } },
  { v: 'b4', label: () => $t('每小節'), rule: { when: 'beat', every: 4 } },
  { v: 'cut', label: () => $t('每個剪接點'), rule: { when: 'cut' } },
  { v: 'accent', label: () => $t('重音'), rule: { when: 'accent' } },
  { v: 'drop', label: () => 'drop', rule: { when: 'drop' } },
  { v: 'section', label: () => $t('整個段落'), rule: { when: 'section' } },
];
const whenValue = (r: FxRule) => (r.when === 'beat' ? 'b' + (r.every ?? 1) : r.when);
const LEVELS = [{ l: 0 as const, label: () => $t('低能量') }, { l: 1 as const, label: () => $t('中能量') }, { l: 2 as const, label: () => $t('高能量') }];

type PickGroup = { id: string; label: string; items: { id: string; label: React.ReactNode }[] };

/** 特效層清單：每層一條特效軌，疊在一起 */
function RuleList({ fxGroups }: { fxGroups: PickGroup[] }) {
  const rules = useAutoEdit((x) => x.rules);
  const upd = (id: string, p: Partial<FxRule>) => setCustom({ rules: useAutoEdit.getState().rules.map((r) => (r.id === id ? { ...r, ...p } : r)) });
  const known = new Set(fxGroups.flatMap((g) => g.items.map((i) => i.id)));
  return (
    <div className="ae-layers">
      {!rules.length && <div className="ae-empty">{$t('沒有特效層')}</div>}
      {rules.map((r) => (
        <div key={r.id} className={'ae-layer' + (r.on ? '' : ' ae-dim')}>
          <div className="ae-line">
            <Switch v={r.on} on={(v) => upd(r.id, { on: v })} />
            <select className="select ae-grow" value={r.moduleId} onChange={(e) => upd(r.id, { moduleId: e.target.value })}>
              {!known.has(r.moduleId) && <option value={r.moduleId}>{$t('（素材遺失）')}</option>}
              {fxGroups.filter((g) => g.items.length).map((g) => (
                <optgroup key={g.id} label={g.label}>{g.items.map((i) => <option key={i.id} value={i.id}>{i.label}</option>)}</optgroup>
              ))}
            </select>
            <button className="ec-icon" title={$t('移除')} onClick={() => setCustom({ rules: useAutoEdit.getState().rules.filter((x) => x.id !== r.id) })}><X size={13} /></button>
          </div>
          <div className="ae-line ae-layer-sub">
            <select className="select" value={whenValue(r)} onChange={(e) => {
              const w = WHENS.find((x) => x.v === e.target.value)!.rule;
              upd(r.id, { when: w.when, every: w.every });
            }}>
              {WHENS.map((x) => <option key={x.v} value={x.v}>{x.label()}</option>)}
            </select>
            {r.when !== 'drop' && (
              <SegToggles items={LEVELS.map(({ l, label }) => ({
                key: String(l), label: label(), v: r.levels.includes(l),
                on: (on: boolean) => {
                  const cur = useAutoEdit.getState().rules.find((x) => x.id === r.id)?.levels ?? [];
                  upd(r.id, { levels: on ? [...new Set([...cur, l])].sort() : cur.filter((x) => x !== l) });
                },
              }))} />
            )}
            <span className="spacer" />
            <DragNumber value={Math.round(r.chance * 100)} min={0} max={100} step={5} decimals={0} suffix="%" onChange={(v) => upd(r.id, { chance: Math.min(1, Math.max(0, v / 100)) })} />
          </div>
        </div>
      ))}
    </div>
  );
}

const popName = (v: PopVariant) => ({
  step: $t('逐拍放大'), mono: $t('黑白背景'), fly: $t('飛入'), shake: $t('震閃'),
  crossShot: $t('跨畫面'), textBehind: $t('文字在後'), trail: $t('殘影'), grid: $t('四格'),
  spin: $t('旋轉分身'), dim: $t('暗背景'), halo: $t('描邊光暈'), blur: $t('背景模糊'),
  silhouetteWindow: $t('剪影窗'), subjectHole: $t('主體挖洞'),
})[v];

const styleName = (v: RecipeId) => ({
  calm: $t('穩'), rhythm: $t('節奏'), hype: $t('炸'), velocity: $t('速度感'), glitch: $t('故障'), flash: $t('閃光'),
})[v];

const speedName = (v: SpeedVariant) => ({
  beatPulse: $t('每拍快慢'), hitRamp: $t('衝入剪接'), drift: $t('緩速'), holdHit: $t('重音定格'),
  rewindToCut: $t('剪前倒抽'), reverseForwardB: $t('倒播回正'), rewindReturn: $t('正倒正'), beatBoomerang: $t('逐拍來回'),
  slowPocket: $t('拍間慢放'), tapeStop: $t('卡帶停'), whooshRamp: $t('甩鏡加速'), beatStutter: $t('重複切片'),
})[v];

const KIND_COLOR: Record<string, string> = { intro: 'var(--sec-intro)', build: 'var(--sec-build)', drop: 'var(--sec-drop)', outro: 'var(--sec-intro)', body: 'var(--sec-body)' };

/** 能量曲線編輯器：淡色 = 分析出來的能量、亮線 = 調整後；背景三帶 = 低 / 中 / 高；控制點上下拖 = 更嗨 / 更穩 */
/** 副歌點（能量曲線上方那一條）：t = 歌的秒數、beats = 這段歌的拍（素材秒數）、url = 試聽用 */
interface ChorusLane { auto: boolean; t: number[]; beats: { t: number; down?: boolean }[]; m: Media }

/**
 * 歌的試聽（能量曲線上的播放頭）：pos = 播放位置（歌的秒數）。
 * 左鍵拖曲線 = 移動播放頭；滑鼠在自動剪輯分頁裡時 Space = 播放 / 暫停、Esc = 停止、C = 在播放頭加 / 拿掉副歌點
 */
const useSongPlay = create<{ pos: number | null; playing: boolean }>(() => ({ pos: null, playing: false }));
let songEl: HTMLAudioElement | null = null;
let songRaf = 0;
/** 播到這裡停（選用範圍的結尾） */
let songEnd = Infinity;
function songPause() {
  cancelAnimationFrame(songRaf);
  songEl?.pause();
  if (useSongPlay.getState().playing) useSongPlay.setState({ playing: false });
}
function songPlay(url: string, from: number) {
  pausePreviews();
  if (useStore.getState().playing) useStore.setState({ playing: false });
  songEl ??= new Audio();
  if (songEl.src !== url) songEl.src = url;
  songEl.currentTime = from;
  void songEl.play().catch(() => {});
  useSongPlay.setState({ pos: from, playing: true });
  cancelAnimationFrame(songRaf);
  const tick = () => {
    if (!songEl || songEl.paused) return songPause();
    if (songEl.currentTime >= songEnd) { useSongPlay.setState({ pos: songEnd }); return songPause(); }
    useSongPlay.setState({ pos: songEl.currentTime });
    songRaf = requestAnimationFrame(tick);
  };
  songRaf = requestAnimationFrame(tick);
}
// 時間軸開始播：歌的試聽停下來
useStore.subscribe((s, p) => { if (s.playing && !p.playing) songPause(); });

/** 滑鼠在自動剪輯分頁裡（Space / Esc / C 給試聽用） */
let aeHover = false;

/** 拍號（可以是小數）↔ 歌的秒數；曲線的橫軸是拍號，拍跟拍之間照時間內插 */
function beatScale(beats: { t: number }[], n: number) {
  const last = beats.length - 1, step = last > 0 ? (beats[last].t - beats[0].t) / last : 0.5;
  const timeAt = (b: number) => {
    const i = Math.max(0, Math.min(last, Math.floor(b)));
    const t0 = beats[i].t, t1 = i < last ? beats[i + 1].t : t0 + step;
    return t0 + (b - i) * (t1 - t0);
  };
  const beatAtT = (t: number) => {
    let i = 0;
    while (i < last && beats[i + 1].t <= t) i++;
    const t1 = i < last ? beats[i + 1].t : beats[i].t + step;
    return i + Math.max(0, Math.min(1, (t - beats[i].t) / Math.max(1e-6, t1 - beats[i].t)));
  };
  return { timeAt, beatAtT, end: timeAt(n), x: (t: number) => beatAtT(t) / n, t: (x: number) => timeAt(x * n) };
}

/** 拍號 → 最近的重拍（沒有重拍資訊 = 原本的拍）；any = 每一拍都可以 */
function snapDown(beats: { down?: boolean }[], raw: number, any = false) {
  if (any || !beats.some((b) => b.down)) return raw;
  let best = -1;
  for (let i = 0; i < beats.length; i++) if (beats[i].down && (best < 0 || Math.abs(i - raw) < Math.abs(best - raw))) best = i;
  return best < 0 ? raw : best;
}

/** 在播放頭的位置（吸附重拍）加副歌點；那裡已經有就拿掉 */
function toggleChorusAt(beats: { t: number; down?: boolean }[], pos: number) {
  let raw = 0;
  for (let i = 1; i < beats.length; i++) if (Math.abs(beats[i].t - pos) < Math.abs(beats[raw].t - pos)) raw = i;
  const t = beats[snapDown(beats, raw)].t;
  editChorus((l) => (l.some((v) => Math.abs(v - t) < 1e-3) ? l.filter((v) => Math.abs(v - t) >= 1e-3) : [...l, t]));
}

/** 拍號 ↔ 曲線上的位置（跟 drop 線一樣畫在拍的開頭） */
const beatOf = (beats: { t: number }[], t: number) => {
  let best = 0;
  for (let i = 1; i < beats.length; i++) if (Math.abs(beats[i].t - t) < Math.abs(beats[best].t - t)) best = i;
  return best;
};

/** 副歌點：曲線最上面那一條。左鍵拖旗子 = 移動（吸附重拍，Shift = 每一拍）、右鍵 = 加 / 拿掉；空白處左鍵 = 移動播放頭（交給曲線） */
function ChorusFlags({ lane, n, box }: { lane: ChorusLane; n: number; box: React.RefObject<HTMLDivElement | null> }) {
  const [ghost, setGhost] = useState<number | null>(null);
  const { beats } = lane;
  const beatAt = (clientX: number, any = false) => {
    const r = box.current!.getBoundingClientRect();
    return snapDown(beats, Math.max(0, Math.min(beats.length - 1, Math.round(((clientX - r.left) / r.width) * n))), any);
  };
  const xOf = (t: number) => `${(beatOf(beats, t) / n) * 100}%`;
  const dragFlag = (e: React.PointerEvent, t: number) => {
    if (e.button !== 0 && e.button !== 2) return;
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX;
    let cur = t, moved = false;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - x0) < 3) return;
      moved = true;
      const nt = Math.round(beats[beatAt(ev.clientX, ev.shiftKey)].t * 1000) / 1000;
      if (nt === cur) return;
      const was = cur;
      cur = nt;
      editChorus((l) => l.map((v) => (Math.abs(v - was) <= 1e-3 ? nt : v)));
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <div className="ae-chorus-lane" title={$t('副歌')}
      onPointerDown={(e) => {
        // 右鍵按下空白處：加一支旗子，按著拖可以直接帶著走
        if (e.button !== 2 || e.target !== e.currentTarget) return;
        const nt = Math.round(beats[beatAt(e.clientX, e.shiftKey)].t * 1000) / 1000;
        editChorus((l) => [...l, nt]);
        dragFlag(e, nt);
      }}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
      onPointerMove={(e) => setGhost((e.target as HTMLElement).classList.contains('ae-chorus-lane') ? beatAt(e.clientX, e.shiftKey) : null)} onPointerLeave={() => setGhost(null)}>
      {ghost !== null && <i className="flag ghost" style={{ left: `${(ghost / n) * 100}%` }} />}
      {lane.t.map((t) => (
        <i key={t} className={`flag ${lane.auto ? 'auto' : ''}`} style={{ left: xOf(t) }} title={`${tc(t)} · ${$t('副歌')}`}
          onPointerDown={(e) => {
            // 右鍵點旗子 = 刪掉
            if (e.button === 2) { e.preventDefault(); e.stopPropagation(); editChorus((l) => l.filter((v) => Math.abs(v - t) > 1e-3)); return; }
            dragFlag(e, t);
          }}
          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }} />
      ))}
    </div>
  );
}

/**
 * 能量曲線的背景：歌的波形 + 節拍格線（跟時間軸的音訊片段一樣：每拍短刻度、重拍長刻度）。
 * 橫軸跟曲線一樣是拍號，波形和旗子才對得上
 */
function CurveWave({ m, beats, n }: { m: Media; beats: { t: number; down?: boolean }[]; n: number }) {
  const ref = React.useRef<HTMLCanvasElement>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ro = new ResizeObserver(() => setW(c.clientWidth));
    ro.observe(c);
    return () => ro.disconnect();
  }, []);
  const theme = usePrefs((x) => x.theme);
  useEffect(() => {
    const c = ref.current, peaks = m.peaks;
    if (!c || !w) return;
    const dpr = devicePixelRatio || 1, W = Math.round(w * dpr), H = Math.round(c.clientHeight * dpr);
    c.width = W; c.height = H;
    const g = c.getContext('2d')!;
    g.clearRect(0, 0, W, H);
    // 顏色從 CSS 讀（color = 波形 / 拍、border-color = 重拍；跟著主題），透明度在這裡給
    const cs = getComputedStyle(c);
    const { timeAt } = beatScale(beats, n);
    if (peaks?.length) {
      const pps = m.peaksPerSec || 100;
      let max = 1e-6;
      const i0 = Math.max(0, Math.floor(beats[0].t * pps)), i1 = Math.min(peaks.length, Math.ceil(timeAt(n) * pps));
      for (let i = i0; i < i1; i++) max = Math.max(max, peaks[i]);
      g.fillStyle = cs.color;
      g.globalAlpha = 0.22;
      for (let x = 0; x < W; x++) {
        const a = Math.floor(timeAt((x / W) * n) * pps), b = Math.max(a + 1, Math.floor(timeAt(((x + 1) / W) * n) * pps));
        let v = 0;
        for (let i = a; i < b && i < peaks.length; i++) v = Math.max(v, peaks[i]);
        const bh = (v / max) * H * 0.8;
        g.fillRect(x, (H - bh) / 2, 1, Math.max(1, bh));
      }
    }
    // 節拍格線：太密就只畫重拍
    const dense = W / n < 6 * dpr;
    for (let i = 0; i < beats.length; i++) {
      const down = !!beats[i].down;
      if (dense && !down) continue;
      const x = Math.round((i / n) * W);
      g.fillStyle = down ? cs.borderTopColor : cs.color;
      g.globalAlpha = down ? 0.9 : 0.4;
      const h = (down ? 10 : 5) * dpr;
      g.fillRect(x, H - h, dpr, h);
    }
    g.globalAlpha = 1;
  }, [m, beats, n, w, theme]);
  return <canvas ref={ref} className="ae-curve-wave" />;
}

function EnergyCurve({ info, shape, onChange, chorus }: { info: MusicInfo; shape: EnergyShape; onChange: (s: EnergyShape) => void; chorus?: ChorusLane | null }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const n = info.energy.length;
  const shaped = useMemo(() => shapeMusic(info, shape).energy, [info, shape]);
  const scale = useMemo(() => (chorus && chorus.beats.length > 1 ? beatScale(chorus.beats, n) : null), [chorus?.beats, n]); // eslint-disable-line react-hooks/exhaustive-deps
  const pos = useSongPlay((x) => x.pos);
  const playing = useSongPlay((x) => x.playing);
  songEnd = scale?.end ?? Infinity;
  // 換歌 / 換範圍：播放頭回到開頭
  useEffect(() => { songPause(); useSongPlay.setState({ pos: null }); }, [scale]);
  useEffect(() => songPause, []);
  // 滑鼠在自動剪輯分頁裡：Space = 播放 / 暫停、Esc = 停止、C = 在播放頭加 / 拿掉副歌點（擋掉時間軸的快捷鍵）
  useEffect(() => {
    if (!chorus || !scale) return;
    const key = (e: KeyboardEvent) => {
      if (!aeHover || isTextField(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      const st = useSongPlay.getState();
      const at = st.pos ?? chorus.beats[0].t;
      if (e.code === 'Space') {
        if (st.playing) songPause();
        else songPlay(chorus.m.url, at >= scale.end - 0.05 ? chorus.beats[0].t : at);
      } else if (e.key === 'Escape') songPause();
      else if (e.key === 'c' || e.key === 'C') toggleChorusAt(chorus.beats, at);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [chorus, scale]);
  // 控制點顯示在「調整後的能量」上：用附近幾拍的平均，避免跟著單一拍跳
  const smooth = (x: number) => {
    const c = Math.round(x * (n - 1));
    let sum = 0, k = 0;
    for (let i = Math.max(0, c - 4); i <= Math.min(n - 1, c + 4); i++) { sum += shaped[i]; k++; }
    return k ? sum / k : 0.5;
  };
  const path = (vals: number[]) => vals.map((v, i) => `${i ? 'L' : 'M'}${((i + 0.5) / n) * 1000},${(1 - v) * 100}`).join('');
  const drag = (e: React.PointerEvent, idx: number) => {
    e.preventDefault();
    e.stopPropagation();
    const box = ref.current!.getBoundingClientRect();
    const start = { y: e.clientY, pts: shape.points.map((p) => ({ ...p })) };
    const last = idx === 0 || idx === start.pts.length - 1;
    const move = (ev: PointerEvent) => {
      const pts = start.pts.map((p) => ({ ...p }));
      const p = pts[idx];
      p.y = Math.min(1, Math.max(-1, start.pts[idx].y - (ev.clientY - start.y) / box.height / 0.6));
      if (!last) p.x = Math.min(pts[idx + 1].x - 0.01, Math.max(pts[idx - 1].x + 0.01, (ev.clientX - box.left) / box.width));
      onChange({ ...shape, points: pts });
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  /** 右鍵按下空白處：在這裡加一個控制點，按著拖可以直接帶著走 */
  const add = (e: React.PointerEvent) => {
    const box = ref.current!.getBoundingClientRect();
    const x = Math.min(0.99, Math.max(0.01, (e.clientX - box.left) / box.width));
    const pts = [...shape.points, { x, y: offsetAt(shape.points, x) }].sort((a, b) => a.x - b.x);
    const idx = pts.findIndex((p) => p.x === x);
    const next = { ...shape, points: pts };
    onChange(next);
    shape = next;
    drag(e, idx);
  };
  const remove = (idx: number) => {
    if (idx === 0 || idx === shape.points.length - 1) return;
    onChange({ ...shape, points: shape.points.filter((_, i) => i !== idx) });
  };
  /** 左鍵拖曳 = 移動播放頭（播放中：拖的時候先停，放開接著播） */
  const scrub = (e: React.PointerEvent) => {
    if (e.button !== 0 || !scale || !chorus) return;
    e.preventDefault();
    const was = useSongPlay.getState().playing;
    songPause();
    const at = (x: number) => {
      const r = ref.current!.getBoundingClientRect();
      return scale.t(Math.max(0, Math.min(1, (x - r.left) / r.width)));
    };
    useSongPlay.setState({ pos: at(e.clientX) });
    const move = (ev: PointerEvent) => useSongPlay.setState({ pos: at(ev.clientX) });
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (was) songPlay(chorus.m.url, useSongPlay.getState().pos!);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const headX = scale && pos !== null ? scale.x(pos) * 100 : null;
  return (
    <div className={`ae-curve ${scale ? 'scrub' : ''}`} ref={ref} onPointerDown={(e) => (e.button === 2 ? add(e) : scrub(e))} onContextMenu={(e) => e.preventDefault()}>
      {chorus && chorus.beats.length > 1 && <CurveWave m={chorus.m} beats={chorus.beats} n={n} />}
      <svg viewBox="0 0 1000 100" preserveAspectRatio="none">
        <rect className="band high" x="0" y="0" width="1000" height={(1 - MID_MAX) * 100} />
        <rect className="band mid" x="0" y={(1 - MID_MAX) * 100} width="1000" height={(MID_MAX - LOW_MAX) * 100} />
        <rect className="band low" x="0" y={(1 - LOW_MAX) * 100} width="1000" height={LOW_MAX * 100} />
        {info.drops.map((d) => <line key={d} className="drop" x1={(d / n) * 1000} x2={(d / n) * 1000} y1="0" y2="100" />)}
        <path className="base" d={path(info.energy)} />
        <path className="shaped" d={path(shaped)} />
        {chorus?.t.map((t) => { const x = (beatOf(chorus.beats, t) / n) * 1000; return <line key={t} className={`chorus ${chorus.auto ? 'auto' : ''}`} x1={x} x2={x} y1="0" y2="100" />; })}
      </svg>
      {chorus && chorus.beats.length > 0 && <ChorusFlags lane={chorus} n={n} box={ref} />}
      {shape.points.map((p, i) => (
        <i key={i} className="ae-handle" style={{ left: `${p.x * 100}%`, top: `${(1 - smooth(p.x)) * 100}%` }}
          onPointerDown={(e) => {
            if (e.button === 0) drag(e, i);
            // 右鍵點控制點 = 刪掉
            else if (e.button === 2) { e.preventDefault(); e.stopPropagation(); remove(i); }
          }}
          onDoubleClick={(e) => { e.stopPropagation(); remove(i); }}
          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }} />
      ))}
      {headX !== null && <b className={`ae-curve-head ${playing ? 'on' : ''}`} style={{ left: `${headX}%` }} />}
    </div>
  );
}

/** 曲線下方：播放 / 暫停、在播放頭加副歌（跟 Space / C 一樣） */
function SongTransport({ m, beats }: { m: Media; beats: { t: number; down?: boolean }[] }) {
  const playing = useSongPlay((x) => x.playing);
  const pos = useSongPlay((x) => x.pos);
  const at = pos ?? beats[0]?.t ?? 0;
  return (
    <>
      <button className="ec-icon" title={`${playing ? $t('暫停') : $t('播放')} (Space)`} onClick={() => (playing ? songPause() : songPlay(m.url, at >= songEnd - 0.05 ? beats[0].t : at))}>
        {playing ? <Pause size={13} /> : <Play size={13} />}
      </button>
      <button className="ec-icon ae-flag-btn" title={`${$t('在播放頭加副歌')} (C)`} onClick={() => toggleChorusAt(beats, at)}><Flag size={13} /></button>
    </>
  );
}

/** 音樂段落條：寬度 = 拍數、亮度 = 能量 */
function SectionBar({ info }: { info: MusicInfo }) {
  const n = info.energy.length || 1;
  return (
    <div className="ae-sections">
      {info.sections.map((s) => (
        <div key={s.b0} style={{ flex: s.b1 - s.b0, background: KIND_COLOR[s.kind], opacity: 0.45 + s.energy * 0.55 }} title={`${roleName(s.kind)} · ${s.b0 + 1}–${s.b1}`} />
      ))}
      {info.drops.map((d) => <i key={d} style={{ left: `${(d / n) * 100}%` }} />)}
    </div>
  );
}

// ───────────── 面板 ─────────────

export function AutoEditPanel() {
  const st = useAutoEdit();
  const media = useStore((x) => x.media);
  const modules = useStore((x) => x.modules);
  const combos = usePrefs((x) => x.fxCombos);
  useHistory((h) => h.ver); // 「再一版」能不能用
  const music = useMemo(() => songMedia({ ...useStore.getState(), media }), [media]);
  const feet = useMemo(() => footage({ ...useStore.getState(), media }), [media]);
  // 分頁開著就先在背景分析影片（匯入素材後按「產生」不用再等）
  const analyze = useAutoEdit((x) => x.analyze);
  const director = useAutoEdit((x) => x.director);
  const segs = useAutoEdit((x) => x.segs);
  const pick = useAutoEdit((x) => x.pick);
  const using = useMemo(() => aeFootage({ ...useStore.getState(), media }, useAutoEdit.getState()), [media, segs, pick]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const list = using.filter((m) => analyze || director);
    if (!list.length) return;
    let stop = false;
    const t = setTimeout(() => void presample(list, () => stop || useAutoEditRun.getState().running), 800);
    return () => { stop = true; clearTimeout(t); };
  }, [using, analyze, director]);
  const song = aeSong({ ...useStore.getState(), media }, st);
  const songSrc = useMemo(() => (song ? songSource({ ...useStore.getState(), media }, song) : null), [song?.mediaId, song?.a, song?.b, media]); // eslint-disable-line react-hooks/exhaustive-deps

  // 細節區塊預設收起（很少動）
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  // 另存 / 改名自己的風格：名稱輸入框
  const [naming, setNaming] = useState<{ mode: 'save' | 'rename'; text: string } | null>(null);
  // 跟拍變速：滑過的種類顯示曲線卡片
  const [speedHover, setSpeedHover] = useState<{ el: HTMLElement; v: SpeedVariant } | null>(null);
  const toggle = (id: string) => setOpen((o) => { const n = new Set(o); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  // 從時間軸跳到素材清單：收起的話打開
  const aeFocus = useAeFocus((x) => x.n);
  useEffect(() => { if (aeFocus) setOpen((o) => { if (!o.has('feet-hide')) return o; const n = new Set(o); n.delete('feet-hide'); return n; }); }, [aeFocus]);

  // 音樂分析（段落條）
  useEffect(() => {
    if (songSrc) void analyzeSource(songSrc).catch(() => {});
  }, [songSrc]);
  const musicInfo = song && st.analysis?.key === songKey(song) ? st.analysis.info : null;
  const shapedInfo = useMemo(() => (musicInfo ? shapeMusic(musicInfo, st.shape) : null), [musicInfo, st.shape]);
  const levels = [0, 0, 0];
  for (const l of shapedInfo?.level ?? []) levels[l]++;
  const songM = song && media.find((m) => m.id === song.mediaId);
  const bpm = songM ? mediaBeats(songM)?.bpm : undefined;
  const chorus = song ? songChorus(song, songSrc?.beats ?? [], shapedInfo) : null;

  const p = st.params;
  const setParam = <K extends keyof Recipe>(k: K, v: Recipe[K]) => set({ recipe: 'custom', params: { ...p, [k]: v, id: 'custom' } });
  const setLevel = (i: number, v: number) => { const b = [...p.beatsPerShot] as Recipe['beatsPerShot']; b[i] = v; setParam('beatsPerShot', b); };

  const trMods = modules.filter((m) => m.kind === 'transition');
  const fxMods = modules.filter((m) => m.kind === 'effect');
  const groupsOf = (kind: 'transition' | 'effect', list: typeof modules) => [
    ...CATEGORIES[kind].map((c) => ({ id: `${kind}:${c.id}`, label: c.label, items: list.filter((m) => categoryOf(m) === c.id) })),
    { id: `${kind}:custom`, label: $t('自訂'), items: list.filter((m) => categoryOf(m) === 'custom' || categoryOf(m) === 'other') },
  ].map((g) => ({ ...g, items: g.items.map((m) => ({ id: m.id, label: displayName(m.name) })) }));
  const fxGroups = [
    { id: 'effect:combo', label: $t('我的組合'), items: combos.map((c) => ({ id: c.id, label: c.name })) },
    { id: 'effect:builtin-combo', label: $t('組合'), items: BUILTIN_COMBOS.map((c) => ({ id: c.id, label: displayName(c.name) })) },
    ...groupsOf('effect', fxMods),
  ];
  const trOn = trMods.filter((m) => (st.trWeights[m.id] ?? 1) > 0).length;
  const allNone = (ids: string[]) => (
    <>
      <button className="link" onClick={() => setCustom({ trWeights: { ...st.trWeights, ...Object.fromEntries(ids.map((id) => [id, Math.max(1, st.trWeights[id] ?? 1)])) } })}>{$t('全選')}</button>
      <button className="link" onClick={() => setCustom({ trWeights: { ...st.trWeights, ...Object.fromEntries(ids.map((id) => [id, 0])) } })}>{$t('全不選')}</button>
    </>
  );
  const addRule = () => setCustom({ rules: [...useAutoEdit.getState().rules, { id: uid(), moduleId: 'fx-shake', on: true, when: 'beat', every: 1, levels: [2], chance: 1 }] });
  const rulesOn = st.rules.filter((r) => r.on).length;
  const mine = st.myStyles.find((x) => `my:${x.id}` === st.recipe);

  const dropOver = useDrag((x) => x.drag?.target?.kind === 'autoEdit');
  const run = useAutoEditRun();
  const canGo = !run.running && !!songSrc && using.length > 0;
  const replace = canReplaceLast();
  const knob = (label: string, node: React.ReactNode) => <label className="ae-knob"><span>{label}</span>{node}</label>;
  const pct = (v: number, on: (v: number) => void, max = 100) => <DragNumber value={Math.round(v * 100)} min={0} max={max} step={5} decimals={0} suffix="%" onChange={(x) => on(x / 100)} />;
  const beatsKnob = (i: number) => <DragNumber value={p.beatsPerShot[i]} min={1} max={32} step={1} decimals={0} suffix={$t(' 拍')} onChange={(v) => setLevel(i, Math.round(v))} />;

  return (
    <div className={`auto-edit-panel ae-segs-drop ${dropOver ? 'drop-here' : ''}`} onPointerEnter={() => (aeHover = true)} onPointerLeave={() => (aeHover = false)}>
      <AeRangeDialog />
      {/* 常用：產生、音樂與能量曲線、智慧挑選、素材、風格 */}
      <div className="ae-bar">
        <button className="btn primary ae-go" disabled={!canGo} onClick={() => void generateAutoEdit(false)}><Wand2 size={15} />{$t('產生')}</button>
        <button className="btn" disabled={!canGo || !replace} onClick={() => void generateAutoEdit(true)}>{$t('再一版')}</button>
        {/* 中間：上面文字、下面進度條（跑完 = 結果） */}
        <div className={`ae-status ${run.running ? 'run' : run.result ? (run.result.ok ? 'ok' : 'err') : ''}`}>
          {(run.running || run.result) && (
            <>
              <div className="ae-status-line">
                <span className="ae-status-text" title={run.running ? run.label : run.result!.text}>{run.running ? run.label : run.result!.text}</span>
                {run.running
                  ? <button className="ec-icon" title={$t('取消')} onClick={cancelAutoEdit}><X size={12} /></button>
                  : <button className="ec-icon" title={$t('關閉')} onClick={() => useAutoEditRun.setState({ result: null })}><X size={12} /></button>}
              </div>
              <div className={`ae-progress-bar ${run.running && run.frac === null ? 'busy' : ''}`}>
                <i style={run.running ? (run.frac === null ? undefined : { width: `${Math.round(run.frac * 100)}%` }) : { width: '100%' }} />
              </div>
            </>
          )}
        </div>
        <button className="ec-icon" title={$t('重設')} onClick={() => useAutoEdit.getState().reset()}><RotateCcw size={14} /></button>
      </div>

      {/* 寬的時候左右兩欄：左 = 用什麼剪（音樂、素材）；右 = 怎麼剪（風格、加料） */}
      <div className="ae-cols">
        <div className="ae-col">
          <div className="ae-card ae-song-drop">
            <div className="ae-card-head">
              <span>{$t('音樂')}</span>
              {bpm && <span className="ae-stat">{bpm.toFixed(1)} BPM{musicInfo && ` · ${$t('{0} 段', musicInfo.sections.length)} · ${$t('{0} 個 drop', musicInfo.drops.length)}`}</span>}
            </div>
            {!music.length ? (
              <div className="ae-empty">{$t('素材庫裡沒有音樂')}</div>
            ) : (
              <>
                <div className="ae-line">
                  <select className="select ae-grow" value={song?.mediaId ?? ''} onChange={(e) => { const m = music.find((x) => x.id === e.target.value); if (m) set({ song: { mediaId: m.id, a: 0, b: m.duration } }); }}>
                    {music.map((m) => <option key={m.id} value={m.id}>{m.name} · {m.duration.toFixed(1)}s</option>)}
                  </select>
                  {song && songM && (song.a > 0.01 || song.b < songM.duration - 0.01) && <span className="ae-stat">{tc(song.a)} – {tc(song.b)}</span>}
                  <button className="ec-icon" title={$t('選範圍')} onClick={() => openSongRange()}><Pencil size={13} /></button>
                </div>

                {musicInfo && (
                  <>
                    <EnergyCurve info={musicInfo} shape={st.shape} onChange={(shape) => set({ shape })}
                      chorus={chorus && songSrc && songM ? { ...chorus, beats: songSrc.beats, m: songM } : null} />
                    <SectionBar info={shapedInfo ?? musicInfo} />
                    <div className="ae-line ae-curve-tools">
                      {knob($t('整體強度'), <DragNumber value={Math.round(st.shape.gain * 100)} min={-50} max={50} step={5} decimals={0} suffix="%" onChange={(v) => set({ shape: { ...st.shape, gain: v / 100 } })} />)}
                      {knob($t('對比'), <DragNumber value={Math.round(st.shape.contrast * 100)} min={50} max={200} step={5} decimals={0} suffix="%" onChange={(v) => set({ shape: { ...st.shape, contrast: v / 100 } })} />)}
                      <span className="spacer" />
                      {chorus && songSrc && songM && <SongTransport m={songM} beats={songSrc.beats} />}
                      {chorus && (
                        <span className={`ae-chorus-stat ${chorus.auto ? '' : 'manual'}`} title={$t('副歌')}>
                          <i />{chorus.auto ? $t('自動（{0}）', chorus.t.length) : $t('手動（{0}）', chorus.t.length)}
                          {!chorus.auto && <button className="ec-icon" title={$t('改回自動')} onClick={() => editChorus(() => [])}><X size={12} /></button>}
                        </span>
                      )}
                      <span className="ae-levels" title={$t('能量分布')}>
                        <i className="high" />{levels[2]}<i className="mid" />{levels[1]}<i className="low" />{levels[0]}
                      </span>
                      <button className="ec-icon" title={$t('重設曲線')} disabled={isFlat(st.shape)} onClick={() => set({ shape: FLAT_SHAPE() })}><RotateCcw size={13} /></button>
                    </div>
                  </>
                )}
              </>
            )}
          </div>

          <div className="ae-card">
            <div className="ae-card-head">
              <span className="ae-fold" onClick={() => toggle('feet-hide')}>
                {open.has('feet-hide') ? <ChevronRight size={13} /> : <ChevronDown size={13} />}{$t('素材')}
              </span>
              <span className="ae-head-actions">
                <span className="ae-stat">{pick === 'list' ? $t('{0} 段', segs.length) : $t('全部素材（{0}）', feet.length)}</span>
                {(pick === 'all' ? feet.length > 0 : segs.length > 0) && <button className="link" onClick={() => set({ pick: 'list', segs: [] })}>{$t('全部移除')}</button>}
                {pick === 'list' && <button className="link" onClick={() => set({ pick: 'all', segs: [] })}>{$t('用全部素材')}</button>}
              </span>
            </div>
            <div className="ae-smart">
              <Check v={st.analyze} on={(v) => set({ analyze: v })} title={$t('依運動量、畫質、有沒有人、原本的剪接點挑片段')}>{$t('分析影片內容')}</Check>
              {st.lead && <div className="ae-seg ae-lead"><img src={st.lead.thumb} alt="" /><span className="ae-seg-name">{$t('主角')}</span><button className="ec-icon" title={$t('清除')} onClick={() => set({ lead: null })}><X size={13} /></button></div>}
              {st.lead && <Check v={!st.lead.mixed} on={(v) => { const { mixed: _, ...l } = st.lead!; set({ lead: v ? l : { ...l, mixed: true } }); }}>{$t('避開沒有主角的片段')}</Check>}
            </div>
            {!open.has('feet-hide') && <SegList />}
          </div>
        </div>

        <div className="ae-col">
          <div className="ae-card">
            <div className="ae-card-head">
              <span>{$t('風格')}</span>
              <span className="ae-head-actions">
                <button className="ec-icon" title={$t('另存風格')} onClick={() => setNaming({ mode: 'save', text: mine?.name ?? '' })}><Save size={13} /></button>
                {mine && <button className="ec-icon" title={$t('重新命名')} onClick={() => setNaming({ mode: 'rename', text: mine.name })}><Pencil size={13} /></button>}
                {mine && <button className="ec-icon" title={$t('刪除')} onClick={() => deleteMyStyle(mine.id)}><Trash2 size={13} /></button>}
              </span>
            </div>
            {naming && (
              <input className="text-input" autoFocus value={naming.text} placeholder={$t('風格名稱')}
                onChange={(e) => setNaming({ ...naming, text: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setNaming(null);
                  if (e.key !== 'Enter') return;
                  if (naming.mode === 'save') saveMyStyle(naming.text);
                  else if (mine) renameMyStyle(mine.id, naming.text);
                  setNaming(null);
                }}
                onBlur={() => setNaming(null)} />
            )}
            <Seg className="ae-style ae-grid4" value={st.recipe} on={(v: StyleKey) => {
              if (v === 'custom') return;
              const m = st.myStyles.find((x) => `my:${x.id}` === v);
              set(m ? myStyleSettings(m) : styleSettings(v as RecipeId));
            }}
              opts={[
                ...STYLE_IDS.map((v) => ({ v: v as StyleKey, label: styleName(v) })),
                ...st.myStyles.map((m) => ({ v: `my:${m.id}` as StyleKey, label: m.name, title: m.name })),
                ...(st.recipe === 'custom' ? [{ v: 'custom' as StyleKey, label: $t('自訂') }] : []),
              ]} />
            <div className="ae-grid3">
              {knob($t('密度'), pct(st.density, (v) => set({ density: v }), 200))}
              {knob($t('強度'), pct(st.intensity, (v) => set({ intensity: v })))}
              {knob($t('轉場'), pct(p.transitionRate, (v) => setParam('transitionRate', v)))}
            </div>
            <Fold title={$t('鏡頭')} open={open.has('shots')} toggle={() => toggle('shots')}>
              <div className="ae-grid3">
                {knob($t('低能量鏡頭'), beatsKnob(0))}
                {knob($t('中能量鏡頭'), beatsKnob(1))}
                {knob($t('高能量鏡頭'), beatsKnob(2))}
                {knob($t('鏡頭最短'), <DragNumber value={p.minShotSec} min={0.1} max={10} step={0.05} decimals={2} suffix="s" onChange={(v) => setParam('minShotSec', Math.min(v, p.maxShotSec))} />)}
                {knob($t('鏡頭最長'), <DragNumber value={p.maxShotSec} min={0.5} max={30} step={0.5} decimals={1} suffix="s" onChange={(v) => setParam('maxShotSec', Math.max(v, p.minShotSec))} />)}
                {knob($t('隨機變化'), pct(p.jitter, (v) => setParam('jitter', v)))}
              </div>
              <div className="ae-line ae-order">
                <span className="ae-label">{$t('素材順序')}</span>
                <Seg value={st.order} on={(v) => set({ order: v })} opts={[{ v: 'library', label: $t('清單順序') }, { v: 'shuffle', label: $t('隨機') }, { v: 'bag', label: $t('輪流') }]} />
              </div>
              <Check v={st.kenBurns} on={(v) => set({ kenBurns: v })}>{$t('推近 / 拉遠')}</Check>
            </Fold>
            <Fold title={$t('轉場')} count={`${trOn}/${trMods.length}`} open={open.has('tr')} toggle={() => toggle('tr')} actions={allNone(trMods.map((m) => m.id))}>
              <div className="ae-grid3">
                {knob($t('段落交界 / drop'), pct(p.sectionTransitionRate, (v) => setParam('sectionTransitionRate', v)))}
                {knob($t('轉場長度'), <DragNumber value={p.transitionBeats} min={0.25} max={4} step={0.25} decimals={2} suffix={$t(' 拍')} onChange={(v) => setParam('transitionBeats', v)} />)}
              </div>
              <div className="ec plain ae-weights">
                <WeightList groups={groupsOf('transition', trMods)} weights={st.trWeights} open={open} toggle={toggle} />
              </div>
            </Fold>
          </div>

          <div className="ae-card">
            <div className="ae-card-head"><span>{$t('加料')}</span></div>
            <Addon title={$t('特效層')} count={`${rulesOn}/${st.rules.length}`} on right={<button className="link" onClick={addRule}>{$t('新增')}</button>}>
              <RuleList fxGroups={fxGroups} />
            </Addon>
            <Addon title={$t('主體跳出')} on={st.popOn} right={<Switch v={st.popOn} on={(v) => set({ popOn: v })} />}>
              <SegToggles className="ae-style ae-grid4" items={POP_VARIANTS.map((v) => ({
                key: v, label: popName(v), v: st.popVariants.includes(v),
                on: (on: boolean) => { const l = useAutoEdit.getState().popVariants; set({ popVariants: on ? [...l.filter((x) => x !== v), v] : l.filter((x) => x !== v) }); },
              }))} />
              <div className="ae-grid3">
                {knob($t('次數'), <DragNumber value={st.popsPer32} min={0} max={4} step={0.5} decimals={1} suffix={$t(' / 32 拍')} onChange={(v) => set({ popsPer32: v })} />)}
              </div>
              {st.popVariants.includes('textBehind') && (
                <input className="text-input" value={st.popText} placeholder={$t('主體後面的文字')} onChange={(e) => set({ popText: e.target.value })} />
              )}
            </Addon>
            {speedHover && st.speedOn && <SpeedCurveCard anchor={speedHover.el} variant={speedHover.v} name={speedName(speedHover.v)} intensity={st.speedIntensity} />}
            <Addon title={$t('跟拍變速')} on={st.speedOn} right={<Switch v={st.speedOn} on={(v) => set({ speedOn: v })} />}>
              <SegToggles className="ae-style ae-grid4" items={SPEED_VARIANTS.map((v) => ({
                key: v, label: speedName(v), v: st.speedVariants.includes(v), hover: (el) => setSpeedHover(el ? { el, v } : null),
                on: (on: boolean) => { const l = useAutoEdit.getState().speedVariants; set({ speedVariants: on ? [...l.filter((x) => x !== v), v] : l.filter((x) => x !== v) }); },
              }))} />
              <div className="ae-grid3">
                {knob($t('次數'), st.speedEvery ? <span className="ae-every">{$t('每個鏡頭')}</span> : <DragNumber value={st.speedsPer32} min={0} max={8} step={0.5} decimals={1} suffix={$t(' / 32 拍')} onChange={(v) => set({ speedsPer32: v })} />)}
                {knob($t('強度'), pct(st.speedIntensity, (v) => set({ speedIntensity: v })))}
                {knob($t('整體加速'), <DragNumber value={Math.round((st.speedBoost ?? 1) * 100)} min={100} max={300} step={10} decimals={0} def={100} suffix="%" onChange={(v) => set({ speedBoost: Math.round(v) / 100 })} />)}
              </div>
              <Check v={!!st.speedEvery} on={(v) => set({ speedEvery: v })}>{$t('每個鏡頭都套用')}</Check>
            </Addon>
          </div>
        </div>
      </div>
    </div>
  );
}
