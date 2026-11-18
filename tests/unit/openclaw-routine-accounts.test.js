import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  accountAdoptions,
  adoptRoutineAccounts,
  modelAccount,
  readAccountBindings,
} from "../../server/features/assistants/runtimes/openclaw/openclaw-routine-accounts.js";

const profile = "openai:owner@example.invalid";
const agentRef = `openai/gpt-6-astra@${profile}`;
const routine = (id, extra = {}) => ({
  id,
  agentId: "ap-1",
  target: { kind: "chat", sessionKey: "agent:ap-1:main" },
  prompt: { text: "Check in." },
  ...extra,
});

// OpenClaw 2026.11.3's cron store: the job's JSON carries its recorded account.
function cronStore(t, jobs) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cron-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(stateDir, "state"));
  const db = new DatabaseSync(path.join(stateDir, "state", "openclaw.sqlite"));
  db.exec("CREATE TABLE cron_jobs (store_key TEXT, job_id TEXT, job_json TEXT)");
  for (const [id, job] of Object.entries(jobs))
    db.prepare("INSERT INTO cron_jobs VALUES ('default', ?, ?)").run(
      id,
      JSON.stringify(job),
    );
  db.close();
  return stateDir;
}

test("a model reference names its provider, model and account", () => {
  assert.deepEqual(modelAccount(agentRef), {
    provider: "openai",
    model: "openai/gpt-6-astra",
    profileId: profile,
  });
  assert.deepEqual(modelAccount({ primary: "anthropic/claude" }), {
    provider: "anthropic",
    model: "anthropic/claude",
    profileId: null,
  });
  assert.equal(modelAccount(""), null);
  assert.equal(modelAccount(undefined), null);
});

test("jobs without the agent's account adopt it and keep their own model choice", () => {
  const jobs = [
    routine("inherits"),
    routine("own-model", { prompt: { text: "x", model: "openai/gpt-6-mini" } }),
    routine("bound"),
    routine("bound-elsewhere"),
    routine("explicit", { prompt: { text: "x", model: `openai/gpt-6@openai:other` } }),
    routine("other-provider", { prompt: { text: "x", model: "fixture/model" } }),
    routine("main-session", { target: { kind: "main" } }),
    routine("system-event", { prompt: null }),
    routine("other-agent", { agentId: "ap-2" }),
  ];
  const bindings = new Map([
    ["bound", { provider: "openai", profileId: profile }],
    ["bound-elsewhere", { provider: "openai", profileId: "openai:gone" }],
  ]);
  assert.deepEqual(
    accountAdoptions({ jobs, agents: new Map([["ap-1", agentRef]]), bindings }),
    [
      { id: "inherits", agentId: "ap-1", adopt: agentRef, restore: null },
      {
        id: "own-model",
        agentId: "ap-1",
        adopt: `openai/gpt-6-mini@${profile}`,
        restore: "openai/gpt-6-mini",
      },
      { id: "bound-elsewhere", agentId: "ap-1", adopt: agentRef, restore: null },
      {
        id: "explicit",
        agentId: "ap-1",
        adopt: "openai/gpt-6@openai:other",
        restore: undefined,
      },
    ],
  );
  // Unknown bindings (an unreadable store): every candidate adopts again.
  assert.equal(
    accountAdoptions({ jobs, agents: new Map([["ap-1", agentRef]]), bindings: null })
      .length,
    5,
  );
  // An agent on a configured key records nothing.
  assert.deepEqual(
    accountAdoptions({
      jobs,
      agents: new Map([["ap-1", "fixture/model"]]),
      bindings: new Map(),
    }).map((a) => a.id),
    ["explicit"],
  );
});

test("the recorded accounts are read from OpenClaw's cron store, never written", (t) => {
  const stateDir = cronStore(t, {
    a: { payload: { kind: "agentTurn" } },
    b: {
      payload: { kind: "agentTurn" },
      inferenceBinding: {
        provider: "openai",
        profileId: profile,
        authorizationId: "secret-free-hash",
      },
    },
  });
  assert.deepEqual(
    readAccountBindings(stateDir),
    new Map([["b", { provider: "openai", profileId: profile }]]),
  );
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-none-"));
  t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
  assert.equal(readAccountBindings(empty), null);
});

test("adoption selects the account, restores the job's model and reports refusals", async (t) => {
  const stateDir = cronStore(t, {});
  const calls = [];
  const call = async (method, params) => {
    calls.push([method, params]);
    if (method === "config.get")
      return {
        config: {
          agents: {
            entries: {
              "ap-1": { model: agentRef },
              "ap-2": { model: { primary: `openai/gpt-6@openai:logged-out` } },
            },
          },
        },
      };
    if (params.id === "refused")
      throw new Error("The selected automation account is unavailable.");
    return {};
  };
  const list = async () => [
    routine("inherits"),
    routine("own-model", { prompt: { text: "x", model: "openai/gpt-6-mini" } }),
    routine("refused", { agentId: "ap-2" }),
  ];
  const result = await adoptRoutineAccounts({ call, list, stateDir });
  assert.deepEqual(result, {
    adopted: ["inherits", "own-model"],
    failed: [
      {
        id: "refused",
        agentId: "ap-2",
        message: "The selected automation account is unavailable.",
      },
    ],
  });
  const updates = calls.filter(([m]) => m === "cron.update").map(([, p]) => p);
  assert.deepEqual(updates, [
    { id: "inherits", patch: { payload: { kind: "agentTurn", model: agentRef } } },
    { id: "inherits", patch: { payload: { kind: "agentTurn", model: null } } },
    {
      id: "own-model",
      patch: { payload: { kind: "agentTurn", model: `openai/gpt-6-mini@${profile}` } },
    },
    {
      id: "own-model",
      patch: { payload: { kind: "agentTurn", model: "openai/gpt-6-mini" } },
    },
    {
      id: "refused",
      patch: {
        payload: { kind: "agentTurn", model: "openai/gpt-6@openai:logged-out" },
      },
    },
  ]);

  // One agent only: its jobs alone.
  calls.length = 0;
  const one = await adoptRoutineAccounts({ call, list, stateDir, agentId: "ap-2" });
  assert.deepEqual(one.adopted, []);
  assert.deepEqual(
    calls.filter(([m]) => m === "cron.update").map(([, p]) => p.id),
    ["refused"],
  );
});
