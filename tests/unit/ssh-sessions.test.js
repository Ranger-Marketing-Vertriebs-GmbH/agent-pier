import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SshSessions } from "../../server/features/ssh/ssh-sessions.js";
import { createSshProjectBinding } from "../../server/features/ssh/ssh-project-scope.js";
import { writePrivate } from "../../server/lib/storage.js";

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-ssh-grants-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const accesses = [{ id: "server-one", name: "Lab", host: "192.0.2.1" }];
  const store = {
    list: () => accesses,
    get: (id) => {
      const item = accesses.find((item) => item.id === id);
      if (!item) throw Error("unknown access");
      return item;
    },
    connection: () => ({ command: "ssh", args: ["-F", "/dev/null", "192.0.2.1"] }),
  };
  const session = {
    id: "session-one",
    accountId: "local-codex",
    tool: "codex",
    createdAt: "2026-09-08",
    status: "running",
  };
  const save = () =>
    writePrivate(path.join(dataDir, "sessions", `${session.id}.json`), session);
  save();
  return { dataDir, session, save, store, grants: new SshSessions({ dataDir, store }) };
}

test("live assignment works without launch mutation and revocation rejects the next invocation", async (t) => {
  const { grants, session, dataDir } = fixture(t);
  await assert.rejects(() => grants.resolve(session.id, "server-one"), /zugeordnet/);
  const original = fs.readFileSync(path.join(dataDir, "sessions", `${session.id}.json`));
  const result = await grants.set(session, ["server-one"]);
  assert.deepEqual(result.assignedIds, ["server-one"]);
  assert.match(result.commands[0].command, /ssh\.mjs/);
  assert.equal(result.commands[0].command.includes("PRIVATE KEY"), false);
  assert.deepEqual((await grants.resolve(session.id, "server-one")).args, [
    "-F",
    "/dev/null",
    "192.0.2.1",
  ]);
  assert.deepEqual(
    fs.readFileSync(path.join(dataDir, "sessions", `${session.id}.json`)),
    original,
  );
  await grants.set(session, []);
  await assert.rejects(() => grants.resolve(session.id, "server-one"), /zugeordnet/);
});

test("grants are identity bound and reject stopped, login, headless and malformed sessions", async (t) => {
  const { grants, session, save } = fixture(t);
  await grants.set(session, ["server-one"]);
  session.createdAt = "reused";
  save();
  await assert.rejects(() => grants.resolve(session.id, "server-one"), /zugeordnet/);
  session.status = "stopped";
  save();
  await assert.rejects(() => grants.resolve(session.id, "server-one"), /laufenden/);
  for (const change of [{ purpose: "login" }, { pipeline: { headless: true } }]) {
    assert.throws(() =>
      grants.set({ ...session, status: "running", ...change }, ["server-one"]),
    );
  }
  await assert.rejects(() => grants.resolve("../../escape", "server-one"));
  assert.throws(() => grants.validate(["server-one", "server-one"]));
  assert.throws(() => grants.validate(["missing"]));
});

test("restart retains grants, removal drops access from every session, owner-only files", async (t) => {
  const { grants, session, dataDir, store } = fixture(t);
  await grants.set(session, ["server-one"]);
  const next = new SshSessions({ dataDir, store });
  assert.deepEqual((await next.get(session)).assignedIds, ["server-one"]);
  const file = path.join(dataDir, "ssh", "grants", `${session.id}.json`);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  next.revokeAccess("server-one");
  assert.deepEqual((await grants.get(session)).assignedIds, []);
  await grants.set(session, ["server-one"]);
  grants.discard(session.id);
  await assert.rejects(() => grants.resolve(session.id, "server-one"));
});

test("project grants are dynamic and deduplicate explicit grants", async (t) => {
  const { grants, session, dataDir, store, save } = fixture(t);
  session.sshTools = { project: await createSshProjectBinding(dataDir) };
  save();
  const hosts = store.list();
  hosts.push({ id: "project-host", projectId: session.sshTools.project.projectId });
  await grants.set(session, ["server-one", "project-host"]);
  assert.deepEqual(await grants.effective(session), ["server-one", "project-host"]);
  assert.deepEqual((await grants.get(session)).inheritedIds, ["project-host"]);
  await grants.set(session, ["server-one"]);
  assert.deepEqual(await grants.effective(session), ["server-one", "project-host"]);
  hosts[1].projectId = "foreign";
  assert.deepEqual(await grants.effective(session), ["server-one"]);
  hosts[1].projectId = session.sshTools.project.projectId;
  session.sshTools.project.launch.ino = "replaced";
  await assert.rejects(grants.effective(session), { code: "SSH_PROJECT_CHANGED" });
});

test("resolution rechecks session and grants after asynchronous project discovery", async (t) => {
  const { grants, session, save } = fixture(t);
  await grants.set(session, ["server-one"]);
  const effective = grants.effective.bind(grants);
  grants.effective = async (live) => {
    const ids = await effective(live);
    session.status = "stopped";
    save();
    return ids;
  };
  await assert.rejects(grants.resolve(session.id, "server-one"), /laufenden/);
  session.status = "running";
  save();
  grants.effective = async (live) => {
    const ids = await effective(live);
    grants.discard(session.id);
    return ids;
  };
  await assert.rejects(grants.resolve(session.id, "server-one"), /zugeordnet/);
});

test("inspection remains available for stopped or excluded sessions without inherited grants", async (t) => {
  const { grants, session, dataDir, store, save } = fixture(t);
  session.sshTools = { project: await createSshProjectBinding(dataDir) };
  store
    .list()
    .push({ id: "project-host", projectId: session.sshTools.project.projectId });
  await grants.set(session, ["server-one"]);
  grants.discard(session.id);
  for (const change of [
    { status: "stopped" },
    { purpose: "login" },
    { pipeline: { headless: true } },
    { tool: "unsupported" },
  ]) {
    const excluded = { ...session, ...change };
    const result = await grants.get(excluded);
    assert.deepEqual(result.assignedIds, []);
    assert.deepEqual(result.inheritedIds, []);
    assert.deepEqual(result.commands, []);
    assert.equal(result.accesses.length, 2);
    assert.throws(() => grants.set(excluded, ["server-one"]), /laufenden/);
    await assert.rejects(grants.effective(excluded), /laufenden/);
  }
  session.status = "stopped";
  save();
  await assert.rejects(grants.resolve(session.id, "project-host"), /laufenden/);
});
