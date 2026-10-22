/**
 * Opt-in "remember on this device" key storage. IndexedDB under the extension origin is
 * reachable only from extension pages; chrome.storage.local would also expose it to content scripts.
 * Not encrypted: the options page says so.
 */
const DB = 'slopmachine';
const STORE = 'secrets';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = op(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export const secretGet = (key: string): Promise<unknown> => run('readonly', (s) => s.get(key));
export const secretSet = (key: string, value: string): Promise<IDBValidKey> => run('readwrite', (s) => s.put(value, key));
export const secretDelete = (key: string): Promise<undefined> => run('readwrite', (s) => s.delete(key));
