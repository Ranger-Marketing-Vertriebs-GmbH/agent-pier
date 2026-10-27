import test from "node:test";
import assert from "node:assert/strict";
import { shellService } from "../helpers/assistant-shell-service.js";
import { catalogSource } from "../../server/features/assistants/agent-skills.js";
import {
  catalogUsers,
  switchOffEverywhere,
} from "../../server/features/assistants/catalog-switches.js";
import { lockedTools } from "../../server/features/users/user-agent-lock.js";
import { settingsPatch } from "../../server/features/users/user-agent-settings.js";
import { userMayReach } from "../../server/http/route-access.js";

// Catalog skills switched per agent through AssistantService and AssistantConfig,
// against the Gateway double of tests/integration/assistant-skills.test.js whose
// skills.status also reports the catalog's skills (skills.load.extraDirs).
const none = { bins: [], anyBins: [], env: [], config: [], os: [] };
const liveRoot = "/secret/skill-catalog/skills";
const entry = (name, source, extra = {}) => ({
  name,
  description: `${name} skill`,
  source,
  bundled: source === "openclaw-bundled",
  filePath: `${source === catalogSource ? liveRoot : "/secret"}/${name}/SKILL.md`,
  baseDir: `${source === catalogSource ? liveRoot : "/secret"}/${name}`,
  eligible: true,
  blockedByAgentFilter: true,
  requirements: { ...none },
  missing: { ...none },
  install: [],
  ...extra,
});
const bundled = (name, extra) => entry(name, "openclaw-bundled", extra);
const extra = (name, more) => entry(name, catalogSource, more);

function skillGateway(f, skills) {
  f.client.answers["skills.status"] = ({ agentId }) => {
    const live = f.client.effective().agents.entries[agentId];
    if (!live)
      throw Object.assign(Error("x"), {
        code: "INVALID_REQUEST",
        remoteMessage: 'unknown agent id "x"',
      });
    const allowed = new Set(live.skills || []);
    return {
      workspaceDir: "/secret/workspace",
      skills: skills().map((s) => ({ ...s, blockedByAgentFilter: !allowed.has(s.name) })),
    };
  };
}

// The catalog store as AgentSkills reads it (SkillCatalogStore: list, liveRoot, failed).
function catalogFixture(f, records) {
  const store = { liveRoot, failed: new Set(), list: () => records };
  f.service.skills.catalog = store;
  f.config.skillCatalog = store;
  return store;
}
const record = (name, extra = {}) => ({ id: `id-${name}`, name, version: 1, ...extra });
const save = (f, agent, skills) =>
  f.service.update(agent.id, { skills }, f.store.getAssistant(agent.id).revision);

function forge(store, id, change) {
  const body = { ...store.storedAssistant(id), ...change };
  store.db
    .prepare("UPDATE assistants SET body=? WHERE id=?")
    .run(JSON.stringify(body), id);
  return body;
}

function standard(t, names = ["Home"]) {
  const f = shellService(t, names);
  skillGateway(f, () => [
    bundled("github"),
    extra("probe"),
    extra("envy", { requirements: { ...none, env: ["TOKEN"] } }),
    extra("broken"),
    bundled("clash"),
    extra("clash"),
  ]);
  catalogFixture(f, [
    record("probe"),
    record("envy"),
    record("broken", { damaged: true }),
    record("clash"),
  ]);
  return f;
}

test("a catalog skill switches on live for one agent", { todo: "Task 6" }, async (t) => {
  const f = standard(t, ["Home", "Other"]);
  const [home, other] = f.agents;
  await save(f, home, ["probe"]);
  assert.deepEqual(f.store.getAssistant(home.id).skills, ["probe"]);
  assert.equal(f.live(other).skills, undefined);
  assert.deepEqual(f.client.effective().agents.entries[home.runtimeAgentId].skills, [
    "probe",
  ]);
});

