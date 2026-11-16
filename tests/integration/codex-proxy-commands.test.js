import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { createCodexProxy } from "../../server/features/requests/codex-proxy.js";
import { codexTaskCommands } from "../../server/features/requests/codex-tasks.js";
import { RequestBroker } from "../../server/features/requests/request-broker.js";
import { NativeRequestChannel } from "../../server/features/requests/native-channel.js";
import { NativeCommands } from "../../server/features/requests/native-commands.js";
import { CodexTaskState } from "../../server/features/chat/codex-task-state.js";
import { codexTaskDriver } from "../../server/features/chat/codex-task-driver.js";
import { TaskControl } from "../../server/features/chat/task-control.js";

const CHILD = "01a1e5fe-843e-7b51-b5e7-5877be215d50";
const MAIN = "01a1e601-e73d-7db3-83a1-76fabe8484b7";

async function until(predicate, ms = 2000) {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > end) throw Error("Timed out");
    await delay(5);
  }
}

/** A proxy between a PassThrough app-server and a ws TUI, as codex-request-proxy.test.js. */
async function fixture(t, given = {}) {
  const appServer = new PassThrough(),
    toAppServer = new PassThrough();
  const lines = [];
  toAppServer.on("data", (chunk) =>
    lines.push(...String(chunk).trim().split("\n").filter(Boolean)),
  );
  const prompts = [];
  const proxy = await createCodexProxy({
    input: appServer,
    output: toAppServer,
    // A real NativeRequestChannel, or a recording stand-in.
    channel: given.publish
      ? given
      : {
          publish() {},
          resolve() {},
          prompt: (event) => prompts.push(event),
          ...given,
        },
    replies: null,
  });
  const tui = new WebSocket(proxy.url, {
    headers: { Authorization: `Bearer ${proxy.authToken}` },
  });
  const tuiReceived = [];
  tui.on("message", (data) => tuiReceived.push(JSON.parse(String(data))));
  await once(tui, "open");
  t.after(async () => {
    tui.terminate();
    await proxy.close();
    appServer.destroy();
    toAppServer.destroy();
  });
  let read = 0;
  const nextAppServerLine = async () => {
    await until(() => lines.length > read);
    return lines[read++];
  };
  const fromApp = (message) => appServer.write(JSON.stringify(message) + "\n");
  const initialize = async (capabilities) => {
    tui.send(
      JSON.stringify({
        id: "initialize",
        method: "initialize",
        params: { capabilities },
      }),
    );
    const line = JSON.parse(await nextAppServerLine());
    assert.equal(line.method, "initialize");
  };
  return {
    proxy,
    tui,
    tuiReceived,
    prompts,
    nextAppServerLine,
    fromApp,
    appServer,
    initialize,
  };
}

test("a proxy request goes to the app-server and its response never reaches the TUI", async (t) => {
  const { proxy, tuiReceived, prompts, nextAppServerLine, appServer } = await fixture(t);
  const reply = proxy.request("turn/interrupt", { threadId: "t1", turnId: "u1" });
  const sent = JSON.parse(await nextAppServerLine());
  assert.match(sent.id, /^agentpier:\d+$/);
  assert.deepEqual(sent, {
    id: sent.id,
    method: "turn/interrupt",
    params: { threadId: "t1", turnId: "u1" },
  });
  appServer.write(JSON.stringify({ id: sent.id, result: {} }) + "\n");
  assert.deepEqual(await reply, {});
  // A notification after it still reaches the TUI, so the response was not just late.
  appServer.write(JSON.stringify({ method: "thread/status/changed", params: {} }) + "\n");
  await until(() => tuiReceived.length === 1);
  assert.equal(
    tuiReceived.some((m) => m.id === sent.id),
    false,
  );
  assert.deepEqual(
    prompts.filter((event) => event.type === "prompt"),
    [],
  );
  await assert.rejects(proxy.request("turn/start", {}), /not allowed/);
  await assert.rejects(proxy.request("thread/read", {}), /not allowed/);
});

test("only the three task methods are allowed, and an error answer rejects", async (t) => {
  const { proxy, nextAppServerLine, fromApp } = await fixture(t);
  for (const method of [
    "turn/interrupt",
    "thread/backgroundTerminals/terminate",
    "thread/backgroundTerminals/list",
  ]) {
    const reply = proxy.request(method, { threadId: "t1" });
    const sent = JSON.parse(await nextAppServerLine());
    assert.equal(sent.method, method);
    fromApp({ id: sent.id, error: { code: -32600, message: "thread not found: t1" } });
    await assert.rejects(reply, /thread not found: t1/);
  }
});

