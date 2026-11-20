import test from "node:test";
import assert from "node:assert/strict";
import { Bridge, register } from "../../server/features/claude-mod/bridge-mod.js";
import { claudeModEvents } from "../../server/features/claude-mod/claude-mod-events.js";
import { ClaudeModCommands } from "../../server/features/claude-mod/claude-mod-commands.js";
import { claudeTaskDriver } from "../../server/features/claude-mod/claude-task-driver.js";
import { fakeModRuntime } from "../helpers/fake-mod-runtime.js";

const env = {
  AGENTPIER_CLAUDE_BRIDGE_SOCKET: "/tmp/agentpier-requests-1-x/claude-mod.sock",
  AGENTPIER_REQUEST_FILE: "/data/requests/session-1.launch.json",
  AGENTPIER_REQUEST_TOKEN: "a".repeat(64),
};
const stopped = (id, type) => ({
  result: {
    message: `Successfully stopped task: ${id} (sleep 300)`,
    task_id: id,
    task_type: type,
    command: "sleep 300",
  },
  text: "{}",
});
const notification = (id) => ({
  origin: { kind: "task-notification" },
  text: `<task-notification>\n<task-id>${id}</task-id>`,
});
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
};

/** A bridge over a fake io: held polls, recorded tool calls, manual timers. */
function bridgeWith({ call, poll = () => new Promise(() => {}) } = {}) {
  const calls = [];
  const posts = [];
  const polls = [];
  const timers = [];
  const bridge = new Bridge().use({
    env: async () => [
      env.AGENTPIER_CLAUDE_BRIDGE_SOCKET,
      env.AGENTPIER_REQUEST_FILE,
      env.AGENTPIER_REQUEST_TOKEN,
    ],
    after: (ms, fn) => timers.push({ ms, fn }),
    fetch: async (url, init) => {
      if (init.method === "GET") {
        polls.push({ url, ...init });
        return poll();
      }
      posts.push(JSON.parse(init.body));
      return { status: 200, ok: true, headers: {}, text: "{}" };
    },
    call: async (input) => {
      calls.push(input);
      return call ? call(input) : stopped(input.task_id, "local_agent");
    },
  });
  const events = () => posts.flatMap((body) => body.events);
  return { bridge, calls, posts, polls, timers, events };
}

test("the mod runs a stop once per command id and reports its result", async () => {
  const { bridge, calls, events, timers } = bridgeWith();
  await bridge.runCommand({ id: "c1", name: "task.stop", taskId: "ad8fe347eb34a68b1" });
  await bridge.runCommand({ id: "c1", name: "task.stop", taskId: "ad8fe347eb34a68b1" });
  assert.deepEqual(calls, [{ tool: "TaskStop", task_id: "ad8fe347eb34a68b1" }]);
  for (const timer of timers.splice(0)) timer.fn();
  await settle();
  assert.deepEqual(
    events().filter((event) => event.type === "command.result"),
    [{ type: "command.result", id: "c1", ok: true, taskType: "local_agent" }],
  );
  assert.equal(
    bridge.dropReason({
      origin: { kind: "task-notification" },
      text: "<task-notification>\n<task-id>ad8fe347eb34a68b1</task-id>",
    }),
    "Stopped in AgentPier",
  );
  assert.equal(
    bridge.dropReason({
      origin: { kind: "task-notification" },
      text: "<task-notification>\n<task-id>aea912a2b4b704f01</task-id>",
    }),
    undefined,
  );
  // A notification that reports the agent finished on its own still enters.
  assert.equal(
    bridge.dropReason({
      origin: { kind: "task-notification" },
      text: "<task-notification>\n<task-id>ad8fe347eb34a68b1</task-id>\n<status>completed</status>",
    }),
    undefined,
  );
  // The same text typed at the composer is the person's, never dropped.
  assert.equal(
    bridge.dropReason({
      ...notification("ad8fe347eb34a68b1"),
      origin: { kind: "composer" },
    }),
    undefined,
  );
});

