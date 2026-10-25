import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { workflowFixture } from "../helpers/assistant-workflow-fixture.js";
import { leadShareFixture } from "../helpers/lead-share-fixture.js";
import { TeamBridge } from "../../server/features/assistants/team-bridge.js";
import { NativeReminders } from "../../server/features/assistants/native-reminders.js";
import { NativeRoutines } from "../../server/features/assistants/native-routines.js";
import { AgentHooks } from "../../server/features/assistants/agent-hooks.js";
import { invokeHook } from "../../server/features/assistants/agent-hook-proposals.js";
import {
  hookDefaults,
  hookTools,
} from "../../server/features/assistants/agent-hook-rights.js";
import { hookActions } from "../../server/features/assistants/agent-hook-bridge.js";
import { pairedTelegram } from "../../server/features/assistants/team-coding.js";
import { toolError } from "../../server/features/assistants/tool-errors.js";
import {
  actions,
  bridgeTool,
  routineActions,
} from "../../server/features/assistants/team-bridge-actions.js";
import {
  lockedTools,
  profileTools,
  routineTools,
} from "../../server/features/assistants/native-capabilities.js";
import { nativeTools } from "../../server/features/assistants/runtime-config.js";
import { actionItem } from "../../server/features/inbox/inbox-items.js";
import { inboxCopy as inboxEn } from "../../web/lib/i18n/en/inbox.js";
import { inboxCopy as inboxDe } from "../../web/lib/i18n/de/inbox.js";

const proposal = {
  action: "propose",
  name: "Zabbix",
  sender: "zabbix01",
  reason: "The owner wants to hear about disk alarms.",
  instruction: "Check which log grew.",
  rights: { research: true },
  hourlyLimit: 5,
};

// The real workflows (Telegram paired, in German) with the hook service of an agent
// that may hold hooks and search the web. `call` is an agentpier_hook call in a turn
// whose trusted context is `origin` (an owner turn by default).
async function setup(t) {
  const f = await workflowFixture(t);
  const agent = f.store.getAssistant(f.id);
  f.store.updateAssistant(
    f.id,
    { capabilities: { memory: false, reminders: true, webSearch: true } },
    agent.revision,
  );
  f.assistants.config = { apply: async () => {}, mcpTools: () => [] };
  const reminders = new NativeReminders({
    assistants: f.assistants,
    channels: f.service,
    dataDir: f.dataDir,
    notifications: { notify: async () => {} },
  });
  t.after(() => reminders.close());
  const routines = new NativeRoutines({ reminders });
  f.assistants.routines = routines;
  const hooks = new AgentHooks({
    reminders,
    routines,
    notifications: { notify: async () => {} },
    addresses: (id) => ({ local: `http://127.0.0.1:4380/hooks/${id}`, tailscale: null }),
  });
  t.after(() => hooks.runs.close());
  const call = async (input, origin = { kind: "owner" }) =>
    invokeHook(hooks, await f.invocation(randomUUID(), origin), input);
  const pending = () =>
    f.workflows.store
      .list(f.id)
      .filter((a) => a.payload.action === "hook_proposal")
      .at(-1);
  const texts = () => f.service.outbox.all(f.channel.id).map((e) => e.text);
  const setCaps = (capabilities) => {
    const current = f.store.getAssistant(f.id);
    f.store.updateAssistant(f.id, { capabilities }, current.revision);
  };
  return { ...f, hooks, call, pending, texts, setCaps };
}

