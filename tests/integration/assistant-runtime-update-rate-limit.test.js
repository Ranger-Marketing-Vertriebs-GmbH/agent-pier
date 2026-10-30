import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RuntimeUpdates } from "../../server/features/assistants/runtime-updates.js";
import { AssistantMaintenance } from "../../server/features/assistants/assistant-maintenance.js";
import { runtimePaths } from "../../server/features/assistants/runtime-paths.js";
import { readJSON, writePrivate } from "../../server/lib/storage.js";

// OpenClaw 2026.10 admits 30 config.patch a minute per connection and refuses the
// rest before any write. An activation pauses the scheduler with one config.patch;
// these Gateways refuse that patch as OpenClaw does (UNAVAILABLE, retryable,
// retryAfterMs) a given number of times.
function fixture(t, { refusals = 0, retryAfterMs = 300 } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-update-limit-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const paths = runtimePaths(dataDir);
  writePrivate(paths.config, { cron: { enabled: true } });
  writePrivate(path.join(paths.root, "runtime.json"), {
    version: "old",
    nodeVersion: "n",
  });
  fs.writeFileSync(path.join(paths.state, "history"), "before");
  const patches = [];
  let refused = 0;
  const client = {
    ready: true,
    async call(method, input) {
      if (method === "config.get") return { hash: "h", config: readJSON(paths.config) };
      if (method === "config.patch") {
        patches.push({ at: Date.now(), raw: input.raw });
        if (refused < refusals) {
          refused++;
          throw Object.assign(Error("rate limit exceeded for config.patch"), {
            code: "UNAVAILABLE",
            answered: true,
            retryable: true,
            retryAfterMs,
          });
        }
        const config = readJSON(paths.config);
        config.cron.enabled = JSON.parse(input.raw).cron.enabled;
        writePrivate(paths.config, config);
        return {};
      }
      if (method === "cron.status")
        return { enabled: readJSON(paths.config).cron.enabled };
      if (method === "agents.list") return { agents: [] };
      assert.fail(method);
    },
  };
  const runtime = {
    paths,
    client,
    generation: 1,
    running: true,
    stops: 0,
    status() {
      return { availability: this.running ? "ready" : "disabled" };
    },
    async stop() {
      this.stops++;
      this.running = false;
    },
    async start() {
      this.generation++;
      this.running = true;
    },
  };
  const counts = { paused: 0, resumed: 0, resets: 0, readies: 0 };
  const channelWork = [];
  const services = {
    assistants: {
      locks: new Map(),
      ledger: { pending: () => [] },
      store: { listAssistants: () => [], listConversations: () => [] },
      reconcile: async () => {},
      config: { reset: () => counts.resets++ },
      gatewayEvents: { ready: () => counts.readies++ },
    },
    assistantChannels: {
      pause: async () => counts.paused++,
      resume: () => counts.resumed++,
      store: { list: () => [{ id: "telegram" }] },
      ledger: { active: () => channelWork },
      outbox: { pending: () => [] },
    },
    assistantRuntime: runtime,
  };
  const updates = new RuntimeUpdates({
    dataDir,
    runtime,
    maintenance: new AssistantMaintenance(services),
    stage: async () => ({ version: "target", nodeVersion: "n" }),
    migrate: async () => {},
    freeSpace: async () => Number.MAX_SAFE_INTEGER,
  });
  return { paths, patches, runtime, services, counts, channelWork, updates };
}

function assertLeftCleanly(f) {
  assert.equal(f.services.assistants.maintenance, false);
  assert.ok(f.counts.resumed >= 1, "channel work resumes");
  assert.equal(readJSON(f.paths.config).cron.enabled, true, "the scheduler runs again");
  assert.equal(fs.existsSync(path.join(f.paths.root, "runtime-maintenance.json")), false);
}

test("an activation whose scheduler pause is rate-limited waits for the Gateway, then completes", async (t) => {
  const f = fixture(t, { refusals: 1, retryAfterMs: 300 });
  await f.updates.stage();
  const started = Date.now();
  const status = await f.updates.activate();
  assert.equal(status.phase, "complete");
  assert.equal(status.diagnostic, null);
  // Refused, sent again after the asked wait (not before), then restored.
  assert.equal(f.patches.length, 3);
  assert.ok(f.patches[1].at - f.patches[0].at >= 290, "the retry honours retryAfterMs");
  assert.ok(Date.now() - started < 5000);
  assertLeftCleanly(f);
  // The Gateway restarted on the new version: its compile is new, so agents re-apply.
  assert.equal(f.counts.resets, 1);
});

test("a persistent rate limit fails the activation as such, without a loop, and leaves maintenance", async (t) => {
  // A wait longer than the bound is never started (live-patch.js).
  const f = fixture(t, { refusals: Infinity, retryAfterMs: 70000 });
  await f.updates.stage();
  const started = Date.now();
  await assert.rejects(f.updates.activate(), {
    code: "UPDATE_CONFIG_BUSY",
    status: 503,
  });
  assert.ok(Date.now() - started < 2000);
  // One refused pause; the restore finds the scheduler still on and sends nothing.
  assert.equal(f.patches.length, 1);
  const status = f.updates.status();
  assert.equal(status.phase, "staged");
  assert.equal(status.diagnostic, "UPDATE_CONFIG_BUSY");
  assert.deepEqual(status.blockers, []);
  assert.equal(f.runtime.stops, 0, "the running version was never stopped");
  assertLeftCleanly(f);
  // The Gateway kept running: no recompile of every agent spends its write budget.
  assert.equal(f.counts.resets, 0);
  assert.equal(f.counts.readies, 1);
});

test("UPDATE_BLOCKED names its blockers and leaves the Gateway's write budget alone", async (t) => {
  const f = fixture(t);
  await f.updates.stage();
  f.channelWork.push({ state: "model_reviewed" });
  await assert.rejects(f.updates.activate(), { code: "UPDATE_BLOCKED", status: 409 });
  const status = f.updates.status();
  assert.equal(status.diagnostic, "UPDATE_BLOCKED");
  assert.deepEqual(status.blockers, ["CHANNEL_WORK"]);
  // Pause and restore only: two config.patch, no recompile of every agent.
  assert.equal(f.patches.length, 2);
  assert.equal(f.counts.resets, 0);
  assertLeftCleanly(f);
  // Once the input is reviewed the next activation goes through.
  f.channelWork.length = 0;
  assert.equal((await f.updates.activate()).phase, "complete");
});

test("every activation failure before the stop records a diagnostic that matches its blockers", async (t) => {
  const f = fixture(t);
  await f.updates.stage();
  // Dropping half-written videos fails before maintenance captured anything.
  f.services.assistants.attachments = {
    videos: {
      dropAll: async () => {
        throw Error("private /host/path");
      },
    },
  };
  await assert.rejects(f.updates.activate(), { code: "UPDATE_PREPARE_FAILED" });
  const status = f.updates.status();
  assert.equal(status.diagnostic, "UPDATE_PREPARE_FAILED");
  assert.deepEqual(status.blockers, []);
  assert.equal(f.runtime.stops, 0);
  assertLeftCleanly(f);
});
