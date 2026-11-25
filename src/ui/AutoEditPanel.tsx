import React, { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Pencil, RotateCcw, Save, Trash2, Wand2, X } from 'lucide-react';
import { $t, displayName } from '../i18n';
import { uid, useStore } from '../store';
import { usePrefs } from '../prefs';
import { mediaBeats } from '../engine/beats';
import { categoryOf, CATEGORIES } from '../modules/categories';
import { type FxRule, type Recipe, type RecipeId } from '../engine/autoEdit';
import { STYLE_IDS } from '../engine/autoEditStyles';
import { deleteMyStyle, myStyleSettings, renameMyStyle, saveMyStyle, styleSettings, type StyleKey } from '../engine/autoEditSettings';
import type { MusicInfo } from '../engine/musicAnalysis';
import { FLAT_SHAPE, LOW_MAX, MID_MAX, isFlat, offsetAt, shapeMusic, type EnergyShape } from '../engine/energyShape';
import { presample } from '../engine/mediaSampler';
import { aeFootage, analyzeSource, canReplaceLast, cancelAutoEdit, footage, generateAutoEdit, musicClips, musicSource, useAutoEdit, useAutoEditRun, type AutoEditSettings } from '../engine/autoEditApply';
import { useHistory } from '../engine/history';
import { useAiSettings } from '../ai/assistant';
import { Check, Seg, SegToggles, Switch } from './Toggle';
import { POP_VARIANTS, type PopVariant } from '../engine/subjectPop';
import { SPEED_VARIANTS, type SpeedVariant } from '../engine/speedRamp';
import { DragNumber } from './DragNumber';
import { AeRangeDialog, SegList, roleName } from './AeSegments';
import { useDrag } from './uiStore';

const set = (p: Partial<AutoEditSettings>) => useAutoEdit.getState().set(p);
/** 改特效層 / 轉場權重 = 風格變「自訂」（數字照舊） */
const setCustom = (p: Partial<AutoEditSettings>) => {
  const st = useAutoEdit.getState();
  set({ ...p, recipe: 'custom', params: { ...st.params, id: 'custom' } });
};

// ───────────── 版面零件（跟屬性面板同一套 .ec 樣式） ─────────────