test("the agent proposes a hook only in a direct owner turn", async (t) => {
  const f = await setup(t);
  const refused = { key: "hookOwnerOnly", status: 403 };
  for (const origin of [
    { kind: "owner", forwarded: true },
    { kind: "telegram", forwarded: true },
    { kind: "member-result", requestId: "member-request" },
    { kind: "memory-step" },
    { kind: "lead-request", requestId: "lead-request" },
  ])
    await assert.rejects(f.call(proposal, origin), refused, origin.kind);
  // A routine's or a hook's own run, and a command's completion, have no owner turn.
  const run = { attemptId: null, toolCallId: "call", assertCurrent() {} };
  for (const bound of [
    { routine: { binding: { id: "routine" } } },
    { hook: { event: { id: "event" } } },
    { continuation: { attemptId: "attempt" } },
  ])
    assert.throws(() => invokeHook(f.hooks, { ...run, ...bound }, proposal), refused);
  await assert.rejects(
    f.call({ action: "list" }, { kind: "owner", forwarded: true }),
    refused,
  );
  assert.equal(toolError({ key: "hookOwnerOnly", status: 403 }).code, "HOOK_OWNER_ONLY");
  assert.equal(f.pending(), undefined);

  // The owner's own turn: an approval card, sent to the paired Telegram chat too.
  const invocation = await f.invocation("owner-call");
  const result = await invokeHook(f.hooks, invocation, proposal);
  assert.equal(result.status, "approval_requested");
  const action = f.pending();
  assert.equal(result.proposalId, action.id);
  assert.equal(action.key, `hook-proposal:${invocation.attemptId}:owner-call`);
  assert.equal(action.state, "awaiting_approval");
  assert.deepEqual(action.payload, {
    action: "hook_proposal",
    approval: true,
    name: "Zabbix",
    sender: "zabbix01",
    reason: proposal.reason,
    instruction: proposal.instruction,
    rights: { ...hookDefaults, research: true, sshHosts: [], folders: {} },
    hourlyLimit: 5,
  });
  assert.deepEqual(action.telegram, pairedTelegram(f.workflows, f.id));
  assert.deepEqual(f.hooks.store.list(f.id), []);
  const [card] = f.service.outbox.all(f.channel.id);
  assert.match(card.text, /Zabbix/);
  assert.match(card.text, /zabbix01/);
  assert.match(card.text, /Festplatten|disk alarms/);
  assert.match(card.text, /Webrecherche/);
  assert.deepEqual(
    card.actions.map((a) => a.decision),
    ["approve", "decline"],
  );
  // A right the agent does not hold is refused before anything is proposed.
  await assert.rejects(f.call({ ...proposal, rights: { memory: true } }), {
    key: "hookRightExceeds",
    status: 400,
  });
  // An agent with reminders off may not hold hooks at all.
  f.setCaps({ memory: false, reminders: false, webSearch: true });
  await assert.rejects(f.call(proposal), { key: "hookUnavailable", status: 403 });
});

test("approving creates the hook without a secret, from Telegram too", async (t) => {
  const f = await setup(t);
  await f.call(proposal);
  const action = f.pending();
  const telegram = { kind: "telegram", ...pairedTelegram(f.workflows, f.id) };
  // Edited rights come only from the owner's browser, never from a Telegram button.
  await assert.rejects(
    f.workflows.decide(
      action.id,
      { revision: action.revision, decision: "approve", rights: {} },
      telegram,
    ),
    { key: "invalid" },
  );
  const decided = await f.workflows.decide(
    action.id,
    { revision: action.revision, decision: "approve" },
    telegram,
  );
  assert.equal(decided.state, "completed");
  const [hook] = f.hooks.store.list(f.id);
  assert.deepEqual(decided.result, { hookId: hook.id });
  assert.equal(hook.secretHash, null);
  assert.equal(hook.createdBy, "assistant");
  assert.equal(hook.proposalId, action.id);
  assert.equal(hook.name, "Zabbix");
  assert.equal(hook.instruction, proposal.instruction);
  assert.equal(hook.hourlyLimit, 5);
  assert.equal(hook.rights.research, true);
  const view = f.hooks.list(f.id).hooks[0];
  assert.equal(view.secretSet, false);
  await f.workflows.tick();
  const settled = f.workflows.store.get(action.id);
  assert.equal(settled.settled, true);
  const texts = f.texts();
  assert.equal(texts.length, 2);
  // The result notice points to the browser for the secret and never holds one.
  assert.match(texts[1], /Browser/);
  for (const text of texts) {
    assert.ok(!text.includes("aph_"), text);
    assert.ok(!text.includes(hook.id), text);
  }
  // Decided once: the same button again is a conflict.
  await assert.rejects(
    f.workflows.decide(
      action.id,
      { revision: action.revision, decision: "approve" },
      telegram,
    ),
    { status: 409 },
  );
});

test("a declined proposal creates nothing", async (t) => {
  const f = await setup(t);
  await f.call(proposal);
  const action = f.pending();
  const declined = await f.workflows.decide(
    action.id,
    { revision: action.revision, decision: "decline" },
    { kind: "owner", channel: "ui" },
  );
  assert.equal(declined.state, "declined");
  assert.deepEqual(f.hooks.store.list(f.id), []);
});

