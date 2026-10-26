import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { contractTimeout } from "../helpers/contract-timeout.js";
import { GuardedRuntimeSupervisor as RuntimeSupervisor } from "../helpers/process-guard.js";
import { guardProcess } from "../helpers/process-guard.js";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { RequestLedger } from "../../server/features/assistants/request-ledger.js";
import { TeamBridge } from "../../server/features/assistants/team-bridge.js";
import { detectBrowser } from "../../server/features/assistants/browser-detection.js";
import { selectedAssistantRuntime } from "../../server/features/assistants/runtime-install.js";
import { provisionTeamPlugin } from "../../server/features/assistants/team-plugin-install.js";
import { agentProfileName } from "../../server/features/assistants/openclaw-config/browser-profiles.js";
import { AgentBrowsers } from "../../server/features/assistants/agent-browsers.js";
import { antiThrottlingArgs } from "../../server/features/assistants/openclaw-config/web-tools.js";

// A visible agent browser in the state AgentPier leaves it in (AGENTPIER-240,
// docs/assistant-web-tools-qualification.md "Visible window"), provisioned like the
// web tools contracts. It opens a real window: parked in the screen's corner on
// macOS, on a private Xvfb display on Linux without one.
const installed = process.env.AGENTPIER_WEB_TOOLS_CONTRACT_RUNTIME;
const contractDir = process.env.AGENTPIER_ASSISTANT_CONTRACT_DIR;
const options = {
  skip:
    !(installed && contractDir) &&
    "set AGENTPIER_WEB_TOOLS_CONTRACT_RUNTIME and AGENTPIER_ASSISTANT_CONTRACT_DIR",
  timeout: contractTimeout(240000),
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// OpenClaw's browser client gives a snapshot 20 s; a usable browser needs far less.
const snapshotBudgetMs = 10000;

function testBrowser() {
  const named = process.env.AGENTPIER_TEST_BROWSER_PATH;
  const browser = named
    ? { available: fs.existsSync(named), name: "Test", executablePath: named }
    : detectBrowser();
  if (process.env.CI && !browser.available)
    throw Error(
      "No Chromium-based browser for the browser window contract: install one or set AGENTPIER_TEST_BROWSER_PATH.",
    );
  return { ...browser, visible: { available: true } };
}

/** A display for the window: the session's own, or a private Xvfb on Linux. */
async function display(t) {
  if (process.platform === "darwin" || process.env.DISPLAY || process.env.WAYLAND_DISPLAY)
    return true;
  const number = 90 + Math.floor(Math.random() * 400);
  const xvfb = spawn(
    "Xvfb",
    [`:${number}`, "-screen", "0", "1920x1080x24", "-nolisten", "tcp"],
    {
      stdio: "ignore",
    },
  );
  const failed = await new Promise((resolve) => {
    xvfb.once("error", () => resolve(true));
    setTimeout(() => resolve(false), 1000);
  });
  if (failed) {
    if (process.env.CI) throw Error("No Xvfb for the browser window contract.");
    return false;
  }
  guardProcess(t, xvfb);
  process.env.DISPLAY = `:${number}`;
  t.after(() => {
    delete process.env.DISPLAY;
    xvfb.kill();
  });
  return true;
}

// The agent's page over CDP, outside OpenClaw and without the window keeper's focus
// emulation, which is held by the keeper's own session only.
async function pageClient(port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = targets.find((x) => x.type === "page");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    const waiting = pending.get(msg.id);
    if (!waiting) return;
    pending.delete(msg.id);
    msg.error ? waiting.reject(Error(msg.error.message)) : waiting.resolve(msg.result);
  };
  await new Promise((r) => (ws.onopen = r));
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      pending.set(++id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) =>
    (
      await send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      })
    ).result.value;
  await send("Page.navigate", { url: "about:blank" });
  for (let n = 0; n < 40 && (await evaluate("document.readyState")) !== "complete"; n++)
    await sleep(250);
  return { id: target.id, send, evaluate, close: () => ws.close() };
}
// The browser's command line, from the process list (CDP returns it only with
// --enable-automation, which OpenClaw does not pass).
function browserArguments(port) {
  const lines = execFileSync("ps", ["-eww", "-o", "args="], { encoding: "utf8" });
  return (
    lines.split("\n").find((line) => line.includes(`--remote-debugging-port=${port} `)) ||
    ""
  );
}
// A moderately heavy page: 400 rows of a link, a button, a field and text.
const heavyPage = `document.body.innerHTML = Array.from({ length: 400 }, (_, i) =>
  '<div><a href="#r' + i + '">Row ' + i + '</a> <button>Act ' + i + '</button> ' +
  '<input aria-label="Field ' + i + '"> <span>Some text for row ' + i + '</span></div>'
).join(""); document.querySelectorAll("button").length`;
// Animation frames per second, and how long 20 timers of 50 ms take: a hidden or
// throttled page paints no frames and runs timers once a second at best. The frames
// are counted from the page's first frame on, in up to three one-second windows (the
// best one counts). Counted from the probe's start, one stall of over a second before
// the first frame read as one frame a second on two Linux runners; that is latency,
// while a throttled or hidden page stays below the rate in every window.
const frameProbe = `new Promise((done) => {
  const start = performance.now(); const samples = [];
  let first = null, from = 0, frames = 0;
  const tick = (now) => {
    if (first === null) { first = Math.round(performance.now() - start); from = now; }
    else if (now - from < 1000) frames++;
    else {
      samples.push(frames);
      if (frames >= 20 || samples.length === 3) return done({ first, samples });
      frames = 0; from = now;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  setTimeout(() => done({ first, samples: [...samples, frames] }), 8000);
})`;
const timerProbe = `new Promise((done) => {
  let n = 0; const start = performance.now();
  const next = () => (++n < 20 ? setTimeout(next, 50) : done(Math.round(performance.now() - start)));
  setTimeout(next, 50);
})`;

