import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { RuntimeUpdates } from "../../server/features/assistants/runtime-updates.js";
import { runtimePaths } from "../../server/features/assistants/runtime-paths.js";
import { readJSON, writePrivate } from "../../server/lib/storage.js";
import {
  fencedDatabase,
  ledgerFence,
} from "../../server/features/assistants/ledger-fence.js";
import {
  pruneRuntimes,
  sweepAssistantStorage,
} from "../../server/features/assistants/runtime-retention.js";
import { AssistantModelAccounts } from "../../server/features/assistants/model-accounts.js";

function runtimeDirectory(paths, name) {
  const directory = path.join(paths.runtimes, name);
  fs.mkdirSync(path.join(directory, "node", "bin"), { recursive: true });
  return {
    version: name,
    nodeVersion: "node",
    nodePath: path.join(directory, "node", "bin", "node"),
    entryPath: path.join(directory, "app", "node_modules", "openclaw", "openclaw.mjs"),
  };
}
function fixture(t, { fenced = false } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-retention-"));
  const paths = runtimePaths(dataDir);
  const selected = path.join(paths.root, "runtime.json");
  writePrivate(selected, { version: "old", nodeVersion: "old-node" });
  fs.writeFileSync(path.join(paths.state, "history"), "before");
  const file = path.join(paths.root, "assistants.sqlite");
  const raw = new DatabaseSync(file);
  raw.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE effects(id TEXT PRIMARY KEY); INSERT INTO effects VALUES ('recorded');",
  );
  const db = fenced ? fencedDatabase(raw, paths.root, "assistants.sqlite") : raw;
  t.after(() => {
    raw.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const calls = [];
  const runtime = {
    running: true,
    status() {
      return { availability: this.running ? "ready" : "disabled" };
    },
    async stop() {
      calls.push("stop");
      this.running = false;
    },
    async start() {
      calls.push(`start:${readJSON(selected).version}`);
      this.running = true;
    },
  };
  const maintenance = {
    async enter() {
      calls.push("enter");
    },
    async blockers() {
      return [];
    },
    async quiesce() {},
    async validate() {},
    async leave() {},
  };
  let next = { version: "target", nodeVersion: "target-node" };
  const options = {
    dataDir,
    runtime,
    maintenance,
    stage: async () => next,
    freeSpace: async () => Number.MAX_SAFE_INTEGER,
  };
  return {
    dataDir,
    paths,
    selected,
    db,
    calls,
    maintenance,
    options,
    setNext: (value) => (next = value),
    count: () => raw.prepare("SELECT count(*) AS n FROM effects").get().n,
    backups: () =>
      fs.existsSync(path.join(paths.root, "backups"))
        ? fs.readdirSync(path.join(paths.root, "backups")).sort()
        : [],
    keys: () => fs.readdirSync(path.join(paths.root, "backup-keys")).sort(),
  };
}
async function update(f, candidate) {
  f.setNext(candidate);
  const updates = new RuntimeUpdates(f.options);
  await updates.stage();
  await updates.activate();
  return readJSON(path.join(f.paths.root, "update.json")).backup;
}

test("insufficient free space refuses activation before any copy", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.paths.workspaces, "large"), Buffer.alloc(64 * 1024));
  let estimate;
  const updates = new RuntimeUpdates({
    ...f.options,
    freeSpace: async () => {
      estimate = 2 * 64 * 1024 - 1;
      return estimate;
    },
  });
  await updates.stage();
  await assert.rejects(updates.activate(), { code: "INSUFFICIENT_SPACE", status: 507 });
  assert.equal(typeof estimate, "number");
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.backups(), []);
  assert.deepEqual(readJSON(f.selected), { version: "old", nodeVersion: "old-node" });
  assert.equal(updates.status().phase, "staged");
  assert.equal(updates.status().diagnostic, "INSUFFICIENT_SPACE");
});

