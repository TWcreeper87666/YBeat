/**
 * 自動剪輯的分段：在歌上框一段，指定這段的轉場、特效層、鏡頭長度、跳出 / 變速，還有給 AI 的指示。
 * 分段軌畫在能量曲線下面（橫軸跟曲線一樣是拍號）；設定在「分段」分頁編輯。
 */
import React, { useState } from 'react';
import { create } from 'zustand';
import { Lock, MessageSquare, Plus, Sparkles, Trash2, X } from 'lucide-react';
import { $t } from '../i18n';
import { keyOf, parseKey, uid, useStore } from '../store';
import { useAutoEdit } from '../engine/autoEditSettings';
import type { FxRule, Recipe } from '../engine/autoEdit';
import type { Section } from '../engine/musicAnalysis';
import type { AeZone } from '../engine/autoEditSettings';
import { carveZones, currentZones, editZones, resetZones, zoneBeat } from '../engine/autoEditApply';
import { tc } from '../engine/rulerTicks';
import { sendChat } from '../ai/assistant';
import { Check, Seg, SegToggles } from './Toggle';
import { DragNumber } from './DragNumber';
import { RuleList, type PickGroup } from './AeRules';
import { roleName } from './AeSegments';
import { useDock } from './Dock';

export type AeTab = 'feet' | 'style' | 'fx' | 'zones';
/** 下面那一塊看哪個分頁、選中哪個分段 */
export const useAeView = create<{ tab: AeTab; zone: string | null }>(() => ({ tab: 'feet', zone: null }));
export const selectZone = (id: string | null) => useAeView.setState(id ? { zone: id, tab: 'zones' } : { zone: null });

/** 歌的拍（歌的秒數）+ 曲線的拍數 + 歌的結尾：拍號 ↔ 秒數 */
export interface ZoneAxis { beats: { t: number; down?: boolean }[]; n: number; end: number }
const tOf = (ax: ZoneAxis, b: number) => (b >= ax.beats.length ? ax.end : ax.beats[Math.max(0, b)].t);

/** 拍號 → 最近的重拍（頭尾不動；any = 每一拍都可以） */
function snap(ax: ZoneAxis, raw: number, any: boolean) {
  if (any || raw <= 0 || raw >= ax.n || !ax.beats.some((b) => b.down)) return raw;
  let best = raw, d = Infinity;
  for (let i = 0; i < ax.beats.length; i++) if (ax.beats[i].down && Math.abs(i - raw) < d) { d = Math.abs(i - raw); best = i; }
  return Math.abs(ax.n - raw) < d ? ax.n : best;
}

const clean = (z: AeZone): AeZone => Object.fromEntries(Object.entries(z).filter(([, v]) => v !== undefined)) as unknown as AeZone;
const upd = (id: string, p: Partial<AeZone>) => editZones((l) => l.map((z) => (z.id === id ? clean({ ...z, ...p }) : z)));

/** 分段的簡短摘要（分段軌、清單上顯示） */
export function zoneSummary(z: AeZone, nameOf: (id: string) => string): string {
  const out: string[] = [];
  if (z.tr === null) out.push($t('不轉場'));
  else if (z.tr) out.push(z.tr.length === 1 ? nameOf(z.tr[0]) : $t('{0} 種轉場', z.tr.length));
  const fx = (z.rules ?? []).filter((r) => r.on).map((r) => nameOf(r.moduleId));
  if (fx.length) out.push(fx.length > 2 ? `${fx.slice(0, 2).join('+')}…` : fx.join('+'));
  if (z.fxRate === 0) out.push($t('關風格特效'));
  else if (z.fxRate !== undefined) out.push(`${$t('特效')} ${Math.round(z.fxRate * 100)}%`);
  if (z.tr !== null && z.trRate !== undefined) out.push(`${$t('轉場')} ${Math.round(z.trRate * 100)}%`);
  if (z.beatsPerShot) out.push(`${z.beatsPerShot}${$t(' 拍')}`);
  if (z.noPop) out.push($t('不跳出'));
  if (z.noSpeed) out.push($t('不變速'));
  return out.join(' · ') || $t('照風格');
}

/** 框一段：新的分段蓋掉舊的重疊部分，選中它 */
export function addZone(t0: number, t1: number) {
  const same = currentZones().list.find((z) => Math.abs(z.t0 - t0) < 1e-3 && Math.abs(z.t1 - t1) < 1e-3);
  if (same) return selectZone(same.id);
  const id = uid();
  editZones((l) => carveZones(l, { id, t0, t1 }));
  selectZone(id);
}

