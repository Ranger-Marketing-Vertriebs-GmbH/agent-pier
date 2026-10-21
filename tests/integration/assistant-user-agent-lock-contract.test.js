import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { contractTimeout } from "../helpers/contract-timeout.js";
import { compiledShell, confirmFull } from "../helpers/assistant-shell-compiled.js";
import { createGatewaySession } from "../../server/features/assistants/session-create.js";
import { lockedTools } from "../../server/features/users/user-agent-lock.js";

// The hard lock on restricted users' agents (AGENTPIER-180) against the pinned
// Gateway: AgentPier compiles a user agent's entry without shell, SSH, team and
// session tools and with an explicit deny of all of them (user-agent-lock.js), and
// the Gateway's own effective tool list for its sessions (tools.effective) and the
// tools a real turn offers the model must follow it, even when the stored profile
// asks for shell and an owner agent beside it holds shell and team tools.
const installed = process.env.AGENTPIER_SHELL_CONTRACT_RUNTIME;
const options = {
  skip: !installed && "set AGENTPIER_SHELL_CONTRACT_RUNTIME",
  timeout: contractTimeout(300000),
};
const everything = {
  memory: true,
  reminders: true,
  webSearch: true,
  webFetch: true,
  browser: true,
  documents: true,
  readPdfs: true,
  createImages: true,
};
const userAccess = {
  mode: "own",
  members: [{ userId: "user-fixture", level: "extended" }],
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

test(
  "a user agent's compiled entry and effective tools keep the hard lock",
  options,
  async (t) => {
    const h = await compiledShell(t, installed, { prefix: "user-agent-lock-" });
    const { store, at } = h;
    // Everything the lock leaves would otherwise be withheld behind the proven guard.
    h.config.writeGuard = () => true;
    // The same stored profile for both: every capability and shell. The user agent's
    // is written past the routes that refuse shell and a visible browser for it.
    const stored = (agent, fields) =>
      store.db
        .prepare("UPDATE assistants SET body=? WHERE id=?")
        .run(
          JSON.stringify({
            ...store.getAssistant(agent.id),
            capabilities: everything,
            ...fields,
          }),
          agent.id,
        );
    const owner = h.create("Owner");
    await h.level(owner, "full", confirmFull);
    stored(owner, {});
    const user = h.create("User");
    stored(user, { userAccess, shell: "full", browserVisible: true });
    await h.runtime.start();
    for (const agent of [owner, user]) await h.config.apply(agent.id);
    const running = await h.running();
    const entries = running.agents.entries;
    const entryOf = (agent) => entries[store.getAssistant(agent.id).runtimeAgentId];
    assert.ok(running.plugins.allow.includes("agentpier-teams"), "team mode");
    assert.ok(running.tools.allow.includes("exec"), "the owner agent holds shell");
    assert.ok(entryOf(owner).tools.allow.includes("agentpier_team_ask"));

    const entry = entryOf(user);
    t.diagnostic(`user entry tools=${JSON.stringify(entry.tools)}`);
    assert.equal(entry.tools.exec, undefined);
    assert.deepEqual([...entry.tools.deny].sort(), [...lockedTools].sort());
    for (const tool of lockedTools) assert.ok(!entry.tools.allow.includes(tool), tool);

    const userAgentId = store.getAssistant(user.id).runtimeAgentId;
    const offered = await effective(h, userAgentId, "user-effective");
    t.diagnostic(`user effective=${JSON.stringify(offered)}`);
    for (const tool of lockedTools) assert.ok(!offered.includes(tool), tool);
    assert.ok(!offered.some((tool) => /github/i.test(tool)), "no GitHub tool");
    const ownerOffered = await effective(
      h,
      store.getAssistant(owner.id).runtimeAgentId,
      "owner-effective",
    );
    t.diagnostic(`owner effective=${JSON.stringify(ownerOffered)}`);
    for (const tool of ["exec", "process", "agentpier_team_ask", "session_status"])
      assert.ok(ownerOffered.includes(tool), `owner ${tool}`);
    // Everything else the same profile gives the owner's agent stays: web tools and
    // its own workspace files (the browser, image and PDF tools wait for their plugin
    // and models, absent here, for both alike; openclaw-*-config tests compile them).
    assert.deepEqual(
      [...offered].sort(),
      ownerOffered.filter((tool) => !lockedTools.includes(tool)).sort(),
    );
    for (const tool of ["web_fetch", "read", "write", "edit"])
      assert.ok(offered.includes(tool), tool);

    // A real turn: the model is never offered exec, and a call to it runs nothing.
    const turn = await h.direct(userAgentId, "user-turn", `touch ${at("user-turn")}`);
    t.diagnostic(`turn=${JSON.stringify(turn)}`);
    for (const tool of lockedTools) assert.ok(!turn.offered.includes(tool), tool);
    assert.ok(turn.offered.includes("web_fetch"));
    assert.equal(fs.existsSync(at("user-turn")), false);

    // The deny holds on its own: a running entry whose allow names locked tools again.
    await h.runtime.client.call("config.patch", {
      baseHash: (await h.runtime.client.call("config.get", {})).hash,
      raw: JSON.stringify({
        agents: {
          entries: {
            [userAgentId]: { tools: { allow: [...entry.tools.allow, ...lockedTools] } },
          },
        },
      }),
      replacePaths: [`agents.entries.${userAgentId}.tools.allow`],
    });
    const patched = (await h.running()).agents.entries[userAgentId].tools;
    assert.ok(patched.allow.includes("exec"));
    const denied = await effective(h, userAgentId, "user-denied");
    t.diagnostic(`deny alone=${JSON.stringify(denied)}`);
    for (const tool of lockedTools) assert.ok(!denied.includes(tool), tool);
  },
);

test("an own agent kept as the owner's loses the lock's deny", options, async (t) => {
  const h = await compiledShell(t, installed, { prefix: "user-agent-release-" });
  const { store } = h;
  const agent = h.create("Kept");
  store.changeUserAgent(agent.id, { userAccess });
  await h.runtime.start();
  await h.config.apply(agent.id);
  const agentId = store.getAssistant(agent.id).runtimeAgentId;
  const toolsOf = async () => (await h.running()).agents.entries[agentId].tools;
  assert.ok((await toolsOf()).deny.includes("exec"));
  // Its user deleted with "keep" (user-release.js): the agent is the owner's now.
  store.changeUserAgent(agent.id, { userAccess: null });
  await h.level(agent, "full", confirmFull);
  await h.config.apply(agent.id);
  const live = await toolsOf();
  t.diagnostic(`after release=${JSON.stringify(live)}`);
  assert.equal(live.deny, undefined);
  assert.ok(live.allow.includes("exec"));
  assert.ok((await effective(h, agentId, "kept-live")).includes("exec"));
  await h.runtime.restart();
  await h.config.apply(agent.id);
  assert.equal((await toolsOf()).deny, undefined);
});
