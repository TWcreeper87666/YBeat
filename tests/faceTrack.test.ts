import { strict as assert } from 'node:assert';
import { decodeYunet, nms, pickTrack, smoothTrack, trackAt, type Face } from '../src/engine/faceTrack';

// ── YuNet 解碼：64×32 的輸入，素材畫在左上角 64×32；stride 8 的第 (r=1, c=2) 格有一張臉 ──
{
  const inW = 64, inH = 32;
  const out: Record<string, Float32Array> = {};
  for (const s of [8, 16, 32]) {
    const n = (inW / s) * (inH / s);
    out[`cls_${s}`] = new Float32Array(n);
    out[`obj_${s}`] = new Float32Array(n);
    out[`bbox_${s}`] = new Float32Array(n * 4);
    out[`kps_${s}`] = new Float32Array(n * 10);
  }
  const cols = inW / 8, i = 1 * cols + 2;
  out.cls_8[i] = 0.9;
  out.obj_8[i] = 0.9;
  out.bbox_8.set([0.5, 0.5, Math.log(2), Math.log(3)], i * 4);
  const f = decodeYunet(out, inW, inH, inW, inH);
  assert.equal(f.length, 1);
  assert.ok(Math.abs(f[0].x - (2.5 * 8) / 64) < 1e-6 && Math.abs(f[0].y - (1.5 * 8) / 32) < 1e-6, '中心 = (格 + 偏移) × stride');
  assert.ok(Math.abs(f[0].w - 16 / 64) < 1e-6 && Math.abs(f[0].h - 24 / 32) < 1e-6, '寬高 = exp × stride');
  assert.ok(Math.abs(f[0].score - 0.9) < 1e-6, '分數 = sqrt(cls × obj)');
  out.obj_8[i] = 0.1;
  assert.equal(decodeYunet(out, inW, inH, inW, inH).length, 0, '分數太低不算');
  assert.throws(() => decodeYunet({}, inW, inH, inW, inH), /missing/, '輸出名稱不對要報錯');
  console.log('PASS YuNet 解碼');
}

// ── NMS ──
{
  const a: Face = { x: 0.5, y: 0.5, w: 0.2, h: 0.2, score: 0.9 };
  const b: Face = { x: 0.51, y: 0.5, w: 0.2, h: 0.2, score: 0.8 };
  const c: Face = { x: 0.1, y: 0.1, w: 0.1, h: 0.1, score: 0.7 };
  assert.deepEqual(nms([b, a, c], 0.3), [a, c], '重疊的留分數高的');
  console.log('PASS NMS');
}

// ── 挑要跟的臉、平滑、查詢 ──
{
  const big = (t: number, x: number): Face => ({ x, y: 0.4, w: 0.2, h: 0.25, score: 0.9 });
  const small = (x: number): Face => ({ x, y: 0.4, w: 0.08, h: 0.1, score: 0.9 });
  const samples = [
    { t: 0, faces: [small(0.8), big(0, 0.3)] },
    { t: 0.1, faces: [big(0.1, 0.32), small(0.8)] },
    // 小的那張變大了，但還是跟原本那個人（位置連續）
    { t: 0.2, faces: [{ ...small(0.8), w: 0.3, h: 0.3 }, big(0.2, 0.34)] },
    { t: 0.3, faces: [] },
    { t: 0.4, faces: [big(0.4, 0.38)] },
    // 跟丟超過 1 秒 → 重新挑最大的
    { t: 2.0, faces: [small(0.2), { ...small(0.7), w: 0.3, h: 0.3 }] },
  ];
  const tr = pickTrack(samples);
  assert.deepEqual(tr.map((p) => p.x), [0.3, 0.32, 0.34, 0.38, 0.7], '一直跟同一個人；跟丟後重挑最大的');

  const sm = smoothTrack(tr);
  assert.ok(sm[4].x === 0.7, '跟丟前後不混在一起平滑');
  assert.ok(sm[1].x > 0.3 && sm[1].x < 0.34, '平滑：前後加權平均');

  const at = trackAt(tr, 0.05)!;
  assert.ok(Math.abs(at.x - 0.31) < 1e-9, '中間內插');
  assert.ok(Math.abs(trackAt(tr, 0.3)!.x - 0.36) < 1e-9, '沒偵測到的那格：前後內插');
  assert.equal(trackAt(tr, 1.2), null, '跟丟的那段沒有臉');
  assert.ok(trackAt(tr, 2.3)?.x === 0.7, '最後一點之後半秒內還算');
  assert.equal(trackAt(tr, 3), null, '太久沒有點 = null');
  assert.equal(trackAt([], 0), null);
  console.log('PASS 追蹤 / 平滑 / 查詢');
}
