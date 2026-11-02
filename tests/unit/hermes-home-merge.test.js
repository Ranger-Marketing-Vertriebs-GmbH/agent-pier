import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hermesCompiler } from "../../server/features/assistants/runtimes/hermes/hermes-compiler.js";
import {
  HermesHomeError,
  mergeEnv,
  readHermesConfig,
} from "../../server/features/assistants/runtimes/hermes/hermes-config/home-merge.js";
import {
  goldenCompileInput,
  hermesGoldenScenarios,
} from "../helpers/hermes-golden-scenarios.js";

// Hermes writes into the home AgentPier compiles (Hermes runtime spike): the merge
// keeps what Hermes wrote, replaces what AgentPier owns and never writes a key twice.
const hermesWritten = `_config_version: 52
model:
  provider: custom
  default: old-model
  base_url: http://127.0.0.1:47811/v1
  api_key: sk-stale-literal
onboarding:
  profile_build: ask
  seen:
    profile_build_offered: true
gateway:
  multiplex_profiles: true
command_allowlist:
  - plugin_rule:agentpier:terminal:abc
plugins:
  disabled:
    - disk-cleanup
approvals:
  mode: smart
approvals:
  mode: smart
  timeout: 120
`;
const envWritten = `# Per-profile secrets for this Hermes profile.
TELEGRAM_BOT_TOKEN=123:abc
OPENROUTER_API_KEY=sk-or-stale
AUXILIARY_AGENTPIER_API_KEY=sk-old
OPENROUTER_API_KEY=sk-or-stale-again
`;
const home = (name, existing) =>
  hermesCompiler.compile(goldenCompileInput(hermesGoldenScenarios[name](), existing))
    .homes["ap-a1"];

test("a merge keeps Hermes's keys, replaces AgentPier's and writes each key once", () => {
  const { files } = home("shell-approval", {
    "config.yaml": hermesWritten,
    ".env": envWritten,
  });
  const text = files["config.yaml"];
  const config = readHermesConfig(text);
  // Hermes's own keys, where they stood.
  assert.equal(config._config_version, 52);
  assert.deepEqual(config.onboarding.seen, { profile_build_offered: true });
  assert.equal(config.gateway.multiplex_profiles, true);
  assert.deepEqual(config.command_allowlist, ["plugin_rule:agentpier:terminal:abc"]);
  assert.deepEqual(config.plugins.disabled, ["disk-cleanup"]);
  assert.equal(config.approvals.timeout, 120);
  assert.ok(text.startsWith("_config_version: 52\nmodel:\n"));
  // AgentPier's keys, replaced; the stale literal key and model are gone.
  assert.equal(config.onboarding.profile_build, "off");
  assert.equal(config.approvals.mode, "manual");
  assert.equal(config.model.default, "golden-1");
  assert.equal(config.model.api_key, undefined);
  assert.doesNotMatch(text, /sk-stale-literal|old-model/);
  // No key twice, at any level (Hermes's YAML loader refuses duplicates).
  for (const line of ["approvals:", "  mode: manual", "model:"])
    assert.equal(text.split("\n").filter((l) => l === line).length, 1, line);
  assert.doesNotThrow(() => readHermesConfig(text), "parses with unique keys");
  // .env: Hermes's names stay, AgentPier's are written once, stale ones go.
  assert.equal(
    files[".env"],
    "# Per-profile secrets for this Hermes profile.\n" +
      "TELEGRAM_BOT_TOKEN=123:abc\n" +
      "AUXILIARY_AGENTPIER_API_KEY='sk-golden-endpoint'\n",
  );
});

test("a merge without the model leaves the model section and its secrets alone", () => {
  const { files, env } = home("no-tools", {
    "config.yaml": hermesWritten,
    ".env": envWritten,
  });
  assert.equal(readHermesConfig(files["config.yaml"]).model.default, "old-model");
  assert.equal(files[".env"], undefined);
  assert.deepEqual(env, { owned: [], values: {} });
});

test("a config.yaml that is no YAML mapping is refused, not overwritten", () => {
  for (const broken of ["model: [unclosed", "- a list\n- of items\n"])
    assert.throws(
      () => home("no-tools", { "config.yaml": broken }),
      (error) => error instanceof HermesHomeError && error.file === "config.yaml",
    );
});

test(".env values are literal and single-line", () => {
  assert.equal(mergeEnv("", ["K"], { K: "a$b${C}" }), "K='a$b${C}'\n");
  assert.equal(mergeEnv("A=1\n", ["K"], {}), "A=1\n");
  assert.equal(mergeEnv("export K=old\n", ["K"], { K: "new" }), "K='new'\n");
  assert.throws(() => mergeEnv("", ["K"], { K: "a\nb" }), /line break/);
  assert.throws(() => mergeEnv("", ["K"], { K: "it's" }), /quote/);
});

const tempHome = (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-home-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, "home");
};
const read = (dir, file) => fs.readFileSync(path.join(dir, file), "utf8");
const mode = (dir, file) => fs.statSync(path.join(dir, file)).mode & 0o777;

test("the writer merges into the home as Hermes left it, owner-only", (t) => {
  const dir = tempHome(t);
  const strict = home("every-command");
  assert.deepEqual(hermesCompiler.write(dir, strict), [
    ".env",
    "SOUL.md",
    "config.yaml",
    "plugins/agentpier-guard/__init__.py",
    "plugins/agentpier-guard/guard.json",
    "plugins/agentpier-guard/plugin.yaml",
  ]);
  assert.equal(mode(dir, "config.yaml"), 0o600);
  assert.equal(mode(dir, "plugins/agentpier-guard"), 0o700);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  // Writing the same home again changes nothing.
  assert.deepEqual(hermesCompiler.write(dir, strict), []);
  // Hermes stamps its version and remembers a hint; the next write keeps both and
  // drops the guard once the agent leaves every-command approval.
  fs.appendFileSync(path.join(dir, "config.yaml"), "_config_version: 52\n");
  fs.appendFileSync(path.join(dir, ".env"), "TELEGRAM_BOT_TOKEN=123:abc\n");
  assert.deepEqual(hermesCompiler.write(dir, home("full")), [
    ".env",
    "config.yaml",
    "plugins/agentpier-guard",
  ]);
  const config = readHermesConfig(read(dir, "config.yaml"));
  assert.equal(config._config_version, 52);
  assert.equal(config.approvals.mode, "off");
  assert.deepEqual(config.plugins.enabled, []);
  assert.equal(fs.existsSync(path.join(dir, "plugins/agentpier-guard")), false);
  assert.equal(
    read(dir, ".env"),
    "TELEGRAM_BOT_TOKEN=123:abc\nOPENROUTER_API_KEY='sk-or-golden'\n",
  );
});

test("the writer stays inside the home", (t) => {
  const dir = tempHome(t);
  const outside = { ...home("no-tools"), files: { "../escape.txt": "x" } };
  assert.throws(() => hermesCompiler.write(dir, outside), { code: "HERMES_HOME_UNSAFE" });
  assert.equal(fs.existsSync(path.join(path.dirname(dir), "escape.txt")), false);
  assert.throws(() => hermesCompiler.write("relative/home", home("no-tools")), TypeError);
});