function Section({ id, title, count, actions, open, toggle, children }: {
  id: string; title: string; count?: string; actions?: React.ReactNode; open: boolean; toggle: (id: string) => void; children: React.ReactNode;
}) {
  return (
    <>
      <div className="ec-row ec-section">
        <div className="ec-left" onClick={() => toggle(id)}>
          <span className="twirl">{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
          <span className="ec-sec-title">{title}{count && <span className="ae-count">{count}</span>}</span>
          {actions && <span className="ec-actions" onClick={(e) => e.stopPropagation()}>{actions}</span>}
        </div>
      </div>
      {open && children}
    </>
  );
}

const Row = ({ label, children, sub, title }: { label: React.ReactNode; children: React.ReactNode; sub?: boolean; title?: string }) => (
  <div className={`ec-row ${sub ? 'sub' : ''}`} title={title}>
    <div className="ec-left ec-plain"><span className="ec-label">{label}</span><div className="ec-node">{children}</div></div>
  </div>
);

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
function EnergyCurve({ info, shape, onChange }: { info: MusicInfo; shape: EnergyShape; onChange: (s: EnergyShape) => void }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const n = info.energy.length;
  const shaped = useMemo(() => shapeMusic(info, shape).energy, [info, shape]);
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
  const add = (e: React.PointerEvent) => {
    const box = ref.current!.getBoundingClientRect();
    const x = Math.min(0.99, Math.max(0.01, (e.clientX - box.left) / box.width));
    const pts = [...shape.points, { x, y: offsetAt(shape.points, x) }].sort((a, b) => a.x - b.x);
    const idx = pts.findIndex((p) => p.x === x);
    const next = { ...shape, points: pts };
    onChange(next);
    // 新加的點直接開始拖
    shape = next;
    drag(e, idx);
  };
  const remove = (idx: number) => {
    if (idx === 0 || idx === shape.points.length - 1) return;
    onChange({ ...shape, points: shape.points.filter((_, i) => i !== idx) });
  };
  return (
    <div className="ae-curve" ref={ref} onPointerDown={(e) => e.button === 0 && add(e)} onContextMenu={(e) => e.preventDefault()}>
      <svg viewBox="0 0 1000 100" preserveAspectRatio="none">
        <rect className="band high" x="0" y="0" width="1000" height={(1 - MID_MAX) * 100} />
        <rect className="band mid" x="0" y={(1 - MID_MAX) * 100} width="1000" height={(MID_MAX - LOW_MAX) * 100} />
        <rect className="band low" x="0" y={(1 - LOW_MAX) * 100} width="1000" height={LOW_MAX * 100} />
        {info.drops.map((d) => <line key={d} className="drop" x1={(d / n) * 1000} x2={(d / n) * 1000} y1="0" y2="100" />)}
        <path className="base" d={path(info.energy)} />
        <path className="shaped" d={path(shaped)} />
      </svg>
      {shape.points.map((p, i) => (
        <i key={i} className="ae-handle" style={{ left: `${p.x * 100}%`, top: `${(1 - smooth(p.x)) * 100}%` }}
          onPointerDown={(e) => e.button === 0 && drag(e, i)} onDoubleClick={(e) => { e.stopPropagation(); remove(i); }}
          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); remove(i); }} />
      ))}
    </div>
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
  const audios = useStore((x) => x.audios);
  const clips = useStore((x) => x.clips);
  const media = useStore((x) => x.media);
  const modules = useStore((x) => x.modules);
  const loop = useStore((x) => x.loop);
  const combos = usePrefs((x) => x.fxCombos);
  useHistory((h) => h.ver); // 「再一版」能不能用
  const music = useMemo(() => musicClips({ ...useStore.getState(), audios, clips, media }), [audios, clips, media]);
  const feet = useMemo(() => footage({ ...useStore.getState(), media }), [media]);
  // 分頁開著就先在背景分析影片（匯入素材後按「產生」不用再等）
  const analyze = useAutoEdit((x) => x.analyze);
  const director = useAutoEdit((x) => x.director);
  const segs = useAutoEdit((x) => x.segs);
  const using = useMemo(() => aeFootage({ ...useStore.getState(), media }, useAutoEdit.getState()), [media, segs]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const list = using.filter((m) => analyze || director);
    if (!list.length) return;
    let stop = false;
    const t = setTimeout(() => void presample(list, () => stop || useAutoEditRun.getState().running), 800);
    return () => { stop = true; clearTimeout(t); };
  }, [using, analyze, director]);
  const audioId = st.audioId && music.some((a) => a.id === st.audioId) ? st.audioId : music[0]?.id ?? null;

  // 細節區塊預設收起（很少動）
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  // 另存 / 改名自己的風格：名稱輸入框
  const [naming, setNaming] = useState<{ mode: 'save' | 'rename'; text: string } | null>(null);
  const toggle = (id: string) => setOpen((o) => { const n = new Set(o); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  // 音樂分析（段落條）
  useEffect(() => {
    if (!audioId) return;
    const src = musicSource(useStore.getState(), audioId);
    if (src) void analyzeSource(src).catch(() => {});
  }, [audioId, audios, media]);
  const musicInfo = st.analysis?.audioId === audioId ? st.analysis.info : null;
  const shapedInfo = useMemo(() => (musicInfo ? shapeMusic(musicInfo, st.shape) : null), [musicInfo, st.shape]);
  const levels = [0, 0, 0];
  for (const l of shapedInfo?.level ?? []) levels[l]++;
  const audio = audios.find((a) => a.id === audioId);
  const bpm = audio ? mediaBeats(media.find((m) => m.id === audio.mediaId))?.bpm : undefined;

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
    ...groupsOf('effect', fxMods),
  ];
  const trOn = trMods.filter((m) => (st.trWeights[m.id] ?? 1) > 0).length;
  const hasKey = useAiSettings((x) => !!x.key);
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
  const canGo = !run.running && !!audioId && using.length > 0 && (st.range === 'all' || !!loop);
  const replace = canReplaceLast();
  const knob = (label: string, node: React.ReactNode) => <label className="ae-knob"><span>{label}</span>{node}</label>;
  const pct = (v: number, on: (v: number) => void, max = 100) => <DragNumber value={Math.round(v * 100)} min={0} max={max} step={5} decimals={0} suffix="%" onChange={(x) => on(x / 100)} />;
  const beatsKnob = (i: number) => <DragNumber value={p.beatsPerShot[i]} min={1} max={32} step={1} decimals={0} suffix={$t(' 拍')} onChange={(v) => setLevel(i, Math.round(v))} />;

  return (
    <div className={`auto-edit-panel ae-segs-drop ${dropOver ? 'drop-here' : ''}`}>
      <AeRangeDialog />
      {/* 常用：產生、音樂與能量曲線、智慧挑選、素材、風格 */}
      <div className="ae-bar">
        <button className="btn primary ae-go" disabled={!canGo} onClick={() => void generateAutoEdit(false)}><Wand2 size={15} />{$t('產生')}</button>
        <button className="btn" disabled={!canGo || !replace} onClick={() => void generateAutoEdit(true)}>{$t('再一版')}</button>
        <span className="spacer" />
        <button className="ec-icon" title={$t('重設')} onClick={() => useAutoEdit.getState().reset()}><RotateCcw size={14} /></button>
      </div>
      {run.running ? (
        <div className="ae-progress">
          <div className="ae-progress-line">
            <span className="ae-stat">{run.label}</span>
            <button className="ec-icon" title={$t('取消')} onClick={cancelAutoEdit}><X size={13} /></button>
          </div>
          <div className={`ae-progress-bar ${run.frac === null ? 'busy' : ''}`}><i style={run.frac === null ? undefined : { width: `${Math.round(run.frac * 100)}%` }} /></div>
        </div>
      ) : run.result && (
        <div className={`ae-result ${run.result.ok ? 'ok' : 'err'}`}>
          <span>{run.result.text}</span>
          <button className="ec-icon" title={$t('關閉')} onClick={() => useAutoEditRun.setState({ result: null })}><X size={12} /></button>
        </div>
      )}

      {/* 寬的時候左右兩欄：左 = 音樂、素材；右 = 剪法 */}
      <div className="ae-cols">
        <div className="ae-col">
      <div className="ae-card">
        <div className="ae-card-head">
          <span>{$t('音樂')}</span>
          {bpm && <span className="ae-stat">{bpm.toFixed(1)} BPM{musicInfo && ` · ${$t('{0} 段', musicInfo.sections.length)} · ${$t('{0} 個 drop', musicInfo.drops.length)}`}</span>}
        </div>
        {!music.length ? (
          <div className="ae-empty">{$t('沒有節拍：先在音訊軌放音樂')}</div>
        ) : (
          <>
            <div className="ae-line">
              <select className="select ae-grow" value={audioId ?? ''} onChange={(e) => set({ audioId: e.target.value })}>
                {music.map((a) => <option key={a.id} value={a.id}>{a.name || media.find((m) => m.id === a.mediaId)?.name} · {a.duration.toFixed(1)}s</option>)}
              </select>
              {loop && <Seg value={st.range} on={(v) => set({ range: v })} opts={[{ v: 'all', label: $t('整段') }, { v: 'loop' as const, label: $t('循環範圍') }]} />}
            </div>
            {musicInfo && (
              <>
                <EnergyCurve info={musicInfo} shape={st.shape} onChange={(shape) => set({ shape })} />
                <SectionBar info={shapedInfo ?? musicInfo} />
                <div className="ae-line ae-curve-tools">
                  {knob($t('整體強度'), <DragNumber value={Math.round(st.shape.gain * 100)} min={-50} max={50} step={5} decimals={0} suffix="%" onChange={(v) => set({ shape: { ...st.shape, gain: v / 100 } })} />)}
                  {knob($t('對比'), <DragNumber value={Math.round(st.shape.contrast * 100)} min={50} max={200} step={5} decimals={0} suffix="%" onChange={(v) => set({ shape: { ...st.shape, contrast: v / 100 } })} />)}
                  <span className="spacer" />
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
        <div className="ae-card-head"><span>{$t('智慧挑選')}</span></div>
        <Check v={st.analyze} on={(v) => set({ analyze: v })} title={$t('依運動量、畫質、有沒有人、原本的剪接點挑片段')}>{$t('分析影片內容')}</Check>
        <Check v={st.director && hasKey} on={(v) => hasKey && set({ director: v })} title={hasKey ? undefined : $t('AI 導演需要 API 金鑰')}>{$t('AI 導演')}</Check>
        {st.director && hasKey && (
          <input className="text-input" value={st.directorNote} placeholder={$t('給導演的指示')} onChange={(e) => set({ directorNote: e.target.value })} />
        )}
      </div>

      <div className="ae-card">
        <div className="ae-card-head">
          <span className="ae-fold" onClick={() => toggle('feet-hide')}>
            {open.has('feet-hide') ? <ChevronRight size={13} /> : <ChevronDown size={13} />}{$t('素材')}
          </span>
          <span className="ae-head-actions">
            <span className="ae-stat">{segs.length ? $t('{0} 段', segs.length) : $t('全部素材（{0}）', feet.length)}</span>
            {segs.length > 0 && <button className="link" onClick={() => set({ segs: [] })}>{$t('清除')}</button>}
          </span>
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
          {knob($t('低能量鏡頭'), beatsKnob(0))}
          {knob($t('中能量鏡頭'), beatsKnob(1))}
          {knob($t('高能量鏡頭'), beatsKnob(2))}
          {knob($t('轉場'), pct(p.transitionRate, (v) => setParam('transitionRate', v)))}
          {knob($t('密度'), pct(st.density, (v) => set({ density: v }), 200))}
          {knob($t('強度'), pct(st.intensity, (v) => set({ intensity: v })))}
          {knob($t('隨機變化'), pct(p.jitter, (v) => setParam('jitter', v)))}
        </div>
      </div>

      <div className="ae-card">
        <div className="ae-card-head">
          <span>{$t('特效層')}<span className="ae-count">{rulesOn}/{st.rules.length}</span></span>
          <button className="link" onClick={addRule}>{$t('新增')}</button>
        </div>
        <RuleList fxGroups={fxGroups} />
      </div>

      <div className={`ae-card ${st.popOn ? '' : 'off'}`}>
        <div className="ae-card-head"><span>{$t('主體跳出')}</span><Switch v={st.popOn} on={(v) => set({ popOn: v })} /></div>
        {st.popOn && (
          <>
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
          </>
        )}
      </div>

      <div className={`ae-card ${st.speedOn ? '' : 'off'}`}>
        <div className="ae-card-head"><span>{$t('跟拍變速')}</span><Switch v={st.speedOn} on={(v) => set({ speedOn: v })} /></div>
        {st.speedOn && (
          <>
            <SegToggles className="ae-style ae-grid4" items={SPEED_VARIANTS.map((v) => ({
              key: v, label: speedName(v), v: st.speedVariants.includes(v),
              on: (on: boolean) => { const l = useAutoEdit.getState().speedVariants; set({ speedVariants: on ? [...l.filter((x) => x !== v), v] : l.filter((x) => x !== v) }); },
            }))} />
            <div className="ae-grid3">
              {knob($t('次數'), <DragNumber value={st.speedsPer32} min={0} max={8} step={0.5} decimals={1} suffix={$t(' / 32 拍')} onChange={(v) => set({ speedsPer32: v })} />)}
              {knob($t('強度'), pct(st.speedIntensity, (v) => set({ speedIntensity: v })))}
            </div>
          </>
        )}
      </div>

      {/* 細節：預設收起 */}
      <div className="ec plain ae-more">
        <Section id="shots" title={$t('鏡頭')} open={open.has('shots')} toggle={toggle}>
          <Row label={$t('鏡頭最短')} sub><DragNumber value={p.minShotSec} min={0.1} max={10} step={0.05} decimals={2} suffix="s" onChange={(v) => setParam('minShotSec', Math.min(v, p.maxShotSec))} /></Row>
          <Row label={$t('鏡頭最長')} sub><DragNumber value={p.maxShotSec} min={0.5} max={30} step={0.5} decimals={1} suffix="s" onChange={(v) => setParam('maxShotSec', Math.max(v, p.minShotSec))} /></Row>
          <Row label={$t('推近 / 拉遠')} sub><Switch v={st.kenBurns} on={(v) => set({ kenBurns: v })} /></Row>
          <Row label={$t('素材順序')} sub>
            <Seg value={st.order} on={(v) => set({ order: v })} opts={[{ v: 'library', label: $t('清單順序') }, { v: 'shuffle', label: $t('隨機') }]} />
          </Row>
        </Section>

        <Section id="tr" title={$t('轉場')} count={`${trOn}/${trMods.length}`} open={open.has('tr')} toggle={toggle} actions={allNone(trMods.map((m) => m.id))}>
          <Row label={$t('段落交界 / drop')} sub>{pct(p.sectionTransitionRate, (v) => setParam('sectionTransitionRate', v))}</Row>
          <Row label={$t('轉場長度')} sub><DragNumber value={p.transitionBeats} min={0.25} max={4} step={0.25} decimals={2} suffix={$t(' 拍')} onChange={(v) => setParam('transitionBeats', v)} /></Row>
          <WeightList groups={groupsOf('transition', trMods)} weights={st.trWeights} open={open} toggle={toggle} />
        </Section>
      </div>
        </div>
      </div>
    </div>
  );
}
