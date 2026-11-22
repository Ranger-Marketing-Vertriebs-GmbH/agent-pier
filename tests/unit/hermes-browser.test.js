import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import {
  HermesBrowser,
  chromiumArgs,
  chromiumEnvironment,
} from "../../server/features/assistants/runtimes/hermes/hermes-browser.js";
import { compileHome } from "../../server/features/assistants/runtimes/hermes/hermes-config/home.js";
import { readHermesConfig } from "../../server/features/assistants/runtimes/hermes/hermes-config/home-merge.js";
import { desiredAgent } from "../../server/features/assistants/agent-desired-state.js";

// The Chromium AgentPier runs for a Hermes agent (hermes-browser.js): launched with
// the agent's own profile and a CDP port kept across starts, spoken to through the
// part of OpenClaw's browser control API the live view uses, and relayed as
// OpenClaw's screencast frames.

function fakeChromium(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-browser-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  // `sockets`: page sockets; `guards`: the navigation guard's browser sockets, which
  // answer Fetch.enable unless `refuseGuard`.
  const chromium = { up: false, launches: [], sockets: [], guards: [] };
  const spawn = (file, args, options) => {
    const child = new EventEmitter();
    Object.assign(child, { pid: 999999, exitCode: null, unref() {} });
    chromium.launches.push({ file, args, options });
    chromium.up = true;
    chromium.child = child;
    return child;
  };
  const fetch = async (url) => {
    if (!chromium.up) throw Error("refused");
    const port = new URL(url).port;
    const body = url.endsWith("/json/version")
      ? { webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/b1` }
      : [
          {
            id: "T1",
            type: "page",
            title: "Pier",
            url: "http://127.0.0.1:1/",
            webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/T1`,
          },
          { id: "W1", type: "service_worker", url: "chrome-extension://x/" },
          // A socket off this browser's port is never connected.
          {
            id: "T2",
            type: "page",
            webSocketDebuggerUrl: "ws://evil.test:9/devtools/page/T2",
          },
        ];
    return { ok: true, json: async () => body };
  };
  class FakeSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 1;
      this.sent = [];
      this.browser = /\/devtools\/browser\//.test(url);
      (this.browser ? chromium.guards : chromium.sockets).push(this);
      setImmediate(() => this.onopen?.());
    }
    send(text) {
      const message = JSON.parse(text);
      this.sent.push(message);
      if (this.browser && !chromium.refuseGuard)
        setImmediate(() =>
          this.onmessage?.({ data: JSON.stringify({ id: message.id, result: {} }) }),
        );
    }
    close() {
      this.readyState = 3;
      this.onclose?.();
    }
  }
  const browser = new HermesBrowser({
    directory,
    settings: () => ({ executablePath: "/apps/chromium", headless: true }),
    spawn,
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    fetch,
    WebSocketImpl: FakeSocket,
  });
  return { browser, chromium, directory };
}

test("the agent's Chromium launches once on its own port and profile", async (t) => {
  const { browser, chromium, directory } = fakeChromium(t);
  assert.deepEqual(await browser.request({ method: "GET", path: "/" }), {
    running: false,
  });
  const port = await browser.port();
  assert.equal(await browser.port(), port);
  await browser.request({ method: "POST", path: "/start" });
  await browser.request({ method: "POST", path: "/start" });
  assert.equal(chromium.launches.length, 1);
  const [launch] = chromium.launches;
  assert.equal(launch.file, "/apps/chromium");
  assert.ok(launch.args.includes(`--remote-debugging-port=${port}`));
  assert.ok(launch.args.includes("--remote-debugging-address=127.0.0.1"));
  assert.ok(launch.args.includes(`--user-data-dir=${path.join(directory, "user-data")}`));
  assert.ok(launch.args.includes("--headless=new"));
  assert.equal(launch.options.detached, true);
  assert.ok(launch.args.includes("--disable-gpu"));
  assert.equal(typeof launch.options.env.PATH, "string");
  assert.deepEqual(await browser.request({ method: "GET", path: "/" }), {
    running: true,
  });
  const { tabs } = await browser.request({ method: "GET", path: "/tabs" });
  assert.deepEqual(
    tabs.map((tab) => [tab.targetId, tab.type]),
    [
      ["T1", "page"],
      ["W1", "service_worker"],
      ["T2", "page"],
    ],
  );
  assert.ok(tabs.every((tab) => !("socket" in tab)));
});

