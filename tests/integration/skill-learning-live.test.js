import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { AssistantConfig } from "../../server/features/assistants/assistant-config.js";
import { mcpStartSnapshot } from "../../server/features/assistants/runtimes/openclaw/openclaw-config/mcp-servers.js";
import { learningTool } from "../../server/features/assistants/runtimes/openclaw/openclaw-config/skill-learning.js";
import { mcpApplyFixture as fixture, model } from "../helpers/mcp-apply-fixture.js";

// The global learning state on two live paths. A live MCP apply writes the Gateway's global tools.allow as a start does: with
// OpenClaw's learning tool while an agent learns its own skills, and without it
// while the only learner has a Telegram bot for other people (its review would read
// those people's chats), as the start compiles it (ADR 0007 decision 8).
async function boundAllow(t, { senderFacing }) {
  const f = fixture(t);
  const learner = f.agent("Learner");
  f.store.updateAssistant(learner.id, { skillLearning: true }, 1);
  const other = f.agent("Other");
  f.changes.telegramSenders = { connected: (id) => senderFacing && id === learner.id };
  const docs = f.http();
  f.runtime.mcp = mcpStartSnapshot({ profiles: [], mcp: {} }, () => {});
  await f.service.update(other.id, { mcpServers: [docs.id] }, 1);
  assert.equal(f.gateway.patches.length, 1);
  return f.gateway.patches[0].patch.tools.allow;
}

test("a live MCP apply keeps the learning tool for a learner", async (t) => {
  assert.ok((await boundAllow(t, { senderFacing: false })).includes(learningTool));
});

test("a live MCP apply leaves the tool out when the only learner has a bot", async (t) => {
  assert.ok(!(await boundAllow(t, { senderFacing: true })).includes(learningTool));
});

// An agent apply (AssistantConfig.applyOnce) against a stand-in Gateway that keeps
// what each config.patch writes: the global tool and the review mode follow the
// learners, and the only learner with a bot for other people counts as none.
async function applied(t, { senderFacing }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-learning-apply-"));
  const store = new AssistantStore({ dataDir });
  t.after(() => {
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const learner = store.createAssistant({ name: "Learner", model, skillLearning: true });
  const config = {
    tools: { allow: ["session_status"] },
    skills: { workshop: { autonomous: { mode: "off" } } },
    agents: { entries: { [learner.runtimeAgentId]: { model: "c/m" } } },
  };
  const merge = (target, patch) => {
    for (const [key, value] of Object.entries(patch))
      if (value && typeof value === "object" && !Array.isArray(value)) {
        target[key] = target[key] && typeof target[key] === "object" ? target[key] : {};
        merge(target[key], value);
      } else if (value === null) delete target[key];
      else target[key] = value;
  };
  const files = {};
  const client = {
    async call(method, params) {
      if (method === "config.get") return { hash: "h", config: structuredClone(config) };
      if (method === "config.patch") return (merge(config, JSON.parse(params.raw)), {});
      if (method === "agents.list") return { agents: [{ id: learner.runtimeAgentId }] };
      if (method === "agents.update") return {};
      if (method === "agents.files.get")
        return {
          file:
            params.name in files ? { content: files[params.name] } : { missing: true },
        };
      if (method === "agents.files.set")
        return ((files[params.name] = params.content), {});
      assert.fail(method);
    },
  };
  const apply = new AssistantConfig({
    runtime: { client },
    store,
    workspaces: dataDir,
    teamReady: () => true,
    models: { resolve: () => ({ modelRef: "c/m", release() {} }) },
  });
  Object.assign(apply, {
    nativeReady: () => true,
    writeGuard: () => false,
    webToolsAvailable: () => ({}),
    mcpTools: () => [],
    senderFacing: (agent) => senderFacing && agent.id === learner.id,
  });
  await apply.apply(learner.id);
  return { config, entry: config.agents.entries[learner.runtimeAgentId] };
}

test("an agent apply switches the host on for a learner", async (t) => {
  const { config, entry } = await applied(t, { senderFacing: false });
  assert.equal(config.skills.workshop.autonomous.mode, "auto");
  assert.ok(config.tools.allow.includes(learningTool));
  assert.ok(entry.tools.allow.includes(learningTool));
});

test("an agent apply keeps the host off when the only learner has a bot", async (t) => {
  const { config, entry } = await applied(t, { senderFacing: true });
  assert.equal(config.skills.workshop.autonomous.mode, "off");
  assert.ok(!config.tools.allow.includes(learningTool));
  assert.ok(!entry.tools.allow.includes(learningTool));
});