test(
  "a visible agent browser stays unthrottled where AgentPier leaves its window",
  options,
  async (t) => {
    const browser = testBrowser();
    if (!browser.available) return t.skip("no Chromium-based browser installed");
    if (!(await display(t))) return t.skip("no display and no Xvfb");
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-window-"));
    const store = new AssistantStore({ dataDir });
    const ledger = new RequestLedger(store.db);
    const created = store.createAssistant({
      name: "Window",
      instructions: "",
      model: { connectionId: "fixture", modelId: "fixture-model" },
      capabilities: { memory: false, reminders: false, browser: true },
    });
    const agent = store.updateAssistant(
      created.id,
      { browserVisible: true },
      created.revision,
    );
    const runtime = new RuntimeSupervisor({
      dataDir,
      install: async () => {
        const selected = await selectedAssistantRuntime({ dataDir: contractDir });
        return {
          ...selected,
          teamPlugin: provisionTeamPlugin({
            paths: runtime.paths,
            runtimeVersion: selected.version,
          }),
        };
      },
    });
    const browsers = new AgentBrowsers({ store, runtime });
    const bridge = new TeamBridge({
      assistants: { store, ledger, runtime, browsers },
      generation: () => runtime.generation,
      teams: { store: { context: () => ({ kind: "owner" }) } },
    });
    let page = null;
    const own = agentProfileName(agent.id);
    t.after(async () => {
      try {
        page?.close();
        await browsers.stop(own);
        browsers.close();
        await runtime.close();
        await bridge.close();
        store.close();
      } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    });
    runtime.teamConfiguration = async (descriptor) => ({
      directory: descriptor.teamPlugin.directory,
      connection: await bridge.start(),
      hostMaxConcurrent: 4,
      native: { token: "browser-window-fixture" },
      profiles: store.listAssistants(),
      webTools: {
        search: { provider: null },
        browser,
        searchPlugins: descriptor.searchPlugins || {},
        pdf: { ready: false },
        documentExtract: false,
      },
    });
    await runtime.start();
    const entry = runtime.webTools.browserProfiles[own];
    assert.equal(entry.headless, false);

    // The owner's Start in the live view: tracked, then launched by the Gateway.
    let started = Date.now();
    await browsers.ownerStart(agent.id);
    t.diagnostic(`start ${Date.now() - started}ms`);
    const keeper = browsers.running.get(own).keeper;
    for (let n = 0; n < 80 && !keeper.placed.size; n++) await sleep(250);
    assert.equal(keeper.placed.size, 1, "the fresh launch's window is parked");
    page = await pageClient(entry.cdpPort);
    const { windowId } = await page.send("Browser.getWindowForTarget", {
      targetId: page.id,
    });
    const { bounds } = await page.send("Browser.getWindowBounds", { windowId });
    t.diagnostic(`window ${JSON.stringify(bounds)}`);
    assert.equal(bounds.windowState, "normal");
    // In the bottom-right corner of its own screen, a corner of it left visible.
    const screen = await page.evaluate(
      "({ right: screen.availLeft + screen.availWidth, bottom: screen.availTop + screen.availHeight })",
    );
    assert.ok(bounds.left >= screen.right - 60 && bounds.left < screen.right, "left");
    assert.ok(bounds.top >= screen.bottom - 60 && bounds.top < screen.bottom, "top");
    // Parked, the window is not the owner's: it counts as idle for the limits.
    assert.equal(await keeper.inUse(), false);
    assert.equal(await page.evaluate(heavyPage), 400);
    // OpenClaw 2026.10.7 accepts AgentPier's extraArgs and launches with them.
    const args = browserArguments(entry.cdpPort).split(" ");
    for (const flag of antiThrottlingArgs) assert.ok(args.includes(flag), flag);

    const check = async (label) => {
      assert.equal(await page.evaluate("document.visibilityState"), "visible", label);
      const { first, samples } = await page.evaluate(frameProbe);
      const frames = Math.max(...samples);
      const timers = await page.evaluate(timerProbe);
      started = Date.now();
      const snapshot = await runtime.client.request(
        "browser.request",
        {
          method: "GET",
          path: "/snapshot",
          query: { profile: own, targetId: page.id, format: "ai" },
        },
        { timeoutMs: 30000 },
      );
      const snapshotMs = Date.now() - started;
      t.diagnostic(
        `${label}: first frame=${first}ms frames/s=${samples.join(",")} timers=${timers}ms snapshot=${snapshotMs}ms`,
      );
      assert.ok(frames >= 20, `${label}: ${frames} animation frames in a second`);
      assert.ok(timers < 5000, `${label}: 20 timers of 50 ms took ${timers} ms`);
      assert.ok(
        snapshotMs < snapshotBudgetMs,
        `${label}: snapshot took ${snapshotMs} ms`,
      );
      assert.match(snapshot.snapshot, /button "Act 0"/, label);
    };
    await check("parked");
    // AgentPier restarted or lost the browser: the keeper's session and its focus
    // emulation are gone (OpenClaw's Playwright session holds its own), and the
    // parked window still renders at full rate.
    keeper.close();
    await sleep(3000);
    await check("without the keeper");

    // The owner's Stop in the live view ends the browser through the same stop path.
    await browsers.ownerStop(agent.id);
    const status = await runtime.client.request("browser.request", {
      method: "GET",
      path: "/",
      query: { profile: own },
    });
    assert.equal(status.running, false);
  },
);