test("retention keeps the last two successful backups and an unresolved recovery", async (t) => {
  const f = fixture(t);
  const ids = [];
  for (const version of ["v1", "v2", "v3"]) ids.push(await update(f, { version }));
  assert.deepEqual(f.backups(), ids.slice(1).sort());
  assert.deepEqual(
    f.keys(),
    ids
      .slice(1)
      .map((id) => `${id}.key`)
      .sort(),
  );
  f.maintenance.validate = async () => f.db.exec("INSERT INTO effects VALUES ('late')");
  await assert.rejects(update(f, { version: "v4" }), {
    code: "UPDATE_RECOVERY_REQUIRED",
  });
  const unresolved = readJSON(path.join(f.paths.root, "update.json")).backup;
  assert.deepEqual(f.backups(), [...ids.slice(1), unresolved].sort());
});

test("successful activation deletes runtimes no selection or rollback target uses", async (t) => {
  const f = fixture(t);
  const previous = runtimeDirectory(f.paths, "previous");
  const candidate = runtimeDirectory(f.paths, "candidate");
  runtimeDirectory(f.paths, "abandoned");
  writePrivate(f.selected, previous);
  await update(f, candidate);
  assert.deepEqual(fs.readdirSync(f.paths.runtimes).sort(), ["candidate"]);
});

test("legacy selections without runtime paths never prune installed runtimes", async (t) => {
  const f = fixture(t);
  runtimeDirectory(f.paths, "kept");
  await update(f, { version: "target" });
  assert.deepEqual(fs.readdirSync(f.paths.runtimes), ["kept"]);
});

test("startup sweep removes abandoned stage directories older than an hour", async (t) => {
  const f = fixture(t);
  const old = path.join(f.paths.runtimes, ".stage-old");
  const fresh = path.join(f.paths.runtimes, ".stage-fresh");
  fs.mkdirSync(old);
  fs.mkdirSync(fresh);
  const hours = new Date(Date.now() - 2 * 3600 * 1000);
  fs.utimesSync(old, hours, hours);
  const work = path.join(f.paths.tmp, "snapshot-fresh");
  fs.mkdirSync(work);
  await sweepAssistantStorage(f.paths);
  assert.deepEqual(fs.readdirSync(f.paths.runtimes), [".stage-fresh"]);
  assert.equal(fs.existsSync(work), false, "no snapshot runs during startup");
  fs.rmSync(f.paths.runtimes, { recursive: true });
  fs.mkdirSync(work);
  await sweepAssistantStorage(f.paths);
  assert.equal(fs.existsSync(work), false);
});

test("validation may record its own ledger rows while other writers are fenced", async (t) => {
  const f = fixture(t, { fenced: true });
  let release;
  const outside = new Promise((resolve) => (release = resolve)).then(() =>
    f.db.prepare("INSERT INTO effects VALUES ('telegram')").run(),
  );
  f.maintenance.validate = async () => {
    f.db.prepare("INSERT INTO effects VALUES ('validation')").run();
    release();
    await assert.rejects(outside, { code: "ASSISTANT_LEDGER_FENCED", status: 503 });
  };
  await update(f, { version: "target" });
  assert.equal(f.count(), 2);
  assert.equal(new RuntimeUpdates(f.options).status().phase, "complete");
  f.db.prepare("INSERT INTO effects VALUES ('after')").run();
  assert.equal(f.count(), 3);
});

test("validation that changes rows recorded before the fence still forbids rollback", async (t) => {
  const f = fixture(t, { fenced: true });
  f.maintenance.validate = async () =>
    f.db.prepare("DELETE FROM effects WHERE id='recorded'").run();
  await assert.rejects(update(f, { version: "target" }), {
    code: "UPDATE_RECOVERY_REQUIRED",
  });
});

