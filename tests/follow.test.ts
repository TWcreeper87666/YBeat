import { strict as assert } from 'node:assert';
(globalThis as any).localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
(globalThis as any).window = globalThis;
import { canFollow, fitScale, isHitFx, parseParams } from '../src/engine/params';
import { fitOf, frameRectToBox, frameToMedia, followOf, mediaToFrame, putAnchor, subjectInFrame, withOffset } from '../src/engine/follow';
import { segments, trackKey } from '../src/engine/boxTrack';
import { makeClip } from '../src/store';
import { BUILTIN_MODULES } from '../src/modules/builtin';
import { followReset } from '../src/ui/followUi';

// ── @follow ──
const defs = parseParams('// @param center: point = 0.5,0.5 "中心" @follow\n// @param other: point = 0.2,0.2 "其他"\n// @param s: float = 1 (0..2) "大小" @box(center)');
const [center, other, s] = defs;
assert.equal(center.follow, true, '解析 @follow');
assert.equal(other.follow, undefined);
assert.equal(s.box, 'center', '@box 不受影響');
assert.deepEqual(followOf(center, undefined), {}, '模組預設就跟隨');
assert.equal(followOf(center, { center: null }), null, '使用者關掉');
assert.equal(followOf(other, undefined), null, '沒標 = 不跟隨');
assert.deepEqual(followOf(other, { other: { side: 'to' } }), { side: 'to' }, '使用者打開');
assert.equal(followOf(s, { s: {} }), null, '只有 point 參數能跟隨');
assert.deepEqual(withOffset([0.5, 0.4], { offset: [0.1, -0.05] }), [0.6, 0.35000000000000003]);
assert.ok(BUILTIN_MODULES.filter((m) => parseParams(m.code).some((d) => d.follow)).length >= 15, '內建的縮放類模組預設跟隨');
assert.ok(!parseParams(BUILTIN_MODULES.find((m) => m.id === 'fx-kaleido')?.code ?? '').some((d) => d.follow), '萬花筒不跟隨');
console.log('PASS @follow 與設定');

// ── @fit：範圍跟著目標大小 ──
{
  const fd = parseParams(['// @param center: point = 0.5,0.5 "中心" @follow', '// @param size: point = 0.3,0.4 "範圍" @fit(center, k)', '// @param k: float = 1.4 (0..5) "大小"', '// @param box2: point = 0.2,0.2 "範圍2" @fit(center)'].join(String.fromCharCode(10)));
  const [c, sz, kd, b2] = fd;
  assert.deepEqual(sz.fit, { of: 'center', scale: 'k' }, '解析 @fit 與倍率參數');
  assert.deepEqual(b2.fit, { of: 'center' }, '沒有倍率參數');
  assert.equal(followOf(sz, { size: {} }), null, '範圍本身不是跟隨的點');
  assert.equal(fitOf(sz, fd, undefined), true, '點在跟隨 → 範圍跟著目標大小');
  assert.equal(fitOf(sz, fd, { center: null }), false, '點沒跟隨 → 範圍照原本的值');
  assert.equal(fitOf(c, fd, undefined), false, '一般的點不是範圍');
  assert.equal(fitScale(sz, fd, { k: 2 }, undefined, 0), 2, '倍率 = 參數的值');
  assert.equal(fitScale(sz, fd, {}, { k: [{ id: 'a', t: 0, v: 3, ease: 'linear' } as any] }, 0), 3, '倍率可以打關鍵影格');
  assert.equal(fitScale(b2, fd, {}, undefined, 0), 1, '沒有倍率參數 = 1');
  assert.equal(fitScale(sz, fd, { k: 2 }, undefined, 0, () => 4), 4, '倍率參數跟著音訊變化時用實際的值');
  void kd;
  const mo = BUILTIN_MODULES.find((m) => m.id === 'fx-mosaic');
  assert.ok(mo && !isHitFx(mo) && canFollow(mo), '馬賽克：持續特效、可以跟隨');
  const fz = BUILTIN_MODULES.find((m) => m.id === 'fx-followzoom');
  assert.ok(fz && !isHitFx(fz) && canFollow(fz) && parseParams(fz.code).some((d) => d.fit?.of === 'center'), '跟隨放大：持續、取景跟著目標大小');
  assert.deepEqual(followReset(c, { center: { offset: [0.1, 0] } })?.center, { offset: undefined }, '重設偏移');
  assert.equal(followReset(c, undefined), null, '沒調過 = 不顯示重設');
}
console.log('PASS @fit');

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

