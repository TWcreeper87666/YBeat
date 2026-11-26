/**
 * 預覽代理檔的儲存：獨立的 IndexedDB 資料庫（key = 素材 id）。
 * 全部清掉時直接刪整個資料庫，空間馬上釋放（只清 store 的話要等瀏覽器自己整理）。
 */

const DB_NAME = 'ybeat-proxy';
const STORE = 'blobs';
let dbp: Promise<IDBDatabase> | null = null;

function db() {
  dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => {
      const d = r.result;
      // 別處要刪掉這個資料庫（清除所有資料）：讓出連線，下次用到再開
      d.onversionchange = () => { d.close(); dbp = null; };
      res(d);
    };
    r.onerror = () => { dbp = null; rej(r.error); };
  });
  return dbp;
}

async function run<T>(mode: IDBTransactionMode, fn: (os: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((res, rej) => {
    const tx = d.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    if (mode === 'readonly') {
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
      return;
    }
    tx.oncomplete = () => res(req.result);
    tx.onabort = tx.onerror = () => rej(tx.error ?? req.error);
  });
}

export const saveProxyBlob = (id: string, blob: Blob) => run('readwrite', (os) => os.put(blob, id));
export const loadProxyBlob = (id: string) => run<Blob | undefined>('readonly', (os) => os.get(id));
export const deleteProxyBlob = (id: string) => run('readwrite', (os) => os.delete(id)).then(() => {}, () => {});
export const proxyBlobIds = () => run<IDBValidKey[]>('readonly', (os) => os.getAllKeys());

/** 刪掉所有代理檔：關掉連線、刪整個資料庫 */
export async function clearProxyBlobs(): Promise<void> {
  const p = dbp;
  dbp = null;
  if (p) (await p.catch(() => null))?.close();
  await new Promise<void>((res) => {
    const r = indexedDB.deleteDatabase(DB_NAME);
    r.onsuccess = r.onerror = () => res();
    // 被別的分頁擋住：它收到 versionchange 會自己關；舊版的分頁不會關，別一直等
    r.onblocked = () => setTimeout(res, 3000);
  });
}
