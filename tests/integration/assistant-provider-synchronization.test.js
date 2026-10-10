import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProviderConnections } from "../../server/features/providers/provider-connections.js";
import { AssistantModels } from "../../server/features/assistants/assistant-models.js";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { runtimePaths } from "../../server/features/assistants/runtime-paths.js";
import { readJSON, writePrivate } from "../../server/lib/storage.js";
import { AssistantProviderSynchronization } from "../../server/features/assistants/assistant-provider-synchronization.js";

function fixture(t, shape = "entries") {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-provider-sync-"));
  const paths = runtimePaths(dataDir),
    store = new AssistantStore({ dataDir });
  t.after(() => {
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const connections = new ProviderConnections({ dataDir });
  const c = connections.create({
    name: "Router",
    providerId: "openrouter",
    apiKey: "original-fixture-key",
  });
  const models = new AssistantModels({ connections });
  const a = store.createAssistant({
    name: "Scheduled",
    instructions: "",
    model: { connectionId: c.id, modelId: "fixture" },
  });
  const lease = models.resolve(a.model);
  const entry = { id: a.runtimeAgentId, name: a.name, model: lease.modelRef };
  writePrivate(paths.config, {
    agents: {
      [shape === "list" ? "list" : "entries"]:
        shape === "entries"
          ? { [a.runtimeAgentId]: entry, unrelated: { model: "openai/native" } }
          : [entry, { id: "unrelated", model: "openai/native" }],
    },
    models: {
      providers: {
        [lease.providerId]: lease.provider,
        unrelated: { apiKey: "keep-fixture-key" },
      },
    },
  });
  lease.release();
  const calls = [],
    paused = [];
  let running = true,
    blockers = [];
  const runtime = {
    paths,
    status: () => ({ availability: running ? "ready" : "disabled" }),
    client: { ready: true },
    stop: async () => {
      calls.push("stop");
      running = false;
      runtime.client.ready = false;
    },
    start: async () => {
      calls.push("start");
      await sync.prepare();
      running = true;
      runtime.client.ready = true;
    },
  };
  const assistants = {
    store,
    models,
    runtime,
    maintenance: false,
    changed() {},
    config: { reset() {} },
    reminders: {
      disable: async (id) => {
        paused.push(id);
      },
    },
  };
  const maintenance = {
    enter: async () => {
      calls.push("enter");
      assistants.maintenance = true;
    },
    blockers: async () => blockers,
    quiesce: async () => {
      calls.push("quiesce");
    },
    leave: async () => {
      calls.push("leave");
      assistants.maintenance = false;
    },
  };
  const sync = new AssistantProviderSynchronization({
    assistants,
    connections,
    maintenance,
  });
  return {
    paths,
    store,
    connections,
    c,
    a,
    models,
    sync,
    assistants,
    calls,
    paused,
    runtime,
    setBlockers: (value) => {
      blockers = value;
    },
    running: () => running,
  };
}
for (const shape of ["entries", "list", "arrayEntries"]) {
  test(`offline synchronization refreshes ${shape} and keeps unrelated providers`, async (t) => {
    const f = fixture(t, shape);
    await f.sync.change(
      f.c.id,
      () => {
        assert.equal(f.running(), false);
        f.calls.push("mutate");
        return f.connections.update(f.c.id, { apiKey: "rotated-fixture-key" });
      },
      { confirmed: true },
    );
    const config = readJSON(f.paths.config);
    const entries = config.agents.entries || config.agents.list;
    const entry = Array.isArray(entries)
      ? entries.find((e) => e.id === f.a.runtimeAgentId)
      : entries[f.a.runtimeAgentId];
    const lease = f.models.resolve(f.a.model);
    assert.deepEqual(entry.model, { primary: lease.modelRef, fallbacks: [] });
    lease.release();
    assert.equal(JSON.stringify(config).includes("original-fixture-key"), false);
    assert.equal(JSON.stringify(config).includes("rotated-fixture-key"), true);
    assert.equal(config.models.providers.unrelated.apiKey, "keep-fixture-key");
    assert.deepEqual(f.calls, ["enter", "stop", "quiesce", "mutate", "start", "leave"]);
    assert.deepEqual(f.paused, []);
  });
}
test("removed connection blocks native selection and pauses scheduled profiles before reopening ingress", async (t) => {
  const f = fixture(t);
  await f.sync.change(f.c.id, () => f.connections.remove(f.c.id), { confirmed: true });
  assert.deepEqual(readJSON(f.paths.config).agents.entries[f.a.runtimeAgentId].model, {
    primary: "agentpier-unavailable/blocked",
    fallbacks: [],
  });
  assert.deepEqual(f.paused, [f.a.id]);
  assert.equal(
    JSON.stringify(readJSON(f.paths.config)).includes("original-fixture-key"),
    false,
  );
  assert.equal(f.assistants.maintenance, false);
});
test("active work or an existing update maintenance gate leaves credentials untouched", async (t) => {
  const f = fixture(t);
  f.setBlockers(["SCHEDULED_WORK"]);
  await assert.rejects(
    f.sync.change(f.c.id, () => assert.fail("must not mutate"), { confirmed: true }),
    { status: 409 },
  );
  assert.equal(f.running(), true);
  assert.deepEqual(f.calls, ["enter", "leave"]);
  f.assistants.maintenance = true;
  await assert.rejects(
    f.sync.change(f.c.id, () => assert.fail("must not mutate"), { confirmed: true }),
    { status: 409 },
  );
  assert.equal(f.connections.secret(f.c.id).apiKey, "original-fixture-key");
});
test("a used connection changes only with a confirmed Gateway restart", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    f.sync.change(f.c.id, () => assert.fail("must not mutate")),
    { status: 409, code: "ASSISTANT_RESTART_REQUIRED" },
  );
  assert.deepEqual(f.calls, []);
  assert.equal(f.running(), true);
  assert.equal(f.connections.secret(f.c.id).apiKey, "original-fixture-key");
});
test("the restart confirmation names permanent agents and counts temporary members", async (t) => {
  const f = fixture(t);
  for (const [n, lifetime] of [
    [1, "task"],
    [2, "task"],
    [3, "permanent"],
  ])
    f.store.reserveMember({
      id: `member-${n}`,
      parent: f.a.id,
      assignment: { name: `Member ${n}`, role: "r", assignment: "a" },
      snapshot: { instructions: "", model: f.a.model },
      teamId: "team",
      lifetime,
    });
  assert.deepEqual(f.sync.usage(f.c.id), {
    agents: [
      { id: f.a.id, name: "Scheduled" },
      { id: "member-3", name: "Member 3" },
    ],
    teamMembers: 2,
  });
  await assert.rejects(
    f.sync.change(f.c.id, () => assert.fail("must not mutate")),
    (e) => {
      assert.deepEqual(e.affected, f.sync.usage(f.c.id));
      return true;
    },
  );
});
test("unrelated changes bypass runtime work and failed mutations restore the running state", async (t) => {
  const f = fixture(t);
  assert.equal(await f.sync.change("unrelated", () => 42), 42);
  assert.deepEqual(f.calls, []);
  await assert.rejects(
    f.sync.change(
      f.c.id,
      () => {
        throw Object.assign(Error("invalid"), { status: 400 });
      },
      { confirmed: true },
    ),
    { status: 400 },
  );
  assert.equal(f.running(), true);
  assert.equal(f.assistants.maintenance, false);
  assert.equal(f.connections.secret(f.c.id).apiKey, "original-fixture-key");
});
test("a disabled runtime stays disabled while offline credentials are refreshed", async (t) => {
  const f = fixture(t);
  await f.runtime.stop();
  f.calls.length = 0;
  await f.sync.change(
    f.c.id,
    () => f.connections.update(f.c.id, { apiKey: "offline-fixture-key" }),
    { confirmed: true },
  );
  assert.equal(f.running(), false);
  assert.equal(f.calls.includes("start"), false);
  assert.equal(
    JSON.stringify(readJSON(f.paths.config)).includes("offline-fixture-key"),
    true,
  );
});
test("unreadable native configuration fails closed after mutation without restarting", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    f.sync.change(
      f.c.id,
      () => {
        f.connections.remove(f.c.id);
        fs.writeFileSync(f.paths.config, "private-fixture-key invalid JSON");
      },
      { confirmed: true },
    ),
    (error) => error.status === 503 && !error.message.includes("private-fixture-key"),
  );
  assert.equal(f.running(), false);
  assert.equal(f.calls.includes("start"), false);
  assert.equal(f.assistants.maintenance, true);
});

