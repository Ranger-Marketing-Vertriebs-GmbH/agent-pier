import test from "node:test";
import assert from "node:assert/strict";
import {
  memberOptionsOf,
  optionConnections,
  runtimeOptionsOf,
  validateRuntimeOptions,
} from "../../server/features/assistants/runtimes/runtime-options.js";
import {
  fallbackProblem,
  maxFallbacks,
} from "../../server/features/assistants/runtimes/openclaw/openclaw-options.js";
import { desiredAgent } from "../../server/features/assistants/agent-desired-state.js";
import {
  agentEntry,
  fallbackRefs,
} from "../../server/features/assistants/runtimes/openclaw/openclaw-config/agent-entry.js";
import {
  agentDrift,
  agentPatch,
  providerPatch,
} from "../../server/features/assistants/runtimes/openclaw/openclaw-config/agent-apply.js";
import { resolveOptionConnections } from "../../server/features/assistants/option-connections.js";
import {
  openClawRunEvent,
  openClawStep,
} from "../../server/features/assistants/runtimes/openclaw/openclaw-events.js";
import { openClawEntry } from "../../server/features/assistants/runtimes/openclaw/openclaw-sessions.js";
import { publicMessages } from "../../server/features/assistants/conversations.js";
import { RunSteps } from "../../server/features/assistants/run-steps.js";
import * as web from "../../web/features/assistants/runtimes/openclaw/fallback-rules.js";

// An OpenClaw agent's fallback models (`runtimeOptions.openclaw.fallbacks`): up to
// two, in order, of OpenRouter or endpoint connections; compiled into the agent's
// entry as OpenClaw's `model.fallbacks`, each with its provider prepared.

const agent = (id, extra = {}) => ({
  id,
  name: `Agent ${id}`,
  runtimeAgentId: `ap-${id}`,
  revision: 1,
  model: { connectionId: "own", modelId: "own-model" },
  capabilities: { memory: true },
  ...extra,
});
const member = (id, extra = {}) =>
  agent(id, {
    teamMemberId: `tm-${id}`,
    lifetime: "task",
    parentAssistantId: "lead",
    inherited: { capabilities: {}, skills: [], shell: "off", ssh: false },
    ...extra,
  });
const router = { connectionId: "router", modelId: "vendor/small" };
const local = { connectionId: "local", modelId: "llama" };
// The model list as AssistantModels.listCapabilities serves it.
const listed = [
  { id: "own", providerId: "openrouter", available: true },
  { id: "router", providerId: "openrouter", available: true },
  {
    id: "local",
    providerId: "endpoint",
    available: true,
    models: [{ modelId: "llama" }],
  },
  { id: "keyless", providerId: "openrouter", available: false },
  { id: "openclaw:abc", providerId: "openai-chatgpt", available: true, models: [] },
];
const models = { listCapabilities: () => listed };
const write = (record, fallbacks) =>
  validateRuntimeOptions(record, { openclaw: { fallbacks } }, { models });
const refused = (fn, key, status) =>
  assert.throws(fn, (error) => error.key === key && error.status === status, key);
const withFallbacks = (id, fallbacks, extra = {}) =>
  agent(id, { runtimeOptions: { openclaw: { fallbacks } }, ...extra });
// A live apply's resolved connections (option-connections.js).
const resolved = (selection, ref, provider = { baseUrl: `http://${ref}` }) => ({
  ...selection,
  ref,
  providerId: ref.split("/")[0],
  provider,
});
const live = (record, connections, model = { ref: "ap-own-1/own-model" }) =>
  desiredAgent(record, { model, optionConnections: connections });

test("up to two fallbacks are stored in order; none stores nothing", () => {
  assert.equal(maxFallbacks, 2);
  assert.deepEqual(write(agent("a"), [router, local]), {
    openclaw: { fallbacks: [router, local] },
  });
  assert.deepEqual(write(agent("a"), [local]), { openclaw: { fallbacks: [local] } });
  assert.deepEqual(write(agent("a"), []), {});
  // The other model options stay beside them.
  assert.deepEqual(
    validateRuntimeOptions(
      agent("a"),
      { openclaw: { thinking: "high", fallbacks: [router] } },
      { models },
    ),
    { openclaw: { thinking: "high", fallbacks: [router] } },
  );
});