test("a task the CLI no longer knows is reported gone, other errors with their reason", async () => {
  const { bridge } = bridgeWith({
    call: ({ task_id }) =>
      task_id === "b4qyjbxhd"
        ? {
            result: "Error: No task found with ID: b4qyjbxhd",
            text: "<tool_use_error>No task found with ID: b4qyjbxhd</tool_use_error>",
            isError: true,
          }
        : task_id === "b315qta8x"
          ? {
              // Claude Code 2.1.326 for a shell that completed a moment ago.
              result: "Error: Task b315qta8x is not running (status: completed)",
              text: "",
              isError: true,
            }
          : task_id === "bthrows"
            ? Promise.reject(Error("Tool call aborted"))
            : { result: "Error: " + "x".repeat(900), text: "", isError: true },
  });
  assert.deepEqual(
    await bridge.runCommand({ id: "c2", name: "task.stop", taskId: "b4qyjbxhd" }),
    { ok: false, gone: true },
  );
  assert.deepEqual(
    await bridge.runCommand({ id: "c2b", name: "task.stop", taskId: "b315qta8x" }),
    { ok: false, gone: true },
  );
  const refused = await bridge.runCommand({ id: "c3", name: "task.stop", taskId: "bx" });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason.length, 500);
  assert.deepEqual(
    await bridge.runCommand({ id: "c4", name: "task.stop", taskId: "bthrows" }),
    { ok: false, reason: "Tool call aborted" },
  );
  assert.deepEqual(await bridge.runCommand({ id: "c5", name: "other" }), {
    ok: false,
    reason: "Unknown command",
  });
});

test("a stopped shell's id is never dropped", async () => {
  const { bridge } = bridgeWith({
    call: ({ task_id }) => stopped(task_id, "local_bash"),
  });
  const result = await bridge.runCommand({
    id: "c6",
    name: "task.stop",
    taskId: "b4qyjbxhd",
  });
  assert.deepEqual(result, { ok: true, taskType: "local_bash" });
  assert.equal(bridge.dropReason(notification("b4qyjbxhd")), undefined);
});

test("a fresh copy drops what the poll's suppress list names and runs its commands", async () => {
  let answers = [
    {
      status: 200,
      ok: true,
      headers: {},
      text: JSON.stringify({
        commands: [{ id: "c7", name: "task.stop", taskId: "ae70c6020167ba525" }],
        suppress: ["ae70c6020167ba525"],
      }),
    },
  ];
  const { bridge, calls, polls } = bridgeWith({
    poll: () => answers.shift() || new Promise(() => {}),
  });
  await settle();
  assert.equal(polls.length, 2, "the next poll follows at once");
  assert.equal(polls[0].url, "http://agentpier/claude-mod/v1/commands");
  assert.equal(polls[0].socketPath, env.AGENTPIER_CLAUDE_BRIDGE_SOCKET);
  assert.equal(polls[0].headers["x-agentpier-session"], "session-1");
  assert.equal(polls[0].headers.authorization, `Bearer ${env.AGENTPIER_REQUEST_TOKEN}`);
  assert.deepEqual(calls, [{ tool: "TaskStop", task_id: "ae70c6020167ba525" }]);
  assert.equal(
    bridge.dropReason(notification("ae70c6020167ba525")),
    "Stopped in AgentPier",
  );
  answers = [];
});

test("a refused poll stops polling; a failing one backs off like the flush", async () => {
  const gone = bridgeWith({ poll: async () => ({ status: 404, ok: false, text: "" }) });
  await settle();
  assert.equal(gone.polls.length, 1);
  assert.equal(gone.timers.length, 0);
  const failing = bridgeWith({ poll: async () => Promise.reject(Error("ECONNREFUSED")) });
  await settle();
  assert.equal(failing.polls.length, 1);
  assert.deepEqual(
    failing.timers.map((timer) => timer.ms),
    [200],
  );
  failing.timers.shift().fn();
  await settle();
  assert.deepEqual(
    failing.timers.map((timer) => timer.ms),
    [400],
  );
});

