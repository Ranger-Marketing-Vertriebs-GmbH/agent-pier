import test from "node:test";
import assert from "node:assert/strict";
import { applicationFixture, enabledAssistants } from "../helpers/application.js";
import { fixtureModel, ownUserAgent } from "../helpers/user-agents.js";

// Per-agent runtime options through the routes (ADR 0007, step 7a): the owner writes
// them with the agent's PATCH, each runtime refuses what it does not take with a
// translated, stable message, and users never change them.
const json = (response) => response.json();
const patch = (f, agent, body) =>
  f.request(`/api/assistants/${agent.id}`, {
    method: "PATCH",
    body: { revision: agent.revision, ...body },
  });
const refused = async (response, status, key) => {
  assert.equal(response.status, status, key);
  assert.equal((await json(response)).messageKey, `runtimeOptions.${key}`);
};

test("the owner sets and clears a Hermes agent's advisors", async (t) => {
  const f = await applicationFixture(t, enabledAssistants);
  const model = fixtureModel(f);
  const store = f.application.assistants.store;
  const heron = store.createAssistant({
    name: "Heron",
    instructions: "",
    model,
    runtime: "hermes",
  });
  const advisors = [{ connectionId: model.connectionId, modelId: "openai/gpt-x" }];
  const saved = await patch(f, heron, {
    runtimeOptions: { hermes: { mixture: { advisors } } },
  });
  assert.equal(saved.status, 200, await saved.clone().text());
  const record = await json(saved);
  assert.deepEqual(record.runtimeOptions, { hermes: { mixture: { advisors } } });
  assert.deepEqual(store.storedAssistant(heron.id).runtimeOptions, {
    hermes: { mixture: { advisors } },
  });

  await refused(
    await patch(f, record, {
      runtimeOptions: { hermes: { mixture: { advisors: [...advisors, ...advisors] } } },
    }),
    400,
    "mixtureAdvisorTwice",
  );
  await refused(
    await patch(f, record, { runtimeOptions: { hermes: { delegation: true } } }),
    400,
    "optionsUnknownKey",
  );
  await refused(
    await patch(f, record, { runtimeOptions: { mystery: {} } }),
    400,
    "optionsUnknownRuntime",
  );
  await refused(
    await patch(f, record, {
      runtimeOptions: {
        hermes: { mixture: { advisors: [{ connectionId: "gone", modelId: "a/b" }] } },
      },
    }),
    409,
    "mixtureAdvisorUnavailable",
  );

  const off = await patch(f, record, {
    runtimeOptions: { hermes: { mixture: { advisors: [] } } },
  });
  assert.equal(off.status, 200, await off.clone().text());
  assert.equal("runtimeOptions" in store.storedAssistant(heron.id), false);
});

test("an OpenClaw agent takes no Hermes options and users never set any", async (t) => {
  const f = await applicationFixture(t, enabledAssistants);
  const created = await json(
    await f.request("/api/assistants", {
      method: "POST",
      body: { name: "Home", instructions: "", model: fixtureModel(f), shell: "off" },
    }),
  );
  await refused(
    await patch(f, created, {
      runtimeOptions: { hermes: { mixture: { advisors: [] } } },
    }),
    400,
    "optionsOtherRuntime",
  );
  await refused(
    await f.request("/api/assistants", {
      method: "POST",
      body: {
        name: "Copy",
        instructions: "",
        model: fixtureModel(f),
        shell: "off",
        runtimeOptions: { hermes: {} },
      },
    }),
    400,
    "optionsOtherRuntime",
  );

  const { agent, cookie } = await ownUserAgent(f, { level: "extended" });
  const own = await f.request(`/api/me/agents/${agent.id}/settings`, {
    method: "PATCH",
    headers: { cookie },
    body: { revision: agent.revision, values: { runtimeOptions: {} } },
  });
  assert.ok([400, 404].includes(own.status), `${own.status}`);
  assert.equal(
    "runtimeOptions" in f.application.assistants.store.storedAssistant(agent.id),
    false,
  );
});

