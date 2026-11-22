import { strict as assert } from 'node:assert';
import { createHash, randomBytes } from 'node:crypto';
import { PACK_HEADER, PackError, Sha256, readManifest, readPack, sha256Blob, writePack } from '../src/engine/ybeatPack';

const node = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const rejects = async (p: Promise<unknown>, why: string) => {
  try { await p; } catch (e) { assert.ok(e instanceof PackError, `${why}：${e}`); return; }
  assert.fail(`${why}：應該失敗`);
};

(async () => {
// ── SHA-256：跟 node 的結果一樣，切塊方式不影響 ──
{
  for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 100_000]) {
    const d = randomBytes(n);
    assert.equal(new Sha256().update(d).hex(), node(d), `長度 ${n}`);
    const s = new Sha256();
    for (let i = 0; i < n; i += 37) s.update(d.subarray(i, i + 37));
    assert.equal(s.hex(), node(d), `分塊 ${n}`);
  }
  const big = randomBytes(9 * 1024 * 1024 + 3);
  assert.equal(await sha256Blob(new Blob([big])), node(big), '超過一塊的 Blob');
}
console.log('PASS SHA-256');

const project = { media: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }], clips: [], effects: [], audios: [], tracks: {} };
const A = randomBytes(5000), B = randomBytes(3000);
const make = () => writePack(project, [
  { id: 'a', blob: new Blob([A], { type: 'image/jpeg' }) },
  { id: 'b', blob: new Blob([B], { type: 'video/mp4' }) },
  { id: 'c', blob: new Blob([A], { type: 'image/jpeg' }) }, // 同檔案再加入一次
]);

// ── 寫入 → 讀回：原始 bytes、相同內容只存一次 ──
{
  const steps: string[] = [];
  const file = await make();
  const { manifest } = await readManifest(file);
  assert.equal(Object.keys(manifest.assets).length, 2, '重複內容只存一份');
  assert.equal(manifest.mediaAssets.a, manifest.mediaAssets.c);
  assert.equal(manifest.mediaAssets.d, undefined, '沒有 Blob 的素材不列入');
  const json = new TextEncoder().encode(JSON.stringify(manifest)).length;
  assert.equal(file.size, PACK_HEADER + json + A.length + B.length, '沒有 base64');
  const { blobs } = await readPack(file, (n, t) => steps.push(`${n}/${t}`));
  assert.deepEqual(steps, ['0/2', '1/2', '2/2']);
  assert.deepEqual(new Uint8Array(await blobs.get('a')!.arrayBuffer()), new Uint8Array(A));
  assert.deepEqual(new Uint8Array(await blobs.get('c')!.arrayBuffer()), new Uint8Array(A));
  assert.deepEqual(new Uint8Array(await blobs.get('b')!.arrayBuffer()), new Uint8Array(B));
  assert.equal(blobs.get('b')!.type, 'video/mp4');
  assert.equal(blobs.has('d'), false);
  assert.deepEqual(manifest.project, project);
}
console.log('PASS 寫入讀回');

// ── 損壞的檔案 ──
{
  const good = new Uint8Array(await (await make()).arrayBuffer());
  const len = Number(new DataView(good.buffer).getBigUint64(8, true));
  const manifest = JSON.parse(new TextDecoder().decode(good.subarray(PACK_HEADER, PACK_HEADER + len)));
  const data = good.subarray(PACK_HEADER + len);
  const rebuild = (m: unknown, body: Uint8Array = data) => {
    const j = new TextEncoder().encode(JSON.stringify(m));
    const h = new Uint8Array(PACK_HEADER);
    h.set(good.subarray(0, 8));
    new DataView(h.buffer).setBigUint64(8, BigInt(j.length), true);
    return new Blob([h, j, body]);
  };
  const edit = (f: (m: any) => void) => { const m = structuredClone(manifest); f(m); return rebuild(m); };

  await rejects(readPack(new Blob([good.subarray(0, 10)])), '太短');
  await rejects(readPack(new Blob([new TextEncoder().encode('{"type":"ybeat-project","version":1}')])), '舊的 JSON 格式');
  const huge = good.slice(); new DataView(huge.buffer).setBigUint64(8, 0xffffffffffffffffn, true);
  await rejects(readPack(new Blob([huge])), '清單長度超過檔案');
  await rejects(readPack(new Blob([good.subarray(0, PACK_HEADER + len - 1)])), '清單被截斷');
  await rejects(readPack(edit((m) => { m.version = 3; })), '版本');
  await rejects(readPack(edit((m) => { m.assets[0].size = 1e9; })), '超出檔案範圍');
  await rejects(readPack(edit((m) => { m.assets[0].offset = -1; })), '負的位移');
  await rejects(readPack(edit((m) => { m.assets[0].offset = 2 ** 60; })), '整數溢位');
  await rejects(readPack(edit((m) => { m.assets[1].offset = 10; })), '區段重疊');
  await rejects(readPack(edit((m) => { m.mediaAssets.a = '9'; })), '引用不存在的資料');
  await rejects(readPack(edit((m) => { m.mediaAssets.a = 'toString'; })), '原型上的 key');
  const flipped = data.slice(); flipped[100] ^= 1;
  await rejects(readPack(rebuild(manifest, flipped)), '雜湊不符');
  await rejects(readPack(rebuild(manifest, data.subarray(0, data.length - 1))), '資料區被截斷');
}
console.log('PASS 損壞的檔案');
})().catch((e) => { console.error(e); process.exit(1); });
