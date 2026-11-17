import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  optionConnections,
  runtimeOptionsOf,
  validateRuntimeOptions,
} from "../../server/features/assistants/runtimes/runtime-options.js";
import { desiredAgent } from "../../server/features/assistants/agent-desired-state.js";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { settingsPatch } from "../../server/features/users/user-agent-settings.js";
import { recompiles } from "../../server/features/assistants/assistant-validation.js";

// Per-agent runtime options (ADR 0007, step 7a): `runtimeOptions: { [runtimeId]:
// object }` in the agent's profile, validated on write by the agent's runtime,
// tolerant on read, handed to the agent's own runtime's compiler only.

// A model list as AssistantModels.listCapabilities answers it.
const connections = [
  {
    id: "c-end",
    name: "Lab endpoint",
    providerId: "endpoint",
    available: true,
    models: [{ modelId: "m-1" }, { modelId: "m-2" }],
  },
  { id: "c-or", name: "OpenRouter", providerId: "openrouter", available: true },
  { id: "c-off", name: "Keyless", providerId: "openrouter", available: false },
  {
    id: "openclaw:gpt",
    name: "ChatGPT",
    providerId: "openai-chatgpt",
    holder: "agentpier",
    available: true,
  },
];
const models = { listCapabilities: () => connections };
const hermes = (extra = {}) => ({
  id: "h1",
  runtime: "hermes",
  model: { connectionId: "c-end", modelId: "m-1" },
  ...extra,
});
const openclaw = (extra = {}) => ({
  id: "o1",
  model: { connectionId: "c-or", modelId: "x/y" },
  ...extra,
});
const mixture = (...advisors) => ({ hermes: { mixture: { advisors } } });
const refusal = (fn, key, status = 400) =>
  assert.throws(fn, (error) => {
    assert.equal(error.key, key, error.message);
    assert.equal(error.status, status);
    return true;
  });

test("a runtime validates its own options and refuses unknown runtimes and keys", () => {
  const context = { models };
  const value = mixture(
    { connectionId: "c-or", modelId: "openai/gpt-x" },
    { connectionId: "c-end", modelId: "m-2" },
  );
  assert.deepEqual(validateRuntimeOptions(hermes(), value, context), value);
  refusal(
    () => validateRuntimeOptions(hermes(), { mystery: {} }, context),
    "optionsUnknownRuntime",
  );
  refusal(
    () => validateRuntimeOptions(openclaw(), mixture(), context),
    "optionsOtherRuntime",
  );
  refusal(
    () => validateRuntimeOptions(hermes(), { hermes: { delegation: true } }, context),
    "optionsUnknownKey",
  );
  refusal(
    () => validateRuntimeOptions(openclaw(), { openclaw: { wiki: true } }, context),
    "optionsUnknownKey",
  );
  for (const bad of [null, [], "x", { hermes: [] }, { hermes: { mixture: [] } }])
    refusal(() => validateRuntimeOptions(hermes(), bad, context), "optionsInvalid");
  // No advisors is Mixture of Agents off: nothing stays stored for the runtime.
  assert.deepEqual(validateRuntimeOptions(hermes(), mixture(), context), {});
  assert.deepEqual(validateRuntimeOptions(hermes(), {}, context), {});
  assert.deepEqual(validateRuntimeOptions(openclaw(), { openclaw: {} }, context), {});
});

