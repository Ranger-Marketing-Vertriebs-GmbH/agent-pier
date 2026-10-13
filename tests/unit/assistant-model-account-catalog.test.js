import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ModelAccountCatalog,
  parseModelsList,
} from "../../server/features/assistants/model-account-catalog.js";
import { AssistantModelAccounts } from "../../server/features/assistants/model-accounts.js";
import { AssistantAccountLogin } from "../../server/features/assistants/model-account-login.js";

const profileId = "openai:fixture@example.invalid";
const listed = (models, extra = {}) => ({
  models,
  providerOutcomes: [{ provider: "openai", profileId, status: "ready" }],
  ...extra,
});
const row = (id, extra = {}) => ({
  id,
  name: id.toUpperCase(),
  provider: "openai",
  available: true,
  ...extra,
});

function gateway(answers) {
  const calls = [];
  const pending = [];
  const runtime = {
    client: {
      ready: true,
      call: (method, params) => {
        calls.push({ method, params });
        const answer = answers.shift();
        if (answer === "hold")
          return new Promise((resolve) => pending.push(() => resolve(answers.shift())));
        return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
      },
    },
  };
  return { runtime, calls, release: () => pending.shift()() };
}
const quiet = { warn: () => {} };

test("models.list rows map to selectable bare IDs of the openai provider", () => {
  const parsed = parseModelsList(
    listed([
      row("gpt-6-astra", { name: "GPT-6 Astra" }),
      row("gpt-5.5", { name: "  " }),
      row("gpt-5.4-nano", { available: false, unavailableReason: "missing-auth" }),
      row("gpt-5.6-luna", { available: false, unavailableReason: "cooldown" }),
      // The pinned Gateway sends a boolean without includeDetails: fail closed.
      row("gpt-6-sol", { available: undefined }),
      row("gpt-6-astra"),
      row("openrouter-model", { provider: "openrouter" }),
      row("openai/gpt-6"),
      row("gpt 6"),
      row("-leading"),
      row("x".repeat(129)),
      row("ctrl", { name: "Line\nbreak\u0007" }),
      { ...row("no-name"), name: 42 },
      null,
      "gpt-6",
      { provider: "openai" },
    ]),
  );
  assert.deepEqual(parsed.models, [
    { modelId: "gpt-6-astra", label: "GPT-6 Astra" },
    { modelId: "gpt-5.5", label: "gpt-5.5" },
    { modelId: "gpt-5.6-luna", label: "GPT-5.6-LUNA" },
    { modelId: "ctrl", label: "Line break " },
    { modelId: "no-name", label: "no-name" },
  ]);
  assert.equal(parsed.outcomes.get(profileId), "ready");
  assert.equal(parsed.pending, false);
  assert.equal(parsed.stale, false);
  // refreshFailed covers every provider; only an unavailable openai outcome counts.
  const outcome = (provider, status) => ({ provider, profileId, status });
  assert.equal(parseModelsList({ models: [], refreshFailed: true }).stale, false);
  assert.equal(
    parseModelsList({
      models: [],
      refreshFailed: true,
      providerOutcomes: [outcome("openai", "ready"), outcome("ollama", "unavailable")],
    }).stale,
    false,
    "another provider failed, openai is fine",
  );
  assert.equal(
    parseModelsList({
      models: [],
      refreshFailed: true,
      providerOutcomes: [outcome("openai", "unavailable")],
    }).stale,
    true,
    "the openai discovery failed",
  );
  for (const malformed of [null, "models", {}, { models: "gpt-6" }])
    assert.equal(parseModelsList(malformed), null);
});

test("the catalog shares reads, chains a forced read after an unforced one and keeps the TTL", async () => {
  let now = 1000;
  const { runtime, calls, release } = gateway([
    "hold",
    listed([row("gpt-6-astra")]),
    listed([row("gpt-6-sol")]),
    listed([row("gpt-5.5")]),
  ]);
  let changes = 0;
  const catalog = new ModelAccountCatalog({
    runtime,
    now: () => now,
    ttlMs: 600,
    retryMs: 60,
    onChange: () => changes++,
    ...quiet,
  });
  // Nothing read and nothing running is not "loading".
  assert.deepEqual(catalog.account(profileId), { models: [], modelCatalog: "failed" });
  catalog.ensure();
  catalog.ensure();
  const unforced = catalog.refresh();
  const forced = catalog.refresh({ force: true });
  assert.equal(catalog.refresh({ force: true }), forced, "one chained forced read");
  assert.equal(calls.length, 1, "in-flight reads are shared");
  assert.deepEqual(calls[0], {
    method: "models.list",
    params: { agentId: "main", provider: "openai", view: "all" },
  });
  assert.equal(catalog.account(profileId).modelCatalog, "loading");
  release();
  await unforced;
  await forced;
  assert.equal(calls.length, 2);
  assert.equal(calls[1].params.refresh, true, "the forced read rediscovers");
  assert.equal(changes, 2);
  assert.deepEqual(catalog.account(profileId), {
    models: [{ modelId: "gpt-6-sol", label: "GPT-6-SOL" }],
    modelCatalog: "ready",
  });
  // A forced read joins a forced one already running.
  const first = catalog.refresh({ force: true });
  assert.equal(catalog.refresh({ force: true }), first);
  await first;
  assert.equal(calls.length, 3);
  now += 599;
  catalog.ensure();
  assert.equal(calls.length, 3, "fresh within the TTL");
  now += 1;
  catalog.ensure();
  assert.equal(calls.length, 4, "stale after the TTL");
  await catalog.loading?.catch(() => {});
});

