/**
 * `.ybeat` 專案包容器（version 2）
 *
 *   [0..8)   標記 'YBEAT2\0\0'
 *   [8..16)  清單長度（UTF-8 bytes，u64 little-endian）
 *   [16..)   清單 JSON
 *   之後     資料區：不重複素材的原始 bytes 串接，位移相對資料區起點
 *
 * 只處理容器本身（不碰 store / IndexedDB），方便測試。
 */

export const PACK_MAGIC = 'YBEAT2\0\0';
export const PACK_HEADER = 16;
/** 清單上限：只有中繼資料（含影片縮圖 data URL），超過視為損壞 */
export const PACK_MAX_MANIFEST = 256 * 1024 * 1024;
const CHUNK = 4 * 1024 * 1024;

export interface PackAsset { type: string; offset: number; size: number; sha256: string }
export interface PackManifest<P = unknown> {
  type: 'ybeat-project';
  version: 2;
  project: P;
  /** mediaId → assets 的 key */
  mediaAssets: Record<string, string>;
  assets: Record<string, PackAsset>;
}
export type PackProgress = (done: number, total: number) => void;

// ───────────── SHA-256（分塊計算，不用一次讀進整個檔案） ─────────────

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export class Sha256 {
  private h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  private w = new Uint32Array(64);
  private buf = new Uint8Array(64);
  private bufLen = 0;
  private total = 0;

  private block(d: Uint8Array, p: number) {
    const w = this.w;
    for (let i = 0; i < 16; i++, p += 4) w[i] = (d[p] << 24) | (d[p + 1] << 16) | (d[p + 2] << 8) | d[p + 3];
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15], b = w[i - 2];
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    const h = this.h;
    let a = h[0], b = h[1], c = h[2], e = h[4], f = h[5], g = h[6], hh = h[7], dd = h[3];
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (hh + S1 + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      hh = g; g = f; f = e; e = (dd + t1) | 0; dd = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += dd; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }

  update(data: Uint8Array): this {
    let p = 0;
    const n = data.length;
    this.total += n;
    if (this.bufLen) {
      const take = Math.min(64 - this.bufLen, n);
      this.buf.set(data.subarray(0, take), this.bufLen);
      this.bufLen += take;
      p = take;
      if (this.bufLen < 64) return this;
      this.block(this.buf, 0);
      this.bufLen = 0;
    }
    for (; p + 64 <= n; p += 64) this.block(data, p);
    if (p < n) { this.buf.set(data.subarray(p), 0); this.bufLen = n - p; }
    return this;
  }

  hex(): string {
    const bits = this.total * 8;
    const pad = new Uint8Array((this.bufLen < 56 ? 64 : 128) - this.bufLen);
    pad[0] = 0x80;
    const v = new DataView(pad.buffer);
    v.setUint32(pad.length - 8, Math.floor(bits / 0x100000000));
    v.setUint32(pad.length - 4, bits >>> 0);
    this.update(pad);
    return Array.from(this.h, (x) => x.toString(16).padStart(8, '0')).join('');
  }
}

/** 分塊讀取 Blob 計算 SHA-256（hex） */
export async function sha256Blob(blob: Blob): Promise<string> {
  const s = new Sha256();
  for (let i = 0; i < blob.size; i += CHUNK) s.update(new Uint8Array(await blob.slice(i, Math.min(i + CHUNK, blob.size)).arrayBuffer()));
  return s.hex();
}

// ───────────── 寫入 ─────────────

