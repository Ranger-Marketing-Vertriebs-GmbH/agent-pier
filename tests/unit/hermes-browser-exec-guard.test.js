import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { compileHome } from "../../server/features/assistants/runtimes/hermes/hermes-config/home.js";
import { readHermesConfig } from "../../server/features/assistants/runtimes/hermes/hermes-config/home-merge.js";
import { desiredAgent } from "../../server/features/assistants/agent-desired-state.js";
import { shortenedMark } from "../../server/features/assistants/runtimes/hermes/hermes-approval-queue.js";

// Hermes's browser_exec runs the agent's Python on the host (Hermes v0.23
// tools/browser_use_cli.py) and Hermes asks before none of it: on an asking shell
// level AgentPier's guard asks the owner as Hermes asks before an execute_code run
// (hermes-config/guard-plugin.js).

const connection = { url: "http://127.0.0.1:4100", token: "t" };
const browser = { cdpUrl: "http://127.0.0.1:41234", allowPrivateNetwork: false };
const home = (shell, extra = {}) =>
  compileHome(
    desiredAgent({
      id: "a1",
      runtimeAgentId: "ap-a1",
      revision: 1,
      shell,
      capabilities: { browser: true },
      ...extra,
    }),
    { connection, browser, strict: extra.strict ? ["ap-a1"] : [] },
  );
const settingsOf = (compiled) =>
  JSON.parse(compiled.files["plugins/agentpier-guard/guard.json"] || "null");

test("the guard asks before browser_exec on the asking shell levels only", () => {
  assert.deepEqual(settingsOf(home("approval")), {
    everyCommand: false,
    cronAsks: true,
    browserAsks: true,
  });
  assert.deepEqual(settingsOf(home("approval", { strict: true })), {
    everyCommand: true,
    cronAsks: true,
    browserAsks: true,
  });
  // Full access asks nobody; without a shell Hermes offers no browser_exec at all
  // (only browser_cdp), so there is nothing to ask.
  for (const level of ["full", "off"]) {
    const compiled = home(level);
    const config = readHermesConfig(compiled.files["config.yaml"]);
    assert.equal(config.agent.disabled_toolsets.includes("browser"), false);
    assert.equal(settingsOf(compiled), null);
    assert.equal(config.plugins.enabled.includes("agentpier-guard"), false);
  }
  const off = readHermesConfig(home("off").files["config.yaml"]);
  assert.ok(off.agent.disabled_toolsets.includes("terminal"));
});

const python = spawnSync("python3", ["--version"]).status === 0 ? "python3" : null;

async function runHook(root, call, env = {}) {
  const script = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("guard", sys.argv[1])
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)
print(json.dumps(guard._guard(**json.loads(sys.argv[2]))))
`;
  const { stdout } = await promisify(execFile)(
    python,
    [
      "-I",
      "-c",
      script,
      path.join(root, "plugins", "agentpier-guard", "__init__.py"),
      JSON.stringify(call),
    ],
    { env: { PATH: process.env.PATH, ...env }, timeout: 20000 },
  );
  return JSON.parse(stdout);
}

function written(t, compiled) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-browser-guard-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [file, text] of Object.entries(compiled.files)) {
    if (!file.startsWith("plugins/agentpier-guard/")) continue;
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  return root;
}

const run = (code) => ({
  tool_name: "browser_exec",
  args: { code },
  session_id: "s1",
  task_id: "t1",
});

test(
  "browser_exec asks once per chat on approval and per run on every-command",
  { skip: !python && "python3 is not installed" },
  async (t) => {
    const approval = written(t, home("approval"));
    const first = await runHook(approval, run("new_tab('https://a.example')"));
    const second = await runHook(approval, run("print(page_info())"));
    // One rule key: allowing it for the chat covers the browser for that session.
    assert.deepEqual(first, {
      action: "approve",
      message: "new_tab('https://a.example')",
      rule_key: "agentpier:browser_exec",
    });
    assert.equal(second.rule_key, "agentpier:browser_exec");
    // Other tools stay Hermes's own business on this level.
    assert.equal(
      await runHook(approval, { ...run(""), tool_name: "browser_cdp", args: {} }),
      null,
    );
    const every = written(t, home("approval", { strict: true }));
    const a = await runHook(every, run("print(1)"));
    const b = await runHook(every, run("print(2)"));
    assert.match(a.rule_key, /^agentpier:browser_exec:[0-9a-f]{32}$/);
    assert.notEqual(a.rule_key, b.rule_key);
    // A long run is shown shortened, marked so the card offers no "Always allow".
    const long = await runHook(every, run(`print(1)\n${"#".repeat(5000)}`));
    assert.ok(long.message.endsWith(shortenedMark));
    assert.equal(long.message.length, 4000 + shortenedMark.length);
    // Without its settings the guard blocks the run.
    fs.rmSync(path.join(approval, "plugins/agentpier-guard/guard.json"));
    assert.equal((await runHook(approval, run("print(1)"))).action, "block");
  },
);

test(
  "a routine run's browser_exec asks the owner through the team bridge",
  { skip: !python && "python3 is not installed" },
  async (t) => {
    const root = written(t, home("approval"));
    const bodies = [];
    const server = http.createServer((req, res) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        bodies.push(JSON.parse(data));
        res.end(JSON.stringify({ allow: false, message: "BLOCKED: denied" }));
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    t.after(() => server.close());
    fs.mkdirSync(path.join(root, "plugins", "agentpier-team"));
    fs.writeFileSync(
      path.join(root, "plugins", "agentpier-team", "bridge.json"),
      JSON.stringify({
        url: `http://127.0.0.1:${server.address().port}`,
        token: "tok",
        agentId: "ap-a1",
      }),
    );
    const answer = await runHook(
      root,
      {
        ...run("new_tab('https://a.example')"),
        session_id: "cron_job1_20261102_090000",
        task_id: "cron:job1:exec1",
      },
      { HERMES_CRON_SESSION: "1" },
    );
    assert.deepEqual(answer, { action: "block", message: "BLOCKED: denied" });
    assert.equal(bodies.at(-1).kind, "code");
    assert.equal(bodies.at(-1).command, "new_tab('https://a.example')");
    assert.equal(bodies.at(-1).description, "browser_exec script execution");
  },
);
