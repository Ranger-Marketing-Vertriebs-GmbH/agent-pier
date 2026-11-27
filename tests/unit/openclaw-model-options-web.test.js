import test from "node:test";
import assert from "node:assert/strict";
import {
  fastChoice,
  fastValue,
  followsLead,
  loopAutomatic,
  loopChecked,
  thinkingChoice,
  thinkingLevels,
  withLoop,
  withOption,
} from "../../web/features/assistants/runtimes/openclaw/model-option-rules.js";
import {
  identityKeys,
  identityPatch,
  identityServer,
} from "../../web/features/assistants/settings/identity-fields.js";
import { identityStep } from "../../web/features/assistants/settings/agent-settings-steps.js";
import { profileKeys } from "../../web/features/assistants/settings/agent-settings-fields.js";
import { openClawSearch as openClawWeb } from "../../web/features/assistants/runtimes/openclaw/search.js";
import { thinkingLevels as serverLevels } from "../../server/features/assistants/runtimes/openclaw/openclaw-options.js";
import { openClawDescriptor } from "../../server/features/assistants/runtimes/openclaw/descriptor.js";
import { hermesDescriptor } from "../../server/features/assistants/runtimes/hermes/descriptor.js";
import * as de from "../../web/lib/i18n/de/assistant-model-options.js";
import * as en from "../../web/lib/i18n/en/assistant-model-options.js";
import * as advancedDe from "../../web/lib/i18n/de/assistant-advanced.js";
import * as advancedEn from "../../web/lib/i18n/en/assistant-advanced.js";

// The web half of an OpenClaw agent's thinking level, fast mode and loop protection:
// the rules of the
// surface below the model on the Identity tab (slot agent.identity) and that tab's
// draft, which holds the agent's runtime options beside its profile.

const agent = (extra = {}) => ({
  id: "a1",
  name: "Owl",
  instructions: "",
  revision: 3,
  runtimeInfo: { id: "openclaw" },
  model: { connectionId: "router", modelId: "a/b" },
  ...extra,
});

test("the web app offers the levels the server accepts, each with a label", () => {
  assert.deepEqual([...thinkingLevels], [...serverLevels]);
  for (const catalog of [advancedDe, advancedEn]) {
    const labels = catalog.assistantAdvancedCopy.settings.thinkingDefault.options;
    for (const level of thinkingLevels) assert.ok(labels[level], level);
  }
});

test("a choice edits one option of the draft and Default stores nothing", () => {
  const wiki = { memoryWiki: true };
  assert.deepEqual(withOption(wiki, "thinking", "high"), {
    memoryWiki: true,
    thinking: "high",
  });
  assert.deepEqual(
    withOption({ ...wiki, thinking: "high" }, "thinking", undefined),
    wiki,
  );
  assert.deepEqual(withOption(undefined, "fastMode", false), { fastMode: false });
  assert.equal(thinkingChoice({ thinking: "max" }), "max");
  assert.equal(thinkingChoice({}), "");
  assert.equal(thinkingChoice({ thinking: "bogus" }), "");
  assert.equal(thinkingChoice(undefined), "");
  assert.equal(fastChoice({ fastMode: true }), "on");
  assert.equal(fastChoice({ fastMode: false }), "off");
  assert.equal(fastChoice({}), "");
  assert.equal(fastValue("on"), true);
  assert.equal(fastValue("off"), false);
  assert.equal(fastValue(""), undefined);
});

test("loop protection follows the model's connection until the owner chooses", () => {
  const endpoint = { id: "local", providerId: "endpoint" };
  const router = { id: "router", providerId: "openrouter" };
  assert.equal(loopAutomatic(endpoint), true);
  assert.equal(loopAutomatic(router), false);
  assert.equal(loopAutomatic({ id: "openclaw:1", providerId: "openai" }), false);
  // A connection that is gone, or not read yet, protects nothing by itself.
  assert.equal(loopAutomatic(undefined), false);
  assert.equal(loopChecked({}, endpoint), true);
  assert.equal(loopChecked(undefined, router), false);
  assert.equal(loopChecked({ loopDetection: false }, endpoint), false);
  assert.equal(loopChecked({ loopDetection: true }, router), true);
  // A choice against the rule is stored; one that agrees with it stores nothing.
  const wiki = { memoryWiki: true };
  assert.deepEqual(withLoop(wiki, true, router), { ...wiki, loopDetection: true });
  assert.deepEqual(withLoop({ ...wiki, loopDetection: true }, false, router), wiki);
  assert.deepEqual(withLoop(wiki, false, endpoint), { ...wiki, loopDetection: false });
  assert.deepEqual(withLoop({ loopDetection: false }, true, endpoint), {});
  // Stored against the old model's rule, it is the owner's choice on the new one too.
  assert.equal(loopChecked({ loopDetection: true }, endpoint), true);
  assert.deepEqual(withLoop({ loopDetection: true }, true, endpoint), {});
});

