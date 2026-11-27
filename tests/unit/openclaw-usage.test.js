import test from "node:test";
import assert from "node:assert/strict";
import {
  dayRange,
  openClawUsage,
  usageContext,
  usageCost,
  usageOf,
  usageTokens,
} from "../../server/features/assistants/runtimes/openclaw/openclaw-usage.js";
import { openClawSessions } from "../../server/features/assistants/runtimes/openclaw/openclaw-sessions.js";
import { openClawAgents } from "../../server/features/assistants/runtimes/openclaw/openclaw-agents.js";
import { hermesCapabilities } from "../../server/features/assistants/runtimes/hermes/hermes-runtime.js";
import { RUNTIME_CAPABILITIES } from "../../server/features/assistants/runtimes/agent-runtime.js";

// Token usage and cost from OpenClaw 2026.11.6's `sessions.usage` report. The shapes
// below are the pinned Gateway's own (tests/integration/assistant-usage-contract).

const own =
  "ap-01d3fc36-4aec-475c-91dd-0f8e49e0ba2d-21e70b6e-a133-4f6b-a186-4c3ad4d960ea";
const totals = (patch = {}) => ({
  input: 1000,
  output: 300,
  cacheRead: 200,
  cacheWrite: 0,
  totalTokens: 1500,
  totalCost: 0.0045,
  inputCost: 0.002,
  outputCost: 0.0024,
  cacheReadCost: 0.0001,
  cacheWriteCost: 0,
  missingCostEntries: 0,
  ...patch,
});
const row = (provider, patch, count = 1) => ({ provider, count, totals: totals(patch) });
const report = (rows, patch = {}) => {
  const sum = (field) => rows.reduce((n, r) => n + (r.totals[field] || 0), 0);
  return {
    sessions: [{ key: "agent:ap-1:dashboard:1", usage: {} }],
    totals: totals({
      input: sum("input"),
      output: sum("output"),
      cacheRead: sum("cacheRead"),
      totalTokens: sum("totalTokens"),
      totalCost: sum("totalCost"),
      missingCostEntries: sum("missingCostEntries"),
    }),
    aggregates: {
      byProvider: rows,
      daily: [{ date: "2026-11-27", tokens: sum("totalTokens"), cost: sum("totalCost") }],
    },
    cacheStatus: { status: "fresh", cachedFiles: 1, pendingFiles: 0, staleFiles: 0 },
    ...patch,
  };
};

test("usage is a capability only OpenClaw offers", () => {
  assert.ok(RUNTIME_CAPABILITIES.includes("usage"));
  assert.deepEqual(hermesCapabilities.usage, {
    available: false,
    reason: "usageUnsupported",
  });
});

test("tokens are whole counts, and the total is OpenClaw's own", () => {
  assert.deepEqual(usageTokens(totals()), {
    input: 1000,
    output: 300,
    cacheRead: 200,
    cacheWrite: 0,
    total: 1500,
  });
  // Without a total the parts add up; junk counts as nothing.
  assert.deepEqual(usageTokens({ input: 10.4, output: "x", cacheRead: -3 }), {
    input: 10,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 10,
  });
  assert.equal(usageTokens(undefined).total, 0);
});

test("a priced connection's calls have a cost in USD", () => {
  assert.deepEqual(usageCost([row(own)]), {
    amount: 0.0045,
    currency: "USD",
    partial: false,
  });
  // A free model is priced, at nothing: OpenClaw reports no missing entry for it.
  assert.deepEqual(usageCost([row(own, { totalCost: 0 })]), {
    amount: 0,
    currency: "USD",
    partial: false,
  });
});

test("calls without a price have no cost, never an invented one", () => {
  // An endpoint model without a price: OpenClaw counts the call as missing.
  assert.equal(usageCost([row(own, { totalCost: 0, missingCostEntries: 1 })]), null);
  // A ChatGPT account runs on OpenClaw's own provider: whatever its catalog would
  // estimate for the subscription is no cost of the owner's.
  assert.equal(usageCost([row("openai", { totalCost: 4.2 })]), null);
  assert.equal(usageCost([]), null);
  assert.equal(usageCost(undefined), null);
});

