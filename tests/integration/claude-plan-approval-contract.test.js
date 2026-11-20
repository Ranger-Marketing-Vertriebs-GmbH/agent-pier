import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { installedClis, isolatedHome } from "../helpers/cli-contract.js";
import { anthropicMock } from "../helpers/anthropic-mock.js";
import { shellQuote } from "../../server/lib/launch-serialization.js";

// Runs the installed Claude Code in plan mode against a local mock API, in a
// temporary HOME and a private tmux socket. A PermissionRequest hook answers
// ExitPlanMode with AgentPier's own plan answer, and the test checks that Claude
// leaves plan mode without showing its own "Ready to code?" dialog.
const enabled = process.env.AGENTPIER_CLI_HOOK_CONTRACT === "1";
const claude = enabled ? installedClis().claude : null;
const skip = !enabled
  ? "set AGENTPIER_CLI_HOOK_CONTRACT=1 to run the installed Claude Code against a mock API"
  : !claude && "claude is not installed";
const key = "sk-ant-api03-agentpier-contract-mock-0000000000000000000000";
const permissionModule = new URL(
  "../../server/features/requests/claude-permission.js",
  import.meta.url,
).href;

async function until(read, accept, timeout = 30000, context = () => "") {
  const end = Date.now() + timeout;
  let value;
  while (Date.now() < end) {
    value = read();
    if (accept(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.fail(`timed out; last value ${JSON.stringify(value)}\n${context()}`);
}

function planSession(t, choice) {
  // Hooks run in the order they were added: stop Claude before its HOME goes.
  const stops = [];
  t.after(async () => {
    for (const stop of stops) await stop();
  });
  const ctx = isolatedHome(t);
  const cwd = fs.realpathSync(ctx.root);
  const project = path.join(cwd, "project");
  fs.mkdirSync(project);
  fs.writeFileSync(
    path.join(ctx.claudeConfig, ".claude.json"),
    JSON.stringify({
      hasCompletedOnboarding: true,
      theme: "dark",
      customApiKeyResponses: { approved: [key.slice(-20)], rejected: [] },
      projects: { [project]: { hasTrustDialogAccepted: true } },
    }),
  );
  const hook = path.join(cwd, "plan-hook.mjs");
  fs.writeFileSync(
    hook,
    [
      `import fs from "node:fs";`,
      `import { planRequest } from ${JSON.stringify(permissionModule)};`,
      `const data = JSON.parse(fs.readFileSync(0, "utf8"));`,
      `fs.writeFileSync(${JSON.stringify(path.join(cwd, "hook-input.json"))}, JSON.stringify(data));`,
      `const answer = planRequest(data)?.answer({ choice: ${JSON.stringify(choice)} });`,
      `process.stdout.write(JSON.stringify(answer ?? {}));`,
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(ctx.claudeConfig, "settings.json"),
    JSON.stringify({
      hooks: {
        PermissionRequest: [
          {
            matcher: "ExitPlanMode",
            hooks: [{ type: "command", command: `node ${shellQuote(hook)}` }],
          },
        ],
      },
    }),
  );
  return { ctx, cwd, project, stops };
}

async function runPlan(t, choice) {
  const { ctx, cwd, project, stops } = planSession(t, choice);
  const api = await anthropicMock();
  t.after(() => api.close());
  const env = {
    ...ctx.env,
    TERM: "xterm-256color",
    LANG: "en_US.UTF-8",
    ANTHROPIC_BASE_URL: api.url,
    ANTHROPIC_API_KEY: key,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
  delete env.NO_COLOR;
  const socket = path.join(cwd, "tmux.sock");
  const tmux = (...args) =>
    execFileSync("tmux", ["-S", socket, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  const command = [
    "env",
    "-i",
    ...Object.entries(env).map(([name, value]) => `${name}=${value}`),
    claude,
    "--permission-mode",
    "plan",
    "--model",
    "claude-sonnet-4-5",
  ]
    .map(shellQuote)
    .join(" ");
  tmux(
    "-f",
    "/dev/null",
    "new-session",
    "-d",
    "-s",
    "plan",
    "-x",
    "160",
    "-y",
    "45",
    "-c",
    project,
    command,
  );
  stops.push(async () => {
    try {
      tmux("kill-server");
    } catch {}
    // Let Claude's last writes into its HOME settle before the HOME is removed.
    await new Promise((resolve) => setTimeout(resolve, 500));
  });
  const screen = () => tmux("capture-pane", "-p", "-t", "plan");
  await until(screen, (text) => /plan mode on/i.test(text));
  tmux("send-keys", "-t", "plan", "-l", "PLANEXIT please");
  tmux("send-keys", "-t", "plan", "Enter");
  // The model's next request carries the ExitPlanMode result.
  const blocks = () =>
    api.requests
      .flatMap((request) => request.messages ?? [])
      .flatMap((message) => (Array.isArray(message.content) ? message.content : []));
  const context = () => {
    const input = path.join(cwd, "hook-input.json");
    return `${screen()}\nhook input: ${fs.existsSync(input) ? fs.readFileSync(input, "utf8") : "none"}`;
  };
  const result = () =>
    until(
      () => {
        const call = blocks().find(
          (block) => block.type === "tool_use" && block.name === "ExitPlanMode",
        );
        return blocks().find(
          (block) => block.type === "tool_result" && block.tool_use_id === call?.id,
        );
      },
      Boolean,
      30000,
      context,
    );
  // What Claude Code 2.1.329 hands the hook: the plan it read from its plan file.
  const hookInput = async () => {
    const file = path.join(cwd, "hook-input.json");
    await until(() => fs.existsSync(file), Boolean, 30000, context);
    return JSON.parse(fs.readFileSync(file, "utf8"));
  };
  return { result, hookInput, screen };
}

const text = (result) =>
  typeof result.content === "string"
    ? result.content
    : result.content.map((block) => block.text ?? "").join("\n");

for (const [choice, mode] of [
  ["acceptEdits", /accept edits on/i],
  ["approve", null],
]) {
  test(
    `the ${choice} plan answer leaves plan mode without Claude's own dialog`,
    { skip, timeout: 120000 },
    async (t) => {
      const run = await runPlan(t, choice);
      const input = await run.hookInput();
      assert.equal(input.tool_name, "ExitPlanMode");
      assert.equal(input.tool_input.plan, "# Plan\n\n1. Write the file");
      assert.equal(typeof input.tool_input.planFilePath, "string");
      const result = await run.result();
      assert.notEqual(result.is_error, true, text(result));
      const { screen } = run;
      const after = await until(screen, (value) => /Hello from the mock/.test(value));
      assert.doesNotMatch(after, /Ready to code\?/);
      assert.doesNotMatch(after, /plan mode on/i);
      if (mode) assert.match(after, mode);
    },
  );
}

test(
  "the keep-planning answer stays in plan mode",
  { skip, timeout: 120000 },
  async (t) => {
    const { hookInput, screen } = await runPlan(t, "keep");
    assert.equal((await hookInput()).tool_name, "ExitPlanMode");
    // The deny interrupts the turn: Claude waits for feedback, still planning.
    const after = await until(screen, (value) => /Rejected Claude's plan/.test(value));
    assert.match(after, /plan mode on/i);
    assert.doesNotMatch(after, /Ready to code\?/);
  },
);