test("a pending provider is read again with refresh; failures keep the last list and log a code", async () => {
  let now = 0;
  const { runtime, calls } = gateway([
    { models: [], pendingProviders: ["openai"] },
    listed([row("gpt-6-astra")]),
    Object.assign(Error("secret upstream text"), { code: "UNAVAILABLE" }),
    { models: "broken" },
  ]);
  const logs = [];
  const catalog = new ModelAccountCatalog({
    runtime,
    now: () => now,
    ttlMs: 600,
    retryMs: 60,
    warn: (line) => logs.push(line),
  });
  await catalog.refresh();
  assert.deepEqual(
    calls.map((c) => c.params.refresh),
    [undefined, true],
  );
  assert.equal(catalog.account(profileId).modelCatalog, "ready");
  await assert.rejects(catalog.refresh({ force: true }), /secret/);
  assert.deepEqual(catalog.account(profileId), {
    models: [{ modelId: "gpt-6-astra", label: "GPT-6-ASTRA" }],
    modelCatalog: "failed",
  });
  now += 59;
  catalog.ensure();
  assert.equal(calls.length, 3, "a failed read is retried after retryMs only");
  now += 1;
  catalog.ensure();
  await catalog.loading?.catch(() => {});
  assert.equal(calls.length, 4);
  assert.equal(catalog.account(profileId).modelCatalog, "failed", "malformed answer");
  assert.deepEqual(logs, [
    "ChatGPT model list could not be read (UNAVAILABLE).",
    "ChatGPT model list could not be read (unexpected answer).",
  ]);
  runtime.client.ready = false;
  await assert.rejects(catalog.refresh(), { status: 503 });
  assert.equal(calls.length, 4, "no read without a Gateway");
  assert.equal(catalog.account(profileId).modelCatalog, "failed");
});

test("a forced read the Gateway answers while discovery still runs is read again", async () => {
  const pending = { models: [], pendingProviders: ["openai"] };
  const { runtime, calls } = gateway([
    pending,
    listed([row("gpt-6-astra")]),
    ...Array(26).fill(pending),
  ]);
  const logs = [];
  const catalog = new ModelAccountCatalog({ runtime, warn: (line) => logs.push(line) });
  await catalog.refresh({ force: true });
  assert.deepEqual(
    calls.map((c) => c.params.refresh),
    [true, true],
  );
  assert.equal(catalog.account(profileId).modelCatalog, "ready");
  assert.deepEqual(logs, [], "a pending answer is not an unexpected one");
  // Discovery that never ends is bounded and logged as such.
  await assert.rejects(catalog.refresh({ force: true }), { code: "PENDING" });
  assert.equal(calls.length, 27, "one read and 24 refreshes while pending");
  assert.deepEqual(catalog.account(profileId), {
    models: [{ modelId: "gpt-6-astra", label: "GPT-6-ASTRA" }],
    modelCatalog: "failed",
  });
  assert.deepEqual(logs, ["ChatGPT model list could not be read (PENDING)."]);
});

test("availability is the agent's: rejected, unknown, empty and stale lists are marked", async () => {
  const { runtime, calls } = gateway([
    {
      models: [row("gpt-6-astra")],
      providerOutcomes: [
        { provider: "openai", profileId: "openai:rejected", status: "auth-rejected" },
        { provider: "openai", profileId, status: "ready" },
      ],
    },
    listed([row("gpt-6-astra", { available: false, unavailableReason: "auth-failed" })]),
    {
      models: [row("gpt-6-astra")],
      refreshFailed: true,
      providerOutcomes: [{ provider: "openai", profileId, status: "unavailable" }],
    },
    listed([row("gpt-6-sol")], { refreshFailed: true }),
  ]);
  let now = 0;
  const catalog = new ModelAccountCatalog({
    runtime,
    now: () => now,
    retryMs: 60,
    ttlMs: 600,
    ...quiet,
  });
  await catalog.refresh();
  assert.deepEqual(catalog.account("openai:rejected", { accounts: 3 }), {
    models: [],
    modelCatalog: "failed",
  });
  assert.equal(catalog.account(profileId, { accounts: 3 }).modelCatalog, "ready");
  // Checked against another profile: offered, but marked as unknown.
  assert.deepEqual(catalog.account("openai:no-outcome", { accounts: 3 }), {
    models: [{ modelId: "gpt-6-astra", label: "GPT-6-ASTRA" }],
    modelCatalog: "unknown",
  });
  assert.equal(catalog.account("openai:no-outcome").modelCatalog, "ready", "alone");
  await catalog.refresh();
  assert.deepEqual(catalog.account(profileId), { models: [], modelCatalog: "failed" });
  await catalog.refresh();
  // The openai discovery was unavailable: the kept list is stale.
  assert.deepEqual(catalog.account("openai:other"), {
    models: [{ modelId: "gpt-6-astra", label: "GPT-6-ASTRA" }],
    modelCatalog: "failed",
  });
  now += 59;
  assert.equal(catalog.stale(), false, "retried after retryMs");
  now += 1;
  catalog.ensure();
  await catalog.loading;
  assert.equal(calls.at(-1).params.refresh, true, "the stale retry is forced");
  // Another provider still failing does not keep the list stale.
  assert.deepEqual(catalog.account(profileId), {
    models: [{ modelId: "gpt-6-sol", label: "GPT-6-SOL" }],
    modelCatalog: "ready",
  });
  assert.equal(catalog.stale(), false);
});

