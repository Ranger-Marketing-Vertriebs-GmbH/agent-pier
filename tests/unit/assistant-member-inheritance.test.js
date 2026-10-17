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

function fixture(t, { lifetime = "task", memberShellSsh = false } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-member-inherit-"));
  const store = new AssistantStore({ dataDir });
  const teams = new TeamStore({ store });
  const ledger = new RequestLedger(store.db);
  t.after(() => {
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const lead = store.createAssistant({ name: "Lead", instructions: "Plan", model });
  store.updateAssistant(
    lead.id,
    { capabilities: ALL, shell: "full", skills: ["weather"] },
    lead.revision,
  );
  if (memberShellSsh) teams.savePolicy(lead.id, { memberShellSsh: true }, 1);
  const chat = store.saveConversation({
    assistantId: lead.id,
    runtimeSessionKey: "agent:lead:test",
  });
  const request = ledger.accept(chat.id, { clientRequestId: "owner", text: "Team" });
  const attempt = ledger.recordAttempt(request.id);
  const proposal = teams.propose({
    operationId: "tool",
    parentAttemptId: attempt.id,
    objective: "Review",
    members: [{ name: "Scout", role: "Research", assignment: "Look around" }],
    origin: { kind: "owner" },
  });
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
  return { store, teams, lead, member, team, editLead, agent };
}

test("a temporary member inherits web, memory, reminders and skills, not shell or SSH", (t) => {
  const f = fixture(t);
  const agent = f.agent();
  assert.deepEqual(personalCapabilities(agent), ALL);
  assert.deepEqual(personalSkills(agent), ["weather"]);
  assert.equal(personalShell(agent), "off");
  assert.equal(agent.inherited.ssh, false);
  const tools = profileTools(agent, true, true, true, {}, ["docs__*"], true);
  for (const tool of [
    "web_search",
    "web_fetch",
    "browser",
    "view_image",
    "memory_search",
    "memory_get",
    "read",
    "agentpier_reminder",
    "docs__*",
  ])
    assert.ok(tools.includes(tool), tool);
  // Memory is the lead's, read-only; routines, delegation, shell and SSH stay away.
  for (const tool of [
    "write",
    "edit",
    "agentpier_routine",
    "agentpier_team_propose",
    "exec",
    "process",
    "agentpier_ssh",
  ])
    assert.ok(!tools.includes(tool), tool);
});

test("inherited capabilities follow the lead live", (t) => {
  const f = fixture(t);
  f.editLead({ capabilities: { ...ALL, browser: false, memory: false }, skills: [] });
  assert.deepEqual(personalCapabilities(f.agent()), {
    ...ALL,
    browser: false,
    memory: false,
  });
  assert.deepEqual(personalSkills(f.agent()), []);
  // The member's own record never changed.
  assert.equal(f.agent().revision, 1);
  const current = f.store.getAssistant(f.lead.id);
  f.store.updateAssistant(f.lead.id, { capabilities: OFF }, current.revision);
  assert.deepEqual(personalCapabilities(f.agent()), OFF);
});

test("shell and SSH reach members only through the lead's explicit setting", (t) => {
  const f = fixture(t, { memberShellSsh: true });
  assert.equal(personalShell(f.agent()), "full");
  assert.equal(f.agent().inherited.ssh, true);
  const tools = profileTools(f.agent(), true, true, true, {}, [], true);
  assert.ok(tools.includes("exec") && tools.includes("agentpier_ssh"));
  // Never above the lead's own level, and lowered live with it.
  f.editLead({ shell: "approval" });
  assert.equal(personalShell(f.agent()), "approval");
  // Switching the setting off revokes both for the running member.
  const policy = f.teams.policy(f.lead.id);
  f.teams.savePolicy(f.lead.id, { memberShellSsh: false }, policy.revision);
  assert.equal(personalShell(f.agent()), "off");
  assert.equal(f.agent().inherited.ssh, false);
});

test("a setting switched on after approval grants nothing to that team", (t) => {
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
  // Keeping the member as a permanent agent keeps none of the lead's capabilities.
  const done = f.teams.setPhase(f.member.id, "queued", { phase: "completed" });
  f.teams.promote(f.member.id, done.revision);
  assert.equal("inherited" in f.store.storedAssistant(agent.id), false);
  assert.deepEqual(personalCapabilities(f.agent()), OFF);
  assert.equal(personalShell(f.agent()), "off");
});

test("members never widen the global capability set", (t) => {
  const f = fixture(t);
  const profiles = f.store.listAssistants();
  assert.deepEqual([...usedCapabilities(profiles)].sort(), Object.keys(ALL).sort());
  const lead = profiles.find((p) => p.id === f.lead.id);
  const others = profiles.map((p) => (p === lead ? { ...lead, capabilities: OFF } : p));
  assert.deepEqual([...usedCapabilities(others)], []);
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