test("the prompt hook drops a stopped agent's notification and passes the rest", async () => {
  const runtime = fakeModRuntime({
    env,
    toolCall: async ({ task_id }) => stopped(task_id, "local_agent"),
  });
  register(runtime.on);
  await runtime.dispatch("session.start", {});
  await runtime.settle();
  const entered = [];
  const bottom = async (input) => {
    entered.push(input.text);
    return {};
  };
  assert.deepEqual(
    await runtime.dispatch("prompt.submit", notification("a1"), bottom),
    {},
  );
  assert.deepEqual(entered, [notification("a1").text]);
  assert.equal(runtime.polls.length, 1, "the mod keeps a command poll open");
});

test("command results are validated before the bridge reads them", () => {
  assert.deepEqual(
    claudeModEvents({
      protocol: 1,
      events: [
        { type: "command.result", id: "c1", ok: true, taskType: "local_agent" },
        { type: "command.result", id: "c2", ok: false, gone: true },
        { type: "command.result", id: "c3", ok: false, reason: "no" },
      ],
    }),
    [
      { type: "command.result", id: "c1", ok: true, taskType: "local_agent" },
      { type: "command.result", id: "c2", ok: false, gone: true },
      { type: "command.result", id: "c3", ok: false, reason: "no" },
    ],
  );
  for (const bad of [
    { id: "c1" },
    { id: "../x", ok: true },
    { id: "c1", ok: false, reason: "x".repeat(501) },
    { id: "c1", ok: true, taskType: "remote_agent" },
    { id: "c1", ok: false, gone: "yes" },
  ])
    assert.throws(() =>
      claudeModEvents({ protocol: 1, events: [{ type: "command.result", ...bad }] }),
    );
});

test("the driver needs a connected channel and a known Claude Code version", async () => {
  const commands = new ClaudeModCommands({ holdMs: 25000 });
  let cli = "2.1.329";
  const driver = claudeTaskDriver({ commands, mod: { cli: () => cli } });
  const session = { id: "s", tool: "claude", status: "running" };
  assert.equal(driver.connected(session), false);
  commands.poll({ id: "s" }, new Promise(() => {}), "i1");
  assert.equal(driver.connected(session), true);
  cli = undefined;
  assert.equal(driver.connected(session), false, "no hello for this launch");
  assert.equal(driver.canStop(session, { kind: "shell", id: "b1" }), true);
  assert.equal(driver.canStop(session, { kind: "agent", id: "a1" }), true);
  commands.forget("s");
});

test("an agent stop asks for its notification to be suppressed, a shell stop does not", async () => {
  const commands = new ClaudeModCommands({ holdMs: 25000 });
  const driver = claudeTaskDriver({ commands, mod: { cli: () => "2.1.325" } });
  const session = { id: "s", tool: "claude", status: "running" };
  const first = commands.poll({ id: "s" }, new Promise(() => {}), "i1");
  const agent = driver.stop(session, { kind: "agent", id: "a1", entry: {} });
  const answer = await first;
  assert.deepEqual(answer.suppress, ["a1"]);
  assert.equal(answer.commands[0].taskId, "a1");
  // Within the grace after the answered poll; the same copy never gets a1 again.
  const shell = driver.stop(session, { kind: "shell", id: "b1", entry: {} });
  const second = await commands.poll({ id: "s" }, new Promise(() => {}), "i1");
  const [shellCommand] = second.commands;
  assert.equal(second.commands.length, 1);
  assert.equal(shellCommand.taskId, "b1");
  assert.deepEqual(commands.suppressed("s"), ["a1"]);
  commands.poll({ id: "s" }, new Promise(() => {}), "i1");
  commands.result("s", { id: answer.commands[0].id, ok: true });
  commands.result("s", { id: shellCommand.id, ok: false, reason: "busy" });
  assert.deepEqual(await agent, { ok: true });
  assert.deepEqual(await shell, { ok: false, reason: "busy" });
  // A stop that went through keeps its agent's notification suppressed.
  assert.deepEqual(commands.suppressed("s"), ["a1"]);
  commands.forget("s");
});

