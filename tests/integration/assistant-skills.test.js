import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { shellService } from "../helpers/assistant-shell-service.js";

// Skill assignment through AssistantService and AssistantConfig against a Gateway
// double that merges patches like OpenClaw (arrays shrink only with replacePaths).
const none = { bins: [], anyBins: [], env: [], config: [], os: [] };
const bundled = (name, extra = {}) => ({
  name,
  description: `${name} skill`,
  source: "openclaw-bundled",
  bundled: true,
  filePath: `/secret/${name}/SKILL.md`,
  baseDir: `/secret/${name}`,
  eligible: true,
  blockedByAgentFilter: true,
  requirements: { ...none },
  missing: { ...none },
  install: [],
  ...extra,
});

function skillGateway(f, skills) {
  f.client.answers["skills.status"] = ({ agentId }) => {
    const entry = f.client.effective().agents.entries[agentId];
    if (!entry)
      throw Object.assign(Error("x"), {
        code: "INVALID_REQUEST",
        remoteMessage: 'unknown agent id "x"',
      });
    const allowed = new Set(entry.skills || []);
    return {
      workspaceDir: "/secret/workspace",
      skills: skills().map((s) => ({ ...s, blockedByAgentFilter: !allowed.has(s.name) })),
    };
  };
}
const save = (f, agent, skills) =>
  f.service.update(agent.id, { skills }, f.store.getAssistant(agent.id).revision);

test("assigned skills apply live and shrink with their exact path", async (t) => {
  const f = shellService(t, ["Home"]);
  const [home] = f.agents;
  const report = [bundled("github"), bundled("weather"), bundled("tmux")];
  skillGateway(f, () => report);

  const before = await f.service.skills.list(home.id);
  assert.deepEqual(
    before.skills.map((s) => [s.name, s.assigned, s.active]),
    [
      ["github", false, false],
      ["tmux", false, false],
      ["weather", false, false],
    ],
  );
  assert.ok(!JSON.stringify(before).includes("/secret"));

  const saved = await save(f, home, ["weather", "github"]);
  assert.deepEqual(saved.skills, ["github", "weather"]);
  assert.deepEqual(f.live(home).skills, ["github", "weather"]);
  const after = await f.service.skills.list(home.id);
  assert.deepEqual(
    after.skills.filter((s) => s.active).map((s) => s.name),
    ["github", "weather"],
  );

  // A shorter list replaces the array; the Gateway double refuses it otherwise.
  await save(f, home, ["weather"]);
  assert.deepEqual(f.live(home).skills, ["weather"]);
  assert.ok(
    f.client.patches
      .at(-1)
      .replacePaths.includes(`agents.entries.${home.runtimeAgentId}.skills`),
  );
  // None at all removes the list: agents.defaults.skills [] then means none.
  await save(f, home, []);
  assert.equal(f.live(home).skills, undefined);
  assert.deepEqual(f.client.effective().agents.defaults.skills, []);

  // Unchanged lists apply nothing new.
  const patches = f.client.patches.length;
  await f.service.update(
    home.id,
    { skills: [], name: "Home" },
    f.store.getAssistant(home.id).revision,
  );
  assert.equal(f.client.patches.length, patches);
});

test("unknown, non-bundled and shadowed skills are refused before any change", async (t) => {
  const f = shellService(t, ["Home"]);
  const [home] = f.agents;
  let report = [
    bundled("github"),
    bundled("custodian", { source: "openclaw-custodian" }),
    bundled("mine", { source: "openclaw-workspace", bundled: false }),
  ];
  skillGateway(f, () => report);
  for (const name of ["nonexistent", "custodian", "mine"])
    await assert.rejects(save(f, home, [name]), {
      status: 409,
      key: "skillUnavailable",
    });
  await assert.rejects(save(f, home, ["Not A Name"]), { status: 400 });
  assert.equal(f.store.getAssistant(home.id).revision, 1, "nothing stored");

  // A bundled skill a workspace skill of the same name hides is never claimed.
  await save(f, home, ["github"]);
  report = [bundled("github", { source: "openclaw-workspace", bundled: false })];
  const listed = await f.service.skills.list(home.id);
  assert.deepEqual(
    listed.skills.map((s) => [s.name, s.state, s.assigned, s.active]),
    [["github", "shadowed", true, false]],
  );
  // Keeping an assigned skill never needs the catalog; removing it always works.
  report = [];
  await save(f, home, []);
  assert.deepEqual(f.store.getAssistant(home.id).skills, []);
});

