import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SshSessions } from "../../server/features/ssh/ssh-sessions.js";
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

test("live assignment works without launch mutation and revocation rejects the next invocation", (t) => {
  const { grants, session, dataDir } = fixture(t);
  assert.throws(() => grants.resolve(session.id, "server-one"), /zugeordnet/);
  const original = fs.readFileSync(path.join(dataDir, "sessions", `${session.id}.json`));
  const result = grants.set(session, ["server-one"]);
  assert.deepEqual(result.assignedIds, ["server-one"]);
  assert.match(result.commands[0].command, /ssh\.mjs/);
  assert.equal(result.commands[0].command.includes("PRIVATE KEY"), false);
  assert.deepEqual(grants.resolve(session.id, "server-one").args, [
    "-F",
    "/dev/null",
    "192.0.2.1",
  ]);
  assert.deepEqual(
    fs.readFileSync(path.join(dataDir, "sessions", `${session.id}.json`)),
    original,
  );
  grants.set(session, []);
  assert.throws(() => grants.resolve(session.id, "server-one"), /zugeordnet/);
});

test("grants are identity bound and reject stopped, login, headless and malformed sessions", (t) => {
  const { grants, session, save } = fixture(t);
  grants.set(session, ["server-one"]);
  session.createdAt = "reused";
  save();
  assert.throws(() => grants.resolve(session.id, "server-one"), /zugeordnet/);
  session.status = "stopped";
  save();
  assert.throws(() => grants.resolve(session.id, "server-one"), /laufenden/);
  for (const change of [{ purpose: "login" }, { pipeline: { headless: true } }]) {
    assert.throws(() =>
      grants.set({ ...session, status: "running", ...change }, ["server-one"]),
    );
  }
  assert.throws(() => grants.resolve("../../escape", "server-one"));
  assert.throws(() => grants.validate(["server-one", "server-one"]));
  assert.throws(() => grants.validate(["missing"]));
});

test("restart retains grants, removal drops access from every session, owner-only files", (t) => {
  const { grants, session, dataDir, store } = fixture(t);
  grants.set(session, ["server-one"]);
  const next = new SshSessions({ dataDir, store });
  assert.deepEqual(next.get(session).assignedIds, ["server-one"]);
  const file = path.join(dataDir, "ssh", "grants", `${session.id}.json`);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  next.revokeAccess("server-one");
  assert.deepEqual(grants.get(session).assignedIds, []);
  grants.set(session, ["server-one"]);
  grants.discard(session.id);
  assert.throws(() => grants.resolve(session.id, "server-one"));
});
