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
import { browserRefusals } from "../../server/features/assistants/team-plugin/tool-guard.js";

// A browser upload of a Hermes agent on the pinned Hermes
// (AGENTPIER_HERMES_CONTRACT_RUNTIME) with the browser app of this machine: the agent
// stages a file of its workspace (agentpier_workspace browser_upload_stage), opens a
// local page with a file field with Hermes's own browser tool, and fills the field with
// agentpier_browser_upload, which AgentPier sets over CDP in the agent's
// AgentPier-owned Chromium; a path AgentPier did not stage is refused. The in-repo
// fake model drives every tool call.
// The browser app: hermesContractBrowser (hermes-native.js).
const contractBrowser = hermesContractBrowser();
const options = {
  skip: contractBrowser.skip,
  timeout: contractTimeout(900000),
};

test(
  "Hermes contract: the agent fills a page's file field with a file AgentPier staged",
  options,
  async (t) => {
    const page = http.createServer((_req, res) => {
      res.setHeader("content-type", "text/html");
      res.end(
        '<html><head><title>Upload page</title></head><body><form><input id="f" type="file" ' +
          "onchange=\"document.title='got ' + this.files[0].name + ' ' + this.files[0].size\">" +
          "</form></body></html>",
      );
    });
    await new Promise((resolve) => page.listen(0, "127.0.0.1", resolve));
    t.after(() => page.close());
    const url = `http://127.0.0.1:${page.address().port}/`;
    const model = await startFakeModel();
    t.after(() => model.close());
    const app = await hermesFleetApp(t, model);
    contractBrowser.use(app);
    const { fleet } = app;
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
    const created = await app.createAgent({ name: "Hermes uploader" });
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
    const tools = () =>
      JSON.parse(
        fs.readFileSync(
          path.join(home.hermesHome, "plugins/agentpier-team/tools.json"),
          "utf8",
        ),
      );
    await eventually(
      () =>
        fs.existsSync(path.join(home.hermesHome, "plugins/agentpier-team/tools.json")) &&
        tools().browserUpload?.name === "agentpier_browser_upload" &&
        !readHermesConfig(
          fs.readFileSync(path.join(home.hermesHome, "config.yaml"), "utf8"),
        ).agent.disabled_toolsets.includes("browser"),
      60000,
      "the browser and its upload tool in the agent's home",
    );
    await app.ready(agent);
    fs.writeFileSync(path.join(home.workspace, "report.txt"), "twelve bytes");

    const chat = await app.chat(agent);
    // The next message once the turn before it has ended (a reply is seen while its
    // turn still settles).
    const send = async (id, text) => {
      let status;
      await eventually(
        async () => {
          const sent = await app.f.request(
            `/api/assistant-conversations/${chat.chat.id}/messages`,
            { method: "POST", body: { clientRequestId: id, text } },
          );
          status = sent.status;
          return [200, 201, 202].includes(status) || status !== 409;
        },
        60000,
        `the message ${id}`,
      );
      assert.ok([200, 201, 202].includes(status), String(status));
    };
    const stage = { action: "browser_upload_stage", path: "report.txt" };
    await send("stage", `CALL: agentpier_workspace ${JSON.stringify(stage)}`);
    const staged = await chat.reply(/TOOL_DONE: .*uploadPath/s);
    const uploadPath = /"uploadPath": "([^"]+)"/.exec(staged.text)[1];
    await send("open", `CALL: browser_navigate ${JSON.stringify({ url })}`);
    await chat.reply(/TOOL_DONE: .*Upload page/s);

    // A path AgentPier did not stage never reaches the page.
    const outside = path.join(home.workspace, "report.txt");
    await send(
      "refuse",
      `CALL: agentpier_browser_upload ${JSON.stringify({ paths: [outside] })}`,
    );
    const refused = await chat.reply(/TOOL_DONE: .*"ok": false/s);
    assert.ok(
      refused.text.includes(browserRefusals.uploadOutside.slice(0, 40)) ||
        refused.text.includes(browserRefusals.uploadNotStaged.slice(0, 40)),
    );

    await send(
      "upload",
      `CALL: agentpier_browser_upload ${JSON.stringify({ paths: [uploadPath] })}`,
    );
    const uploaded = await chat.reply(/TOOL_DONE: .*"ok": true/s);
    assert.match(uploaded.text, /"files": 1/);
    const port = Number(
      new URL(
        readHermesConfig(
          fs.readFileSync(path.join(home.hermesHome, "config.yaml"), "utf8"),
        ).browser.cdp_url,
      ).port,
    );
    await eventually(
      async () =>
        (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).some(
          (tab) => tab.title === "got report.txt 12",
        ),
      30000,
      "the page to see the chosen file",
    );

    await fleet.close();
    assert.deepEqual(await strayAfterStop({ root: path.dirname(home.hermesHome) }), []);
    assert.deepEqual(await strayAfterStop({ root: home.home }), []);
  },
);