test("an advisor is an available endpoint or OpenRouter model, at most three", () => {
  const context = { models };
  const advisor = (connectionId, modelId = "m-1") => ({ connectionId, modelId });
  refusal(
    () => validateRuntimeOptions(hermes(), mixture(advisor("openclaw:gpt")), context),
    "mixtureAdvisorKind",
  );
  refusal(
    () => validateRuntimeOptions(hermes(), mixture(advisor("c-off", "a/b")), context),
    "mixtureAdvisorUnavailable",
    409,
  );
  refusal(
    () => validateRuntimeOptions(hermes(), mixture(advisor("gone")), context),
    "mixtureAdvisorUnavailable",
    409,
  );
  // An endpoint's model must be one the connection lists.
  refusal(
    () => validateRuntimeOptions(hermes(), mixture(advisor("c-end", "m-9")), context),
    "mixtureAdvisorUnavailable",
    409,
  );
  refusal(
    () =>
      validateRuntimeOptions(
        hermes(),
        mixture(advisor("c-end"), advisor("c-end")),
        context,
      ),
    "mixtureAdvisorTwice",
  );
  refusal(
    () =>
      validateRuntimeOptions(
        hermes(),
        mixture(
          advisor("c-end"),
          advisor("c-end", "m-2"),
          advisor("c-or", "a/b"),
          advisor("c-or", "a/c"),
        ),
        context,
      ),
    "mixtureTooMany",
  );
  for (const bad of [
    { connectionId: "c-or" },
    { connectionId: "c-or", modelId: "" },
    { connectionId: "c-or", modelId: "a/b", extra: 1 },
    { connectionId: 3, modelId: "a/b" },
  ])
    refusal(
      () => validateRuntimeOptions(hermes(), mixture(bad), context),
      "optionsInvalid",
    );
  // The agent's own model acts as the aggregator: a ChatGPT login cannot.
  refusal(
    () =>
      validateRuntimeOptions(
        hermes({ model: { connectionId: "openclaw:gpt", modelId: "gpt-x" } }),
        mixture(advisor("c-or", "a/b")),
        context,
      ),
    "mixtureModelKind",
    409,
  );
});

test("an advisor already stored stays when its connection became unavailable", () => {
  const stored = { connectionId: "c-off", modelId: "a/b" };
  const agent = hermes({ runtimeOptions: mixture(stored) });
  const value = mixture(stored, { connectionId: "c-or", modelId: "a/c" });
  assert.deepEqual(validateRuntimeOptions(agent, value, { models }), value);
});

test("reading ignores what a descriptor no longer names, never failing", () => {
  const advisors = [{ connectionId: "c-or", modelId: "a/b" }];
  // Another runtime's options never reach this agent's compiler.
  assert.deepEqual(
    runtimeOptionsOf(openclaw({ runtimeOptions: mixture(...advisors) })),
    {},
  );
  assert.deepEqual(
    runtimeOptionsOf(
      hermes({
        runtimeOptions: {
          mystery: { x: 1 },
          hermes: {
            future: true,
            mixture: {
              advisors: [...advisors, { connectionId: 1 }, "x"],
              later: 2,
            },
          },
        },
      }),
    ),
    { mixture: { advisors } },
  );
  for (const broken of [null, "x", { hermes: "x" }, { hermes: { mixture: 3 } }])
    assert.deepEqual(runtimeOptionsOf(hermes({ runtimeOptions: broken })), {});
  assert.deepEqual(runtimeOptionsOf(hermes()), {});
  assert.ok(
    Object.isFrozen(runtimeOptionsOf(hermes({ runtimeOptions: mixture(...advisors) }))),
  );
  assert.deepEqual(
    optionConnections(hermes({ runtimeOptions: mixture(...advisors) })),
    advisors,
  );
  assert.deepEqual(
    optionConnections(openclaw({ runtimeOptions: mixture(...advisors) })),
    [],
  );
});

test("the desired state carries the agent's options for its own runtime only", () => {
  const advisors = [{ connectionId: "c-or", modelId: "a/b" }];
  const own = desiredAgent({
    ...hermes({ runtimeOptions: mixture(...advisors) }),
    runtimeAgentId: "ap-h1",
  });
  assert.deepEqual(own.runtimeOptions, { mixture: { advisors } });
  assert.ok(Object.isFrozen(own.runtimeOptions.mixture.advisors));
  const other = desiredAgent({
    ...openclaw({ runtimeOptions: mixture(...advisors) }),
    runtimeAgentId: "ap-o1",
  });
  assert.deepEqual(other.runtimeOptions, {});
  // The connections a live apply resolved for them travel beside, as the model does.
  const resolved = [{ connectionId: "c-or", modelId: "a/b", unavailable: "provider" }];
  const applied = desiredAgent(
    { ...hermes({ runtimeOptions: mixture(...advisors) }), runtimeAgentId: "ap-h1" },
    { optionConnections: resolved },
  );
  assert.deepEqual(applied.optionConnections, resolved);
  assert.equal("optionConnections" in own, false);
});

