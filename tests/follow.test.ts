import { strict as assert } from 'node:assert';
(globalThis as any).localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
(globalThis as any).window = globalThis;
import { parseParams } from '../src/engine/params';
import { faceInFrame, followOf, mediaToFrame, withOffset } from '../src/engine/follow';
import { makeClip } from '../src/store';
import { BUILTIN_MODULES } from '../src/modules/builtin';

// ── @follow(face) ──
const defs = parseParams('// @param center: point = 0.5,0.5 "中心" @follow(face)\n// @param other: point = 0.2,0.2 "其他"\n// @param s: float = 1 (0..2) "大小" @box(center)');
const [center, other, s] = defs;
assert.equal(center.follow, 'face', '解析 @follow(face)');
assert.equal(other.follow, undefined);
assert.equal(s.box, 'center', '@box 不受影響');
assert.deepEqual(followOf(center, undefined), { target: 'face' }, '模組預設就跟隨');
assert.equal(followOf(center, { center: null }), null, '使用者關掉');
assert.equal(followOf(other, undefined), null, '沒標 = 不跟隨');
assert.deepEqual(followOf(other, { other: { target: 'face', side: 'to' } }), { target: 'face', side: 'to' }, '使用者打開');
assert.equal(followOf(s, { s: { target: 'face' } }), null, '只有 point 參數能跟隨');
assert.deepEqual(withOffset([0.5, 0.4], { target: 'face', offset: [0.1, -0.05] }), [0.6, 0.35000000000000003]);
assert.ok(BUILTIN_MODULES.filter((m) => parseParams(m.code).some((d) => d.follow)).length >= 15, '內建的縮放類模組預設跟隨');
assert.ok(!parseParams(BUILTIN_MODULES.find((m) => m.id === 'fx-kaleido')?.code ?? '').some((d) => d.follow), '萬花筒不跟隨');
console.log('PASS @follow 與設定');

// ── 素材座標 → 畫面座標（跟渲染一樣：fit、位置、縮放 / 翻轉、旋轉） ──
const near = (a: number[], b: number[], msg: string) => assert.ok(Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9, `${msg}: ${a} ≠ ${b}`);
const aspect = 9 / 16;
const media = { width: 1080, height: 1920 };
const clip = (t: Partial<ReturnType<typeof makeClip>['transform']>, fit: 'cover' | 'contain' = 'cover') => {
  const c = makeClip({ mediaId: 'm', duration: 2, fit });
  return { ...c, transform: { ...c.transform, ...t } };
};
near(mediaToFrame(clip({}), media, 0, aspect, 0.3, 0.7), [0.3, 0.7], '同比例、置中、原大小 = 一樣的座標');
near(mediaToFrame(clip({ x: 0.1, y: -0.2 }), media, 0, aspect, 0.5, 0.5), [0.6, 0.3], '位置');
near(mediaToFrame(clip({ scaleX: 2, scaleY: 2 }), media, 0, aspect, 0.75, 0.5), [1, 0.5], '放大兩倍：右邊四分之一 → 畫面右邊緣');
near(mediaToFrame(clip({ scaleX: -1 }), media, 0, aspect, 0.25, 0.5), [0.75, 0.5], '水平翻轉');
near(mediaToFrame(clip({ rotation: 90 }), media, 0, aspect, 0.5, 0.75), [0.5 - (0.25 / aspect), 0.5], '旋轉 90 度（順時針）：下方 → 左邊');
// 橫的素材放進直的畫面，完整顯示：上下留黑，素材高度只佔 aspect / (16/9)
const wide = { width: 1920, height: 1080 };
near(mediaToFrame(clip({}, 'contain'), wide, 0, aspect, 0.5, 1), [0.5, 0.5 + (aspect / (16 / 9)) / 2], '完整顯示：素材底邊');
console.log('PASS 素材座標換算');

// 片段沒開臉部追蹤：不看臉（也不會去偵測）
assert.equal(faceInFrame(makeClip({ mediaId: 'm' }), { id: 'm', kind: 'video', width: 1080, height: 1920, duration: 5 } as any, 0, new Map(), aspect), null, '沒開臉部追蹤 = null');
console.log('PASS 臉部追蹤是片段的屬性');

// ── 哪些模組可以跟隨臉部（素材庫的標記 / 分類用） ──
import { isFaceAware } from '../src/engine/params';
assert.ok(isFaceAware(BUILTIN_MODULES.find((m) => m.id === 'fx-crashzoom')!), '衝擊變焦可以跟隨');
assert.ok(isFaceAware(BUILTIN_MODULES.find((m) => m.id === 'tr-scaleout')!), '縮放推出轉場可以跟隨');
assert.ok(!isFaceAware(BUILTIN_MODULES.find((m) => m.id === 'fx-flash')!), '閃白不行');
assert.ok(!BUILTIN_MODULES.filter((m) => m.kind === 'remap').some(isFaceAware), '變速模組不算');
console.log('PASS 可以跟隨臉部的模組');