test("the owner's edited rights apply on approval, within the ceiling", async (t) => {
  const f = await setup(t);
  await f.call(proposal);
  let action = f.pending();
  const owner = { kind: "owner", channel: "ui" };
  // A malformed edit is refused and leaves the proposal open.
  await assert.rejects(
    f.workflows.decide(
      action.id,
      { revision: action.revision, decision: "approve", rights: { research: "yes" } },
      owner,
    ),
    { key: "invalid", status: 400 },
  );
  assert.equal(f.workflows.store.get(action.id).state, "awaiting_approval");
  const decided = await f.workflows.decide(
    action.id,
    {
      revision: action.revision,
      decision: "approve",
      rights: { research: false, telegram: true, notify: true },
    },
    owner,
  );
  assert.equal(decided.state, "completed");
  const hook = f.hooks.store.get(decided.result.hookId);
  assert.equal(hook.rights.research, false);
  assert.equal(hook.rights.telegram, true);
  // An edit above what the agent holds fails like a right the agent lost.
  await f.call(proposal);
  action = f.pending();
  const raised = await f.workflows.decide(
    action.id,
    { revision: action.revision, decision: "approve", rights: { memory: true } },
    owner,
  );
  assert.equal(raised.state, "failed");
  assert.equal(raised.diagnostic, "RIGHTS_CHANGED");
  assert.equal(f.hooks.store.list(f.id).length, 1);
});

test("a proposal whose rights the agent lost fails on approval", async (t) => {
  const f = await setup(t);
  await f.call(proposal);
  const action = f.pending();
  f.setCaps({ memory: false, reminders: true, webSearch: false });
  const decided = await f.workflows.decide(
    action.id,
    { revision: action.revision, decision: "approve" },
    { kind: "owner", channel: "ui" },
  );
  assert.equal(decided.state, "failed");
  assert.equal(decided.diagnostic, "RIGHTS_CHANGED");
  assert.deepEqual(f.hooks.store.list(f.id), []);
  await f.workflows.tick();
  assert.equal(f.workflows.store.get(action.id).settled, true);
  assert.equal(f.texts().length, 2);
  assert.match(f.texts()[1], /nicht angelegt/);
});

test("list shows the agent addresses and never a secret", async (t) => {
  const f = await setup(t);
  const { hook, secret } = f.hooks.create(f.id, {
    name: "Zabbix",
    sender: "zabbix01",
    rights: { research: true },
  });
  const stored = f.hooks.store.get(hook.id);
  // The agent lost web search: the list shows the right it holds now.
  f.setCaps({ memory: false, reminders: true, webSearch: false });
  const listed = await f.call({ action: "list" });
  assert.deepEqual(listed, {
    hooks: [
      {
        id: hook.id,
        name: "Zabbix",
        sender: "zabbix01",
        enabled: true,
        active: true,
        rights: { ...hookDefaults, sshHosts: [], folders: {} },
        addresses: { local: `http://127.0.0.1:4380/hooks/${hook.id}`, tailscale: null },
      },
    ],
  });
  const text = JSON.stringify(listed);
  assert.ok(!text.includes(secret));
  assert.ok(!text.includes(stored.secretHash));
  assert.ok(!text.includes("aph_"));
  await assert.rejects(f.call({ action: "list", name: "x" }), { key: "invalid" });
  await assert.rejects(f.call({ action: "remove" }), { key: "invalid" });
});

test("the inbox lists the proposal with the hook name", () => {
  const item = actionItem(
    {
      id: "a1",
      assistantId: "agent",
      conversationId: "chat",
      state: "awaiting_approval",
      revision: 1,
      createdAt: "2026-10-25T10:00:00.000Z",
      expiresAt: Date.parse("2026-10-26T10:00:00.000Z"),
      payload: { action: "hook_proposal", approval: true, name: "Zabbix alarms" },
    },
    new Map([["agent", { name: "Home" }]]),
    [{ id: "chat", assistantId: "agent" }],
  );
  assert.equal(item.kind, "hook_proposal");
  assert.equal(item.tab, "agents");
  assert.equal(item.title, "Zabbix alarms");
  assert.equal(item.link, "/agents/agent/chats/chat");
  assert.equal(inboxEn.kinds.hook_proposal, "Hook proposal");
  assert.equal(inboxDe.kinds.hook_proposal, "Hook-Vorschlag");
});