test("a fallback that cannot be one is refused in the owner's words", () => {
  const third = { connectionId: "router", modelId: "vendor/other" };
  refused(() => write(agent("a"), [router, local, third]), "fallbackTooMany", 400);
  refused(() => write(agent("a"), [router, { ...router }]), "fallbackTwice", 400);
  // The agent's own model, also the one the same write changes it to.
  refused(
    () => write(agent("a"), [{ connectionId: "own", modelId: "own-model" }]),
    "fallbackOwnModel",
    400,
  );
  refused(() => write(agent("a", { model: router }), [router]), "fallbackOwnModel", 400);
  // A ChatGPT login: OpenClaw would choose the account of a fallback itself.
  refused(
    () => write(agent("a"), [{ connectionId: "openclaw:abc", modelId: "gpt-x" }]),
    "fallbackKind",
    400,
  );
  for (const gone of [
    { connectionId: "missing", modelId: "m" },
    { connectionId: "keyless", modelId: "m" },
    { connectionId: "local", modelId: "not-listed" },
  ])
    refused(() => write(agent("a"), [gone]), "fallbackUnavailable", 409);
  for (const malformed of [
    "router",
    [{ connectionId: "router" }],
    [{ ...router, extra: 1 }],
    [{ connectionId: "", modelId: "m" }],
    [{ connectionId: "router", modelId: "bad id" }],
  ])
    refused(() => write(agent("a"), malformed), "optionsInvalid", 400);
});

test("a stored fallback whose connection went away stays, a new one is refused", () => {
  const gone = { connectionId: "keyless", modelId: "m" };
  const record = withFallbacks("a", [gone]);
  assert.deepEqual(write(record, [gone, router]), {
    openclaw: { fallbacks: [gone, router] },
  });
  refused(() => write(agent("a"), [gone]), "fallbackUnavailable", 409);
});

test("stored fallbacks are read tolerantly", () => {
  const read = (fallbacks) => runtimeOptionsOf(withFallbacks("a", fallbacks));
  assert.deepEqual(read([router, local]), { fallbacks: [router, local] });
  // Malformed and repeated ones are left out, at most two kept.
  assert.deepEqual(
    read([
      router,
      "x",
      { connectionId: 1 },
      { ...router },
      local,
      { ...local, modelId: "b" },
    ]),
    { fallbacks: [router, local] },
  );
  assert.deepEqual(read("nonsense"), {});
  assert.deepEqual(read([]), {});
  assert.deepEqual(optionConnections(withFallbacks("a", [router, local])), [
    router,
    local,
  ]);
  assert.deepEqual(optionConnections(agent("a")), []);
});

test("a temporary member holds none of its own and takes over its lead's", () => {
  const lead = withFallbacks("lead", [router, local]);
  refused(() => write(member("m"), [router]), "modelOptionsTaskMember", 409);
  // A stored leftover is not read; the lead's are what it runs with.
  const leftover = member("m", { runtimeOptions: { openclaw: { fallbacks: [local] } } });
  assert.deepEqual(runtimeOptionsOf(leftover), {});
  assert.deepEqual(memberOptionsOf(leftover, lead), { fallbacks: [router, local] });
  assert.deepEqual(optionConnections(leftover, lead), [router, local]);
  assert.deepEqual(optionConnections(leftover), []);
  assert.deepEqual(desiredAgent(leftover, { lead }).runtimeOptions.fallbacks, [
    router,
    local,
  ]);
  // A permanent member keeps its own and takes nothing over.
  const permanent = agent("p", { teamMemberId: "tm-p", lifetime: "permanent" });
  assert.deepEqual(write(permanent, [router]), { openclaw: { fallbacks: [router] } });
  assert.deepEqual(desiredAgent(permanent, { lead }).runtimeOptions, {});
});

test("the server's and the web app's rule agree on every connection", () => {
  for (const connection of [...listed, undefined])
    for (const modelId of ["llama", "other"]) {
      const server = fallbackProblem(connection, modelId);
      const browser = web.fallbackProblem(connection, modelId);
      // The web app tells a connection that is gone from the list apart.
      assert.equal(browser === "missing" ? "unavailable" : browser, server);
    }
  assert.equal(web.maxFallbacks, maxFallbacks);
});

