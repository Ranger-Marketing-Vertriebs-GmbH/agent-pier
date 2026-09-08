import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const module = await import("../../server/features/audit/audit-store.js").catch(
  () => ({}),
);
async function fixture(t) {
  assert.equal(typeof module.AuditStore, "function");
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-audit-"));
  let store = new module.AuditStore({ dataDir });
  t.after(async () => {
    store.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return {
    dataDir,
    get store() {
      return store;
    },
    reopen() {
      store.close();
      store = new module.AuditStore({ dataDir });
    },
  };
}
const event = (id) => ({
  action: "session.started",
  resourceType: "session",
  resourceId: `session-${id}`,
  sessionId: `session-${id}`,
  outcome: "success",
  source: "user",
});
test("audit survives restart and retains a fixed pagination boundary while new events arrive", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 30; i++) f.store.append(event(i));
  const first = f.store.list({ page: 1 });
  assert.equal(first.events.length, 25);
  assert.equal(first.total, 30);
  f.store.append(event(30));
  const second = f.store.list({ page: 2, before: first.before });
  assert.equal(second.total, 30);
  assert.equal(second.events.length, 5);
  assert.equal(new Set([...first.events, ...second.events].map((e) => e.id)).size, 30);
  f.reopen();
  assert.equal(f.store.list({ sessionId: "session-30" }).total, 1);
  assert.equal(f.store.export().length, 31);
});
test("audit stores typed metadata without raw input, paths, credentials or native text", async (t) => {
  const { store } = await fixture(t);
  store.append({
    ...event(1),
    body: { apiKey: "fixture-secret" },
    details: {
      tool: "codex",
      statusCode: 201,
      command: "fixture-secret",
      path: "/private/fixture-secret",
      error: "fixture-secret",
      apiKey: "fixture-secret",
    },
  });
  const row = store.list().events[0];
  assert.deepEqual(row.details, { tool: "codex", statusCode: 201 });
  assert.equal(JSON.stringify(row).includes("fixture-secret"), false);
  assert.throws(
    () => store.append({ ...event(1), action: "native.secret-content" }),
    /action/i,
  );
  for (const filters of [
    { page: 0 },
    { page: 1.2 },
    { page: 100001 },
    { before: "1 OR 1=1" },
    { outcome: "anything" },
    { sessionId: "x' OR 1=1" },
  ])
    assert.throws(() => store.list(filters));
});
test("audit refuses linked database files without modifying their target", async (t) => {
  const f = await fixture(t);
  f.store.close();
  const target = path.join(f.dataDir, "target");
  await fs.writeFile(target, "untouched");
  const file = path.join(f.dataDir, "audit", "audit.sqlite");
  await fs.rm(file);
  await fs.symlink(target, file);
  assert.throws(() => new module.AuditStore({ dataDir: f.dataDir }), /storage/i);
  assert.equal(await fs.readFile(target, "utf8"), "untouched");
});
test("audit restore preserves identities and timestamps atomically into an empty target only", async (t) => {
  const first = await fixture(t);
  first.store.append(event(1));
  first.store.append(event(2));
  const records = first.store.export(),
    target = await fixture(t);
  assert.equal(typeof target.store.importEvents, "function");
  assert.throws(() => target.store.importEvents([...records, records[0]]));
  assert.equal(target.store.list().total, 0);
  target.store.importEvents(records);
  assert.deepEqual(target.store.export(), records);
  assert.throws(() => target.store.importEvents(records), /empty/i);
  assert.equal(Number(target.store.append(event(3)).id), 3);
});
