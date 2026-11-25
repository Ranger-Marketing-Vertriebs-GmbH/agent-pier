import test from "node:test";
import assert from "node:assert/strict";
import {
  groupSkills,
  searchSkills,
  sharedRevision,
} from "../../web/features/extensions/skill-groups.js";
import {
  catalogGroupMeta,
  catalogSkillUsage,
  catalogSource,
  catalogSourceCheck,
  hasFindings,
  matchesFilter,
} from "../../web/features/assistants/hub/catalog-skill-view.js";
import { setLanguage } from "../../web/lib/i18n/index.js";

setLanguage("en");

const origin = (commit, ref = "main", refKind = "branch") => ({
  kind: "github",
  repository: "acme/skills",
  ref,
  refKind,
  commit,
});
const skill = (name, extra = {}) => ({
  id: name,
  name,
  description: `Use ${name} when asked.`,
  importKind: "github",
  origin: origin("0123456789abcdef"),
  scan: { verdict: "ok", rules: [], overridden: false },
  state: "ready",
  agents: [],
  ...extra,
});

test("the search matches every word in the name, the description or extra texts", () => {
  const skills = [skill("gh-notes"), skill("trips", { description: "Plan a Reise." })];
  assert.deepEqual(
    searchSkills(skills, " NOTES gh ").map((item) => item.name),
    ["gh-notes"],
  );
  assert.deepEqual(
    searchSkills(skills, "reise plan").map((item) => item.name),
    ["trips"],
  );
  assert.deepEqual(searchSkills(skills, "notes reise"), []);
  assert.equal(searchSkills(skills, "  ").length, 2);
  assert.deepEqual(
    searchSkills(skills, "profile", (item) => [
      item.name === "trips" ? "Claude profile" : "",
    ]).map((item) => item.name),
    ["trips"],
  );
});

test("catalog skills group by repository, plain GitHub and uploads, sorted by name", () => {
  const groups = groupSkills(
    [
      skill("zeta"),
      skill("upload-b", { importKind: "skill-md", origin: undefined }),
      skill("plain", { origin: undefined }),
      skill("alpha"),
      skill("other", { origin: { ...origin("ffff000"), repository: "zed/pack" } }),
      skill("upload-a", { importKind: "zip", origin: undefined }),
    ],
    catalogSource,
  );
  assert.deepEqual(
    groups.map((group) => [group.title, group.skills.map((item) => item.name)]),
    [
      ["acme/skills", ["alpha", "zeta"]],
      ["zed/pack", ["other"]],
      ["GitHub", ["plain"]],
      ["Uploaded", ["upload-a", "upload-b"]],
    ],
  );
  assert.equal(catalogGroupMeta(groups[0]), "main · 0123456 · 2 skills");
  assert.equal(catalogGroupMeta(groups[2]), "1 skill");
  assert.equal(catalogGroupMeta(groups[3]), "2 skills");
});

test("a group names a revision only when all of its skills share it", () => {
  assert.deepEqual(sharedRevision([skill("a"), skill("b")]), {
    ref: "main",
    commit: "0123456",
  });
  assert.equal(
    sharedRevision([skill("a"), skill("b", { origin: origin("9999999abc") })]),
    null,
  );
  assert.equal(sharedRevision([skill("a"), skill("b", { origin: undefined })]), null);
  // A link that named a commit has no branch or tag to show beside it.
  assert.deepEqual(
    sharedRevision([
      skill("a", { origin: origin("abcdef0123", "abcdef0123", "commit") }),
    ]),
    { ref: "", commit: "abcdef0" },
  );
  const mixed = groupSkills(
    [skill("a"), skill("b", { origin: origin("9999999abc") })],
    catalogSource,
  );
  assert.equal(catalogGroupMeta(mixed[0]), "2 skills");
});

test("a repository group is checked as a whole when its skills share a ref", () => {
  const group = (skills) => groupSkills(skills, catalogSource)[0];
  const checked = (name, extra) => skill(name, { repository: true, ...extra });
  assert.deepEqual(
    catalogSourceCheck(
      group([checked("a"), checked("b", { origin: origin("9999999abc") })]),
    ),
    { repository: "acme/skills", ref: "main" },
  );
  // Mixed refs, no skill with an update check, or no repository: one by one.
  assert.equal(
    catalogSourceCheck(
      group([checked("a"), checked("b", { origin: origin("0123456789abcdef", "v2") })]),
    ),
    null,
  );
  assert.equal(catalogSourceCheck(group([skill("a")])), null);
  assert.equal(
    catalogSourceCheck(group([checked("a", { importKind: "zip", origin: undefined })])),
    null,
  );
});

test("rows count agents, and the filters follow use, findings and limits", () => {
  const used = skill("used", { agents: [{ id: "1", name: "Home" }] });
  const two = skill("two", { agents: [{ id: "1" }, { id: "2" }] });
  const warned = skill("warned", { scan: { verdict: "warn" } });
  const shadowed = skill("shadowed", { state: "shadowed", shadowedBy: "bundled" });
  const plain = skill("plain");
  assert.equal(catalogSkillUsage(used), "1 agent");
  assert.equal(catalogSkillUsage(two), "2 agents");
  assert.equal(catalogSkillUsage(plain), "Unused");
  assert.equal(catalogSkillUsage(used, true), "On for 1 agent");
  assert.equal(catalogSkillUsage(plain, true), "Not switched on for any agent");
  assert.equal(hasFindings(plain), false);
  assert.equal(hasFindings(warned), true);
  assert.equal(hasFindings(shadowed), true);
  const names = (filter) =>
    [used, two, warned, shadowed, plain]
      .filter((item) => matchesFilter(item, filter))
      .map((item) => item.name);
  assert.deepEqual(names("all"), ["used", "two", "warned", "shadowed", "plain"]);
  assert.deepEqual(names("used"), ["used", "two"]);
  assert.deepEqual(names("unused"), ["warned", "shadowed", "plain"]);
  assert.deepEqual(names("findings"), ["warned", "shadowed"]);
});