test("the owner sets an OpenClaw agent's thinking, fast mode and loop protection", async (t) => {
  const f = await applicationFixture(t, enabledAssistants);
  const store = f.application.assistants.store;
  const created = await json(
    await f.request("/api/assistants", {
      method: "POST",
      body: { name: "Home", instructions: "", model: fixtureModel(f), shell: "off" },
    }),
  );
  const saved = await patch(f, created, {
    runtimeOptions: { openclaw: { thinking: "high", fastMode: false } },
  });
  assert.equal(saved.status, 200, await saved.clone().text());
  let record = await json(saved);
  assert.deepEqual(record.runtimeOptions, {
    openclaw: { thinking: "high", fastMode: false },
  });
  assert.deepEqual(store.storedAssistant(created.id).runtimeOptions, {
    openclaw: { thinking: "high", fastMode: false },
  });
  await refused(
    await patch(f, record, { runtimeOptions: { openclaw: { thinking: "extreme" } } }),
    400,
    "optionsInvalid",
  );
  await refused(
    await patch(f, record, { runtimeOptions: { openclaw: { fastMode: "auto" } } }),
    400,
    "optionsInvalid",
  );
  // A temporary member works with its lead's and stores none of its own.
  const member = store.reserveMember({
    id: "m1",
    parent: created.id,
    assignment: { name: "Helper" },
    snapshot: store.getAssistant(created.id),
    teamId: "t1",
    lifetime: "temporary",
  });
  await refused(
    await patch(f, member, { runtimeOptions: { openclaw: { thinking: "low" } } }),
    409,
    "modelOptionsTaskMember",
  );
  // Loop protection is a choice in both directions; off is stored, not dropped.
  const loop = await patch(f, record, {
    runtimeOptions: { openclaw: { thinking: "high", loopDetection: false } },
  });
  assert.equal(loop.status, 200, await loop.clone().text());
  record = await json(loop);
  assert.deepEqual(store.storedAssistant(created.id).runtimeOptions, {
    openclaw: { thinking: "high", loopDetection: false },
  });
  await refused(
    await patch(f, record, { runtimeOptions: { openclaw: { loopDetection: "auto" } } }),
    400,
    "optionsInvalid",
  );
  // "Default" for all of them stores no options at all.
  const cleared = await patch(f, record, { runtimeOptions: {} });
  assert.equal(cleared.status, 200, await cleared.clone().text());
  assert.equal("runtimeOptions" in store.storedAssistant(created.id), false);
});

test("the owner sets an OpenClaw agent's fallback models, in order", async (t) => {
  const f = await applicationFixture(t, enabledAssistants);
  const store = f.application.assistants.store;
  const model = fixtureModel(f);
  const created = await json(
    await f.request("/api/assistants", {
      method: "POST",
      body: { name: "Home", instructions: "", model, shell: "off" },
    }),
  );
  // Other models of the same OpenRouter connection, as two fallbacks.
  const fallbacks = [
    { connectionId: model.connectionId, modelId: "vendor/first" },
    { connectionId: model.connectionId, modelId: "vendor/second" },
  ];
  const saved = await patch(f, created, {
    runtimeOptions: { openclaw: { thinking: "low", fallbacks } },
  });
  assert.equal(saved.status, 200, await saved.clone().text());
  let record = await json(saved);
  assert.deepEqual(record.runtimeOptions, { openclaw: { thinking: "low", fallbacks } });
  assert.deepEqual(store.storedAssistant(created.id).runtimeOptions, {
    openclaw: { thinking: "low", fallbacks },
  });
  const options = (value) => ({ runtimeOptions: { openclaw: value } });
  await refused(
    await patch(
      f,
      record,
      options({
        fallbacks: [...fallbacks, { ...fallbacks[0], modelId: "vendor/third" }],
      }),
    ),
    400,
    "fallbackTooMany",
  );
  await refused(
    await patch(f, record, options({ fallbacks: [fallbacks[0], fallbacks[0]] })),
    400,
    "fallbackTwice",
  );
  await refused(
    await patch(f, record, options({ fallbacks: [model] })),
    400,
    "fallbackOwnModel",
  );
  await refused(
    await patch(
      f,
      record,
      options({ fallbacks: [{ connectionId: "openclaw:none", modelId: "gpt-x" }] }),
    ),
    409,
    "fallbackUnavailable",
  );
  await refused(
    await patch(f, record, options({ fallbacks: "vendor/first" })),
    400,
    "optionsInvalid",
  );
  // A temporary member works with its lead's and stores none of its own.
  const member = store.reserveMember({
    id: "m1",
    parent: created.id,
    assignment: { name: "Helper" },
    snapshot: store.getAssistant(created.id),
    teamId: "t1",
    lifetime: "temporary",
  });
  await refused(
    await patch(f, member, options({ fallbacks: [fallbacks[0]] })),
    409,
    "modelOptionsTaskMember",
  );
  // Reordering is a new list; none removes the key and leaves the other options.
  const reordered = await patch(
    f,
    record,
    options({ thinking: "low", fallbacks: [fallbacks[1], fallbacks[0]] }),
  );
  assert.equal(reordered.status, 200, await reordered.clone().text());
  record = await json(reordered);
  assert.deepEqual(store.storedAssistant(created.id).runtimeOptions.openclaw.fallbacks, [
    fallbacks[1],
    fallbacks[0],
  ]);
  const cleared = await patch(f, record, options({ thinking: "low", fallbacks: [] }));
  assert.equal(cleared.status, 200, await cleared.clone().text());
  assert.deepEqual(store.storedAssistant(created.id).runtimeOptions, {
    openclaw: { thinking: "low" },
  });
});
