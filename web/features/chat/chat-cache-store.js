const DATABASE = "agentpier.chat.cache.v1";
const STORE = "sessions";

function openDatabase(factory) {
  return new Promise((resolve, reject) => {
    const request = factory.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE, { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Chat cache storage blocked"));
  });
}

/**
 * IndexedDB adapter, or null when the browser has none. Every method may reject.
 * The open handle is cached; it closes on `versionchange` (another tab deletes or
 * upgrades the database) and reopens on demand.
 */
export function openChatCacheStore(factory = globalThis.indexedDB) {
  if (typeof factory === "undefined" || !factory) return null;
  let handle = null;
  let opening = null;
  const drop = (db) => {
    if (handle !== db) return;
    handle = null;
    try {
      db.close();
    } catch {
      // already closed
    }
  };
  const database = () => {
    if (handle) return Promise.resolve(handle);
    opening ??= openDatabase(factory).then(
      (db) => {
        opening = null;
        handle = db;
        db.onversionchange = () => drop(db);
        db.onclose = () => drop(db);
        return db;
      },
      (error) => {
        opening = null;
        throw error;
      },
    );
    return opening;
  };
  const begin = async (mode) => {
    const db = await database();
    try {
      return db.transaction(STORE, mode);
    } catch {
      // The cached handle closed underneath us: reopen once.
      drop(db);
      return (await database()).transaction(STORE, mode);
    }
  };
  // Runs `work(store, setResult)` in one transaction; resolves after it committed.
  const transact = async (mode, work) => {
    const transaction = await begin(mode);
    return new Promise((resolve, reject) => {
      let result;
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () =>
        reject(transaction.error || new Error("Chat cache storage aborted"));
      work(transaction.objectStore(STORE), (value) => {
        result = value;
      });
    });
  };
  const read = (method) =>
    transact("readonly", (store, done) => {
      const request = store[method]();
      request.onsuccess = () => done(request.result);
    });
  return {
    getAll: () => read("getAll"),
    getAllKeys: () => read("getAllKeys"),
    // Puts and deletes commit together in one readwrite transaction.
    write: ({ puts = [], deletes = [] }) =>
      transact("readwrite", (store) => {
        for (const entry of puts) store.put(entry);
        for (const key of deletes) store.delete(key);
      }),
    clear: () => transact("readwrite", (store) => store.clear()),
    // Closes the cached handle so a deleteDatabase is not blocked by this tab.
    close: () => {
      opening = null;
      if (handle) drop(handle);
    },
  };
}
