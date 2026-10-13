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

test("models.list rows map to selectable bare IDs of the openai provider", () => {
  const parsed = parseModelsList(
    listed([
      row("gpt-6-astra", { name: "GPT-6 Astra" }),
      row("gpt-5.5", { name: "  " }),
      row("gpt-5.4-nano", { available: false, unavailableReason: "missing-auth" }),
      row("gpt-5.6-luna", { available: false, unavailableReason: "cooldown" }),
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
    { modelId: "gpt-6-sol", label: "GPT-6-SOL" },
    { modelId: "ctrl", label: "Line break " },
    { modelId: "no-name", label: "no-name" },
  ]);
  assert.equal(parsed.outcomes.get(profileId), "ready");
  assert.equal(parsed.pending, false);
  for (const malformed of [null, "models", {}, { models: "gpt-6" }])
    assert.equal(parseModelsList(malformed), null);
});

test("the catalog reads once, shares concurrent reads and keeps its list for the TTL", async () => {
  let now = 1000;
  const { runtime, calls, release } = gateway([
    "hold",
    listed([row("gpt-6-astra")]),
    listed([row("gpt-6-sol")]),
  ]);
  let changes = 0;
  const catalog = new ModelAccountCatalog({
    runtime,
    now: () => now,
    ttlMs: 600,
    retryMs: 60,
    onChange: () => changes++,
  });
  assert.deepEqual(catalog.account(profileId), { models: [], modelCatalog: "loading" });
  catalog.ensure();
  catalog.ensure();
  const shared = catalog.refresh({ force: true });
  assert.equal(calls.length, 1, "in-flight reads are shared");
  assert.deepEqual(calls[0], {
    method: "models.list",
    params: { agentId: "main", provider: "openai", view: "all" },
  });
  assert.equal(catalog.account(profileId).modelCatalog, "loading");
  release();
  await shared;
  assert.equal(changes, 1);
  assert.deepEqual(catalog.account(profileId), {
    models: [{ modelId: "gpt-6-astra", label: "GPT-6-ASTRA" }],
    modelCatalog: "ready",
  });
  now += 599;
  catalog.ensure();
  assert.equal(calls.length, 1, "fresh within the TTL");
  now += 1;
  catalog.ensure();
  await catalog.loading?.catch(() => {});
  assert.equal(calls.length, 2, "stale after the TTL");
  assert.deepEqual(catalog.account(profileId).models, [
    { modelId: "gpt-6-sol", label: "GPT-6-SOL" },
  ]);
  await catalog.refresh({ force: true }).catch(() => {});
  assert.deepEqual(calls[2].params.refresh, true, "a forced read rediscovers");
});

test("a pending provider is read again with refresh; failures keep the last list", async () => {
  let now = 0;
  const { runtime, calls } = gateway([
    { models: [], pendingProviders: ["openai"] },
    listed([row("gpt-6-astra")]),
    Object.assign(Error("down"), { code: "UNAVAILABLE" }),
    { models: "broken" },
  ]);
  const catalog = new ModelAccountCatalog({
    runtime,
    now: () => now,
    ttlMs: 600,
    retryMs: 60,
  });
  await catalog.refresh();
  assert.deepEqual(
    calls.map((c) => c.params.refresh),
    [undefined, true],
  );
  assert.equal(catalog.account(profileId).modelCatalog, "ready");
  await assert.rejects(catalog.refresh({ force: true }), /down/);
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
  runtime.client.ready = false;
  await assert.rejects(catalog.refresh(), { status: 503 });
  assert.equal(calls.length, 4, "no read without a Gateway");
  assert.equal(catalog.account(profileId).modelCatalog, "failed");
});

test("an account the Gateway rejected gets no list, other accounts keep theirs", async () => {
  const { runtime } = gateway([
    {
      models: [row("gpt-6-astra")],
      providerOutcomes: [
        { provider: "openai", profileId: "openai:rejected", status: "auth-rejected" },
        { provider: "openai", profileId, status: "ready" },
      ],
    },
  ]);
  const catalog = new ModelAccountCatalog({ runtime });
  await catalog.refresh();
  assert.deepEqual(catalog.account("openai:rejected"), {
    models: [],
    modelCatalog: "failed",
  });
  assert.equal(catalog.account(profileId).models.length, 1);
  assert.equal(catalog.account("openai:no-outcome").models.length, 1);
});

test("accounts expose cached models synchronously and refresh on request", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-account-models-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const calls = [];
  let fail = false;
  const runtime = {
    client: {
      ready: true,
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
          if (fail) throw Error("Gateway down");
          return listed([row("gpt-6-astra")]);
        }
        return {};
      },
    },
  };
  const accounts = new AssistantModelAccounts({ dataDir, runtime });
  const [first] = await accounts.list();
  assert.deepEqual(first.models, []);
  assert.equal(first.modelCatalog, "loading");
  await accounts.catalog.loading;
  const [account] = accounts.capabilities();
  assert.deepEqual(account.models, [{ modelId: "gpt-6-astra", label: "GPT-6-ASTRA" }]);
  assert.equal(account.modelCatalog, "ready");
  const lease = await accounts.resolve(account.id, account.models[0].modelId);
  assert.equal(lease.modelRef, `openai/gpt-6-astra@${profileId}`);
  lease.release();
  assert.deepEqual(await accounts.refreshModels(account.id), {
    models: account.models,
    modelCatalog: "ready",
  });
  assert.equal(
    calls.filter((c) => c.method === "models.list").at(-1).params.refresh,
    true,
  );
  fail = true;
  assert.deepEqual(await accounts.refreshModels(account.id), {
    models: account.models,
    modelCatalog: "failed",
  });
  await assert.rejects(accounts.refreshModels("openclaw:unknown"), { status: 400 });
  runtime.client.ready = false;
  await assert.rejects(accounts.refreshModels(account.id), { status: 503 });
});