test("pre-spawn preparation refuses a live Gateway and schedule pause defers during maintenance", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.sync.prepare(), { status: 409 });
  f.sync.blocked.add(f.a.id);
  f.assistants.maintenance = true;
  await f.sync.pauseBlocked();
  assert.deepEqual(f.paused, []);
  await f.sync.pauseBlocked({ duringMaintenance: true });
  assert.deepEqual(f.paused, [f.a.id]);
});
test("failed native pause stops the Gateway and keeps mutation ingress gated", async (t) => {
  const f = fixture(t);
  f.assistants.reminders.disable = async () => {
    throw Error("cron unavailable");
  };
  await assert.rejects(
    f.sync.change(f.c.id, () => f.connections.remove(f.c.id), { confirmed: true }),
    (error) => error.status === 503 && !error.message.includes("cron unavailable"),
  );
  assert.equal(f.running(), false);
  assert.equal(f.assistants.maintenance, true);
});
test("maintenance entry diagnostics stay private and cannot mutate credentials", async (t) => {
  const f = fixture(t);
  f.sync.maintenance.enter = async () => {
    f.assistants.maintenance = true;
    throw Error("private-fixture-token from native RPC");
  };
  await assert.rejects(
    f.sync.change(f.c.id, () => assert.fail("must not mutate"), { confirmed: true }),
    (error) => error.status === 503 && !error.message.includes("private-fixture-token"),
  );
  assert.equal(f.assistants.maintenance, true);
  assert.equal(f.connections.secret(f.c.id).apiKey, "original-fixture-key");
});
test("changing fences recovery synchronously through maintenance leave", async (t) => {
  const f = fixture(t);
  let releaseEntry;
  const entry = new Promise((resolve) => {
    releaseEntry = resolve;
  });
  f.sync.maintenance.enter = async () => {
    await entry;
    f.assistants.maintenance = true;
  };
  f.sync.maintenance.leave = async () => {
    assert.equal(f.sync.changing, true);
    f.assistants.maintenance = false;
  };
  const change = f.sync.change(
    f.c.id,
    () => {
      assert.equal(f.sync.changing, true);
      return f.connections.update(f.c.id, { apiKey: "rotated-key" });
    },
    { confirmed: true },
  );
  try {
    assert.equal(f.sync.changing, true);
    await assert.rejects(
      f.sync.change(f.c.id, () => assert.fail("concurrent change"), { confirmed: true }),
      { status: 409 },
    );
  } finally {
    releaseEntry();
    await change;
  }
  assert.equal(f.sync.changing, false);
});
test("changing resets after maintenance entry and leave failures", async (t) => {
  for (const stage of ["enter", "leave"]) {
    const f = fixture(t);
    f.sync.maintenance[stage] = async () => {
      throw Error("native failure");
    };
    await assert.rejects(
      f.sync.change(f.c.id, () => 1, { confirmed: true }),
      { status: 503 },
    );
    assert.equal(f.sync.changing, false);
  }
});

