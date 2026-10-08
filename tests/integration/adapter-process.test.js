import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import net from "node:net";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import {
  startAdapter,
  spawnAdapter,
  adapterExecArgv,
  adapterEnvironment,
  substituteAdapterUrl,
} from "../../server/features/adapter-runtime/adapter-supervisor.js";
import { createAdapterServer } from "../../server/features/adapter-runtime/adapter-server.js";
import { scriptedUpstream, sse } from "../helpers/scripted-upstream.js";
import { loadFixture } from "../helpers/protocol-adapter.js";
import { KEY, validAdapterConfig, authorized } from "../helpers/adapter-fixture.js";
import {
  alive,
  bindError,
  childPids,
  closed,
  rawSocket,
  until,
  writeStub,
} from "../helpers/adapter-process.js";

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
      {
        NODE_EXTRA_CA_CERTS: "/ca.pem",
        SSL_CERT_FILE: "/certs/bundle.pem",
        HTTPS_PROXY: "x",
        K: KEY,
      },
      { PATH: "/bin", SSL_CERT_DIR: "/certs", HTTP_PROXY: "y" },
    ),
    {
      PATH: "/bin",
      NODE_EXTRA_CA_CERTS: "/ca.pem",
      SSL_CERT_FILE: "/certs/bundle.pem",
      SSL_CERT_DIR: "/certs",
    },
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
  // A launch without env keeps inheriting the launcher's environment.
  assert.deepEqual(substituteAdapterUrl({ args: ["x"] }, "http://127.0.0.1:5"), {
    args: ["x"],
  });
});

test("substitution fills the port placeholder from the bound URL", () => {
  const out = substituteAdapterUrl(
    { env: {}, args: ["wrap", "--open-port", "__AGENTPIER_ADAPTER_PORT__", "--", "cli"] },
    "http://127.0.0.1:43210",
  );
  assert.deepEqual(out.args, ["wrap", "--open-port", "43210", "--", "cli"]);
});

test("startup failures: invalid config and a silent child (start timeout)", async (t) => {
  // The adapter reports `config` over IPC before it exits; the supervisor must see that reason.
  await assert.rejects(startAdapter({ token: "x" }), { reason: "config" });
  const silent = writeStub(t, "setInterval(() => {}, 1000);\n").file;
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
  // The rejection waits for the killed child: nothing outlives a failed start.
  assert.equal(alive(spawned.pid), false);
});

test("without a failed message the exit code names the reason", async (t) => {
  for (const [code, reason] of [
    [78, "config"],
    [71, "exited"], // the adapter never binds: no exit code of its own for that
    [3, "exited"],
  ]) {
    const stub = writeStub(t, `process.once("message", () => process.exit(${code}));\n`);
    await assert.rejects(
      spawnAdapter(validAdapterConfig(), { entry: stub.file, port: 47999 }),
      { reason },
    );
  }
});

test("stop escalates to SIGKILL after the grace period", async (t) => {
  const stubborn = writeStub(
    t,
    `process.on("SIGTERM", () => {});
process.once("message", (m) => process.send({ type: "ready", port: m.port }));
setInterval(() => {}, 1000);\n`,
  ).file;
  const adapter = await startAdapter(validAdapterConfig(), { entry: stubborn });
  const started = Date.now();
  await adapter.stop({ graceMs: 200 });
  assert.ok(Date.now() - started >= 180);
  assert.equal(alive(adapter.child.pid), false);
});

test("the supervisor owns the port and the adapter never binds", async (t) => {
  const adapter = await startAdapter(validAdapterConfig());
  t.after(() => adapter.stop());
  const blocker = net.createServer();
  blocker.listen(adapter.port, "127.0.0.1");
  const [error] = await once(blocker, "error");
  assert.equal(error.code, "EADDRINUSE");
  // Connections still reach the adapter: the supervisor hands them over.
  assert.equal((await fetch(`${adapter.url}/api/hello`, { method: "HEAD" })).status, 200);
  await adapter.stop();
  assert.equal(await bindError(adapter.port), null, "stop releases the port");
});

