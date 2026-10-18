import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { once } from "node:events";
import WebSocket from "ws";
import { NativeSessionBinding } from "../../server/features/sessions/native-session-binding.js";
import { recordNativeActivity } from "../../server/features/sessions/native-session-activity.js";
import { SessionActivity } from "../../server/features/sessions/session-activity.js";
import { AccountStore } from "../../server/features/accounts/account-store.js";
import { serverMessages } from "../../server/lib/i18n/de.js";
import { createCodexProxy } from "../../server/features/requests/codex-proxy.js";

const run = promisify(execFile);
const hookScript = fileURLToPath(
  new URL("../../server/features/sessions/native-session-binding.js", import.meta.url),
);
function setup(t) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-activity-")),
  );
  const cwd = path.join(root, "project");
  fs.mkdirSync(cwd);
  const accounts = new AccountStore({ dataDir: path.join(root, "data"), home: root });
  const bindings = new NativeSessionBinding({ dataDir: accounts.dataDir, accounts });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, cwd, accounts, bindings };
}
async function launch(ctx, id, tool, replace = false) {
  const account = ctx.accounts.create({ name: id, tool });
  const prepared = await ctx.bindings.prepare({
    id,
    account,
    cwd: ctx.cwd,
    replace,
    launch: {
      command: process.execPath,
      args: [],
      env: ctx.accounts.environment(account.id),
    },
  });
  const session = {
    id,
    tool,
    accountId: account.id,
    cwd: ctx.cwd,
    status: "running",
    nativeBinding: prepared.nativeBinding,
  };
  return { account, prepared, session };
}
// Runs the hook exactly as Claude Code does: the command from hooks.json, payload on stdin.
async function hook(prepared, payload) {
  const child = run(process.execPath, [hookScript, "--record"], {
    env: {
      PATH: process.env.PATH,
      AGENTPIER_NATIVE_BINDING_FILE: prepared.env.AGENTPIER_NATIVE_BINDING_FILE,
      AGENTPIER_NATIVE_BINDING_TOKEN: prepared.env.AGENTPIER_NATIVE_BINDING_TOKEN,
    },
  });
  child.child.stdin.end(JSON.stringify(payload));
  return child;
}

