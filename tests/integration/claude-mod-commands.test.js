import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { RequestBroker } from "../../server/features/requests/request-broker.js";
import { ClaudeModBridge } from "../../server/features/claude-mod/claude-mod-bridge.js";
import { ClaudeModCommands } from "../../server/features/claude-mod/claude-mod-commands.js";
import { claudeTaskDriver } from "../../server/features/claude-mod/claude-task-driver.js";
import { CLAUDE_TASK_STOP_VERSION } from "../../server/features/claude-mod/claude-mod-launch.js";
import { TaskControl } from "../../server/features/chat/task-control.js";
import { TaskStopStore } from "../../server/features/chat/task-stop-store.js";
import { setTimeout as delay } from "node:timers/promises";
import { fakeModRuntime } from "../helpers/fake-mod-runtime.js";
import { until } from "../helpers/adapter-process.js";

// `$.http.fetch` with `socketPath`, as Claude Code's host performs it.
function unixFetch({ url, socketPath, method, headers, body }) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { socketPath, path: new URL(url).pathname, method, headers },
      (response) => {
        let text = "";
        response.on("data", (chunk) => (text += chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            ok: response.statusCode < 300,
            headers: response.headers,
            text,
            json: async () => JSON.parse(text),
          }),
        );
      },
    );
    request.on("error", reject);
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

const noStreams = { streamText: () => true, endStream: () => {}, setStatus: () => {} };

async function setup(t, { holdMs = 30, graceMs = 200 } = {}) {
  const dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "claude-cmd-")));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const session = { id: "s", accountId: "account", tool: "claude", status: "running" };
  const changes = [];
  const commands = new ClaudeModCommands({
    holdMs,
    graceMs,
    onChange: (id) => changes.push(id),
  });
  t.after(() => commands.forget("s"));
  const mod = new ClaudeModBridge({ streams: noStreams });
  mod.commands = commands;
  const broker = new RequestBroker({
    dataDir,
    sessions: { get: async () => ({ ...session }) },
    modCommands: commands,
    onNative: (id, push) => {
      if (push.type === "claude-mod")
        return mod.receive(id, push.events, { prompts: push.prompts });
    },
    onLaunch: (id) => mod.forget(id),
  });
  t.after(() => broker.close());
  const launch = await broker.prepare({
    id: "s",
    account: { id: "account", tool: "claude" },
    cwd: dataDir,
    launch: { command: "/fixture/claude", args: [], env: {}, cliVersion: "2.1.325" },
  });
  const headers = (token = launch.env.AGENTPIER_REQUEST_TOKEN) => ({
    "x-agentpier-session": "s",
    authorization: `Bearer ${token}`,
  });
  // `instance` stands for one loaded copy of the mod (its x-agentpier-instance).
  const poll = ({ token, instance = "i1", cli } = {}) =>
    unixFetch({
      url: "http://agentpier/claude-mod/v1/commands",
      socketPath: broker.modSocketPath,
      method: "GET",
      headers: {
        ...headers(token),
        ...(instance ? { "x-agentpier-instance": instance } : {}),
        ...(cli === undefined ? {} : { "x-agentpier-cli": cli }),
      },
    });
  const postEvents = (events) =>
    unixFetch({
      url: "http://agentpier/claude-mod/v1/events",
      socketPath: broker.modSocketPath,
      method: "POST",
      headers: headers(),
      body: { protocol: 1, prompts: true, events },
    });
  return { broker, launch, mod, commands, changes, poll, postEvents, session };
}

test("the command long-poll hands a stop to the mod and redelivers it after a reload", async (t) => {
  const { commands, poll, postEvents } = await setup(t);
  assert.equal((await poll({ token: "0".repeat(64) })).status, 401);
  const open = poll();
  // Beside an open poll the event posts still go through.
  assert.equal((await postEvents([{ type: "hello", cli: "2.1.325" }])).status, 200);
  assert.deepEqual(await (await open).json(), { commands: [], suppress: [] });
  const first = poll();
  await until(() => commands.connected("s"), 2000);
  const sent = commands.send("s", { name: "task.stop", taskId: "ad8fe347eb34a68b1" });
  const {
    commands: [cmd],
  } = await (await first).json();
  assert.equal(cmd.name, "task.stop");
  assert.equal(cmd.taskId, "ad8fe347eb34a68b1");
  // The same copy polls again before its result is posted: it never gets the
  // command twice, the poll is held as usual.
  assert.deepEqual(await (await poll()).json(), { commands: [], suppress: [] });
  // Reload mid long-poll: no result arrives, the new copy gets the same command.
  assert.equal((await (await poll({ instance: "i2" })).json()).commands[0].id, cmd.id);
  // The reloaded copy finds the task gone: it was stopped by the first delivery.
  commands.result("s", { id: cmd.id, ok: false, gone: true });
  assert.deepEqual(await sent, { ok: true });
  // A poll that names no mod copy is refused.
  assert.equal((await poll({ instance: "" })).status, 400);
  await assert.rejects(new ClaudeModCommands({}).send("none", {}), {
    code: "TASK_STOP_CHANNEL_DOWN",
  });
});