/** 組出專案包：相同內容（雜湊＋長度）只放一次；用 Blob 片段串接，不複製素材內容 */
export async function writePack<P>(project: P, media: { id: string; blob: Blob }[], onProgress?: PackProgress): Promise<Blob> {
  const mediaAssets: Record<string, string> = {};
  const assets: Record<string, PackAsset> = {};
  const byContent = new Map<string, string>();
  const parts: Blob[] = [];
  let offset = 0;
  onProgress?.(0, media.length);
  for (let i = 0; i < media.length; i++) {
    const { id, blob } = media[i];
    const sha256 = await sha256Blob(blob);
    const ident = `${sha256}:${blob.size}`;
    let key = byContent.get(ident);
    if (!key) {
      key = String(byContent.size);
      byContent.set(ident, key);
      assets[key] = { type: blob.type, offset, size: blob.size, sha256 };
      parts.push(blob);
      offset += blob.size;
    }
    mediaAssets[id] = key;
    onProgress?.(i + 1, media.length);
  }
  const manifest: PackManifest<P> = { type: 'ybeat-project', version: 2, project, mediaAssets, assets };
  const json = new TextEncoder().encode(JSON.stringify(manifest));
  const head = new Uint8Array(PACK_HEADER);
  for (let i = 0; i < 8; i++) head[i] = PACK_MAGIC.charCodeAt(i);
  new DataView(head.buffer).setBigUint64(8, BigInt(json.length), true);
  return new Blob([head, json, ...parts], { type: 'application/octet-stream' });
}

// ───────────── 讀取 ─────────────

export class PackError extends Error {}
const fail = (why: string): never => { throw new PackError(why); };
const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/** 讀檔頭與清單，驗證區段與引用（還沒驗證雜湊） */
export async function readManifest(file: Blob): Promise<{ manifest: PackManifest; dataStart: number }> {
  if (file.size < PACK_HEADER) fail('header');
  const head = new Uint8Array(await file.slice(0, PACK_HEADER).arrayBuffer());
  for (let i = 0; i < 8; i++) if (head[i] !== PACK_MAGIC.charCodeAt(i)) fail('magic');
  const len64 = new DataView(head.buffer).getBigUint64(8, true);
  if (len64 > BigInt(Math.min(PACK_MAX_MANIFEST, file.size - PACK_HEADER))) fail('manifest length');
  const len = Number(len64);
  const dataStart = PACK_HEADER + len;
  let manifest: unknown;
  try {
    manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await file.slice(PACK_HEADER, dataStart).arrayBuffer()));
  } catch { fail('manifest json'); }
  if (!isObj(manifest) || manifest.type !== 'ybeat-project' || manifest.version !== 2 || !isObj(manifest.project) || !isObj(manifest.mediaAssets) || !isObj(manifest.assets)) fail('manifest fields');
  const m = manifest as unknown as PackManifest;
  const dataSize = file.size - dataStart;
  const ranges: [number, number][] = [];
  for (const key of Object.keys(m.assets)) {
    const a = m.assets[key] as unknown;
    if (!isObj(a) || typeof a.type !== 'string' || !isCount(a.offset) || !isCount(a.size) || typeof a.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(a.sha256)) fail(`asset ${key}`);
    const { offset, size } = a as unknown as PackAsset;
    if (offset > dataSize || size > dataSize - offset) fail(`asset ${key} range`);
    if (size) ranges.push([offset, offset + size]);
  }
  ranges.sort((x, y) => x[0] - y[0]);
  for (let i = 1; i < ranges.length; i++) if (ranges[i][0] < ranges[i - 1][1]) fail('asset overlap');
  for (const id of Object.keys(m.mediaAssets)) {
    const key = m.mediaAssets[id];
    if (typeof key !== 'string' || !own(m.assets, key)) fail(`media ${id}`);
  }
  return { manifest: m, dataStart };
}

/** 讀出整包：每個素材驗證雜湊後才回傳（mediaId → Blob，切片自原檔不複製） */
export async function readPack(file: Blob, onProgress?: PackProgress): Promise<{ manifest: PackManifest; blobs: Map<string, Blob> }> {
  const { manifest, dataStart } = await readManifest(file);
  const keys = Object.keys(manifest.assets);
  const byKey = new Map<string, Blob>();
  onProgress?.(0, keys.length);
  for (let i = 0; i < keys.length; i++) {
    const a = manifest.assets[keys[i]];
    const blob = file.slice(dataStart + a.offset, dataStart + a.offset + a.size, a.type);
    if (await sha256Blob(blob) !== a.sha256) fail(`asset ${keys[i]} hash`);
    byKey.set(keys[i], blob);
    onProgress?.(i + 1, keys.length);
  }
  const blobs = new Map<string, Blob>();
  for (const id of Object.keys(manifest.mediaAssets)) blobs.set(id, byKey.get(manifest.mediaAssets[id])!);
  return { manifest, blobs };
}
