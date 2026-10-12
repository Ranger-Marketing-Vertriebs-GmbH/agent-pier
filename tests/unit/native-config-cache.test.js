import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigCache } from "../../server/features/extensions/native-config-cache.js";
import { readConfig } from "../../server/features/extensions/mcp-config.js";
import { configParses } from "../../server/features/extensions/config-parse.js";

function files(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-config-cache-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (name, text) => {
    const file = path.join(root, name);
    fs.writeFileSync(file, text);
    return file;
  };
  return { root, write };
}
/** Caches `text` for `file` as the cache would after a read; old enough to be trusted. */
function cache(store, file, text) {
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(file, old, old);
  store.remember(file, "claude", fs.statSync(file), { text, data: { text }, tree: null });
}
const hit = (store, file, text) =>
  store.cached(file, "claude", fs.statSync(file), () => text) !== null;

test("the least recently used entries leave when the byte budget is exceeded", (t) => {
  const { write } = files(t);
  const store = new ConfigCache({ budget: 30 });
  const [a, b, c] = ["a", "b", "c"].map((name) => write(name, name.repeat(10)));
  cache(store, a, "a".repeat(10));
  cache(store, b, "b".repeat(10));
  cache(store, c, "c".repeat(10));
  assert.equal(store.bytes, 30);
  const d = write("d", "d".repeat(10));
  cache(store, d, "d".repeat(10));
  assert.deepEqual(
    [a, b, c, d].map((file) => hit(store, file, "")),
    [false, true, true, true],
  );
  assert.equal(store.bytes, 30);
});

test("a hit makes an entry the most recently used", (t) => {
  const { write } = files(t);
  const store = new ConfigCache({ budget: 30 });
  const [a, b, c, d] = ["a", "b", "c", "d"].map((name) => write(name, name.repeat(10)));
  for (const file of [a, b, c]) cache(store, file, path.basename(file).repeat(10));
  assert.equal(hit(store, a, ""), true);
  cache(store, d, "d".repeat(10));
  assert.deepEqual(
    [a, b, c, d].map((file) => hit(store, file, "")),
    [true, false, true, true],
  );
});

test("a file larger than the budget is never cached and keeps a smaller one", (t) => {
  const { write } = files(t);
  const store = new ConfigCache({ budget: 30 });
  const small = write("small", "s".repeat(10));
  cache(store, small, "s".repeat(10));
  const large = write("large", "l".repeat(31));
  cache(store, large, "l".repeat(31));
  assert.equal(hit(store, large, ""), false);
  assert.equal(hit(store, small, ""), true);
  assert.equal(store.bytes, 10);
});

test("an over-budget file is read correctly every time, just not cached", (t) => {
  const { write } = files(t);
  // The real budget is 96 MiB; a file above it is still read up to the 64 MiB limit
  // in production, here a reduced budget plays that role.
  const store = new ConfigCache({ budget: 8 });
  const file = write("claude.json", JSON.stringify({ mcpServers: { a: {} } }));
  const before = configParses.reads;
  const first = readConfig(file, path.dirname(file), "claude", store);
  const second = readConfig(file, path.dirname(file), "claude", store);
  assert.deepEqual(first.data, { mcpServers: { a: {} } });
  assert.deepEqual(second.data, first.data);
  assert.equal(configParses.reads - before, 2);
  assert.equal(store.bytes, 0);
});

test("a same-size rewrite with the same time inside the racy window is read again", (t) => {
  const { write } = files(t);
  const store = new ConfigCache({ budget: 1024 });
  const file = write("claude.json", '{"mcpServers":{"aa":{}}}');
  const boundary = path.dirname(file);
  // A whole second, which utimes sets exactly; still within the racy window.
  const now = Math.floor(Date.now() / 1000);
  fs.utimesSync(file, now, now);
  const first = fs.statSync(file);
  assert.deepEqual(
    Object.keys(readConfig(file, boundary, "claude", store).data.mcpServers),
    ["aa"],
  );
  fs.writeFileSync(file, '{"mcpServers":{"bb":{}}}');
  fs.utimesSync(file, now, now);
  const second = fs.statSync(file);
  assert.equal(second.size, first.size);
  assert.equal(second.ino, first.ino);
  assert.equal(second.mtimeMs, first.mtimeMs);
  // Signature equal, but the entry is racy: the text is compared and differs.
  assert.deepEqual(
    Object.keys(readConfig(file, boundary, "claude", store).data.mcpServers),
    ["bb"],
  );
});
