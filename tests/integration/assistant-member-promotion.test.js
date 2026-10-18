import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { memberGrantFixture } from "../helpers/member-grant-fixture.js";
import { teamFixture } from "../helpers/assistant-team-fixture.js";
import { MemberPromotions } from "../../server/features/assistants/member-promotion.js";
import { actionNotes } from "../../server/features/assistants/assistant-action-notifications.js";
import { TeamBridge } from "../../server/features/assistants/team-bridge.js";
import {
  personalCapabilities,
  personalShell,
  personalSkills,
} from "../../server/features/assistants/native-capabilities.js";

// A small stand-in for the MCP server store: bindings per agent.
function fakeServers(bound) {
  return {
    list: () => [
      { id: "s-docs", name: "docs" },
      { id: "s-git", name: "git" },
      { id: "s-mail", name: "mail" },
    ],
    bindings: (_target, id) => bound[id] || [],
    bindingsByTarget: () => ({ ...bound }),
    setBindings: (_target, id, ids) => (bound[id] = [...ids]),
  };
}

async function setup(t, options = {}) {
  const f = await memberGrantFixture(t, options);
  const bound = { [f.id]: ["s-docs", "s-git"] };
  const servers = fakeServers(bound);
  f.teams.servers = () => servers;
  const workspaces = path.join(f.dataDir, "workspaces");
  f.assistants.config = { ...f.assistants.config, workspaces, apply: async () => {} };
  const promotions = new MemberPromotions({
    teams: f.teams,
    assistants: f.assistants,
    audit: f.services.audit,
    onChanged: () => {},
  });
  const promote = async (inv) =>
    promotions.promote(inv || (await f.invocation(randomUUID())), {
      memberId: f.member.id,
    });
  return { ...f, bound, servers, workspaces, promotions, promote };
}

test("a lead promotes its member: grants become its own settings, visibly", async (t) => {
  const f = await setup(t, {
    grants: {
      webSearch: true,
      browser: true,
      memory: true,
      reminders: true,
      skills: ["weather"],
    },
  });
  // A server granted later within the lead's ceiling, and one the lead lost since.
  f.teams.write(f.teams.member(f.member.id), {
    phase: "completed",
    grantedMcpServerIds: ["s-git", "s-mail"],
  });
  const agent = f.agent();
  const own = path.join(f.workspaces, agent.id),
    lead = path.join(f.workspaces, f.id);
  fs.mkdirSync(own, { recursive: true });
  fs.mkdirSync(lead, { recursive: true });
  // Its own memory and the copy of the lead's in memory/lead/.
  fs.mkdirSync(path.join(own, "memory", "lead"), { recursive: true });
  fs.writeFileSync(path.join(own, "MEMORY.md"), "My facts");
  fs.writeFileSync(path.join(own, "memory", "lead", "MEMORY.md"), "Lead facts");
  const result = await f.promote();
  assert.equal(result.status, "promoted");
  const promoted = f.agent();
  assert.equal(promoted.lifetime, "permanent");
  assert.equal("inherited" in promoted, false);
  assert.deepEqual(personalCapabilities(promoted), {
    memory: true,
    reminders: true,
    webSearch: true,
    webFetch: false,
    browser: true,
    documents: false,
    createImages: false,
  });
  assert.deepEqual(personalSkills(promoted), ["weather"]);
  assert.equal(personalShell(promoted), "off");
  // Only its own memory stays: the copy of the lead's memory is gone.
  assert.deepEqual(fs.readdirSync(path.join(own, "memory", "lead")), []);
  assert.equal(fs.readFileSync(path.join(own, "MEMORY.md"), "utf8"), "My facts");
  // The member's effective servers within the lead's ceiling, now its own.
  assert.deepEqual(f.bound[agent.id], ["s-git"]);
  assert.equal(f.teams.member(f.member.id).mcpGranted, true);
  // Independent of the lead from now on.
  const leadNow = f.store.getAssistant(f.id);
  f.store.updateAssistant(
    f.id,
    { capabilities: { ...personalCapabilities(leadNow), browser: false } },
    leadNow.revision,
  );
  assert.equal(personalCapabilities(f.agent()).browser, true);
  // Name and instructions as they were; the lead's place in the hierarchy stays.
  assert.equal(promoted.name, agent.name);
  assert.equal(promoted.instructions, agent.instructions);
  assert.equal(promoted.parentAssistantId, f.id);
  // Visible: history, both chats, the audit and a Telegram notice to the owner.
  assert.equal(f.teams.member(f.member.id).grantLog.at(-1).promoted, true);
  for (const [owner, chat] of [
    [agent.id, f.memberChat.id],
    [f.channel.assistantId, f.channel.conversationId],
  ]) {
    const notes = actionNotes(f.workflows.store.list(owner), chat);
    assert.equal(notes.at(-1).event, "member-promote", owner);
  }
  assert.equal(f.audits.at(-1).details.kind, "member-promote");
  const notice = f.service.outbox
    .all(f.channel.id)
    .find((e) => e.kind === "team-member-promoted");
  assert.ok(notice, "Telegram notice");
  assert.match(notice.text, /Scout/);
});