test("the agent's skill page lists catalog skills without paths", async (t) => {
  const f = standard(t);
  const [home] = f.agents;
  const { skills } = await f.service.skills.list(home.id);
  assert.deepEqual(
    skills.map((s) => [s.name, s.source, s.state]),
    [
      ["broken", "catalog", "damaged"],
      ["clash", "catalog", "shadowed"],
      ["envy", "catalog", "needsSettings"],
      ["github", undefined, "ready"],
      ["probe", "catalog", "ready"],
    ],
  );
  assert.ok(!JSON.stringify(skills).includes("/secret"));
  // A catalog that cannot be read leaves the bundled skills listed.
  f.service.skills.catalog.list = () => {
    throw Object.assign(Error("unreadable"), { code: "EACCES" });
  };
  const fallback = await f.service.skills.list(home.id);
  assert.deepEqual(
    fallback.skills.map((s) => [s.name, s.state]),
    [
      ["clash", "ready"],
      ["github", "ready"],
    ],
  );
  await assert.rejects(save(f, home, ["probe"]), { status: 409 });
});

test("needsSettings, damaged and shadowed catalog skills are refused when added", async (t) => {
  const f = standard(t);
  const [home] = f.agents;
  for (const name of ["envy", "broken", "clash", "gone"])
    await assert.rejects(save(f, home, [name]), {
      status: 409,
      key: "skillUnavailable",
    });
  // A skill whose last check failed is not offered until a check passes.
  f.service.skills.catalog.failed.add("probe");
  await assert.rejects(save(f, home, ["probe"]), { status: 409 });
  f.service.skills.catalog.failed.clear();
  assert.equal(f.store.getAssistant(home.id).revision, 1, "nothing stored");
  await save(f, home, ["probe"]);
  assert.deepEqual(f.store.getAssistant(home.id).skills, ["probe"]);
});

test("removing a catalog skill switches it off on every agent and lists them first", async (t) => {
  const f = standard(t, ["A", "B", "C", "Old"]);
  const [a, b, c, old] = f.agents;
  await save(f, a, ["github", "probe"]);
  await save(f, b, ["probe"]);
  await save(f, c, ["github"]);
  forge(f.store, old.id, { skills: ["probe"], archivedAt: "2026-10-14T00:00:00Z" });
  assert.deepEqual(
    catalogUsers(f.service, "probe")
      .map((agent) => agent.id)
      .sort(),
    [a.id, b.id].sort(),
  );
  assert.deepEqual(catalogUsers(f.service, "probe")[0], {
    id: a.id,
    name: "A",
  });
  // An owner edit between the read and the write: one retry on the conflict.
  const update = f.store.updateAssistant.bind(f.store);
  let raced = false;
  f.store.updateAssistant = (id, patch, revision, options) => {
    if (id === b.id && !raced) {
      raced = true;
      update(id, { name: "B2" }, revision);
    }
    return update(id, patch, revision, options);
  };
  assert.deepEqual(
    (await switchOffEverywhere(f.service, "probe")).sort(),
    [a.id, b.id].sort(),
  );
  assert.ok(raced);
  assert.deepEqual(f.store.getAssistant(a.id).skills, ["github"]);
  assert.deepEqual(f.store.getAssistant(b.id).skills, []);
  assert.equal(f.store.getAssistant(b.id).name, "B2");
  assert.deepEqual(f.store.getAssistant(c.id).skills, ["github"]);
  // Archived agents keep their stored list; the compile drops the name.
  assert.deepEqual(f.store.storedAssistant(old.id).skills, ["probe"]);
  assert.equal(f.client.effective().agents.entries[b.runtimeAgentId].skills, undefined);
  assert.deepEqual(catalogUsers(f.service, "probe"), []);
  assert.deepEqual(await switchOffEverywhere(f.service, "probe"), []);
});

