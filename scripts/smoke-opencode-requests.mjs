// Explicit offline protocol smoke: all subprocesses, sessions and events are fixture-owned.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import * as pty from "node-pty";
import { RequestBroker } from "../server/features/requests/request-broker.js";

const executable = process.argv[2];
if (!executable || !path.isAbsolute(executable))
  throw Error("Pass an absolute OpenCode CLI path");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-opencode-protocol-"));
const home = path.join(root, "home");
await fs.mkdir(home);
const env = {
  HOME: home,
  PATH: process.env.PATH,
  LANG: "en_US.UTF-8",
  TERM: "xterm-256color",
  XDG_CONFIG_HOME: path.join(home, "config"),
  XDG_DATA_HOME: path.join(home, "data"),
  XDG_STATE_HOME: path.join(home, "state"),
  XDG_CACHE_HOME: path.join(home, "cache"),
  OPENCODE_DISABLE_AUTOUPDATE: "true",
  OPENCODE_DISABLE_MODELS_FETCH: "true",
  OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
  OPENCODE_DISABLE_EXTERNAL_SKILLS: "true",
  OPENCODE_CONFIG_CONTENT: JSON.stringify({
    autoupdate: false,
    enabled_providers: [],
    plugin: [],
  }),
};
const session = {
  id: "smoke",
  tool: "opencode",
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
  backendUrl,
  nativeSession,
  output = "",
  serverOutput = "",
  blocked = false;
const eventClients = new Map();
const sockets = new Set();
const replies = [];
const observed = [];
async function waitFor(check, label) {
  const until = Date.now() + 15000;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw Error(
    `OpenCode smoke timeout: ${label}; requests=${JSON.stringify(observed)}; backend=${serverOutput.slice(-1200)}; output=${output.slice(-2500)}`,
  );
}
function emit(type, properties) {
  for (const [client, global] of eventClients) {
    const payload = { type, properties };
    client.write(
      `data: ${JSON.stringify(global ? { directory: root, payload } : payload)}\n\n`,
    );
  }
}
try {
  const launch = await broker.prepare({
    id: "smoke",
    account: { id: "fixture", tool: "opencode" },
    cwd: root,
    launch: { command: executable, args: [], env },
  });
  const reservation = http.createServer();
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const backendPort = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  backend = spawn(
    executable,
    ["serve", "--hostname", "127.0.0.1", "--port", String(backendPort)],
    {
      cwd: root,
      env: launch.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );
  const capture = (data) => {
    serverOutput += data;
    backendUrl ||= serverOutput.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
  };
  backend.stdout.on("data", capture);
  backend.stderr.on("data", capture);
  await waitFor(() => backendUrl, "owned native server starts");
  const create = await fetch(
    `${backendUrl}/session?directory=${encodeURIComponent(root)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Inert request smoke" }),
    },
  );
  assert.ok(create.ok, `Native session create returned ${create.status}`);
  nativeSession = (await create.json()).id;
  proxy = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, "http://fixture").pathname;
    observed.push(`${req.method} ${pathname}`);
    if (
      req.method === "POST" &&
      /\/session\/[^/]+\/(message|prompt_async|command|shell)$/.test(pathname)
    ) {
      blocked = true;
      res.writeHead(403).end("Model turns are forbidden in this smoke");
      return;
    }
    const reply = /^\/(permission|question)\/(fixture-[^/]+)\/reply$/.exec(pathname);
    if (reply) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      replies.push({ kind: reply[1], id: reply[2], body });
      res.writeHead(200, { "content-type": "application/json" }).end("true");
      emit(`${reply[1]}.replied`, {
        sessionID: nativeSession,
        requestID: reply[2],
        ...body,
      });
      return;
    }
    const upstream = http.request(
      new URL(req.url, backendUrl),
      { method: req.method, headers: req.headers },
      (incoming) => {
        res.writeHead(incoming.statusCode, incoming.headers);
        if (pathname.endsWith("/event")) {
          eventClients.set(res, pathname === "/global/event");
          res.on("close", () => eventClients.delete(res));
        }
        incoming.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.on("aborted", () => upstream.destroy());
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
  });
  proxy.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const args = [
    "attach",
    `http://127.0.0.1:${proxy.address().port}`,
    "--dir",
    root,
    "--session",
    nativeSession,
  ];
  terminal = pty.spawn(launch.command, args, {
    cwd: root,
    env: launch.env,
    cols: 120,
    rows: 40,
  });
  terminal.onData((data) => {
    output += data;
    if (data.includes("\u001b[6n")) terminal.write("\u001b[1;1R");
  });
  await waitFor(
    () =>
      eventClients.size &&
      observed.some((value) => value.includes(`/session/${nativeSession}/message`)),
    "native TUI session sync",
  );
  const question = (id) => ({
    id,
    sessionID: nativeSession,
    questions: [
      {
        header: "Smoke",
        question: "Select the inert fixture",
        options: [{ label: "Fixture", description: "No model call" }],
        multiple: false,
        custom: true,
      },
    ],
  });
  emit("question.asked", question("fixture-chat"));
  let pending;
  await waitFor(async () => {
    pending = (await broker.list("smoke")).requests[0];
    return pending?.kind === "question";
  }, "actual TUI plugin publishes question");
  await broker.answer("smoke", pending.id, {
    expectedRevision: pending.revision,
    answers: { q0: ["Fixture"] },
  });
  await waitFor(
    () => replies.some((value) => value.id === "fixture-chat"),
    "actual SDK question reply",
  );
  assert.deepEqual(replies.find((value) => value.id === "fixture-chat").body, {
    answers: [["Fixture"]],
  });
  await waitFor(
    async () => !(await broker.list("smoke")).requests.length,
    "question resolved",
  );
  emit("permission.asked", {
    id: "fixture-permission",
    sessionID: nativeSession,
    permission: "bash",
    patterns: ["echo inert"],
    always: ["echo *"],
    metadata: { command: "echo inert" },
  });
  await waitFor(async () => {
    pending = (await broker.list("smoke")).requests[0];
    return pending?.kind === "permission";
  }, "actual TUI plugin publishes permission");
  await broker.answer("smoke", pending.id, {
    expectedRevision: pending.revision,
    choice: "reject",
  });
  await waitFor(
    () => replies.some((value) => value.id === "fixture-permission"),
    "actual SDK permission reply",
  );
  assert.deepEqual(replies.find((value) => value.id === "fixture-permission").body, {
    reply: "reject",
  });
  await waitFor(
    async () => !(await broker.list("smoke")).requests.length,
    "permission resolved",
  );
  emit("question.asked", question("fixture-terminal"));
  await waitFor(async () => {
    pending = (await broker.list("smoke")).requests[0];
    return pending?.kind === "question";
  }, "second native question");
  terminal.write("\r");
  await waitFor(
    () => replies.some((value) => value.id === "fixture-terminal"),
    "actual Terminal answer",
  );
  await waitFor(
    async () => !(await broker.list("smoke")).requests.length,
    "native answer expires Chat prompt",
  );
  await assert.rejects(
    broker.answer("smoke", pending.id, {
      expectedRevision: pending.revision,
      answers: { q0: ["Fixture"] },
    }),
    { status: 409 },
  );
  assert.equal(replies.filter((value) => value.id === "fixture-terminal").length, 1);
  assert.equal(blocked, false);
  console.log(
    "Actual OpenCode server + TUI + loaded plugin passed: Chat question, permission denial, Terminal question race; zero model turns.",
  );
} finally {
  terminal?.kill();
  for (const child of [terminal, backend])
    if (child?.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {}
    }
  for (const socket of sockets) socket.destroy();
  if (proxy) await new Promise((resolve) => proxy.close(resolve));
  await broker.close();
  await new Promise((resolve) => setTimeout(resolve, 500));
  for (const child of [terminal, backend])
    if (child?.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
