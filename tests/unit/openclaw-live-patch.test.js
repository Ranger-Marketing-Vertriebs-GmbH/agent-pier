import test from "node:test";
import assert from "node:assert/strict";
import { patchConfig } from "../../server/features/assistants/openclaw-config/live-patch.js";

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
