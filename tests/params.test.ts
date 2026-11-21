import { strict as assert } from 'node:assert';
import { paramAt, parseParams, parsePointCh, pointCh, resolveParams } from '../src/engine/params';
import { BUILTIN_MODULES } from '../src/modules/builtin';

const code = `// @param center: point = 0.25,0.75 "中心"
// @param ease: curve = inOut "曲線"
// @param raw: curve = 0.1,0.2,0.3,0.4
// @param to: float = 0.2 (0..1) "結束大小" @box(center)
// @param amount: float = 1 (0..2)
`;
const defs = parseParams(code);
const by = (n: string) => defs.find((d) => d.name === n)!;
assert.deepEqual(by('center').def, [0.25, 0.75]);
assert.equal(by('center').type, 'point');
assert.deepEqual(by('ease').def, [0.42, 0, 0.58, 1], '曲線預設值可以用預設名稱');
assert.deepEqual(by('raw').def, [0.1, 0.2, 0.3, 0.4], '也可以直接寫四個數字');
assert.equal(by('to').box, 'center');
assert.equal(by('to').label, '結束大小');
assert.equal(by('amount').box, undefined);
console.log('PASS 參數型別：point / curve / @box 解析');

// 型別不合（舊存檔的數值、壞掉的陣列）→ 用預設值
const v = resolveParams(defs, { center: 0.5, ease: [1, 2], raw: [0, 0, 1, 1], to: 0.5 });
assert.deepEqual(v.center, [0.25, 0.75]);
assert.deepEqual(v.ease, [0.42, 0, 0.58, 1]);
assert.deepEqual(v.raw, [0, 0, 1, 1]);
assert.equal(v.to, 0.5);
console.log('PASS 參數值型別檢查');

// point 的兩軸各自打 key
const lin = [0, 0, 1, 1] as [number, number, number, number];
const keys = { [pointCh('center', 0)]: [{ id: 'a', t: 0, v: 0, ease: lin }, { id: 'b', t: 1, v: 1, ease: lin }] };
assert.deepEqual(paramAt(by('center'), v, keys, 0.5), [0.5, 0.75], 'X 有 key、Y 用固定值');
assert.deepEqual(parsePointCh('center.y'), { name: 'center', axis: 1 });
assert.equal(parsePointCh('mask.x'), null, '遮罩的 channel 不是 point');
assert.equal(parsePointCh('amount'), null);
console.log('PASS point 關鍵影格');

// 內建模組：中心都改成 point、不再有 cx / cy
for (const m of BUILTIN_MODULES) {
  const d = parseParams(m.code);
  assert.ok(!d.some((x) => x.name === 'cx' || x.name === 'cy'), `${m.id} 還有 cx / cy`);
  for (const x of d) if (x.box) assert.ok(d.some((p) => p.name === x.box && p.type === 'point'), `${m.id} 的 @box 指向不存在的 point`);
}
const so = parseParams(BUILTIN_MODULES.find((m) => m.id === 'tr-scaleout')!.code);
assert.ok(so.some((d) => d.type === 'point') && so.some((d) => d.type === 'curve') && so.some((d) => d.box === 'center'));
console.log('PASS 內建模組使用 point / curve');

// curve 的「無」：@none(值) → 整段固定是這個值
import { bezierY } from '../src/engine/keyframes';
const none = parseParams('// @param fadeIn: curve = 0.3,1,0,1 "淡入" @none(1)\n// @param ease: curve = inOut "曲線"');
assert.equal(none[0].none, 1);
assert.equal(none[1].none, undefined, '沒寫 @none 就沒有');
assert.equal(bezierY([-1, 1, 0, 0], 0), 1);
assert.equal(bezierY([-1, 0, 0, 0], 0.7), 0);
const si = parseParams(BUILTIN_MODULES.find((m) => m.id === 'tr-scalein')!.code);
assert.equal(si.find((d) => d.name === 'fadeIn')?.none, 1, '縮放推入的淡入可以選「無」');
console.log('PASS curve 的「無」');
