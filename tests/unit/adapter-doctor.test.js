import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  adapterCheck,
  adapterSessionChecks,
} from "../../server/features/operations/adapter-doctor.js";

const session = {
  id: "s1",
  name: "Refactor API",
  tool: "claude",
  status: "running",
  adapterGeneration: "g2",
  provider: { route: { mode: "adapter", source: "chatCompletions" } },
};
const snapshot = (extra = {}) => ({
  version: 1,
  generation: "g2",
  restarts: 0,
  requests: { "/v1/messages": 40, "/v1/messages/count_tokens": 3 },
  errors: {},
  upstreamStatus: { "2xx": 40 },
  dropped: {},
  compactionDropped: 0,
  capabilityFallbacks: {},
  estimatedUsage: 0,
  cacheReadTokens: 0,
  capabilities: {},
  ...extra,
});

test("a healthy adapter session is ok and counts requests", () => {
  const check = adapterCheck(session, snapshot());
  assert.equal(check.id, "adapter-session.s1");
  assert.equal(check.status, "ok");
  assert.match(check.summary, /Refactor API/);
  assert.match(check.summary, /Claude Code via adapter \(chatCompletions\)/);
  assert.match(check.summary, /43 request\(s\)/);
});

test("restarts, errors and dropped compaction items warn", () => {
  assert.equal(adapterCheck(session, snapshot({ restarts: 1 })).status, "warn");
  assert.equal(
    adapterCheck(session, snapshot({ errors: { rateLimit: 2 } })).status,
    "warn",
  );
  const compaction = adapterCheck(session, snapshot({ compactionDropped: 2 }));
  assert.equal(compaction.status, "warn");
  assert.match(compaction.summary, /compacted history/);
});

test("a supervisor give-up or start failure fails with a reload remedy", () => {
  const gaveUp = adapterCheck(
    session,
    snapshot({
      supervisor: {
        restarts: 3,
        lastReason: "exited",
        gaveUpAt: "2026-10-08T10:00:00.000Z",
      },
    }),
  );
  assert.equal(gaveUp.status, "fail");
  assert.match(gaveUp.summary, /stopped after 3 restart\(s\)/);
  assert.match(gaveUp.summary, /HTTP 503/);
  assert.match(gaveUp.remedy, /Reload the session/);
  const failed = adapterCheck(session, {
    version: 1,
    generation: "g2",
    supervisor: { startFailed: "timeout", at: "2026-10-08T10:00:00.000Z" },
  });
  assert.equal(failed.status, "fail");
  assert.match(failed.summary, /failed to start \(timeout\)/);
});

test("details hold counters only", () => {
  const { details } = adapterCheck(session, snapshot({ secret: "x", prompt: "y" }));
  assert.equal("secret" in details, false);
  assert.equal("prompt" in details, false);
  assert.deepEqual(details.requests, snapshot().requests);
});

test("running sessions and recent failures of the current generation are reported", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-adapter-doctor-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const dir = path.join(dataDir, "sessions");
  fs.mkdirSync(dir);
  const write = (name, value) =>
    fs.writeFileSync(path.join(dir, name), JSON.stringify(value));
  write("s1.json", session);
  write(
    "s1.adapter.json",
    snapshot({
      generation: "g1",
      supervisor: { gaveUpAt: "x", restarts: 3, lastReason: "exited" },
    }),
  );
  write("s2.json", { ...session, id: "s2", status: "stopped" });
  write(
    "s2.adapter.json",
    snapshot({ supervisor: { gaveUpAt: "x", restarts: 3, lastReason: "exited" } }),
  );
  write("s3.json", { ...session, id: "s3", adapterGeneration: undefined });
  write("s1.outcome.json", { unrelated: true });
  // A failed start ends the session, so its record is already stopped.
  const now = Date.parse("2026-10-08T12:00:00.000Z");
  const stoppedWith = (id, supervisor, generation = "g2") => {
    write(`${id}.json`, { ...session, id, status: "stopped" });
    write(`${id}.adapter.json`, { version: 1, generation, supervisor });
  };
  stoppedWith("s4", { startFailed: "spawn", at: "2026-10-08T11:00:00.000Z" });
  stoppedWith("s5", { startFailed: "spawn", at: "2026-10-06T11:00:00.000Z" });
  stoppedWith("s6", { startFailed: "spawn", at: "2026-10-08T11:00:00.000Z" }, "g1");
  stoppedWith("s7", { restarts: 3, gaveUpAt: "2026-10-08T09:00:00.000Z" });
  const before = fs.readdirSync(dir).sort();
  const checks = adapterSessionChecks(dataDir, { now });
  assert.deepEqual(
    checks.map((c) => [c.id, c.status]),
    [
      ["adapter-session.s1", "ok"],
      ["adapter-session.s4", "fail"],
      ["adapter-session.s7", "fail"],
    ],
  );
  assert.match(checks[1].summary, /failed to start \(spawn\)/);
  assert.match(checks[2].summary, /stopped after 3 restart/);
  assert.deepEqual(
    adapterSessionChecks(dataDir, { now: now + 2 * 24 * 60 * 60 * 1000 }).map(
      (c) => c.id,
    ),
    ["adapter-session.s1"],
    "failures older than a day are no longer reported",
  );
  assert.match(checks[0].summary, /no requests recorded/);
  assert.deepEqual(fs.readdirSync(dir).sort(), before, "the doctor writes nothing");
  assert.deepEqual(adapterSessionChecks(path.join(dataDir, "missing")), []);
});

test("unexpected strings in snapshot objects never reach the report", () => {
  const leak = "sk-leak-probe-0123456789";
  const known = {
    route: { client: "messages", upstream: "chatCompletions", note: leak },
    capabilities: {
      promptCacheKey: true,
      systemMessages: "inline",
      maxTokensField: leak,
      futureFlag: leak,
    },
    errors: { rateLimit: 1, [leak + " with spaces"]: 2, nested: { message: leak } },
    startedAt: leak,
  };
  const healthy = adapterCheck(session, snapshot(known));
  assert.equal(JSON.stringify(healthy).includes("leak-probe"), false);
  assert.deepEqual(healthy.details.route, {
    client: "messages",
    upstream: "chatCompletions",
  });
  assert.deepEqual(healthy.details.capabilities, {
    promptCacheKey: true,
    systemMessages: "inline",
  });
  assert.deepEqual(healthy.details.errors, { rateLimit: 1, nested: {} });
  for (const supervisor of [
    { restarts: 3, lastReason: leak, gaveUpAt: leak, extra: leak },
    { startFailed: leak, at: leak },
  ]) {
    const check = adapterCheck(
      { ...session, tool: leak, provider: { route: { source: leak } } },
      snapshot({ ...known, supervisor }),
    );
    assert.equal(check.status, "fail");
    assert.equal(JSON.stringify(check).includes("leak-probe"), false);
  }
});