test("agentpier_hook is compiled for own agents and permanent members, never for shared or user agents or routines", () => {
  const caps = { memory: false, reminders: true };
  const tools = (agent) =>
    profileTools({ capabilities: caps, ...agent }, true, true, true);
  assert.ok(tools({ id: "a" }).includes("agentpier_hook"));
  assert.ok(
    tools({ id: "a", teamMemberId: "m", lifetime: "permanent" }).includes(
      "agentpier_hook",
    ),
  );
  for (const agent of [
    { id: "a", teamMemberId: "m", lifetime: "task" },
    { id: "a", archivedAt: "2026-10-20" },
    { id: "a", userAccess: { mode: "shared", members: [], released: [] } },
    { id: "a", userAccess: { mode: "personal", members: [], released: [] } },
    { id: "a", capabilities: { memory: false, reminders: false } },
  ])
    assert.ok(!tools(agent).includes("agentpier_hook"), JSON.stringify(agent));
  assert.ok(
    !profileTools({ id: "a", capabilities: caps }, true, false).includes(
      "agentpier_hook",
    ),
  );
  // Never in a routine's or a hook's own run.
  assert.ok(!routineTools.includes("agentpier_hook"));
  const all = {
    ...hookDefaults,
    telegram: true,
    research: true,
    coding: true,
    shell: "full",
    sshHosts: ["h"],
    folders: { p: "write" },
    memory: true,
    mcp: true,
  };
  assert.ok(
    !hookTools(all, { webSearch: true, webFetch: true }).includes("agentpier_hook"),
  );
  assert.ok(!routineActions.has("hook"));
  assert.ok(!hookActions.has("hook"));
  // The bridge serves it under its own name; the Gateway allows and locks it.
  assert.ok(actions.has("hook"));
  assert.equal(bridgeTool("hook"), "agentpier_hook");
  assert.ok(nativeTools.includes("agentpier_hook"));
  assert.ok(lockedTools.includes("agentpier_hook"));
});

test("a permanent member proposes a hook through the bridge in the owner's own turn", async (t) => {
  const f = await leadShareFixture(t);
  const id = f.member.assistantId;
  const stored = f.store.storedAssistant(id);
  f.store.db.prepare("UPDATE assistants SET body=? WHERE id=?").run(
    JSON.stringify({
      ...stored,
      capabilities: { ...stored.capabilities, reminders: true },
    }),
    id,
  );
  f.assistants.config = { ...f.assistants.config, mcpTools: () => [] };
  const reminders = new NativeReminders({
    assistants: f.assistants,
    channels: f.service,
    dataDir: f.dataDir,
    notifications: { notify: async () => {} },
  });
  t.after(() => reminders.close());
  const routines = new NativeRoutines({ reminders });
  f.assistants.routines = routines;
  const hooks = new AgentHooks({
    reminders,
    routines,
    notifications: { notify: async () => {} },
    addresses: (hookId) => ({ local: `http://127.0.0.1:4380/hooks/${hookId}` }),
  });
  t.after(() => hooks.runs.close());
  f.assistants.runtime.generation = 1;
  const bridge = new TeamBridge({ assistants: f.assistants, teams: {} });
  await bridge.start();
  t.after(() => bridge.close());
  const agentId = f.store.getAssistant(id).runtimeAgentId;
  const call = (input) => {
    const { ticket } = bridge.prepare({
      agentId,
      sessionKey: f.memberChat.runtimeSessionKey,
      toolCallId: randomUUID(),
      action: "hook",
    });
    return bridge.invoke({ ticket, action: "hook", input });
  };
  // The owner's own message in the member's chat.
  const owner = await f.turn(f.memberChat.id);
  const result = await call({ ...proposal, rights: {} });
  assert.equal(result.status, "approval_requested");
  const action = f.workflows.store.get(result.proposalId);
  assert.equal(action.assistantId, id);
  assert.equal(action.conversationId, f.memberChat.id);
  assert.equal(action.attemptId, owner.attemptId);
  assert.equal(action.payload.name, "Zabbix");
  assert.deepEqual((await call({ action: "list" })).hooks, []);
  f.assistants.ledger.transition(owner.attemptId, "completed");
  // A forwarded message in that chat is no owner turn.
  await f.turn(f.memberChat.id, { kind: "owner", forwarded: true });
  await assert.rejects(call(proposal), (error) => {
    assert.equal(toolError(error).code, "HOOK_OWNER_ONLY");
    return true;
  });
});