test("Claude launches get async activity hooks in their own plugin", async (t) => {
  const ctx = setup(t);
  const { prepared } = await launch(ctx, "claude-hooks", "claude");
  const plugins = prepared.args.filter((_, i) => prepared.args[i - 1] === "--plugin-dir");
  const activity = plugins.find((dir) => dir.endsWith("claude-hooks.claude-activity"));
  assert.ok(activity, "activity plugin is passed to Claude Code");
  const { hooks } = JSON.parse(fs.readFileSync(path.join(activity, "hooks/hooks.json")));
  assert.deepEqual(Object.keys(hooks).sort(), [
    "Elicitation",
    "PermissionRequest",
    "PreToolUse",
    "SessionEnd",
    "Stop",
    "StopFailure",
  ]);
  assert.equal(hooks.PreToolUse[0].matcher, "AskUserQuestion");
  for (const [entry] of Object.values(hooks)) {
    assert.equal(entry.hooks[0].async, true);
    assert.match(entry.hooks[0].command, /native-session-binding\.js' '--record'$/);
  }
  // The identity plugin keeps its synchronous hooks and is unchanged otherwise.
  const reader = plugins.find((dir) => dir.endsWith("claude-hooks.claude"));
  assert.deepEqual(
    Object.keys(JSON.parse(fs.readFileSync(path.join(reader, "hooks/hooks.json"))).hooks),
    ["SessionStart", "UserPromptSubmit"],
  );
});

test("the hook records activity for the current launch only, and SessionActivity prefers it", async (t) => {
  const ctx = setup(t);
  const { prepared, session } = await launch(ctx, "claude-live", "claude");
  assert.equal(ctx.bindings.activity(session), null, "no report before the first hook");
  await hook(prepared, {
    hook_event_name: "Stop",
    session_id: "11111111-1111-4111-8111-111111111111",
    cwd: ctx.cwd,
    background_tasks: [{ id: "b1", type: "shell", status: "running" }],
  });
  const stopped = ctx.bindings.activity(session);
  assert.equal(stopped.state, "working");
  assert.equal(stopped.background, 1);
  assert.equal(stopped.event, "Stop");
  // An activity-only event never rebinds the conversation.
  assert.equal(
    fs.existsSync(
      prepared.env.AGENTPIER_NATIVE_BINDING_FILE.replace("launch", "receipt"),
    ),
    false,
  );
  // An async hook that finishes late cannot overwrite a newer report.
  assert.equal(
    recordNativeActivity(
      { state: "idle", event: "Stop", at: stopped.at - 1 },
      prepared.env,
    ),
    false,
  );
  assert.equal(ctx.bindings.activity(session).state, "working");
  assert.throws(() =>
    recordNativeActivity(
      { state: "idle", event: "Stop" },
      { ...prepared.env, AGENTPIER_NATIVE_BINDING_TOKEN: "forged" },
    ),
  );
  assert.throws(() =>
    recordNativeActivity({ state: "busy", event: "Stop" }, prepared.env),
  );

  let now = Date.now();
  const activity = new SessionActivity({
    sessions: {},
    screen: async () => "unrecognized narrow pane",
    hooks: (value) => ctx.bindings.activity(value),
    cacheMs: 0,
    now: () => now,
  });
  let read = await activity.read(session);
  assert.equal(read.state, "working");
  assert.equal(read.source, "hook");
  assert.equal(read.background, 1);
  await hook(prepared, { hook_event_name: "Stop", cwd: ctx.cwd, background_tasks: [] });
  read = await activity.read(session);
  assert.deepEqual(
    [read.state, read.source, read.label],
    ["idle", "hook", serverMessages.sessions.activityReady],
  );
  // A foreign or older launch's report is ignored; the terminal reading takes over.
  assert.equal(ctx.bindings.activity({ ...session, accountId: "other" }), null);
  assert.equal(ctx.bindings.activity({ ...session, nativeBinding: undefined }), null);
  const replaced = await launch(ctx, "claude-live", "claude", true);
  assert.equal(ctx.bindings.activity(replaced.session), null);
  read = await new SessionActivity({
    sessions: {},
    screen: async () => "unrecognized narrow pane",
    hooks: (value) => ctx.bindings.activity(value),
  }).read(replaced.session);
  assert.deepEqual([read.state, read.source], ["unknown", "native-terminal"]);
  await ctx.bindings.discard("claude-live");
  assert.equal(
    fs.existsSync(
      path.join(ctx.accounts.dataDir, "native-sessions/claude-live.claude-activity"),
    ),
    false,
  );
});

test("an interrupted Claude turn falls back to the still, idle terminal", async (t) => {
  const ctx = setup(t);
  const { prepared, session } = await launch(ctx, "claude-esc", "claude");
  await hook(prepared, {
    hook_event_name: "UserPromptSubmit",
    cwd: ctx.cwd,
    prompt: "x",
  });
  const at = ctx.bindings.activity(session).at;
  let now = at;
  const idleClaude = [
    "─".repeat(40),
    "❯ ",
    "─".repeat(40),
    "  ⏸ manual mode on · ? for shortcuts",
  ].join("\n");
  const activity = new SessionActivity({
    sessions: {},
    screen: async () => idleClaude,
    hooks: (value) => ctx.bindings.activity(value),
    cacheMs: 0,
    now: () => now,
  });
  assert.equal((await activity.read(session)).state, "working");
  now = at + 20_000;
  const read = await activity.read(session);
  assert.deepEqual([read.state, read.source], ["idle", "native-terminal"]);
});

test("AgentPier's pending request makes a reporting session wait", async (t) => {
  const ctx = setup(t);
  const { prepared, session } = await launch(ctx, "claude-ask", "claude");
  await hook(prepared, {
    hook_event_name: "UserPromptSubmit",
    cwd: ctx.cwd,
    prompt: "x",
  });
  const activity = new SessionActivity({
    sessions: {},
    screen: async () => "",
    hooks: (value) => ctx.bindings.activity(value),
    pending: (id) => id === session.id,
  });
  const read = await activity.read(session);
  assert.deepEqual([read.state, read.source], ["waiting", "request"]);
});

test("the Codex proxy reports turn events as the session's activity", async (t) => {
  const ctx = setup(t);
  const { prepared, session } = await launch(ctx, "codex-turns", "codex");
  const incoming = new PassThrough(),
    outgoing = new PassThrough();
  const proxy = await createCodexProxy({
    input: incoming,
    output: outgoing,
    channel: { publish() {}, resolve() {}, close() {} },
    onActivity: (update) => recordNativeActivity(update, prepared.env),
  });
  t.after(async () => {
    await proxy.close();
    incoming.destroy();
    outgoing.destroy();
  });
  const tui = new WebSocket(proxy.url, {
    headers: { Authorization: `Bearer ${proxy.authToken}` },
  });
  await once(tui, "open");
  t.after(() => tui.terminate());
  const frame = () => once(tui, "message");
  let next = frame();
  incoming.write(
    JSON.stringify({
      method: "turn/started",
      params: { threadId: "th", turn: { id: "t" } },
    }) + "\n",
  );
  await next;
  assert.equal(ctx.bindings.activity(session).state, "working");
  assert.equal(ctx.bindings.activity(session).event, "turn/started");
  next = frame();
  incoming.write(
    JSON.stringify({
      method: "turn/completed",
      params: { threadId: "th", turn: { id: "t", status: "interrupted" } },
    }) + "\n",
  );
  // The TUI still receives every notification unchanged.
  assert.match(String((await next)[0]), /turn\/completed/);
  assert.equal(ctx.bindings.activity(session).state, "idle");
});
