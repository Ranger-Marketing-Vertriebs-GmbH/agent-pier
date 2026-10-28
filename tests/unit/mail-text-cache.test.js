import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MailTextCache } from "../../server/features/mail/mail-text-cache.js";

function tempRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-text-cache-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "mail", "text-cache");
}

const account = "0b3f6a52-6f2e-4c1f-9d1a-2f4c9a7e1b01";
const other = "7c1d2e3f-4a5b-4c6d-8e7f-901a2b3c4d5e";
const fields = (uid, part = "2") => ({
  accountId: account,
  folder: "INBOX",
  uidValidity: "1700000000",
  uid,
  part,
});
// A text entry of exactly `bytes` bytes on disk.
const sized = (bytes) => ({
  text: "x".repeat(bytes - JSON.stringify({ text: "", truncated: false }).length),
  truncated: false,
});
const fileOf = (root, accountId, key) => path.join(root, accountId, `${key}.json`);
// Marks an entry as last used `secondsAgo` seconds ago.
const age = (file, secondsAgo) => {
  const at = new Date(Date.now() - secondsAgo * 1000);
  fs.utimesSync(file, at, at);
};

test("keys are SHA-256 hex and differ by every field", (t) => {
  const cache = new MailTextCache({ root: tempRoot(t) });
  const base = cache.key(fields(1));
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.equal(cache.key(fields(1)), base);
  for (const change of [
    { accountId: other },
    { folder: "Archive" },
    { uidValidity: "1700000001" },
    { uid: 2 },
    { part: "3" },
  ])
    assert.notEqual(cache.key({ ...fields(1), ...change }), base, JSON.stringify(change));
  // Joined with a separator no field can blur: "a" + "bc" is not "ab" + "c".
  assert.notEqual(
    cache.key({ ...fields(1), folder: "a", uidValidity: "bc" }),
    cache.key({ ...fields(1), folder: "ab", uidValidity: "c" }),
  );
});

test("entries round-trip, are 0600 and evict oldest over budget", (t) => {
  const root = tempRoot(t);
  const cache = new MailTextCache({ root, budgetBytes: 2_000 });
  const keys = [1, 2, 3].map((uid) => cache.key(fields(uid)));
  assert.equal(cache.get(account, keys[0]), null);
  assert.equal(cache.set(account, keys[0], sized(900)), true);
  assert.deepEqual(cache.get(account, keys[0]), sized(900));
  const first = fileOf(root, account, keys[0]);
  assert.equal(fs.statSync(first).size, 900);
  assert.equal(fs.statSync(first).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(first)).mode & 0o777, 0o700);
  age(first, 30);
  assert.equal(
    cache.set(account, keys[1], { failed: "MAIL_TEXT_FAILED", extra: 1 }),
    true,
  );
  assert.deepEqual(cache.get(account, keys[1]), { failed: "MAIL_TEXT_FAILED" });
  assert.equal(cache.set(account, keys[1], sized(900)), true);
  age(fileOf(root, account, keys[1]), 20);
  // 2 700 bytes are over the 2 000 budget: the oldest entry goes.
  assert.equal(cache.set(account, keys[2], sized(900)), true);
  assert.equal(fs.existsSync(first), false);
  assert.equal(cache.get(account, keys[0]), null);
  assert.deepEqual(cache.get(account, keys[1]), sized(900));
  assert.deepEqual(cache.get(account, keys[2]), sized(900));
  // No temporary file is left behind.
  assert.deepEqual(
    fs.readdirSync(path.join(root, account)).filter((name) => !name.endsWith(".json")),
    [],
  );
});

test("a read marks an entry as used, so the least recently used goes first", (t) => {
  const root = tempRoot(t);
  const cache = new MailTextCache({ root, budgetBytes: 2_000 });
  const [a, b, c] = [1, 2, 3].map((uid) => cache.key(fields(uid)));
  cache.set(account, a, sized(900));
  age(fileOf(root, account, a), 30);
  cache.set(account, b, sized(900));
  age(fileOf(root, account, b), 20);
  // Reading a makes it the newest: b is now the oldest.
  assert.deepEqual(cache.get(account, a), sized(900));
  cache.set(account, c, sized(900));
  assert.equal(cache.get(account, b), null);
  assert.deepEqual(cache.get(account, a), sized(900));
  // A fresh cache over the same folder counts the stored bytes before writing.
  const again = new MailTextCache({ root, budgetBytes: 2_000 });
  again.set(account, b, sized(900));
  const left = fs
    .readdirSync(path.join(root, account))
    .filter((n) => n.endsWith(".json"));
  assert.equal(left.length, 2);
});

