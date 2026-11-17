import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  configWrite,
  patchConfig,
} from "../../server/features/assistants/runtimes/openclaw/live-patch.js";
import { providerPatch } from "../../server/features/assistants/runtimes/openclaw/openclaw-config/agent-apply.js";

function client(responses) {
  const calls = [];
  return {
    calls,
    async call(method, params) {
      // A Gateway that admitted every agent (agent-admission.js).
      if (method === "agents.list") return { agents: [] };
      calls.push([method, params]);
      const next = responses[method];
      if (next instanceof Error) throw next;
      return typeof next === "function" ? next(params) : next;
    },
  };
}

test("a patch carries the base hash and replace paths", async () => {
  const gateway = client({
    "config.get": { hash: "h1", config: { cron: { enabled: false } } },
    "config.patch": { ok: true },
  });
  await patchConfig(gateway, (current) =>
    current.cron.enabled
      ? null
      : { patch: { cron: { enabled: true } }, replacePaths: ["cron"] },
  );
  assert.deepEqual(gateway.calls[1], [
    "config.patch",
    {
      baseHash: "h1",
      raw: JSON.stringify({ cron: { enabled: true } }),
      replacePaths: ["cron"],
    },
  ]);
});

test("an unchanged value sends no patch", async () => {
  const gateway = client({
    "config.get": { hash: "h1", config: { cron: { enabled: true } } },
  });
  const result = await patchConfig(gateway, (c) =>
    c.cron.enabled ? null : { patch: {} },
  );
  assert.equal(result, null);
  assert.equal(gateway.calls.length, 1);
});

// OpenClaw 2026.9.8 answers a stale base hash with the generic INVALID_REQUEST
// ("config changed since last load"), so the hash is re-read to tell it apart.
test("a stale base hash becomes a conflict", async () => {
  const stale = Object.assign(Error("stale"), {
    code: "INVALID_REQUEST",
    answered: true,
  });
  let reads = 0;
  const gateway = client({
    "config.get": () => ({ hash: reads++ ? "h2" : "h1", config: {} }),
    "config.patch": stale,
  });
  await assert.rejects(
    patchConfig(gateway, () => ({ patch: { a: 1 } })),
    { status: 409 },
  );
});

test("an invalid patch on an unchanged configuration is not a conflict", async () => {
  const invalid = Object.assign(Error("bad"), {
    code: "INVALID_REQUEST",
    answered: true,
  });
  const gateway = client({
    "config.get": { hash: "h1", config: {} },
    "config.patch": invalid,
  });
  await assert.rejects(
    patchConfig(gateway, () => ({ patch: { a: 1 } })),
    invalid,
  );
});

test("other patch failures and a missing config pass through", async () => {
  const broken = Object.assign(Error("boom"), { code: "UNAVAILABLE", answered: true });
  const gateway = client({ "config.get": { hash: "h1" }, "config.patch": broken });
  await assert.rejects(
    patchConfig(gateway, (c) => ({ patch: { seen: c } })),
    broken,
  );
  assert.equal(gateway.calls[1][1].raw, JSON.stringify({ seen: {} }));
});

// As OpenClaw 2026.10 refuses a config.patch over its budget of 30 a minute per
// connection: before any write, retryable, with the wait it asks for.
const rateLimited = (retryAfterMs) =>
  Object.assign(Error("rate limit exceeded for config.patch"), {
    code: "UNAVAILABLE",
    answered: true,
    retryable: true,
    retryAfterMs,
  });
function limitedGateway(refusals, retryAfterMs) {
  let clock = 0;
  const waits = [];
  let refused = 0;
  const gateway = client({
    "config.get": { hash: "h1", config: {} },
    "config.patch": () => {
      if (refused++ < refusals) throw rateLimited(retryAfterMs);
      return {};
    },
  });
  const options = {
    now: () => clock,
    wait: async (ms) => {
      waits.push(ms);
      clock += ms;
    },
  };
  const patches = () => gateway.calls.filter(([method]) => method === "config.patch");
  return { gateway, options, waits, patches };
}

test("a rate-limited patch waits as long as the Gateway asks, then applies", async () => {
  const f = limitedGateway(1, 45000);
  const base = await patchConfig(
    f.gateway,
    () => ({ patch: { cron: { enabled: false } } }),
    f.options,
  );
  assert.equal(base.hash, "h1");
  assert.deepEqual(f.waits, [45000]);
  assert.equal(f.patches().length, 2);
});

test("a rate limit beyond the bound fails at once as configBusy, never in a loop", async () => {
  const f = limitedGateway(Infinity, 45000);
  await assert.rejects(
    patchConfig(f.gateway, () => ({ patch: { a: 1 } }), {
      ...f.options,
      maxWaitMs: 30000,
    }),
    (error) =>
      error.status === 503 && error.code === "CONFIG_BUSY" && error.key === "configBusy",
  );
  assert.deepEqual(f.waits, [], "a wait past the bound is not even started");
  assert.equal(f.patches().length, 1);
  // Within the default minute: one wait, one more patch, then the honest refusal.
  const g = limitedGateway(Infinity, 45000);
  await assert.rejects(
    patchConfig(g.gateway, () => ({ patch: { a: 1 } }), g.options),
    { code: "CONFIG_BUSY" },
  );
  assert.deepEqual(g.waits, [45000]);
  assert.equal(g.patches().length, 2);
});