test("a switch-off whose live apply fails stays pending", async (t) => {
  const f = standard(t);
  const [home] = f.agents;
  await save(f, home, ["probe"]);
  const apply = f.config.apply;
  f.config.apply = async () => {
    throw Object.assign(Error("busy"), { code: "UNAVAILABLE" });
  };
  assert.deepEqual(await switchOffEverywhere(f.service, "probe"), [home.id]);
  let stored = f.store.getAssistant(home.id);
  assert.deepEqual(stored.skills, []);
  assert.notEqual(stored.effectiveRevision, stored.revision, "pending");
  f.config.apply = apply;
  // Without a ready Gateway nothing is applied; the stored list still changes.
  await save(f, home, ["probe"]);
  const patches = f.client.patches.length;
  f.client.ready = false;
  assert.deepEqual(await switchOffEverywhere(f.service, "probe"), [home.id]);
  stored = f.store.getAssistant(home.id);
  assert.deepEqual(stored.skills, []);
  assert.notEqual(stored.effectiveRevision, stored.revision, "pending");
  assert.equal(f.client.patches.length, patches);
  f.client.ready = true;
});

test("the owner switches a catalog skill on a shared user agent; the hard lock holds", async (t) => {
  const f = standard(t, ["Shared"]);
  const [agent] = f.agents;
  forge(f.store, agent.id, {
    userAccess: {
      mode: "shared",
      members: [{ userId: "u1", level: "extended" }],
      released: [],
    },
  });
  await save(f, agent, ["probe"]);
  assert.deepEqual(f.store.getAssistant(agent.id).skills, ["probe"]);
  const live = f.live(agent);
  assert.deepEqual(live.tools.deny, lockedTools);
  assert.equal(live.tools.exec, undefined);
  for (const tool of lockedTools) assert.ok(!(live.tools.allow || []).includes(tool));
  await t.test("the user agent's entry lists the skill", { todo: "Task 6" }, () => {
    assert.deepEqual(f.live(agent).skills, ["probe"]);
  });
});

test("a temporary member inherits its lead's catalog skill", async (t) => {
  const f = standard(t, ["Lead"]);
  const [lead] = f.agents;
  await save(f, lead, ["probe"]);
  f.store.memberGrants = () => ({ grants: { skills: "all" }, shellSsh: false });
  const member = f.store.reserveMember({
    id: "member-1",
    parent: lead.id,
    assignment: { name: "Helper" },
    snapshot: { model: lead.model, instructions: "" },
    teamId: "team",
    lifetime: "temporary",
  });
  assert.deepEqual(f.store.getAssistant(member.id).inherited.skills, ["probe"]);
  // The member is not a user of its own: removal switches the lead off only.
  assert.deepEqual(
    catalogUsers(f.service, "probe").map((agent) => agent.id),
    [lead.id],
  );
  await t.test("the member's entry lists the skill", { todo: "Task 6" }, async () => {
    // The Gateway created the member when its team started.
    f.client.effective().agents.entries[member.runtimeAgentId] = {
      id: member.runtimeAgentId,
      model: "c/m",
    };
    await f.config.apply(member.id);
    assert.deepEqual(f.live(member).skills, ["probe"]);
  });
});

test("a user's settings patch with skills is refused", () => {
  const own = {
    id: "a",
    userAccess: { mode: "own", members: [{ userId: "u1", level: "extended" }] },
  };
  for (const level of ["chat", "personalize", "extended"])
    assert.throws(() => settingsPatch(own, level, { skills: ["probe"] }), {
      status: 400,
    });
  // The catalog and its switches stay out of every user route.
  for (const [method, path] of [
    ["GET", "/api/agent-skill-catalog"],
    ["DELETE", "/api/agent-skill-catalog/skills/x"],
    ["PATCH", "/api/assistants/a"],
    ["GET", "/api/assistants/a/skills"],
  ])
    assert.equal(userMayReach(method, path), false, `${method} ${path}`);
});