test("a response to a proxy request counts only with the id the proxy generated", async (t) => {
  const { proxy, tui, tuiReceived, nextAppServerLine, fromApp } = await fixture(t);
  let settled = false;
  const reply = proxy
    .request("thread/backgroundTerminals/list", { threadId: "t1" }, { timeoutMs: 300 })
    .finally(() => (settled = true));
  const sent = JSON.parse(await nextAppServerLine());
  // A guess, a number and the TUI answering the id on its own connection settle nothing.
  fromApp({ id: "agentpier:999", result: { data: ["guess"] } });
  fromApp({ id: Number(sent.id.split(":")[1]), result: { data: ["number"] } });
  tui.send(JSON.stringify({ id: sent.id, result: { data: ["tui"] } }));
  await delay(40);
  assert.equal(settled, false);
  // The TUI's line went to the app-server as the TUI's own message.
  assert.deepEqual(JSON.parse(await nextAppServerLine()), {
    id: sent.id,
    result: { data: ["tui"] },
  });
  // Unknown ids in the namespace are passed on to the TUI untouched.
  await until(() => tuiReceived.length === 2);
  fromApp({ id: sent.id, result: { data: [] } });
  assert.deepEqual(await reply, { data: [] });
  await assert.rejects(
    proxy.request(
      "thread/backgroundTerminals/list",
      { threadId: "t1" },
      { timeoutMs: 30 },
    ),
    /timed out/,
  );
});

test("proxy ids never take an id the TUI is using", async (t) => {
  const { proxy, tui, tuiReceived, nextAppServerLine, fromApp } = await fixture(t);
  tui.send(JSON.stringify({ id: "agentpier:1", method: "thread/read", params: {} }));
  assert.equal(JSON.parse(await nextAppServerLine()).id, "agentpier:1");
  const reply = proxy.request("thread/backgroundTerminals/list", { threadId: "t1" });
  const sent = JSON.parse(await nextAppServerLine());
  assert.notEqual(sent.id, "agentpier:1");
  fromApp({ id: "agentpier:1", result: { thread: "tui" } });
  await until(() => tuiReceived.some((m) => m.id === "agentpier:1"));
  fromApp({ id: sent.id, result: { data: [] } });
  assert.deepEqual(await reply, { data: [] });
});

test("the terminal methods follow the TUI's initialize and an experimentalApi refusal", async (t) => {
  const reports = [];
  const { proxy, initialize, nextAppServerLine, fromApp } = await fixture(t, {
    tasks: (state) => reports.push(state),
  });
  await initialize({ experimentalApi: true });
  assert.equal(reports.at(-1).terminalMethods, true);
  const reply = proxy.request("thread/backgroundTerminals/list", { threadId: "t1" });
  const sent = JSON.parse(await nextAppServerLine());
  fromApp({
    id: sent.id,
    error: {
      code: -32600,
      message: "thread/backgroundTerminals/list requires experimentalApi capability",
    },
  });
  await assert.rejects(reply, /requires experimentalApi capability/);
  assert.equal(reports.at(-1).terminalMethods, false);
  // For the rest of this launch.
  await initialize({ experimentalApi: true });
  assert.equal(reports.at(-1).terminalMethods, false);
});

test("without experimentalApi in the TUI's initialize there are no terminal methods", async (t) => {
  const reports = [];
  const { initialize } = await fixture(t, { tasks: (state) => reports.push(state) });
  await initialize({});
  assert.equal(reports.at(-1)?.terminalMethods ?? false, false);
});

test("pending proxy requests fail when the proxy closes", async (t) => {
  const { proxy, nextAppServerLine } = await fixture(t);
  const reply = proxy.request("turn/interrupt", { threadId: "t1", turnId: "u1" });
  await nextAppServerLine();
  await proxy.close();
  await assert.rejects(reply, /disconnected/);
});