test("an apply resolves each fallback like a model and never fails on one", async () => {
  const leases = [];
  const fake = {
    async resolve({ connectionId, modelId }) {
      if (connectionId === "keyless")
        throw Object.assign(new Error("no key"), { key: "provider" });
      const lease = { released: false };
      leases.push(lease);
      return {
        modelRef: `ap-${connectionId}-1/${modelId}`,
        providerId: `ap-${connectionId}-1`,
        provider: { baseUrl: `http://${connectionId}` },
        display: { connection: connectionId, model: modelId },
        release: () => (lease.released = true),
      };
    },
  };
  const gone = { connectionId: "keyless", modelId: "m" };
  const record = withFallbacks("a", [gone, router]);
  const connections = await resolveOptionConnections(fake, record);
  assert.deepEqual(connections, [
    { ...gone, unavailable: "provider" },
    {
      ...router,
      ref: "ap-router-1/vendor/small",
      providerId: "ap-router-1",
      provider: { baseUrl: "http://router" },
      display: { connection: "router", model: "vendor/small" },
    },
  ]);
  assert.ok(leases.every((lease) => lease.released));
  // A temporary member's are its lead's.
  const follower = member("m");
  assert.deepEqual(await resolveOptionConnections(fake, follower), []);
  assert.equal((await resolveOptionConnections(fake, follower, record)).length, 2);
});

test("the entry holds the fallbacks that resolved, in order, without the own model", () => {
  const record = withFallbacks("a", [router, local]);
  const both = [
    resolved(router, "ap-router-1/vendor/small"),
    resolved(local, "ap-local-1/llama"),
  ];
  assert.deepEqual(fallbackRefs(live(record, both)), [
    "ap-router-1/vendor/small",
    "ap-local-1/llama",
  ]);
  // One that could not be resolved is left out; the other still serves.
  assert.deepEqual(
    fallbackRefs(live(record, [{ ...router, unavailable: "provider" }, both[1]])),
    ["ap-local-1/llama"],
  );
  // The agent's own model is never its own fallback, and none is named twice.
  assert.deepEqual(
    fallbackRefs(live(record, both, { ref: "ap-router-1/vendor/small" })),
    ["ap-local-1/llama"],
  );
  assert.deepEqual(
    fallbackRefs(live(record, [both[0], resolved(local, "ap-router-1/vendor/small")])),
    ["ap-router-1/vendor/small"],
  );
  assert.deepEqual(fallbackRefs(live(record, [])), []);
  assert.deepEqual(fallbackRefs(live(agent("a"), both)), []);
  const state = { teamsReady: true, nativeReady: true };
  assert.deepEqual(agentEntry({}, live(record, both), state).model, {
    primary: "ap-own-1/own-model",
    fallbacks: ["ap-router-1/vendor/small", "ap-local-1/llama"],
  });
  // Without fallbacks the list is empty: OpenClaw's strict "no fallback".
  assert.deepEqual(agentEntry({}, live(agent("a"), []), state).model, {
    primary: "ap-own-1/own-model",
    fallbacks: [],
  });
  // A Gateway start knows no model connection and leaves the model to the provider
  // preparation (assistant-provider-synchronization.js).
  const kept = { primary: "kept", fallbacks: ["kept-too"] };
  assert.deepEqual(agentEntry({ model: kept }, record, state).model, kept);
});

test("an apply writes every provider a fallback needs before the entry", () => {
  const record = withFallbacks("a", [router, local]);
  const connections = [
    resolved(router, "ap-router-1/vendor/small", {
      baseUrl: "http://router",
      apiKey: "k",
    }),
    { ...local, unavailable: "provider" },
  ];
  const own = { ref: "ap-own-1/own-model", providerId: "ap-own-1", provider: { a: 1 } };
  const desired = live(record, connections, own);
  assert.deepEqual(providerPatch(desired, {}), {
    patch: {
      models: {
        providers: {
          "ap-own-1": { a: 1 },
          "ap-router-1": { baseUrl: "http://router", apiKey: "k" },
        },
      },
    },
  });
  // Only what the configuration does not hold yet; nothing is no write at all.
  const written = { models: { providers: { "ap-own-1": { a: 1 } } } };
  assert.deepEqual(Object.keys(providerPatch(desired, written).patch.models.providers), [
    "ap-router-1",
  ]);
  written.models.providers["ap-router-1"] = { baseUrl: "http://router", apiKey: "k" };
  assert.equal(providerPatch(desired, written), null);
  // A ChatGPT login has no provider entry; its fallback's still is written.
  const chatgpt = live(record, connections, { ref: "openai/gpt-x@p" });
  assert.deepEqual(Object.keys(providerPatch(chatgpt, {}).patch.models.providers), [
    "ap-router-1",
  ]);
  assert.equal(providerPatch(live(agent("a"), [], { ref: "openai/gpt-x@p" }), {}), null);
});