test("a zero retry hint still pauses before the next patch", async () => {
  const f = limitedGateway(2, 0);
  await patchConfig(f.gateway, () => ({ patch: { a: 1 } }), f.options);
  assert.deepEqual(f.waits, [250, 250]);
  assert.equal(f.patches().length, 3);
});

test("a refusal without a retry hint is not repeated", async () => {
  const refused = Object.assign(Error("refused"), {
    code: "UNAVAILABLE",
    answered: true,
    retryable: false,
    retryAfterMs: 1000,
  });
  const gateway = client({
    "config.get": { hash: "h1", config: {} },
    "config.patch": refused,
  });
  let waited = false;
  await assert.rejects(
    patchConfig(gateway, () => ({ patch: { a: 1 } }), {
      wait: async () => (waited = true),
    }),
    refused,
  );
  assert.equal(waited, false);
});

// A write that timed out still runs in the Gateway (a config.patch is answered once
// its reload applied it). On a slow host an agents.create sent meanwhile locked that
// reload out of its database, which left the plugin lifecycle lease held for 5 min
// and the create unanswered (agent-deletion-contract on macos-latest).
function slowGateway(timeouts = 1) {
  const gateway = new EventEmitter();
  gateway.calls = [];
  gateway.late = [];
  gateway.call = async (method, params, options = {}) => {
    if (method === "agents.list") return { agents: [] };
    gateway.calls.push(method);
    if (method === "config.get") return { hash: "h1", config: {} };
    if (timeouts-- <= 0) return {};
    gateway.late.push(options.onLate);
    throw Object.assign(Error("timeout"), { code: "TIMEOUT", method });
  };
  return gateway;
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("the next write waits for the late answer of one that timed out", async () => {
  const gateway = slowGateway();
  await assert.rejects(
    patchConfig(gateway, () => ({ patch: { models: {} } })),
    { code: "TIMEOUT" },
  );
  assert.equal(typeof gateway.late[0], "function");
  const create = configWrite(gateway, (call) => call("agents.create", {}));
  for (let n = 0; n < 5; n++) await tick();
  assert.deepEqual(gateway.calls, ["config.get", "config.patch"]);
  gateway.late[0](true, {});
  await create;
  assert.deepEqual(gateway.calls, ["config.get", "config.patch", "agents.create"]);
});

test("a dropped connection or the settle bound ends the wait", async () => {
  const gateway = slowGateway();
  await assert.rejects(
    configWrite(gateway, (call) => call("agents.create", {})),
    { code: "TIMEOUT" },
  );
  const next = configWrite(gateway, (call) => call("agents.update", {}));
  await tick();
  assert.deepEqual(gateway.calls, ["agents.create"]);
  gateway.emit("disconnected");
  await next;
  assert.deepEqual(gateway.calls, ["agents.create", "agents.update"]);

  const bounded = slowGateway();
  const started = Date.now();
  await assert.rejects(
    configWrite(bounded, (call) => call("agents.delete", {}), { settleMs: 30 }),
    { code: "TIMEOUT" },
  );
  await configWrite(bounded, (call) => call("agents.update", {}));
  assert.ok(Date.now() - started >= 25);
  assert.deepEqual(bounded.calls, ["agents.delete", "agents.update"]);
});

test("an answered or refused write holds nothing back", async () => {
  const gateway = slowGateway(0);
  await configWrite(gateway, (call) => call("agents.create", {}));
  const refused = Object.assign(Error("no"), { code: "INVALID_REQUEST", answered: true });
  await assert.rejects(
    configWrite(gateway, async (call) => {
      await call("agents.update", {}).catch(() => {});
      throw refused;
    }),
    refused,
  );
  await configWrite(gateway, (call) => call("agents.delete", {}));
  assert.deepEqual(gateway.calls, ["agents.create", "agents.update", "agents.delete"]);
});

// OpenClaw reloads after every config.patch, an unchanged one too; the provider of an
// agent's model connection is written only when the configuration as written
// (sourceConfig, without resolved defaults) does not hold it yet.
test("a provider the configuration already holds is not written again", async () => {
  const provider = {
    baseUrl: "http://127.0.0.1:9/v1",
    api: "openai-completions",
    apiKey: undefined,
    models: [{ id: "echo", name: "echo", contextWindow: 32768, maxTokens: 4096 }],
  };
  const desired = { model: { providerId: "ap-c", provider } };
  const written = JSON.parse(JSON.stringify(provider));
  // As config.get answers: `config` with OpenClaw's resolved defaults.
  const resolved = {
    ...written,
    models: [{ ...written.models[0], reasoning: false, input: ["text"] }],
  };
  const gateway = client({
    "config.get": {
      hash: "h1",
      config: { models: { providers: { "ap-c": resolved } } },
      sourceConfig: { models: { providers: { "ap-c": written } } },
    },
  });
  const build = (config, answer) =>
    providerPatch(desired, answer?.sourceConfig ?? config);
  assert.equal(await patchConfig(gateway, build), null);
  assert.deepEqual(
    gateway.calls.map(([method]) => method),
    ["config.get"],
  );
  // A changed or missing entry, or none to compare (a redacted key never equals).
  assert.deepEqual(
    providerPatch(desired, { models: { providers: { "ap-c": resolved } } }),
    {
      patch: { models: { providers: { "ap-c": provider } } },
    },
  );
  assert.ok(providerPatch(desired, {}));
  assert.ok(providerPatch(desired));
  assert.equal(providerPatch({ model: { providerId: "ap-c" } }, {}), null);
});
