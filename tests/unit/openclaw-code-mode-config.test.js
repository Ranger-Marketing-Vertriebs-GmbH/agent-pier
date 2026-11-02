import test from "node:test";
import assert from "node:assert/strict";
import { compileOpenClawConfig } from "../../server/features/assistants/runtimes/openclaw/runtime-config.js";
import { validateOverride } from "../../server/features/assistants/runtimes/openclaw/openclaw-config/overrides.js";

// OpenClaw 2026.10 engages Code Mode while `tools.codeMode` is absent ("auto") for
// catalog-preferred models; a tool called from a Code Mode cell returns only its
// `details`, so a browser snapshot's page text never reached the model. Every start
// compiles it off, and no agent or model setting, which OpenClaw ranks above the
// global one, survives to turn it back on.
const paths = { workspaces: "/w", logs: "/l" };
const profile = {
  id: "a1",
  runtimeAgentId: "ap-a1",
  capabilities: { memory: false, reminders: false, browser: true },
};
const teams = {
  directory: "/plugin",
  connection: { url: "http://127.0.0.1:1", token: "bridge" },
  hostMaxConcurrent: 4,
  native: { token: "hook" },
  profiles: [profile],
};
const ref = "openai/gpt-6-astra";
// A configuration someone turned Code Mode on in, at every level OpenClaw reads.
const existing = () => ({
  agents: {
    defaults: { models: { [ref]: { alias: "astra", codeMode: true } } },
    entries: {
      main: { tools: { codeMode: "auto" } },
      "ap-a1": {
        id: "ap-a1",
        tools: { allow: ["browser"], codeMode: { enabled: true } },
        models: { [ref]: { codeMode: true, streaming: true } },
      },
    },
  },
  tools: { codeMode: true },
});
const compile = (withTeams) =>
  compileOpenClawConfig({
    existing: existing(),
    paths,
    port: 1234,
    token: "t",
    ...(withTeams && { teams }),
  });

for (const [label, withTeams] of [
  ["a native team start", true],
  ["a start without teams", false],
])
  test(`${label} compiles Code Mode off and drops every agent or model override`, () => {
    const config = compile(withTeams);
    assert.equal(config.tools.codeMode, false);
    assert.equal(config.tools.toolSearch, false);
    // Other model settings stay; only the activation goes.
    assert.deepEqual(config.agents.defaults.models, { [ref]: { alias: "astra" } });
    for (const [id, entry] of Object.entries(config.agents.entries)) {
      assert.equal(entry.tools?.codeMode, undefined, id);
      for (const model of Object.values(entry.models || {}))
        assert.equal(model.codeMode, undefined, id);
    }
    assert.equal(config.agents.entries["ap-a1"].models[ref].streaming, true);
    assert.doesNotMatch(
      JSON.stringify({ ...config, tools: { ...config.tools, codeMode: undefined } }),
      /codeMode/,
    );
  });

test("an owner override cannot turn Code Mode back on", () => {
  for (const target of [
    "tools.codeMode",
    "tools.codeMode.enabled",
    "agents.entries.ap-a1.tools.codeMode",
    `agents.defaults.models.${ref}.codeMode`,
  ])
    assert.throws(() => validateOverride(target, true), { status: 400 }, target);
});
