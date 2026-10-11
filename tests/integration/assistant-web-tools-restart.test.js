import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { AssistantService } from "../../server/features/assistants/assistant-service.js";
import { AssistantProviderSynchronization } from "../../server/features/assistants/assistant-provider-synchronization.js";
import { WebSearchSettings } from "../../server/features/assistants/web-search-settings.js";
import { WebToolsChanges } from "../../server/features/assistants/web-tools-changes.js";
import { runtimePaths } from "../../server/features/assistants/runtime-paths.js";
import { webToolsSnapshot } from "../../server/features/assistants/openclaw-config/web-tools.js";

const searchPlugins = {
  duckduckgo: { id: "duckduckgo", directory: "/rt/ddg" },
  brave: { id: "brave", directory: "/rt/brave" },
};
const browser = { available: true, executablePath: "/usr/bin/chromium" };
const model = { connectionId: "c", modelId: "m" };
// The settings form always sends the original two capabilities.
const caps = (extra = {}) => ({ memory: false, reminders: false, ...extra });

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-web-restart-"));
  const store = new AssistantStore({ dataDir });
  const webSearch = new WebSearchSettings({ dataDir });
  const calls = [];
  let blockers = [];
  // What a Gateway start compiles: the current profiles, settings and browser.
  const compiled = () =>
    webToolsSnapshot({
      profiles: store.listAssistants(),
      webTools: { search: webSearch.resolve(), browser, searchPlugins },
    });
  const runtime = Object.assign(new EventEmitter(), {
    paths: runtimePaths(dataDir),
    client: { ready: true, subscribe: () => () => {}, call: async () => ({}) },
    status: () => ({ availability: runtime.client.ready ? "ready" : "disabled" }),
    stop: async () => {
      calls.push("stop");
      runtime.client.ready = false;
      runtime.webTools = null;
    },
    start: async () => {
      calls.push("start");
      runtime.client.ready = true;
      runtime.webTools = compiled();
    },
    close: async () => {},
  });
  const service = new AssistantService({
    store,
    runtime,
    models: {},
    config: {
      apply: async (id) => calls.push(`apply:${id}`),
      reset() {},
    },
  });
  const maintenance = {
    enter: async () => {
      calls.push("enter");
      service.maintenance = true;
    },
    blockers: async () => blockers,
    quiesce: async () => calls.push("quiesce"),
    leave: async () => {
      calls.push("leave");
      service.maintenance = false;
    },
  };
  const synchronization = new AssistantProviderSynchronization({
    assistants: service,
    maintenance,
  });
  service.webTools = new WebToolsChanges({
    assistants: service,
    webSearch,
    synchronization,
    detect: () => browser,
  });
  t.after(async () => {
    await service.close();
    webSearch.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const agent = (name, capabilities = {}) =>
    store.createAssistant({
      name,
      instructions: "",
      model,
      capabilities: caps(capabilities),
    });
  return {
    store,
    webSearch,
    service,
    runtime,
    calls,
    agent,
    // The Gateway runs with what the current state compiles.
    started: () => {
      runtime.webTools = compiled();
    },
    setBlockers: (value) => {
      blockers = value;
    },
  };
}
const restartRequired = { status: 409, code: "ASSISTANT_RESTART_REQUIRED" };

test("a capability another agent already uses applies live without a restart", async (t) => {
  const f = fixture(t);
  f.agent("Reader", { webFetch: true });
  const second = f.agent("Writer");
  f.started();
  const saved = await f.service.update(
    second.id,
    { capabilities: caps({ webFetch: true }) },
    second.revision,
  );
  assert.equal(saved.capabilities.webFetch, true);
  assert.deepEqual(f.calls, [`apply:${second.id}`]);
});

test("a capability that needs new global sections asks for the owner's confirmation", async (t) => {
  const f = fixture(t);
  const a = f.agent("Home", { reminders: true });
  f.agent("Other");
  f.started();
  f.service.reminders = {
    disable: async (id) => f.calls.push(`disable:${id}`),
    close: async () => {},
  };
  // Also switching reminders off: they stay on until the owner confirms.
  await assert.rejects(
    f.service.update(a.id, { capabilities: caps({ webSearch: true }) }, a.revision),
    (error) => {
      assert.equal(error.status, restartRequired.status);
      assert.equal(error.code, restartRequired.code);
      assert.equal(error.key, "webToolsRestartRequired");
      assert.deepEqual(error.affected.agents.map((x) => x.name).sort(), [
        "Home",
        "Other",
      ]);
      assert.equal(error.affected.teamMembers, 0);
      return true;
    },
  );
  assert.equal(f.store.getAssistant(a.id).revision, a.revision);
  assert.equal(f.store.getAssistant(a.id).capabilities.webSearch, undefined);
  assert.deepEqual(f.calls, []);
  await f.service.update(a.id, { capabilities: caps({ webSearch: true }) }, a.revision, {
    confirmed: true,
  });
  assert.deepEqual(f.calls, [
    `disable:${a.id}`,
    "enter",
    "stop",
    "quiesce",
    "start",
    "leave",
    `apply:${a.id}`,
  ]);
});

test("a confirmed capability change persists in maintenance and restarts the Gateway", async (t) => {
  const f = fixture(t);
  const a = f.agent("Home");
  f.started();
  const before = f.runtime.webTools.signature;
  const saved = await f.service.update(
    a.id,
    { capabilities: caps({ browser: true }) },
    a.revision,
    { confirmed: true },
  );
  assert.equal(saved.capabilities.browser, true);
  assert.equal(f.store.getAssistant(a.id).capabilities.browser, true);
  assert.deepEqual(f.calls, [
    "enter",
    "stop",
    "quiesce",
    "start",
    "leave",
    `apply:${a.id}`,
  ]);
  assert.notEqual(f.runtime.webTools.signature, before);
  assert.equal(f.service.maintenance, false);
  // Switching it off again changes the sections back, which also restarts.
  await assert.rejects(
    f.service.update(a.id, { capabilities: caps({ browser: false }) }, saved.revision),
    restartRequired,
  );
});

test("busy work refuses the confirmed restart and persists nothing", async (t) => {
  const f = fixture(t);
  const a = f.agent("Home");
  f.started();
  f.setBlockers(["ASSISTANT_WORK"]);
  await assert.rejects(
    f.service.update(a.id, { capabilities: caps({ webFetch: true }) }, a.revision, {
      confirmed: true,
    }),
    { status: 409, key: "active" },
  );
  assert.equal(f.store.getAssistant(a.id).capabilities.webFetch, undefined);
  assert.deepEqual(f.calls, ["enter", "leave"]);
  assert.equal(f.service.maintenance, false);
});

test("a stopped Gateway or a temporary member's change never restarts", async (t) => {
  const f = fixture(t);
  const a = f.agent("Home");
  f.started();
  const member = f.store.reserveMember({
    id: "member-1",
    parent: a.id,
    assignment: { name: "Helper", role: "Helper", assignment: "Fixture" },
    snapshot: { instructions: "", model },
    teamId: "team-1",
    lifetime: "temporary",
  });
  const changed = await f.service.update(
    member.id,
    { capabilities: caps({ browser: true }) },
    member.revision,
  );
  assert.equal(changed.capabilities.browser, true);
  assert.deepEqual(f.calls, [`apply:${member.id}`]);
  f.calls.length = 0;
  f.runtime.client.ready = false;
  const saved = await f.service.update(
    a.id,
    { capabilities: caps({ webSearch: true }) },
    a.revision,
  );
  // The next start compiles it; nothing was applied to a stopped Gateway.
  assert.equal(saved.capabilities.webSearch, true);
  assert.deepEqual(f.calls, []);
});

test("a changed search provider or key restarts the Gateway once confirmed", async (t) => {
  const f = fixture(t);
  f.agent("Home", { webSearch: true });
  f.started();
  const brave = { revision: 0, provider: "brave", braveKey: "secret-brave-fixture" };
  await assert.rejects(f.service.webTools.saveSearch(brave), restartRequired);
  assert.equal(f.webSearch.get().provider, "duckduckgo");
  assert.equal(f.webSearch.get().hasBraveKey, false);
  assert.deepEqual(f.calls, []);
  const saved = await f.service.webTools.saveSearch(brave, { confirmed: true });
  assert.equal(saved.provider, "brave");
  assert.deepEqual(f.calls, ["enter", "stop", "quiesce", "start", "leave"]);
  // The running state never holds the key.
  assert.equal(
    JSON.stringify(f.runtime.webTools).includes("secret-brave-fixture"),
    false,
  );
  f.calls.length = 0;
  // The same settings again change nothing, so they save without a restart.
  const again = await f.service.webTools.saveSearch({
    ...brave,
    revision: saved.revision,
  });
  assert.equal(again.revision, saved.revision + 1);
  // A new key is a new plugin entry.
  await assert.rejects(
    f.service.webTools.saveSearch({ ...brave, revision: again.revision, braveKey: "k2" }),
    restartRequired,
  );
  assert.deepEqual(f.calls, []);
});

test("search settings save directly while no agent uses web search", async (t) => {
  const f = fixture(t);
  f.agent("Home", { webFetch: true });
  f.started();
  const saved = await f.service.webTools.saveSearch({
    revision: 0,
    provider: "brave",
    braveKey: "secret-brave-fixture",
  });
  assert.equal(saved.provider, "brave");
  assert.deepEqual(f.calls, []);
  // Invalid input and stale revisions fail before any restart decision.
  await assert.rejects(f.service.webTools.saveSearch({ revision: 0, provider: "x" }), {
    status: 400,
  });
  await assert.rejects(
    f.service.webTools.saveSearch({ revision: 0, provider: "duckduckgo" }),
    { status: 409, key: "conflict" },
  );
});