test("online account mutation runs behind maintenance after schedules pause, then repairs the stopped Gateway", async (t) => {
  const f = fixture(t);
  await f.sync.change(
    f.c.id,
    () => {
      assert.equal(f.assistants.maintenance, true);
      assert.equal(f.running(), true, "native logout needs a connected Gateway");
      assert.deepEqual(f.paused, [f.a.id], "dependent jobs pause before native logout");
      f.calls.push("logout");
      f.connections.remove(f.c.id);
    },
    { online: true },
  );
  assert.deepEqual(f.calls, ["enter", "logout", "stop", "quiesce", "start", "leave"]);
  assert.equal(
    readJSON(f.paths.config).agents.entries[f.a.runtimeAgentId].model.primary,
    "agentpier-unavailable/blocked",
  );
});

test("native account logout without a dependent assistant still respects scheduled-work and maintenance gates", async (t) => {
  const f = fixture(t);
  f.setBlockers(["SCHEDULED_WORK"]);
  await assert.rejects(
    f.sync.change("unrelated-native-account", () => assert.fail("must not log out"), {
      online: true,
    }),
    { status: 409 },
  );
  f.assistants.maintenance = true;
  await assert.rejects(
    f.sync.change("unrelated-native-account", () => assert.fail("must not log out"), {
      online: true,
    }),
    { status: 409 },
  );
});

