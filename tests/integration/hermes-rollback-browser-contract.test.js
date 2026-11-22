import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { contractTimeout } from "../helpers/contract-timeout.js";
import { startFakeModel } from "../helpers/hermes-fake-model.js";
import { eventually } from "../helpers/hermes-fake-runtime.js";
import { hermesContractBrowser, hermesSandbox } from "../helpers/hermes-native.js";
import { hermesFleetApp, json } from "../helpers/hermes-app.js";
import { readHermesConfig } from "../../server/features/assistants/runtimes/hermes/hermes-config/home-merge.js";
import { ensureHermesRuntime } from "../../server/features/assistants/runtimes/hermes/hermes-install.js";
import {
  hermesContractDownload,
  previousHermesManifest,
} from "../../scripts/hermes-contract-downloads.mjs";

// A rollback to the previous pin (tests/fixtures/hermes-previous-manifest.json,
// v0.22.5) keeps a working browser: the home this AgentPier compiles has no
// `browser.backend` and the previous pin's agent-browser is no longer on the agent's
// PATH, so Hermes v0.22.5 runs its own browser_exec (browser-harness, a core
// dependency there too) against AgentPier's Chromium. The previous installation is
// built from its manifest (network: GitHub, PyPI), as in the update contract.
const contractBrowser = hermesContractBrowser();
const options = { skip: contractBrowser.skip, timeout: contractTimeout(1800000) };

test(
  "Hermes contract: on the previous pin, as after a rollback, the agent browses with browser_exec",
  options,
  async (t) => {
    const previous = previousHermesManifest();
    const sandbox = hermesSandbox(t);
    const old = await ensureHermesRuntime({
      dataDir: sandbox.root,
      manifest: previous,
      download: hermesContractDownload(),
    });
    assert.equal(old.version, previous.version);
    const page = http.createServer((_req, res) => {
      res.setHeader("content-type", "text/html");
      res.end("<html><head><title>Rollback page</title></head><body>ok</body></html>");
    });
    await new Promise((resolve) => page.listen(0, "127.0.0.1", resolve));
    t.after(() => page.close());
    const url = `http://127.0.0.1:${page.address().port}/`;
    const model = await startFakeModel();
    t.after(() => model.close());
    const app = await hermesFleetApp(t, model);
    app.fleet.options.runtime = async () => old;
    contractBrowser.use(app);
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
    const created = await app.createAgent({
      name: "Hermes rollback",
      shell: "full",
      confirmShell: true,
      confirmFull: true,
    });
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
    const home = app.fleet.sets.get(agent.runtimeAgentId).supervisor.agentPaths();
    const readConfig = () =>
      readHermesConfig(
        fs.readFileSync(path.join(home.hermesHome, "config.yaml"), "utf8"),
      );
    await eventually(
      () => !readConfig().agent.disabled_toolsets.includes("browser"),
      60000,
      "the browser in the agent's home",
    );
    const runtime = await app.ready(agent);
    assert.equal(runtime.host.version(), previous.version);
    assert.equal(readConfig().browser.backend, undefined);
    const chat = await app.chat(agent);
    const code = `# Opening the page\nnew_tab(${JSON.stringify(url)})\nwait_for_load()\nprint(js("document.title"))`;
    await chat.send("open", `CALL: browser_exec ${JSON.stringify({ code })}`);
    const opened = await chat.reply(/TOOL_DONE:[\s\S]*Rollback page/);
    assert.match(opened.text, /Rollback page/);
  },
);
