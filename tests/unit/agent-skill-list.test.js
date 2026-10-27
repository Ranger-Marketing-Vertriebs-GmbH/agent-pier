import test from "node:test";
import assert from "node:assert/strict";
import {
  skillLocked,
  statusText,
  visibleSkills,
} from "../../web/features/assistants/settings/skill-list.js";
import {
  agentPageAllowed,
  resolveAgentLocation,
} from "../../web/features/assistants/settings/agent-settings-fields.js";
import { readAgentSettingsQuery } from "../../web/features/assistants/settings-routes.js";
import * as en from "../../web/lib/i18n/en/assistant-skills.js";

const copy = en.assistantSkillsCopy;
const none = { bins: [], anyBins: [], env: [], config: [], os: [] };
const skills = [
  { name: "github", description: "GitHub CLI", state: "ready", missing: none },
  {
    name: "himalaya",
    description: "Mail over IMAP",
    state: "missing",
    missing: { ...none, bins: ["himalaya"], env: ["MAIL_KEY"] },
  },
  {
    name: "apple-notes",
    description: "Notes",
    state: "unsupported",
    missing: { ...none, os: ["darwin"] },
  },
  { name: "tmux", description: "", state: "shadowed", missing: none },
];

test("skills filter by state, the draft's switches and a search term", () => {
  const names = (options) => visibleSkills(skills, options).map((s) => s.name);
  assert.deepEqual(names(), ["github", "himalaya", "apple-notes", "tmux"]);
  assert.deepEqual(names({ filter: "ready" }), ["github"]);
  assert.deepEqual(names({ filter: "missing" }), ["himalaya", "apple-notes", "tmux"]);
  assert.deepEqual(names({ filter: "on", on: ["tmux"] }), ["tmux"]);
  assert.deepEqual(names({ term: " imap " }), ["himalaya"]);
  assert.deepEqual(names({ term: "GIT" }), ["github"]);
});

test("the status line names what is missing", () => {
  assert.equal(statusText(skills[0], copy), "Ready");
  assert.equal(
    statusText(skills[1], copy),
    "Missing: programs himalaya; environment variables or API keys MAIL_KEY",
  );
  assert.equal(statusText(skills[2], copy), "Not available on this system (darwin)");
  assert.match(
    statusText(skills[3], copy),
    /^Off for this agent: a skill of the same name/,
  );
  assert.equal(statusText({ state: "missing", missing: none }, copy), "Missing");
  assert.equal(skillLocked(skills[3], false), true);
  assert.equal(skillLocked(skills[3], true), false);
  assert.equal(skillLocked(skills[1], false), false);
});

test("a catalog skill's status names why it is shadowed or unavailable", () => {
  const row = (state, more = {}) => ({
    state,
    source: "catalog",
    missing: none,
    ...more,
  });
  assert.match(
    statusText(row("shadowed", { shadowedBy: "bundled" }), copy),
    /^Off: a bundled skill of the same name replaces this catalog skill/,
  );
  // A skill in this agent's own folders: the generic text, never "remove the catalog skill".
  assert.equal(
    statusText(row("shadowed", { shadowedBy: "agentFolder" }), copy),
    copy.states.shadowed,
  );
  assert.equal(
    statusText(row("shadowed", { shadowedBy: "source" }), copy),
    copy.states.shadowedCatalogSource,
  );
  assert.doesNotMatch(
    statusText(row("shadowed", { shadowedBy: "source" }), copy),
    /bundled/,
  );
  assert.equal(statusText(row("unavailable"), copy), copy.states.unavailableCatalog);
  assert.doesNotMatch(statusText(row("unavailable"), copy), /OpenClaw version/);
  assert.equal(
    statusText({ state: "unavailable", missing: none }, copy),
    copy.states.unavailable,
  );
});

test("the skills subpage belongs to Capabilities and to eligible agents only", () => {
  assert.deepEqual(readAgentSettingsQuery("?page=skills"), {
    agentTab: "capabilities",
    agentPage: "skills",
  });
  assert.equal(agentPageAllowed({ id: "a" }, "skills"), true);
  assert.equal(
    agentPageAllowed({ id: "a", teamMemberId: "m", lifetime: "temporary" }, "skills"),
    false,
  );
  assert.equal(agentPageAllowed({ id: "a", archivedAt: "x" }, "skills"), false);
  assert.deepEqual(
    resolveAgentLocation({ id: "a" }, { agentTab: "capabilities", agentPage: "skills" }),
    {
      tab: "capabilities",
      page: "skills",
      tabs: [
        "overview",
        "identity",
        "capabilities",
        "access",
        "team",
        "automation",
        "channels",
      ],
      normalized: false,
    },
  );
});

test("catalog skills that need settings or are damaged cannot be switched on", () => {
  assert.equal(skillLocked({ state: "needsSettings" }, false), true);
  assert.equal(skillLocked({ state: "damaged" }, false), true);
  assert.equal(skillLocked({ state: "damaged" }, true), false);
});

test("the catalog filter keeps catalog skills only", () => {
  assert.deepEqual(
    visibleSkills([{ name: "a", source: "catalog" }, { name: "b" }], {
      filter: "catalog",
    }).map((s) => s.name),
    ["a"],
  );
});

test("needs-settings and damaged skills have their own status text", () => {
  assert.equal(
    statusText({ state: "needsSettings" }, copy),
    "Needs settings \u2014 not supported yet",
  );
  assert.equal(
    statusText({ state: "damaged" }, copy),
    "Damaged \u2014 install it again in Agents \u203a Skills",
  );
  assert.match(
    statusText({ state: "shadowed", source: "catalog", shadowedBy: "bundled" }, copy),
    /^Off: a bundled/,
  );
  assert.match(statusText({ state: "shadowed" }, copy), /^Off for this agent/);
});