test("an agent stop that never happened leaves no suppress entry behind", async () => {
  const commands = new ClaudeModCommands({ holdMs: 25000 });
  const driver = claudeTaskDriver({ commands, mod: { cli: () => "2.1.325" } });
  const session = { id: "s", tool: "claude", status: "running" };
  // No mod polls: the channel is down.
  await assert.rejects(driver.stop(session, { kind: "agent", id: "a1", entry: {} }), {
    code: "TASK_STOP_CHANNEL_DOWN",
  });
  assert.deepEqual(commands.suppressed("s"), []);
  // The mod never answers.
  commands.poll({ id: "s" }, new Promise(() => {}), "i1");
  commands.suppress("s", "a2");
  await assert.rejects(
    commands.send("s", { name: "task.stop", taskId: "a2" }, { timeoutMs: 20 }),
    { code: "TASK_STOP_TIMEOUT" },
  );
  assert.deepEqual(commands.suppressed("s"), []);
  // The mod refused.
  const open = commands.poll({ id: "s" }, new Promise(() => {}), "i1");
  commands.suppress("s", "a3");
  const refused = commands.send("s", { name: "task.stop", taskId: "a3" });
  commands.result("s", { id: (await open).commands[0].id, ok: false, reason: "no" });
  await refused;
  assert.deepEqual(commands.suppressed("s"), []);
  commands.forget("s");
});

test("a late success, after the stop service gave up waiting, keeps the suppress entry", async () => {
  const commands = new ClaudeModCommands({ holdMs: 25000 });
  const open = commands.poll({ id: "s" }, new Promise(() => {}), "i1");
  commands.suppress("s", "a1");
  const sent = commands.send(
    "s",
    { name: "task.stop", taskId: "a1" },
    { timeoutMs: 500 },
  );
  const [command] = (await open).commands;
  await new Promise((resolve) => setTimeout(resolve, 50));
  commands.result("s", { id: command.id, ok: true });
  assert.deepEqual(await sent, { ok: true });
  assert.deepEqual(commands.suppressed("s"), ["a1"]);
  commands.forget("s");
});

test("a command's id is always the generated one", async () => {
  const commands = new ClaudeModCommands({ holdMs: 25000 });
  const open = commands.poll({ id: "s" }, new Promise(() => {}), "i1");
  commands.send("s", { id: "chosen", name: "task.stop", taskId: "b1" }).catch(() => {});
  const [command] = (await open).commands;
  assert.notEqual(command.id, "chosen");
  assert.match(command.id, /^[0-9a-f-]{36}$/);
  commands.forget("s");
});

test("one prompt with two task notifications is never dropped for one of them", async () => {
  const { bridge } = bridgeWith();
  await bridge.runCommand({ id: "c9", name: "task.stop", taskId: "ae70c6020167ba525" });
  const both = {
    origin: { kind: "task-notification" },
    text:
      "<task-notification>\n<task-id>ae70c6020167ba525</task-id>\n</task-notification>\n" +
      "<task-notification>\n<task-id>aea912a2b4b704f01</task-id>\n</task-notification>",
  };
  assert.equal(bridge.dropReason(both), undefined);
});

test("each mod copy names itself on its polls; a replaced copy stops polling", async () => {
  const one = bridgeWith();
  const two = bridgeWith();
  await settle();
  const id = (copy) => copy.polls[0].headers["x-agentpier-instance"];
  assert.match(id(one), /^[A-Za-z0-9_-]{8,64}$/);
  assert.notEqual(id(one), id(two));
  const replaced = bridgeWith({
    poll: async () => ({
      status: 200,
      ok: true,
      headers: {},
      text: JSON.stringify({ commands: [], suppress: [], superseded: true }),
    }),
  });
  await settle();
  assert.equal(replaced.polls.length, 1);
  assert.equal(replaced.timers.length, 0);
});

