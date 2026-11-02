import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { contractTimeout } from "../helpers/contract-timeout.js";
import { startFakeModel } from "../helpers/hermes-fake-model.js";
import { hermesSkip, strayAfterStop } from "../helpers/hermes-native.js";
import { hermesFleetApp } from "../helpers/hermes-app.js";

// AgentPier's own tools on the pinned Hermes (AGENTPIER_HERMES_CONTRACT_RUNTIME): a
// Hermes agent works in AgentPier's own agent workspace, the folder an OpenClaw agent
// works in, and hands the owner a file from it with agentpier_share_file through its
// team plugin and the team bridge. The in-repo fake model drives the tool call.
const options = { skip: hermesSkip, timeout: contractTimeout(900000) };

test(
  "Hermes contract: an agent shares a file of its workspace with agentpier_share_file",
  options,
  async (t) => {
    const model = await startFakeModel();
    t.after(() => model.close());
    const app = await hermesFleetApp(t, model);
    const { fleet } = app;
    const agent = await app.createAgent({ name: "Hermes sharer" });
    const paths = fleet.sets.get(agent.runtimeAgentId).supervisor.agentPaths();
    // Its work folder is AgentPier's agent workspace, as an OpenClaw agent's.
    // <data>/assistants/hermes/state/<runtime agent> → <data>/assistants
    const root = path.dirname(path.dirname(path.dirname(paths.hermesHome)));
    assert.equal(paths.workspace, path.join(root, "workspaces", agent.id));
    fs.writeFileSync(path.join(paths.workspace, "report.md"), "# Report\n");
    const tools = JSON.parse(
      fs.readFileSync(path.join(paths.hermesHome, "plugins/agentpier-team/tools.json")),
    ).tools.map((tool) => tool.name);
    assert.ok(tools.includes("agentpier_share_file"));

    const chat = await app.chat(agent);
    await chat.send(
      "share",
      `Please send me the report.\nCALL: agentpier_share_file ${JSON.stringify({ path: "report.md" })}`,
    );
    const shared = await chat.reply("TOOL_DONE");
    assert.match(shared.text, /"status": "shared"/);
    assert.match(shared.text, /"name": "report.md"/);

    await fleet.close();
    assert.deepEqual(await strayAfterStop({ root: path.dirname(paths.hermesHome) }), []);
  },
);
