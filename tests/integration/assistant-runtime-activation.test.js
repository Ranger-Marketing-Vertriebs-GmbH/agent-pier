import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RuntimeUpdates } from "../../server/features/assistants/runtime-updates.js";
import { runtimePaths } from "../../server/features/assistants/runtime-paths.js";
import { readJSON, writePrivate } from "../../server/lib/storage.js";

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-activation-"));
  const paths = runtimePaths(dataDir);
  const selected = path.join(paths.root, "runtime.json");
  const journal = path.join(paths.root, "update.json");
  const old = { version: "old", nodeVersion: "old-node" };
  const target = { version: "target", nodeVersion: "target-node" };
  writePrivate(selected, old);
  fs.writeFileSync(path.join(paths.state, "history"), "before");
  const db = new DatabaseSync(path.join(paths.root, "assistants.sqlite"));
  db.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE effects(id TEXT PRIMARY KEY); INSERT INTO effects VALUES ('recorded');",
  );
  t.after(() => {
    db.close();
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
  let gated = false;
  const maintenance = {
    async enter() {
      gated = true;
      calls.push("enter");
    },
    async blockers() {
      return [];
    },
    async quiesce() {
      calls.push("quiesce");
    },
    async validate() {
      calls.push("validate");
    },
    async leave() {
      gated = false;
      calls.push("leave");
    },
  };
  const options = { dataDir, runtime, maintenance, stage: async () => target };
  return {
    ...options,
    paths,
    selected,
    journal,
    old,
    target,
    db,
    calls,
    options,
    gated: () => gated,
    updates: new RuntimeUpdates(options),
  };
}

test("staging keeps selection, hides paths, and activation commits before resuming", async (t) => {
  const f = fixture(t);
  await f.updates.stage();
  assert.deepEqual(readJSON(f.selected), f.old);
  assert.equal(f.updates.status().targetVersion, "target");
  f.maintenance.leave = async () => {
    assert.equal(readJSON(f.journal).phase, "committed");
    f.calls.push("leave");
  };
  await f.updates.activate();
  assert.deepEqual(readJSON(f.selected), f.target);
  assert.equal(f.updates.status().phase, "complete");
  assert.deepEqual(f.calls, [
    "enter",
    "stop",
    "quiesce",
    "start:target",
    "validate",
    "leave",
  ]);
  assert.equal(JSON.stringify(f.updates.status()).includes(f.dataDir), false);
});

test("active or uncertain work rejects activation before stopping and preserves selection", async (t) => {
  const f = fixture(t);
  await f.updates.stage();
  f.maintenance.blockers = async () => ["pending_work"];
  await assert.rejects(f.updates.activate(), { status: 409 });
  assert.deepEqual(f.calls, ["enter", "leave"]);
  assert.equal(f.gated(), false);
  assert.deepEqual(readJSON(f.selected), f.old);
  assert.deepEqual(f.updates.status().blockers, ["pending_work"]);
});

test("failed candidate restores matching history/runtime and preserves recorded effects", async (t) => {
  const f = fixture(t);
  await f.updates.stage();
  f.maintenance.validate = async () => {
    if (readJSON(f.selected).version === "target") {
      fs.writeFileSync(path.join(f.paths.state, "history"), "migrated");
      throw Error("private upstream failure");
    }
  };
  await assert.rejects(f.updates.activate(), { code: "UPDATE_ROLLED_BACK" });
  assert.deepEqual(readJSON(f.selected), f.old);
  assert.equal(fs.readFileSync(path.join(f.paths.state, "history"), "utf8"), "before");
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM effects").get().n, 1);
  assert.equal(f.updates.status().phase, "rolled_back");
  assert.equal(f.gated(), false);
  assert.equal(JSON.stringify(f.updates.status()).includes("private upstream"), false);
});

test("changed effect ledger forbids rollback and leaves admission stopped", async (t) => {
  const f = fixture(t);
  await f.updates.stage();
  f.maintenance.validate = async () => {
    f.db.exec("INSERT INTO effects VALUES ('new-effect')");
    throw Error("failed");
  };
  await assert.rejects(f.updates.activate(), { code: "UPDATE_RECOVERY_REQUIRED" });
  assert.equal(f.runtime.running, false);
  assert.equal(f.gated(), true);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM effects").get().n, 2);
  assert.equal(f.updates.status().recoveryRequired, true);
});

test("interrupted validation restores snapshot on startup without sending any request", async (t) => {
  const f = fixture(t);
  await f.updates.stage();
  f.maintenance.leave = async () => {
    throw Error("pause after commit");
  };
  await assert.rejects(f.updates.activate());
  const journal = readJSON(f.journal);
  journal.phase = "validating";
  writePrivate(f.journal, journal);
  fs.writeFileSync(path.join(f.paths.state, "history"), "partly migrated");
  f.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  f.maintenance.leave = async () => f.calls.push("resume recovered");
  const recovered = new RuntimeUpdates(f.options);
  await recovered.recover();
  assert.deepEqual(readJSON(f.selected), f.old);
  assert.equal(fs.readFileSync(path.join(f.paths.state, "history"), "utf8"), "before");
  assert.equal(recovered.status().phase, "rolled_back");
});

test("committed update recovery keeps new effects and cannot downgrade", async (t) => {
  const f = fixture(t);
  await f.updates.stage();
  f.maintenance.leave = async () => {
    throw Error("resume interrupted");
  };
  await assert.rejects(f.updates.activate());
  f.db.exec("INSERT INTO effects VALUES ('after-commit')");
  f.maintenance.leave = async () => {};
  await new RuntimeUpdates(f.options).recover();
  assert.deepEqual(readJSON(f.selected), f.target);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM effects").get().n, 2);
});

test("snapshot keeps aliases as links without following or touching their targets", async (t) => {
  const f = fixture(t);
  const outside = path.join(f.dataDir, "unrelated");
  fs.writeFileSync(outside, "untouched");
  fs.symlinkSync(outside, path.join(f.paths.state, "alias"));
  await f.updates.stage();
  await f.updates.activate();
  const backup = path.join(f.paths.root, "backups", readJSON(f.journal).backup);
  assert.equal(fs.readlinkSync(path.join(backup, "payload", "state", "alias")), outside);
  assert.deepEqual(readJSON(path.join(backup, "snapshot.json")).excludedLinks, [
    "state/alias",
  ]);
  assert.equal(fs.readFileSync(outside, "utf8"), "untouched");
});

test("concurrent update requests are rejected instead of crossing activation", async (t) => {
  const f = fixture(t);
  let finish;
  f.options.stage = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const updates = new RuntimeUpdates(f.options);
  const staging = updates.stage();
  await assert.rejects(updates.activate(), { status: 409 });
  finish(f.target);
  await staging;
});

test("rollback resume failure cannot later restore over newly recorded effects", async (t) => {
  const f = fixture(t);
  await f.updates.stage();
  f.maintenance.validate = async () => {
    if (readJSON(f.selected).version === "target") throw Error("reject candidate");
  };
  f.maintenance.leave = async () => {
    f.db.exec("INSERT INTO effects VALUES ('after-rollback')");
    throw Error("partial resume");
  };
  await assert.rejects(f.updates.activate());
  f.maintenance.leave = async () => {};
  const recovered = new RuntimeUpdates(f.options);
  await recovered.recover();
  assert.deepEqual(readJSON(f.selected), f.old);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM effects").get().n, 2);
});

test("candidate validation cannot commit new effects while admission is frozen", async (t) => {
  const f = fixture(t);
  await f.updates.stage();
  f.maintenance.validate = async () =>
    f.db.exec("INSERT INTO effects VALUES ('unexpected')");
  await assert.rejects(f.updates.activate(), { code: "UPDATE_RECOVERY_REQUIRED" });
  assert.equal(f.runtime.running, false);
  assert.equal(f.gated(), true);
});

test("staging failure leaves selected runtime and live service untouched", async (t) => {
  const f = fixture(t);
  f.options.stage = async () => {
    throw Object.assign(Error("disk full"), { code: "ENOSPC" });
  };
  const updates = new RuntimeUpdates(f.options);
  await assert.rejects(updates.stage(), { code: "UPDATE_STAGE_FAILED" });
  assert.deepEqual(readJSON(f.selected), f.old);
  assert.deepEqual(f.calls, []);
  assert.equal(f.runtime.running, true);
});

test("insufficient snapshot space never activates candidate or loses state", async (t) => {
  const f = fixture(t);
  await f.updates.stage();
  t.mock.method(fs.promises, "copyFile", async () => {
    throw Object.assign(Error("full"), { code: "ENOSPC" });
  });
  await assert.rejects(f.updates.activate(), { code: "UPDATE_ROLLED_BACK" });
  assert.deepEqual(readJSON(f.selected), f.old);
  assert.equal(fs.readFileSync(path.join(f.paths.state, "history"), "utf8"), "before");
  assert.equal(f.calls.includes("start:target"), false);
});

test("corrupt snapshot cannot restore or resume an interrupted update", async (t) => {
  const f = fixture(t);
  await f.updates.stage();
  await f.updates.activate();
  const journal = readJSON(f.journal);
  journal.phase = "validating";
  writePrivate(f.journal, journal);
  fs.writeFileSync(
    path.join(f.paths.root, "backups", journal.backup, "payload", "state", "history"),
    "corrupt",
  );
  const recovered = new RuntimeUpdates(f.options);
  await assert.rejects(recovered.recover(), { code: "UPDATE_RECOVERY_REQUIRED" });
  assert.equal(f.runtime.running, false);
  assert.equal(f.gated(), true);
  assert.equal(fs.readFileSync(path.join(f.paths.state, "history"), "utf8"), "before");
});

test("activation validates a disabled service and leaves it disabled afterward", async (t) => {
  const f = fixture(t);
  f.runtime.running = false;
  await f.updates.stage();
  await f.updates.activate();
  assert.deepEqual(readJSON(f.selected), f.target);
  assert.equal(f.runtime.running, false);
  assert.equal(f.calls.includes("validate"), true);
});

test("malformed update journal leaves assistant recovery available and fails closed", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.journal, "{truncated");
  const recovered = new RuntimeUpdates(f.options);
  assert.equal(recovered.status().recoveryRequired, true);
  await assert.rejects(recovered.recover(), { code: "UPDATE_RECOVERY_REQUIRED" });
  assert.equal(f.runtime.running, false);
  assert.deepEqual(readJSON(f.selected), f.old);
});

