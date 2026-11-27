/** 自動剪輯的特效層編輯（風格的特效層、分段自己的特效層共用）：一層一行 */
import React from 'react';
import { X } from 'lucide-react';
import { $t } from '../i18n';
import type { FxRule } from '../engine/autoEdit';
import { SegToggles, Switch } from './Toggle';
import { DragNumber } from './DragNumber';

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

export type PickGroup = { id: string; label: string; items: { id: string; label: React.ReactNode }[] };

/**
 * 特效層清單：每層一行（開關 · 特效 · 時機 · 能量 · 機率 · 移除）。
 * levels = false：不顯示能量（分段的特效層只看範圍）
 */
export function RuleList({ fxGroups, rules, onChange, levels = true }: {
  fxGroups: PickGroup[]; rules: FxRule[]; onChange: (rules: FxRule[]) => void; levels?: boolean;
}) {
  const upd = (id: string, p: Partial<FxRule>) => onChange(rules.map((r) => (r.id === id ? { ...r, ...p } : r)));
  const known = new Set(fxGroups.flatMap((g) => g.items.map((i) => i.id)));
  if (!rules.length) return <div className="ae-empty">{$t('沒有特效層')}</div>;
  return (
    <div className="ae-layers">
      {rules.map((r) => (
        <div key={r.id} className={'ae-layer' + (r.on ? '' : ' ae-dim')}>
          <Switch v={r.on} on={(v) => upd(r.id, { on: v })} />
          <select className="select ae-layer-fx" value={r.moduleId} onChange={(e) => upd(r.id, { moduleId: e.target.value })}>
            {!known.has(r.moduleId) && <option value={r.moduleId}>{$t('（素材遺失）')}</option>}
            {fxGroups.filter((g) => g.items.length).map((g) => (
              <optgroup key={g.id} label={g.label}>{g.items.map((i) => <option key={i.id} value={i.id}>{i.label}</option>)}</optgroup>
            ))}
          </select>
          <select className="select ae-layer-when" value={whenValue(r)} onChange={(e) => {
            const w = WHENS.find((x) => x.v === e.target.value)!.rule;
            upd(r.id, { when: w.when, every: w.every });
          }}>
            {WHENS.map((x) => <option key={x.v} value={x.v}>{x.label()}</option>)}
          </select>
          {levels && r.when !== 'drop' && (
            <SegToggles className="ae-layer-lv" items={LEVELS.map(({ l, label }) => ({
              key: String(l), label: label(), v: r.levels.includes(l),
              on: (on: boolean) => upd(r.id, { levels: on ? [...new Set([...r.levels, l])].sort() : r.levels.filter((x) => x !== l) }),
            }))} />
          )}
          <DragNumber value={Math.round(r.chance * 100)} min={0} max={100} step={5} decimals={0} suffix="%" onChange={(v) => upd(r.id, { chance: Math.min(1, Math.max(0, v / 100)) })} />
          <button className="ec-icon" title={$t('移除')} onClick={() => onChange(rules.filter((x) => x.id !== r.id))}><X size={13} /></button>
        </div>
      ))}
    </div>
  );
}
