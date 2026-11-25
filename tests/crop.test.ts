import { strict as assert } from 'node:assert';
import { describe, it } from './logicHarness';
import { clipTransformAt, cropClip, cropView, DEFAULT_TRANSFORM, fitSize, intoCrop, outOfCrop, type Crop, type Transform } from '../src/engine/transform';
import { cropSampled } from '../src/engine/autoEditApply';
import { newKey } from '../src/engine/keyframes';

/** 跟 clip shader 一樣：素材 uv（0..1，y 向下）→ 畫面座標（-0.5..0.5，x 以寬、y 以高為 1） */
function toScreen(uv: [number, number], xf: Transform, srcAspect: number, A: number): [number, number] {
  const [fw, fh] = fitSize(true, srcAspect, A);
  return [((uv[0] - 0.5) * fw * xf.scaleX) / A + xf.x, (uv[1] - 0.5) * fh * xf.scaleY + xf.y];
}
const near = (a: number, b: number, m: string) => assert.ok(Math.abs(a - b) < 1e-9, `${m}: ${a} vs ${b}`);

describe('裁切 → 放大位移', () => {
  it('框跟畫面同比例：框的四角剛好是畫面四角', () => {
    const src = 16 / 9, A = 9 / 16;
    // 16:9 素材裡切一塊 9:16 的框
    const c: Crop = { x: 0.6, y: 0.1, w: (0.8 * 9 / 16) / src, h: 0.8 };
    const v = cropView(c, src, A);
    const xf = { ...DEFAULT_TRANSFORM, scaleX: v.s, scaleY: v.s, x: v.x, y: v.y };
    const tl = toScreen([c.x, c.y], xf, src, A), br = toScreen([c.x + c.w, c.y + c.h], xf, src, A);
    near(tl[0], -0.5, '左'); near(tl[1], -0.5, '上'); near(br[0], 0.5, '右'); near(br[1], 0.5, '下');
  });
  it('框比畫面寬：上下貼齊、左右超出（cover）', () => {
    const c: Crop = { x: 0.1, y: 0.2, w: 0.5, h: 0.3 };
    const v = cropView(c, 16 / 9, 9 / 16);
    const xf = { ...DEFAULT_TRANSFORM, scaleX: v.s, scaleY: v.s, x: v.x, y: v.y };
    const tl = toScreen([c.x, c.y], xf, 16 / 9, 9 / 16), br = toScreen([c.x + c.w, c.y + c.h], xf, 16 / 9, 9 / 16);
    near(tl[1], -0.5, '上'); near(br[1], 0.5, '下');
    assert.ok(tl[0] < -0.5 && br[0] > 0.5);
    near((tl[0] + br[0]) / 2, 0, '水平置中');
  });
  it('運鏡關鍵影格：對裁切後畫面的推近，換算後框的中心照樣在畫面中心、放大倍率相乘', () => {
    const c: Crop = { x: 0.2, y: 0.1, w: 0.4, h: 0.5 };
    const lin = [0, 0, 1, 1] as [number, number, number, number];
    const clip = { transform: { ...DEFAULT_TRANSFORM }, keys: { scaleX: [newKey(0, 1, lin), newKey(2, 1.2, lin)], scaleY: [newKey(0, 1, lin), newKey(2, 1.2, lin)] } };
    const out = cropClip(clip, c, 16 / 9, 9 / 16);
    const v = cropView(c, 16 / 9, 9 / 16);
    for (const t of [0, 2]) {
      const xf = clipTransformAt(out, t);
      const k = t ? 1.2 : 1;
      near(xf.scaleX, v.s * k, `縮放 t=${t}`);
      const center = toScreen([c.x + c.w / 2, c.y + c.h / 2], xf, 16 / 9, 9 / 16);
      near(center[0], 0, `中心 x t=${t}`); near(center[1], 0, `中心 y t=${t}`);
    }
  });
  it('沒有動畫：寫進固定變換', () => {
    const out = cropClip({ transform: { ...DEFAULT_TRANSFORM } }, { x: 0, y: 0, w: 0.5, h: 0.5 }, 1, 1);
    near(out.transform.scaleX, 2, '放大兩倍');
    near(out.transform.x, 0.5, 'x'); near(out.transform.y, 0.5, 'y');
  });
});

describe('裁切 → 分析結果', () => {
  const c: Crop = { x: 0.5, y: 0, w: 0.5, h: 1 };
  it('框內的臉換成框內座標，框外的丟掉；換回來不變', () => {
    const f = { x: 0.75, y: 0.4, h: 0.2, w: 0.1 };
    const g = intoCrop(f, c)!;
    near(g.x, 0.5, 'x'); near(g.w, 0.2, 'w');
    assert.equal(intoCrop({ x: 0.2, y: 0.5, h: 0.2 }, c), null);
    const back = outOfCrop(g, c);
    near(back.x, f.x, '還原 x'); near(back.w!, f.w, '還原 w');
  });
  it('cropSampled：最大的臉改用框內的那張、人數分數跟著改', () => {
    const big = { x: 0.2, y: 0.5, h: 0.4 }, small = { x: 0.8, y: 0.5, h: 0.1 };
    const r = cropSampled({
      info: { step: 1, duration: 2, motion: [0, 0], quality: [1, 1], cuts: [], faces: [big, big], facesAt: [[big, small], null], people: [1, 1] },
      shots: [], face: big, faceList: [big, small], people: 1,
    }, c);
    near(r.info!.faces![0]!.x, 0.6, '框內那張');
    assert.equal(r.info!.faces![1], null);
    near(r.info!.people![0], 0.4, '人數分數');
    assert.equal(r.info!.people![1], 0);
    assert.equal(r.face, null);
    assert.equal(r.people, 0);
    assert.equal(r.faceList!.length, 1);
  });
});
