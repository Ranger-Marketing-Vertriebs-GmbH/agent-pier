import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runtimePaths } from "../../server/features/assistants/runtime-paths.js";
import { prepareRuntimeConfig } from "../../server/features/assistants/runtime-config.js";
import { readJSON } from "../../server/lib/storage.js";
import { validateDefinition } from "../../server/features/assistants/assistant-validation.js";
import {
  heartbeatHours,
  heartbeatSchedule,
  heartbeatSettings,
} from "../../server/features/assistants/heartbeat-schedule.js";

const profile = (capabilities, extra = {}) => ({
  id: "a1",
  runtimeAgentId: "ap-a1",
  capabilities,
  ...extra,
});

function compile(t, teams) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proactivity-config-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const paths = runtimePaths(dir);
  prepareRuntimeConfig(paths, 1234, teams);
  return readJSON(paths.config);
}
const teams = (profiles) => ({
  directory: "/private/plugin",
  connection: { url: "http://127.0.0.1:1235", token: "teams" },
  hostMaxConcurrent: 8,
  native: { token: "native" },
  profiles,
});

test("session tools stay same-agent on every Gateway, native or not", (t) => {
  assert.deepEqual(compile(t).tools.sessions, { visibility: "agent" });
  assert.deepEqual(compile(t, teams([])).tools.sessions, { visibility: "agent" });
});

test("native Gateways keep proactive defaults off and recall unconfigured", (t) => {
  const config = compile(t, teams([profile({ memory: true, reminders: false })]));
  assert.ok(!config.plugins.allow.includes("active-memory"));
  assert.equal(config.plugins.entries["active-memory"], undefined);
  assert.equal(config.memory.search.rememberAcrossConversations, false);
  assert.deepEqual(config.agents.defaults.heartbeat, { every: "0m" });
  assert.equal(config.plugins.entries["memory-core"].config.dreaming.enabled, false);
  assert.equal(compile(t).plugins.allow, undefined);
});

test("heartbeat settings validate interval, active hours and time zone", () => {
  const heartbeat = {
    enabled: true,
    interval: "2h",
    start: 8,
    end: 20,
    timeZone: "Europe/Berlin",
  };
  assert.deepEqual(validateDefinition({ heartbeat }, true), { heartbeat });
  // Recall across conversations is not offered in this release.
  assert.throws(
    () =>
      validateDefinition(
        { capabilities: { memory: true, reminders: false, recall: true } },
        true,
      ),
    { status: 400 },
  );
  for (const invalid of [
    null,
    { ...heartbeat, interval: "30m" },
    { ...heartbeat, start: 20, end: 8 },
    { ...heartbeat, start: -1 },
    { ...heartbeat, end: 25 },
    { ...heartbeat, start: 1.5 },
    { ...heartbeat, timeZone: "Mars/Olympus" },
    { ...heartbeat, enabled: "yes" },
    { ...heartbeat, extra: true },
  ])
    assert.throws(() => validateDefinition({ heartbeat: invalid }, true), {
      status: 400,
    });
});

test("heartbeat schedules run within the active hours in the owner's time zone", () => {
  const base = { enabled: true, start: 8, end: 20, timeZone: "Europe/Berlin" };
  assert.deepEqual(heartbeatHours({ ...base, interval: "1h" }).length, 12);
  assert.deepEqual(heartbeatHours({ ...base, interval: "4h" }), [8, 12, 16]);
  assert.deepEqual(heartbeatHours({ ...base, interval: "daily" }), [8]);
  assert.deepEqual(heartbeatSchedule({ ...base, interval: "2h" }), {
    kind: "cron",
    expr: "0 8,10,12,14,16,18 * * *",
    tz: "Europe/Berlin",
  });
  // Defaults: off, every four hours, 9 to 18 in UTC until the owner saves a zone.
  assert.deepEqual(heartbeatSettings({}), {
    enabled: false,
    interval: "4h",
    start: 9,
    end: 18,
    timeZone: "UTC",
  });
  assert.equal(
    heartbeatSettings({ heartbeat: { ...base, interval: "1h" } }).enabled,
    true,
  );
});

test("the settings form's cost hint counts the runs the server schedules", async () => {
  const { heartbeatRuns } = await import("../../web/features/assistants/heartbeat.js");
  for (const interval of ["1h", "2h", "4h", "daily"])
    for (let start = 0; start < 24; start++)
      for (let end = start + 1; end <= 24; end++)
        assert.equal(
          heartbeatRuns({ interval, start, end }),
          heartbeatHours({ interval, start, end }).length,
          `${interval} ${start}-${end}`,
        );
});
