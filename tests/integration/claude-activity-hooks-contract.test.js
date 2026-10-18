import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { installedClis, isolatedHome } from "../helpers/cli-contract.js";
import { anthropicMock } from "../helpers/anthropic-mock.js";
import { AccountStore } from "../../server/features/accounts/account-store.js";
import { NativeSessionBinding } from "../../server/features/sessions/native-session-binding.js";
import { shellQuote } from "../../server/lib/launch-serialization.js";

// Runs the installed Claude Code against a local mock API in a temporary HOME and a
// private tmux socket, and checks the hook events AgentPier's activity relies on.
const enabled = process.env.AGENTPIER_CLI_HOOK_CONTRACT === "1";
const claude = enabled ? installedClis().claude : null;
const skip = !enabled
  ? "set AGENTPIER_CLI_HOOK_CONTRACT=1 to run the installed Claude Code against a mock API"
  : !claude && "claude is not installed";
const key = "sk-ant-api03-agentpier-contract-mock-0000000000000000000000";

async function until(read, accept, timeout = 30000) {
  const end = Date.now() + timeout;
  let value;
  while (Date.now() < end) {
    value = read();
    if (accept(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.fail(`timed out; last value ${JSON.stringify(value)}`);
}

test(
  "Claude Code reports turns, background work and exit through the activity hooks",
  { skip, timeout: 180000 },
  async (t) => {
    const ctx = isolatedHome(t);
    const api = await anthropicMock();
    t.after(() => api.close());
    const cwd = fs.realpathSync(path.join(ctx.root));
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
    const accounts = new AccountStore({
      dataDir: path.join(cwd, "data"),
      home: ctx.home,
    });
    const account = accounts.create({ name: "contract", tool: "claude" });
    const bindings = new NativeSessionBinding({ dataDir: accounts.dataDir, accounts });
    const id = "0f7a1c52-6a8e-4b3c-9d21-5e4f3a2b1c0d";
    const prepared = await bindings.prepare({
      id,
      account,
      cwd: project,
      launch: { command: claude, args: [], env: {} },
    });
    const session = {
      id,
      tool: "claude",
      accountId: account.id,
      cwd: project,
      status: "running",
      nativeBinding: prepared.nativeBinding,
    };
    const env = {
      ...ctx.env,
      ...prepared.env,
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
      ...prepared.args,
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
      "contract",
      "-x",
      "160",
      "-y",
      "45",
      "-c",
      project,
      command,
    );
    t.after(() => {
      try {
        tmux("kill-server");
      } catch {}
    });
    const activity = () => bindings.activity(session);
    await until(activity, (value) => value?.event === "SessionStart");
    tmux("send-keys", "-t", "contract", "say hi", "Enter");
    await until(activity, (value) => value?.event === "Stop" && value.state === "idle");

    // Background shells keep the session working until Claude Code reports back.
    tmux("send-keys", "-t", "contract", "BGRUN now", "Enter");
    const background = await until(activity, (value) => value?.background > 0);
    assert.equal(background.state, "working");
    await until(activity, (value) => value?.state === "idle" && value.at > background.at);

    // Esc sends no Stop: the turn's report stays "working" for the terminal to end.
    tmux("send-keys", "-t", "contract", "SLOW reply", "Enter");
    const started = await until(
      activity,
      (value) => value?.event === "UserPromptSubmit" && value.state === "working",
    );
    await new Promise((resolve) => setTimeout(resolve, 2000));
    tmux("send-keys", "-t", "contract", "Escape");
    await new Promise((resolve) => setTimeout(resolve, 3000));
    assert.equal(activity().at, started.at);

    tmux("send-keys", "-t", "contract", "C-u");
    tmux("send-keys", "-t", "contract", "/exit");
    await new Promise((resolve) => setTimeout(resolve, 800));
    tmux("send-keys", "-t", "contract", "Enter");
    await until(activity, (value) => value?.state === "ended");
  },
);
