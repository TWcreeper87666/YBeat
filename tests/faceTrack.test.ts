import { strict as assert } from 'node:assert';
import { HEAD_PAD, bridgeTrack, decodeYunet, findGaps, nms, padBox, pickTrack, smoothTrack, trackAt, type Face, type TrackPoint } from '../src/engine/faceTrack';

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

// ── 臉追丟的空洞：找出要補的地方 ──
{
  const P = (t: number, x = 0.5): TrackPoint => ({ t, x, y: 0.5, w: 0.1, h: 0.1 });
  // 0..2 有臉、2..5 沒有、5..8 有
  const picked = [0, 0.5, 1, 1.5, 2, 5, 5.5, 6, 7, 8].map((t) => P(t));
  const g = findGaps(picked, 0, 8);
  assert.equal(g.length, 1, '中間一個空洞');
  assert.deepEqual([g[0].from, g[0].to, g[0].dir, g[0].seed.t, g[0].end?.t], [2, 5, 1, 2, 5], '從前面那張臉往後追到後面那張');
  assert.equal(findGaps(picked, 0, 1.8).length, 0, '範圍裡沒有空洞');
  // 範圍從空洞中間開始：前面那張臉夠近 → 一樣往後追（後面那張在範圍外 = 沒有 end）
  const h = findGaps(picked, 2.5, 4);
  assert.deepEqual([h[0].from, h[0].to, h[0].dir, h[0].end], [2, 4, 1, undefined], '從範圍外的臉追進來，追到範圍結尾');
  // 前面的臉離太遠 → 從後面往前追
  const far = [P(0), P(10)];
  const b = findGaps(far, 8, 12);
  assert.deepEqual([b[0].from, b[0].to, b[0].dir, b[0].seed.t], [8, 10, -1, 10], '前面太遠：從後面那張往前追到範圍開頭');
  assert.equal(findGaps([P(0), P(30)], 10, 12).length, 0, '兩邊都太遠：不補');
  // 頭尾
  const ht = findGaps([P(3), P(3.5), P(4)], 0, 7);
  assert.deepEqual(ht.map((x) => [x.from, x.to, x.dir]), [[0, 3, -1], [4, 7, 1]], '範圍開頭往前、結尾往後');
  assert.equal(findGaps([P(0.3), P(1), P(1.6)], 0, 1.9).length, 0, '頭尾差不到半個 MAX_GAP 不用補');
  assert.equal(findGaps([], 0, 5).length, 0, '整段沒有臉：沒有起點可以追');
  console.log('PASS 找空洞');
}

// ── 把 VitTrack 補的點併進來 ──
{
  const P = (t: number, x: number): TrackPoint => ({ t, x, y: 0.5, w: 0.1, h: 0.1 });
  const picked = [P(1, 0.2), P(2, 0.2), P(5, 0.8), P(6, 0.8)];
  const [gap] = findGaps(picked, 1, 6);
  const pad = padBox(gap.seed);
  assert.ok(Math.abs(pad[2] - 0.1 * HEAD_PAD) < 1e-9, '給 VitTrack 的框放大');
  // VitTrack 追到 x = 0.75（差 0.05），框是放大過的大小
  const pts: TrackPoint[] = [];
  for (let k = 0; k <= 90; k++) {
    const t = 2 + k / 30;
    pts.push({ t, x: 0.2 + 0.55 * ((t - 2) / 3), y: 0.5, w: 0.1 * HEAD_PAD, h: 0.1 * HEAD_PAD });
  }
  const m = bridgeTrack(picked, [{ gap, pts }]);
  const mid = m.filter((p) => p.t > 2 && p.t < 5);
  assert.equal(mid.length, 89, '空洞裡的點都併進來（兩端的臉不重複）');
  assert.ok(mid.every((p) => Math.abs(p.w - 0.1) < 1e-9), '大小縮回臉的大小');
  const last = mid[mid.length - 1];
  assert.ok(Math.abs(last.x - (0.2 + 0.6 * ((last.t - 2) / 3))) < 0.01, '接縫誤差攤掉：最後接到後面那張臉');
  assert.ok(Math.abs(mid[0].x - pts[1].x) < 0.002, '起點那邊幾乎不動');
  assert.ok(trackAt(smoothTrack(m), 3.5) !== null, '空洞補起來了');
  assert.equal(trackAt(smoothTrack(picked), 3.5), null, '沒補時是 null');
  // 空洞已經不在（中間偵測到臉了）→ 不用
  assert.equal(bridgeTrack([...picked, P(3.5, 0.5)], [{ gap, pts }]).length, 5, '中間有臉了：補的點不用');
  // 追到別的東西去（離另一頭的臉太遠）→ 不修正
  const off = pts.map((p) => ({ ...p, x: 0.2 }));
  const n = bridgeTrack(picked, [{ gap, pts: off }]).filter((p) => p.t > 2 && p.t < 5);
  assert.ok(n.every((p) => Math.abs(p.x - 0.2) < 1e-9), '對不上就不修正');
  console.log('PASS 補空洞');
}
