import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  SecretStore,
  secretsRestoreFile,
} from "../../server/features/secrets/secret-store.js";
import { auditEvent } from "../../server/features/audit/audit-schema.js";

function fixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "secret-store-"));
  const calls = [];
  const store = new SecretStore({
    dataDir,
    audit: { append: (input) => calls.push(input) },
    clock: () => 1700000000000,
  });
  return { dataDir, calls, store };
}
const rejectsWith = (work, status) =>
  assert.throws(work, (e) => e.status === status && /^SECRET_/.test(e.code));

test("create and list never expose the value", () => {
  const { dataDir, store, calls } = fixture();
  try {
    const made = store.create({ name: "API_KEY", value: "hunter2" }, { id: "owner" });
    assert.deepEqual(Object.keys(made).sort(), [
      "description",
      "hasValue",
      "id",
      "name",
      "projectId",
      "updatedAt",
    ]);
    assert.equal(made.hasValue, true);
    assert.equal(made.updatedAt, 1700000000000);
    assert.equal(JSON.stringify(store.list()).includes("hunter2"), false);
    assert.equal(JSON.stringify(store.get(made.id)).includes("hunter2"), false);
    assert.equal(JSON.stringify(calls).includes("hunter2"), false);
    assert.equal(calls[0].action, "secret.created");
    assert.equal(calls[0].resourceType, "secret");
    assert.equal(calls[0].resourceId, made.id);
    assert.equal(calls[0].source, "user");
    assert.deepEqual(calls[0].details, { name: "API_KEY" });
    assert.equal(
      fs.statSync(path.join(dataDir, "secrets", "secrets.sqlite")).mode & 0o777,
      0o600,
    );
    // The details pass the audit schema unchanged.
    const event = auditEvent({ ...calls[0], outcome: "success" });
    assert.equal(event.details.name, "API_KEY");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("invalid input, duplicates and limits are refused with stable codes", () => {
  const { dataDir, store } = fixture();
  try {
    for (const name of ["zabbix", "1X", "", "A".repeat(65)])
      rejectsWith(() => store.create({ name, value: "v" }), 400);
    rejectsWith(() => store.create({ name: "A" }), 400);
    rejectsWith(() => store.create({ name: "A", value: "a\0b" }), 400);
    rejectsWith(() => store.create({ name: "A", value: "x".repeat(8193) }), 400);
    rejectsWith(() => store.create({ name: "A", value: "é".repeat(4097) }), 400);
    rejectsWith(
      () => store.create({ name: "A", value: "v", description: "d".repeat(201) }),
      400,
    );
    store.create({ name: "A", value: "v" });
    rejectsWith(() => store.create({ name: "A", value: "w" }), 409);
    assert.equal(store.create({ name: "B", value: "x".repeat(8192) }).hasValue, true);
    rejectsWith(() => store.get("missing"), 404);
    rejectsWith(() => store.update("missing", { name: "Z" }), 404);
    rejectsWith(() => store.remove("missing"), 404);
    assert.equal(store.get(store.list()[0].id).code, undefined);
    assert.equal(
      (() => {
        try {
          store.create({ name: "A", value: "w" });
        } catch (e) {
          return e.code;
        }
      })(),
      "SECRET_NAME_TAKEN",
    );
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("at most 200 secrets", () => {
  const { dataDir, store } = fixture();
  try {
    for (let i = 0; i < 200; i += 1) store.create({ name: `S_${i}`, value: "v" });
    rejectsWith(() => store.create({ name: "ONE_MORE", value: "v" }), 409);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("update keeps the value when none is sent and audits the changed fields", () => {
  const { dataDir, store, calls } = fixture();
  try {
    const made = store.create({ name: "A", value: "keep" });
    const updated = store.update(made.id, {
      name: "B",
      description: "d",
      projectId: "p1",
    });
    assert.equal(updated.name, "B");
    assert.equal(updated.projectId, "p1");
    assert.deepEqual(store.entries([made.id, "unknown"]), [{ name: "B", value: "keep" }]);
    const last = calls.at(-1);
    assert.equal(last.action, "secret.updated");
    assert.deepEqual(last.details, {
      name: "B",
      changed: ["name", "description", "project"],
    });
    store.update(made.id, { name: "B", value: "new" });
    assert.deepEqual(calls.at(-1).details.changed, ["value"]);
    assert.deepEqual(store.entries([made.id]), [{ name: "B", value: "new" }]);
    assert.equal(JSON.stringify(calls).includes("new"), false);
    assert.equal(JSON.stringify(calls).includes("keep"), false);
    store.update(made.id, { name: "B", projectId: null });
    assert.equal(store.get(made.id).projectId, null);
    store.remove(made.id, { id: "owner" });
    assert.equal(calls.at(-1).action, "secret.deleted");
    assert.deepEqual(calls.at(-1).details, { name: "B" });
    assert.deepEqual(store.list(), []);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("project entries, project moves and the sealed export", () => {
  const { dataDir, store } = fixture();
  try {
    const a = store.create({ name: "A", value: "1", projectId: "p1" });
    store.create({ name: "B", value: "2", projectId: "p2" });
    store.create({ name: "C", value: "3" });
    assert.deepEqual(store.projectEntries("p1"), [{ id: a.id, name: "A", value: "1" }]);
    store.moveProject("p1", "p2");
    assert.equal(store.projectEntries("p2").length, 2);
    assert.deepEqual(store.projectEntries("p1"), []);
    const sealed = store.exportSealed();
    assert.equal(sealed.version, 1);
    assert.equal(sealed.secrets.length, 3);
    assert.deepEqual(Object.keys(sealed.secrets[0]).sort(), [
      "description",
      "id",
      "name",
      "projectId",
      "value",
    ]);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("onChange supports several listeners and unsubscribing", () => {
  const { dataDir, store } = fixture();
  try {
    let one = 0,
      two = 0;
    const off = store.onChange(() => (one += 1));
    store.onChange(() => (two += 1));
    const made = store.create({ name: "A", value: "v" });
    store.update(made.id, { name: "A", value: "w" });
    store.remove(made.id);
    assert.deepEqual([one, two], [3, 3]);
    off();
    store.create({ name: "B", value: "v" });
    assert.deepEqual([one, two], [3, 4]);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("the store works without an audit sink", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "secret-store-"));
  try {
    const store = new SecretStore({ dataDir });
    assert.equal(store.create({ name: "A", value: "v" }).name, "A");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a failing audit still notifies the delivery of every committed change", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "secret-store-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const errors = t.mock.method(console, "error", () => {});
  const store = new SecretStore({
    dataDir,
    audit: {
      append() {
        throw Object.assign(new Error("disk full hunter2"), { code: "ENOSPC" });
      },
    },
  });
  let notified = 0;
  store.onChange(() => notified++);
  const made = store.create({ name: "A", value: "hunter2" });
  store.update(made.id, { value: "next" });
  store.remove(made.id);
  assert.equal(notified, 3);
  assert.deepEqual(store.names(), []);
  assert.equal(errors.mock.callCount(), 3);
  for (const call of errors.mock.calls)
    assert.deepEqual(call.arguments, ["Secret audit failed:", "ENOSPC"]);
  store.db.close();
});

test("update accepts a partial body and keeps every absent field", () => {
  const { dataDir, store } = fixture();
  try {
    const made = store.create({ name: "A", description: "d", value: "v" });
    const updated = store.update(made.id, { description: "e" });
    assert.equal(updated.name, "A");
    assert.equal(updated.description, "e");
    assert.deepEqual(store.entries([made.id]), [{ name: "A", value: "v" }]);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a failed open closes the database", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "secret-store-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  // A folder where the restore file belongs makes the import fail.
  fs.mkdirSync(path.join(dataDir, "secrets", secretsRestoreFile), { recursive: true });
  const close = t.mock.method(DatabaseSync.prototype, "close");
  assert.throws(() => new SecretStore({ dataDir }));
  assert.equal(close.mock.callCount(), 1);
});
