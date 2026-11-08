import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { hermesCompiler } from "../../server/features/assistants/runtimes/hermes/hermes-compiler.js";
import { readHermesConfig } from "../../server/features/assistants/runtimes/hermes/hermes-config/home-merge.js";
import { desiredAgent } from "../../server/features/assistants/agent-desired-state.js";
import {
  goldenCompileInput,
  goldenText,
  hermesGoldenScenarios,
} from "../helpers/hermes-golden-scenarios.js";

// The Hermes home each representative desired state compiles to, byte for byte
// (tests/fixtures/hermes-golden/, excluded from Prettier). A change here changes
// what every Hermes agent runs with: review the fixture diff with
// docs/hermes-runtime.md.
const fixtures = path.resolve(import.meta.dirname, "../fixtures/hermes-golden");
const expected = (name) => fs.readFileSync(path.join(fixtures, `${name}.txt`), "utf8");
const compiled = (name) => {
  const { homes } = hermesCompiler.compile(
    goldenCompileInput(hermesGoldenScenarios[name]()),
  );
  return homes["ap-a1"];
};

for (const name of Object.keys(hermesGoldenScenarios))
  test(`golden Hermes home: ${name}`, () => {
    assert.equal(goldenText(compiled(name)), expected(name));
  });

test("every golden fixture has its scenario", () => {
  const names = fs.readdirSync(fixtures).map((file) => path.basename(file, ".txt"));
  assert.deepEqual(names.sort(), Object.keys(hermesGoldenScenarios).sort());
});

test("the compiled home holds config.yaml, .env, SOUL.md and AgentPier's plugins only", () => {
  for (const name of Object.keys(hermesGoldenScenarios))
    for (const file of Object.keys(compiled(name).files))
      assert.match(
        file,
        /^(?:config\.yaml|\.env|SOUL\.md|plugins\/agentpier-(?:guard|team|deepgram|web)\/.+)$/,
      );
});

test("shell levels map to Hermes's approval model and toolsets", () => {
  const config = (name) => readHermesConfig(compiled(name).files["config.yaml"]);
  const shellTools = ["code_execution", "terminal"];
  const off = config("no-tools");
  assert.equal(off.approvals.mode, "manual");
  assert.ok(shellTools.every((t) => off.agent.disabled_toolsets.includes(t)));
  for (const [name, mode] of [
    ["shell-approval", "manual"],
    ["every-command", "manual"],
    ["full", "off"],
  ]) {
    const c = config(name);
    assert.equal(c.approvals.mode, mode, name);
    assert.ok(!shellTools.some((t) => c.agent.disabled_toolsets.includes(t)), name);
    assert.deepEqual(
      c.plugins.enabled,
      name === "every-command"
        ? ["agentpier-guard"]
        : name === "shell-approval"
          ? ["agentpier-web"]
          : [],
    );
  }
  assert.deepEqual(compiled("shell-approval").remove, [
    "plugins/agentpier-guard",
    "plugins/agentpier-team",
  ]);
  assert.deepEqual(compiled("every-command").remove, [
    "plugins/agentpier-team",
    "plugins/agentpier-web",
  ]);
});

test("a lead and a member get the team plugin with their own team tools", () => {
  const plugin = (name) => {
    const home = compiled(name);
    const file = (part) => home.files[`plugins/agentpier-team/${part}`];
    return {
      home,
      config: readHermesConfig(home.files["config.yaml"]),
      settings: JSON.parse(file("tools.json")),
      bridge: JSON.parse(file("bridge.json")),
    };
  };
  const lead = plugin("team-lead");
  assert.deepEqual(lead.config.plugins.enabled, ["agentpier-team"]);
  assert.equal(lead.home.unsupported.includes("teams"), false);
  const names = lead.settings.tools.map((tool) => tool.name);
  assert.ok(names.includes("agentpier_team_propose"));
  assert.ok(names.includes("agentpier_team_delegate"));
  assert.equal(names.includes("agentpier_team_report"), false);
  // An ask waits inside the tool, beyond Hermes's 30-second hook timeout.
  const ask = lead.settings.tools.find((tool) => tool.name === "agentpier_team_ask");
  assert.ok(ask.timeoutMs > 30000);
  assert.equal(lead.settings.guardWrites, false);
  assert.deepEqual(lead.bridge, {
    url: "http://127.0.0.1:43210",
    token: "golden-bridge-token",
    agentId: "ap-a1",
  });
  const member = plugin("team-member");
  assert.deepEqual(
    member.settings.tools.map((tool) => tool.name),
    [
      // AgentPier's own tools, as a permanent member holds them on OpenClaw.
      "agentpier_coding_session",
      "agentpier_goal",
      "agentpier_mail",
      "agentpier_pinboard",
      "agentpier_preview",
      "agentpier_share_file",
      "agentpier_ssh_access",
      "agentpier_team_peer_ask",
      "agentpier_team_peer_delegate",
      "agentpier_team_peers",
      "agentpier_team_report",
      "agentpier_workspace",
    ],
  );
  // A staged browser upload copies up to 8 GiB before the workspace call answers.
  const workspace = member.settings.tools.find((t) => t.name === "agentpier_workspace");
  assert.equal(workspace.stageTimeoutMs, 300000);
  assert.ok(lead.settings.tools.some((t) => t.name === "agentpier_share_file"));
  assert.equal(member.settings.guardWrites, true);
  // Without the bridge the tools are named as not served yet.
  assert.ok(compiled("subagents-default").unsupported.includes("teams"));
});

test("subagents stay on and the practical defaults hold for every home", () => {
  for (const name of Object.keys(hermesGoldenScenarios)) {
    const c = readHermesConfig(compiled(name).files["config.yaml"]);
    assert.ok(!c.agent.disabled_toolsets.includes("delegation"), name);
    assert.equal(c.delegation.subagent_auto_approve, false);
    assert.equal(c.web.keyless_fallback, false);
    assert.equal(c.auth.adopt_external_logins, false);
    assert.equal(c.onboarding.profile_build, "off");
    assert.equal(c.updates.check, false);
    assert.equal(c.telemetry.shared_metrics.send, false);
  }
});

test("secrets reach only .env, never config.yaml", () => {
  for (const name of Object.keys(hermesGoldenScenarios)) {
    const { files } = compiled(name);
    assert.doesNotMatch(files["config.yaml"], /sk-/, name);
    assert.ok(!readHermesConfig(files["config.yaml"]).model?.api_key, name);
  }
  assert.match(
    compiled("shell-approval").files[".env"],
    /^AUXILIARY_AGENTPIER_API_KEY='/,
  );
  assert.match(compiled("full").files[".env"], /^OPENROUTER_API_KEY='sk-or-golden'\n$/);
  assert.equal(compiled("every-command").files[".env"], "");
});

test("a lead gets agentpier_craft only while Craft Anything is available", () => {
  const scenario = hermesGoldenScenarios["team-lead"]();
  const tools = (craft) => {
    const input = goldenCompileInput(scenario);
    const agent = desiredAgent(scenario.profile, {
      model: scenario.model,
      instructions: scenario.instructions,
      craft,
    });
    const home = hermesCompiler.compile({ ...input, agents: [agent] }).homes["ap-a1"];
    return JSON.parse(home.files["plugins/agentpier-team/tools.json"]).tools;
  };
  assert.ok(!tools(false).some((tool) => tool.name === "agentpier_craft"));
  const craft = tools(true).find((tool) => tool.name === "agentpier_craft");
  assert.equal(craft.timeoutMs, 95000);
  assert.deepEqual(craft.parameters.properties.action.enum, ["start", "status"]);
});
