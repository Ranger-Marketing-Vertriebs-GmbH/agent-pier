import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import {
  PendingRestart,
  updateBlocked,
} from "../../server/features/assistants/pending-restart.js";

function fixture(t, { blockers = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pending-restart-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = Object.assign(new EventEmitter(), {
    paths: { root },
    client: { ready: true },
    availability: "ready",
    status: () => ({ availability: runtime.availability }),
    generationId: "g1",
  });
  const calls = [];
  const state = { blockers, inside: [], fail: null, entered: 0, gate: null };
  const synchronization = {
    // Read outside maintenance (assistant-provider-synchronization.js busy()).
    busy: async () => state.blockers,
    restartGateway: async (operation, options) => {
      calls.push(options);
      state.entered++;
      if (state.gate) await state.gate;
      const inside = options.force ? [] : state.inside;
      if (inside.length)
        throw Object.assign(new Error("busy"), {
          status: 409,
          key: "active",
          blockers: inside,
        });
      if (state.fail) throw state.fail;
      await operation();
      runtime.generationId = `g${calls.length + 1}`;
      runtime.emit("status", { availability: "ready" });
    },
  };
  let changes = 0;
  const warnings = [];
  const assistants = { runtime, changed: () => changes++ };
  const make = () => {
    const pending = new PendingRestart({
      assistants,
      synchronization,
      retryMs: 5,
      warn: (message) => warnings.push(message),
    });
    t.after(() => pending.close());
    return pending;
  };
  return {
    root,
    runtime,
    calls,
    state,
    make,
    warnings,
    changes: () => changes,
    file: path.join(root, "pending-restart.json"),
  };
}
const until = async (check) => {
  for (let n = 0; n < 200 && !check(); n++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(check());
};
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

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
  // Busy: it waits, says for what, and never enters maintenance to find out.
  await until(() => pending.status()?.waitingFor?.includes("ASSISTANT_WORK"));
  await pause(40);
  assert.equal(f.state.entered, 0);
  assert.equal(pending.status().running, false);
  assert.equal(pending.status().failed, false);
  // Idle again: the next try restarts and ends it.
  f.state.blockers = [];
  await until(() => pending.status() === null);
  assert.equal(f.calls[0].force, false);
  assert.equal(fs.existsSync(f.file), false);
  assert.ok(f.changes() > 0);
});

test("work that starts inside maintenance still refuses; a failure is logged and shown", async (t) => {
  const f = fixture(t);
  f.state.inside = ["SCHEDULED_WORK"];
  const pending = f.make();
  pending.request("pdfModel");
  await until(() => pending.status()?.waitingFor?.includes("SCHEDULED_WORK"));
  assert.deepEqual(f.warnings, []);
  f.state.inside = [];
  f.state.fail = Object.assign(new Error("private detail"), { code: "PROCESS_EXIT" });
  await until(() => pending.status()?.failed === true);
  assert.match(f.warnings[0], /PROCESS_EXIT/);
  assert.doesNotMatch(f.warnings[0], /private detail/);
  f.state.fail = null;
  await until(() => pending.status() === null);
});

test("restart now refused by an update or other maintenance waits instead of failing", async (t) => {
  const f = fixture(t);
  const pending = f.make();
  pending.request("webSearch");
  pending.close();
  f.state.fail = Object.assign(new Error("active"), { status: 409, key: "active" });
  await assert.rejects(pending.restartNow(), { key: "active" });
  assert.deepEqual(pending.status().waitingFor, ["active"]);
  assert.equal(pending.status().failed, false);
  assert.deepEqual(f.warnings, []);
});

test("a stopped Gateway records nothing; a starting one may have compiled too early", (t) => {
  const f = fixture(t);
  f.runtime.client.ready = false;
  f.runtime.availability = "disabled";
  const pending = f.make();
  assert.equal(pending.request("pdfModel"), false);
  assert.equal(pending.status(), null);
  assert.equal(fs.existsSync(f.file), false);
  // Saved between the start's compile and its ready: the change is kept.
  f.runtime.availability = "starting";
  assert.equal(pending.request("pdfModel"), true);
  assert.deepEqual(pending.status().reasons, ["pdfModel"]);
  // That start's own ready does not end it: it is the generation it was saved for.
  f.runtime.client.ready = true;
  f.runtime.emit("status", { availability: "ready" });
  assert.deepEqual(pending.status().reasons, ["pdfModel"]);
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

test("a try that missed the ready event of a newer Gateway ends without restarting", async (t) => {
  const f = fixture(t);
  const pending = f.make();
  pending.request("webTools");
  pending.close();
  f.runtime.generationId = "g-other";
  assert.equal(await pending.attempt(), null);
  assert.equal(pending.status(), null);
  assert.equal(f.state.entered, 0);
});

test("restart now runs at once, after an automatic try instead of joining it", async (t) => {
  const f = fixture(t, { blockers: ["ACCOUNT_LOGIN"] });
  const pending = f.make();
  pending.request("connection", { agents: [], teamMembers: 0 });
  pending.close();
  // An automatic try is under way and will stop at busy work inside maintenance.
  f.state.blockers = [];
  f.state.inside = ["ASSISTANT_WORK"];
  let open;
  f.state.gate = new Promise((r) => {
    open = r;
  });
  const automatic = pending.attempt();
  assert.equal(updateBlocked(null, pending), true);
  const now = pending.restartNow();
  open();
  await assert.rejects(automatic, { blockers: ["ASSISTANT_WORK"] });
  f.state.gate = null;
  assert.deepEqual(await now, { restarted: true });
  assert.deepEqual(
    f.calls.map((call) => call.force),
    [false, true],
  );
  assert.equal(pending.status(), null);
  assert.equal(updateBlocked(null, pending), false);
  assert.equal(updateBlocked({ changing: true }, pending), true);
  // Nothing pending: nothing runs.
  assert.equal(await pending.restartNow(), null);
});
