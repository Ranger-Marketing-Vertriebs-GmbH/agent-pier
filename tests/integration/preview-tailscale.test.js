import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { applicationFixture } from "../helpers/application.js";
import { freePortRange } from "../helpers/preview-ports.js";
import { send, startUpstream } from "../helpers/preview-proxy-fixture.js";
import { portAvailable } from "../../server/features/pipelines/run-ports.js";

/** An app with previews on `range`, Tailscale CLI calls answered by a fake. */
async function previewApp(t, { range, enabled = true, prepare, ...extra }) {
  const f = await applicationFixture(t, {
    ...extra,
    prepareDataDir: async (dataDir) => {
      await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
      await fs.writeFile(
        path.join(dataDir, "config.json"),
        JSON.stringify({
          previews: { enabled, portRangeStart: range.start, portRangeEnd: range.end },
        }),
      );
      await prepare?.(dataDir);
    },
  });
  const previews = f.application.previews;
  previews.sessionAlive = () => true;
  await previews.start();
  return { f, range, previews };
}

const sessionOwner = (f, sessionId = "s1") => ({
  kind: "session",
  sessionId,
  project: f.project,
});

const remoteUrl = "https://box.tail.ts.net";
const OFFSET = 1000;

/** A free range whose Tailscale listener ports (slot + 1000) are free as well. */
async function tailscaleRange(count) {
  for (;;) {
    const range = await freePortRange(count);
    let free = true;
    for (let port = range.start; port <= range.end && free; port++)
      free = await portAvailable(port + OFFSET);
    if (free) return range;
  }
}

/** A fake `tailscale` that keeps the Serve entries it is asked to add or remove. */
function fakeTailscale({ fail = () => false, web = {} } = {}) {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    if (fail(args)) throw new Error("denied");
    if (args.join(" ") === "serve status --json") return JSON.stringify({ Web: web });
    const port = args.find((arg) => arg.startsWith("--https=")).slice(8);
    if (args.includes("off")) delete web[`box.tail.ts.net:${port}`];
    else web[`box.tail.ts.net:${port}`] = { Handlers: { "/": { Proxy: args.at(-1) } } };
    return "";
  };
  const writes = () => calls.filter((args) => args[1] !== "status");
  return { run, calls, web, writes };
}

const ports = (range) =>
  Array.from({ length: range.end - range.start + 1 }, (_, i) => range.start + i);
const registration = (slot) => [
  "serve",
  "--bg",
  `--https=${slot}`,
  `http://127.0.0.1:${slot + OFFSET}`,
];

test("start re-applies registrations only when enabled", async (t) => {
  const off = fakeTailscale();
  const disabled = await previewApp(t, {
    count: 2,
    enabled: false,
    range: await tailscaleRange(2),
    remoteUrl,
    tailscaleRun: off.run,
  });
  assert.equal(off.calls.length, 0);
  assert.deepEqual((await disabled.previews.view()).serve, {
    registered: [],
    failed: [],
    commands: [],
  });

  const tailscale = fakeTailscale();
  const range = await tailscaleRange(2);
  const { f, previews } = await previewApp(t, {
    range,
    remoteUrl,
    tailscaleRun: tailscale.run,
  });
  assert.deepEqual(tailscale.writes(), ports(range).map(registration));
  assert.deepEqual((await previews.view()).serve, {
    registered: ports(range),
    failed: [],
    commands: [],
  });
  // The listener binds loopback at slot + 1000; the slot itself stays for tailscaled.
  for (const slot of ports(range)) {
    assert.equal(await portAvailable(slot + OFFSET), false);
    assert.equal(await portAvailable(slot), true);
  }
  const host = `box.tail.ts.net:${range.start}`;
  const idle = await send(range.start + OFFSET, {
    headers: { host, cookie: f.cookie, "tailscale-user-login": "o@x" },
  });
  assert.equal(idle.status, 404);
  // Loopback names the listener's own port, Tailscale the slot.
  const local = (port) =>
    send(range.start + OFFSET, {
      headers: { host: `127.0.0.1:${port}`, cookie: f.cookie },
    });
  assert.equal((await local(range.start + OFFSET)).status, 404);
  assert.equal((await local(range.start)).status, 403);
  assert.deepEqual(
    (await previews.view()).slots.map((slot) => slot.state),
    ["free", "free"],
  );
  // The update path: a restart finds its own registrations and adds none.
  await f.restart();
  await f.application.previews.start();
  assert.equal(tailscale.writes().length, range.end - range.start + 1);
  assert.deepEqual((await f.application.previews.view()).serve.registered, ports(range));
});