test("every poll names the Claude Code version, also from a reloaded copy", async () => {
  const pollVersion = (runtime) =>
    runtime.polls.map((request) => request.headers["x-agentpier-cli"]);
  const runtime = fakeModRuntime({ env, version: "2.1.325" });
  register(runtime.on);
  await runtime.dispatch("session.start", { cwd: "/p", isInteractive: true });
  await runtime.settle();
  assert.deepEqual(pollVersion(runtime), ["2.1.325"]);
  // A copy the engine loaded mid-session hears no session.start.
  const reloaded = fakeModRuntime({ env, version: "2.1.326" });
  register(reloaded.on);
  await reloaded.dispatch("turn.start", { turnId: "t1" });
  await reloaded.settle();
  assert.deepEqual(pollVersion(reloaded), ["2.1.326"]);
  // A version that does not look like one is left out, the poll still goes.
  const odd = fakeModRuntime({ env, version: "2.1.325\nx" });
  register(odd.on);
  await odd.dispatch("session.start", { cwd: "/p", isInteractive: true });
  await odd.settle();
  assert.deepEqual(pollVersion(odd), [undefined]);
});

test("a poll's version connects the driver after a restart that heard no hello", () => {
  const commands = new ClaudeModCommands({ holdMs: 25000 });
  const driver = claudeTaskDriver({ commands, mod: { cli: () => undefined } });
  const session = { id: "s", tool: "claude", status: "running" };
  commands.poll({ id: "s" }, new Promise(() => {}), "i1");
  assert.equal(driver.connected(session), false, "no version yet");
  commands.poll({ id: "s" }, new Promise(() => {}), "i1", "2.1.329");
  assert.equal(commands.cli("s"), "2.1.329");
  assert.equal(driver.connected(session), true);
  commands.poll({ id: "s" }, new Promise(() => {}), "i1");
  assert.equal(driver.connected(session), true, "a poll without one keeps it");
  commands.forget("s");
  assert.equal(commands.cli("s"), undefined);
});

test("suppressed ids live ten minutes, at most 64", () => {
  let now = 0;
  const commands = new ClaudeModCommands({ holdMs: 25000, now: () => now });
  for (let i = 0; i < 70; i++) commands.suppress("s", `a${i}`);
  assert.deepEqual(commands.suppressed("s").length, 64);
  assert.equal(commands.suppressed("s")[0], "a6");
  now = 10 * 60 * 1000 + 1;
  commands.suppress("s", "fresh");
  assert.deepEqual(commands.suppressed("s"), ["fresh"]);
});

const held = () => new Promise(() => {});
const pending = (promise) =>
  Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve("held"), 20)),
  ]);

test("an older mod copy that polls after a newer one is turned away, not the newer one", async () => {
  const commands = new ClaudeModCommands({ holdMs: 25000 });
  const owner = { id: "s" };
  // Copy A polls first, then the reload's copy B takes the channel.
  const a = commands.poll(owner, held(), "copy-a");
  const b = commands.poll(owner, held(), "copy-b");
  assert.deepEqual(await a, { commands: [], suppress: [], superseded: true });
  // A comes back from a backoff and polls again: it is answered superseded at once,
  // and B's poll stays open.
  assert.deepEqual(await commands.poll(owner, held(), "copy-a"), {
    commands: [],
    suppress: [],
    superseded: true,
  });
  assert.equal(await pending(b), "held");
  commands.send("s", { name: "task.stop", taskId: "b1" }).catch(() => {});
  const answer = await b;
  assert.equal(answer.commands[0].taskId, "b1");
  assert.equal(answer.superseded, undefined);
  commands.forget("s");
});

test("the same copy polling again replaces its own poll without superseding itself", async () => {
  const commands = new ClaudeModCommands({ holdMs: 25000 });
  const owner = { id: "s" };
  const first = commands.poll(owner, held(), "copy-a");
  const second = commands.poll(owner, held(), "copy-a");
  assert.deepEqual(await first, { commands: [], suppress: [] });
  assert.equal(await pending(second), "held");
  commands.forget("s");
});

test("the record of mod copies per session is bounded at 16", async () => {
  const commands = new ClaudeModCommands({ holdMs: 25000 });
  const owner = { id: "s" };
  for (let i = 0; i < 40; i++) commands.poll(owner, held(), `copy-${i}`);
  assert.equal(commands.sessions.get("s").seen.size, 16);
  // The newest copy keeps the channel; an older one still known is turned away.
  assert.deepEqual(await commands.poll(owner, held(), "copy-30"), {
    commands: [],
    suppress: [],
    superseded: true,
  });
  commands.forget("s");
});
