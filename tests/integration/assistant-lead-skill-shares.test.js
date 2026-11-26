import test from "node:test";
import assert from "node:assert/strict";
import { leadShareFixture } from "../helpers/lead-share-fixture.js";
import { toolError } from "../../server/features/assistants/tool-errors.js";
import {
  ownSkills,
  personalSkills,
} from "../../server/features/assistants/native-capabilities.js";
import { desiredAgent } from "../../server/features/assistants/agent-desired-state.js";
import {
  AgentSkills,
  skillCatalog,
} from "../../server/features/assistants/agent-skills.js";
import { catalogUsers } from "../../server/features/assistants/catalog-switches.js";
import { followLead } from "../../server/features/assistants/member-follow.js";
import { taskShare } from "../../server/features/assistants/lead-share-input.js";
import { sharedWith } from "../../server/features/assistants/lead-share-views.js";
import {
  assertWithinLead,
  grantInput,
} from "../../server/features/assistants/member-grants.js";
import { teamAuditDetails } from "../../server/features/audit/audit-team-details.js";

// AGENTPIER-499: a lead switches on, for its permanent member, skills that are
// switched on for the lead itself (lead-skill-shares.js).
const shareAudits = (f) => f.audits.filter((e) => e.details?.kind === "lead-share");
const skillRows = (f) => f.shares.rows().filter((r) => r.kind === "skill");
const setSkills = (f, id, skills) => {
  const agent = f.store.getAssistant(id);
  return f.store.updateAssistant(id, { skills }, agent.revision);
};
const settle = () => new Promise((resolve) => setImmediate(resolve));
// The lead has three skills on; the member has none of its own.
async function setup(t) {
  const f = await leadShareFixture(t);
  setSkills(f, f.lead, ["github", "tmux", "weather"]);
  // The skills page of an agent; without a running agent service it cannot be read.
  f.assistants.skills = new AgentSkills({ store: f.store, runtime: {} });
  const member = () => f.store.getAssistant(f.member.assistantId);
  return { ...f, agent: member, skills: () => personalSkills(member()) };
}

test("a lead shares named skills with its permanent member, visibly", async (t) => {
  const f = await setup(t);
  const applied = [];
  f.assistants.config.apply = async (id) => applied.push(id);
  const result = await f.share({ grants: { skills: ["weather", "github"] } });
  assert.deepEqual(result, {
    status: "shared",
    memberId: f.member.id,
    projects: [],
    coding: [],
    mcpServers: 0,
    skills: ["github", "weather"],
  });
  // One row per skill, standing; the member holds them through its lead only.
  assert.deepEqual(
    skillRows(f).map((r) => [r.skill, r.requestId]),
    [
      ["github", null],
      ["weather", null],
    ],
  );
  assert.deepEqual(f.skills(), ["github", "weather"]);
  assert.deepEqual(ownSkills(f.agent()), []);
  assert.deepEqual(f.agent().leadSkills, ["github", "weather"]);
  // The compiled state carries them, and the running member is applied at once.
  const desired = desiredAgent(f.agent());
  assert.deepEqual([...desired.skills.assigned], ["github", "weather"]);
  assert.deepEqual([...desired.skills.compiled], ["github", "weather"]);
  await settle();
  assert.ok(applied.includes(f.member.assistantId));
  // Never persisted with the member's own record.
  assert.equal(f.store.storedAssistant(f.member.assistantId).leadSkills, undefined);
  // Notes in both chats, the audit with a count and the owner's list.
  for (const id of [f.member.assistantId, f.lead]) {
    const note = f.workflows.store.list(id).at(-1);
    assert.equal(note.payload.action, "member_grant");
    assert.deepEqual(note.payload.granted, ["skills"], id);
  }
  const audit = shareAudits(f).at(-1);
  assert.equal(audit.details.change, "grant");
  assert.equal(audit.details.skills, 2);
  assert.ok(!JSON.stringify(audit).includes("weather"));
  const kept = { details: {} };
  teamAuditDetails(audit.details, kept, (id) => id);
  assert.equal(kept.details.skills, 2);
  const listed = f.shares.list().filter((s) => s.kind === "skill");
  assert.deepEqual(
    listed.map((s) => [s.skill, s.leadId, s.requestId, s.live]),
    [
      ["github", f.lead, null, { on: true }],
      ["weather", f.lead, null, { on: true }],
    ],
  );
  // The lead reads what it shares in agentpier_team_members.
  assert.deepEqual(sharedWith(f.assistants, f.teams.member(f.member.id), f.lead), {
    shares: { skills: ["github", "weather"] },
  });
  // Sharing again changes nothing but the time.
  await f.share({ grants: { skills: ["github"] } });
  assert.equal(skillRows(f).length, 2);
});

