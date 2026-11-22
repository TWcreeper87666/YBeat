import React, { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, RotateCcw, Wand2 } from 'lucide-react';
import { $t, displayName } from '../i18n';
import { useStore } from '../store';
import { usePrefs } from '../prefs';
import { mediaBeats } from '../engine/beats';
import { categoryOf, CATEGORIES } from '../modules/categories';
import { isHitFx } from '../engine/params';
import { RECIPES, type Recipe, type RecipeId } from '../engine/autoEdit';
import type { MusicInfo } from '../engine/musicAnalysis';
import { FLAT_SHAPE, LOW_MAX, MID_MAX, isFlat, offsetAt, shapeMusic, type EnergyShape } from '../engine/energyShape';
import { analyzeSource, canReplaceLast, footage, generateAutoEdit, musicClips, musicSource, useAutoEdit, type AutoEditSettings } from '../engine/autoEditApply';
import { useHistory } from '../engine/history';
import { useAiSettings } from '../ai/assistant';
import { Check, Seg, Switch } from './Toggle';
import { DragNumber } from './DragNumber';

const set = (p: Partial<AutoEditSettings>) => useAutoEdit.getState().set(p);

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

/** 一串可以勾選的項目（依分類收合）；off = 不用的 id */
function PickList({ groups, off, onOff, open, toggle }: {
  groups: { id: string; label: string; items: { id: string; label: React.ReactNode; title?: string }[] }[];
  off: string[]; onOff: (off: string[]) => void; open: Set<string>; toggle: (id: string) => void;
}) {
  const offSet = new Set(off);
  return (
    <>
      {groups.filter((g) => g.items.length).map((g) => {
        const on = g.items.filter((i) => !offSet.has(i.id)).length;
        const isOpen = open.has(g.id);
        const setAll = (v: boolean) => {
          const ids = new Set(g.items.map((i) => i.id));
          onOff(v ? off.filter((x) => !ids.has(x)) : [...new Set([...off, ...ids])]);
        };
        return (
          <React.Fragment key={g.id}>
            <div className="ec-row sub ae-group">
              <div className="ec-left ec-plain">
                <span className="twirl small" onClick={() => toggle(g.id)}>{isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</span>
                <span className="ec-label" onClick={() => toggle(g.id)}>{g.label}<span className="ae-count">{on}/{g.items.length}</span></span>
                <div className="ec-node"><Switch v={on > 0} on={setAll} /></div>
              </div>
            </div>
            {isOpen && (
              <div className="ae-picks">
                {g.items.map((i) => (
                  <Check key={i.id} v={!offSet.has(i.id)} title={i.title} on={(v) => onOff(v ? off.filter((x) => x !== i.id) : [...off, i.id])}>{i.label}</Check>
                ))}
              </div>
            )}
          </React.Fragment>
        );
      })}
    </>
  );
}

const roleName = (k: string) => ({ intro: $t('開頭'), build: $t('鋪陳'), drop: $t('高潮'), body: $t('主體'), outro: $t('結尾') } as Record<string, string>)[k] ?? k;

const KIND_COLOR: Record<string, string> = { intro: '#3d4a66', build: '#8a6d2c', drop: '#c2413f', outro: '#3d4a66', body: '#2b7d74' };

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
  const audioId = st.audioId && music.some((a) => a.id === st.audioId) ? st.audioId : music[0]?.id ?? null;

  const [open, setOpen] = useState<Set<string>>(() => new Set(['music', 'style', 'media', 'tr', 'fx']));
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
  const trOn = trMods.filter((m) => !st.trOff.includes(m.id)).length;
  const fxOn = fxMods.filter((m) => !st.fxOff.includes(m.id)).length + combos.filter((c) => !st.fxOff.includes(c.id)).length;
  const mediaOn = feet.filter((m) => !st.mediaOff.includes(m.id)).length;
  const hasKey = useAiSettings((x) => !!x.key);
  const dir = st.director ? st.direction : null;
  const hits = [...combos.map((c) => ({ id: c.id, name: c.name })), ...fxMods.filter(isHitFx).map((m) => ({ id: m.id, name: displayName(m.name) }))];
  const allNone = (ids: string[], key: 'trOff' | 'fxOff' | 'mediaOff') => (
    <>
      <button className="link" onClick={() => set({ [key]: st[key].filter((x) => !ids.includes(x)) })}>{$t('全選')}</button>
      <button className="link" onClick={() => set({ [key]: [...new Set([...st[key], ...ids])] })}>{$t('全不選')}</button>
    </>
  );

  const canGo = !!audioId && mediaOn > 0 && (st.range === 'all' || !!loop);
  const replace = canReplaceLast();

  return (
    <div className="auto-edit-panel">
      <div className="ae-bar">
        <button className="btn primary" disabled={!canGo} onClick={() => void generateAutoEdit(false)}><Wand2 size={14} />{$t('產生')}</button>
        <button className="btn" disabled={!canGo || !replace} onClick={() => void generateAutoEdit(true)}>{$t('再一版')}</button>
        <span className="spacer" />
        <button className="ec-icon" title={$t('重設')} onClick={() => useAutoEdit.getState().reset()}><RotateCcw size={14} /></button>
      </div>
      <div className="ec plain">
        <Section id="music" title={$t('音樂')} open={open.has('music')} toggle={toggle}>
          {!music.length ? (
            <div className="empty">{$t('沒有節拍：先在音訊軌放音樂')}</div>
          ) : (
            <>
              <Row label={$t('音樂')}>
                <select className="select" value={audioId ?? ''} onChange={(e) => set({ audioId: e.target.value })}>
                  {music.map((a) => <option key={a.id} value={a.id}>{a.name || media.find((m) => m.id === a.mediaId)?.name} · {a.duration.toFixed(1)}s</option>)}
                </select>
              </Row>
              <Row label={$t('範圍')}>
                <Seg value={loop ? st.range : 'all'} on={(v) => set({ range: v })} opts={[{ v: 'all', label: $t('整段') }, ...(loop ? [{ v: 'loop' as const, label: $t('循環範圍') }] : [])]} />
              </Row>
              <Row label={$t('分析')}>
                <span className="ae-stat">{bpm ? `${bpm.toFixed(1)} BPM` : '—'}{musicInfo && ` · ${$t('{0} 段', musicInfo.sections.length)} · ${$t('{0} 個 drop', musicInfo.drops.length)}`}</span>
              </Row>
              {musicInfo && (
                <div className="ae-sec-row">
                  <EnergyCurve info={musicInfo} shape={st.shape} onChange={(shape) => set({ shape })} />
                  <SectionBar info={shapedInfo ?? musicInfo} />
                </div>
              )}
              {musicInfo && (
                <>
                  <Row label={$t('整體強度')} sub><DragNumber value={Math.round(st.shape.gain * 100)} min={-50} max={50} step={5} decimals={0} suffix="%" onChange={(v) => set({ shape: { ...st.shape, gain: v / 100 } })} /></Row>
                  <Row label={$t('對比')} sub><DragNumber value={Math.round(st.shape.contrast * 100)} min={50} max={200} step={5} decimals={0} suffix="%" onChange={(v) => set({ shape: { ...st.shape, contrast: v / 100 } })} /></Row>
                  <Row label={$t('能量分布')} sub>
                    <span className="ae-stat">{$t('高 {0} · 中 {1} · 低 {2} 拍', levels[2], levels[1], levels[0])}</span>
                    <button className="ec-icon" title={$t('重設曲線')} disabled={isFlat(st.shape)} onClick={() => set({ shape: FLAT_SHAPE() })}><RotateCcw size={13} /></button>
                  </Row>
                </>
              )}
            </>
          )}
        </Section>

        <Section id="style" title={$t('節奏')} open={open.has('style')} toggle={toggle}>
          <Row label={$t('風格')}>
            <Seg value={st.recipe} on={(v: RecipeId | 'custom') => v !== 'custom' && set({ recipe: v, params: { ...RECIPES[v] } })}
              opts={[{ v: 'calm', label: $t('穩') }, { v: 'rhythm', label: $t('節奏') }, { v: 'hype', label: $t('炸') }, ...(st.recipe === 'custom' ? [{ v: 'custom' as const, label: $t('自訂') }] : [])]} />
          </Row>
          <Row label={$t('低能量鏡頭')} sub><DragNumber value={p.beatsPerShot[0]} min={1} max={32} step={1} decimals={0} suffix={$t(' 拍')} onChange={(v) => setLevel(0, Math.round(v))} /></Row>
          <Row label={$t('中能量鏡頭')} sub><DragNumber value={p.beatsPerShot[1]} min={1} max={32} step={1} decimals={0} suffix={$t(' 拍')} onChange={(v) => setLevel(1, Math.round(v))} /></Row>
          <Row label={$t('高能量鏡頭')} sub><DragNumber value={p.beatsPerShot[2]} min={1} max={32} step={1} decimals={0} suffix={$t(' 拍')} onChange={(v) => setLevel(2, Math.round(v))} /></Row>
          <Row label={$t('隨機變化')} sub><DragNumber value={Math.round(p.jitter * 100)} min={0} max={100} step={5} decimals={0} suffix="%" onChange={(v) => setParam('jitter', v / 100)} /></Row>
          <Row label={$t('鏡頭最短')} sub><DragNumber value={p.minShotSec} min={0.1} max={10} step={0.05} decimals={2} suffix="s" onChange={(v) => setParam('minShotSec', Math.min(v, p.maxShotSec))} /></Row>
          <Row label={$t('鏡頭最長')} sub><DragNumber value={p.maxShotSec} min={0.5} max={30} step={0.5} decimals={1} suffix="s" onChange={(v) => setParam('maxShotSec', Math.max(v, p.minShotSec))} /></Row>
        </Section>

        <Section id="media" title={$t('素材')} count={`${mediaOn}/${feet.length}`} open={open.has('media')} toggle={toggle} actions={allNone(feet.map((m) => m.id), 'mediaOff')}>
          <Row label={$t('順序')} sub>
            <Seg value={st.order} on={(v) => set({ order: v })} opts={[{ v: 'library', label: $t('素材庫順序') }, { v: 'shuffle', label: $t('隨機') }]} />
          </Row>
          <Row label={$t('圖片推近 / 拉遠')} sub><Switch v={st.kenBurns} on={(v) => set({ kenBurns: v })} /></Row>
          <Row label={$t('分析影片內容')} sub title={$t('依運動量、畫質、原本的剪接點挑片段')}><Switch v={st.analyze} on={(v) => set({ analyze: v })} /></Row>
          <Row label={$t('AI 導演')} sub title={hasKey ? undefined : $t('AI 導演需要 API 金鑰')}><Switch v={st.director && hasKey} on={(v) => set({ director: v })} /></Row>
          {st.director && hasKey && (
            <div className="ae-note">
              <input className="text-input" value={st.directorNote} placeholder={$t('給導演的指示')} onChange={(e) => set({ directorNote: e.target.value })} />
            </div>
          )}
          {feet.length ? (
            <div className="ae-picks">
              {feet.map((m) => (
                <Check key={m.id} v={!st.mediaOff.includes(m.id)} title={m.name} on={(v) => set({ mediaOff: v ? st.mediaOff.filter((x) => x !== m.id) : [...st.mediaOff, m.id] })}>
                  <span className={`ae-media ${dir?.[m.id]?.weight === 0 ? 'dim' : ''}`}>
                    {m.thumb && <img src={m.thumb} alt="" />}<span>{m.name}</span>
                    {dir?.[m.id] && <em className="ae-role" title={dir[m.id].note}>{dir[m.id].weight === 0 ? $t('不用') : dir[m.id].roles.map(roleName).join(' · ')}</em>}
                  </span>
                </Check>
              ))}
            </div>
          ) : <div className="empty">{$t('沒有可用的素材')}</div>}
        </Section>

        <Section id="tr" title={$t('轉場')} count={`${trOn}/${trMods.length}`} open={open.has('tr')} toggle={toggle} actions={allNone(trMods.map((m) => m.id), 'trOff')}>
          <Row label={$t('一般切點')} sub><DragNumber value={Math.round(p.transitionRate * 100)} min={0} max={100} step={5} decimals={0} suffix="%" onChange={(v) => setParam('transitionRate', v / 100)} /></Row>
          <Row label={$t('段落交界 / drop')} sub><DragNumber value={Math.round(p.sectionTransitionRate * 100)} min={0} max={100} step={5} decimals={0} suffix="%" onChange={(v) => setParam('sectionTransitionRate', v / 100)} /></Row>
          <Row label={$t('轉場長度')} sub><DragNumber value={p.transitionBeats} min={0.25} max={4} step={0.25} decimals={2} suffix={$t(' 拍')} onChange={(v) => setParam('transitionBeats', v)} /></Row>
          <PickList groups={groupsOf('transition', trMods)} off={st.trOff} onOff={(trOff) => set({ trOff })} open={open} toggle={toggle} />
        </Section>

        <Section id="fx" title={$t('點綴')} count={`${fxOn}/${fxMods.length + combos.length}`} open={open.has('fx')} toggle={toggle} actions={allNone([...fxMods.map((m) => m.id), ...combos.map((c) => c.id)], 'fxOff')}>
          <Row label={$t('頻率')} sub><DragNumber value={p.accentsPer32} min={0} max={16} step={0.5} decimals={1} suffix={$t(' / 32 拍')} onChange={(v) => setParam('accentsPer32', v)} /></Row>
          <Row label={$t('drop 強調')} sub>
            <select className="select" value={st.dropHit ?? ''} onChange={(e) => set({ dropHit: e.target.value || null })}>
              <option value="">{$t('無')}</option>
              {hits.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
            </select>
          </Row>
          <PickList groups={fxGroups} off={st.fxOff} onOff={(fxOff) => set({ fxOff })} open={open} toggle={toggle} />
        </Section>
      </div>
    </div>
  );
}
