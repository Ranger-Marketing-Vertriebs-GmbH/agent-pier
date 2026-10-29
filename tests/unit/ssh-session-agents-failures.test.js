import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { SessionSshAgents } from "../../server/features/ssh/ssh-session-agents.js";
import { sessionFolder } from "../../server/features/ssh/ssh-session-config.js";
import {
  base,
  fixture,
  hostA,
  hostB,
  identitiesAt,
  input,
  launch,
  root,
} from "../helpers/ssh-session-agents-fixture.js";

async function waitFor(check, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
}

const errors = (f) => f.logs.filter(([level]) => level === "error");

// The wrapper still runs the real ssh for a host that is no session alias.
function passThrough(binDir) {
  const ssh = path.join(binDir, "ssh");
  const version = execFileSync(ssh, ["-V"], { encoding: "utf8", stdio: "pipe" });
  assert.equal(version, "");
  const config = execFileSync(ssh, ["-F", "/dev/null", "-G", "github.com"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  assert.match(config, /^hostname github\.com$/m);
}

test("a failed write keeps pass-through wrappers, drops the aliases and retries", async (t) => {
  const f = fixture(t, { retryDelays: [30, 30, 30] });
  const { id, record } = await launch(f);
  await f.grants.set(record, [hostA.id]);
  await f.agents.sync(record);
  const folder = sessionFolder(f.dataDir, id);
  const { binDir, configPath } = f.agents.launchDetails(id);
  const victim = path.join(root, `victim-${randomUUID()}`);
  fs.mkdirSync(victim);
  fs.writeFileSync(path.join(victim, "keep"), "keep");
  fs.rmSync(path.join(folder, "keys"), { recursive: true });
  fs.symlinkSync(victim, path.join(folder, "keys"));
  await f.grants.set(record, [hostA.id, hostB.id]);
  await assert.rejects(f.agents.sync(record), { code: "SSH_FOLDER_UNSAFE" });
  assert.deepEqual(fs.readdirSync(victim), ["keep"]);
  assert.deepEqual(errors(f), [
    ["error", "Session SSH agent files could not be written:", "SSH_FOLDER_UNSAFE"],
  ]);
  // No alias survives for the CLI to trust, but bin/ssh still serves Git and rsync.
  assert.equal(fs.lstatSync(path.join(folder, "keys")).isSymbolicLink(), false);
  assert.doesNotMatch(fs.readFileSync(configPath, "utf8"), /^Host /m);
  assert.deepEqual(f.agents.status(record).aliases, {});
  passThrough(binDir);
  // The retry writes the full set without any further event.
  await waitFor(() => /^Host database$/m.test(fs.readFileSync(configPath, "utf8")));
  assert.deepEqual(Object.keys(f.agents.status(record).aliases).sort(), [
    hostA.id,
    hostB.id,
  ]);
  assert.deepEqual(fs.readdirSync(victim), ["keep"]);
});

test("retries after a failing catalog are bounded", async (t) => {
  const f = fixture(t, { retryDelays: [10, 20, 30] });
  const { id, record } = await launch(f);
  const list = f.store.list;
  f.store.list = () => {
    throw Object.assign(new Error("catalog unreadable"), { code: "SSH_CATALOG" });
  };
  await assert.rejects(f.agents.sync(record), /catalog unreadable/);
  await waitFor(() => errors(f).length === 4);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(errors(f).length, 4);
  passThrough(f.agents.launchDetails(id).binDir);
  // A later change syncs as usual again.
  f.store.list = list;
  await f.grants.set(record, [hostA.id]);
  assert.equal(await f.agents.sync(record), "written");
});

test("a failing prepare launches without the agent and reports it", async (t) => {
  const f = fixture(t);
  const broken = new SessionSshAgents({
    ...f.deps,
    store: {
      list: () => {
        throw new Error("catalog unreadable");
      },
    },
  });
  f.started.push(broken);
  const request = input();
  assert.deepEqual(await broken.prepare(request), request.launch);
  assert.equal(broken.launchDetails(request.id), null);
  assert.equal(fs.existsSync(sessionFolder(f.dataDir, request.id)), false);
  assert.deepEqual(broken.status({ id: request.id, status: "running", tool: "claude" }), {
    state: "unavailable",
    reason: "failed",
    aliases: {},
  });
  assert.deepEqual(errors(f).at(-1), [
    "error",
    "Session SSH agent could not be started:",
    "error",
  ]);
});

test("restore uses the binaries recorded at launch; a missing ssh stops only its session", async (t) => {
  const f = fixture(t);
  const kept = await launch(f);
  const gone = await launch(f);
  await f.grants.set(kept.record, [hostA.id]);
  const binaries = f.agents.launchDetails(kept.id).binaries;
  await f.agents.close();
  // The second record names an ssh that no longer exists.
  const missing = path.join(root, `missing-${randomUUID()}`, "ssh");
  f.save({
    ...gone.record,
    sshAgent: { ...gone.record.sshAgent, binaries: { ssh: missing } },
  });
  const again = new SessionSshAgents(f.deps);
  f.started.push(again);
  const pathEnv = process.env.PATH;
  // The server's own PATH has no ssh: only the recorded binaries can serve.
  process.env.PATH = path.join(root, "empty");
  try {
    await again.restore();
  } finally {
    process.env.PATH = pathEnv;
  }
  assert.deepEqual(again.launchDetails(kept.id).binaries, binaries);
  assert.equal((await identitiesAt(again.launchDetails(kept.id).socketPath)).length, 1);
  assert.equal(again.launchDetails(gone.id), null);
  assert.equal(again.status(gone.record).reason, "no-openssh");
  // Gone binaries are resolved again from PATH when it has ssh.
  const third = new SessionSshAgents(f.deps);
  f.started.push(third);
  await again.close();
  await third.restore();
  assert.ok(third.launchDetails(gone.id).binaries.ssh.endsWith("/ssh"));
});

test("a discard while a sync waits wins: nothing is written afterwards", async (t) => {
  const f = fixture(t);
  const { id, record } = await launch(f);
  await f.grants.set(record, [hostA.id]);
  const gate = deferred();
  const effective = f.grants.effective;
  f.grants.effective = async (session) => {
    await gate.promise;
    return effective(session);
  };
  const syncing = f.agents.sync(record);
  const discarding = f.agents.discard(id);
  const later = f.agents.sync(record);
  gate.resolve();
  assert.equal(await syncing, "written");
  await discarding;
  assert.equal(await later, "unchanged");
  assert.equal(fs.existsSync(sessionFolder(f.dataDir, id)), false);
  assert.equal(f.agents.launchDetails(id), null);
});

test("of two concurrent prepares for one id the later generation is live", async (t) => {
  const f = fixture(t);
  const id = randomUUID();
  f.ids.push(id);
  const request = { id, account: { id: "account-1", tool: "claude" }, launch: base() };
  const [first, second] = await Promise.all([
    f.agents.prepare(request),
    f.agents.prepare(request),
  ]);
  assert.equal(first.sshAgent.token, second.sshAgent.token);
  assert.notEqual(first.sshAgent.generation, second.sshAgent.generation);
  assert.equal(f.agents.launchDetails(id).generation, second.sshAgent.generation);
  const record = { id, tool: "claude", status: "running", sshTools: second.sshTools };
  await f.grants.set(record, [hostA.id]);
  const socketPath = f.agents.launchDetails(id).socketPath;
  f.save({ ...record, sshAgent: first.sshAgent });
  assert.deepEqual(await identitiesAt(socketPath), []);
  f.save({ ...record, sshAgent: second.sshAgent });
  assert.equal((await identitiesAt(socketPath)).length, 1);
});

test("a prepare after a discard starts a listener that a stopped record never unlocks", async (t) => {
  const f = fixture(t);
  const { id, record } = await launch(f);
  await f.grants.set(record, [hostA.id]);
  await f.agents.discard(id);
  f.save({ ...record, status: "stopped" });
  const again = await f.agents.prepare({
    id,
    account: { id: "account-1", tool: "claude" },
    launch: base(),
  });
  const socketPath = f.agents.launchDetails(id).socketPath;
  f.save({ ...record, status: "stopped", sshAgent: again.sshAgent });
  assert.deepEqual(await identitiesAt(socketPath), []);
  assert.equal(f.agents.status({ ...record, status: "stopped" }).state, "unavailable");
});