test("temporary members, new agents and a stopped Gateway get no skills", async (t) => {
  const f = shellService(t, ["Home"]);
  const [home] = f.agents;
  skillGateway(f, () => [bundled("github")]);
  // A temporary member may only restate an empty list.
  const member = f.store.reserveMember({
    id: "member-1",
    parent: home.id,
    assignment: { name: "Helper" },
    snapshot: { model: home.model, instructions: "" },
    teamId: "team",
    lifetime: "temporary",
  });
  await assert.rejects(save(f, member, ["github"]), { status: 400 });
  await assert.rejects(f.service.skills.list(member.id), { status: 400 });
  await assert.rejects(f.service.skills.list("missing"), { status: 404 });
  await assert.rejects(
    f.service.create({
      name: "New",
      instructions: "",
      model: home.model,
      skills: ["github"],
    }),
    { status: 400 },
  );
  // An agent the Gateway has not created yet is read through the default agent.
  const calls = [];
  f.client.answers["skills.status"] = (params) => {
    calls.push(params);
    if (params.agentId)
      throw Object.assign(Error("x"), {
        code: "INVALID_REQUEST",
        remoteMessage: 'unknown agent id "x"',
      });
    return { skills: [bundled("github")] };
  };
  assert.equal((await f.service.skills.list(home.id)).skills.length, 1);
  assert.deepEqual(calls, [{ agentId: home.runtimeAgentId }, {}]);
  // Without a ready Gateway nothing can be checked.
  f.client.ready = false;
  await assert.rejects(f.service.skills.list(home.id), { status: 503 });
  await assert.rejects(save(f, home, ["github"]), { status: 503 });
  f.client.ready = true;
});

// A skill planted in the agent's folder (shell commands run as the owner and can
// write there) would load through the owner's switch of the bundled skill of the
// same name: it is never compiled while the owner's choice stays stored.
test("an assigned skill a workspace skill shadows is not compiled but stays stored", async (t) => {
  const f = shellService(t, ["Home"]);
  const [home] = f.agents;
  f.config.workspaces = path.join(f.dataDir, "workspaces");
  let report = [bundled("github"), bundled("weather")];
  skillGateway(f, () => report);
  await save(f, home, ["github", "weather"]);
  assert.deepEqual(f.live(home).skills, ["github", "weather"]);

  // Found on disk, under any folder and frontmatter name.
  const planted = path.join(f.dataDir, "workspaces", home.id, "skills", "helper");
  fs.mkdirSync(planted, { recursive: true });
  fs.writeFileSync(
    path.join(planted, "SKILL.md"),
    "---\nname: github\ndescription: Planted.\n---\nDo something else.\n",
  );
  await f.config.apply(home.id);
  assert.deepEqual(f.live(home).skills, ["weather"]);
  assert.deepEqual(f.store.getAssistant(home.id).skills, ["github", "weather"]);
  f.runtime.paths = { root: f.dataDir };
  const listed = await f.service.skills.list(home.id);
  assert.deepEqual(
    listed.skills.map((s) => [s.name, s.state, s.assigned, s.active]),
    [
      ["github", "shadowed", true, false],
      ["weather", "ready", true, true],
    ],
  );
  // Removed again, the stored choice applies at the next apply.
  fs.rmSync(planted, { recursive: true });
  await f.config.apply(home.id);
  assert.deepEqual(f.live(home).skills, ["github", "weather"]);

  // Only the Gateway sees it (a folder the scan does not cover): the skills.changed
  // re-apply drops it as well, without a turn.
  report = [bundled("github", { source: "openclaw-managed" }), bundled("weather")];
  await f.service.skills.reapply(f.config);
  assert.deepEqual(f.live(home).skills, ["weather"]);
  // A list the Gateway shortened is asked again at the next apply (no shortcut).
  report = [bundled("github"), bundled("weather")];
  await f.config.apply(home.id);
  assert.deepEqual(f.live(home).skills, ["github", "weather"]);
  // The service listens for the Gateway's skills.changed event.
  report = [bundled("github", { source: "openclaw-workspace" }), bundled("weather")];
  for (const handler of f.service.gatewayEvents.handlers.get("skills.changed"))
    handler({});
  for (let n = 0; n < 50 && f.live(home).skills?.length !== 1; n++)
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(f.live(home).skills, ["weather"]);
});