/** 點段落條的一塊 = 框那一段 */
export const pickSection = (ax: ZoneAxis, s: Pick<Section, 'b0' | 'b1'>) => addZone(tOf(ax, s.b0), tOf(ax, s.b1));

/**
 * 分段軌：空白處左鍵拖 = 框一段（吸附重拍，Shift = 每一拍）；點分段 = 選中；拖兩端 = 改範圍；右鍵 = 刪掉
 */
export function ZoneLane({ ax, zones, auto, nameOf }: { ax: ZoneAxis; zones: AeZone[]; auto: boolean; nameOf: (id: string) => string }) {
  const sel = useAeView((x) => x.zone);
  const box = React.useRef<HTMLDivElement>(null);
  const [ghost, setGhost] = useState<[number, number] | null>(null);
  const beatAt = (clientX: number, any: boolean) => {
    const r = box.current!.getBoundingClientRect();
    return snap(ax, Math.max(0, Math.min(ax.n, Math.round(((clientX - r.left) / r.width) * ax.n))), any);
  };
  const pct = (b: number) => `${(b / ax.n) * 100}%`;
  const track = (move: (ev: PointerEvent) => void, up?: () => void) => {
    const u = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', u); up?.(); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', u);
  };
  const draw = (e: React.PointerEvent) => {
    if (e.button !== 0 || e.target !== e.currentTarget) return;
    e.preventDefault();
    const b0 = beatAt(e.clientX, e.shiftKey);
    let range: [number, number] | null = null;
    track((ev) => {
      const b = beatAt(ev.clientX, ev.shiftKey);
      range = b === b0 ? null : [Math.min(b0, b), Math.max(b0, b)];
      setGhost(range);
    }, () => {
      setGhost(null);
      if (range) addZone(tOf(ax, range[0]), tOf(ax, range[1]));
      else selectZone(null);
    });
  };
  const resize = (e: React.PointerEvent, z: AeZone, side: 0 | 1) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    selectZone(z.id);
    const i = zones.findIndex((x) => x.id === z.id);
    // 不能蓋到旁邊的分段、至少留一拍
    const lo = side === 0 ? (i > 0 ? zoneBeat(zones[i - 1].t1, ax.beats) : 0) : zoneBeat(z.t0, ax.beats) + 1;
    const hi = side === 0 ? zoneBeat(z.t1, ax.beats) - 1 : (i < zones.length - 1 ? zoneBeat(zones[i + 1].t0, ax.beats) : ax.n);
    track((ev) => {
      const t = tOf(ax, Math.max(lo, Math.min(hi, beatAt(ev.clientX, ev.shiftKey))));
      upd(z.id, side === 0 ? { t0: t } : { t1: t });
    });
  };
  return (
    <div className="ae-zone-lane" ref={box} onPointerDown={draw} onContextMenu={(e) => e.preventDefault()}>
      {zones.map((z) => {
        const b0 = zoneBeat(z.t0, ax.beats), b1 = zoneBeat(z.t1, ax.beats);
        return (
          <div key={z.id} className={`ae-zone ${sel === z.id ? 'on' : ''} ${auto ? 'auto' : ''}`} style={{ left: pct(b0), width: pct(b1 - b0) }}
            title={`${tc(z.t0)} – ${tc(z.t1)} · ${zoneSummary(z, nameOf)}${z.prompt ? `\n${z.prompt}` : ''}`}
            onPointerDown={(e) => {
              e.stopPropagation();
              if (e.button === 2) { editZones((l) => l.filter((x) => x.id !== z.id)); if (sel === z.id) selectZone(null); }
              else if (e.button === 0) selectZone(z.id);
            }}>
            {z.prompt && <MessageSquare size={10} />}
            <span>{zoneSummary(z, nameOf)}</span>
            <i className="ae-zone-edge l" onPointerDown={(e) => resize(e, z, 0)} />
            <i className="ae-zone-edge r" onPointerDown={(e) => resize(e, z, 1)} />
          </div>
        );
      })}
      {ghost && <div className="ae-zone ghost" style={{ left: pct(ghost[0]), width: pct(ghost[1] - ghost[0]) }} />}
    </div>
  );
}

/**
 * 上一版在這個分段裡的東西（片段、特效；中點落在分段裡的）：時間軸 key。
 * 分段是歌的秒數，用上一版那段歌放在時間軸的位置換算
 */
