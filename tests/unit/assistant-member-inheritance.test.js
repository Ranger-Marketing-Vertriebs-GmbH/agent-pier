import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { RequestLedger } from "../../server/features/assistants/request-ledger.js";
import { TeamStore } from "../../server/features/assistants/team-store.js";
import {
  personalCapabilities,
  personalShell,
  personalSkills,
  profileTools,
  usedCapabilities,
} from "../../server/features/assistants/native-capabilities.js";
import {
  grantInput,
  mergeGrants,
  removeGrants,
} from "../../server/features/assistants/member-grants.js";
import { followLead } from "../../server/features/assistants/member-follow.js";

const model = { connectionId: "c", modelId: "m" };
const ALL = {
  memory: true,
  reminders: true,
  webSearch: true,
  webFetch: true,
  browser: true,
  documents: true,
};
const OFF = Object.fromEntries(Object.keys(ALL).map((key) => [key, false]));
const DEFAULT = { ...OFF, memory: true, webSearch: true, webFetch: true };

function fixture(
  t,
  { lifetime = "task", memberShellSsh = false, grants, caps = ALL, ssh = false } = {},
) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-member-inherit-"));
  const store = new AssistantStore({ dataDir });
  const teams = new TeamStore({ store, sshGranted: () => ssh });
  const ledger = new RequestLedger(store.db);
  t.after(() => {
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const lead = store.createAssistant({ name: "Lead", instructions: "Plan", model });
  store.updateAssistant(
    lead.id,
    { capabilities: caps, shell: "approval", skills: ["github", "weather"] },
    lead.revision,
  );
  if (memberShellSsh) teams.savePolicy(lead.id, { memberShellSsh: true }, 1);
  const chat = store.saveConversation({
    assistantId: lead.id,
    runtimeSessionKey: "agent:lead:test",
  });
  const request = ledger.accept(chat.id, { clientRequestId: "owner", text: "Team" });
  const attempt = ledger.recordAttempt(request.id);
  const propose = (members) =>
    teams.propose({
      operationId: `tool-${Math.random()}`,
      parentAttemptId: attempt.id,
      objective: "Review",
      members,
      origin: { kind: "owner" },
    });
  const proposal = propose([
    {
      name: "Scout",
      role: "Research",
      assignment: "Look around",
      ...(grants ? { grants } : {}),
    },
  ]);
  teams.decide(
    proposal.id,
    { revision: proposal.revision, decision: "approve", lifetime },
    { kind: "owner" },
  );
  const team = teams.reserve(proposal.id);
  const member = teams.member(team.memberIds[0]);
  const editLead = (patch) => {
    const current = store.getAssistant(lead.id);
    return store.updateAssistant(lead.id, patch, current.revision);
  };
  const agent = () => store.getAssistant(member.assistantId);
  return { store, teams, lead, member, team, editLead, agent, propose };
}

test("a member the lead grants nothing reads memory and searches and reads the web", (t) => {
  const f = fixture(t);
  assert.deepEqual(f.member.grants, { memory: true, webSearch: true, webFetch: true });
  const agent = f.agent();
  assert.deepEqual(personalCapabilities(agent), DEFAULT);
  assert.deepEqual(personalSkills(agent), []);
  assert.equal(personalShell(agent), "off");
  const tools = profileTools(agent, true, true, true, {}, [], true);
  // Its own memory is writable (the bridge refuses the copy of the lead's).
  for (const tool of [
    "web_search",
    "web_fetch",
    "memory_search",
    "memory_get",
    "read",
    "write",
    "edit",
  ])
    assert.ok(tools.includes(tool), tool);
  for (const tool of [
    "browser",
    "agentpier_reminder",
    "agentpier_routine",
    "agentpier_team_propose",
    "exec",
    "agentpier_ssh",
  ])
    assert.ok(!tools.includes(tool), tool);
});

test("the default only holds what the lead itself has", (t) => {
  const f = fixture(t, { caps: { ...OFF, webSearch: true } });
  assert.deepEqual(f.member.grants, { webSearch: true });
  assert.deepEqual(personalCapabilities(f.agent()), { ...OFF, webSearch: true });
});

test("explicit grants replace the default and stay within the lead", (t) => {
  const f = fixture(t, {
    grants: { browser: true, reminders: true, skills: ["weather"] },
  });
  assert.deepEqual(personalCapabilities(f.agent()), {
    ...OFF,
    browser: true,
    reminders: true,
  });
  assert.deepEqual(personalSkills(f.agent()), ["weather"]);
  const tools = profileTools(f.agent(), true, true, true);
  assert.ok(tools.includes("agentpier_reminder") && !tools.includes("agentpier_routine"));
  // A grant beyond the lead's own capabilities, skills or shell is refused.
  for (const grants of [{ skills: ["himalaya"] }, { shell: "approval" }, { ssh: true }])
    assert.throws(() => f.propose([{ name: "X", role: "R", assignment: "A", grants }]), {
      key: "teamGrantNotHeld",
    });
  f.editLead({ capabilities: { ...ALL, browser: false } });
  assert.throws(
    () =>
      f.propose([{ name: "X", role: "R", assignment: "A", grants: { browser: true } }]),
    { key: "teamGrantNotHeld" },
  );
});

test("granted capabilities follow the lead live", (t) => {
  const f = fixture(t, { grants: { ...ALL, skills: true } });
  assert.deepEqual(personalSkills(f.agent()), ["github", "weather"]);
  f.editLead({ capabilities: { ...ALL, browser: false, memory: false }, skills: [] });
  assert.deepEqual(personalCapabilities(f.agent()), {
    ...ALL,
    browser: false,
    memory: false,
  });
  assert.deepEqual(personalSkills(f.agent()), []);
  // The member's own record never changed.
  assert.equal(f.agent().revision, 1);
  // A capability the lead gains back returns, but never one it was not granted.
  f.editLead({ capabilities: ALL, skills: ["weather"] });
  assert.deepEqual(personalCapabilities(f.agent()), ALL);
  assert.deepEqual(personalSkills(f.agent()), ["weather"]);
});

test("shell and SSH need the lead's setting, at most at the lead's level", (t) => {
  const f = fixture(t, {
    memberShellSsh: true,
    ssh: true,
    grants: { shell: "approval", ssh: true },
  });
  assert.equal(personalShell(f.agent()), "approval");
  assert.equal(f.agent().inherited.ssh, true);
  const tools = profileTools(f.agent(), true, true, true, {}, [], true);
  assert.ok(tools.includes("exec") && tools.includes("agentpier_ssh"));
  // Never above the lead's own level: Full access is refused for a lead with approval.
  assert.throws(
    () =>
      f.propose([{ name: "X", role: "R", assignment: "A", grants: { shell: "full" } }]),
    { key: "teamGrantNotHeld" },
  );
  f.editLead({ shell: "off" });
  assert.equal(personalShell(f.agent()), "off");
  f.editLead({ shell: "full" });
  assert.equal(personalShell(f.agent()), "approval");
  // Switching the setting off revokes both for the running member.
  const policy = f.teams.policy(f.lead.id);
  f.teams.savePolicy(f.lead.id, { memberShellSsh: false }, policy.revision);
  assert.equal(personalShell(f.agent()), "off");
  assert.equal(f.agent().inherited.ssh, false);
});

test("a setting switched on after the proposal grants nothing to that team", (t) => {
  const f = fixture(t);
  f.teams.savePolicy(f.lead.id, { memberShellSsh: true }, 1);
  assert.equal(personalShell(f.agent()), "off");
  assert.equal(f.agent().inherited.ssh, false);
});

test("permanent and ended members inherit nothing", (t) => {
  const permanent = fixture(t, { lifetime: "permanent" });
  assert.deepEqual(personalCapabilities(permanent.agent()), OFF);
  assert.equal("inherited" in permanent.agent(), false);
  const f = fixture(t);
  const done = f.teams.setPhase(f.member.id, "queued", { phase: "completed" });
  f.teams.archive(done.id, done.revision);
  assert.deepEqual(personalCapabilities(f.agent()), OFF);
});

test("inheritance is resolved on read and never stored", (t) => {
  const f = fixture(t);
  const agent = f.agent();
  f.store.markEffective(agent.id, agent.revision);
  const stored = f.store.storedAssistant(agent.id);
  assert.equal("inherited" in stored, false);
  assert.equal(stored.capabilities, undefined);
  // Keeping the member as a permanent agent keeps none of the lead's capabilities;
  // only its own memory, which is on.
  const done = f.teams.setPhase(f.member.id, "queued", { phase: "completed" });
  f.teams.promote(f.member.id, done.revision);
  assert.equal("inherited" in f.store.storedAssistant(agent.id), false);
  assert.deepEqual(personalCapabilities(f.agent()), { ...OFF, memory: true });
  assert.equal(personalShell(f.agent()), "off");
});

test("members never widen the global capability set", (t) => {
  const f = fixture(t, { grants: ALL });
  const profiles = f.store.listAssistants();
  assert.deepEqual([...usedCapabilities(profiles)].sort(), Object.keys(ALL).sort());
  const lead = profiles.find((p) => p.id === f.lead.id);
  const others = profiles.map((p) => (p === lead ? { ...lead, capabilities: OFF } : p));
  assert.deepEqual([...usedCapabilities(others)], []);
});

test("grant inputs are normalized, merged and removed key by key", () => {
  assert.deepEqual(grantInput({ webSearch: true, browser: false, skills: true }), {
    webSearch: true,
    skills: "all",
  });
  assert.deepEqual(grantInput({ shell: "off", ssh: false, skills: [] }), {});
  for (const value of [null, [], { exec: true }, { webSearch: "yes" }, { shell: "root" }])
    assert.throws(() => grantInput(value), { status: 400 });
  assert.deepEqual(mergeGrants({ skills: ["a"] }, { skills: ["b"], memory: true }), {
    skills: ["a", "b"],
    memory: true,
  });
  assert.deepEqual(mergeGrants({ skills: "all" }, { skills: ["b"] }), { skills: "all" });
  assert.deepEqual(mergeGrants({ shell: "full" }, { shell: "approval" }), {
    shell: "full",
  });
  assert.deepEqual(
    removeGrants(
      { memory: true, skills: ["a", "b"], ssh: true },
      { skills: ["a"], ssh: true },
    ),
    { memory: true, skills: ["b"] },
  );
  assert.deepEqual(removeGrants({ skills: "all" }, { skills: "all" }), {});
});

test("a lead's change re-applies only its running task members", async (t) => {
  const f = fixture(t);
  const applied = [];
  const assistants = {
    runtime: { client: { ready: true } },
    store: f.store,
    teams: { store: f.teams },
    admit: (fn) => fn(),
    config: { apply: async (id) => applied.push(id) },
  };
  // Queued members have no Gateway entry yet; their first apply compiles the lead's.
  followLead(assistants, f.lead.id);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(applied, []);
  f.teams.setPhase(f.member.id, "queued", { phase: "running" });
  followLead(assistants, f.lead.id);
  followLead(assistants, "another-lead");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(applied, [f.member.assistantId]);
});

test("a proposal granting shell or SSH always waits for the owner", (t) => {
  for (const kind of ["task", "standing"]) {
    const f = fixture(t, { memberShellSsh: true, ssh: true });
    const policy = f.teams.policy(f.lead.id);
    f.teams.savePolicy(f.lead.id, { autonomous: kind === "standing" }, policy.revision);
    const chat = f.store.saveConversation({
      assistantId: f.lead.id,
      runtimeSessionKey: `agent:lead:${kind}`,
    });
    const ledger = new RequestLedger(f.store.db);
    // A fresh owner turn per proposal: a task authorization covers one team.
    const turn = () => {
      const request = ledger.accept(chat.id, {
        clientRequestId: `${kind}-${Math.random()}`,
        text: "/team go",
      });
      f.teams.recordContext(request.id, { kind: "owner", teamAllowed: kind === "task" });
      return ledger.recordAttempt(request.id);
    };
    // The fixture's team is still active; a new one waits for it to finish.
    f.teams.write(f.teams.member(f.member.id), { phase: "completed" });
    f.teams.write(f.teams.get(f.team.id), { phase: "completed" });
    const plain = f.teams.propose({
      operationId: `${kind}-plain`,
      parentAttemptId: turn().id,
      objective: "Plain",
      members: [{ name: "A", role: "R", assignment: "A" }],
      origin: { kind: "owner" },
    });
    assert.equal(plain.phase, "approved", kind);
    assert.equal(plain.authorization.kind, kind);
    f.teams.write(plain, { phase: "declined" });
    for (const grants of [{ shell: "approval" }, { ssh: true }]) {
      const proposal = f.teams.propose({
        operationId: `${kind}-${Object.keys(grants)[0]}`,
        parentAttemptId: turn().id,
        objective: "Shell",
        members: [{ name: "B", role: "R", assignment: "B", grants }],
        origin: { kind: "owner" },
      });
      assert.equal(proposal.phase, "awaiting_approval", `${kind} ${Object.keys(grants)}`);
      assert.equal(proposal.authorization, null);
      f.teams.write(proposal, { phase: "declined" });
    }
  }
});

test("members reserved before grants existed get the default grants", (t) => {
  const f = fixture(t, { caps: { ...OFF, webSearch: true, browser: true } });
  f.teams.write(f.teams.member(f.member.id), { grants: undefined });
  // Within the lead: it has no memory or web pages, and browser is no default.
  assert.deepEqual(personalCapabilities(f.agent()), { ...OFF, webSearch: true });
});
