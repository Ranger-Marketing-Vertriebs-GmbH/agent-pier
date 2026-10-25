import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  HookStore,
  newSecret,
  secretMatches,
} from "../../server/features/assistants/agent-hook-store.js";

const fields = (assistantId = "a1") => ({
  assistantId,
  name: "Deploys",
  sender: "CI",
  instruction: "Summarise",
  enabled: true,
  secretHash: null,
  createdBy: "owner",
});

test("a secret is shown once and only its hash matches", () => {
  const { secret, hash } = newSecret();
  assert.match(secret, /^aph_[A-Za-z0-9_-]{43}$/);
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(secretMatches(hash, secret), true);
  assert.equal(secretMatches(hash, secret + "x"), false);
  assert.equal(secretMatches(null, secret), false);
});

test("create assigns id, revision and creation time; get and list read them back", () => {
  const store = new HookStore(new DatabaseSync(":memory:"));
  const hook = store.create(fields());
  assert.equal(hook.revision, 1);
  assert.match(hook.id, /^[0-9a-f-]{36}$/);
  assert.ok(Number.isFinite(Date.parse(hook.createdAt)));
  assert.deepEqual(store.get(hook.id), hook);
  store.create(fields("a2"));
  assert.deepEqual(
    store.list("a1").map((h) => h.id),
    [hook.id],
  );
  assert.equal(store.get("missing"), null);
});

test("patch with a stale revision conflicts", () => {
  const store = new HookStore(new DatabaseSync(":memory:"));
  const hook = store.create(fields());
  const next = store.patch(hook.id, { name: "Renamed" }, 1);
  assert.equal(next.revision, 2);
  assert.equal(next.name, "Renamed");
  assert.throws(
    () => store.patch(hook.id, {}, 1),
    (error) => error.status === 409,
  );
  assert.equal(store.get(hook.id).revision, 2);
  assert.equal(store.patch(hook.id, { enabled: false }).revision, 3);
});

test("remove deletes the hook", () => {
  const store = new HookStore(new DatabaseSync(":memory:"));
  const hook = store.create(fields());
  store.remove(hook.id);
  assert.equal(store.get(hook.id), null);
});