test("a launch carries OpenClaw's managed-browser flags, Linux ones on Linux", () => {
  const base = { port: 41234, userData: "/agent/user-data" };
  const linux = chromiumArgs({ ...base, headless: true, platform: "linux" });
  for (const flag of [
    "--headless=new",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--password-store=basic",
    "--use-mock-keychain",
    "--disable-renderer-backgrounding",
    // A direct connection, as OpenClaw's managed browser.
    "--no-proxy-server",
    // A blocked navigation's error page never reloads itself.
    "--disable-auto-reload",
  ])
    assert.ok(linux.includes(flag), flag);
  assert.equal(linux.at(-1), "about:blank");
  // The sandbox is never switched off.
  assert.ok(!linux.some((arg) => /sandbox|zygote/.test(arg)));
  const mac = chromiumArgs({ ...base, headless: false, platform: "darwin" });
  assert.ok(!mac.includes("--headless=new"));
  assert.ok(!mac.includes("--disable-gpu"));
  assert.ok(!mac.includes("--disable-dev-shm-usage"));
  // Linux config and cache homes stay beside the profile unless set.
  assert.deepEqual(
    chromiumEnvironment({ directory: "/agent", platform: "linux", env: { PATH: "/b" } }),
    {
      PATH: "/b",
      XDG_CONFIG_HOME: "/agent/chromium-state",
      XDG_CACHE_HOME: "/agent/chromium-state",
    },
  );
  assert.equal(
    chromiumEnvironment({
      directory: "/agent",
      platform: "linux",
      env: { XDG_CACHE_HOME: "/c" },
    }).XDG_CACHE_HOME,
    "/c",
  );
  assert.deepEqual(
    chromiumEnvironment({ directory: "/agent", platform: "darwin", env: { A: "1" } }),
    { A: "1" },
  );
  // The proxy variables OpenClaw drops from its managed browser's environment.
  assert.deepEqual(
    chromiumEnvironment({
      directory: "/agent",
      platform: "darwin",
      env: {
        A: "1",
        HTTP_PROXY: "http://p",
        https_proxy: "http://p",
        ALL_PROXY: "socks5://p",
        no_proxy: "localhost",
      },
    }),
    { A: "1" },
  );
});

test("a screencast ticket opens once and relays frames in OpenClaw's format", async (t) => {
  const { browser, chromium } = fakeChromium(t);
  await browser.start();
  const ticket = await browser.request({
    method: "POST",
    path: "/screencast",
    body: { maxWidth: 1280, maxHeight: 1280, quality: 60 },
  });
  assert.equal(ticket.targetId, "T1");
  assert.match(ticket.wsPath, /^\/screencast\/[0-9a-f]{32}$/);
  const stream = browser.openStream({ path: ticket.wsPath });
  assert.throws(() => browser.openStream({ path: ticket.wsPath }), {
    code: "BROWSER_TICKET_INVALID",
  });
  assert.throws(() => browser.openStream({ path: "/elsewhere" }), {
    code: "BROWSER_TICKET_INVALID",
  });
  const messages = [];
  stream.on("message", (data, binary) => messages.push({ data, binary }));
  await new Promise((resolve) => setImmediate(resolve));
  const [socket] = chromium.sockets;
  assert.match(socket.url, /^ws:\/\/127\.0\.0\.1:\d+\/devtools\/page\/T1$/);
  assert.deepEqual(
    socket.sent.map((m) => m.method),
    ["Page.enable", "Page.startScreencast"],
  );
  assert.equal(socket.sent[1].params.format, "jpeg");
  assert.equal(JSON.parse(messages[0].data).type, "ready");
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  socket.onmessage({
    data: JSON.stringify({
      method: "Page.screencastFrame",
      params: {
        data: jpeg.toString("base64"),
        sessionId: 7,
        metadata: { deviceWidth: 800, deviceHeight: 600, pageScaleFactor: 1 },
      },
    }),
  });
  assert.deepEqual(socket.sent.at(-1), {
    id: 3,
    method: "Page.screencastFrameAck",
    params: { sessionId: 7 },
  });
  const frame = messages.at(-1);
  assert.equal(frame.binary, true);
  const length = frame.data.readUInt32BE(0);
  const header = JSON.parse(frame.data.subarray(4, 4 + length).toString());
  assert.equal(header.cssWidth, 800);
  assert.equal(header.cssHeight, 600);
  assert.deepEqual(frame.data.subarray(4 + length), jpeg);
  const closed = new Promise((resolve) => stream.once("close", resolve));
  stream.close();
  assert.equal(await closed, 1000);
});

