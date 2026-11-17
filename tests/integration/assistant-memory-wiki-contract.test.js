import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { contractTimeout } from "../helpers/contract-timeout.js";
import { compiledShell } from "../helpers/assistant-shell-compiled.js";
import { createGatewaySession } from "../../server/features/assistants/runtimes/openclaw/session-create.js";
import {
  wikiConfig,
  wikiPlugin,
  wikiTools,
} from "../../server/features/assistants/runtimes/openclaw/openclaw-config/memory-wiki.js";
import { stripOpenClawRows } from "../../server/features/operations/private-tables.js";

// OpenClaw's memory wiki against the pinned Gateway (ADR 0007, step 7b). AgentPier
// loads the bundled plugin `memory-wiki` while an owner's own agent keeps a wiki, one
// vault per agent in bridge mode, and grants its five tools to those agents alone.
// The Gateway must accept that configuration, offer the tools to that agent's
// sessions only, keep the prompt of an agent without them free of the wiki, import
// the agent's own memory notes, let a real turn file a page with `wiki_apply`, and
// record nothing in its state rows that a public backup copy would keep.
const installed = process.env.AGENTPIER_SHELL_CONTRACT_RUNTIME;
const options = {
  skip: !installed && "set AGENTPIER_SHELL_CONTRACT_RUNTIME",
  timeout: contractTimeout(400000),
};
const on = { openclaw: { memoryWiki: true } };
const shared = {
  mode: "shared",
  members: [{ userId: "user-fixture", level: "chat" }],
  released: [],
};

// What the Gateway itself says a session of the agent may call.
async function effective(h, agentId, label) {
  const session = await createGatewaySession(h.runtime.client, { agentId, label });
  const result = await h.runtime.client.call("tools.effective", {
    agentId,
    sessionKey: session.key,
  });
  return (result.groups || []).flatMap((group) => group.tools.map((tool) => tool.id));
}
const systemOf = (h, label) =>
  h.model.requests
    .filter((r) => JSON.stringify(r.messages).includes(`[cmd:${label}]`))
    .flatMap((r) => r.messages || [])
    .filter((m) => m.role === "system")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\n");
const hasWikiTool = (tools) => tools.some((tool) => wikiTools.includes(tool));
function files(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }))
    if (entry.isDirectory()) files(path.join(dir, entry.name), out);
    else out.push(path.join(dir, entry.name));
  return out;
}

