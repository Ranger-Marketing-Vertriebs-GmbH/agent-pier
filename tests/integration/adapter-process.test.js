import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import {
  startAdapter,
  adapterExecArgv,
  adapterEnvironment,
  substituteAdapterUrl,
} from "../../server/features/adapter-runtime/adapter-supervisor.js";
import net from "node:net";
import { once } from "node:events";
import { spawnAdapter } from "../../server/features/adapter-runtime/adapter-supervisor.js";
import { scriptedUpstream, sse } from "../helpers/scripted-upstream.js";
import { loadFixture } from "../helpers/protocol-adapter.js";
import { KEY, validAdapterConfig, authorized } from "../helpers/adapter-fixture.js";
import { alive, childPids, until } from "../helpers/adapter-process.js";

test("the adapter process serves one session and keeps the key out of argv, env and stdio", async (t) => {
  const up = await scriptedUpstream(t, (_e, res) =>
    sse(res, loadFixture("upstreams/chat/text.sse")),
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-adapter-process-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const adapter = await startAdapter(
    validAdapterConfig({
      upstream: { baseUrl: `${up.base}/v1`, authHeader: null, apiKey: KEY },
      diagnosticsPath: path.join(dir, "s.adapter.json"),
    }),
    {
      cliEnv: {
        NODE_EXTRA_CA_CERTS: "/etc/ca.pem",
        HTTPS_PROXY: "http://proxy:1",
        AGENTPIER_ENDPOINT_API_KEY: KEY,
      },
    },
  );
  t.after(() => adapter.stop());
  assert.equal(adapter.child.stdout, null);
  assert.equal(adapter.child.stderr, null);
  const argv = execFileSync("ps", ["-o", "args=", "-p", String(adapter.child.pid)], {
    encoding: "utf8",
  });
  assert.equal(argv.includes(KEY), false);
  assert.match(argv, /adapter-process\.js/);
  const res = await fetch(`${adapter.url}/v1/messages`, {
    method: "POST",
    headers: authorized(),
    body: JSON.stringify(loadFixture("clients/claude-code/text.json").body),
  });
  assert.match(await res.text(), /message_stop/);
  await adapter.stop();
  assert.equal(alive(adapter.child.pid), false);
  const diagnostics = fs.readFileSync(path.join(dir, "s.adapter.json"), "utf8");
  assert.equal(diagnostics.includes(KEY), false);
  assert.equal(JSON.parse(diagnostics).requests["/v1/messages"], 1);
});

test("environment and exec args", () => {
  assert.deepEqual(adapterExecArgv(new Set(["--use-system-ca"])), ["--use-system-ca"]);
  assert.deepEqual(adapterExecArgv(new Set()), []);
  assert.deepEqual(
    adapterEnvironment(
      { NODE_EXTRA_CA_CERTS: "/ca.pem", HTTPS_PROXY: "x", K: KEY },
      { PATH: "/bin" },
    ),
    { PATH: "/bin", NODE_EXTRA_CA_CERTS: "/ca.pem" },
  );
});

test("substitution touches env values and args only", () => {
  const out = substituteAdapterUrl(
    {
      env: { A: "__AGENTPIER_ADAPTER_URL__", B: "x" },
      args: ["-c", 'p={base_url="__AGENTPIER_ADAPTER_URL__/v1"}'],
    },
    "http://127.0.0.1:5",
  );
  assert.deepEqual(out, {
    env: { A: "http://127.0.0.1:5", B: "x" },
    args: ["-c", 'p={base_url="http://127.0.0.1:5/v1"}'],
  });
});

test("startup failures: invalid config and a silent child (start timeout)", async (t) => {
  // The adapter reports `config` over IPC before it exits; the supervisor must see that reason.
  await assert.rejects(startAdapter({ token: "x" }), { reason: "config" });
  const silent = path.join(os.tmpdir(), `agentpier-silent-${process.pid}.mjs`);
  fs.writeFileSync(silent, "setInterval(() => {}, 1000);\n");
  t.after(() => fs.rmSync(silent, { force: true }));
  const started = Date.now();
  let spawned = null;
  await assert.rejects(
    startAdapter(validAdapterConfig(), {
      entry: silent,
      timeoutMs: 200,
      onSpawn: (child) => (spawned = child),
    }),
    { reason: "timeout" },
  );
  assert.ok(Date.now() - started < 2000);
  await until(() => !alive(spawned.pid), 2000); // the timed-out child is not orphaned
});

test("stop escalates to SIGKILL after the grace period", async (t) => {
  const stubborn = path.join(os.tmpdir(), `agentpier-stubborn-${process.pid}.mjs`);
  fs.writeFileSync(
    stubborn,
    `process.on("SIGTERM", () => {});
process.once("message", () => process.send({ type: "ready", port: 1 }));
setInterval(() => {}, 1000);\n`,
  );
  t.after(() => fs.rmSync(stubborn, { force: true }));
  const adapter = await startAdapter(validAdapterConfig(), { entry: stubborn });
  const started = Date.now();
  await adapter.stop({ graceMs: 200 });
  assert.ok(Date.now() - started >= 180);
  assert.equal(alive(adapter.child.pid), false);
});

test("a taken port fails the start with reason bind", async (t) => {
  const blocker = net.createServer().listen(0, "127.0.0.1");
  await once(blocker, "listening");
  t.after(() => blocker.close());
  await assert.rejects(
    spawnAdapter(validAdapterConfig(), { port: blocker.address().port }),
    { reason: "bind" },
  );
});

test("the adapter exits when its launcher dies", async (t) => {
  const supervisor = new URL(
    "../../server/features/adapter-runtime/adapter-supervisor.js",
    import.meta.url,
  ).href;
  const script = `
import { startAdapter } from ${JSON.stringify(supervisor)};
const adapter = await startAdapter(${JSON.stringify(validAdapterConfig())});
console.log(adapter.child.pid);
setInterval(() => {}, 1000);
`;
  const parent = spawn(process.execPath, ["--input-type=module", "-e", script], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  t.after(() => parent.kill("SIGKILL"));
  const [line] = await once(parent.stdout, "data");
  const pid = Number(String(line).trim());
  assert.ok(alive(pid), "adapter started");
  parent.kill("SIGKILL"); // no SIGTERM, no stop(): only the IPC disconnect tells the adapter
  await until(() => !alive(pid), 5000);
});

test("SIGINT does not stop the adapter", async (t) => {
  const adapter = await startAdapter(validAdapterConfig());
  t.after(() => adapter.stop());
  process.kill(adapter.child.pid, "SIGINT");
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(alive(adapter.child.pid), true);
  assert.equal(adapter.restarts(), 0, "not a crash and restart either");
  assert.equal((await fetch(`${adapter.url}/api/hello`, { method: "HEAD" })).status, 200);
});

test("no adapter child outlives the tests", async () => {
  await until(() => childPids().length === 0, 3000);
});
