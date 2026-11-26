/**
 * 這個網站在瀏覽器裡用掉的空間（設定 → 專案 → 儲存空間）：
 * 依 IndexedDB 資料庫 / store 逐筆加總大小（Blob、ArrayBuffer 用實際大小，其他約略估算），加上 localStorage。
 */
import { $t } from '../i18n';

export interface UsagePart { label: string; bytes: number }
export interface Usage { parts: UsagePart[]; used: number | null; quota: number | null }

/** [資料庫, store（沒有 = 整個資料庫）, 名稱] */
const PARTS: [string, string | null, () => string][] = [
  ['ybeat', 'media', () => $t('素材檔案')],
  ['ybeat', 'proxy', () => $t('預覽代理檔')],
  ['ybeat', 'project', () => $t('專案')],
  ['ybeat-matte', null, () => $t('去背')],
  ['ybeat-face', null, () => $t('臉部追蹤')],
  ['ybeat-track', null, () => $t('物件追蹤')],
  ['ybeat-analysis', null, () => $t('自動剪輯分析')],
];

/** 值大概佔多少 byte */
function sizeOf(v: unknown, depth = 0): number {
  if (v == null) return 0;
  if (typeof v === 'string') return v.length * 2;
  if (typeof v === 'number' || typeof v === 'boolean') return 8;
  if (v instanceof Blob) return v.size;
  if (v instanceof ArrayBuffer) return v.byteLength;
  if (ArrayBuffer.isView(v)) return v.byteLength;
  if (depth > 8) return 0;
  if (v instanceof Map) { let n = 0; for (const [k, x] of v) n += sizeOf(k, depth + 1) + sizeOf(x, depth + 1); return n; }
  if (Array.isArray(v)) return v.reduce((s: number, x) => s + sizeOf(x, depth + 1), 0);
  if (typeof v === 'object') { let n = 0; for (const [k, x] of Object.entries(v)) n += k.length * 2 + sizeOf(x, depth + 1); return n; }
  return 0;
}

function openDb(name: string): Promise<IDBDatabase | null> {
  return new Promise((res) => {
    const r = indexedDB.open(name);
    // 還沒建立過的資料庫：不要順手建一個空的
    r.onupgradeneeded = () => { r.transaction?.abort(); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => res(null);
  });
}

function storeSize(d: IDBDatabase, store: string): Promise<number> {
  return new Promise((res) => {
    let n = 0;
    const req = d.transaction(store, 'readonly').objectStore(store).openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return res(n);
      n += sizeOf(c.key) + sizeOf(c.value);
      c.continue();
    };
    req.onerror = () => res(n);
  });
}

export async function measureUsage(): Promise<Usage> {
  const parts: UsagePart[] = [];
  for (const [dbName, store, label] of PARTS) {
    const d = await openDb(dbName);
    let bytes = 0;
    if (d) {
      const stores = store ? (d.objectStoreNames.contains(store) ? [store] : []) : [...d.objectStoreNames];
      for (const s of stores) bytes += await storeSize(d, s);
      d.close();
    }
    parts.push({ label: label(), bytes });
  }
  let ls = 0;
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)!;
    ls += (k.length + (localStorage.getItem(k)?.length ?? 0)) * 2;
  }
  parts.push({ label: $t('設定與自訂'), bytes: ls });
  const est = await navigator.storage?.estimate?.().catch(() => null);
  return { parts, used: est?.usage ?? null, quota: est?.quota ?? null };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}

/** 快取裡每筆屬於哪些素材：[資料庫, store, key → 素材 id] */
const CACHES: [string, string, (key: string) => string[]][] = [
  ['ybeat-matte', 'frames', (k) => [k]],
  ['ybeat-face', 'tracks', (k) => [k]],
  ['ybeat-track', 'tracks', (k) => [k.split('|')[0]]],
  ['ybeat-analysis', 'media', (k) => [k.split('|')[0]]],
  ['ybeat-analysis', 'meta', (k) => [k.split('|')[0]]],
  ['ybeat-analysis', 'music', (k) => [k.split(':')[0]]],
  // directionKey = 「id,id@片段,…|段落|指示」
  ['ybeat-analysis', 'director', (k) => k.split('|')[0].split(',').map((x) => x.split('@')[0])],
];

/** 刪掉不屬於目前專案素材的快取（去背、追蹤、自動剪輯分析）：開專案、開新專案、匯入專案包後呼叫 */
export async function pruneCaches(keep: Set<string>): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  for (const dbName of new Set(CACHES.map(([n]) => n))) {
    const d = await openDb(dbName);
    if (!d) continue;
    for (const [, store, ids] of CACHES.filter(([n]) => n === dbName)) {
      if (!d.objectStoreNames.contains(store)) continue;
      await new Promise<void>((res) => {
        const tx = d.transaction(store, 'readwrite');
        const req = tx.objectStore(store).openKeyCursor();
        req.onsuccess = () => {
          const c = req.result;
          if (!c) return;
          if (ids(String(c.primaryKey)).some((id) => !keep.has(id))) tx.objectStore(store).delete(c.primaryKey);
          c.continue();
        };
        tx.oncomplete = tx.onerror = tx.onabort = () => res();
      });
    }
    d.close();
  }
}

/** 清掉這個網站的所有資料（專案、素材、快取、設定），然後重新載入 */
export async function wipeAllData(): Promise<void> {
  // 開著的連線會擋住 deleteDatabase：改成把每個 store 清空
  const names = (await indexedDB.databases?.().catch(() => []) ?? []).map((x) => x.name).filter((x): x is string => !!x);
  for (const name of new Set([...names, ...PARTS.map(([n]) => n)])) {
    const d = await openDb(name);
    if (!d) continue;
    const stores = [...d.objectStoreNames];
    if (stores.length) {
      await new Promise<void>((res) => {
        const tx = d.transaction(stores, 'readwrite');
        for (const s of stores) tx.objectStore(s).clear();
        tx.oncomplete = tx.onerror = tx.onabort = () => res();
      });
    }
    d.close();
  }
  if ('caches' in window) for (const k of await caches.keys().catch(() => [])) await caches.delete(k).catch(() => {});
  localStorage.clear();
  sessionStorage.clear();
  // 關掉前別人（版面、時間軸位置）還會寫一次：最後再清一次
  window.addEventListener('pagehide', () => localStorage.clear());
  location.reload();
}