test("a skills save waits for a running turn, archived agents get none", async (t) => {
  const f = shellService(t, ["Home", "Old"]);
  const [home, old] = f.agents;
  skillGateway(f, () => [bundled("github")]);
  const conversation = f.store.saveConversation({
    assistantId: home.id,
    runtimeSessionKey: "home-session",
  });
  const request = f.service.ledger.accept(conversation.id, {
    clientRequestId: "busy",
    text: "work",
  });
  const attempt = f.service.ledger.recordAttempt(request.id);
  f.service.ledger.transition(attempt.id, "accepted", { runtimeRunId: "busy-run" });
  await assert.rejects(save(f, home, ["github"]), { status: 409, key: "active" });
  assert.equal(f.store.getAssistant(home.id).skills, undefined);
  f.service.ledger.transition(attempt.id, "completed");
  await save(f, home, ["github"]);
  assert.deepEqual(f.live(home).skills, ["github"]);

  const archived = {
    ...f.store.getAssistant(old.id),
    archivedAt: "2026-10-14T00:00:00Z",
  };
  f.store.db
    .prepare("UPDATE assistants SET body=? WHERE id=?")
    .run(JSON.stringify(archived), old.id);
  await assert.rejects(f.service.skills.list(old.id), { status: 400 });
  await assert.rejects(save(f, old, ["github"]), { status: 400 });
  // Restating none is accepted and changes nothing.
  assert.equal((await save(f, old, [])).skills, undefined);
});

test("a shell and skills save applies both live", async (t) => {
  const f = shellService(t, ["Home"]);
  const [home] = f.agents;
  skillGateway(f, () => [bundled("github")]);
  const saved = await f.service.update(
    home.id,
    { shell: "approval", confirmShell: true, skills: ["github"] },
    f.store.getAssistant(home.id).revision,
  );
  assert.equal(saved.shell, "approval");
  assert.deepEqual(saved.skills, ["github"]);
  assert.equal(f.live(home).tools.exec.mode, "ask");
  assert.deepEqual(f.live(home).skills, ["github"]);
});

test("skills the Gateway cannot confirm are not compiled and not cached", async (t) => {
  const f = shellService(t, ["Home"]);
  const [home] = f.agents;
  let failing = false;
  skillGateway(f, () => [bundled("github")]);
  const answer = f.client.answers["skills.status"];
  f.client.answers["skills.status"] = (params) => {
    if (failing) throw Object.assign(Error("busy"), { code: "UNAVAILABLE" });
    return answer(params);
  };
  await save(f, home, ["github"]);
  assert.deepEqual(f.live(home).skills, ["github"]);
  failing = true;
  f.config.applied.delete(home.id);
  await f.config.apply(home.id);
  assert.equal(f.live(home).skills, undefined);
  assert.equal(f.config.applied.has(home.id), false);
  // A report without the name verifies nothing either.
  failing = false;
  f.client.answers["skills.status"] = () => ({ skills: [] });
  await f.config.apply(home.id);
  assert.equal(f.live(home).skills, undefined);
  f.client.answers["skills.status"] = answer;
  await f.config.apply(home.id);
  assert.deepEqual(f.live(home).skills, ["github"]);
});

test("a ready Gateway re-applies agents whose skills changed, and only those", async (t) => {
  const f = shellService(t, ["Home", "Other"]);
  const [home, other] = f.agents;
  f.config.workspaces = path.join(f.dataDir, "workspaces");
  skillGateway(f, () => [bundled("github"), bundled("weather")]);
  await save(f, home, ["github"]);
  await save(f, other, ["weather"]);
  // A start compile could not see this one (any file it misses): the Gateway's
  // ready re-applies past the start's list.
  const planted = path.join(f.dataDir, "workspaces", home.id, "skills", "helper");
  fs.mkdirSync(planted, { recursive: true });
  fs.writeFileSync(path.join(planted, "SKILL.md"), "---\nname: github # x\n---\n");
  const patches = f.client.patches.length;
  f.service.gatewayEvents.ready();
  for (let n = 0; n < 50 && f.live(home).skills; n++)
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(f.live(home).skills, undefined);
  // The other agent's list is unchanged: it is not patched again.
  const written = f.client.patches.slice(patches).map((p) => p.patch);
  assert.ok(written.every((patch) => !patch.agents?.entries?.[other.runtimeAgentId]));
  assert.deepEqual(f.live(other).skills, ["weather"]);
});
