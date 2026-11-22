import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as ort from 'onnxruntime-web';
import { HANN, SEARCH, TEMPLATE, clipBox, cropBlob, cropRegion, decodeVit, fromPx, toPx, type PxBox } from '../src/engine/vitTrack';

// ── 純計算 ──
assert.deepEqual(cropRegion({ x: 10, y: 20, w: 40, h: 10 }, 2), { size: 40, x0: 10, y0: 5 }, '裁切 = 以框中心為中心、邊長 sqrt(w×h)×2');
assert.ok(Math.abs(HANN[0] - HANN[255]) < 1e-6 && HANN[7 * 16 + 7] > 0.9, 'Hann 窗對稱、中間最大');
assert.deepEqual(clipBox({ x: -5, y: 95, w: 20, h: 20 }, 100, 100, 10), { x: 0, y: 90, w: 15, h: 10 }, '框限制在畫面裡');
assert.deepEqual(fromPx(toPx([0.5, 0.25, 0.2, 0.1], 200, 100), 200, 100), [0.5, 0.25, 0.2, 0.1]);
{
  // 全黑畫面：每個值都是 −mean/std；BGR → 第 0 個通道配 0.485 / 0.229
  const { blob } = cropBlob(new Uint8ClampedArray(4 * 4 * 4), 4, 4, { x: 1, y: 1, w: 2, h: 2 }, 2, 8);
  assert.ok(Math.abs(blob[0] - -0.485 / 0.229) < 1e-5 && Math.abs(blob[2 * 64] - -0.406 / 0.225) < 1e-5);
}
{
  // 分數圖正中最大、偏移 0.5、大小 = 裁切的 1/4 → 框不動
  const conf = new Float32Array(256), size = new Float32Array(512), off = new Float32Array(512);
  conf[8 * 16 + 8] = 1;
  off.fill(0);
  size.fill(0.25);
  const prev: PxBox = { x: 100, y: 100, w: 40, h: 40 };
  const r = decodeVit(conf, size, off, prev, cropRegion(prev, 4).size, 640, 360);
  assert.ok(Math.abs(r.box.x - 100) < 1e-6 && Math.abs(r.box.w - 40) < 1e-6, '中心不動');
}
console.log('PASS VitTrack 前後處理');

// ── 實際跑模型：雜訊背景上一個有花紋的方塊往右下移動 ──
const W = 320, H = 180;
const rand = (() => { let s = 1; return () => ((s = (s * 1103515245 + 12345) >>> 0) / 2 ** 32); })();
const bg = new Uint8ClampedArray(W * H * 4).map((_, i) => (i % 4 === 3 ? 255 : 60 + rand() * 60));
const frame = (ox: number, oy: number) => {
  const f = bg.slice();
  for (let y = 0; y < 30; y++) for (let x = 0; x < 30; x++) {
    const i = ((oy + y) * W + ox + x) * 4;
    const check = ((x >> 3) + (y >> 3)) & 1;
    f[i] = check ? 240 : 200; f[i + 1] = check ? 40 : 200; f[i + 2] = check ? 40 : 30;
  }
  return f;
};
void (async () => {
const s = await ort.InferenceSession.create(new Uint8Array(readFileSync('public/models/object_tracking_vittrack_2023sep.onnx')));
let box: PxBox = { x: 40, y: 30, w: 30, h: 30 };
const tpl = new ort.Tensor('float32', cropBlob(frame(40, 30), W, H, box, 2, TEMPLATE).blob, [1, 3, TEMPLATE, TEMPLATE]);
for (let k = 1; k <= 20; k++) {
  const ox = 40 + k * 6, oy = 30 + k * 3;
  const img = frame(ox, oy);
  const { blob, size } = cropBlob(img, W, H, box, 4, SEARCH);
  const r = await s.run({ template: tpl, search: new ort.Tensor('float32', blob, [1, 3, SEARCH, SEARCH]) });
  const out = decodeVit(r.output1.data as Float32Array, r.output2.data as Float32Array, r.output3.data as Float32Array, box, size, W, H);
  assert.ok(out.score > 0.2, `第 ${k} 格有追到（分數 ${out.score.toFixed(2)}）`);
  box = out.box;
  const err = Math.hypot(box.x + box.w / 2 - (ox + 15), box.y + box.h / 2 - (oy + 15));
  assert.ok(err < 6, `第 ${k} 格中心誤差 ${err.toFixed(1)}px`);
}
console.log('PASS VitTrack 實際追蹤移動的方塊');
})().catch((e) => { console.error(e); process.exit(1); });