test("a live apply replaces the fallback list and notices one that did not take", () => {
  const record = withFallbacks("a", [router]);
  const desired = live(record, [resolved(router, "ap-router-1/vendor/small")]);
  const state = () => ({ teamsReady: true, nativeReady: true, managed: true });
  const config = (model) => ({
    tools: { allow: [] },
    agents: { entries: { "ap-a": { model } } },
  });
  const first = agentPatch(config("ap-own-1/own-model"), desired, state);
  assert.deepEqual(first.patch.agents.entries["ap-a"].model, {
    primary: "ap-own-1/own-model",
    fallbacks: ["ap-router-1/vendor/small"],
  });
  // A string model has no list to replace; an existing list is named, so a shorter
  // or reordered one drops the old items.
  const path = "agents.entries.ap-a.model.fallbacks";
  assert.equal(first.replacePaths.includes(path), false);
  const before = { primary: "ap-own-1/own-model", fallbacks: ["old-1", "old-2"] };
  assert.ok(agentPatch(config(before), desired, state).replacePaths.includes(path));
  const removed = agentPatch(config(before), live(agent("a"), []), state);
  assert.deepEqual(removed.patch.agents.entries["ap-a"].model.fallbacks, []);
  assert.ok(removed.replacePaths.includes(path));

  const entry = agentEntry({}, desired, { teamsReady: true, nativeReady: true });
  const expected = {
    managed: true,
    tools: entry.tools.allow,
    skills: [],
    shellGlobal: undefined,
    memory: undefined,
  };
  const running = (model) => ({ agents: { entries: { "ap-a": { ...entry, model } } } });
  assert.equal(agentDrift(running(entry.model), desired, expected), false);
  assert.equal(agentDrift(running(before), desired, expected), true);
  assert.equal(agentDrift(running("ap-own-1/own-model"), desired, expected), true);
  // An agent without fallbacks matches a string model and an empty list alike.
  const plain = live(agent("a"), []);
  const plainEntry = agentEntry({}, plain, { teamsReady: true, nativeReady: true });
  const plainRunning = (model) => ({
    agents: { entries: { "ap-a": { ...plainEntry, model } } },
  });
  const plainExpected = { ...expected, tools: plainEntry.tools.allow };
  assert.equal(
    agentDrift(plainRunning("ap-own-1/own-model"), plain, plainExpected),
    false,
  );
  assert.equal(agentDrift(plainRunning(before), plain, plainExpected), true);
});

test("a run that moves on to a fallback model shows one step with the model id", () => {
  const frame = (to, outcome = "next_fallback") => ({
    event: "agent",
    payload: {
      runId: "r1",
      sessionKey: "s1",
      stream: "lifecycle",
      data: {
        phase: "fallback_step",
        fallbackStepFromModel: "ap-own-1/own-model",
        fallbackStepToModel: to,
        fallbackStepFinalOutcome: outcome,
      },
    },
  });
  // The provider id (AgentPier's are opaque) and an account pin never leave.
  assert.deepEqual(openClawStep(frame("ap-router-1/vendor/small").payload), {
    type: "fallback",
    model: "vendor/small",
    failed: false,
  });
  assert.equal(openClawStep(frame("openai/gpt-x@profile").payload).model, "gpt-x");
  assert.equal(openClawStep(frame(undefined).payload).model, "");
  assert.equal(openClawStep(frame("x/y", "chain_exhausted").payload).failed, true);
  const steps = new RunSteps();
  const observe = (value) => steps.observe(openClawRunEvent(value));
  assert.equal(observe(frame("ap-gone-1/none")).changed, true);
  observe(frame("ap-router-1/vendor/small"));
  observe(frame("ap-router-1/vendor/small", "succeeded"));
  assert.deepEqual(steps.view("r1").steps, [
    { id: "fallback", kind: "fallback", label: "vendor/small", state: "done" },
  ]);
  observe(frame("ap-router-1/vendor/small", "chain_exhausted"));
  assert.equal(steps.view("r1").steps[0].state, "failed");
});

