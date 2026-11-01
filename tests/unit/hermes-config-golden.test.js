import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { hermesCompiler } from "../../server/features/assistants/runtimes/hermes/hermes-compiler.js";
import { readHermesConfig } from "../../server/features/assistants/runtimes/hermes/hermes-config/home-merge.js";
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
        /^(?:config\.yaml|\.env|SOUL\.md|plugins\/agentpier-(?:guard|deepgram)\/.+)$/,
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
      name === "every-command" ? ["agentpier-guard"] : [],
    );
  }
  assert.deepEqual(compiled("shell-approval").remove, ["plugins/agentpier-guard"]);
  assert.deepEqual(compiled("every-command").remove, []);
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
