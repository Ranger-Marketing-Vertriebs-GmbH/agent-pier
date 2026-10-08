import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { scriptedUpstream, sse } from "../helpers/scripted-upstream.js";
import { loadFixture } from "../helpers/protocol-adapter.js";
import { KEY, TOKEN, validAdapterConfig } from "../helpers/adapter-fixture.js";
import { alive, until } from "../helpers/adapter-process.js";

const launcher = fileURLToPath(
  new URL("../../server/terminal-launcher.js", import.meta.url),
);
const fakeCli = fileURLToPath(new URL("../helpers/fake-cli.mjs", import.meta.url));
const holdReady = fileURLToPath(
  new URL("../helpers/hold-adapter-ready.mjs", import.meta.url),
);

function payloadFile(t, payload) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-adapter-launcher-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "s.launch.json");
  fs.writeFileSync(file, JSON.stringify(payload(dir)), { mode: 0o600 });
  return { dir, file };
}
function run(file, { detached = false, env = process.env } = {}) {
  const child = spawn(process.execPath, [launcher, file], {
    stdio: ["ignore", "pipe", "pipe"],
    detached,
    env,
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const done = new Promise((resolve) =>
    child.on("close", (code) => resolve({ code, stdout, stderr })),
  );
  return { child, done };
}
const adapterPids = (launcherPid) =>
  execFileSync("ps", ["-A", "-o", "pid=,ppid=,args="], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter(
      ([, ppid, ...rest]) =>
        ppid === String(launcherPid) && rest.join(" ").includes("adapter-process.js"),
    )
    .map(([pid]) => Number(pid));

/** Collects every adapter PID below the launcher until `done` settles (restarts included). */
function watchAdapters(child, done) {
  const seen = new Set(adapterPids(child.pid));
  let running = true;
  const poll = async () => {
    while (running) {
      for (const pid of adapterPids(child.pid)) seen.add(pid);
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  const polling = poll();
  return done.then(async (result) => {
    running = false;
    await polling;
    return { ...result, seen: [...seen] };
  });
}
const allDead = (pids) => until(() => pids.every((pid) => !alive(pid)));

async function setup(t, mode = "call", extra = () => ({})) {
  const up = await scriptedUpstream(t, (_e, res) =>
    sse(res, loadFixture("upstreams/chat/text.sse")),
  );
  const body = JSON.stringify(loadFixture("clients/claude-code/text.json").body);
  const { dir, file } = payloadFile(t, (d) => ({
    command: process.execPath,
    args: [fakeCli, path.join(d, "out.json"), mode, "--base=__AGENTPIER_ADAPTER_URL__"],
    cwd: d,
    env: {
      PATH: process.env.PATH,
      ANTHROPIC_BASE_URL: "__AGENTPIER_ADAPTER_URL__",
      ANTHROPIC_AUTH_TOKEN: TOKEN,
      FAKE_CLI_BODY: body,
    },
    adapter: validAdapterConfig({
      upstream: { baseUrl: `${up.base}/v1`, authHeader: null, apiKey: KEY },
      diagnosticsPath: path.join(d, "s.adapter.json"),
    }),
    ...extra(d),
  }));
  return { up, dir, file, out: path.join(dir, "out.json") };
}

test("placeholders are substituted in env and argv; the CLI reaches the adapter; no key leaks", async (t) => {
  const { up, file, out } = await setup(t);
  const { code, stdout, stderr } = await run(file).done;
  assert.equal(code, 0, stderr);
  assert.equal(fs.existsSync(file), false, "payload is one-use");
  const record = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.match(record.env.ANTHROPIC_BASE_URL, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(record.args.at(-1), `--base=${record.env.ANTHROPIC_BASE_URL}`);
  assert.equal(JSON.stringify(record).includes(KEY), false);
  assert.match(record.calls[0].text, /message_stop/);
  assert.equal(up.seen[0].headers.authorization, `Bearer ${KEY}`);
  assert.equal(stdout, "FAKE-CLI-STDOUT\n");
  assert.equal(stderr, "");
});

test("the adapter stops when the CLI exits", async (t) => {
  const { file, out } = await setup(t, "wait");
  const { child, done } = run(file);
  await until(() => fs.existsSync(`${out}.ready`));
  const [pid] = adapterPids(child.pid);
  assert.ok(pid, "adapter child of the launcher");
  child.kill("SIGTERM");
  await done;
  await until(() => !alive(pid));
});

test("a CLI exiting on its own stops the adapter and keeps the CLI's exit code", async (t) => {
  const { file, out } = await setup(t, "wait");
  const { child, done } = run(file);
  await until(() => fs.existsSync(`${out}.ready`));
  const [pid] = adapterPids(child.pid);
  assert.ok(pid, "adapter child of the launcher");
  process.kill(JSON.parse(fs.readFileSync(out, "utf8")).pid, "SIGUSR2"); // CLI exits 7
  const { code, stdout, stderr } = await done;
  assert.equal(code, 7);
  assert.equal(stdout, "");
  assert.equal(stderr, "");
  await until(() => !alive(pid));
});

test("adapter start failure: one sanitized line, exit 127, CLI not started", async (t) => {
  const { dir, file } = payloadFile(t, (d) => ({
    command: process.execPath,
    args: [fakeCli, path.join(d, "out.json")],
    cwd: d,
    env: { PATH: process.env.PATH },
    adapter: { ...validAdapterConfig(), token: "bad" },
  }));
  const { code, stdout, stderr } = await run(file).done;
  assert.equal(code, 127);
  assert.equal(stderr, "Unable to start the protocol adapter.\n");
  assert.equal(stdout, "");
  assert.equal(fs.existsSync(path.join(dir, "out.json")), false);
});

test("an adapter crash is restarted on the same URL and never writes to the CLI's terminal", async (t) => {
  const { file, out } = await setup(t, "wait");
  const { child, done } = run(file);
  await until(() => fs.existsSync(`${out}.ready`));
  const url = JSON.parse(fs.readFileSync(out, "utf8")).env.ANTHROPIC_BASE_URL;
  const [first] = adapterPids(child.pid);
  process.kill(first, "SIGKILL");
  await until(() => adapterPids(child.pid).some((pid) => pid !== first));
  await until(
    async () =>
      (await fetch(`${url}/api/hello`, { method: "HEAD" }).catch(() => null))?.status ===
      200,
  );
  child.kill("SIGTERM");
  const { stdout, stderr } = await done;
  assert.equal(stdout, "");
  assert.equal(stderr, "");
});

test("launcher shutdown during an adapter restart leaves no adapter behind", async (t) => {
  const { file, out } = await setup(t, "wait");
  const { child, done } = run(file);
  await until(() => fs.existsSync(`${out}.ready`));
  const watched = watchAdapters(child, done);
  process.kill(adapterPids(child.pid)[0], "SIGKILL");
  child.kill("SIGTERM"); // inside the supervisor's 250 ms restart delay
  const { seen } = await watched;
  // Leaked adapters would be reparented, so the PIDs are captured while the launcher runs.
  assert.ok(seen.length >= 1);
  await new Promise((r) => setTimeout(r, 600)); // past the restart delay
  await allDead(seen);
});

test("Ctrl+C in the terminal does not stop the adapter (Review Focus 2)", async (t) => {
  const { file, out } = await setup(t, "wait-sigint");
  const { child, done } = run(file, { detached: true }); // launcher leads its own process group, like a tmux pane
  await until(() => fs.existsSync(`${out}.ready`));
  process.kill(-child.pid, "SIGINT");
  const { code } = await done;
  assert.equal(code, 0);
  assert.match(JSON.parse(fs.readFileSync(out, "utf8")).calls[0].text, /message_stop/);
});

test("headless pipelines get the substituted URL through the native process group", async (t) => {
  // observationPath switches the launcher to spawnNativeProcess (the pipeline path).
  const { dir, file, out } = await setup(t, "call-wait", (d) => ({
    observationPath: path.join(d, "s.events.jsonl"),
    outcomePath: path.join(d, "s.outcome.json"),
  }));
  const { child, done } = run(file);
  await until(() => fs.existsSync(`${out}.ready`), 10_000);
  // Captured while the launcher runs: after its exit a leaked adapter would be reparented.
  const pids = adapterPids(child.pid);
  assert.equal(pids.length, 1, "adapter child of the launcher");
  process.kill(JSON.parse(fs.readFileSync(out, "utf8")).pid, "SIGUSR2"); // CLI exits 7
  const { code, stdout, stderr } = await done;
  assert.equal(code, 7, stderr);
  assert.match(stdout, /FAKE-CLI-STDOUT/);
  assert.match(
    fs.readFileSync(path.join(dir, "s.events.jsonl"), "utf8"),
    /FAKE-CLI-STDOUT/,
    "observation captured the CLI output",
  );
  const record = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.match(record.env.ANTHROPIC_BASE_URL, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(JSON.stringify(record).includes("__AGENTPIER_ADAPTER_URL__"), false);
  assert.equal(JSON.stringify(record).includes(KEY), false);
  assert.match(record.calls[0].text, /message_stop/);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(dir, "s.outcome.json"), "utf8")).exitCode,
    7,
  );
  await allDead(pids);
});

for (const [signal, expected] of [
  ["SIGTERM", 143],
  ["SIGHUP", 129],
])
  test(`${signal} during the adapter start exits ${expected} without the CLI`, async (t) => {
    const { dir, file, out } = await setup(t);
    const marker = path.join(dir, "held.pid");
    // Test-only preload: holds back the adapter's ready message, so the launcher stays in
    // its start phase until the signal arrives.
    const { child, done } = run(file, {
      env: { ...process.env, NODE_OPTIONS: `--import=${holdReady}`, HOLD_MARKER: marker },
    });
    await until(() => fs.existsSync(marker), 10_000);
    const adapterPid = Number(fs.readFileSync(marker, "utf8"));
    assert.ok(alive(adapterPid));
    child.kill(signal);
    const { code, stdout, stderr } = await done;
    assert.equal(code, expected);
    assert.equal(stdout, "");
    assert.equal(stderr, "");
    assert.equal(fs.existsSync(out), false, "CLI never started");
    assert.equal(fs.existsSync(file), false, "payload consumed");
    await until(() => !alive(adapterPid)); // the aborted start killed the adapter
  });

test("SIGTERM during the adapter start never starts the CLI afterwards (race-tolerant)", async (t) => {
  const { file, out } = await setup(t);
  const { child, done } = run(file);
  await once(child, "spawn");
  child.kill("SIGTERM");
  const { code } = await done;
  // The signal lands either during the adapter start (exit 143, CLI never ran) or after the
  // CLI started (the CLI was told to stop). The deterministic part: a 143 exit never has a CLI
  // record. An adapter orphaned by a dying launcher exits on IPC disconnect (Task 10 test).
  if (code === 143) assert.equal(fs.existsSync(out), false);
  else assert.ok(fs.existsSync(out) || code !== 0);
});
