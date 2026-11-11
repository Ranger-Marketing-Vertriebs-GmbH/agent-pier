import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";

const root = path.resolve(import.meta.dirname, "../..");

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => socket.destroy());
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * The application as its own process, the way the browser suite runs it
 * (scripts/test-server.mjs): an unhandled socket error ends that process, which a
 * server inside the test process would not show the same way. It owns a disposable
 * data directory and removes it when it stops.
 */
async function serverProcess(t) {
  const port = await freePort();
  const child = spawn(process.execPath, ["scripts/test-server.mjs"], {
    cwd: root,
    env: { ...process.env, AGENTPIER_TEST_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let exited = null;
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const gone = once(child, "exit").then(([code, signal]) => (exited = { code, signal }));
  t.after(async () => {
    if (!exited) child.kill("SIGTERM");
    await Promise.race([gone, sleep(8000).then(() => child.kill("SIGKILL"))]);
    await gone;
  });
  for (let waited = 0; !output.includes("Isolated test server"); waited += 50) {
    if (exited || waited > 30000) throw new Error(`The server did not start: ${output}`);
    await sleep(50);
  }
  const url = `http://127.0.0.1:${port}`;
  const setup = await fetch(`${url}/auth/setup`, {
    method: "POST",
    headers: { origin: url, "content-type": "application/json" },
    body: JSON.stringify({
      username: "fixture",
      password: randomBytes(24).toString("hex"),
    }),
  });
  assert.equal(setup.status, 201);
  const cookie = setup.headers.getSetCookie().map((one) => one.split(";")[0])[0];
  assert.match(cookie, /^agentpier_session=/);
  return {
    port,
    url,
    cookie,
    /** Fails when the process ended, or no longer answers. */
    async alive(what) {
      // A reset reaches the server after the client's call returned.
      for (let round = 0; round < 3; round++) {
        await sleep(100);
        assert.equal(exited, null, `${what}: the server process ended\n${output}`);
        const health = await fetch(`${url}/api/health`, {
          signal: AbortSignal.timeout(5000),
        });
        assert.equal(health.status, 200, what);
      }
    },
  };
}

const upgradeRequest = (server, target, { cookie, protocol = "websocket" } = {}) =>
  [
    `GET ${target} HTTP/1.1`,
    `Host: 127.0.0.1:${server.port}`,
    "Connection: Upgrade",
    `Upgrade: ${protocol}`,
    "Sec-WebSocket-Version: 13",
    `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
    ...(cookie ? [`Cookie: ${cookie}`, `Origin: ${server.url}`] : []),
    "",
    "",
  ].join("\r\n");

/**
 * Opens a connection, writes `bytes` and resets it (a TCP RST, not a close) at `when`:
 * "sent" once the bytes are written, "answer" once the server's first bytes arrive.
 * Resolves with what the server had answered until then.
 */
function resetConnection(server, bytes, when) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port: server.port });
    let answer = "";
    const waiting = setTimeout(() => {
      socket.destroy();
      reject(new Error(`No answer to reset at "${when}"`));
    }, 5000);
    socket.setEncoding("latin1");
    socket.on("error", () => {});
    socket.on("close", () => {
      clearTimeout(waiting);
      resolve(answer);
    });
    socket.on("data", (chunk) => {
      answer += chunk;
      if (when === "answer") socket.resetAndDestroy();
    });
    socket.on("connect", () =>
      socket.write(bytes, () => {
        if (when === "sent") socket.resetAndDestroy();
      }),
    );
  });
}

const status = (answer) => Number(/^HTTP\/1\.1 (\d{3}) /.exec(answer)?.[1]);
// A reset races the server's own work, so each window is hit several times.
const rounds = 8;

const refusals = [
  { name: "an upgrade refused without a login", target: "/api/live", status: 403 },
  { name: "an upgrade to a path no attacher takes", target: "/nothing", status: 403 },
  { name: "an upgrade with a malformed target", target: "//", status: 400 },
  {
    name: "an upgrade to another protocol",
    target: "/api/live",
    protocol: "h2c",
    status: 403,
  },
  {
    name: "an upgrade refused after the login",
    target: "/api/sessions/a.b/terminal",
    login: true,
    status: 404,
  },
  {
    name: "an upgrade whose service does not run",
    target: "/api/assistants/probe/browser-stream",
    login: true,
    status: 503,
  },
];

for (const refusal of refusals) {
  test(`${refusal.name}, reset by the peer, leaves the server running`, async (t) => {
    const server = await serverProcess(t);
    const bytes = () =>
      upgradeRequest(server, refusal.target, {
        cookie: refusal.login ? server.cookie : undefined,
        protocol: refusal.protocol,
      });
    for (let round = 0; round < rounds; round++) {
      const answered = status(await resetConnection(server, bytes(), "answer"));
      // No answer at all: say whether the process is gone before comparing statuses.
      if (!answered) await server.alive(refusal.name);
      assert.equal(answered, refusal.status);
      await resetConnection(server, bytes(), "sent");
    }
    await server.alive(refusal.name);
  });
}

test("a reset in the middle of the upgrade request leaves the server running", async (t) => {
  const server = await serverProcess(t);
  const bytes = upgradeRequest(server, "/api/live", { cookie: server.cookie });
  for (const length of [1, 20, bytes.length - 30, bytes.length - 2])
    for (let round = 0; round < 3; round++)
      await resetConnection(server, bytes.slice(0, length), "sent");
  await server.alive("half-sent headers");
});

test("a reset after a completed upgrade leaves the server running", async (t) => {
  const server = await serverProcess(t);
  for (let round = 0; round < rounds; round++) {
    const answer = await resetConnection(
      server,
      upgradeRequest(server, "/api/live", { cookie: server.cookie }),
      "answer",
    );
    assert.equal(status(answer), 101);
  }
  await server.alive("an open socket");
  // The places of the reset sockets are free again (16 per principal).
  const again = await resetConnection(
    server,
    upgradeRequest(server, "/api/live", { cookie: server.cookie }),
    "answer",
  );
  assert.equal(status(again), 101);
});

test("a refused upgrade is closed when the peer keeps its side open", async (t) => {
  const server = await serverProcess(t);
  // The peer reads the refusal and then neither closes nor resets.
  const socket = net.connect({
    host: "127.0.0.1",
    port: server.port,
    allowHalfOpen: true,
  });
  t.after(() => socket.destroy());
  let answer = "";
  let failed = false;
  socket.setEncoding("latin1");
  socket.on("data", (chunk) => (answer += chunk));
  socket.on("error", () => (failed = true));
  await once(socket, "connect");
  socket.write(upgradeRequest(server, "/api/live"));
  await once(socket, "end");
  assert.equal(status(answer), 403);
  // The server ended its side only; after its grace (5 s) it closes the connection,
  // which a later write of the peer meets as a reset.
  await sleep(5500);
  for (let round = 0; round < 20 && !failed; round++) {
    socket.write("x");
    await sleep(100);
  }
  assert.equal(failed, true, "the server still holds the connection");
  await server.alive("a peer that never closes");
});