function zoneItems(z: AeZone): string[] {
  const take = useAutoEdit.getState().lastTake?.id;
  const s = useStore.getState();
  const au = take && s.audios.find((a) => a.take === take);
  if (!au) return [];
  const T = (t: number) => au.start + (t - au.in) / (au.rate || 1);
  const t0 = T(z.t0), t1 = T(z.t1);
  const inside = (x: { start: number; duration: number; take?: string }) => x.take === take && x.start + x.duration / 2 >= t0 && x.start + x.duration / 2 < t1;
  return [...s.clips.filter(inside).map((c) => keyOf('clip', c.id)), ...s.effects.filter(inside).map((f) => keyOf('effect', f.id))];
}

/** 鎖住 / 解鎖這段（選取那些東西再切換，時間軸上看得到鎖了哪些） */
function lockZone(z: AeZone) {
  const keys = zoneItems(z);
  if (!keys.length) return;
  const st = useStore.getState();
  st.selectKeys(keys);
  useStore.getState().toggleLockSelected();
}

/** 「分段」分頁：分段清單 + 選中那段的設定 */
export function ZonePanel({ ax, zones, auto, sections, fxGroups, trGroups, nameOf, params }: {
  ax: ZoneAxis | null; zones: AeZone[]; auto: boolean; sections: Section[]; fxGroups: PickGroup[]; trGroups: PickGroup[]; nameOf: (id: string) => string; params: Recipe;
}) {
  const sel = useAeView((x) => x.zone);
  const z = zones.find((x) => x.id === sel);
  const prompts = zones.filter((x) => x.prompt?.trim());
  const bySections = () => {
    if (!ax) return;
    editZones(() => sections.map((s) => ({ id: uid(), t0: tOf(ax, s.b0), t1: tOf(ax, s.b1) })));
  };
  const askAi = () => {
    const lines = prompts.map((x, i) => `${i + 1}. ${tc(x.t0)} – ${tc(x.t1)} (${x.t0.toFixed(2)}s–${x.t1.toFixed(2)}s)：${x.prompt!.trim()}`);
    sendChat(`${$t('照每個分段的指示調整自動剪輯的分段設定（set_auto_edit 的 zones；範圍和指示保留）：')}\n${lines.join('\n')}`);
    useDock.getState().activatePanel('ai');
  };
  return (
    <div className="ae-zones">
      <div className="ae-line">
        <span className="ae-stat ae-grow">{auto ? $t('自動（{0}）', zones.length) : $t('手動（{0}）', zones.length)}</span>
        {ax && sections.length > 1 && <button className="link" onClick={bySections}>{$t('照段落切分')}</button>}
        {!auto && <button className="ec-icon" title={$t('改回自動')} onClick={() => { resetZones(); selectZone(null); }}><X size={12} /></button>}
      </div>
      {!zones.length ? (
        <div className="ae-empty">{$t('還沒有分段')}</div>
      ) : (
        <div className="ae-zone-list">
          {zones.map((x) => {
            const kind = ax && sections.find((s) => tOf(ax, s.b0) <= x.t0 + 1e-3 && x.t0 < tOf(ax, s.b1) - 1e-3)?.kind;
            return (
              <div key={x.id} className={`ae-seg ${x.id === sel ? 'on' : ''}`} onClick={() => selectZone(x.id)}>
                <span className="ae-stat">{tc(x.t0)} – {tc(x.t1)}</span>
                {kind && <em className="ae-role">{roleName(kind)}</em>}
                <span className="ae-seg-name">{zoneSummary(x, nameOf)}</span>
                {x.prompt && <MessageSquare size={11} className="ae-crop" />}
              </div>
            );
          })}
        </div>
      )}
      {z && <ZoneEditor key={z.id} z={z} fxGroups={fxGroups} trGroups={trGroups} params={params} />}
      {prompts.length > 0 && (
        <button className="btn ae-ask" onClick={askAi}><Sparkles size={14} />{$t('交給 AI（{0}）', prompts.length)}</button>
      )}
    </div>
  );
}

/** 鎖住這段：上一版在這段裡的東西全部鎖住，「再一版」時保留 */
function ZoneLock({ z }: { z: AeZone }) {
  useStore((s) => s.clips);
  useStore((s) => s.effects);
  useAutoEdit((x) => x.lastTake);
  const keys = zoneItems(z);
  if (!keys.length) return null;
  const s = useStore.getState();
  const all = keys.every((k) => { const { type, id } = parseKey(k); return (type === 'clip' ? s.clips : s.effects).find((x) => x.id === id)?.locked; });
  return <button className={`ec-icon ${all ? 'on' : ''}`} title={all ? $t('解鎖這段') : $t('鎖住這段')} onClick={() => lockZone(z)}><Lock size={13} /></button>;
}