test("a cost over priced and unpriced calls is a lower bound", () => {
  assert.deepEqual(usageCost([row(own), row("openai", { totalCost: 4.2 })]), {
    amount: 0.0045,
    currency: "USD",
    partial: true,
  });
  // Two calls of one provider, one of them without a price.
  assert.deepEqual(usageCost([row(own, { missingCostEntries: 1 }, 2)]), {
    amount: 0.0045,
    currency: "USD",
    partial: true,
  });
  // A provider row without any usage changes nothing.
  assert.equal(
    usageCost([row(own), row("openai", { totalTokens: 0, totalCost: 0 }, 0)]).partial,
    false,
  );
});

test("a report still being computed is pending", () => {
  assert.equal(usageOf(report([row(own)])).pending, false);
  const cold = report([], {
    sessions: [{ key: "k", usage: null, computing: true }],
    cacheStatus: { status: "refreshing", cachedFiles: 0, pendingFiles: 1, staleFiles: 1 },
  });
  assert.deepEqual(usageOf(cold), {
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: null,
    pending: true,
  });
  assert.equal(
    usageOf(report([row(own)], { partial: { reason: "time-budget" } })).pending,
    true,
  );
  assert.equal(
    usageOf(report([row(own)], { cacheStatus: { status: "partial" } })).pending,
    true,
  );
});

test("the context is the last call's size while OpenClaw holds a current one", () => {
  const session = { totalTokens: 1200, totalTokensFresh: true, contextTokens: 32768 };
  assert.deepEqual(usageContext(session), { used: 1200, limit: 32768 });
  assert.deepEqual(usageContext({ ...session, contextTokens: undefined }), {
    used: 1200,
    limit: null,
  });
  assert.equal(usageContext({ ...session, totalTokensFresh: false }), null);
  assert.equal(usageContext({ totalTokensFresh: true }), null);
  assert.equal(usageContext(undefined), null);
});

test("a range of days ends on the day of now, in the host's zone", () => {
  const now = new Date(2026, 10, 27, 23, 30).getTime();
  assert.deepEqual(dayRange(1, now), { from: "2026-11-27", to: "2026-11-27" });
  assert.deepEqual(dayRange(7, now), { from: "2026-11-21", to: "2026-11-27" });
  // Over a month's and a year's end.
  assert.deepEqual(dayRange(30, new Date(2027, 0, 5, 0, 10).getTime()), {
    from: "2026-12-07",
    to: "2027-01-05",
  });
});

function gateway(answers) {
  const calls = [];
  const call = async (method, params, options) => {
    calls.push([method, params, options]);
    const next = answers[method];
    const answer = Array.isArray(next) ? next.shift() : next;
    if (answer instanceof Error) throw answer;
    return structuredClone(answer);
  };
  return { calls, call };
}

test("a session's usage reads its whole report and its context", async () => {
  const g = gateway({
    "sessions.usage": report([row(own)]),
    "sessions.describe": {
      session: { totalTokens: 1200, totalTokensFresh: true, contextTokens: 32768 },
    },
  });
  const client = { call: g.call };
  const sessions = openClawSessions({ client }, () => client);
  assert.deepEqual(await sessions.usage({ key: "agent:ap-1:dashboard:1" }), {
    tokens: { input: 1000, output: 300, cacheRead: 200, cacheWrite: 0, total: 1500 },
    cost: { amount: 0.0045, currency: "USD", partial: false },
    pending: false,
    context: { used: 1200, limit: 32768 },
  });
  assert.deepEqual(g.calls[0].slice(0, 2), [
    "sessions.usage",
    { key: "agent:ap-1:dashboard:1", range: "all", mode: "gateway", limit: 1 },
  ]);
  // A failed describe costs only the context.
  const waits = [];
  const sleep = async (ms) => waits.push(ms);
  const blind = gateway({
    "sessions.usage": report([row(own)]),
    "sessions.describe": new Error("gone"),
  });
  assert.equal(
    (await openClawUsage(blind.call, { sleep }).session({ key: "k" })).context,
    null,
  );
  // At a run's end the size follows the report: it is read again, twice at most.
  assert.deepEqual(waits, [250, 500]);
  waits.length = 0;
  const late = gateway({
    "sessions.usage": report([row(own)]),
    "sessions.describe": [
      { session: { totalTokens: 900, totalTokensFresh: false } },
      { session: { totalTokens: 1200, totalTokensFresh: true } },
    ],
  });
  assert.deepEqual(
    (await openClawUsage(late.call, { sleep }).session({ key: "k" })).context,
    {
      used: 1200,
      limit: null,
    },
  );
  assert.deepEqual(waits, [250]);
  // A session without usage has no size to wait for.
  waits.length = 0;
  const unused = gateway({ "sessions.usage": report([]), "sessions.describe": {} });
  await openClawUsage(unused.call, { sleep }).session({ key: "k" });
  assert.deepEqual(waits, []);
});

