import test from "node:test";
import assert from "node:assert/strict";
import {
  AgentUsage,
  usageCacheMs,
  usageOf,
  usagePendingMs,
  usagePeriods,
} from "../../server/features/assistants/agent-usage.js";
import {
  USAGE_PENDING_SAMPLE_MS,
  agentUsageChanged,
  agentUsageTopics,
} from "../../server/features/assistants/live-usage-topics.js";
import { chatEventListener } from "../../server/features/assistants/gateway-wiring.js";
import {
  available,
  unavailable,
} from "../../server/features/assistants/runtimes/agent-runtime.js";
import { assistantProblem } from "../../server/features/assistants/assistant-validation.js";

// What an agent's sessions used, for the owner (agent-usage.js): read through the
// runtime port, kept per agent and chat, dropped when a run of the chat ends.

const tokens = (total) => ({
  input: total - 300,
  output: 300,
  cacheRead: 0,
  cacheWrite: 0,
  total,
});
const priced = { amount: 0.0045, currency: "USD", partial: false };
const agents = {
  a1: { id: "a1", runtimeAgentId: "ap-1" },
  h1: { id: "h1", runtimeAgentId: "ap-h", runtime: "hermes" },
};
const chats = {
  c1: { id: "c1", assistantId: "a1", runtimeSessionKey: "agent:ap-1:dashboard:1" },
  hers: {
    id: "hers",
    assistantId: "a1",
    userId: "u1",
    runtimeSessionKey: "agent:ap-1:dashboard:2",
  },
  fresh: { id: "fresh", assistantId: "a1" },
};
const found = (map, id) => {
  if (!map[id]) throw assistantProblem("notFound", 404);
  return map[id];
};

function fixture({ cost = priced, pending = false, ready = true } = {}) {
  const state = { now: new Date(2026, 10, 27, 12).getTime(), cost, pending, ready };
  const calls = [];
  const runtime = {
    capabilities: () => ({ usage: available() }),
    agents: {
      usage: async ({ agentId, days, now }) => {
        calls.push(["agent", agentId, days]);
        if (state.fail) throw Object.assign(new Error("secret reason"), { code: "X" });
        return {
          from: `from-${days}`,
          to: "2026-11-27",
          tokens: tokens(days * 1000),
          cost: state.cost,
          pending: state.pending,
          daily: Array.from({ length: days }, (_, i) => ({ date: `d${i}`, tokens: i })),
          now,
        };
      },
    },
    sessions: {
      usage: async ({ key }) => {
        calls.push(["chat", key]);
        return {
          tokens: tokens(1500),
          cost: state.cost,
          pending: state.pending,
          context: { used: 1200, limit: 32768 },
        };
      },
    },
  };
  const hermes = { capabilities: () => ({ usage: unavailable("usageUnsupported") }) };
  const assistants = {
    store: {
      getAssistant: (id) => found(agents, id),
      getConversation: (id) => found(chats, id),
    },
    maintenance: false,
    requireReady() {
      if (!state.ready) throw assistantProblem("unavailable", 503);
    },
  };
  const usage = new AgentUsage(assistants, {
    now: () => state.now,
    runtimeOf: (agent) => (agent.runtime === "hermes" ? hermes : runtime),
  });
  assistants.usage = usage;
  return { state, calls, usage, assistants };
}

test("an agent's usage names today, 7 and 30 days from the runtime's own figures", async () => {
  const { usage, calls } = fixture();
  const view = await usage.agent("a1");
  assert.deepEqual(
    usagePeriods.map((p) => [p.id, p.days]),
    [
      ["today", 1],
      ["week", 7],
      ["month", 30],
    ],
  );
  assert.deepEqual(
    view.periods.map((p) => [p.id, p.days, p.from, p.to, p.tokens.total, p.cost]),
    [
      ["today", 1, "from-1", "2026-11-27", 1000, priced],
      ["week", 7, "from-7", "2026-11-27", 7000, priced],
      ["month", 30, "from-30", "2026-11-27", 30000, priced],
    ],
  );
  // The tokens per day are the longest period's; nothing else of the port leaks.
  assert.equal(view.daily.length, 30);
  assert.equal(view.pending, false);
  assert.deepEqual(Object.keys(view).sort(), [
    "daily",
    "pending",
    "periods",
    "updatedAt",
  ]);
  assert.deepEqual(Object.keys(view.periods[0]).sort(), [
    "cost",
    "days",
    "from",
    "id",
    "pending",
    "to",
    "tokens",
  ]);
  assert.deepEqual(calls, [
    ["agent", "ap-1", 1],
    ["agent", "ap-1", 7],
    ["agent", "ap-1", 30],
  ]);
});

test("a read is kept for a while and shared while in flight", async () => {
  const { usage, calls, state } = fixture();
  const [first, second] = await Promise.all([usage.agent("a1"), usage.agent("a1")]);
  assert.equal(first, second);
  assert.equal(calls.length, 3);
  state.now += usageCacheMs - 1;
  await usage.agent("a1");
  await usage.chat("c1");
  await usage.chat("c1");
  assert.equal(calls.length, 4);
  state.now += 1;
  await usage.agent("a1");
  assert.equal(calls.length, 7);
});

test("a run that ended in a chat drops the chat's and its agent's figures only", async () => {
  const { usage, calls } = fixture();
  await usage.agent("a1");
  await usage.chat("c1");
  assert.equal(calls.length, 4);
  assert.equal(usage.changed({ id: "other", assistantId: "a2" }), false);
  await usage.agent("a1");
  await usage.chat("c1");
  assert.equal(calls.length, 4);
  assert.equal(usage.changed(chats.c1), true);
  await usage.agent("a1");
  await usage.chat("c1");
  assert.equal(calls.length, 8);
});