test("lost native logout acknowledgement repairs model references but stays stopped in maintenance", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    f.sync.change(
      f.c.id,
      () => {
        f.connections.remove(f.c.id);
        throw Error("private native acknowledgement failure");
      },
      { online: true },
    ),
    (error) => error.status === 503 && !error.message.includes("private native"),
  );
  assert.equal(f.running(), false);
  assert.equal(f.assistants.maintenance, true);
  assert.equal(f.calls.includes("leave"), false);
  assert.equal(
    readJSON(f.paths.config).agents.entries[f.a.runtimeAgentId].model.primary,
    "agentpier-unavailable/blocked",
  );
});

test("account logout repairs archived model selections without reopening archived schedules", async (t) => {
  const f = fixture(t);
  const archived = { ...f.a, archivedAt: new Date().toISOString() };
  f.store.db
    .prepare("UPDATE assistants SET body=? WHERE id=?")
    .run(JSON.stringify(archived), archived.id);
  f.assistants.reminders.disable = async () => {
    throw Object.assign(Error("archived assistant cannot administer schedules"), {
      status: 404,
    });
  };
  await f.sync.change(f.c.id, () => f.connections.remove(f.c.id), { online: true });
  assert.equal(f.assistants.maintenance, false);
  assert.equal(
    readJSON(f.paths.config).agents.entries[f.a.runtimeAgentId].model.primary,
    "agentpier-unavailable/blocked",
  );
});

test("an admitted provider credential change destroys update backup keys first", async (t) => {
  const f = fixture(t);
  const key = path.join(
    f.paths.root,
    "backup-keys",
    "8b0c5f0e-8f43-4a8e-9a55-3c2f4c1d0e01.key",
  );
  fs.mkdirSync(path.dirname(key), { mode: 0o700 });
  fs.writeFileSync(key, Buffer.alloc(32, 1), { mode: 0o600 });
  f.assistants.maintenance = true;
  await assert.rejects(
    f.sync.change(f.c.id, () => assert.fail("not admitted"), { confirmed: true }),
    {
      status: 409,
    },
  );
  assert.equal(fs.existsSync(key), true, "a rejected change keeps backup keys");
  f.assistants.maintenance = false;
  f.setBlockers(["ASSISTANT_WORK"]);
  await assert.rejects(
    f.sync.change(f.c.id, () => assert.fail("blocked"), { confirmed: true }),
    {
      status: 409,
    },
  );
  assert.equal(fs.existsSync(key), true, "a change refused for active work keeps keys");
  f.setBlockers([]);
  await f.sync.change(
    f.c.id,
    () => {
      assert.equal(fs.existsSync(key), false);
      return f.connections.update(f.c.id, { apiKey: "rotated-fixture-key" });
    },
    { confirmed: true },
  );
});
test("offline preparation writes endpoint image support and chat options from main's draft fields", async (t) => {
  const f = fixture(t);
  const model = { modelId: "vision", source: "manual", contextTokens: 32768 };
  const e = f.connections.create({
    name: "Local",
    providerId: "endpoint",
    endpoint: {
      preset: "custom",
      openaiBaseUrl: "http://127.0.0.1:8080/v1",
      protocols: { messages: false, responses: false, chatCompletions: true },
      models: [{ ...model, images: false }],
    },
  });
  f.store.updateAssistant(
    f.a.id,
    { model: { connectionId: e.id, modelId: "vision" } },
    f.a.revision,
  );
  await f.sync.change(
    e.id,
    () =>
      f.connections.update(e.id, {
        endpoint: {
          ...f.connections.get(e.id).endpoint,
          routing: { claude: "off", codex: "off", opencode: "off" },
          adapterCapabilities: { chatCompletions: { maxTokensField: "max_tokens" } },
          models: [{ ...model, images: true }],
        },
      }),
    { confirmed: true },
  );
  const providers = Object.entries(readJSON(f.paths.config).models.providers).filter(
    ([key]) => key.startsWith(`ap-${e.id}-`),
  );
  assert.equal(providers.length, 1);
  assert.equal(providers[0][1].api, "openai-completions");
  assert.deepEqual(providers[0][1].models[0].input, ["text", "image"]);
  assert.deepEqual(providers[0][1].models[0].compat, { maxTokensField: "max_tokens" });
});