test("skills: true shares every skill the lead has on, each revocable alone", async (t) => {
  const f = await setup(t);
  const result = await f.share({ grants: { skills: true } });
  assert.deepEqual(result.skills, ["github", "tmux", "weather"]);
  assert.equal(skillRows(f).length, 3);
  // A skill the lead gets later is not shared by the earlier "all".
  setSkills(f, f.lead, ["github", "notes", "tmux", "weather"]);
  assert.deepEqual(f.skills(), ["github", "tmux", "weather"]);
  const one = await f.share({ grants: { skills: ["tmux"] }, revoke: true });
  assert.deepEqual(one, {
    status: "revoked",
    memberId: f.member.id,
    projects: [],
    coding: [],
    mcpServers: 0,
    skills: ["tmux"],
  });
  assert.deepEqual(f.skills(), ["github", "weather"]);
  const note = f.workflows.store.list(f.member.assistantId).at(-1);
  assert.deepEqual(note.payload.revoked, ["skills"]);
  assert.equal(shareAudits(f).at(-1).details.change, "revoke");
  // true takes back every skill this lead shares; nothing left names nothing.
  const all = await f.share({ grants: { skills: true }, revoke: true });
  assert.deepEqual(all.skills, ["github", "weather"]);
  assert.deepEqual(f.skills(), []);
  const none = await f.share({ grants: { skills: true }, revoke: true });
  assert.equal(none.status, "nothing_to_revoke");
});

test("a lead cannot share a skill it does not have on itself", async (t) => {
  const f = await setup(t);
  await assert.rejects(f.share({ grants: { skills: ["github", "1password"] } }), {
    key: "teamGrantNotHeld",
  });
  assert.equal(skillRows(f).length, 0);
  // A lead without skills has nothing "all" could mean.
  setSkills(f, f.lead, []);
  await assert.rejects(f.share({ grants: { skills: true } }), {
    key: "teamGrantNotHeld",
  });
  // Malformed names, and other settings of a permanent member, stay refused.
  await assert.rejects(f.share({ grants: { skills: ["../x"] } }), { key: "invalid" });
  await assert.rejects(f.share({ grants: { skills: "all" } }), { key: "invalid" });
  await assert.rejects(f.share({ grants: { skills: ["github"], webSearch: true } }), {
    key: "teamShareAccessOnly",
  });
  // AgentPier's built-in skill is never a share, even from a stored name.
  setSkills(f, f.lead, ["agentpier-shopping"]);
  await assert.rejects(f.share({ grants: { skills: true } }), {
    key: "teamGrantNotHeld",
  });
});

test("skills are standing only, and a task member's grant is as before", async (t) => {
  const f = await setup(t);
  // Never with one delegated task.
  assert.throws(
    () =>
      taskShare(f.workflows, f.store.getAssistant(f.lead), f.teams.member(f.member.id), {
        skills: ["github"],
      }),
    { key: "invalid" },
  );
  // A row smuggled in for one task counts for nothing.
  const { id } = await f.task();
  const shared = await f.share({ grants: { skills: ["github"] } });
  assert.deepEqual(shared.skills, ["github"]);
  const row = skillRows(f)[0];
  f.shares.write({ ...row, id: "task-row", skill: "tmux", requestId: id });
  assert.deepEqual(f.skills(), ["github"]);
  // A temporary member's grant keeps its own shape and ceiling.
  assert.deepEqual(grantInput({ skills: true }), { skills: "all" });
  assert.deepEqual(grantInput({ skills: ["tmux", "github"] }), {
    skills: ["github", "tmux"],
  });
  const lead = f.store.getAssistant(f.lead);
  assert.doesNotThrow(() => assertWithinLead(lead, { skills: ["github"] }));
  assert.throws(() => assertWithinLead(lead, { skills: ["1password"] }), {
    key: "teamGrantNotHeld",
  });
});