// 片段沒有追蹤：不看目標（也不會去偵測）
assert.equal(subjectInFrame(makeClip({ mediaId: 'm' }), { id: 'm', kind: 'video', width: 1080, height: 1920, duration: 5 } as any, 0, new Map(), aspect), null, '沒有追蹤 = null');
assert.equal(subjectInFrame(makeClip({ mediaId: 'm', subject: { kind: 'box', anchors: [] } }), { id: 'm', kind: 'video', width: 1080, height: 1920, duration: 5 } as any, 0, new Map(), aspect), null, '自訂目標還沒框 = null');
console.log('PASS 追蹤是片段的屬性');

// ── 畫面座標 ↔ 素材座標、框選 ──
for (const c of [clip({}), clip({ x: 0.1, y: -0.2, scaleX: 1.5, scaleY: 1.5 }), clip({ scaleX: -1, rotation: 30 }), clip({ rotation: -75 }, 'contain')]) {
  for (const m of [media, wide]) {
    const p = mediaToFrame(c, m, 0, aspect, 0.3, 0.8);
    near(frameToMedia(c, m, 0, aspect, p[0], p[1]), [0.3, 0.8], 'frameToMedia 是反函數');
  }
}
{
  const b = frameRectToBox(clip({}), media, 0, aspect, [0.6, 0.5], [0.2, 0.3])!;
  near([b[0], b[1]], [0.4, 0.4], '框的中心（對角順序不拘）');
  near([b[2], b[3]], [0.4, 0.2], '框的寬高');
  assert.equal(frameRectToBox(clip({}), media, 0, aspect, [0.5, 0.5], [0.501, 0.5]), null, '太小 = 不算');
  const big = frameRectToBox(clip({}), media, 0, aspect, [-1, -1], [2, 2])!;
  near([big[2], big[3]], [1, 1], '超出素材的部分切掉');
}
{
  const a = putAnchor([{ t: 1, box: [0.5, 0.5, 0.1, 0.1] }], { t: 0.2, box: [0.1, 0.1, 0.1, 0.1] });
  assert.deepEqual(a.map((x) => x.t), [0.2, 1], '錨點依時間排序');
  assert.deepEqual(putAnchor(a, { t: 1.01, box: [0.9, 0.9, 0.1, 0.1] }).map((x) => x.box[0]), [0.1, 0.9], '同一格附近的錨點換掉');
  // 追蹤段落：第一個錨點往前到開頭，每個錨點往後到下一個
  const seg = segments([{ t: 1, box: [0, 0, 0, 0] }, { t: 3, box: [0, 0, 0, 0] }], 0, 5);
  assert.deepEqual(seg.map((x) => [x.a.t, x.dir, +x.from.toFixed(3), +x.to.toFixed(3)]), [[1, -1, 0, 1], [1, 1, 1, 2.983], [3, 1, 3, 5]]);
  assert.deepEqual(segments([{ t: 1, box: [0, 0, 0, 0] }, { t: 3, box: [0, 0, 0, 0] }], 3.5, 5).map((x) => x.a.t), [3], '範圍外的段落不追');
  assert.notEqual(trackKey('m', a), trackKey('m', putAnchor(a, { t: 2, box: [0.3, 0.3, 0.1, 0.1] })), '錨點改了 = 另一份結果');
  assert.equal(trackKey('m', a), trackKey('m', [...a].reverse()), '錨點順序不影響');
}
console.log('PASS 框選與錨點');

// ── 哪些模組可以跟隨目標（素材庫的標記 / 分類用） ──
import { canFollow } from '../src/engine/params';
assert.ok(canFollow(BUILTIN_MODULES.find((m) => m.id === 'fx-crashzoom')!), '衝擊變焦可以跟隨');
assert.ok(canFollow(BUILTIN_MODULES.find((m) => m.id === 'tr-scaleout')!), '縮放推出轉場可以跟隨');
assert.ok(!canFollow(BUILTIN_MODULES.find((m) => m.id === 'fx-flash')!), '閃白不行');
assert.ok(!BUILTIN_MODULES.filter((m) => m.kind === 'remap').some(canFollow), '變速模組不算');
console.log('PASS 可以跟隨目標的模組');