test("a result posted as a mod event settles the command; a newer poll answers the older one", async (t) => {
  const { commands, poll, postEvents } = await setup(t, { holdMs: 5000 });
  const older = poll();
  await until(() => commands.connected("s"), 2000);
  const newer = poll();
  assert.deepEqual(await (await older).json(), { commands: [], suppress: [] });
  commands.suppress("s", "ae70c6020167ba525");
  const sent = commands.send("s", { name: "task.stop", taskId: "ae70c6020167ba525" });
  const answer = await (await newer).json();
  assert.deepEqual(answer.suppress, ["ae70c6020167ba525"]);
  const [cmd] = answer.commands;
  const posted = await postEvents([
    { type: "command.result", id: cmd.id, ok: true, taskType: "local_agent" },
  ]);
  assert.equal(posted.status, 200);
  assert.deepEqual(await sent, { ok: true });
  // A refusal carries the CLI's reason; a single delivery that finds no task is gone.
  const pollAgain = poll();
  await until(() => commands.connected("s"), 2000);
  const refused = commands.send("s", { name: "task.stop", taskId: "b4qyjbxhd" });
  const [second] = (await (await pollAgain).json()).commands;
  await postEvents([{ type: "command.result", id: second.id, ok: false, gone: true }]);
  assert.deepEqual(await refused, { ok: false, gone: true });
  // Malformed results refuse the batch.
  const bad = await postEvents([{ type: "command.result", id: "x", ok: "yes" }]);
  assert.equal(bad.status, 400);
});

test("the channel counts as connected while a poll is open and shortly after", async (t) => {
  const { commands, changes, poll } = await setup(t, { holdMs: 30, graceMs: 300 });
  assert.equal(commands.connected("s"), false);
  await poll();
  assert.equal(commands.connected("s"), true, "within the grace after a poll");
  assert.deepEqual(changes, ["s"]);
  await until(() => !commands.connected("s"), 2000);
  await until(() => changes.length === 2, 2000);
  await assert.rejects(commands.send("s", { name: "task.stop", taskId: "b1" }), {
    code: "TASK_STOP_CHANNEL_DOWN",
  });
});

test("the real mod stops a task through TaskStop and AgentPier drops its notification", async (t) => {
  const { launch, mod, commands } = await setup(t, { holdMs: 5000 });
  const calls = [];
  const runtime = fakeModRuntime({
    env: launch.env,
    fetch: unixFetch,
    poll: unixFetch,
    version: "2.1.325",
    toolCall: async (input) => {
      calls.push(input);
      return {
        result: {
          message: `Successfully stopped task: ${input.task_id} (beta)`,
          task_id: input.task_id,
          task_type: "local_agent",
          command: "beta",
        },
        text: "{}",
      };
    },
  });
  const directory = launch.args.find((arg) => arg.endsWith(".claude-bridge"));
  const { register } = await import(path.join(directory, "hooks/register.js"));
  register(runtime.on);
  await runtime.dispatch("session.start", {});
  await runtime.tick();
  await until(() => mod.cli("s") === "2.1.325" && commands.connected("s"), 2000);
  const driver = claudeTaskDriver({ commands, mod });
  const session = { id: "s", tool: "claude", status: "running" };
  assert.equal(driver.connected(session), true);
  const stopping = driver.stop(session, {
    kind: "agent",
    id: "ae70c6020167ba525",
    entry: { id: "ae70c6020167ba525", status: "running" },
  });
  // The mod reports its result on the next flush.
  await until(async () => {
    await runtime.tick();
    return calls.length === 1;
  }, 2000);
  let settled = null;
  stopping.then((value) => (settled = value));
  await until(async () => {
    await runtime.tick();
    return settled;
  }, 2000);
  assert.deepEqual(settled, { ok: true });
  assert.deepEqual(calls, [{ tool: "TaskStop", task_id: "ae70c6020167ba525" }]);
  const notification = {
    origin: { kind: "task-notification" },
    text: "<task-notification>\n<task-id>ae70c6020167ba525</task-id>\n<status>killed</status>",
  };
  const next = async () => assert.fail("a dropped notification never enters");
  assert.deepEqual(await runtime.dispatch("prompt.submit", notification, next), {
    drop: "Stopped in AgentPier",
  });
  assert.equal(CLAUDE_TASK_STOP_VERSION, "2.1.325");
});

const SHELL = "b4qyjbxhd";
const noTask = (id) => ({
  result: `Error: No task found with ID: ${id}`,
  text: `<tool_use_error>No task found with ID: ${id}</tool_use_error>`,
  isError: true,
});

