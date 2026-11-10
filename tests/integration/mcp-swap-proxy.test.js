import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const main = fileURLToPath(
  new URL("../../server/features/tools/mcp-swap-proxy-main.js", import.meta.url),
);
const fake = fileURLToPath(new URL("../helpers/fake-swap-mcp.mjs", import.meta.url));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (check, ms = 10000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out");
};

/** A proxy over the fake server, driven like a coding CLI drives its MCP server. */
async function proxy(t, version = "1", tools = "echo") {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "swap-proxy-")));
  const statusDir = path.join(dir, "status");
  const specFile = path.join(dir, "spec.json");
  const spec = (v, names = tools, extra = []) =>
    fs.writeFileSync(
      specFile,
      JSON.stringify({
        command: process.execPath,
        args: [fake, v, names, ...extra],
        statusDir,
      }),
    );
  spec(version);
  const child = spawn(process.execPath, [main, specFile], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, FAKE_SWAP_LOG: path.join(dir, "log") },
  });
  const messages = [];
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      messages.push(JSON.parse(buffer.slice(0, index)));
      buffer = buffer.slice(index + 1);
    }
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  t.after(() => {
    child.kill("SIGKILL");
    fs.rmSync(dir, { recursive: true, force: true });
  });
  let nextId = 1;
  const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);
  const request = (method, params) => {
    const id = nextId++;
    send({ jsonrpc: "2.0", id, method, params });
    return id;
  };
  const answer = (id) => until(() => messages.find((msg) => msg.id === id));
  const call = async (name, args = {}) =>
    (await answer(request("tools/call", { name, arguments: args }))).result?.value;
  const status = () => {
    try {
      return JSON.parse(
        fs.readFileSync(path.join(statusDir, `${child.pid}.json`), "utf8"),
      );
    } catch {
      return null;
    }
  };
  const init = await answer(
    request("initialize", {
      protocolVersion: "2025-06-18",
      clientInfo: { name: "test" },
    }),
  );
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  return {
    child,
    messages,
    send,
    request,
    answer,
    call,
    spec,
    status,
    stderr: () => stderr,
    init,
  };
}

test("the proxy forwards the handshake and announces list changes it will send", async (t) => {
  const p = await proxy(t);
  assert.equal(p.init.result.serverInfo.version, "1");
  assert.deepEqual(p.init.result.capabilities.tools, { listChanged: true });
  const me = await p.call("whoami");
  assert.equal(me.version, "1");
  assert.equal(me.initialized, true);
  assert.equal(p.status().error, null);
});

test("a swap while idle replays the handshake, announces new tools and stops the old server", async (t) => {
  const p = await proxy(t);
  await p.answer(p.request("tools/list"));
  const old = await p.call("whoami");
  p.spec("2", "echo,more");
  await until(() =>
    p.messages.some((msg) => msg.method === "notifications/tools/list_changed"),
  );
  const now = await p.call("whoami");
  assert.equal(now.version, "2");
  assert.equal(now.initialized, true, "initialize and initialized were replayed");
  assert.notEqual(now.pid, old.pid);
  await until(() => !alive(old.pid));
  assert.match(p.status().args.join(" "), / 2 echo,more$/);
  const tools = await p.answer(p.request("tools/list"));
  assert.deepEqual(
    tools.result.tools.map((tool) => tool.name),
    ["echo", "more"],
  );
});

test("a swap with an unchanged tool list sends no list change", async (t) => {
  const p = await proxy(t);
  await p.answer(p.request("tools/list"));
  p.spec("2");
  await until(async () => (await p.call("whoami")).version === "2");
  assert.equal(
    p.messages.some((msg) => msg.method === "notifications/tools/list_changed"),
    false,
  );
});

test("a swap waits for the call in flight; calls during the swap reach the new server", async (t) => {
  const p = await proxy(t);
  const slow = p.request("tools/call", { name: "slow", arguments: { ms: 1500 } });
  await new Promise((resolve) => setTimeout(resolve, 100));
  p.spec("2");
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const during = p.request("tools/call", { name: "whoami", arguments: {} });
  const first = await p.answer(slow);
  assert.equal(first.result.value.version, "1", "the old server finished its call");
  const second = await p.answer(during);
  assert.equal(second.result.value.version, "2");
  const ids = p.messages.filter((msg) => msg.id !== undefined).map((msg) => msg.id);
  assert.equal(new Set(ids).size, ids.length, "no request is answered twice");
});

test("a new server that fails keeps the old one and reports it", async (t) => {
  const p = await proxy(t);
  const before = await p.call("whoami");
  p.spec("2", "echo", ["--fail"]);
  await until(() => p.status()?.error);
  assert.match(p.status().error, /exited \(3\)/);
  assert.match(p.status().args.join(" "), / 1 echo$/);
  const after = await p.call("whoami");
  assert.equal(after.pid, before.pid);
  // The next good version still swaps.
  p.spec("3");
  await until(async () => (await p.call("whoami")).version === "3");
  assert.equal(p.status().error, null);
});

test("a crash fails the call in flight once and restarts the server with the handshake", async (t) => {
  const p = await proxy(t);
  const before = await p.call("whoami");
  const crash = p.request("tools/call", { name: "crash", arguments: {} });
  const failed = await p.answer(crash);
  assert.match(failed.error.message, /stopped unexpectedly/);
  const after = await until(() => p.call("whoami"));
  assert.notEqual(after.pid, before.pid);
  assert.equal(after.initialized, true);
  assert.equal(p.messages.filter((msg) => msg.id === crash).length, 1);
  // A second crash soon after ends the proxy: the client sees the server gone.
  p.request("tools/call", { name: "crash", arguments: {} });
  await until(() => p.child.exitCode !== null);
  assert.equal(p.child.exitCode, 1);
});

test("server requests get proxy ids, so two servers' ids never collide", async (t) => {
  const p = await proxy(t);
  const ask = (roots) => {
    const id = p.request("tools/call", { name: "ask", arguments: {} });
    return until(() =>
      p.messages.find((msg) => msg.method === "roots/list" && !msg.seen),
    ).then((msg) => {
      msg.seen = true;
      p.send({ jsonrpc: "2.0", id: msg.id, result: { roots } });
      return { asked: msg.id, answer: p.answer(id) };
    });
  };
  const one = await ask([{ uri: "file:///one" }]);
  assert.equal(typeof one.asked, "string");
  assert.deepEqual((await one.answer).result.value.roots, {
    roots: [{ uri: "file:///one" }],
  });
  p.spec("2");
  await until(async () => (await p.call("whoami")).version === "2");
  const two = await ask([{ uri: "file:///two" }]);
  assert.notEqual(two.asked, one.asked);
  const value = (await two.answer).result.value;
  assert.equal(value.version, "2");
  assert.deepEqual(value.roots, { roots: [{ uri: "file:///two" }] });
});

test("closing the client's stdin stops the server and removes the status file", async (t) => {
  const p = await proxy(t);
  const { pid } = await p.call("whoami");
  assert.ok(p.status());
  p.child.stdin.end();
  await until(() => p.child.exitCode !== null);
  await until(() => !alive(pid));
  assert.equal(p.status(), null);
});