test("an agent's usage reads the days of the range and fills the days without", async () => {
  const g = gateway({ "sessions.usage": report([row(own)]) });
  const client = { call: g.call };
  const agents = openClawAgents({ client }, () => client);
  const now = new Date(2026, 10, 27, 12).getTime();
  const usage = await agents.usage({ agentId: "ap-1", days: 3, now });
  assert.deepEqual(g.calls[0].slice(0, 2), [
    "sessions.usage",
    {
      agentId: "ap-1",
      startDate: "2026-11-25",
      endDate: "2026-11-27",
      mode: "gateway",
      limit: 1,
    },
  ]);
  assert.deepEqual(usage, {
    from: "2026-11-25",
    to: "2026-11-27",
    tokens: { input: 1000, output: 300, cacheRead: 200, cacheWrite: 0, total: 1500 },
    cost: { amount: 0.0045, currency: "USD", partial: false },
    pending: false,
    daily: [
      { date: "2026-11-25", tokens: 0 },
      { date: "2026-11-26", tokens: 0 },
      { date: "2026-11-27", tokens: 1500 },
    ],
  });
  for (const days of [0, 367, 1.5, "7", undefined])
    await assert.rejects(agents.usage({ agentId: "ap-1", days, now }), TypeError);
});

test("a report still computed after a turn is read again, a few times at most", async () => {
  const cold = report([], {
    sessions: [{ key: "k", usage: null, computing: true }],
    cacheStatus: { status: "refreshing" },
  });
  const waits = [];
  const sleep = async (ms) => waits.push(ms);
  const settles = gateway({
    "sessions.usage": [cold, cold, report([row(own)])],
    "sessions.describe": { session: { totalTokens: 1200, totalTokensFresh: true } },
  });
  const settled = await openClawUsage(settles.call, { sleep }).session({ key: "k" });
  assert.equal(settled.pending, false);
  assert.equal(settled.tokens.total, 1500);
  assert.deepEqual(waits, [250, 500]);
  // One that never settles answers what it has, marked pending.
  waits.length = 0;
  const never = gateway({ "sessions.usage": cold, "sessions.describe": {} });
  const pending = await openClawUsage(never.call, { sleep }).session({ key: "k" });
  assert.equal(pending.pending, true);
  assert.deepEqual(waits, [250, 500, 1000]);
  assert.equal(never.calls.filter(([method]) => method === "sessions.usage").length, 4);
});

test("a view bound to a replaced connection reads no usage", async () => {
  const live = { call: gateway({ "sessions.usage": report([row(own)]) }).call };
  const supervisor = { client: live };
  const handle = {};
  const clientOf = (connection) => (connection === handle ? live : null);
  const bound = openClawAgents(supervisor, clientOf).on({});
  await assert.rejects(bound.usage({ agentId: "ap-1", days: 1 }));
  assert.equal(
    (
      await openClawAgents(supervisor, clientOf)
        .on(handle)
        .usage({ agentId: "ap-1", days: 1 })
    ).tokens.total,
    1500,
  );
});