test("the store keeps runtimeOptions, a member starts without, users never write it", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-options-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new AssistantStore({ dataDir: dir });
  const value = mixture({ connectionId: "c-or", modelId: "a/b" });
  const created = store.createAssistant({
    name: "Heron",
    instructions: "",
    model: { connectionId: "c-end", modelId: "m-1" },
    runtime: "hermes",
    runtimeOptions: value,
  });
  assert.deepEqual(store.storedAssistant(created.id).runtimeOptions, value);
  const updated = store.updateAssistant(
    created.id,
    { runtimeOptions: {} },
    created.revision,
  );
  assert.equal("runtimeOptions" in updated, false, "off leaves the record as before");
  assert.equal("runtimeOptions" in store.storedAssistant(created.id), false);
  const again = store.updateAssistant(
    created.id,
    { runtimeOptions: value },
    updated.revision,
  );
  // A task member does not inherit its lead's options.
  const member = store.reserveMember({
    id: "m1",
    parent: created.id,
    assignment: { name: "Member" },
    snapshot: store.getAssistant(created.id),
    teamId: "t1",
    lifetime: "temporary",
  });
  assert.equal("runtimeOptions" in member, false);
  assert.deepEqual(
    store.storedAssistant(created.id).runtimeOptions,
    again.runtimeOptions,
  );
  // A save of the options re-applies the agent's configuration.
  assert.equal(recompiles({ runtimeOptions: {} }), true);
  // Users never change it on their own agent.
  assert.throws(() => settingsPatch(again, "extended", { runtimeOptions: {} }), {
    key: "invalid",
  });
});

test("an apply resolves the connections the options name, never failing", async () => {
  const { resolveOptionConnections } =
    await import("../../server/features/assistants/option-connections.js");
  const released = [];
  const leases = {
    resolve: async ({ connectionId, modelId }) => {
      if (connectionId === "gone")
        throw Object.assign(new Error("x"), { key: "provider" });
      return {
        modelRef: `ap-${connectionId}/${modelId}`,
        providerId: `ap-${connectionId}`,
        provider: { baseUrl: "https://x.test/v1", apiKey: "k" },
        display: { connection: connectionId, model: modelId },
        release: () => released.push(connectionId),
      };
    },
  };
  const agent = hermes({
    runtimeOptions: mixture(
      { connectionId: "c-or", modelId: "a/b" },
      { connectionId: "gone", modelId: "a/c" },
    ),
  });
  const resolved = await resolveOptionConnections(leases, agent);
  assert.deepEqual(resolved[1], {
    connectionId: "gone",
    modelId: "a/c",
    unavailable: "provider",
  });
  assert.equal(resolved[0].providerId, "ap-c-or");
  assert.deepEqual(released, ["c-or"]);
  assert.deepEqual(await resolveOptionConnections(leases, hermes()), []);
});

test("a connection an agent's advisors use counts as used by the agent", async () => {
  const { AssistantProviderSynchronization } =
    await import("../../server/features/assistants/assistant-provider-synchronization.js");
  const agent = hermes({
    runtimeOptions: mixture({ connectionId: "c-or", modelId: "a/b" }),
  });
  const sync = new AssistantProviderSynchronization({
    assistants: { store: { listAssistants: () => [agent] } },
  });
  assert.equal(sync.uses(agent, "c-or"), true);
  assert.equal(sync.affects("c-or"), true);
  assert.equal(sync.affects("c-other"), false);
  assert.deepEqual(sync.usage("c-or").agents, [{ id: "h1", name: undefined }]);
});
