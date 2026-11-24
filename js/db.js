// Thin promise wrapper around IndexedDB. One object store per record type,
// plus a key/value "meta" store for settings and sync state.

const DB_NAME = 'time-tracker';
const DB_VERSION = 2; // 2: planned tasks
export const STORES = ['projects', 'tasks', 'entries', 'plans'];
/** Stores every snapshot must have; newer ones are optional so older backups still load. */
export const CORE_STORES = ['projects', 'tasks', 'entries'];

let dbPromise;

function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
    };
    req.onsuccess = () => {
      // A newer version of the app opened in another tab: let it upgrade, then reload.
      req.result.onversionchange = () => { req.result.close(); location.reload(); };
      resolve(req.result);
    };
    req.onerror = () => reject(new Error('Could not open the database', { cause: req.error }));
  });
  return dbPromise;
}

const settle = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

const done = (tx) =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });

export async function getAll(store) {
  const db = await open();
  return settle(db.transaction(store).objectStore(store).getAll());
}

export async function putMany(store, records) {
  const db = await open();
  const tx = db.transaction(store, 'readwrite');
  const os = tx.objectStore(store);
  for (const r of records) os.put(r);
  await done(tx);
}

export const put = (store, record) => putMany(store, [record]);

export async function getMeta(key) {
  const db = await open();
  return settle(db.transaction('meta').objectStore('meta').get(key));
}

export async function setMeta(key, value) {
  const db = await open();
  const tx = db.transaction('meta', 'readwrite');
  tx.objectStore('meta').put(value, key);
  await done(tx);
}