test("a temporary member follows its lead; every other agent sets its own", () => {
  assert.equal(followsLead(agent()), false);
  assert.equal(followsLead(agent({ teamMemberId: "tm", lifetime: "task" })), true);
  assert.equal(followsLead(agent({ teamMemberId: "tm", lifetime: "permanent" })), false);
  assert.equal(followsLead(agent({ userAccess: { mode: "own" } })), false);
});

test("the Identity draft holds the runtime's options and sends them only changed", () => {
  assert.deepEqual(identityKeys, [...profileKeys, "runtimeOptions"]);
  const saved = agent({ runtimeOptions: { openclaw: { memoryWiki: true } } });
  const server = identityServer(saved);
  assert.deepEqual(server.runtimeOptions, { memoryWiki: true });
  assert.deepEqual(identityServer(agent()).runtimeOptions, {});
  // Another runtime's stored options are not this agent's.
  assert.deepEqual(
    identityServer(agent({ runtimeOptions: { hermes: { mixture: {} } } })).runtimeOptions,
    {},
  );
  const patch = identityPatch(saved);
  assert.equal("runtimeOptions" in patch(server), false);
  assert.equal(patch({ ...server, name: "Eule" }).name, "Eule");
  // The whole set goes, so the wiki the other tab switched on stays.
  assert.deepEqual(
    patch({ ...server, runtimeOptions: { memoryWiki: true, thinking: "high" } })
      .runtimeOptions,
    { openclaw: { memoryWiki: true, thinking: "high" } },
  );
  // None left is `{}`, which the store reads as no options.
  assert.deepEqual(
    identityPatch(agent({ runtimeOptions: { openclaw: { fastMode: true } } }))({
      ...server,
      runtimeOptions: {},
    }).runtimeOptions,
    {},
  );
});

test("the Identity step sends one PATCH with the draft's revision", async () => {
  const calls = [];
  const step = identityStep({
    assistant: agent(),
    label: "Identity",
    update: async (...args) => calls.push(args),
  });
  assert.deepEqual(step.keys, identityKeys);
  const values = { ...identityServer(agent()), runtimeOptions: { thinking: "low" } };
  await step.run({ values, revision: 3, confirmations: {} });
  assert.deepEqual(calls, [
    [
      "a1",
      {
        name: "Owl",
        instructions: "",
        model: { connectionId: "router", modelId: "a/b" },
        runtimeOptions: { openclaw: { thinking: "low" } },
        revision: 3,
      },
    ],
  ]);
});

test("OpenClaw registers the surface below the model; Hermes has none", () => {
  assert.deepEqual(
    openClawDescriptor.surfaces.find((surface) => surface.id === "modelOptions"),
    { id: "modelOptions", slot: "agent.identity", kind: "built", shows: "whileEnabled" },
  );
  assert.equal(
    hermesDescriptor.surfaces.some((surface) => surface.slot === "agent.identity"),
    false,
  );
  const entry = openClawWeb.entries.find((item) => item.surface === "modelOptions");
  assert.ok(entry);
  // Thinking level, fast mode, reasoning effort, loop protection and three names
  // of the fallback models.
  assert.equal(entry.aliases.length, 7);
});

test("both catalogs name the same texts", () => {
  const keys = (value, prefix = "") =>
    Object.entries(value).flatMap(([key, inner]) =>
      inner && typeof inner === "object"
        ? keys(inner, `${prefix}${key}.`)
        : [`${prefix}${key}`],
    );
  assert.deepEqual(
    keys(de.assistantModelOptionsCopy),
    keys(en.assistantModelOptionsCopy),
  );
});