function accountsFixture(t, { hold = false } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-account-models-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const calls = [];
  const held = [];
  const state = { fail: false, hold };
  const client = {
    ready: true,
    on() {},
    once() {},
    off() {},
    call: async (method, params) => {
      calls.push({ method, params });
      if (method === "models.authStatus")
        return {
          providers: [
            {
              provider: "openai",
              profiles: [{ profileId, type: "oauth", status: "ok", displayName: "P" }],
            },
          ],
        };
      if (method === "models.list") {
        if (state.hold) await new Promise((resolve) => held.push(resolve));
        if (state.fail) throw Error("Gateway down");
        return listed([row(params.refresh ? "gpt-6-sol" : "gpt-6-astra")]);
      }
      if (method === "models.authLogin") return { done: false };
      if (method === "wizard.next") return { done: true, status: "done" };
      if (method === "models.probe") return { status: "ok" };
      return {};
    },
  };
  const runtime = { client };
  const accounts = new AssistantModelAccounts({ dataDir, runtime });
  accounts.catalog.warn = () => {};
  const lists = () => calls.filter((c) => c.method === "models.list");
  return { accounts, runtime, calls, lists, held, state };
}

test("accounts expose cached models synchronously; only the pages start reads", async (t) => {
  const { accounts, runtime, lists, state } = accountsFixture(t);
  const [first] = await accounts.list();
  assert.deepEqual(first.models, []);
  assert.equal(first.modelCatalog, "failed", "no read running yet");
  assert.equal(lists().length, 0, "listing accounts internally reads no models");
  accounts.ensureModels();
  await accounts.catalog.loading;
  const [account] = accounts.capabilities();
  assert.deepEqual(account.models, [{ modelId: "gpt-6-astra", label: "GPT-6-ASTRA" }]);
  assert.equal(account.modelCatalog, "ready");
  const lease = await accounts.resolve(account.id, account.models[0].modelId);
  assert.equal(lease.modelRef, `openai/gpt-6-astra@${profileId}`);
  lease.release();
  await accounts.check(account.id);
  assert.equal(lists().length, 1, "runs and checks read no models");
  assert.deepEqual(await accounts.refreshModels(account.id), {
    models: [{ modelId: "gpt-6-sol", label: "GPT-6-SOL" }],
    modelCatalog: "ready",
  });
  assert.equal(lists().at(-1).params.refresh, true);
  state.fail = true;
  assert.deepEqual(await accounts.refreshModels(account.id), {
    models: [{ modelId: "gpt-6-sol", label: "GPT-6-SOL" }],
    modelCatalog: "failed",
  });
  await assert.rejects(accounts.refreshModels("openclaw:unknown"), { status: 400 });
  runtime.client.ready = false;
  await assert.rejects(accounts.refreshModels(account.id), { status: 503 });
});

test("a sign-in during a page's background read still forces a rediscovery", async (t) => {
  const { accounts, runtime, lists, held, state } = accountsFixture(t, { hold: true });
  await accounts.list();
  // The agents page loads: the stale cache starts an unforced read.
  accounts.ensureModels();
  assert.equal(lists().length, 1);
  const login = new AssistantAccountLogin({
    runtime,
    accounts,
    warn: () => {},
  });
  login.start();
  for (let i = 0; i < 200 && login.status().status !== "completed"; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(login.status().status, "completed");
  assert.equal(lists().length, 1, "the forced read waits for the running one");
  state.hold = false;
  held.shift()();
  await accounts.catalog.loading;
  await accounts.catalog.loading;
  assert.deepEqual(
    lists().map((c) => c.params.refresh),
    [undefined, true],
  );
  assert.deepEqual(accounts.capabilities()[0].models, [
    { modelId: "gpt-6-sol", label: "GPT-6-SOL" },
  ]);
});