test("handed-over connections keep Node's header and request timeouts", async (t) => {
  const adapter = await startAdapter(validAdapterConfig(), {
    httpTimeouts: {
      headersTimeout: 400,
      requestTimeout: 800,
      connectionsCheckingInterval: 100,
    },
  });
  t.after(() => adapter.stop());
  const started = Date.now();
  const silent = await rawSocket(t, adapter.port); // connects, sends nothing
  const trickling = await rawSocket(t, adapter.port);
  trickling.write("POST /v1/messages HTTP/1.1\r\nhost: 127.0.0.1\r\n");
  const drip = setInterval(() => trickling.writable && trickling.write("x-a: b\r\n"), 50);
  t.after(() => clearInterval(drip));
  const [fromSilent, fromTrickling] = await Promise.all([
    closed(silent),
    closed(trickling),
  ]);
  assert.ok(Date.now() - started < 3000, "both reaped within the limit");
  assert.match(fromSilent, /^(HTTP\/1\.1 408|$)/);
  assert.match(fromTrickling, /^(HTTP\/1\.1 408|$)/);
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

test("SIGINT, SIGQUIT and SIGHUP do not stop the adapter", async (t) => {
  const adapter = await startAdapter(validAdapterConfig());
  t.after(() => adapter.stop());
  for (const signal of ["SIGINT", "SIGQUIT", "SIGHUP"])
    process.kill(adapter.child.pid, signal);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(alive(adapter.child.pid), true);
  assert.equal(adapter.restarts(), 0, "not a crash and restart either");
  assert.equal((await fetch(`${adapter.url}/api/hello`, { method: "HEAD" })).status, 200);
});

test("an uncaught exception exits with 70 and the supervisor restarts the adapter", async (t) => {
  // Preload: the first adapter process throws shortly after it reported ready. It wraps
  // process.send instead of listening for messages, so the adapter still gets `start`.
  const preload = writeStub(t, "");
  const marker = path.join(preload.dir, "thrown");
  fs.writeFileSync(
    preload.file,
    `import fs from "node:fs";
const send = process.send.bind(process);
process.send = (message, ...rest) => {
  const sent = send(message, ...rest);
  if (message?.type === "ready" && !fs.existsSync(${JSON.stringify(marker)})) {
    fs.writeFileSync(${JSON.stringify(marker)}, "");
    setTimeout(() => { throw new Error("boom"); }, 100);
  }
  return sent;
};\n`,
  );
  const adapter = await startAdapter(validAdapterConfig(), {
    execArgv: [...adapterExecArgv(), "--import", pathToFileURL(preload.file).href],
    restart: { delayMs: 20 },
  });
  t.after(() => adapter.stop());
  const first = adapter.child;
  const [code] = await once(first, "exit");
  assert.equal(code, 70);
  await until(() => adapter.restarts() === 1 && adapter.child !== first);
  assert.equal((await fetch(`${adapter.url}/api/hello`, { method: "HEAD" })).status, 200);
});

test("an adapter server that never served leaves the previous snapshot alone", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-adapter-unserved-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const diagnosticsPath = path.join(dir, "s.adapter.json");
  fs.writeFileSync(diagnosticsPath, JSON.stringify({ unauthorized: 4 }));
  await createAdapterServer(validAdapterConfig({ diagnosticsPath })).close();
  assert.deepEqual(JSON.parse(fs.readFileSync(diagnosticsPath, "utf8")), {
    unauthorized: 4,
  });
});

test("a ready for another port or a stray message fails the start as config", async (t) => {
  for (const message of ['{ type: "ready", port: 1 }', '{ type: "hello" }']) {
    const stub = writeStub(
      t,
      `process.once("message", () => process.send(${message}));\nsetInterval(() => {}, 1000);\n`,
    );
    await assert.rejects(
      spawnAdapter(validAdapterConfig(), { entry: stub.file, port: 47999 }),
      { reason: "config" },
    );
  }
});

test("a failed start is recorded in the diagnostics file; a cancelled one is not", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-adapter-startfail-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const diagnosticsPath = path.join(dir, "s.adapter.json");
  const generation = "generation-0000001";
  fs.writeFileSync(
    path.join(dir, "s.json"),
    JSON.stringify({ adapterGeneration: generation }),
  );
  const config = validAdapterConfig({ diagnosticsPath, generation });
  const exits = writeStub(t, `process.once("message", () => process.exit(78));\n`).file;
  await assert.rejects(startAdapter(config, { entry: exits }), { reason: "config" });
  const record = JSON.parse(fs.readFileSync(diagnosticsPath, "utf8"));
  assert.equal(record.generation, generation);
  assert.equal(record.supervisor.startFailed, "config");
  assert.equal(JSON.stringify(record).includes(KEY), false);
  fs.rmSync(diagnosticsPath);
  const silent = writeStub(t, "setInterval(() => {}, 1000);\n").file;
  const controller = new AbortController();
  const started = startAdapter(config, { entry: silent, signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(started, { reason: "aborted" });
  assert.equal(fs.existsSync(diagnosticsPath), false);
});

test("the adapter trusts a private CA passed as NODE_EXTRA_CA_CERTS", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-adapter-ca-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const [key, cert] = ["key.pem", "cert.pem"].map((name) => path.join(dir, name));
  execFileSync(
    "openssl",
    [
      ...["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert],
      ...[
        "-days",
        "1",
        "-subj",
        "/CN=127.0.0.1",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
      ],
    ],
    { stdio: "ignore" },
  );
  const tls = { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
  const up = await scriptedUpstream(
    t,
    (_e, res) => sse(res, loadFixture("upstreams/chat/text.sse")),
    { tls },
  );
  const config = validAdapterConfig({
    upstream: { baseUrl: `${up.base}/v1`, authHeader: null, apiKey: KEY },
  });
  const call = async (cliEnv) => {
    const adapter = await startAdapter(config, { cliEnv });
    t.after(() => adapter.stop());
    const res = await fetch(`${adapter.url}/v1/messages`, {
      method: "POST",
      headers: authorized(),
      body: JSON.stringify(loadFixture("clients/claude-code/text.json").body),
    });
    return { status: res.status, text: await res.text() };
  };
  const trusted = await call({ NODE_EXTRA_CA_CERTS: cert });
  assert.equal(trusted.status, 200);
  assert.match(trusted.text, /message_stop/);
  // Control: without the CA the certificate is refused.
  assert.notEqual((await call({})).status, 200);
});

test("no adapter child outlives the tests", async () => {
  await until(() => childPids().length === 0, 3000);
});
