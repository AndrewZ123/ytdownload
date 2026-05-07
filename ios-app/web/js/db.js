// ===== INDEXED DB =====
let dbInstance = null;
const dbReady = new Promise(resolve => {
  const req = indexedDB.open(DB_NAME, DB_VERSION);
  req.onupgradeneeded = e => {
    const db = e.target.result;
    if (!db.objectStoreNames.contains('songs')) {
      const s = db.createObjectStore('songs', {keyPath: 'key'});
      s.createIndex('playlist', 'playlist');
    }
    if (!db.objectStoreNames.contains('covers')) {
      db.createObjectStore('covers', {keyPath: 'key'});
    }
    if (!db.objectStoreNames.contains('liked')) {
      db.createObjectStore('liked', {keyPath: 'key'});
    }
    if (!db.objectStoreNames.contains('history')) {
      const h = db.createObjectStore('history', {keyPath: 'key'});
      h.createIndex('timestamp', 'timestamp');
    }
  };
  req.onsuccess = () => { dbInstance = req.result; resolve(); };
  req.onerror = () => { console.error('DB open failed'); resolve(); };
});

function openDB() { return dbInstance; }

function dbPut(store, data) {
  return new Promise((res, rej) => {
    const r = dbInstance.transaction(store, 'readwrite').objectStore(store).put(data);
    r.onsuccess = () => res(); r.onerror = () => rej(r.error);
  });
}

function dbGet(store, key) {
  return new Promise((res, rej) => {
    const r = dbInstance.transaction(store).objectStore(store).get(key);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}

function dbDelete(store, key) {
  return new Promise((res, rej) => {
    const r = dbInstance.transaction(store, 'readwrite').objectStore(store).delete(key);
    r.onsuccess = () => res(); r.onerror = () => rej(r.error);
  });
}

function dbGetAll(store) {
  return new Promise((res, rej) => {
    const r = dbInstance.transaction(store).objectStore(store).getAll();
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}

function dbClear(store) {
  return new Promise((res, rej) => {
    const r = dbInstance.transaction(store, 'readwrite').objectStore(store).clear();
    r.onsuccess = () => res(); r.onerror = () => rej(r.error);
  });
}

async function initDB() { await dbReady; }