test("the share ends when the lead loses the skill, and the member follows", async (t) => {
  const f = await setup(t);
  await f.share({ grants: { skills: ["github", "weather"] } });
  const applied = [];
  f.assistants.config.apply = async (id) => applied.push(id);
  setSkills(f, f.lead, ["github", "tmux"]);
  // Live at once: the member's next compile no longer names it.
  assert.deepEqual(f.skills(), ["github"]);
  const row = skillRows(f).find((r) => r.skill === "weather");
  assert.equal(f.shares.live(row).on, false);
  // The lead's re-applied profile prunes the share and re-applies the member.
  followLead(f.assistants, f.lead);
  await settle();
  assert.ok(applied.includes(f.member.assistantId));
  assert.deepEqual(
    skillRows(f).map((r) => r.skill),
    ["github"],
  );
  const revoked = shareAudits(f).at(-1);
  assert.equal(revoked.details.change, "revoke");
  assert.equal(revoked.details.by, "system");
  assert.equal(revoked.details.reason, "lead-lost");
  assert.equal(revoked.details.skills, 1);
  // Switching it on again does not bring the ended share back.
  setSkills(f, f.lead, ["github", "tmux", "weather"]);
  assert.deepEqual(f.skills(), ["github"]);
});

test("a share pruned by the owner's list still re-applies the member", async (t) => {
  const f = await setup(t);
  await f.share({ grants: { skills: ["weather"] } });
  const applied = [];
  f.assistants.config.apply = async (id) => applied.push(id);
  setSkills(f, f.lead, []);
  assert.equal(f.shares.list().filter((s) => s.kind === "skill").length, 0);
  await settle();
  assert.ok(applied.includes(f.member.assistantId));
});

test("the owner revokes a shared skill like any share", async (t) => {
  const f = await setup(t);
  await f.share({ grants: { skills: ["github", "weather"] } });
  const applied = [];
  f.assistants.config.apply = async (id) => applied.push(id);
  const row = skillRows(f).find((r) => r.skill === "weather");
  assert.deepEqual(f.shares.remove(row.id), { removed: row.id });
  assert.deepEqual(f.skills(), ["github"]);
  const note = f.workflows.store.list(f.member.assistantId).at(-1);
  assert.equal(note.payload.by, "owner");
  assert.deepEqual(note.payload.revoked, ["skills"]);
  const audit = shareAudits(f).at(-1);
  assert.equal(audit.details.by, "owner");
  assert.equal(audit.source, "user");
  assert.equal(audit.details.skills, 1);
  await settle();
  assert.ok(applied.includes(f.member.assistantId));
});

test("the owner's own list never absorbs a shared skill", async (t) => {
  const f = await setup(t);
  setSkills(f, f.member.assistantId, ["tmux"]);
  await f.share({ grants: { skills: ["github", "tmux"] } });
  assert.deepEqual(f.skills(), ["github", "tmux"]);
  assert.deepEqual(ownSkills(f.agent()), ["tmux"]);
  // The owner's skills page: its own list apart from what the lead shares.
  const page = skillCatalog({
    report: {
      skills: ["github", "tmux", "weather"].map((name) => ({
        name,
        source: "openclaw-bundled",
        eligible: true,
        blockedByAgentFilter: name === "weather",
      })),
    },
    bundled: new Set(["github", "tmux", "weather"]),
    assistant: f.agent(),
  });
  assert.deepEqual(page.assigned, ["tmux"]);
  assert.deepEqual(page.shared, ["github", "tmux"]);
  const row = (name) => page.skills.find((s) => s.name === name);
  assert.deepEqual(
    ["github", "tmux", "weather"].map((n) => [
      row(n).assigned,
      row(n).shared === true,
      row(n).active,
    ]),
    [
      [false, true, true],
      [true, true, true],
      [false, false, false],
    ],
  );
  // The catalog counts and strips own lists only: the member is no user of "github".
  assert.deepEqual(
    catalogUsers(f.assistants, "github").map((a) => a.id),
    [f.lead],
  );
  // A save of the member, read with the shares resolved, stores its own list only,
  // and the resolved names are no field a save accepts.
  f.store.updateAssistant(f.member.assistantId, { name: "Scout 2" }, f.agent().revision);
  assert.throws(
    () =>
      f.store.updateAssistant(
        f.member.assistantId,
        { leadSkills: ["weather"] },
        f.agent().revision,
      ),
    { key: "invalid" },
  );
  setSkills(f, f.member.assistantId, ["tmux"]);
  const stored = f.store.storedAssistant(f.member.assistantId);
  assert.deepEqual(stored.skills, ["tmux"]);
  assert.equal(stored.leadSkills, undefined);
  // The owner's check treats a shared name as new for the own list, and a save that
  // only keeps or removes own names needs no check at all.
  const asked = [];
  f.assistants.skills.list = async (id) => {
    asked.push(id);
    return { skills: [{ name: "github", state: "ready" }] };
  };
  await f.assistants.skills.check(f.agent(), ["tmux"]);
  await f.assistants.skills.check(f.agent(), []);
  assert.deepEqual(asked, []);
  await f.assistants.skills.check(f.agent(), ["github", "tmux"]);
  assert.deepEqual(asked, [f.member.assistantId]);
  // Own and shared: the skill stays on when either ends.
  setSkills(f, f.member.assistantId, []);
  assert.deepEqual(f.skills(), ["github", "tmux"]);
  setSkills(f, f.member.assistantId, ["tmux"]);
  await f.share({ grants: { skills: ["tmux"] }, revoke: true });
  assert.deepEqual(f.skills(), ["github", "tmux"]);
  assert.deepEqual(ownSkills(f.agent()), ["tmux"]);
});

