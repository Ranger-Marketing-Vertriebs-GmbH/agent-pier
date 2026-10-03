import assert from "node:assert/strict";
import test from "node:test";
import { openChatCacheStore } from "../../web/features/chat/chat-cache-store.js";

// Minimal IndexedDB stand-in: records opens, transactions and request methods.
function fakeIndexedDB() {
  const rows = new Map();
  const log = { opens: 0, transactions: [], closed: 0 };
  const databases = [];
  const later = (fn) => setImmediate(fn);
  const request = (result) => {
    const value = {};
    later(() => {
      value.result = result();
      value.onsuccess?.();
    });
    return value;
  };
  const factory = {
    open() {
      log.opens += 1;
      const db = {
        closed: false,
        close() {
          if (!db.closed) log.closed += 1;
          db.closed = true;
        },
        transaction(_store, mode) {
          if (db.closed) throw new Error("InvalidStateError");
          const ops = [];
          log.transactions.push({ mode, ops });
          const transaction = {
            objectStore: () => ({
              getAll: () => (ops.push("getAll"), request(() => [...rows.values()])),
              getAllKeys: () => (ops.push("getAllKeys"), request(() => [...rows.keys()])),
              put: (entry) => (ops.push("put"), rows.set(entry.key, entry)),
              delete: (key) => (ops.push("delete"), rows.delete(key)),
              clear: () => (ops.push("clear"), rows.clear()),
            }),
          };
          later(() => later(() => transaction.oncomplete?.()));
          return transaction;
        },
      };
      databases.push(db);
      const open = { result: db };
      later(() => open.onsuccess?.());
      return open;
    },
  };
  return { factory, rows, log, databases };
}

test("the open handle is cached across operations", async () => {
  const { factory, log } = fakeIndexedDB();
  const store = openChatCacheStore(factory);
  await store.write({ puts: [{ key: "a" }] });
  await store.getAllKeys();
  await store.getAll();
  assert.equal(log.opens, 1);
});

test("a write commits puts and deletes in one readwrite transaction", async () => {
  const { factory, rows, log } = fakeIndexedDB();
  const store = openChatCacheStore(factory);
  await store.write({ puts: [{ key: "old" }] });
  log.transactions.length = 0;
  await store.write({
    puts: [{ key: "a" }, { key: "b" }, { key: "c" }],
    deletes: ["old"],
  });
  assert.equal(log.transactions.length, 1);
  assert.equal(log.transactions[0].mode, "readwrite");
  assert.deepEqual(log.transactions[0].ops, ["put", "put", "put", "delete"]);
  assert.deepEqual([...rows.keys()], ["a", "b", "c"]);
});

test("versionchange closes the handle and the next operation reopens", async () => {
  const { factory, log, databases } = fakeIndexedDB();
  const store = openChatCacheStore(factory);
  await store.getAllKeys();
  databases[0].onversionchange();
  assert.equal(databases[0].closed, true);
  await store.getAllKeys();
  assert.equal(log.opens, 2);
});

test("close releases the cached handle", async () => {
  const { factory, log, databases } = fakeIndexedDB();
  const store = openChatCacheStore(factory);
  await store.clear();
  store.close();
  assert.equal(databases[0].closed, true);
  assert.equal(log.closed, 1);
  await store.getAllKeys();
  assert.equal(log.opens, 2);
});

test("no IndexedDB means no adapter", () => {
  assert.equal(openChatCacheStore(null), null);
});