/** Broker, launcher channel, proxy, server state, driver and stop control together. */
async function launched(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-codex-tasks-"));
  const session = {
    id: "fixture",
    tool: "codex",
    accountId: "account",
    status: "running",
    nativeRequests: { enabled: true },
  };
  const changes = [];
  const state = new CodexTaskState({ onChange: (id) => changes.push(id) });
  const commands = new NativeCommands({
    onTasks: (id, push) => (push ? state.report(id, push) : state.forget(id)),
  });
  const broker = new RequestBroker({
    dataDir: root,
    sessions: { get: async () => session },
    commands,
  });
  const launch = await broker.prepare({
    id: "fixture",
    account: { id: "account", tool: "codex" },
    cwd: root,
    launch: { command: "/fixture/cli", args: [], env: {} },
  });
  const channel = new NativeRequestChannel({ env: launch.env, commands: true });
  const proxyFixture = await fixture(t, channel);
  channel.onCommand = codexTaskCommands(proxyFixture.proxy);
  await channel.ready;
  await until(() => commands.connected("fixture"));
  const snapshot = {
    providerSessionId: MAIN,
    observability: { subagents: [], shells: [] },
  };
  const control = new TaskControl({
    sessions: { get: async () => session },
    chat: { read: async () => control.overlay(session, snapshot) },
    reads: { flags: () => ({}) },
    stops: { has: () => false, record: () => {}, forget: () => {} },
    onChange: () => {},
  });
  control.register("codex", codexTaskDriver({ commands, state }));
  t.after(async () => {
    channel.close();
    await broker.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { ...proxyFixture, broker, channel, state, control, snapshot, session, changes };
}
const terminalStarted = (threadId, processId) => ({
  method: "item/started",
  params: {
    threadId,
    turnId: "u1",
    startedAtMs: 1794860031067,
    item: {
      type: "commandExecution",
      id: `exec-${processId}`,
      command: "/bin/zsh -lc 'sleep 300'",
      processId,
      source: "unifiedExecStartup",
      status: "inProgress",
      exitCode: null,
    },
  },
});

test("a Codex shell is listed and stopped end to end through the proxy", async (t) => {
  const { control, snapshot, session, initialize, fromApp, nextAppServerLine, state } =
    await launched(t);
  await initialize({ experimentalApi: true });
  fromApp(terminalStarted(MAIN, "18591"));
  await until(
    () => state.shells("fixture", MAIN).length === 1 && state.terminalMethods("fixture"),
  );
  const [shell] = control.overlay(session, snapshot).observability.shells;
  assert.equal(shell.id, `${MAIN}:18591`);
  assert.equal(shell.canStop, true);
  const stop = control.stop("fixture", shell.id);
  const sent = JSON.parse(await nextAppServerLine());
  assert.deepEqual(sent, {
    id: sent.id,
    method: "thread/backgroundTerminals/terminate",
    params: { threadId: MAIN, processId: "18591" },
  });
  fromApp({ id: sent.id, result: { terminated: true } });
  assert.deepEqual(await stop, { stopped: true });
});

test("a Codex subagent stop interrupts its turn and terminates its terminal", async (t) => {
  const { control, snapshot, session, initialize, fromApp, nextAppServerLine, state } =
    await launched(t);
  snapshot.observability.subagents = [{ id: CHILD, name: "worker", status: "running" }];
  await initialize({ experimentalApi: true });
  fromApp({ method: "turn/started", params: { threadId: CHILD, turn: { id: "u1" } } });
  fromApp(terminalStarted(CHILD, "92650"));
  await until(() => state.turn("fixture", CHILD) && state.shells("fixture", MAIN).length);
  const [agent] = control.overlay(session, snapshot).observability.subagents;
  assert.equal(agent.canStop, true);
  const [shell] = control.overlay(session, snapshot).observability.shells;
  assert.equal(shell.ownerAgentId, CHILD);
  const stop = control.stop("fixture", CHILD);
  const interrupt = JSON.parse(await nextAppServerLine());
  assert.deepEqual(interrupt.params, { threadId: CHILD, turnId: "u1" });
  fromApp({ id: interrupt.id, result: {} });
  fromApp({
    method: "turn/completed",
    params: { threadId: CHILD, turn: { id: "u1", status: "interrupted" } },
  });
  const terminate = JSON.parse(await nextAppServerLine());
  assert.equal(terminate.method, "thread/backgroundTerminals/terminate");
  assert.deepEqual(terminate.params, { threadId: CHILD, processId: "92650" });
  fromApp({ id: terminate.id, result: { terminated: true } });
  assert.deepEqual(await stop, { stopped: true });
});

test("a Codex subagent that finished by itself answers notRunning", async (t) => {
  const { control, snapshot, initialize, fromApp, state } = await launched(t);
  snapshot.observability.subagents = [{ id: CHILD, name: "worker", status: "running" }];
  await initialize({ experimentalApi: true });
  fromApp({ method: "turn/started", params: { threadId: CHILD, turn: { id: "u1" } } });
  await until(() => state.turn("fixture", CHILD));
  fromApp({
    method: "turn/completed",
    params: { threadId: CHILD, turn: { id: "u1", status: "completed" } },
  });
  await until(() => !state.turn("fixture", CHILD));
  // The chat still lists it running for a moment.
  await assert.rejects(control.stop("fixture", CHILD), { code: "TASK_STOP_NOT_RUNNING" });
});

test("the tracker report is sent again after the channel reconnects", async (t) => {
  const { broker, channel, initialize, fromApp, state } = await launched(t);
  await initialize({ experimentalApi: true });
  fromApp(terminalStarted(MAIN, "18591"));
  await until(() => state.shells("fixture", MAIN).length === 1);
  // The server's socket goes away (a server restart): its state is forgotten ...
  for (const socket of broker.clients) if (socket.owner) socket.destroy();
  await until(() => state.shells("fixture", MAIN).length === 0);
  // ... and the launcher's channel reconnects and reports again.
  await until(() => state.shells("fixture", MAIN).length === 1, 4000);
  assert.equal(state.terminalMethods("fixture"), true);
  assert.equal(channel.connected, true);
});
