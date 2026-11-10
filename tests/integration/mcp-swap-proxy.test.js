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
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (check, ms = 10000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await pause(25);
  }
  throw new Error("timed out");
};

/**
 * A proxy over the fake server, driven like a coding CLI drives its MCP server. Each
 * version is its own command (a script running the fake), as each Craft Anything
 * version is its own binary; the proxy runs variant "a".
 */
async function proxy(t, version = "1", tools = "echo") {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "swap-proxy-")));
  const statusDir = path.join(dir, "status");
  const specFile = path.join(dir, "spec.json");
  const log = path.join(dir, "log");
  const command = (v) => {
    const file = path.join(dir, `server-${v}`);
    fs.writeFileSync(
      file,
      `#!/bin/sh\nexec "${process.execPath}" "${fake}" ${v} "$@"\n`,
      {
        mode: 0o755,
      },
    );
    return file;
  };
  const spec = (v, { names = tools, extra = [], other = [] } = {}) =>
    fs.writeFileSync(
      specFile,
      JSON.stringify({
        command: command(v),
        variants: { a: [names, ...extra], b: [names, ...other] },
        env: { FAKE_SWAP_ENV: `env-${v}` },
        statusDir,
      }),
    );
  spec(version);
  const child = spawn(process.execPath, [main, specFile, "a"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, FAKE_SWAP_LOG: log },
  });
  const messages = [];
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    const parts = (buffer + chunk).split("\n");
    buffer = parts.pop();
    for (const line of parts) messages.push(JSON.parse(line));
  });
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
  /** What the servers received: `[{ pid, msg }]`. */
  const received = () =>
    fs.existsSync(log)
      ? fs
          .readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .map((line) => {
            const space = line.indexOf(" ");
            return {
              pid: Number(line.slice(0, space)),
              msg: JSON.parse(line.slice(space)),
            };
          })
      : [];
  const listChanged = () =>
    messages.filter((msg) => msg.method === "notifications/tools/list_changed").length;
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
    received,
    listChanged,
    init,
  };
}

test("the proxy forwards the handshake, the spec's env, and announces list changes", async (t) => {
  const p = await proxy(t);
  assert.equal(p.init.result.serverInfo.version, "1");
  assert.deepEqual(p.init.result.capabilities.tools, { listChanged: true });
  const me = await p.call("whoami");
  assert.equal(me.version, "1");
  assert.equal(me.env, "env-1");
  assert.equal(me.initialized, true);
  assert.equal(p.status().error, null);
});

test("a new version swaps while idle: handshake again, new tools announced, old stopped", async (t) => {
  const p = await proxy(t);
  await p.answer(p.request("tools/list"));
  const old = await p.call("whoami");
  p.spec("2", { names: "echo,more" });
  await until(() => p.listChanged() === 1);
  const now = await p.call("whoami");
  assert.equal(now.version, "2");
  assert.equal(now.env, "env-2");
  assert.equal(now.initialized, true, "initialize and initialized were repeated");
  await until(() => !alive(old.pid));
  await until(() => /server-2$/.test(p.status()?.command ?? ""));
  const tools = await p.answer(p.request("tools/list"));
  assert.deepEqual(
    tools.result.tools.map((tool) => tool.name),
    ["echo", "more"],
  );
});

test("a mode change (another variant's args) never swaps a running session", async (t) => {
  const p = await proxy(t);
  const before = await p.call("whoami");
  // Same command: only the other variant's args and this one's change.
  p.spec("1", { names: "echo,deep", other: ["--slow-init"] });
  await pause(2000);
  const after = await p.call("whoami");
  assert.equal(after.pid, before.pid);
  assert.equal(p.listChanged(), 0);
});

test("an unchanged tool list sends no list change", async (t) => {
  const p = await proxy(t);
  await p.answer(p.request("tools/list"));
  p.spec("2");
  await until(async () => (await p.call("whoami")).version === "2");
  assert.equal(p.listChanged(), 0);
});

test("during a swap new calls reach the new server while the old finishes and gets cancellations", async (t) => {
  const p = await proxy(t);
  const first = p.request("tools/call", { name: "slow", arguments: { ms: 4000 } });
  const second = p.request("tools/call", { name: "slow", arguments: { ms: 4000 } });
  await pause(100);
  const old = p.received().at(-1).pid;
  p.spec("2");
  // The new server answers right away, long before the old one's calls end.
  const now = await until(async () => {
    const value = await p.call("whoami");
    return value.version === "2" && value;
  });
  assert.notEqual(now.pid, old);
  assert.equal(
    p.messages.some((msg) => msg.id === first),
    false,
  );
  // A cancellation goes to the server that owns the call.
  p.send({
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { requestId: second },
  });
  await until(() =>
    p
      .received()
      .some(
        (entry) =>
          entry.pid === old &&
          entry.msg.method === "notifications/cancelled" &&
          entry.msg.params.requestId === second,
      ),
  );
  assert.equal((await p.answer(first)).result.value.version, "1");
  await until(() => !alive(old));
  const ids = p.messages.filter((msg) => msg.id !== undefined).map((msg) => msg.id);
  assert.equal(new Set(ids).size, ids.length, "no request is answered twice");
});

