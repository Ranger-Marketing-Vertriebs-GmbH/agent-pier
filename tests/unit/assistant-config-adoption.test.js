import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AssistantConfig } from "../../server/features/assistants/assistant-config.js";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";

/**
 * A Gateway that persists agents.update at once and answers config.get with the new
 * hash, but announces the runtime commit (`config.changed`) only `lag` ms later, as
 * OpenClaw's scheduled reload does (a negative lag announces before answering).
 * `event` shapes (or drops) that announcement; `early` is announced while the roster
 * is read, before the write.
 */
function fixture(
  t,
  { lag = 300, event = (hash) => ({ hash }), failUpdate = false, early } = {},
) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-adoption-"));
  const store = new AssistantStore({ dataDir });
  t.after(() => {
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const assistant = store.createAssistant({
    name: "Home",
    model: { connectionId: "c", modelId: "m" },
  });
  const gateway = { model: "old/model", hash: 1, files: {}, listeners: new Set() };
  gateway.announced = [];
  const announce = (payload) => {
    gateway.announced.push(Date.now());
    if (payload)
      for (const listener of [...gateway.listeners])
        listener({ event: "config.changed", payload });
  };
  gateway.client = {
    subscribe(listener) {
      gateway.listeners.add(listener);
      return () => gateway.listeners.delete(listener);
    },
    async call(method, params) {
      if (method === "agents.list") {
        if (early) announce(early);
        return { agents: [{ id: assistant.runtimeAgentId }] };
      }
      if (method === "agents.update") {
        if (failUpdate) throw Object.assign(Error("lost"), { code: "CLOSED" });
        if (params.model === gateway.model) return {};
        gateway.model = params.model;
        const hash = String(++gateway.hash);
        if (lag < 0) announce(event(hash));
        else setTimeout(() => announce(event(hash)), lag);
        return {};
      }
      if (method === "config.get")
        return {
          hash: String(gateway.hash),
          config: {
            agents: { entries: { [assistant.runtimeAgentId]: { model: gateway.model } } },
          },
        };
      if (method === "agents.files.get")
        return {
          file:
            gateway.files[params.name] === undefined
              ? { missing: true }
              : { content: gateway.files[params.name] },
        };
      if (method === "agents.files.set") {
        gateway.files[params.name] = params.content;
        return {};
      }
      assert.fail(method);
    },
  };
  const warnings = [];
  const config = (timeoutMs = 5000) =>
    new AssistantConfig({
      client: gateway.client,
      store,
      workspaces: dataDir,
      models: {
        resolve: () => ({ modelRef: "new/model", display: "m", release() {} }),
      },
      adoption: { timeoutMs, warn: (line) => warnings.push(line) },
    });
  return { assistant, gateway, config, warnings, store };
}

test("apply resolves only after the Gateway announced the written config", async (t) => {
  const { assistant, gateway, config, warnings, store } = fixture(t);
  const started = Date.now();
  await config().apply(assistant.id);
  assert.equal(gateway.announced.length, 1, "returned before config.changed");
  assert.ok(Date.now() - started >= 250);
  assert.equal(gateway.model, "new/model");
  assert.equal(store.getAssistant(assistant.id).effectiveRevision, 1);
  assert.deepEqual(warnings, []);
  assert.equal(gateway.listeners.size, 0);
});

test("an unchanged config or an already applied profile does not wait", async (t) => {
  const { assistant, gateway, config, warnings } = fixture(t);
  gateway.model = "new/model";
  const apply = config(10_000);
  let started = Date.now();
  await apply.apply(assistant.id);
  assert.ok(Date.now() - started < 1000, "waited although nothing changed");
  started = Date.now();
  await apply.apply(assistant.id);
  assert.ok(Date.now() - started < 1000);
  assert.deepEqual(gateway.announced, []);
  assert.deepEqual(warnings, []);
  assert.equal(gateway.listeners.size, 0);
});

test("a dropped, stale or premature announcement ends the wait at the timeout", async (t) => {
  // Dropped; the baseline's own hash; a hashless event from before the write.
  for (const options of [
    { event: () => null },
    { event: () => ({ hash: "1" }) },
    { event: () => null, early: { hash: null } },
  ]) {
    const { assistant, gateway, config, warnings, store } = fixture(t, {
      lag: 10,
      ...options,
    });
    const started = Date.now();
    await config(200).apply(assistant.id);
    assert.ok(Date.now() - started >= 190);
    assert.equal(store.getAssistant(assistant.id).effectiveRevision, 1);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /within 200 ms/);
    assert.equal(gateway.listeners.size, 0);
  }
});

test("an announcement without a hash confirms the write", async (t) => {
  const { assistant, gateway, config, warnings } = fixture(t, {
    lag: 50,
    event: () => ({ hash: null }),
  });
  const started = Date.now();
  await config(5000).apply(assistant.id);
  assert.ok(Date.now() - started < 1000);
  assert.deepEqual(warnings, []);
  assert.equal(gateway.listeners.size, 0);
});

for (const [name, options] of [
  ["an announcement before the write answered", { lag: -1 }],
  ["a coalesced later write's announcement", { lag: 10, event: () => ({ hash: "9" }) }],
])
  test(`${name} confirms the write without waiting`, async (t) => {
    const { assistant, gateway, config, warnings } = fixture(t, options);
    const started = Date.now();
    await config(10_000).apply(assistant.id);
    assert.ok(Date.now() - started < 1000);
    assert.equal(gateway.announced.length, 1);
    assert.deepEqual(warnings, []);
    assert.equal(gateway.listeners.size, 0);
  });

test("a failed apply ends the subscription without waiting", async (t) => {
  const { assistant, gateway, config } = fixture(t, { failUpdate: true });
  await assert.rejects(config(10_000).apply(assistant.id), { code: "CLOSED" });
  assert.equal(gateway.listeners.size, 0);
});