function ZoneEditor({ z, fxGroups, trGroups, params }: { z: AeZone; fxGroups: PickGroup[]; trGroups: PickGroup[]; params: Recipe }) {
  const mode = z.tr === undefined ? 'style' : z.tr === null ? 'none' : 'only';
  const set = (p: Partial<AeZone>) => upd(z.id, p);
  const rules = z.rules ?? [];
  const setRules = (r: FxRule[]) => set({ rules: r.length ? r : undefined });
  const addRule = () => setRules([...rules, { id: uid(), moduleId: 'fx-flash', on: true, when: 'drop', levels: [0, 1, 2], chance: 1 }]);
  const knob = (label: string, node: React.ReactNode) => <label className="ae-knob"><span>{label}</span>{node}</label>;
  return (
    <div className="ae-zone-edit">
      <div className="ae-card-head">
        <span>{tc(z.t0)} – {tc(z.t1)}</span>
        <span className="ae-head-actions">
          <ZoneLock z={z} />
          <button className="ec-icon" title={$t('刪除')} onClick={() => { editZones((l) => l.filter((x) => x.id !== z.id)); selectZone(null); }}><Trash2 size={13} /></button>
        </span>
      </div>

      <div className="ae-addon">
        <div className="ae-addon-head"><span>{$t('轉場')}</span>
          <Seg value={mode} on={(v) => set({ tr: v === 'style' ? undefined : v === 'none' ? null : z.tr ?? [] })}
            opts={[{ v: 'style', label: $t('照風格') }, { v: 'none', label: $t('不用') }, { v: 'only', label: $t('指定') }]} />
        </div>
        {mode === 'only' && trGroups.filter((g) => g.items.length).map((g) => (
          <div key={g.id} className="ae-zone-picks">
            <span className="ae-label">{g.label}</span>
            <SegToggles className="ae-style ae-grid4" items={g.items.map((i) => ({
              key: i.id, label: i.label, v: !!z.tr?.includes(i.id),
              on: (on: boolean) => { const l = z.tr ?? []; set({ tr: on ? [...l.filter((x) => x !== i.id), i.id] : l.filter((x) => x !== i.id) }); },
            }))} />
          </div>
        ))}
        {mode !== 'none' && (
          <div className="ae-grid3">
            {knob($t('轉場頻率'), <DragNumber value={Math.round((z.trRate ?? params.transitionRate) * 100)} min={0} max={100} step={5} decimals={0} suffix="%"
              def={Math.round(params.transitionRate * 100)}
              onChange={(v) => set({ trRate: Math.abs(v / 100 - params.transitionRate) < 1e-6 ? undefined : Math.min(1, Math.max(0, v / 100)) })} />)}
          </div>
        )}
      </div>

      <div className="ae-addon">
        <div className="ae-addon-head"><span>{$t('特效')}</span>
          <button className="link" onClick={addRule}><Plus size={12} />{$t('新增')}</button>
        </div>
        <div className="ae-grid3">
          {knob($t('風格特效量'), <DragNumber value={Math.round((z.fxRate ?? 1) * 100)} min={0} max={200} step={10} decimals={0} suffix="%" def={100}
            onChange={(v) => set({ fxRate: Math.abs(v - 100) < 1e-6 ? undefined : Math.max(0, v / 100) })} />)}
        </div>
        {rules.length > 0 && <RuleList fxGroups={fxGroups} rules={rules} onChange={setRules} levels={false} />}
      </div>

      <div className="ae-addon">
        <Check v={!!z.beatsPerShot} on={(v) => set({ beatsPerShot: v ? 2 : undefined })}>{$t('固定鏡頭長度')}</Check>
        {!!z.beatsPerShot && (
          <div className="ae-grid3">
            {knob($t('鏡頭'), <DragNumber value={z.beatsPerShot} min={1} max={32} step={1} decimals={0} suffix={$t(' 拍')} onChange={(v) => set({ beatsPerShot: Math.max(1, Math.round(v)) })} />)}
          </div>
        )}
        <Check v={!z.noPop} on={(v) => set({ noPop: v ? undefined : true })}>{$t('主體跳出')}</Check>
        <Check v={!z.noSpeed} on={(v) => set({ noSpeed: v ? undefined : true })}>{$t('跟拍變速')}</Check>
      </div>

      <textarea className="text-input ae-prompt" rows={2} defaultValue={z.prompt ?? ''} placeholder={$t('給 AI 的指示')}
        onKeyDown={(e) => e.stopPropagation()}
        onBlur={(e) => { const v = e.currentTarget.value.trim(); if (v !== (z.prompt ?? '')) set({ prompt: v || undefined }); }} />
    </div>
  );
}
