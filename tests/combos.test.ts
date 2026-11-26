// 內建特效組合：模組、參數名稱都存在、數值在範圍內、名稱有英日文
import { strict as assert } from 'node:assert';
import { BUILTIN_MODULES } from '../src/modules/builtin';
import { BUILTIN_COMBOS, isBuiltinCombo } from '../src/modules/combos';
import { parseParams, type ParamValues } from '../src/engine/params';
import { fxCombo } from '../src/prefs';
import { EN } from '../src/i18n.en';
import { JA } from '../src/i18n.ja';

function check(moduleId: string, params: ParamValues) {
  const m = BUILTIN_MODULES.find((x) => x.id === moduleId && x.kind === 'effect');
  assert.ok(m, `沒有這個特效模組：${moduleId}`);
  const defs = parseParams(m.code);
  for (const [k, v] of Object.entries(params)) {
    const d = defs.find((x) => x.name === k);
    assert.ok(d, `${moduleId} 沒有參數 ${k}`);
    if (d.type === 'float' || d.type === 'int') {
      assert.equal(typeof v, 'number', `${moduleId}.${k}`);
      assert.ok((v as number) >= d.min && (v as number) <= d.max, `${moduleId}.${k} = ${v} 超出 ${d.min}..${d.max}`);
    } else if (d.type === 'bool') assert.equal(typeof v, 'boolean', `${moduleId}.${k}`);
    else if (d.type === 'color') assert.match(String(v), /^#[0-9a-f]{6}$/, `${moduleId}.${k}`);
  }
}

const ids = BUILTIN_COMBOS.map((c) => c.id);
assert.equal(new Set(ids).size, ids.length, 'id 不重複');
for (const c of BUILTIN_COMBOS) {
  assert.ok(isBuiltinCombo(c.id) && c.builtin);
  assert.equal(fxCombo(c.id), c, '用 id 找得到');
  assert.ok(c.fx.duration > 0);
  check(c.fx.moduleId, c.fx.params);
  for (const s of c.fx.stack ?? []) check(s.moduleId, s.params);
  assert.ok(EN[c.name], `缺英文：${c.name}`);
  assert.ok(JA[c.name], `缺日文：${c.name}`);
}