test(
  "the Gateway runs the compiled wiki for the agent that keeps one, and only for it",
  options,
  async (t) => {
    const calls = new Map();
    const h = await compiledShell(t, installed, {
      prefix: "memory-wiki-",
      tool: (input) => {
        const text = JSON.stringify(input.messages);
        for (const [marker, call] of calls) if (text.includes(marker)) return call;
        return null;
      },
    });
    const { store } = h;
    const keeper = h.create("Keeper");
    const plain = h.create("Plain");
    const user = h.create("User");
    store.updateAssistant(keeper.id, { runtimeOptions: on }, keeper.revision);
    // Written past the routes, which refuse it for an agent shared with users.
    store.changeUserAgent(user.id, { runtimeOptions: on, userAccess: shared });
    const idOf = (agent) => store.getAssistant(agent.id).runtimeAgentId;
    const note = (agent, name, text) => {
      const file = path.join(h.runtime.paths.workspaces, agent.id, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    };
    note(keeper, "MEMORY.md", "# Memory\n\n- The owner likes quartz.\n");
    note(keeper, "memory/2026-11-17.md", "# 2026-11-17\n\n- Talked about slate.\n");
    note(plain, "MEMORY.md", "# Memory\n\n- PLAIN-ONLY fact.\n");
    note(user, "MEMORY.md", "# Memory\n\n- USER-ONLY fact.\n");
    await h.runtime.start();
    for (const agent of [keeper, plain, user]) await h.config.apply(agent.id);

    // The configuration as compiled, accepted by the Gateway.
    const running = await h.running();
    assert.ok(running.plugins.allow.includes(wikiPlugin));
    assert.deepEqual(running.plugins.entries[wikiPlugin], {
      enabled: true,
      config: wikiConfig(),
    });
    assert.deepEqual(running.tools.allow.slice(-5), wikiTools);
    assert.deepEqual(running.memory.search.enabled, false);
    assert.equal(h.runtime.memoryWiki, true);

    // Offered to the keeper alone: the Gateway's view and a real turn's tool list.
    const offered = await effective(h, idOf(keeper), "keeper-effective");
    assert.deepEqual(
      offered.filter((tool) => wikiTools.includes(tool)).sort(),
      [...wikiTools].sort(),
    );
    for (const agent of [plain, user])
      assert.equal(
        hasWikiTool(await effective(h, idOf(agent), `${agent.name}-e`)),
        false,
      );
    const plainTurn = await h.direct(idOf(plain), "plain-turn", "true");
    assert.equal(hasWikiTool(plainTurn.offered), false);
    // The plugin's prompt supplement names only tools the agent holds: an agent
    // without them reads no wiki section, and no bundled wiki skill reaches it.
    const plainPrompt = systemOf(h, "plain-turn");
    t.diagnostic(`plain prompt mentions wiki: ${/wiki/i.test(plainPrompt)}`);
    assert.equal(plainPrompt.includes("Compiled Wiki"), false);
    assert.equal(/wiki_(status|search|get|apply|lint)/.test(plainPrompt), false);
    assert.equal(plainPrompt.includes("wiki-maintainer"), false);

    // The keeper's first wiki call imports its own memory notes (bridge mode).
    calls.set("[cmd:status]", { name: "wiki_status", arguments: {} });
    const status = await h.direct(idOf(keeper), "status", "true");
    t.diagnostic(`wiki_status: ${status.result}`);
    assert.match(status.result, /Bridge: enabled \(2 exported artifacts\)/);
    const keeperPrompt = systemOf(h, "status");
    assert.ok(keeperPrompt.includes("## Compiled Wiki"));
    const vault = path.join(h.runtime.paths.state, "wiki", idOf(keeper));
    const source = files(path.join(vault, "sources")).find((file) =>
      /-memory-[0-9a-f]+\.md$/.test(file),
    );
    const sourceId = /^id:\s*(.+)$/m.exec(fs.readFileSync(source, "utf8"))[1].trim();

    // A real turn files a synthesis citing that note, then lints the vault.
    calls.set("[cmd:apply]", {
      name: "wiki_apply",
      arguments: {
        op: "create_synthesis",
        title: "Quartz Notes",
        body: "Quartz is grey and the owner likes it.",
        sourceIds: [sourceId],
        claims: [{ text: "The owner likes quartz.", confidence: 0.8 }],
      },
    });
    const applied = await h.direct(idOf(keeper), "apply", "true");
    assert.match(applied.result, /syntheses\/quartz-notes\.md via create_synthesis/);
    calls.set("[cmd:lint]", { name: "wiki_lint", arguments: {} });
    assert.match((await h.direct(idOf(keeper), "lint", "true")).result, /Issues:/);
    assert.ok(fs.existsSync(path.join(vault, "syntheses", "quartz-notes.md")));

    // No vault for the others, and nothing of their notes in any vault.
    for (const agent of [plain, user])
      assert.equal(
        fs.existsSync(path.join(h.runtime.paths.state, "wiki", idOf(agent))),
        false,
      );
    const wikiText = files(path.join(h.runtime.paths.state, "wiki"))
      .map((file) => fs.readFileSync(file, "utf8"))
      .join("\n");
    assert.equal(/PLAIN-ONLY|USER-ONLY/.test(wikiText), false);

    // The plugin's state rows name the imported notes' paths, never their text; the
    // public backup copy keeps none of them.
    const database = path.join(h.runtime.paths.state, "state", "openclaw.sqlite");
    const copy = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "wiki-rows-")),
      "copy.sqlite",
    );
    t.after(() => fs.rmSync(path.dirname(copy), { recursive: true, force: true }));
    const live = new DatabaseSync(database, { readOnly: true });
    const rows = live
      .prepare("SELECT namespace, value_json FROM plugin_state_entries WHERE plugin_id=?")
      .all(wikiPlugin);
    live.exec(`VACUUM INTO '${copy.replaceAll("'", "''")}'`);
    live.close();
    t.diagnostic(`wiki state rows: ${JSON.stringify(rows.map((r) => r.namespace))}`);
    assert.ok(rows.length >= 2);
    assert.ok(rows.some((r) => r.value_json.includes(path.join(keeper.id, "MEMORY.md"))));
    assert.equal(
      rows.some((r) => r.value_json.includes("likes quartz")),
      false,
    );
    const stripped = new DatabaseSync(copy);
    stripOpenClawRows(stripped);
    assert.equal(
      stripped
        .prepare("SELECT COUNT(*) AS n FROM plugin_state_entries WHERE plugin_id=?")
        .get(wikiPlugin).n,
      0,
    );
    stripped.close();
  },
);

test(
  "a second wiki applies live, and the last one off takes the tools away live",
  options,
  async (t) => {
    const h = await compiledShell(t, installed, { prefix: "memory-wiki-live-" });
    const { store } = h;
    const first = h.create("First");
    const second = h.create("Second");
    store.updateAssistant(first.id, { runtimeOptions: on }, first.revision);
    const idOf = (agent) => store.getAssistant(agent.id).runtimeAgentId;
    const set = (agent, runtimeOptions) =>
      h.assistants.update(
        agent.id,
        { runtimeOptions },
        store.getAssistant(agent.id).revision,
      );
    await h.runtime.start();
    for (const agent of [first, second]) await h.config.apply(agent.id);
    const generation = h.runtime.generation;
    const before = (await h.running()).tools.allow;

    await set(second, on);
    assert.equal(h.runtime.generation, generation, "no restart");
    assert.ok(hasWikiTool(await effective(h, idOf(second), "second-on")));
    assert.deepEqual((await h.running()).tools.allow, before);

    await set(first, {});
    await set(second, {});
    assert.equal(h.runtime.generation, generation, "no restart");
    const after = await h.running();
    assert.equal(hasWikiTool(after.tools.allow), false);
    for (const agent of [first, second])
      assert.equal(
        hasWikiTool(await effective(h, idOf(agent), `${agent.name}-off`)),
        false,
      );
    // The next start leaves the plugin out: the configuration from before the option.
    await h.runtime.restart();
    for (const agent of [first, second]) await h.config.apply(agent.id);
    const restarted = await h.running();
    assert.equal(restarted.plugins.allow.includes(wikiPlugin), false);
    assert.equal(restarted.plugins.entries[wikiPlugin], undefined);
    assert.equal(h.runtime.memoryWiki, false);
  },
);
