import test from "node:test";
import assert from "node:assert/strict";
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
