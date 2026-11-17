import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { AssistantService } from "../../server/features/assistants/assistant-service.js";
import { AssistantProviderSynchronization } from "../../server/features/assistants/assistant-provider-synchronization.js";
import { WebToolsChanges } from "../../server/features/assistants/web-tools-changes.js";
import { runtimePaths } from "../../server/features/assistants/runtime-paths.js";
import { pendingRestartReasons } from "../../server/features/assistants/pending-restart.js";
import { hostWiki } from "../../server/features/assistants/runtimes/openclaw/openclaw-config/memory-wiki.js";

// The memory wiki on OpenClaw (ADR 0007, step 7b): its plugin is listed in
// plugins.allow, which the Gateway reads only at a start. The first agent with a wiki
// therefore restarts the Gateway through the confirmation (or, in the app, the
// pending restart) web tools use; later agents and switching it off apply live.
const model = { connectionId: "c", modelId: "m" };
const on = { openclaw: { memoryWiki: true } };

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-wiki-restart-"));
  const store = new AssistantStore({ dataDir });
  const calls = [];
  // What a start loads: the plugin while a stored agent keeps a wiki.
  const loaded = () => hostWiki(store.listAssistants());
  const runtime = Object.assign(new EventEmitter(), {
    paths: runtimePaths(dataDir),
    client: { ready: true, subscribe: () => () => {}, call: async () => ({}) },
    status: () => ({ availability: runtime.client.ready ? "ready" : "disabled" }),
    webTools: { tools: [], signatures: {} },
    memoryWiki: false,
    stop: async () => {
      calls.push("stop");
      runtime.client.ready = false;
    },
    start: async () => {
      calls.push("start");
      runtime.client.ready = true;
      runtime.memoryWiki = loaded();
    },
    close: async () => {},
  });
  const service = new AssistantService({
    store,
    runtime,
    models: {},
    config: { apply: async (id) => calls.push(`apply:${id}`), reset() {} },
  });
  const maintenance = {
    enter: async () => {
      calls.push("enter");
      service.maintenance = true;
    },
    blockers: async () => [],
    quiesce: async () => {},
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
    webSearch: { resolve: () => ({}) },
    synchronization,
    detect: () => ({ available: false }),
  });
  t.after(async () => {
    await service.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const agent = (name) => store.createAssistant({ name, instructions: "", model });
  const wiki = (a, runtimeOptions = on, options) =>
    service.update(a.id, { runtimeOptions }, store.getAssistant(a.id).revision, options);
  return { store, service, runtime, calls, agent, wiki };
}

test("the first wiki asks to restart and restarts the Gateway once confirmed", async (t) => {
  const f = fixture(t);
  const first = f.agent("First");
  await assert.rejects(f.wiki(first), {
    status: 409,
    code: "ASSISTANT_RESTART_REQUIRED",
  });
  assert.equal(f.store.getAssistant(first.id).runtimeOptions, undefined);
  assert.deepEqual(f.calls, []);
  const saved = await f.wiki(first, on, { confirmed: true });
  assert.deepEqual(saved.runtimeOptions, on);
  assert.deepEqual(f.calls, ["enter", "stop", "start", "leave", `apply:${first.id}`]);
  assert.equal(f.runtime.memoryWiki, true);
});

test("a later wiki and switching wikis off apply live", async (t) => {
  const f = fixture(t);
  const first = f.agent("First");
  const second = f.agent("Second");
  f.store.updateAssistant(first.id, { runtimeOptions: on }, first.revision);
  f.runtime.memoryWiki = true;
  await f.wiki(second);
  await f.wiki(first, {});
  await f.wiki(second, { openclaw: { memoryWiki: false } });
  assert.deepEqual(f.calls, [
    `apply:${second.id}`,
    `apply:${first.id}`,
    `apply:${second.id}`,
  ]);
  assert.equal(f.store.getAssistant(second.id).runtimeOptions, undefined);
});

test("a stopped Gateway compiles the wiki at its next start without asking", async (t) => {
  const f = fixture(t);
  const first = f.agent("First");
  f.runtime.client.ready = false;
  const saved = await f.wiki(first);
  assert.deepEqual(saved.runtimeOptions, on);
  assert.ok(!f.calls.includes("stop"));
});

test("in the app the first wiki is saved at once and its restart queued", async (t) => {
  const f = fixture(t);
  const first = f.agent("First");
  const queued = [];
  f.service.webTools.synchronization.pending = {
    request: (reason, affected) => queued.push({ reason, affected }),
  };
  const saved = await f.wiki(first);
  assert.deepEqual(saved.runtimeOptions, on);
  assert.deepEqual(
    queued.map((entry) => entry.reason),
    ["runtimeOptions"],
  );
  assert.ok(pendingRestartReasons.includes("runtimeOptions"));
  assert.ok(!f.calls.includes("stop"));
});

test("another runtime's options never ask for the Gateway's restart", async (t) => {
  const f = fixture(t);
  const first = f.agent("First");
  // Stored past the routes: the running start has not loaded the plugin yet.
  f.store.updateAssistant(first.id, { runtimeOptions: on }, first.revision);
  const heron = f.store.createAssistant({
    name: "Heron",
    instructions: "",
    model,
    runtime: "hermes",
  });
  assert.equal(f.service.webTools.optionsDiffer(f.store.listAssistants(), heron), false);
  assert.equal(
    f.service.webTools.optionsDiffer(
      f.store.listAssistants(),
      f.store.getAssistant(first.id),
    ),
    true,
  );
});