test("figures the runtime still computes are kept only briefly", async () => {
  const { usage, calls, state } = fixture({ pending: true });
  assert.equal((await usage.chat("c1")).pending, true);
  assert.equal((await usage.agent("a1")).pending, true);
  state.now += usagePendingMs - 1;
  await usage.chat("c1");
  assert.equal(calls.length, 4);
  state.now += 1;
  state.pending = false;
  assert.equal((await usage.chat("c1")).pending, false);
  assert.equal(calls.length, 5);
});

test("an unknown price stays null; a chat names its context", async () => {
  const { usage } = fixture({ cost: null });
  const chat = await usage.chat("c1");
  assert.equal(chat.cost, null);
  assert.deepEqual(chat.tokens, tokens(1500));
  assert.deepEqual(chat.context, { used: 1200, limit: 32768 });
  for (const period of (await usage.agent("a1")).periods) assert.equal(period.cost, null);
});

test("a user's chat, a chat without a session and a runtime without figures have none", async () => {
  const { usage, calls, assistants } = fixture();
  for (const read of [
    () => usage.chat("hers"),
    () => usage.chat("fresh"),
    () => usage.chat("missing"),
    () => usage.agent("h1"),
    () => usage.agent("missing"),
  ])
    await assert.rejects(read(), { status: 404 });
  assert.deepEqual(calls, []);
  assert.equal(usageOf(assistants), usage);
  assert.throws(() => usageOf({}), { status: 404 });
});

test("a failed read says only that usage is unavailable, and is not kept", async () => {
  const { usage, calls, state } = fixture();
  state.fail = true;
  await assert.rejects(usage.agent("a1"), (error) => {
    assert.equal(error.status, 503);
    assert.doesNotMatch(error.message, /secret/);
    return true;
  });
  state.fail = false;
  assert.equal((await usage.agent("a1")).periods.length, 3);
  assert.equal(calls.length, 6);
  // While the runtime takes no calls nothing is asked, kept figures or not.
  state.ready = false;
  await assert.rejects(usage.agent("a1"), { status: 503 });
  assert.equal(calls.length, 6);
});

test("the topics are the owner's, read the routes' values and sample only pending ones", async () => {
  const { assistants, state } = fixture({ pending: true });
  const privacy = { agentContent: (agent) => agent.id !== "a1" || state.optIn !== false };
  const services = { assistants, ownerPrivacy: privacy };
  const [agent, chat] = agentUsageTopics(services);
  assert.deepEqual([agent.name, chat.name], ["agent.usage", "agent.chat-usage"]);
  for (const topic of [agent, chat]) {
    assert.equal(topic.sampleMs, USAGE_PENDING_SAMPLE_MS);
    assert.equal(topic.authorize({ role: "user" }, "a1"), false);
    assert.equal(topic.authorize(null, "a1"), false);
  }
  assert.equal(agent.authorize({ role: "owner" }, "a1"), true);
  const stop = chat.watch({ param: "c1", invalidate() {} });
  assert.equal(await chat.sampling("c1"), false);
  assert.equal((await chat.read({ role: "owner" }, "c1")).pending, true);
  assert.equal(await chat.sampling("c1"), true);
  state.pending = false;
  state.now += usagePendingMs;
  assert.equal((await chat.read({ role: "owner" }, "c1")).pending, false);
  assert.equal(await chat.sampling("c1"), false);
  stop();
  // A user's chat is refused like an unknown one, marked expected for the hub.
  await assert.rejects(chat.read({ role: "owner" }, "hers"), {
    status: 404,
    expected: true,
  });
  // The agent topic is content: a user's own agent only under her opt-in.
  state.optIn = false;
  assert.equal(agent.authorize({ role: "owner" }, "a1"), false);
  await assert.rejects(agent.read({ role: "owner" }, "a1"), { status: 404 });
  // Without agent services the topics refuse like the routes.
  await assert.rejects(
    agentUsageTopics({ assistantFeature: { enabled: false } })[0].read({}, "a1"),
    { status: 404 },
  );
});

test("a run's end signals both topics and drops the kept figures", async () => {
  const { usage, calls } = fixture();
  await usage.chat("c1");
  const signals = [];
  const hub = { invalidate: (name, id) => signals.push(`${name}:${id}`) };
  agentUsageChanged(hub, usage, chats.c1);
  assert.deepEqual(signals, ["agent.usage:a1", "agent.chat-usage:c1"]);
  await usage.chat("c1");
  assert.equal(calls.length, 2);
  // A failing hub never reaches the run's own handling.
  agentUsageChanged(
    {
      invalidate() {
        throw new Error("closed");
      },
    },
    usage,
    chats.c1,
  );
});

test("the chat path reports usage once per ended run of a chat", () => {
  const ended = [];
  const service = {
    store: {
      conversationOfSession: (key) => (key === "known" ? { ...chats.c1 } : null),
      updateConversation() {},
    },
    ledger: { attemptForRun: () => null },
    generatedImages: { observeRun() {}, observe: async () => {} },
    runSteps: { observe: () => null, end() {} },
    chatStreams: { delta: () => undefined, end() {} },
    feeds: { endRun() {}, stream() {}, steps() {} },
    reconcile: async () => {},
    onUsageChange: (conversation) => ended.push(conversation.id),
  };
  const listen = chatEventListener(service);
  const event = (kind, sessionKey = "known") => ({ kind, sessionKey, runId: "r1" });
  listen(event("started"));
  listen(event("text"));
  listen(event("finished", "a-routine-session"));
  assert.deepEqual(ended, []);
  listen(event("finished"));
  listen(event("aborted"));
  listen(event("failed"));
  assert.deepEqual(ended, ["c1", "c1", "c1"]);
});