test("OpenClaw's own fallback lines are neither a reply nor a chat message", () => {
  const notice = {
    event: "chat",
    payload: {
      runId: "r1",
      sessionKey: "s1",
      state: "final",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "↪️ Model Fallback: ap-router-1/vendor/small (selected ap-own-1/own-model; auth)",
            openclawStatusNotice: true,
            openclawFallback: true,
          },
        ],
      },
    },
  };
  const event = openClawRunEvent(notice);
  assert.equal(event.kind, "progress");
  assert.equal(event.reply, null);
  // The run's real end still is one.
  const final = structuredClone(notice);
  final.payload.message.content = [{ type: "text", text: "Done." }];
  assert.equal(openClawRunEvent(final).kind, "finished");
  assert.equal(openClawRunEvent(final).reply.text, "Done.");

  const mirror = {
    role: "assistant",
    content: [
      {
        type: "text",
        text: "Model switched from ap-own-1/own-model to ap-router-1/vendor/small (auth).",
      },
    ],
    provider: "openclaw",
    model: "delivery-mirror",
    openclawDeliveryMirror: { kind: "model-fallback", runId: "r1" },
    __openclaw: { id: "m1", runId: "r1" },
  };
  const reply = {
    role: "assistant",
    content: [{ type: "text", text: "Done." }],
    __openclaw: { id: "m2", runId: "r1" },
  };
  // Another mirrored message (a delivered reply) stays a message.
  const delivered = {
    ...mirror,
    content: [{ type: "text", text: "Sent." }],
    openclawDeliveryMirror: { kind: "delivery" },
    __openclaw: { id: "m3", runId: "r1" },
  };
  assert.equal(openClawEntry(mirror).status, true);
  assert.equal(openClawEntry(reply).status, false);
  assert.equal(openClawEntry(delivered).status, false);
  const entries = [mirror, reply, delivered].map((m) => ({
    ...m,
    entry: openClawEntry(m),
  }));
  assert.deepEqual(
    publicMessages(entries).map((m) => m.text),
    ["Done.", "Sent."],
  );
});

test("the fallback rows of the web app: choices, drafts and what blocks a save", () => {
  assert.deepEqual(web.fallbacksOf({ thinking: "high" }), []);
  assert.deepEqual(web.fallbacksOf({ fallbacks: [router] }), [router]);
  // The other options stay; none stores nothing.
  assert.deepEqual(web.withFallbacks({ thinking: "high" }, [router]), {
    thinking: "high",
    fallbacks: [router],
  });
  assert.deepEqual(web.withFallbacks({ thinking: "high", fallbacks: [router] }, []), {
    thinking: "high",
  });
  assert.equal(web.fallbacksProblem({}), null);
  assert.equal(web.fallbacksProblem({ fallbacks: [router, local] }), null);
  assert.equal(
    web.fallbacksProblem({ fallbacks: [router, { connectionId: "", modelId: "" }] }),
    "incomplete",
  );
  assert.equal(
    web.fallbacksProblem({ fallbacks: [{ connectionId: "router", modelId: "" }] }),
    "incomplete",
  );
  assert.equal(web.fallbacksProblem({ fallbacks: [router, { ...router }] }), "twice");
  assert.equal(typeof web.fallbackSaveProblem({ fallbacks: [{}] }), "string");
  assert.equal(web.fallbackSaveProblem({ fallbacks: [router] }), null);
  assert.equal(web.fallbackSaveProblem({ memoryWiki: true }), null);
  assert.equal(web.isOwnModel(router, router), true);
  assert.equal(web.isOwnModel(router, local), false);
  assert.equal(web.isOwnModel({ connectionId: "", modelId: "" }, {}), false);
  const label = (connection) => connection.id;
  const reason = (problem) => problem;
  // A ChatGPT login is not offered; a connection without its key is, disabled.
  assert.deepEqual(web.connectionChoices(listed, "", label, reason), [
    { value: "own", label: "own", disabled: false },
    { value: "router", label: "router", disabled: false },
    { value: "local", label: "local", disabled: false },
    { value: "keyless", label: "keyless · unavailable", disabled: true },
  ]);
  // A stored connection that is gone, or of another kind now, stays visible.
  assert.deepEqual(web.connectionChoices(listed, "deleted", label, reason).at(-1), {
    value: "deleted",
    label: "deleted · missing",
    disabled: true,
  });
  assert.ok(
    web
      .connectionChoices(listed, "openclaw:abc", label, reason)
      .some((choice) => choice.value === "openclaw:abc" && choice.disabled),
  );
  assert.deepEqual(web.listedModels(listed[2]), [{ modelId: "llama" }]);
  assert.equal(web.listedModels(listed[1]), null);
});
