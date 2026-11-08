import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  advancedEntries,
  advancedHome,
  hermesAdvancedRuntime,
  hermesAdvancedSettings,
  homeZone,
} from "../../server/features/assistants/runtimes/hermes/hermes-config/advanced.js";
import { compileHome } from "../../server/features/assistants/runtimes/hermes/hermes-config/home.js";
import { readHermesConfig } from "../../server/features/assistants/runtimes/hermes/hermes-config/home-merge.js";
import { writeHermesHome } from "../../server/features/assistants/runtimes/hermes/hermes-config/home-writer.js";
import { desiredAgent } from "../../server/features/assistants/agent-desired-state.js";
import { advancedSettings } from "../../server/features/assistants/runtimes/openclaw/openclaw-config/advanced-settings.js";
import { hermesFakeRuntime } from "../helpers/hermes-fake-runtime.js";
import { createHermesRuntime } from "../../server/features/assistants/runtimes/hermes/hermes-runtime.js";

const manifest = JSON.parse(
  fs.readFileSync(
    path.resolve(
      import.meta.dirname,
      "../../server/features/assistants/runtimes/hermes/hermes-manifest.json",
    ),
    "utf8",
  ),
);
const approved = (values) => ({ version: hermesAdvancedRuntime, values });
const entries = (advanced) =>
  Object.fromEntries(advancedEntries(advanced).map(([keys, v]) => [keys.join("."), v]));

test("the Hermes mapping is approved for the pinned Hermes version only", () => {
  // A Hermes update reviews every mapped key against the new version first.
  assert.equal(hermesAdvancedRuntime, manifest.version);
});

test("only settings with a Hermes equivalent map, each to its Hermes key", () => {
  const ids = new Set(advancedSettings.map((s) => s.id));
  for (const setting of hermesAdvancedSettings.list) assert.ok(ids.has(setting.id));
  assert.deepEqual(
    hermesAdvancedSettings.list.map((s) => s.id),
    ["thinkingDefault", "userTimezone"],
  );
  for (const id of ["runTimeout", "imageQuality", "imageMaxDimension", "mediaRetention"])
    assert.equal(hermesAdvancedSettings.byId(id), undefined, id);
  assert.equal(hermesAdvancedSettings.byPath("timezone").id, "userTimezone");
});

test("no advanced key reaches access, approvals, toolsets, plugins or management", () => {
  const guarded =
    /^(?:approvals|agent\.disabled_toolsets|toolsets|plugins|platform_toolsets|security|auth|delegation|mcp_servers|terminal|browser|model|providers|command_allowlist|gateway|updates|skills|memory)(?:\.|$)/;
  for (const { path: key } of hermesAdvancedSettings.list)
    assert.doesNotMatch(key, guarded, key);
  assert.throws(() => hermesAdvancedSettings.validate("approvals.mode", "off"));
  assert.throws(() => hermesAdvancedSettings.validate("timezone", "../etc"));
});

test("the thinking level maps to Hermes's reasoning effort", () => {
  const effort = (level) =>
    entries(approved({ thinkingDefault: level }))["agent.reasoning_effort"];
  assert.equal(effort("off"), "none");
  for (const level of ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"])
    assert.equal(effort(level), level);
  // Hermes has no adaptive level: its own default applies.
  assert.equal(effort("adaptive"), undefined);
  assert.equal(effort("bogus"), undefined);
});

test("the time zone maps to Hermes's clock zone", () => {
  assert.equal(entries(approved({ userTimezone: "Asia/Tokyo" })).timezone, "Asia/Tokyo");
  assert.equal(entries(approved({ userTimezone: "not a zone" })).timezone, undefined);
});

test("unset or unapproved values remove the keys; unknown values leave them", () => {
  assert.deepEqual(entries(approved({})), {
    "agent.reasoning_effort": undefined,
    timezone: undefined,
  });
  assert.deepEqual(entries({ version: "0.23.0", values: { thinkingDefault: "high" } }), {
    "agent.reasoning_effort": undefined,
    timezone: undefined,
  });
  assert.deepEqual(advancedEntries(undefined), []);
});

test("a compiled home carries the settings and an unapproved one drops them", () => {
  const agent = desiredAgent({ id: "a1", name: "A", runtimeAgentId: "ap-a1" });
  const values = { thinkingDefault: "high", userTimezone: "Europe/Berlin" };
  const config = (advanced, existing) =>
    readHermesConfig(compileHome(agent, { advanced, existing }).files["config.yaml"]);
  const set = config(approved(values));
  assert.equal(set.agent.reasoning_effort, "high");
  assert.equal(set.timezone, "Europe/Berlin");
  const written = {
    "config.yaml": compileHome(agent, { advanced: approved(values) }).files[
      "config.yaml"
    ],
  };
  const other = config({ version: "0.23.0", values }, written);
  assert.equal(other.agent.reasoning_effort, undefined);
  assert.equal(other.timezone, undefined);
  // Without the owner's values the keys stay as they were.
  assert.equal(config(undefined, written).timezone, "Europe/Berlin");
});

test("a start without a desired state writes only the advanced keys into a home", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-advanced-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const advanced = approved({ userTimezone: "Asia/Tokyo" });
  // No config.yaml yet: nothing is written, a first start writes the whole home.
  assert.deepEqual(writeHermesHome(dir, advancedHome(advanced, { hermesHome: dir })), []);
  assert.equal(homeZone(dir), null);
  fs.writeFileSync(path.join(dir, "config.yaml"), "_config_version: 7\ntimezone: UTC\n");
  assert.deepEqual(writeHermesHome(dir, advancedHome(advanced, { hermesHome: dir })), [
    "config.yaml",
  ]);
  const config = readHermesConfig(fs.readFileSync(path.join(dir, "config.yaml"), "utf8"));
  assert.equal(config._config_version, 7);
  assert.equal(homeZone(dir), "Asia/Tokyo");
  writeHermesHome(
    dir,
    advancedHome({ version: "0.23.0", values: {} }, { hermesHome: dir }),
  );
  assert.equal(homeZone(dir), null);
});

test("each start compiles the owner's settings, also without a desired state", async (t) => {
  const fake = hermesFakeRuntime(t);
  let values = { userTimezone: "Asia/Tokyo", thinkingDefault: "off" };
  const made = createHermesRuntime({
    dataDir: fake.dataDir,
    agentId: "agent-1",
    runtime: async () => ({ ...fake.runtime, version: hermesAdvancedRuntime }),
    stopTimeoutMs: 3000,
    advanced: () => values,
  });
  t.after(() => made.supervisor.stop());
  const home = made.supervisor.agentPaths().hermesHome;
  fs.writeFileSync(path.join(home, "config.yaml"), "_config_version: 7\n");
  await made.runtime.host.start();
  const read = () =>
    readHermesConfig(fs.readFileSync(path.join(home, "config.yaml"), "utf8"));
  assert.equal(read().timezone, "Asia/Tokyo");
  assert.equal(read().agent.reasoning_effort, "none");
  values = {};
  await made.runtime.host.restart();
  assert.equal(read().timezone, undefined);
  assert.equal(read().agent?.reasoning_effort, undefined);
});
