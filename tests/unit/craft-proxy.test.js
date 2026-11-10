import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  craftProxies,
  craftProxyRow,
  proxyMain,
  proxySpecFile,
  proxyStatusDir,
  watchCraftProxies,
} from "../../server/features/tools/craft-proxy.js";

const dataDir = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "craft-proxy-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test("the row runs the proxy; the spec is rewritten only when the server changes", (t) => {
  const dir = dataDir(t);
  const server = {
    command: "/clis/craft-anything/cli-0.5.0/craft-anything-cli",
    variants: { "clean-room": ["mcp"], deep: ["mcp", "--deep"] },
    env: { A: "1" },
  };
  const row = craftProxyRow(dir, server, "/node", "deep");
  assert.deepEqual(row, {
    command: "/node",
    args: [proxyMain, proxySpecFile(dir), "deep"],
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(proxySpecFile(dir), "utf8")), {
    ...server,
    statusDir: proxyStatusDir(dir),
  });
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(proxySpecFile(dir), old, old);
  craftProxyRow(dir, server, "/node", "clean-room");
  assert.equal(fs.statSync(proxySpecFile(dir)).mtimeMs, old.getTime(), "unchanged");
  craftProxyRow(dir, { ...server, command: "/clis/cli-0.6.0/cli" }, "/node", "deep");
  assert.notEqual(fs.statSync(proxySpecFile(dir)).mtimeMs, old.getTime());
});

test("proxy statuses list running proxies and drop those that are gone", (t) => {
  const dir = dataDir(t);
  const status = proxyStatusDir(dir);
  fs.mkdirSync(status, { recursive: true });
  // This test process is no proxy: its failed swap is not shown.
  const own = { pid: process.pid, command: "/c", error: null };
  fs.writeFileSync(path.join(status, `${process.pid}.json`), JSON.stringify(own));
  // A pid far above any real one: that proxy is gone.
  fs.writeFileSync(path.join(status, "99999999.json"), JSON.stringify({ pid: 99999999 }));
  assert.deepEqual(craftProxies(dir), [own]);
  assert.deepEqual(fs.readdirSync(status), [`${process.pid}.json`]);
});

test("a status change is announced, debounced", async (t) => {
  const dir = dataDir(t);
  let listener;
  const watcher = { on() {}, close() {}, unref() {} };
  // A stand-in for fs.watch: the test fires the changes itself.
  const watch = (_directory, onEvent) => {
    listener = onEvent;
    return watcher;
  };
  let calls = 0;
  const stop = watchCraftProxies(dir, () => calls++, 20, watch);
  t.after(stop);
  assert.ok(fs.existsSync(proxyStatusDir(dir)));
  listener("rename", "1.json");
  listener("rename", "2.json");
  assert.equal(calls, 0, "debounced");
  for (let i = 0; i < 100 && calls === 0; i += 1)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls, 1);
  listener("change", "1.json");
  for (let i = 0; i < 100 && calls === 1; i += 1)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls, 2);
});