test("switching previews off removes the registrations; open answers PREVIEW_UNAVAILABLE while Serve failed and network mode is off", async (t) => {
  const tailscale = fakeTailscale();
  const range = await tailscaleRange(2);
  const { previews } = await previewApp(t, {
    range,
    remoteUrl,
    tailscaleRun: tailscale.run,
  });
  await previews.configure({
    enabled: false,
    portRangeStart: range.start,
    portRangeEnd: range.end,
  });
  assert.deepEqual(
    tailscale.writes().slice(-2),
    ports(range).map((slot) => ["serve", `--https=${slot}`, "off"]),
  );
  assert.deepEqual(tailscale.web, {});

  const upstream = await startUpstream(t);
  const failing = fakeTailscale({ fail: (args) => args.includes("--bg") });
  const broken = await previewApp(t, {
    range: await tailscaleRange(2),
    remoteUrl,
    tailscaleRun: failing.run,
  });
  const serve = (await broken.previews.view()).serve;
  assert.deepEqual(serve.registered, []);
  assert.equal(serve.failed.length, 2);
  assert.equal(serve.failed[0].reason, "denied");
  assert.equal(
    serve.commands[0],
    `tailscale serve --bg --https=${broken.range.start} http://127.0.0.1:${broken.range.start + OFFSET}`,
  );
  await assert.rejects(
    broken.previews.open({ owner: sessionOwner(broken.f), port: upstream.port }),
    { code: "PREVIEW_UNAVAILABLE", status: 503, message: /npm run tailscale/ },
  );
  assert.deepEqual(broken.previews.list(), []);
});

test("network mode skips Serve and binds the slot itself", async (t) => {
  const tailscale = fakeTailscale();
  const upstream = await startUpstream(t);
  const { f, range, previews } = await previewApp(t, {
    range: await freePortRange(1),
    remoteUrl,
    network: { enabled: true, bind: "127.0.0.1", hosts: ["preview.lan"] },
    tailscaleRun: tailscale.run,
  });
  assert.deepEqual(tailscale.writes(), []);
  assert.equal((await previews.view()).serve.skipped, "network");
  assert.equal(await portAvailable(range.start), false);
  const opened = await previews.open({ owner: sessionOwner(f), port: upstream.port });
  assert.equal(previews.list()[0].slot, range.start);
  assert.equal(opened.url, `http://preview.lan:${range.start}/`);
});

test("a mode change removes AgentPier's own registrations; back in Tailscale mode only the new range is registered", async (t) => {
  const tailscale = fakeTailscale({
    web: {
      "box.tail.ts.net:9999": { Handlers: { "/": { Proxy: "http://127.0.0.1:1" } } },
    },
  });
  const a = await tailscaleRange(2);
  const { previews } = await previewApp(t, {
    range: a,
    remoteUrl,
    tailscaleRun: tailscale.run,
  });
  assert.deepEqual(Object.keys(tailscale.web).length, 3);
  const tailnet = previews.effective;
  // Network mode on, range B: A's own entries go, the foreign one stays.
  previews.effective = () => ({
    ...tailnet(),
    network: { enabled: true, bind: "127.0.0.1", hosts: [] },
  });
  const b = await tailscaleRange(2);
  const settingsB = { enabled: true, portRangeStart: b.start, portRangeEnd: b.end };
  await previews.configure(settingsB);
  assert.deepEqual(Object.keys(tailscale.web), ["box.tail.ts.net:9999"]);
  assert.equal(await portAvailable(b.start), false);
  // Back to Tailscale with B: only B is registered, at its listener ports.
  previews.effective = tailnet;
  await previews.configure(settingsB);
  assert.deepEqual(
    Object.keys(tailscale.web).sort(),
    ["box.tail.ts.net:9999", ...ports(b).map((slot) => `box.tail.ts.net:${slot}`)].sort(),
  );
  assert.deepEqual((await previews.view()).serve.registered, ports(b));
  assert.equal(await portAvailable(b.start + OFFSET), false);
});

test("a slot taken by a foreign Serve entry does not block its project", async (t) => {
  const upstream = await startUpstream(t);
  const range = await tailscaleRange(2);
  const tailscale = fakeTailscale({
    web: {
      [`box.tail.ts.net:${range.start}`]: {
        Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } },
      },
    },
  });
  let project;
  const { f, previews } = await previewApp(t, {
    range,
    remoteUrl,
    tailscaleRun: tailscale.run,
    // The project's sticky slot is the one another Serve entry holds.
    prepare: async (dataDir) => {
      project = path.join(path.dirname(dataDir), "fixture-project");
      const key = createHash("sha256")
        .update(`${project}\0${upstream.port}`)
        .digest("hex")
        .slice(0, 16);
      await fs.mkdir(path.join(dataDir, "previews"), { recursive: true });
      await fs.writeFile(
        path.join(dataDir, "previews", "slots.json"),
        JSON.stringify({ [range.start]: key }),
      );
    },
  });
  assert.equal(f.project, project);
  const serve = (await previews.view()).serve;
  assert.deepEqual(serve.registered, [range.end]);
  assert.deepEqual(serve.failed, [{ port: range.start, reason: "occupied" }]);
  const opened = await previews.open({ owner: sessionOwner(f), port: upstream.port });
  assert.equal(previews.list()[0].slot, range.end);
  assert.equal(opened.url, `https://box.tail.ts.net:${range.end}/`);
});