test("rollback after logout restores state but not the revoked credential", async (t) => {
  const f = fixture(t);
  const agent = path.join(f.paths.state, "agents", "main", "agent");
  fs.mkdirSync(agent, { recursive: true });
  fs.writeFileSync(path.join(agent, "auth-profiles.json"), '{"token":"revoked"}');
  const profileId = "openai:me";
  const id = `openclaw:${createHash("sha256").update(profileId).digest("hex")}`;
  writePrivate(path.join(f.paths.root, "model-accounts.json"), [
    { id, profileId, name: "Me", status: "ok" },
  ]);
  f.maintenance.leave = async () => {
    throw Error("crash after commit");
  };
  await assert.rejects(update(f, { version: "target" }));
  const journal = readJSON(path.join(f.paths.root, "update.json"));
  writePrivate(path.join(f.paths.root, "update.json"), {
    ...journal,
    phase: "validating",
  });
  fs.writeFileSync(path.join(f.paths.state, "history"), "candidate");
  const calls = [];
  const accounts = new AssistantModelAccounts({
    dataDir: f.dataDir,
    runtime: {
      client: {
        ready: true,
        async call(method) {
          calls.push(method);
          return { providers: [] };
        },
      },
    },
  });
  await accounts.logout(id);
  assert.deepEqual(calls, ["models.authLogout", "models.authStatus"]);
  f.maintenance.leave = async () => {};
  const recovered = new RuntimeUpdates(f.options);
  await recovered.recover();
  assert.equal(fs.readFileSync(path.join(f.paths.state, "history"), "utf8"), "before");
  assert.equal(fs.existsSync(path.join(agent, "auth-profiles.json")), false);
  assert.equal(recovered.status().phase, "rolled_back");
  assert.equal(recovered.status().diagnostic, "UPDATE_ROLLED_BACK_LOGIN_REQUIRED");
});

test("work started inside one validation is fenced like any writer in the next", async (t) => {
  const f = fixture(t, { fenced: true });
  const fence = ledgerFence(f.paths.root);
  t.after(() => fence.open());
  let release;
  fence.close();
  const { later } = await fence.validation(async () => ({
    later: new Promise((resolve) => (release = resolve)).then(() =>
      f.db.prepare("INSERT INTO effects VALUES ('stale-timer')").run(),
    ),
  }));
  fence.open();
  fence.close();
  await fence.validation(async () => {
    release();
    await assert.rejects(later, { code: "ASSISTANT_LEDGER_FENCED" });
  });
  assert.deepEqual(fence.writes(), []);
  assert.equal(f.count(), 1);
});

test("recovering a committed update marks its backup as successful", async (t) => {
  const f = fixture(t);
  f.maintenance.leave = async () => {
    throw Error("crash after commit");
  };
  await assert.rejects(update(f, { version: "target" }), {
    code: "UPDATE_RESUME_REQUIRED",
  });
  const { backup } = readJSON(path.join(f.paths.root, "update.json"));
  const marker = path.join(f.paths.root, "backups", backup, "committed");
  fs.rmSync(marker);
  f.maintenance.leave = async () => {};
  await new RuntimeUpdates(f.options).recover();
  assert.equal(fs.existsSync(marker), true);
  assert.deepEqual(f.backups(), [backup]);
});

test("a candidate recorded just before retention takes the install lock is never pruned", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-retention-race-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const paths = runtimePaths(dataDir);
  writePrivate(
    path.join(paths.root, "runtime.json"),
    runtimeDirectory(paths, "selected"),
  );
  runtimeDirectory(paths, "unused");
  const link = fs.linkSync;
  let raced = false;
  t.after(() => {
    fs.linkSync = link;
  });
  // Another process installs a runtime and records it as the candidate under the
  // install lock, releasing the lock right before retention acquires it.
  fs.linkSync = (from, to) => {
    if (!raced && path.basename(to) === ".install.lock") {
      raced = true;
      writePrivate(
        path.join(paths.root, "candidate.json"),
        runtimeDirectory(paths, "fresh"),
      );
    }
    return link(from, to);
  };
  await pruneRuntimes(paths, { phase: "idle" });
  assert.ok(raced);
  assert.deepEqual(
    fs
      .readdirSync(paths.runtimes)
      .filter((name) => !name.startsWith("."))
      .sort(),
    ["fresh", "selected"],
  );
});