test("a new server that fails keeps the old one and reports a stable code", async (t) => {
  const p = await proxy(t);
  const before = await p.call("whoami");
  p.spec("2", { extra: ["--fail"] });
  await until(() => p.status()?.error);
  assert.equal(p.status().error, "start-failed");
  assert.match(p.status().command, /server-1$/);
  assert.equal((await p.call("whoami")).pid, before.pid);
  // The next version still swaps.
  p.spec("3");
  await until(async () => (await p.call("whoami")).version === "3");
  await until(() => p.status()?.error === null);
});

test("a crash fails the call once and restarts the server; a second crash ends the proxy", async (t) => {
  const p = await proxy(t);
  const before = await p.call("whoami");
  const crash = p.request("tools/call", { name: "crash", arguments: {} });
  assert.match((await p.answer(crash)).error.message, /stopped unexpectedly/);
  const after = await until(() => p.call("whoami"));
  assert.notEqual(after.pid, before.pid);
  assert.equal(after.initialized, true);
  assert.equal(p.messages.filter((msg) => msg.id === crash).length, 1);
  p.request("tools/call", { name: "crash", arguments: {} });
  await until(() => p.child.exitCode !== null);
  assert.equal(p.child.exitCode, 1);
});

test("a crash during a swap waits for the swap instead of restarting the old version", async (t) => {
  const p = await proxy(t);
  const before = await p.call("whoami");
  p.spec("2", { extra: ["--slow-init"] });
  await until(() => p.received().some((e) => e.pid !== before.pid));
  const crash = p.request("tools/call", { name: "crash", arguments: {} });
  assert.match((await p.answer(crash)).error.message, /stopped unexpectedly/);
  const after = await until(() => p.call("whoami"));
  assert.equal(after.version, "2");
  const started = new Set(
    p
      .received()
      .filter((e) => e.msg.method === "initialize")
      .map((e) => e.pid),
  );
  assert.equal(started.size, 2, "no third server with the old version");
});

test("server requests get proxy ids, so two servers' ids never collide", async (t) => {
  const p = await proxy(t);
  const ask = async (roots) => {
    const id = p.request("tools/call", { name: "ask", arguments: {} });
    const msg = await until(() =>
      p.messages.find((item) => item.method === "roots/list" && !item.seen),
    );
    msg.seen = true;
    p.send({ jsonrpc: "2.0", id: msg.id, result: { roots } });
    return { asked: msg.id, answer: await p.answer(id) };
  };
  const one = await ask([{ uri: "file:///one" }]);
  assert.equal(typeof one.asked, "string");
  assert.deepEqual(one.answer.result.value.roots, { roots: [{ uri: "file:///one" }] });
  p.spec("2");
  await until(async () => (await p.call("whoami")).version === "2");
  const two = await ask([{ uri: "file:///two" }]);
  assert.notEqual(two.asked, one.asked);
  assert.equal(two.answer.result.value.version, "2");
  assert.deepEqual(two.answer.result.value.roots, { roots: [{ uri: "file:///two" }] });
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

test("client notifications reach a starting server only after its handshake", async (t) => {
  const p = await proxy(t);
  const before = await p.call("whoami");
  p.spec("2", { extra: ["--slow-init"] });
  await until(() => p.received().some((e) => e.pid !== before.pid));
  p.send({ jsonrpc: "2.0", method: "notifications/roots/list_changed" });
  await until(async () => (await p.call("whoami")).version === "2");
  const next = p
    .received()
    .filter((e) => e.pid !== before.pid)
    .map((e) => e.msg.method ?? "response");
  assert.deepEqual(next.slice(0, 3), [
    "initialize",
    "notifications/initialized",
    "notifications/roots/list_changed",
  ]);
  assert.ok(
    p
      .received()
      .some(
        (e) =>
          e.pid === before.pid && e.msg.method === "notifications/roots/list_changed",
      ),
    "the running server got it at once",
  );
});

test("a retired server that dies fails its calls without claiming a restart", async (t) => {
  const p = await proxy(t);
  const { pid } = await p.call("whoami");
  const slow = p.request("tools/call", { name: "slow", arguments: { ms: 8000 } });
  p.spec("2");
  await until(async () => (await p.call("whoami")).version === "2");
  process.kill(pid, "SIGKILL");
  const failed = await p.answer(slow);
  assert.match(failed.error.message, /before it answered/);
  assert.doesNotMatch(failed.error.message, /restarted/);
  assert.equal((await p.call("whoami")).version, "2");
});
