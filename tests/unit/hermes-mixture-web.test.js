import test from "node:test";
import assert from "node:assert/strict";
import {
  advisorProblem,
  advisorsOf,
  aggregatorReady,
  connectionChoices,
  listedModels,
  withAdvisors,
} from "../../web/features/assistants/runtimes/hermes/mixture-rules.js";
import { mixtureProblem } from "../../server/features/assistants/runtimes/hermes/hermes-options.js";
import {
  capabilityPatch,
  capabilityServer,
} from "../../web/features/assistants/settings/agent-settings-fields.js";

// The web half of Hermes's Mixture of Agents group (ADR 0007, step 7a).
const models = [
  {
    id: "c-end",
    name: "Lab",
    providerId: "endpoint",
    available: true,
    models: [{ modelId: "m-1" }],
  },
  { id: "c-or", name: "OpenRouter", providerId: "openrouter", available: true },
  { id: "c-off", name: "Old", providerId: "openrouter", available: false },
  {
    id: "c-az",
    name: "Azure",
    providerId: "endpoint",
    available: true,
    keyHeader: true,
    models: [{ modelId: "dep" }],
  },
  { id: "openclaw:x", name: "ChatGPT", providerId: "openai-chatgpt", available: true },
];

test("the web rule says what the server refuses, connection by connection", () => {
  for (const connection of [undefined, ...models])
    for (const modelId of ["m-1", "a/b", "dep"]) {
      const web = advisorProblem(connection, modelId);
      const server = mixtureProblem(connection, modelId);
      assert.equal(web === "missing" ? "unavailable" : web, server, connection?.id);
    }
  assert.equal(advisorProblem(models[0]), null);
  assert.equal(advisorProblem(models[3]), "keyHeader");
});

test("choices list every connection, those that cannot advise disabled", () => {
  const reason = (problem) => `(${problem})`;
  const choices = connectionChoices(models, "gone", (m) => m.name, reason);
  assert.deepEqual(
    choices.map(({ value, disabled }) => [value, disabled]),
    [
      ["c-end", false],
      ["c-or", false],
      ["c-off", true],
      ["c-az", true],
      ["openclaw:x", true],
      ["gone", true],
    ],
  );
  assert.equal(choices[4].label, "ChatGPT · (kind)");
  assert.deepEqual(listedModels(models[0]), [{ modelId: "m-1" }]);
  assert.equal(listedModels(models[1]), null);
});

test("the agent's own model must be able to act on the advice", () => {
  const agent = (connectionId) => ({ model: { connectionId, modelId: "x" } });
  assert.equal(aggregatorReady(models, agent("c-end")), true);
  assert.equal(aggregatorReady(models, agent("c-off")), true, "unavailable is not kind");
  assert.equal(aggregatorReady(models, agent("openclaw:x")), false);
  assert.equal(aggregatorReady(models, agent("c-az")), false);
  assert.equal(aggregatorReady([], agent("c-end")), true);
});

test("the Capabilities draft holds the agent's runtime options and saves them", () => {
  const advisors = [{ connectionId: "c-or", modelId: "a/b" }];
  const assistant = {
    id: "h1",
    runtime: "hermes",
    runtimeInfo: { id: "hermes" },
    revision: 3,
    runtimeOptions: { hermes: { mixture: { advisors } }, other: { x: 1 } },
  };
  const base = capabilityServer(assistant);
  assert.deepEqual(base.runtimeOptions, { mixture: { advisors } });
  assert.deepEqual(advisorsOf(base.runtimeOptions), advisors);
  assert.deepEqual(capabilityServer({ id: "o1" }).runtimeOptions, {});
  // Unchanged: nothing is sent.
  assert.equal(
    "runtimeOptions" in capabilityPatch({ values: base, base, assistant }),
    false,
  );
  const more = [...advisors, { connectionId: "c-end", modelId: "m-1" }];
  assert.deepEqual(
    capabilityPatch({
      values: { ...base, runtimeOptions: withAdvisors(more) },
      base,
      assistant,
    }).runtimeOptions,
    { hermes: { mixture: { advisors: more } } },
  );
  // None left switches it off.
  assert.deepEqual(
    capabilityPatch({
      values: { ...base, runtimeOptions: withAdvisors([]) },
      base,
      assistant,
    }).runtimeOptions,
    {},
  );
});

test("a half-filled advisor row blocks the save with its own message", async () => {
  const { incompleteAdvisors } =
    await import("../../web/features/assistants/runtimes/hermes/mixture-rules.js");
  assert.equal(incompleteAdvisors({}), false);
  assert.equal(
    incompleteAdvisors(withAdvisors([{ connectionId: "c-or", modelId: "a/b" }])),
    false,
  );
  for (const row of [
    { connectionId: "", modelId: "" },
    { connectionId: "c-or", modelId: "" },
    { connectionId: "", modelId: "a/b" },
  ])
    assert.equal(
      incompleteAdvisors(withAdvisors([{ connectionId: "c-or", modelId: "a/b" }, row])),
      true,
      JSON.stringify(row),
    );
});
