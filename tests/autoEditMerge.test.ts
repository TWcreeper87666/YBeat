// 自動剪輯：範圍、觸發一樣的特效方塊合併成疊加的特效
import { strict as assert } from 'node:assert';
import { mergeStacked } from '../src/engine/autoEditApply';
import type { FxItem } from '../src/store';
import type { Module } from '../src/modules/builtin';

const mod = (id: string, hit: number | null): Module => ({ id, kind: 'effect', name: id, code: hit ? `// @duration ${hit}\n// @hit\n` : '// @duration 3\n' });
const modules = [mod('hitA', 0.4), mod('hitB', 0.4), mod('hitC', 0.25), mod('holdA', null), mod('holdB', null)];
let n = 0;
const fx = (moduleId: string, track: number, start: number, duration: number, extra: Partial<FxItem> = {}): FxItem =>
  ({ id: `f${n++}`, moduleId, params: {}, start, duration, track, ...extra });

// 整段一樣 → 合併，空出來的軌道收掉
{
  const out = mergeStacked([fx('holdA', 0, 0, 4), fx('holdB', 1, 0, 4), fx('hitA', 2, 1, 0.4)], modules);
  assert.equal(out.length, 2);
  const a = out.find((f) => f.moduleId === 'holdA')!;
  assert.deepEqual(a.stack?.map((x) => x.moduleId), ['holdB']);
  assert.equal(a.track, 0);
  assert.equal(out.find((f) => f.moduleId === 'hitA')!.track, 1, '軌道 2 收成 1');
}

// 範圍不同 / 觸發不同 → 不合併
{
  const out = mergeStacked([fx('holdA', 0, 0, 4), fx('holdB', 1, 0, 3), fx('hitA', 2, 0, 4, { trigger: { kind: 'beat', every: 1 } })], modules);
  assert.equal(out.length, 3);
}

// 有觸發：衝擊長度一樣才合併
{
  const tr = { kind: 'beat' as const, every: 1 as const };
  const out = mergeStacked([fx('hitA', 0, 0, 4, { trigger: tr }), fx('hitB', 1, 0, 4, { trigger: tr }), fx('hitC', 2, 0, 4, { trigger: tr })], modules);
  assert.equal(out.length, 2);
  assert.deepEqual(out.find((f) => f.moduleId === 'hitA')!.stack?.map((x) => x.moduleId), ['hitB']);
}

// 中間軌道有重疊的別的特效：照樣合併
{
  const out = mergeStacked([fx('holdA', 0, 0, 4), fx('hitA', 1, 1, 0.4), fx('holdB', 2, 0, 4)], modules);
  assert.equal(out.length, 2);
}

// 沒設機率時 seed 不同也算同一種觸發；有機率時 seed 要一樣
{
  const beat = (seed: number, chance?: number) => ({ trigger: { kind: 'beat' as const, every: 1 as const, seed, ...(chance ? { chance } : {}) } });
  assert.equal(mergeStacked([fx('holdA', 0, 0, 4, beat(1)), fx('holdB', 1, 0, 4, beat(2))], modules).length, 1);
  assert.equal(mergeStacked([fx('holdA', 0, 0, 4, beat(1, 0.5)), fx('holdB', 1, 0, 4, beat(2, 0.5))], modules).length, 2);
}

// 組合的疊加接在後面、合併後名稱拿掉
{
  const out = mergeStacked([fx('holdA', 0, 0, 4, { name: '電影感', stack: [{ id: 's', moduleId: 'hitC', params: {} }] }), fx('holdB', 1, 0, 4, { stack: [{ id: 't', moduleId: 'hitA', params: {} }] })], modules);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].stack?.map((x) => x.moduleId), ['hitC', 'holdB', 'hitA']);
  assert.equal(out[0].name, undefined);
}
