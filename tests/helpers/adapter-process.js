import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createAdapterServer } from "../../server/features/adapter-runtime/adapter-server.js";
import { KEY, validAdapterConfig } from "./adapter-fixture.js";

export const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** The error code of a second bind of `port` on 127.0.0.1, or null when it was free. */
export async function bindError(port) {
  const server = net.createServer().listen(port, "127.0.0.1");
  try {
    await once(server, "listening"); // rejects with the listen error
  } catch (error) {
    return error.code;
  }
  await new Promise((resolve) => server.close(resolve));
  return null;
}

/** Connects a raw socket and resolves once it is connected. */
export async function rawSocket(t, port) {
  const socket = net.connect(port, "127.0.0.1");
  t.after(() => socket.destroy());
  socket.on("error", () => {});
  await once(socket, "connect");
  return socket;
}

/** Resolves with everything the peer sent once it closed the socket. */
export function closed(socket) {
  let data = "";
  socket.on("data", (chunk) => (data += chunk));
  return new Promise((resolve) => socket.once("close", () => resolve(data)));
}

/** Writes a stub adapter entry into a private temp dir (removed after the test). */
export function writeStub(t, source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-adapter-stub-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "stub.mjs");
  fs.writeFileSync(file, source);
  return { dir, file };
}

/** Live child processes of this test process (adapters are detached but keep their parent). */
export function childPids() {
  return execFileSync("ps", ["-A", "-o", "pid=,ppid=,stat=,comm="], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter(
      ([pid, ppid, stat, comm]) =>
        pid &&
        Number(ppid) === process.pid &&
        !stat?.startsWith("Z") &&
        !/(^|\/)ps$/.test(comm ?? ""), // the ps call itself
    )
    .map(([pid]) => Number(pid));
}

/** Polls `check` (sync or async) until it is truthy; fails the test after `ms`. */
export async function until(check, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("condition not reached");
}

/** Waits until `file` holds complete JSON and returns it parsed. */
export async function waitForJson(file, ms = 10_000) {
  let value;
  await until(() => {
    try {
      value = JSON.parse(fs.readFileSync(file, "utf8"));
      return true;
    } catch {
      return false;
    }
  }, ms);
  return value;
}

/**
 * In-process adapter server against a scripted upstream (base + "/v1" for OpenAI-style
 * routes). It is served the way production serves it: a separate listener accepts each
 * connection and hands it over with `attach()` + `accept()` (the supervisor's role).
 */
export async function startAdapterServer(t, upstream, overrides = {}, options = {}) {
  const config = validAdapterConfig({
    upstream: { baseUrl: `${upstream.base}/v1`, authHeader: null, apiKey: KEY },
    ...overrides,
  });
  const server = createAdapterServer(config, options);
  const listener = net.createServer((socket) => server.accept(socket));
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const { port } = listener.address();
  server.attach(port);
  t.after(async () => {
    listener.close();
    await server.close();
  });
  return { url: `http://127.0.0.1:${port}`, server };
}