test("unreadable, foreign or malformed entries read as missing", (t) => {
  const root = tempRoot(t);
  const cache = new MailTextCache({ root });
  const key = cache.key(fields(1));
  fs.mkdirSync(path.join(root, account), { recursive: true });
  for (const content of ["{not json", '{"text":1}', '{"failed":"rm -rf"}', "null"]) {
    fs.writeFileSync(fileOf(root, account, key), content);
    assert.equal(cache.get(account, key), null, content);
  }
  // Ids and keys that are no plain names never reach the file system.
  for (const [id, k] of [
    ["../escape", key],
    [account, "../../x"],
    [account, "ABC"],
  ]) {
    assert.equal(cache.get(id, k), null);
    assert.equal(cache.set(id, k, sized(100)), false);
  }
  assert.equal(fs.existsSync(path.join(root, "..", "escape")), false);
  // Values that are neither text nor a failure code are not stored.
  assert.equal(cache.set(account, key, { text: 1 }), false);
  assert.equal(cache.set(account, key, { failed: "nope" }), false);
  // An entry larger than the whole budget is not stored.
  const small = new MailTextCache({ root, budgetBytes: 50 });
  assert.equal(small.set(account, key, sized(100)), false);
});

test("a failed write leaves nothing behind and never throws", (t) => {
  const root = tempRoot(t);
  fs.mkdirSync(path.dirname(root), { recursive: true });
  // The cache folder is a file: nothing can be written below it.
  fs.writeFileSync(root, "");
  const cache = new MailTextCache({ root });
  const key = cache.key(fields(1));
  assert.equal(cache.set(account, key, sized(100)), false);
  assert.equal(cache.get(account, key), null);
});

test("removeAccount and removeOrphans delete account folders", (t) => {
  const root = tempRoot(t);
  const cache = new MailTextCache({ root });
  const third = "11111111-2222-4333-8444-555555555555";
  for (const id of [account, other, third])
    cache.set(id, cache.key({ ...fields(1), accountId: id }), sized(100));
  cache.removeAccount(other);
  assert.deepEqual(fs.readdirSync(root).sort(), [account, third].sort());
  // Removing an unknown or malformed id changes nothing.
  cache.removeAccount("../mail");
  cache.removeAccount(other);
  assert.deepEqual(fs.readdirSync(root).sort(), [account, third].sort());
  cache.removeOrphans([account]);
  assert.deepEqual(fs.readdirSync(root), [account]);
  assert.deepEqual(cache.get(account, cache.key(fields(1))), sized(100));
  // A missing cache folder is no error.
  fs.rmSync(root, { recursive: true });
  cache.removeOrphans([account]);
  cache.removeAccount(account);
});

test("eviction goes down to 90 % of the budget, not just under it", (t) => {
  const root = tempRoot(t);
  const cache = new MailTextCache({ root, budgetBytes: 2_000 });
  const keys = [1, 2, 3, 4, 5, 6].map((uid) => cache.key(fields(uid)));
  keys.slice(0, 5).forEach((key, i) => {
    cache.set(account, key, sized(400));
    age(fileOf(root, account, key), 60 - i);
  });
  // 2 000 bytes fit; the sixth entry makes 2 400 and leaves 1 600 (<= 1 800).
  cache.set(account, keys[5], sized(400));
  assert.deepEqual(
    keys.map((key) => cache.get(account, key) !== null),
    [false, false, true, true, true, true],
  );
});

test("a removed account gets no new entries; a cleared one does", (t) => {
  const root = tempRoot(t);
  const cache = new MailTextCache({ root });
  const key = cache.key(fields(1));
  cache.set(account, key, sized(100));
  cache.clearAccount(account);
  assert.equal(cache.get(account, key), null);
  assert.equal(cache.set(account, key, sized(100)), true);
  cache.removeAccount(account);
  // A search still running for the removed account writes nothing.
  assert.equal(cache.set(account, key, sized(100)), false);
  assert.equal(fs.existsSync(path.join(root, account)), false);
});

test("a write from an older generation is dropped", (t) => {
  const cache = new MailTextCache({ root: tempRoot(t) });
  const key = cache.key(fields(1));
  const started = cache.generation(account);
  assert.equal(started, 0);
  cache.clearAccount(account);
  assert.equal(cache.generation(account), 1);
  assert.equal(cache.set(account, key, sized(100), started), false);
  assert.equal(cache.get(account, key), null);
  assert.equal(cache.set(account, key, sized(100), 1), true);
  // Other accounts keep their own generation.
  assert.equal(cache.generation(other), 0);
});