test("shell and SSH are not carried into the permanent agent", async (t) => {
  const f = await setup(t, {
    memberShellSsh: true,
    grants: { webSearch: true, shell: "approval", ssh: true },
  });
  assert.equal(personalShell(f.agent()), "approval");
  f.teams.write(f.teams.member(f.member.id), { phase: "completed" });
  await f.promote();
  assert.equal(personalShell(f.agent()), "off");
  assert.equal(f.agent().inherited, undefined);
});

test("a lead cannot promote a member mid-turn, archived or another lead's", async (t) => {
  const f = await setup(t);
  const turn = f.assistants.ledger.accept(f.memberChat.id, {
    clientRequestId: "busy",
    text: "Working",
  });
  const busy = f.assistants.ledger.recordAttempt(turn.id);
  await assert.rejects(f.promote(), { key: "active" });
  f.assistants.ledger.transition(busy.id, "completed");
  f.teams.write(f.teams.member(f.member.id), { archivedAt: "2026-10-17" });
  await assert.rejects(f.promote(), { key: "teamGrantMemberEnded" });
  const g = await setup(t);
  const other = g.store.createAssistant({
    name: "Other",
    instructions: "",
    model: { connectionId: "c", modelId: "m" },
  });
  const chat = g.store.saveConversation({
    assistantId: other.id,
    runtimeSessionKey: "o",
  });
  const request = g.assistants.ledger.accept(chat.id, {
    clientRequestId: "o",
    text: "x",
  });
  const attempt = g.assistants.ledger.recordAttempt(request.id);
  await assert.rejects(
    g.promote({ attemptId: attempt.id, toolCallId: "x", assertCurrent() {} }),
    { key: "teamGrantMemberEnded" },
  );
});

test("a member cannot promote itself", async (t) => {
  const f = await setup(t);
  const bridge = new TeamBridge({
    assistants: {
      store: f.store,
      ledger: f.assistants.ledger,
      runtime: { client: { ready: true }, status: () => ({}) },
    },
    teams: {},
  });
  bridge.closed = false;
  const turn = f.assistants.ledger.accept(f.memberChat.id, {
    clientRequestId: "member",
    text: "Go",
  });
  const attempt = f.assistants.ledger.recordAttempt(turn.id);
  assert.throws(
    () =>
      bridge.valid({
        action: "promote",
        attemptId: attempt.id,
        sessionKey: "member-session",
        agentId: f.agent().runtimeAgentId,
        generation: 1,
      }),
    { status: 403 },
  );
});

test("promotion withdraws the member's pending shell card", async (t) => {
  const f = await setup(t, { memberShellSsh: true });
  await f.call({ grants: { shell: "approval" } });
  const card = f.workflows.store
    .list(f.channel.assistantId)
    .find((a) => a.payload.approval && a.state === "awaiting_approval");
  f.teams.write(f.teams.member(f.member.id), { phase: "completed" });
  await f.promote();
  const cancelled = f.workflows.store.get(card.id);
  assert.equal(cancelled.state, "cancelled");
  assert.equal(cancelled.diagnostic, "MEMBER_PROMOTED");
});

test("the team service promotes under admission, once, also when called twice at once", async (t) => {
  const f = teamFixture(t);
  const { team, chat } = await f.proposal({ count: 1 });
  await f.service.reconcile();
  const member = f.service.store.members(team.id)[0];
  f.complete(f.service.store.member(member.id).attemptId);
  await f.service.reconcile();
  const memberChat = f.service.store.member(member.id).conversationId;
  assert.ok(memberChat);
  const inv = () => {
    const request = f.assistants.ledger.accept(chat.id, {
      clientRequestId: randomUUID(),
      text: "Keep it",
    });
    const attempt = f.assistants.ledger.recordAttempt(request.id);
    return { attemptId: attempt.id, toolCallId: randomUUID(), assertCurrent() {} };
  };
  const results = await Promise.allSettled([
    f.service.promote(inv(), { memberId: member.id }),
    f.service.promote(inv(), { memberId: member.id }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
  assert.equal(
    results.find((r) => r.status === "rejected").reason.key,
    "teamGrantMemberEnded",
  );
  const agent = f.store.getAssistant(member.assistantId);
  assert.equal(agent.lifetime, "permanent");
  assert.equal(agent.capabilities.memory, true);
  assert.equal(agent.shell, "off");
  await assert.rejects(f.service.promote(inv(), { memberId: member.id }), {
    key: "teamGrantMemberEnded",
  });
});
