import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SessionAgentGrants,
  talkEligible,
} from "../../server/features/session-talk/session-agent-grants.js";

const running = (extra = {}) => ({
  id: "session-1",
  createdAt: "2026-11-13T10:00:00.000Z",
  tool: "codex",
  status: "running",
  ...extra,
});

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-talk-grants-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const grants = new SessionAgentGrants({ dataDir });
  const changes = [];
  grants.onChange = (id) => changes.push(id);
  return { dataDir, grants, changes };
}

test("set stores and assigned reads the ids", (t) => {
  const { grants, changes } = fixture(t);
  const session = running();
  assert.deepEqual(grants.assigned(session), []);
  assert.deepEqual(grants.set(session, ["agent-b", "agent-a"]), ["agent-b", "agent-a"]);
  assert.deepEqual(grants.assigned(session), ["agent-b", "agent-a"]);
  assert.deepEqual(changes, ["session-1"]);
  const mode = fs.statSync(grants.file(session.id)).mode & 0o777;
  assert.equal(mode, 0o600);
  // An empty list removes the file.
  assert.deepEqual(grants.set(session, []), []);
  assert.equal(fs.existsSync(grants.file(session.id)), false);
  assert.deepEqual(grants.assigned(session), []);
});

test("a session with another createdAt sees no grant", (t) => {
  const { grants } = fixture(t);
  grants.set(running(), ["agent-a"]);
  assert.deepEqual(
    grants.assigned(running({ createdAt: "2026-11-14T10:00:00.000Z" })),
    [],
  );
  assert.deepEqual(grants.assigned(running({ id: "session-2" })), []);
});

test("stop discards", (t) => {
  const { grants, changes } = fixture(t);
  const session = running();
  grants.set(session, ["agent-a"]);
  changes.length = 0;
  grants.discard(session.id);
  assert.deepEqual(grants.assigned(session), []);
  assert.deepEqual(changes, ["session-1"]);
  // A failing listener never fails the discard.
  grants.onChange = () => {
    throw new Error("listener");
  };
  const original = console.error;
  console.error = () => {};
  t.after(() => (console.error = original));
  grants.discard(session.id);
});

test("ineligible sessions are refused", (t) => {
  const { grants } = fixture(t);
  for (const session of [
    running({ purpose: "login" }),
    running({ pipeline: { runId: "r" } }),
    running({ tool: "shell" }),
    running({ status: "stopped" }),
    running({ imported: { historyOnly: true } }),
  ]) {
    assert.equal(talkEligible(session), false);
    assert.throws(() => grants.set(session, ["agent-a"]), { status: 409 });
  }
  for (const tool of ["claude", "codex", "opencode"])
    assert.equal(talkEligible(running({ tool })), true);
  assert.equal(talkEligible(null), false);
});

test("validate refuses 21 ids and duplicates", (t) => {
  const { grants } = fixture(t);
  const ids = Array.from({ length: 20 }, (_, i) => `agent-${i}`);
  assert.deepEqual(grants.validate(ids), ids);
  assert.deepEqual(grants.validate(undefined), []);
  for (const value of [
    [...ids, "agent-20"],
    ["agent-a", "agent-a"],
    "agent-a",
    [""],
    ["-leading"],
    ["a".repeat(101)],
    ["bad/slash"],
    [1],
  ])
    assert.throws(() => grants.validate(value), { status: 400 });
  assert.deepEqual(grants.validate(["a".repeat(100)]), ["a".repeat(100)]);
});
