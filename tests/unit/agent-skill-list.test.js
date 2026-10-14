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
      tabs: ["profile", "capabilities", "work", "telegram"],
      normalized: false,
    },
  );
});
