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
  const chromium = { up: false, launches: [], sockets: [] };
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
      chromium.sockets.push(this);
      setImmediate(() => this.onopen?.());
    }
    send(text) {
      this.sent.push(JSON.parse(text));
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
  assert.deepEqual(config.browser, {
    backend: "off",
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
