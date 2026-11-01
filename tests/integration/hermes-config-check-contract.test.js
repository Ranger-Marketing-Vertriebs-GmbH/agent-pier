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
  endpointKeyEnv,
  openRouterKeyEnv,
} from "../../server/features/assistants/runtimes/hermes/hermes-config/model.js";
import {
  goldenCompileInput,
  hermesGoldenScenarios,
} from "../helpers/hermes-golden-scenarios.js";
import { contractTimeout } from "../helpers/contract-timeout.js";
import { telegramTokenEnv } from "../../server/features/assistants/runtimes/hermes/hermes-config/telegram.js";
import { deepgramKeyEnv } from "../../server/features/assistants/runtimes/hermes/hermes-config/deepgram-plugin.js";

// The compiled homes against the pinned Hermes (docs/hermes-runtime.md): `hermes
// config check` accepts each, and Hermes reads them as AgentPier means them.
// AGENTPIER_HERMES_CONTRACT_RUNTIME names an installation that
// scripts/provision-hermes-contracts.mjs made from the pinned manifest (its
// venv/bin/python and venv/bin/hermes, hermesExecutables). Every process gets a private HOME,
// HERMES_HOME and TMPDIR inside the test folder and a cleared environment, so the
// developer's own ~/.hermes is never read or written.
const runtime = process.env.AGENTPIER_HERMES_CONTRACT_RUNTIME;
const options = {
  skip: !runtime && "set AGENTPIER_HERMES_CONTRACT_RUNTIME",
  timeout: contractTimeout(300000),
};
const run = promisify(execFile);
const bin = (name) => hermesExecutables(runtime || "")[name];

// What Hermes makes of a home: approval mode, the CLI's toolsets, the loaded guard
// plugin and its directive for a command, the model route and whether its key
// reached a child process's environment.
const probe = `
import json, os, sys
from hermes_cli.env_loader import load_hermes_dotenv
load_hermes_dotenv(hermes_home=os.environ["HERMES_HOME"])
from hermes_cli.config import load_config
from hermes_cli.tools_config import _get_platform_tools
from hermes_cli.plugins import discover_plugins, get_plugin_manager, get_pre_tool_call_directive
from hermes_cli.runtime_provider import resolve_runtime_provider
from tools.environments.local import _sanitize_subprocess_env
config = load_config()
discover_plugins()
loaded = getattr(get_plugin_manager(), "_plugins", {}).values()
out = {
  "approvals": config["approvals"]["mode"],
  "toolsets": sorted(_get_platform_tools(config, "cli", include_default_mcp_servers=False)),
  "guard": [p.manifest.name for p in loaded if p.manifest.source == "user" and p.enabled and not p.error],
  "directive": list(get_pre_tool_call_directive("terminal", {"command": "ls -la /tmp"})),
  "adopt": config["auth"]["adopt_external_logins"],
  "keyless": config["web"]["keyless_fallback"],
  "teamTools": sorted(n for n in __import__("tools.registry", fromlist=["registry"]).registry.get_all_tool_names() if n.startswith("agentpier_team_")),
}
if config.get("model"):
  route = resolve_runtime_provider()
  out["route"] = [route["provider"], route["api_mode"], route["base_url"]]
  out["key"] = route.get("api_key") == os.environ.get(sys.argv[1])
from agent.transcription_registry import get_provider as stt_provider
stt = (config.get("stt") or {})
if stt.get("enabled") and stt.get("provider"):
  provider = stt_provider(stt["provider"])
  out["stt"] = [stt["provider"], bool(provider and provider.is_available())]
child = _sanitize_subprocess_env(dict(os.environ))
out["leaked"] = sorted(k for k in child if k in sys.argv[1:])
print(json.dumps(out))
`;

async function hermesHome(t, name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `hermes-contract-${name}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dirs = Object.fromEntries(
    ["home", "hermes", "tmp", "work"].map((d) => [d, path.join(root, d)]),
  );
  for (const d of ["home", "tmp", "work"]) fs.mkdirSync(dirs[d]);
  const input = goldenCompileInput(hermesGoldenScenarios[name]());
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
  return { exec, dirs };
}

for (const name of Object.keys(hermesGoldenScenarios))
  test(`Hermes accepts the compiled ${name} home`, options, async (t) => {
    const { exec } = await hermesHome(t, name);
    const check = await exec(bin("hermes"), ["config", "check"]);
    assert.doesNotMatch(check.stdout, /✗|⚠/, check.stdout);
    const scenario = hermesGoldenScenarios[name]();
    const provider = scenario.model?.provider;
    const keyEnv = provider?.baseUrl.includes("openrouter.ai")
      ? openRouterKeyEnv
      : endpointKeyEnv;
    const keys = [
      keyEnv,
      keyEnv === endpointKeyEnv ? openRouterKeyEnv : endpointKeyEnv,
      // The agent's own bot (AGENTPIER-341): its token and the Deepgram key.
      telegramTokenEnv,
      deepgramKeyEnv,
    ];
    const { stdout } = await exec(bin("python"), ["-c", probe, ...keys]);
    const seen = JSON.parse(stdout.trim().split("\n").at(-1));
    const level = scenario.strict ? "every-command" : scenario.profile.shell || "off";
    assert.equal(seen.approvals, level === "full" ? "off" : "manual");
    assert.equal(seen.toolsets.includes("terminal"), level !== "off");
    assert.equal(seen.toolsets.includes("delegation"), true);
    assert.equal(seen.toolsets.includes("browser"), false);
    // The team plugin (team-plugin.js) loads with the team bridge and registers the
    // agent's team tools, offered beside Hermes's own toolsets.
    const team = !!scenario.connection;
    const voice = !!scenario.channelBot?.speech;
    assert.deepEqual(seen.guard, [
      ...(level === "every-command" ? ["agentpier-guard"] : []),
      ...(team ? ["agentpier-team"] : []),
      ...(voice ? ["agentpier-deepgram"] : []),
    ]);
    assert.equal(seen.teamTools.length > 0, team);
    assert.equal(seen.toolsets.includes("agentpier"), team);
    // The Deepgram plugin registers its provider and finds its key.
    assert.deepEqual(seen.stt, voice ? ["agentpier-deepgram", true] : undefined);
    assert.deepEqual(
      seen.directive,
      level === "every-command" ? ["approve", "ls -la /tmp"] : [null, null],
    );
    assert.equal(seen.adopt, false);
    assert.equal(seen.keyless, false);
    if (provider) {
      assert.deepEqual(seen.route.slice(0, 2), [
        keyEnv === openRouterKeyEnv ? "openrouter" : "custom",
        "chat_completions",
      ]);
      if (provider.apiKey)
        assert.equal(seen.key, true, "the key reaches the model route");
    } else assert.equal(seen.route, undefined);
    assert.deepEqual(seen.leaked, []);
  });
