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
          const record = { mode, ops, aborted: false };
          log.transactions.push(record);
          // Mutations apply at once and roll back on abort, like a transaction.
          const before = new Map(rows);
          let pendingRequests = 0;
          const tracked = (result) => {
            pendingRequests += 1;
            const value = request(result);
            const settle = () => {
              pendingRequests -= 1;
              if (pendingRequests === 0) later(finish);
            };
            later(() => later(settle));
            return value;
          };
          const transaction = {
            abort() {
              record.aborted = true;
              rows.clear();
              for (const [name, entry] of before) rows.set(name, entry);
              later(() => transaction.onabort?.());
            },
            objectStore: () => ({
              getAll: () => (ops.push("getAll"), tracked(() => [...rows.values()])),
              getAllKeys: () => (ops.push("getAllKeys"), tracked(() => [...rows.keys()])),
              get: (name) => (ops.push(["get", name]), tracked(() => rows.get(name))),
              put: (entry) => {
                ops.push("put");
                if (entry.uncloneable) throw new Error("DataCloneError");
                rows.set(entry.key, entry);
              },
              delete: (key) => (ops.push("delete"), rows.delete(key)),
              clear: () => (ops.push("clear"), rows.clear()),
            }),
          };
          let finished = false;
          const finish = () => {
            if (finished || record.aborted || pendingRequests > 0) return;
            finished = true;
            transaction.oncomplete?.();
          };
          later(() => later(finish));
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

test("a synchronous throw in a write aborts so no partial put commits", async () => {
  const { factory, rows, log } = fakeIndexedDB();
  const store = openChatCacheStore(factory);
  await store.write({ puts: [{ key: "kept" }] });
  await assert.rejects(
    store.write({ puts: [{ key: "a" }, { key: "b", uncloneable: true }] }),
    /DataCloneError/,
  );
  assert.equal(log.transactions.at(-1).aborted, true);
  assert.deepEqual([...rows.keys()], ["kept"]);
});

test("an evicting write reads keys, only unknown values, then commits once", async () => {
  const { factory, rows, log } = fakeIndexedDB();
  const store = openChatCacheStore(factory);
  await store.write({ puts: [{ key: "mine" }, { key: "foreign", size: 9 }] });
  log.transactions.length = 0;
  let seen;
  await store.write({
    puts: [{ key: "new" }],
    evict: {
      read: (keys) => keys.filter((name) => name !== "mine"),
      decide: (keys, values) => {
        seen = { keys: [...keys], values: [...values] };
        return ["foreign"];
      },
    },
  });
  assert.equal(log.transactions.length, 1);
  assert.deepEqual(log.transactions[0].ops, [
    "getAllKeys",
    ["get", "foreign"],
    "put",
    "delete",
  ]);
  assert.deepEqual(seen.keys, ["mine", "foreign"]);
  assert.deepEqual(seen.values, [["foreign", { key: "foreign", size: 9 }]]);
  assert.deepEqual([...rows.keys()].sort(), ["mine", "new"]);
});

test("a throw while deciding evictions aborts the whole write", async () => {
  const { factory, rows, log } = fakeIndexedDB();
  const store = openChatCacheStore(factory);
  await assert.rejects(
    store.write({
      puts: [{ key: "a" }],
      evict: {
        read: () => [],
        decide: () => {
          throw new Error("boom");
        },
      },
    }),
    /boom/,
  );
  assert.equal(log.transactions.at(-1).aborted, true);
  assert.equal(rows.size, 0);
});

test("no IndexedDB means no adapter", () => {
  assert.equal(openChatCacheStore(null), null);
});
