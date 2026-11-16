import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { hermesCompiler } from "../../server/features/assistants/runtimes/hermes/hermes-compiler.js";
import { hermesExecutables } from "../../server/features/assistants/runtimes/hermes/hermes-paths.js";
import {
  goldenCompileInput,
  hermesGoldenScenarios,
} from "../helpers/hermes-golden-scenarios.js";
import { contractTimeout } from "../helpers/contract-timeout.js";

// "Learns its own skills" against the pinned Hermes (ADR 0007, step 6;
// docs/hermes-runtime.md): AgentPier writes `skills.creation_nudge_interval: 0` for
// an agent that does not learn and no key for one that does. `hermes config check`
// must accept both homes, and Hermes's own agent setup (agent/agent_init.py
// `_apply_agent_section`, which every agent runs on the loaded config) must read the
// interval the turn's end compares before it starts a skill review
// (agent/turn_finalizer.py: `_skill_nudge_interval > 0`). Every process gets a
// private HOME, HERMES_HOME and TMPDIR and a cleared environment.
const runtime = process.env.AGENTPIER_HERMES_CONTRACT_RUNTIME;
const options = {
  skip: !runtime && "set AGENTPIER_HERMES_CONTRACT_RUNTIME",
  timeout: contractTimeout(300000),
};
const run = promisify(execFile);
const bin = (name) => hermesExecutables(runtime || "")[name];

const probe = `
import json, os, types
from hermes_cli.env_loader import load_hermes_dotenv
load_hermes_dotenv(hermes_home=os.environ["HERMES_HOME"])
from hermes_cli.config import load_config
from hermes_cli.tools_config import _get_platform_tools
from agent import agent_init
config = load_config()
agent = types.SimpleNamespace()
try:
  agent_init._apply_agent_section(agent, config)
except Exception:
  pass
interval = getattr(agent, "_skill_nudge_interval", None)
print(json.dumps({
  "interval": interval,
  "reviews": bool(interval and interval > 0),
  "toolsets": sorted(_get_platform_tools(config, "cli", include_default_mcp_servers=False)),
  "memory": bool((config.get("memory") or {}).get("memory_enabled")),
}))
`;

async function hermesHome(t, name, skillLearning) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `hermes-learning-${name}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dirs = Object.fromEntries(
    ["home", "hermes", "tmp", "work"].map((d) => [d, path.join(root, d)]),
  );
  for (const d of ["home", "tmp", "work"]) fs.mkdirSync(dirs[d]);
  const scenario = hermesGoldenScenarios["shell-approval"]();
  if (skillLearning !== undefined)
    scenario.profile = { ...scenario.profile, skillLearning };
  const input = goldenCompileInput(scenario);
  input.workspaces = { "ap-a1": dirs.work };
  hermesCompiler.write(dirs.hermes, hermesCompiler.compile(input).homes["ap-a1"]);
  const env = {
    HOME: dirs.home,
    HERMES_HOME: dirs.hermes,
    TMPDIR: dirs.tmp,
    PATH: `${path.dirname(bin("python"))}:/usr/bin:/bin`,
    LANG: "C.UTF-8",
  };
  const exec = (file, args) =>
    run(file, args, { cwd: dirs.work, env, timeout: 120000, maxBuffer: 8 << 20 });
  const check = await exec(bin("hermes"), ["config", "check"]);
  assert.doesNotMatch(check.stdout, /✗|⚠/, check.stdout);
  const { stdout } = await exec(bin("python"), ["-c", probe]);
  return {
    seen: JSON.parse(stdout.trim().split("\n").at(-1)),
    yaml: fs.readFileSync(path.join(dirs.hermes, "config.yaml"), "utf8"),
  };
}

test(
  "Hermes reads the interval 0 of an agent that does not learn",
  options,
  async (t) => {
    const { seen, yaml } = await hermesHome(t, "off", false);
    t.diagnostic(`off=${JSON.stringify(seen)}`);
    assert.match(yaml, /creation_nudge_interval: 0/);
    assert.equal(seen.interval, 0);
    assert.equal(seen.reviews, false, "no skill review is ever due");
    // The agent can still read and, when asked, write skills; memory stays on.
    assert.ok(seen.toolsets.includes("skills"));
    assert.equal(seen.memory, true);
  },
);

for (const [name, value] of [
  ["unset", undefined],
  ["on", true],
])
  test(
    `Hermes keeps its own interval for an agent that learns (${name})`,
    options,
    async (t) => {
      const { seen, yaml } = await hermesHome(t, name, value);
      t.diagnostic(`${name}=${JSON.stringify(seen)}`);
      assert.doesNotMatch(yaml, /creation_nudge_interval/);
      assert.equal(seen.interval, 10);
      assert.equal(seen.reviews, true);
      assert.ok(seen.toolsets.includes("skills"));
    },
  );
