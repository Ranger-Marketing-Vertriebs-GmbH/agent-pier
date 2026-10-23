import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PendingRestart } from "../../server/features/assistants/pending-restart.js";

function fixture(t, { blockers = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pending-restart-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = Object.assign(new EventEmitter(), {
    paths: { root },
    client: { ready: true },
    generationId: "g1",
  });
  const calls = [];
  const state = { blockers };
  const synchronization = {
    restartGateway: async (operation, options) => {
      calls.push(options);
      if (state.blockers.length)
        throw Object.assign(new Error("busy"), {
          status: 409,
          key: "active",
          blockers: state.blockers,
        });
      await operation();
      runtime.generationId = `g${calls.length + 1}`;
      runtime.emit("status", { availability: "ready" });
    },
  };
  let changes = 0;
  const assistants = { runtime, changed: () => changes++ };
  const make = () => {
    const pending = new PendingRestart({ assistants, synchronization, retryMs: 5 });
    t.after(() => pending.close());
    return pending;
  };
  return {
    root,
    runtime,
    calls,
    state,
    make,
    changes: () => changes,
    file: path.join(root, "pending-restart.json"),
  };
}
const until = async (check) => {
  for (let n = 0; n < 200 && !check(); n++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(check());
};

test("a saved change records the restart and runs it as soon as nothing is busy", async (t) => {
  const f = fixture(t, { blockers: ["ASSISTANT_WORK"] });
  const pending = f.make();
  const ana = { agents: [{ id: "a", name: "Ana" }], teamMembers: 1 };
  assert.equal(pending.request("webSearch", ana), true);
  pending.request("connection", { agents: [{ id: "b", name: "Ben" }], teamMembers: 0 });
  assert.deepEqual(pending.status().reasons, ["webSearch", "connection"]);
  assert.deepEqual(pending.status().affected, {
    agents: [
      { id: "a", name: "Ana" },
      { id: "b", name: "Ben" },
    ],
    teamMembers: 1,
  });
  // Persisted at once, without anything secret.
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file, "utf8")).reasons, [
    "webSearch",
    "connection",
  ]);
  // Busy: it waits and says for what.
  await until(() => pending.status()?.waitingFor?.includes("ASSISTANT_WORK"));
  assert.ok(f.calls.length >= 1);
  assert.equal(f.calls[0].force, false);
  // Idle again: the next try restarts and ends it.
  f.state.blockers = [];
  await until(() => pending.status() === null);
  assert.equal(fs.existsSync(f.file), false);
  assert.ok(f.changes() > 0);
});

test("a stopped Gateway records nothing: its next start compiles the change", (t) => {
  const f = fixture(t);
  f.runtime.client.ready = false;
  const pending = f.make();
  assert.equal(pending.request("pdfModel"), false);
  assert.equal(pending.status(), null);
  assert.equal(fs.existsSync(f.file), false);
});

test("a pending restart survives AgentPier and ends with the next Gateway start", async (t) => {
  const f = fixture(t, { blockers: ["TEAM_WORK"] });
  const first = f.make();
  first.request("telegram", { agents: [], teamMembers: 0 });
  first.close();
  // The next process loads it, still for the Gateway generation it was saved for.
  const second = f.make();
  assert.deepEqual(second.status().reasons, ["telegram"]);
  second.settle();
  assert.deepEqual(second.status().reasons, ["telegram"]);
  // A Gateway of another generation is ready: it compiled every saved change.
  f.runtime.generationId = "g-next";
  f.runtime.emit("status", { availability: "ready" });
  assert.equal(second.status(), null);
  assert.equal(fs.existsSync(f.file), false);
});

test("restart now runs at once and interrupts agent work", async (t) => {
  const f = fixture(t, { blockers: ["ACCOUNT_LOGIN"] });
  const pending = f.make();
  pending.request("connection", { agents: [], teamMembers: 0 });
  pending.close();
  // A sign-in in progress still refuses, with the reason.
  await assert.rejects(pending.restartNow(), { key: "active" });
  assert.deepEqual(pending.status().waitingFor, ["ACCOUNT_LOGIN"]);
  f.state.blockers = [];
  assert.deepEqual(await pending.restartNow(), { restarted: true });
  assert.equal(f.calls.at(-1).force, true);
  assert.equal(pending.status(), null);
  // Nothing pending: nothing runs.
  assert.equal(await pending.restartNow(), null);
});
