import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { contractTimeout } from "../helpers/contract-timeout.js";
import { startFakeModel } from "../helpers/hermes-fake-model.js";
import { eventually } from "../helpers/hermes-fake-runtime.js";
import { hermesContractBrowser, strayAfterStop } from "../helpers/hermes-native.js";
import { hermesFleetApp, json } from "../helpers/hermes-app.js";
import { readHermesConfig } from "../../server/features/assistants/runtimes/hermes/hermes-config/home-merge.js";

// The browser of a Hermes agent on the pinned Hermes (AGENTPIER_HERMES_CONTRACT_RUNTIME)
// with the browser app installed on this machine: AgentPier starts the agent's own
// Chromium when its browser tool asks, Hermes attaches to it through browser.cdp_url
// and opens a local test page with browser_exec (Python over CDP through
// browser-harness), and the owner's live view gets frames of that page over
// AgentPier's CDP screencast. With private networks off, AgentPier's navigation guard
// keeps the same page out even when the address never appears in the agent's code.
// The in-repo fake model drives the tool calls.
// The browser app: hermesContractBrowser (hermes-native.js).
const contractBrowser = hermesContractBrowser();
const openCode = (url) =>
  `# Opening the test page\nnew_tab(${JSON.stringify(url)})\nwait_for_load()\nprint(js("document.title"))`;
const options = {
  skip: contractBrowser.skip,
  timeout: contractTimeout(900000),
};

test(
  "Hermes contract: the agent browses a local page in its AgentPier-owned Chromium and the live view gets frames",
  options,
  async (t) => {
    let requests = 0;
    const page = http.createServer((_req, res) => {
      requests++;
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
    contractBrowser.use(app);
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
    // browser_exec runs Python on the host: Hermes offers it only with the shell.
    const created = await app.createAgent({
      name: "Hermes browser",
      shell: "full",
      confirmShell: true,
      confirmFull: true,
    });
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
    assert.equal(config.browser.backend, undefined);
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
    await chat.send(
      "open",
      `CALL: browser_exec ${JSON.stringify({ code: openCode(url) })}`,
    );
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

    // Private networks off: the agent's set restarts, and AgentPier's navigation
    // guard keeps the page out although the code never writes its address, so
    // Hermes's own check of the code's addresses cannot see it.
    const current = await json(await app.f.request("/api/assistant-browser-network"));
    await json(
      await app.f.request("/api/assistant-browser-network", {
        method: "PUT",
        body: {
          revision: current.revision,
          allowPrivateNetwork: false,
          confirmRestart: true,
        },
      }),
    );
    await eventually(
      () => readConfig().browser.allow_private_urls === false,
      60000,
      "private networks off in the agent's home",
    );
    await app.ready(agent);
    const seenBefore = requests;
    const hidden = `"http" + "://127.0.0.1:" + str(${page.address().port})`;
    const code = `# Opening the page again\nnew_tab(${hidden})\nwait_for_load()\nprint("AT " + js("location.href"))`;
    // A new chat on the restarted set; a send waits while it still settles.
    const after = await app.chat(agent);
    await eventually(
      async () => {
        try {
          await after.send("blocked", `CALL: browser_exec ${JSON.stringify({ code })}`);
          return true;
        } catch {
          return false;
        }
      },
      60000,
      "the message on the restarted agent",
    );
    const blocked = await after.reply(/TOOL_DONE:[\s\S]*AT /);
    assert.doesNotMatch(blocked.text, /AT http:\/\/127\.0\.0\.1/);
    assert.equal(requests, seenBefore);

    // Stopping the set stops its browser; nothing of it stays behind.
    await fleet.close();
    await eventually(async () => !(await running()), 30000, "the browser to stop");
    assert.deepEqual(await strayAfterStop({ root: path.dirname(home.hermesHome) }), []);
    assert.deepEqual(await strayAfterStop({ root: home.home }), []);
  },
);
