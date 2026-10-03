const DATABASE = "agentpier.chat.cache.v1";
const STORE = "sessions";

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE, { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Chat cache storage blocked"));
  });
}

// Runs `work(store, setResult)` in one transaction; resolves after it committed.
async function transact(mode, work) {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      let result;
      work(transaction.objectStore(STORE), (value) => {
        result = value;
      });
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () =>
        reject(transaction.error || new Error("Chat cache storage aborted"));
    });
  } finally {
    db.close();
  }
}

/** IndexedDB adapter, or null when the browser has none. Every method may reject. */
export function openChatCacheStore() {
  if (typeof indexedDB === "undefined" || !indexedDB) return null;
  return {
    getAll: () =>
      transact("readonly", (store, done) => {
        const request = store.getAll();
        request.onsuccess = () => done(request.result);
      }),
    put: (entry) => transact("readwrite", (store) => store.put(entry)),
    delete: (key) => transact("readwrite", (store) => store.delete(key)),
    clear: () => transact("readwrite", (store) => store.clear()),
    // Keeps at most maxEntries and maxSize bytes, dropping the least recently used.
    evict: ({ maxEntries, maxSize }) =>
      transact("readwrite", (store) => {
        const request = store.getAll();
        request.onsuccess = () => {
          const entries = request.result.sort(
            (a, b) => (a.accessedAt || 0) - (b.accessedAt || 0),
          );
          let total = entries.reduce((sum, entry) => sum + (entry.size || 0), 0);
          let count = entries.length;
          for (const entry of entries) {
            if (count <= maxEntries && total <= maxSize) break;
            store.delete(entry.key);
            count -= 1;
            total -= entry.size || 0;
          }
        };
      }),
  };
}
