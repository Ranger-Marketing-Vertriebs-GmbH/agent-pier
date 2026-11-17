import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compilerFor } from "../../server/features/assistants/runtimes/runtime-for.js";
import { desiredState } from "../../server/features/assistants/agent-desired-state.js";
import { agentEntry } from "../../server/features/assistants/runtimes/openclaw/openclaw-config/agent-entry.js";
import { mcpLive } from "../../server/features/assistants/runtimes/openclaw/openclaw-config/mcp-live.js";
import { webToolsSnapshot } from "../../server/features/assistants/runtimes/openclaw/openclaw-config/web-tools.js";
import {
  hasWiki,
  hostWiki,
  wikiPlugin,
  wikiTools,
} from "../../server/features/assistants/runtimes/openclaw/openclaw-config/memory-wiki.js";
import {
  restrictRuntimeOptions,
  validateRuntimeOptions,
} from "../../server/features/assistants/runtimes/runtime-options.js";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { wikiLock } from "../../web/features/assistants/runtimes/openclaw/wiki-rules.js";
import { goldenPaths, goldenScenarios } from "../helpers/openclaw-golden-scenarios.js";

// The owner's decision of 2026-11-17 (step 7b review): an OpenClaw agent whose own
// Telegram bot serves other people keeps no memory wiki, as it learns no skills:
// `wiki_apply` would let strangers' prompts write lasting pages into its knowledge.
// Every path leaves it out; turning it on is refused; a stored value is dropped when
// the agent gets such a bot.
const agent = (id, extra = {}) => ({
  id,
  name: `Agent ${id}`,
  runtimeAgentId: `ap-${id}`,
  revision: 1,
  capabilities: { memory: true },
  ...extra,
});
const wiki = { runtimeOptions: { openclaw: { memoryWiki: true } } };
const ready = { teamsReady: true, nativeReady: true, guardProven: true };
const bot = (assistantId) => ({
  accounts: [
    { assistantId, botId: "b1", token: "111:tok", tokenRevision: 1, people: ["100"] },
  ],
  speech: null,
  unreadable: false,
});
const compile = (profiles, telegram) => {
  const scenario = goldenScenarios["no-tools"]();
  return compilerFor(null).compile({
    desired: desiredState({ ...scenario.teams, profiles, ...(telegram && { telegram }) }),
    existing: {
      agents: {
        defaults: {},
        entries: Object.fromEntries([
          ["main", {}],
          ...profiles.map((p) => [p.runtimeAgentId, {}]),
        ]),
      },
    },
    paths: goldenPaths,
    port: scenario.port,
    token: scenario.token,
    overrides: [],
    runtime: { maintenance: false },
    shell: scenario.shell,
    skillShadows: {},
  });
};
const has = (allow) => allow.some((tool) => wikiTools.includes(tool));

test("an agent with a bot for other people holds no wiki tool", () => {
  const keeper = agent("a1", wiki);
  assert.equal(hasWiki(keeper, { senderFacing: true }), false);
  assert.equal(
    has(agentEntry({}, keeper, { ...ready, senderFacing: true }).tools.allow),
    false,
  );
  assert.equal(hostWiki([keeper], { senderFacing: () => true }), false);
  const compiler = compilerFor(null);
  assert.deepEqual(
    compiler.wiki(keeper, {
      nativeReady: true,
      profiles: [keeper],
      senderFacing: () => true,
    }),
    { tools: [], global: false },
  );
});

test("a start whose only wiki agent has such a bot loads no plugin", () => {
  const config = compile([agent("a1", wiki), agent("a2")], bot("a1"));
  assert.ok(config.channels.telegram.accounts["ap-a1"], "the bot is compiled");
  assert.equal(config.plugins.allow.includes(wikiPlugin), false);
  assert.equal(has(config.tools.allow), false);
  // Another wiki agent without a bot loads it, for itself alone.
  const two = compile([agent("a1", wiki), agent("a3", wiki)], bot("a1"));
  assert.ok(two.plugins.allow.includes(wikiPlugin));
  assert.ok(has(two.agents.entries["ap-a3"].tools.allow));
  assert.equal(has(two.agents.entries["ap-a1"].tools.allow), false);
});

test("the live MCP apply writes the start's list with such an agent", () => {
  const profiles = [agent("a1", wiki), agent("a2")];
  const scenario = goldenScenarios["no-tools"]();
  const started = compile(profiles, bot("a1"));
  const desired = desiredState({ ...scenario.teams, profiles });
  const webTools = webToolsSnapshot({ profiles, webTools: desired.host.webTools });
  const live = mcpLive({
    desired,
    webTools,
    wiki: hostWiki(profiles, { senderFacing: (p) => p.id === "a1" }),
  });
  assert.deepEqual(live.build(started).patch.tools.allow, started.tools.allow);
});

test("turning it on is refused; a stored value goes when the bot comes", (t) => {
  const own = agent("a1", { model: { connectionId: "c", modelId: "m" } });
  assert.throws(
    () =>
      validateRuntimeOptions(
        own,
        { openclaw: { memoryWiki: true } },
        { senderFacing: true },
      ),
    (error) => error.key === "memoryWikiChannelBot" && error.status === 409,
  );
  const dropped = restrictRuntimeOptions({ ...own, ...wiki }, { senderFacing: true });
  assert.equal("runtimeOptions" in dropped, false);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-bot-"));
  const store = new AssistantStore({ dataDir: dir });
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const created = store.createAssistant({
    name: "Owl",
    instructions: "",
    model: { connectionId: "c", modelId: "m" },
  });
  store.updateAssistant(created.id, wiki, created.revision);
  store.restrictOptions(created.id, { senderFacing: true });
  assert.equal(store.getAssistant(created.id).runtimeOptions, undefined);
});

test("the switch shows locked with the reason while the bot is connected", () => {
  assert.equal(wikiLock({ id: "a1", ownChannelBot: true }), "channelBot");
  assert.equal(wikiLock({ id: "a1" }), null);
});