/** A loaded copy of the real mod module on the broker's socket, hello sent. */
async function loadMod({ launch, mod, commands }, { toolCall }) {
  const runtime = fakeModRuntime({
    env: launch.env,
    fetch: unixFetch,
    poll: unixFetch,
    version: "2.1.325",
    toolCall,
  });
  const directory = launch.args.find((arg) => arg.endsWith(".claude-bridge"));
  const { register } = await import(path.join(directory, "hooks/register.js"));
  register(runtime.on);
  await runtime.dispatch("session.start", {});
  await runtime.tick();
  await until(() => mod.cli("s") === "2.1.325" && commands.connected("s"), 2000);
  return runtime;
}

/** The stop service over a snapshot that lists one running shell. */
function stopService(t, { commands, mod }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-cmd-stops-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const shell = { id: SHELL, command: "sleep 5", status: "running" };
  const snapshot = { observability: { stale: false, subagents: [], shells: [shell] } };
  const control = new TaskControl({
    sessions: { get: async () => ({ id: "s", tool: "claude", status: "running" }) },
    chat: { read: async () => snapshot },
    reads: { flags: () => ({}) },
    stops: new TaskStopStore({ dataDir }),
    timeoutMs: 5000,
  });
  control.register("claude", claudeTaskDriver({ commands, mod }));
  return control;
}

/** Run the copies' timers (their flushes) until `promise` settles. */
async function ticking(runtimes, promise) {
  let done = false;
  const settled = promise.finally(() => (done = true));
  settled.catch(() => {});
  for (let i = 0; i < 400 && !done; i++) {
    for (const runtime of runtimes) await runtime.tick();
    await delay(5);
  }
  return settled;
}

test("a task that ended by itself is not reported stopped, though the mod polls again first", async (t) => {
  const ctx = await setup(t, { holdMs: 5000 });
  const runtime = await loadMod(ctx, {
    toolCall: async ({ task_id }) => {
      await delay(20);
      return noTask(task_id);
    },
  });
  const control = stopService(t, ctx);
  await assert.rejects(ticking([runtime], control.stop("s", SHELL)), {
    code: "TASK_STOP_NOT_RUNNING",
  });
  assert.ok(runtime.polls.length >= 2, "the copy polled again before its result");
  assert.equal(
    control.overlay(
      { id: "s", tool: "claude", status: "running" },
      {
        observability: { shells: [] },
      },
    ).observability.stopNotes.length,
    0,
    "no note",
  );
});

test("a reloaded copy gets a pending stop again; its 'gone' then counts as stopped", async (t) => {
  const ctx = await setup(t, { holdMs: 5000 });
  const firstCalls = [];
  // The first copy stops the shell but is replaced before it posts the result.
  const first = await loadMod(ctx, {
    toolCall: async ({ task_id }) => {
      firstCalls.push(task_id);
      return {
        result: { message: "Successfully stopped", task_id, task_type: "local_bash" },
        text: "{}",
      };
    },
  });
  const control = stopService(t, ctx);
  const stopping = control.stop("s", SHELL);
  stopping.catch(() => {});
  await until(() => firstCalls.length === 1, 2000);
  const second = await loadMod(ctx, { toolCall: async ({ task_id }) => noTask(task_id) });
  assert.deepEqual(await ticking([second], stopping), { stopped: true });
  // The replaced copy stops polling instead of competing with the new one.
  const polls = first.polls.length;
  await delay(50);
  assert.equal(first.polls.length, polls);
  assert.equal(second.polls.length >= 2, true);
});

test("a restarted server learns the Claude Code version from the next poll, not a hello", async (t) => {
  const { commands, mod, poll } = await setup(t, { holdMs: 30 });
  const driver = claudeTaskDriver({ commands, mod });
  const session = { id: "s", tool: "claude", status: "running" };
  for (const odd of ["2.1.325; x", "v2.1.325", `2.1.${"9".repeat(70)}`, ""]) {
    assert.equal((await poll({ cli: odd })).status, 200, "an odd version never refuses");
    assert.equal(commands.cli("s"), undefined, JSON.stringify(odd));
  }
  assert.equal(driver.connected(session), false);
  await poll({ cli: "2.1.324" });
  assert.equal(driver.connected(session), false, "too old");
  await poll({ cli: CLAUDE_TASK_STOP_VERSION });
  assert.equal(mod.cli("s"), undefined, "no hello was heard");
  assert.equal(driver.connected(session), true);
});

test("a copy the server has not seen gets the suppress list at once", async (t) => {
  const { commands, poll } = await setup(t, { holdMs: 5000 });
  commands.suppress("s", "ae70c6020167ba525");
  const started = Date.now();
  assert.deepEqual(await (await poll({ instance: "fresh" })).json(), {
    commands: [],
    suppress: ["ae70c6020167ba525"],
  });
  assert.ok(Date.now() - started < 2000);
  // Known from now on: its next poll is held as usual.
  const again = poll({ instance: "fresh" });
  assert.equal(await Promise.race([again.then(() => "answered"), delay(200)]), undefined);
});