test("a Hermes home with AgentPier's Chromium turns Hermes's browser tools on", () => {
  const agent = desiredAgent({
    id: "a1",
    name: "A1",
    runtimeAgentId: "ap-a1",
    revision: 1,
    capabilities: { browser: true },
  });
  const options = {
    connection: { url: "http://127.0.0.1:4100", token: "t" },
    browser: { cdpUrl: "http://127.0.0.1:41234", allowPrivateNetwork: false },
  };
  const home = compileHome(agent, options);
  const config = readHermesConfig(home.files["config.yaml"]);
  assert.equal(config.agent.disabled_toolsets.includes("browser"), false);
  // Hermes's browser_exec and browser_cdp on that Chromium; v0.22's `backend` goes.
  assert.deepEqual(config.browser, {
    cdp_url: "http://127.0.0.1:41234",
    allow_private_urls: false,
  });
  assert.equal(home.unsupported.includes("browser"), false);
  const settings = JSON.parse(home.files["plugins/agentpier-team/tools.json"]);
  assert.equal(settings.browser, true);
  // Without the guard, or without the agent's own setting, the toolset stays off.
  for (const home of [
    compileHome(agent, { browser: options.browser }),
    compileHome(
      desiredAgent({ id: "a2", runtimeAgentId: "ap-a2", revision: 1 }),
      options,
    ),
  ]) {
    const config = readHermesConfig(home.files["config.yaml"]);
    assert.ok(config.agent.disabled_toolsets.includes("browser"));
    assert.equal(config.browser, undefined);
  }
});

test("a home compiled for Hermes v0.22 loses browser.backend, whatever else it holds", () => {
  const agent = desiredAgent({
    id: "a1",
    name: "A1",
    runtimeAgentId: "ap-a1",
    revision: 1,
  });
  const existing = {
    "config.yaml": "browser:\n  backend: 'off'\n  cdp_url: http://127.0.0.1:41234\n",
  };
  const config = readHermesConfig(compileHome(agent, { existing }).files["config.yaml"]);
  assert.deepEqual(config.browser, { cdp_url: "http://127.0.0.1:41234" });
});