test("schema version mutation while validating prevents unsafe restoration", async (t) => {
  const f = fixture(t);
  await f.updates.stage();
  f.maintenance.validate = async () => f.db.exec("PRAGMA user_version=99");
  await assert.rejects(f.updates.activate(), { code: "UPDATE_RECOVERY_REQUIRED" });
  assert.equal(f.db.prepare("PRAGMA user_version").get().user_version, 99);
});

test("failure writing final status after resume cannot roll back committed state", async (t) => {
  const f = fixture(t);
  await f.updates.stage();
  f.maintenance.leave = async () =>
    fs.writeFileSync(path.join(f.paths.state, "history"), "after-resume");
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (source, destination) => {
    if (destination === f.journal && readJSON(source).phase === "complete")
      throw Error("status write failed");
    return rename(source, destination);
  });
  await assert.rejects(f.updates.activate(), { code: "UPDATE_RESUME_REQUIRED" });
  assert.deepEqual(readJSON(f.selected), f.target);
  assert.equal(
    fs.readFileSync(path.join(f.paths.state, "history"), "utf8"),
    "after-resume",
  );
  assert.equal(readJSON(f.journal).phase, "committed");
});

test("orphaned provider pause recovers current runtime without restoring stale ledgers", async (t) => {
  const f = fixture(t);
  f.maintenance.recoveryState = () => ({ wasRunning: true });
  f.db.exec("INSERT INTO effects VALUES ('provider-change')");
  f.maintenance.leave = async () => {
    assert.equal(readJSON(f.journal).phase, "committed");
    f.maintenance.recoveryState = () => null;
  };
  assert.equal(f.updates.status().recoveryRequired, true);
  await f.updates.recover();
  assert.deepEqual(readJSON(f.selected), f.old);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM effects").get().n, 2);
  assert.deepEqual(f.calls, ["enter", "start:old", "validate"]);
  assert.equal(f.updates.status().recoveryRequired, false);
});

test("direct updater operations cannot cross an active provider mutation", async (t) => {
  const f = fixture(t);
  await f.updates.stage();
  const updates = new RuntimeUpdates({ ...f.options, isBlocked: () => true });
  for (const action of ["stage", "activate", "recover"])
    await assert.rejects(updates[action](), { code: "UPDATE_BUSY", status: 409 });
  assert.deepEqual(f.calls, []);
  assert.deepEqual(readJSON(f.selected), f.old);
  assert.equal(fs.existsSync(path.join(f.paths.root, "backups")), false);
});