test("a shared skill must be one the member could have switched on", async (t) => {
  const f = await setup(t);
  const states = { github: "ready", tmux: "shadowed", weather: "needsSettings" };
  f.assistants.skills.list = async () => ({
    skills: Object.entries(states).map(([name, state]) => ({ name, state })),
  });
  // A named skill that cannot be on refuses the share.
  const refused = await f
    .share({ grants: { skills: ["github", "tmux"] } })
    .catch((e) => e);
  assert.equal(refused.key, "skillUnavailable");
  assert.equal(toolError(refused).code, "SKILL_UNAVAILABLE");
  assert.equal(skillRows(f).length, 0);
  // Of "all", those that cannot be on are left out and named.
  const result = await f.share({ grants: { skills: true } });
  assert.deepEqual(result.skills, ["github"]);
  assert.deepEqual(result.skippedSkills, ["tmux", "weather"]);
  assert.deepEqual(f.skills(), ["github"]);
  // A skill the member's runtime does not list at all is refused too.
  states.github = "unavailable";
  await assert.rejects(f.share({ grants: { skills: true } }), {
    key: "skillUnavailable",
  });
  // Missing programs keep no skill from being on, as for the owner's switch.
  states.github = "missing";
  assert.deepEqual((await f.share({ grants: { skills: ["github"] } })).skills, [
    "github",
  ]);
});

test("a shared skill never reaches an agent of users", async (t) => {
  const f = await setup(t);
  await f.share({ grants: { skills: ["github"] } });
  assert.deepEqual(f.skills(), ["github"]);
  // The member becomes an agent of restricted users: only the owner's own switch
  // decides what it reads.
  f.store.changeUserAgent(f.member.assistantId, {
    userAccess: { mode: "own", members: [{ userId: "u1", level: "chat" }], released: [] },
  });
  assert.deepEqual(f.skills(), []);
  assert.equal(f.agent().leadSkills, undefined);
  assert.deepEqual([...desiredAgent(f.agent()).skills.compiled], []);
  await assert.rejects(f.share({ grants: { skills: ["tmux"] } }), {
    key: "skillUnavailable",
  });
  // A resolved list on such a record counts for nothing either.
  assert.deepEqual(personalSkills({ ...f.agent(), leadSkills: ["github"] }), []);
});

test("a shared skill counts only for the lead's own active permanent member", async (t) => {
  const f = await setup(t);
  await f.share({ grants: { skills: ["github"] } });
  // The lead archived: nothing is shared, and nothing can be.
  const lead = f.store.getAssistant(f.lead);
  f.store.setArchived(f.lead, lead.revision, new Date().toISOString());
  assert.deepEqual(f.skills(), []);
  assert.equal(f.shares.live(skillRows(f)[0]).ended, "lead-archived");
  f.store.setArchived(f.lead, f.store.getAssistant(f.lead).revision, null);
  assert.deepEqual(f.skills(), ["github"]);
  // The member archived: the share ends for good and is pruned.
  f.teams.archive(f.member.id, f.teams.member(f.member.id).revision);
  assert.deepEqual(f.skills(), []);
  await assert.rejects(f.share({ grants: { skills: ["tmux"] } }), {
    key: "teamGrantMemberEnded",
  });
  f.shares.prune();
  assert.equal(f.shares.rows().length, 0);
  assert.equal(shareAudits(f).at(-1).details.reason, "member-archived");
});