test("the takeover toolbar navigates, focuses and closes tabs of the agent's Chromium", async (t) => {
  const { browser, chromium } = fakeChromium(t);
  const fetched = [];
  const fetch = browser.fetch;
  browser.fetch = async (url, options) => {
    fetched.push(url);
    return fetch(url, options);
  };
  await browser.start();
  const navigating = browser.request({
    method: "POST",
    path: "/navigate",
    body: { url: "https://shop.example/", targetId: "T1" },
  });
  for (let n = 0; n < 5 && !chromium.sockets.at(-1)?.sent.length; n++)
    await new Promise((resolve) => setImmediate(resolve));
  const socket = chromium.sockets.at(-1);
  assert.match(socket.url, /^ws:\/\/127\.0\.0\.1:\d+\/devtools\/page\/T1$/);
  assert.deepEqual(socket.sent, [
    { id: 1, method: "Page.navigate", params: { url: "https://shop.example/" } },
  ]);
  socket.onmessage({ data: JSON.stringify({ id: 1, result: { frameId: "F" } }) });
  assert.deepEqual(await navigating, {
    ok: true,
    targetId: "T1",
    url: "https://shop.example/",
  });
  // Only web addresses, and only on a page socket of this browser.
  // Only web addresses; cloud metadata stays blocked, as for Hermes's own tools.
  for (const url of ["file:///etc/hosts", "http://169.254.169.254/latest/meta-data"])
    await assert.rejects(
      browser.request({ method: "POST", path: "/navigate", body: { url } }),
      { code: "BROWSER_NAVIGATION_BLOCKED" },
    );
  await assert.rejects(
    browser.request({
      method: "POST",
      path: "/navigate",
      body: { url: "https://a.example/", targetId: "T2" },
    }),
    { code: "BROWSER_NO_TAB" },
  );
  await browser.request({
    method: "POST",
    path: "/tabs/focus",
    body: { targetId: "T1" },
  });
  await browser.request({ method: "DELETE", path: "/tabs/T1" });
  assert.deepEqual(
    fetched
      .filter((url) => /\/json\/(activate|close)\//.test(url))
      .map((url) => new URL(url).pathname),
    ["/json/activate/T1", "/json/close/T1"],
  );
  await assert.rejects(
    browser.request({ method: "POST", path: "/tabs/focus", body: {} }),
    { code: "BROWSER_NO_TAB" },
  );
  await assert.rejects(browser.request({ method: "DELETE", path: "/tabs/W1" }), {
    code: "BROWSER_NO_TAB",
  });
});

test("each launch runs the navigation guard on the browser's own socket", async (t) => {
  const { browser, chromium } = fakeChromium(t);
  await browser.start();
  const [guard] = chromium.guards;
  assert.match(guard.url, /^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/b1$/);
  assert.deepEqual(guard.sent[0], {
    id: 1,
    method: "Fetch.enable",
    params: {
      patterns: [{ urlPattern: "*", resourceType: "Document", requestStage: "Request" }],
    },
  });
  const paused = async (url, sessionId) => {
    const before = guard.sent.length;
    guard.onmessage({
      data: JSON.stringify({
        method: "Fetch.requestPaused",
        params: { requestId: url, request: { url } },
        ...(sessionId && { sessionId }),
      }),
    });
    for (let n = 0; n < 10 && guard.sent.length === before; n++)
      await new Promise((resolve) => setImmediate(resolve));
    return guard.sent.at(-1);
  };
  // Private networks are off: a private, loopback or metadata address fails.
  for (const url of [
    "http://10.0.0.5/admin",
    "http://127.0.0.1:8080/",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]/",
  ])
    assert.deepEqual(await paused(url, "S1"), {
      id: guard.sent.length,
      method: "Fetch.failRequest",
      params: { requestId: url, errorReason: "BlockedByClient" },
      sessionId: "S1",
    });
  // A public address, or a name that resolves to one, goes on.
  for (const url of ["https://93.184.216.34/", "https://shop.example/"])
    assert.equal((await paused(url)).method, "Fetch.continueRequest");
  // A guard that is lost stops the browser.
  guard.close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(browser.child, null);
});

test("private networks allowed: only cloud metadata addresses fail", async (t) => {
  const { browser, chromium } = fakeChromium(t);
  browser.settings = () => ({
    executablePath: "/apps/chromium",
    headless: true,
    allowPrivateNetwork: true,
  });
  await browser.start();
  const [guard] = chromium.guards;
  assert.equal(browser.navigationGuard.allowPrivateNetwork, true);
  const { documentAllowed } =
    await import("../../server/features/assistants/runtimes/hermes/hermes-browser-guard.js");
  const lookup = async (host) =>
    host === "metadata.internal.test"
      ? [{ address: "169.254.169.254", family: 4 }]
      : [{ address: "10.0.0.5", family: 4 }];
  const allowed = (url) => documentAllowed(url, { allowPrivateNetwork: true, lookup });
  assert.equal(await allowed("http://10.0.0.5/"), true);
  assert.equal(await allowed("http://nas.local/"), true);
  assert.equal(await allowed("http://169.254.169.254/"), false);
  assert.equal(await allowed("http://metadata.google.internal/"), false);
  assert.equal(await allowed("http://metadata.internal.test/"), false);
  guard.close();
});

test("a browser whose navigation guard cannot start is stopped", async (t) => {
  const { browser, chromium } = fakeChromium(t);
  chromium.refuseGuard = true;
  const closed = browser.request({ method: "POST", path: "/start" });
  // The guard's Fetch.enable gets no answer; its socket closes instead.
  for (let n = 0; n < 50 && !chromium.guards.length; n++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  chromium.guards[0].close();
  await assert.rejects(closed, { code: "BROWSER_START_FAILED" });
  assert.equal(browser.child, null);
});
