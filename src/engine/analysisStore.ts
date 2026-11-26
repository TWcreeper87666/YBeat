/**
 * 自動剪輯分析結果存在瀏覽器（IndexedDB `ybeat-analysis`），重新整理不用重算。
 * - media：素材分析（key = 素材 id|起點|長度）；總量超過 MEDIA_LIMIT 就刪最久沒用的
 * - director：AI 導演的分配結果（key = directionKey）
 * - music：音樂分析（key = 素材 id:第一拍:拍數）
 * 每筆記版本，分析方式改了就把 STORE_VERSION +1，讀到舊版本直接丟掉重算。
 */
const STORE_VERSION = 1;
const MEDIA_LIMIT = 200 * 1024 * 1024;
type StoreName = 'media' | 'meta' | 'director' | 'music';

let dbp: Promise<IDBDatabase> | null = null;
function db() {
  dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open('ybeat-analysis', 1);
    r.onupgradeneeded = () => {
      for (const n of ['media', 'meta', 'director', 'music']) r.result.createObjectStore(n);
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function idb<T>(store: StoreName, mode: IDBTransactionMode, fn: (os: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((res, rej) => {
    const req = fn(d.transaction(store, mode).objectStore(store));
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

const hasIdb = () => typeof indexedDB !== 'undefined';

/** 讀一筆（版本不對 = 刪掉、當沒有）；讀不到 / 出錯都回 undefined */
export async function loadAnalysis<T>(store: 'media' | 'director' | 'music', key: string): Promise<T | undefined> {
  if (!hasIdb()) return undefined;
  try {
    const rec = await idb<{ v: number; data: T } | undefined>(store, 'readonly', (os) => os.get(key));
    if (!rec) return undefined;
    if (rec.v !== STORE_VERSION) {
      void dropKey(store, key);
      return undefined;
    }
    if (store === 'media') void idb('meta', 'readwrite', (os) => os.get(key)).then((m) => m && idb('meta', 'readwrite', (os) => os.put({ ...(m as Meta), at: Date.now() }, key))).catch(() => {});
    return rec.data;
  } catch {
    return undefined;
  }
}

interface Meta { at: number; bytes: number }

/** 存一筆；media 另外記大小，超過上限刪最久沒用的 */
export async function saveAnalysis(store: 'media' | 'director' | 'music', key: string, data: unknown, bytes = 0): Promise<void> {
  if (!hasIdb()) return;
  try {
    await idb(store, 'readwrite', (os) => os.put({ v: STORE_VERSION, data }, key));
    if (store !== 'media') return;
    await idb('meta', 'readwrite', (os) => os.put({ at: Date.now(), bytes } satisfies Meta, key));
    await trim();
  } catch (e) {
    console.warn('analysis save failed', e);
  }
}

async function trim() {
  const d = await db();
  const all = await new Promise<[string, Meta][]>((res, rej) => {
    const out: [string, Meta][] = [];
    const req = d.transaction('meta', 'readonly').objectStore('meta').openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return res(out);
      out.push([String(c.key), c.value as Meta]);
      c.continue();
    };
    req.onerror = () => rej(req.error);
  });
  let total = all.reduce((s, [, m]) => s + m.bytes, 0);
  if (total <= MEDIA_LIMIT) return;
  all.sort((a, b) => a[1].at - b[1].at);
  for (const [k, m] of all) {
    if (total <= MEDIA_LIMIT * 0.8) break;
    await dropKey('media', k);
    total -= m.bytes;
  }
}

async function dropKey(store: StoreName, key: string) {
  await idb(store, 'readwrite', (os) => os.delete(key)).catch(() => {});
  if (store === 'media') await idb('meta', 'readwrite', (os) => os.delete(key)).catch(() => {});
}

/** 素材被刪除：清掉它的素材分析（整支和所有指定片段） */
export function dropMediaAnalysis(mediaId: string) {
  if (!hasIdb()) return;
  const range = IDBKeyRange.bound(`${mediaId}|`, `${mediaId}|￿`);
  void idb('media', 'readwrite', (os) => os.delete(range)).catch(() => {});
  void idb('meta', 'readwrite', (os) => os.delete(range)).catch(() => {});
}
