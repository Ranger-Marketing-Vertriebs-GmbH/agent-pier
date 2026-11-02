import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { contractTimeout } from "../helpers/contract-timeout.js";
import { startFakeModel } from "../helpers/hermes-fake-model.js";
import { eventually } from "../helpers/hermes-fake-runtime.js";
import { hermesSkip, strayAfterStop } from "../helpers/hermes-native.js";
import { hermesFleetApp, json } from "../helpers/hermes-app.js";
import { detectBrowser } from "../../server/features/assistants/browser-detection.js";
import { readHermesConfig } from "../../server/features/assistants/runtimes/hermes/hermes-config/home-merge.js";

// The browser of a Hermes agent on the pinned Hermes (AGENTPIER_HERMES_CONTRACT_RUNTIME)
// with the browser app installed on this machine: AgentPier starts the agent's own
// Chromium when its browser tool asks, Hermes attaches to it through browser.cdp_url
// and opens a local test page with its own browser tool and the provisioned
// agent-browser, and the owner's live view gets frames of that page over
// AgentPier's CDP screencast. The in-repo fake model drives the tool call.
// AgentPier's own detection, unless the environment names the browser to drive (CI:
// the runner's Google Chrome, as for the OpenClaw web tools contract; the Ubuntu
// image's /usr/bin/chromium, which the detection prefers, is an unpacked snapshot
// without a sandbox helper, which AppArmor's user namespace limit stops at once).
const named = process.env.AGENTPIER_TEST_BROWSER_PATH;
const browser = named
  ? {
      available: fs.existsSync(named),
      name: "Test",
      executablePath: named,
      visible: { available: false, reason: "noApp" },
    }
  : detectBrowser();
// CI must exercise the browser; a missing one is a runner problem, not a skip.
if (process.env.CI && !hermesSkip && !browser.available)
  throw Error(
    "No Chromium-based browser for the Hermes browser contract: install one or set AGENTPIER_TEST_BROWSER_PATH.",
  );
const options = {
  skip:
    hermesSkip ||
    (!browser.available && "no Chrome, Chromium, Brave or Edge on this machine"),
  timeout: contractTimeout(900000),
};

test(
  "Hermes contract: the agent browses a local page in its AgentPier-owned Chromium and the live view gets frames",
  options,
  async (t) => {
    const page = http.createServer((_req, res) => {
      res.setHeader("content-type", "text/html");
      res.end(
        "<html><head><title>Pier test page</title></head><body><h1>Hello pier</h1></body></html>",
      );
    });
    await new Promise((resolve) => page.listen(0, "127.0.0.1", resolve));
    t.after(() => page.close());
    const url = `http://127.0.0.1:${page.address().port}/`;
    const model = await startFakeModel();
    t.after(() => model.close());
    const app = await hermesFleetApp(t, model);
    const { assistants, fleet } = app;
    if (named) app.f.application.assistantWebTools.detect = () => browser;
    // A local page is a private address: the owner allows those for agent browsers.
    const network = await json(await app.f.request("/api/assistant-browser-network"));
    await json(
      await app.f.request("/api/assistant-browser-network", {
        method: "PUT",
        body: {
          revision: network.revision,
          allowPrivateNetwork: true,
          confirmRestart: true,
        },
      }),
    );
    const created = await app.createAgent({ name: "Hermes browser" });
    // A new agent starts without web tools; the owner switches the browser on.
    const agent = await json(
      await app.f.request(`/api/assistants/${created.id}`, {
        method: "PATCH",
        body: {
          revision: created.revision,
          capabilities: { ...created.capabilities, browser: true },
          confirmRestart: true,
        },
      }),
    );
    const home = fleet.sets.get(agent.runtimeAgentId).supervisor.agentPaths();
    const readConfig = () =>
      readHermesConfig(
        fs.readFileSync(path.join(home.hermesHome, "config.yaml"), "utf8"),
      );
    await eventually(
      () => !readConfig().agent.disabled_toolsets.includes("browser"),
      60000,
      "the browser in the agent's home",
    );
    await app.ready(agent);
    const config = readConfig();
    assert.equal(config.agent.disabled_toolsets.includes("browser"), false);
    assert.equal(config.browser.backend, "off");
    assert.match(config.browser.cdp_url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(config.browser.allow_private_urls, true);
    const listed = (await json(await app.f.request("/api/assistants"))).assistants.find(
      (a) => a.id === agent.id,
    );
    assert.equal(listed.runtimeInfo.capabilities.browser.available, true);

    // No Chromium runs before the agent's first browser call.
    const port = Number(new URL(config.browser.cdp_url).port);
    const running = async () => {
      try {
        return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok;
      } catch {
        return false;
      }
    };
    assert.equal(await running(), false);
    const chat = await app.chat(agent);
    await chat.send("open", `CALL: browser_navigate ${JSON.stringify({ url })}`);
    const opened = await chat.reply("TOOL_DONE");
    assert.match(opened.text, /Pier test page/);
    assert.equal(await running(), true);
    assert.equal(assistants.browsers.isRunning(agent.id), true);

    // The owner's live view shows the page through AgentPier's CDP screencast.
    const seen = { states: [], frames: [] };
    const view = assistants.liveView.subscribe(agent.id, {
      state: (state) => seen.states.push(state),
      frame: (bytes) => seen.frames.push(bytes),
    });
    t.after(() => view.close());
    await eventually(() => seen.frames.length > 0, 60000, "a live view frame");
    const frame = Buffer.from(seen.frames.at(-1));
    const length = frame.readUInt32BE(0);
    const header = JSON.parse(frame.subarray(4, 4 + length).toString());
    assert.ok(header.cssWidth > 0 && header.cssHeight > 0);
    // The JPEG follows the header.
    assert.deepEqual([...frame.subarray(4 + length, 6 + length)], [0xff, 0xd8]);
    const live = seen.states.at(-1);
    assert.equal(live.status, "live");
    assert.ok(
      live.tabs.some((tab) => tab.url === url && /Pier test page/.test(tab.title)),
    );
    view.close();

    // Stopping the set stops its browser; nothing of it stays behind.
    await fleet.close();
    await eventually(async () => !(await running()), 30000, "the browser to stop");
    assert.deepEqual(await strayAfterStop({ root: path.dirname(home.hermesHome) }), []);
    assert.deepEqual(await strayAfterStop({ root: home.home }), []);
  },
);
