// Explicit offline native smoke. All state, subprocesses and transport frames belong to this fixture.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { PassThrough, Writable } from "node:stream";
import readline from "node:readline";
import * as pty from "node-pty";
import { RequestBroker } from "../server/features/requests/request-broker.js";
import { NativeRequestChannel } from "../server/features/requests/native-channel.js";
import { createCodexProxy } from "../server/features/requests/codex-proxy.js";
import { appServerArgs } from "../server/features/requests/codex-launch.js";

const executable = process.argv[2];
if (!executable || !path.isAbsolute(executable))
  throw Error("Pass the absolute path of an installed Codex CLI");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-request-native-smoke-"));
const home = path.join(root, "home");
await fs.mkdir(home);
const env = {
  HOME: home,
  CODEX_HOME: home,
  PATH: process.env.PATH,
  LANG: "en_US.UTF-8",
  TERM: "xterm-256color",
  FIXTURE_API_KEY: "inert-fixture",
};
const args = [
  "--no-alt-screen",
  "-c",
  'model="gpt-5"',
  "-c",
  'model_provider="fixture"',
  "-c",
  'model_providers.fixture={name="Fixture",base_url="http://127.0.0.1:1",env_key="FIXTURE_API_KEY",wire_api="responses"}',
];
const session = {
  id: "smoke",
  tool: "codex",
  accountId: "fixture",
  status: "running",
  nativeRequests: { enabled: true },
};
const broker = new RequestBroker({
  dataDir: root,
  sessions: { get: async () => session },
});
let backend,
  terminal,
  proxy,
  channel,
  nativeThread,
  output = "",
  blockedTurn = false;
const replies = [];
async function waitFor(check, label) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw Error(`Native smoke timed out: ${label}; output=${output.slice(-3500)}`);
}
try {
  const launch = await broker.prepare({
    id: "smoke",
    account: { id: "fixture", tool: "codex" },
    cwd: root,
    launch: { command: executable, args, env },
  });
  channel = new NativeRequestChannel({ env: launch.env });
  backend = spawn(executable, appServerArgs(args), {
    cwd: root,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  backend.on("error", (error) => {
    throw error;
  });
  backend.stderr.on("data", () => {});
  const incoming = new PassThrough();
  backend.stdout.pipe(incoming);
  const events = readline.createInterface({ input: backend.stdout });
  events.on("line", (line) => {
    try {
      const event = JSON.parse(line);
      if (event.method === "thread/started") nativeThread = event.params.thread.id;
    } catch {}
  });
  const outgoing = new Writable({
    write(chunk, _encoding, done) {
      try {
        const message = JSON.parse(String(chunk));
        if (message.method === "turn/start") {
          blockedTurn = true;
          throw Error("Smoke forbids model turns");
        }
        if (String(message.id).startsWith("fixture-request-") && !message.method)
          replies.push(message);
        else backend.stdin.write(chunk);
        done();
      } catch (error) {
        done(error);
      }
    },
  });
  outgoing.on("error", () => {});
  proxy = await createCodexProxy({ input: incoming, output: outgoing, channel });
  terminal = pty.spawn(
    executable,
    [
      ...args,
      "--remote",
      proxy.url,
      "--remote-auth-token-env",
      "AGENTPIER_CODEX_WS_TOKEN",
    ],
    {
      cwd: root,
      env: { ...env, AGENTPIER_CODEX_WS_TOKEN: proxy.authToken },
      cols: 120,
      rows: 40,
    },
  );
  terminal.onData((data) => {
    output += data;
    if (data.includes("\u001b[6n")) terminal.write("\u001b[1;1R");
  });
  await waitFor(
    () => nativeThread && output.includes("OpenAI Codex"),
    "actual TUI startup",
  );
  const inject = (message) => incoming.write(JSON.stringify(message) + "\n");
  const question = (id) => ({
    id,
    method: "item/tool/requestUserInput",
    params: {
      threadId: nativeThread,
      turnId: "fixture-turn",
      itemId: id,
      isBlocking: true,
      autoResolutionMs: null,
      questions: [
        {
          id: "native-choice",
          header: "Fixture",
          question: `Which fixture option? ${id}`,
          isOther: true,
          isSecret: false,
          options: [
            { label: "First fixture", description: "Offline synthetic option" },
            { label: "Second fixture", description: "Another offline option" },
          ],
        },
      ],
    },
  });
  inject(question("fixture-request-chat"));
  await waitFor(
    async () =>
      (await broker.list("smoke")).requests.length === 1 &&
      output.includes("Which fixture option?"),
    "native question in Chat and Terminal",
  );
  const ask = (await broker.list("smoke")).requests[0];
  await broker.answer("smoke", ask.id, {
    expectedRevision: 1,
    answers: { q0: ["Second fixture"] },
  });
  assert.deepEqual(replies[0], {
    id: "fixture-request-chat",
    result: { answers: { "native-choice": { answers: ["Second fixture"] } } },
  });
  inject({
    method: "serverRequest/resolved",
    params: { threadId: nativeThread, requestId: "fixture-request-chat" },
  });
  output = "";
  inject(question("fixture-request-terminal"));
  await waitFor(() => output.includes("terminal"), "next native question");
  const terminalAsk = (await broker.list("smoke")).requests[0];
  terminal.write("\r");
  await waitFor(() => replies.length === 2, "native Terminal answer");
  assert.equal(replies[1].id, "fixture-request-terminal");
  await assert.rejects(
    broker.answer("smoke", terminalAsk.id, {
      expectedRevision: 1,
      answers: { q0: ["Second fixture"] },
    }),
    { status: 409 },
  );
  inject({
    method: "serverRequest/resolved",
    params: { threadId: nativeThread, requestId: "fixture-request-terminal" },
  });
  const approval = {
    id: "fixture-request-permission",
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: nativeThread,
      turnId: "fixture-turn",
      itemId: "fixture-command",
      kind: "command",
      startedAtMs: Date.now(),
      environmentId: null,
      command: "printf offline-fixture",
      cwd: root,
      availableDecisions: ["accept", "decline"],
    },
  };
  inject(approval);
  await waitFor(
    async () =>
      (await broker.list("smoke")).requests.some((r) => r.kind === "permission"),
    "native permission request",
  );
  const permission = (await broker.list("smoke")).requests[0];
  await broker.answer("smoke", permission.id, { expectedRevision: 1, choice: "decline" });
  assert.deepEqual(replies[2], {
    id: "fixture-request-permission",
    result: { decision: "decline" },
  });
  assert.equal(blockedTurn, false);
  console.log(
    "Native Codex TUI + app-server smoke passed: Chat question, Terminal question race, permission denial; no model turns.",
  );
} finally {
  terminal?.kill("SIGTERM");
  if (backend?.pid) {
    try {
      if (process.platform !== "win32") process.kill(-backend.pid, "SIGTERM");
      else backend.kill();
    } catch {}
  }
  await proxy?.close();
  channel?.close();
  await broker.close();
  await fs.rm(root, { recursive: true, force: true });
}
