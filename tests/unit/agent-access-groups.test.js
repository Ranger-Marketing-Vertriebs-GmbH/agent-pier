import test from "node:test";
import assert from "node:assert/strict";
import {
  addIds,
  addProjects,
  addSshGrants,
  candidatesOf,
  firstEntries,
  grantedItems,
  grantedProjectIds,
  inlineLimit,
  removeId,
  removeProject,
} from "../../web/features/assistants/settings/access/access-groups.js";
import {
  accessSummary,
  automationSummary,
  capabilitySummary,
  channelSummary,
  identitySummary,
  teamSummary,
} from "../../web/features/assistants/settings/overview-glance.js";
import { setLanguage } from "../../web/lib/i18n/index.js";

test("a long group shows its first entries and counts the rest", () => {
  const entries = Array.from({ length: 12 }, (_, i) => i);
  assert.deepEqual(firstEntries(entries), {
    shown: entries.slice(0, inlineLimit),
    more: 12 - inlineLimit,
  });
  assert.deepEqual(firstEntries([1, 2]), { shown: [1, 2], more: 0 });
});

test("granted items keep catalog order and drop unknown ids", () => {
  const catalog = [
    { id: "a", name: "A" },
    { id: "b", name: "B" },
    { id: "c", name: "C" },
  ];
  assert.deepEqual(
    grantedItems(catalog, ["c", "a", "gone"]).map((i) => i.id),
    ["a", "c"],
  );
  assert.deepEqual(grantedItems(null, ["a"]), []);
  assert.deepEqual(
    candidatesOf(catalog.slice(0, 1), () => ({ sub: "/p" })),
    [{ id: "a", name: "A", sub: "/p" }],
  );
});

test("adding projects writes coding and the chosen folder level into the draft", () => {
  const values = { projectIds: ["p1"], projectFiles: { p1: "read" } };
  assert.deepEqual(addProjects(values, ["p3", "p2"], "write", false), {
    projectIds: ["p1", "p2", "p3"],
    projectFiles: { p1: "read", p2: "write", p3: "write" },
  });
  // "Keiner" grants coding only.
  assert.deepEqual(addProjects(values, ["p2"], "none", false), {
    projectIds: ["p1", "p2"],
    projectFiles: { p1: "read" },
  });
  assert.deepEqual(removeProject(values, "p1", false), {
    projectIds: [],
    projectFiles: {},
  });
  assert.deepEqual(grantedProjectIds(values, false), ["p1"]);
});

test("an agent of users gets folders only, at least read", () => {
  const values = { projectIds: [], projectFiles: {} };
  const added = addProjects(values, ["p1"], "none", true);
  assert.deepEqual(added, { projectIds: [], projectFiles: { p1: "read" } });
  assert.deepEqual(grantedProjectIds(added, true), ["p1"]);
  assert.deepEqual(removeProject(added, "p1", true), {
    projectIds: [],
    projectFiles: {},
  });
});

test("SSH hosts are added with one mode; granted hosts keep theirs", () => {
  const grants = [{ accessId: "b", mode: "trusted" }];
  assert.deepEqual(addSshGrants(grants, ["c", "a", "b"], "approval"), [
    { accessId: "a", mode: "approval" },
    { accessId: "b", mode: "trusted" },
    { accessId: "c", mode: "approval" },
  ]);
  assert.deepEqual(addIds(["b"], ["a", "b"]), ["a", "b"]);
  assert.deepEqual(removeId(["a", "b"], "a"), ["b"]);
});

test("the overview summarises each tab from known data only", () => {
  setLanguage("en");
  const agent = {
    id: "home",
    model: { modelId: "gpt-x" },
    template: { id: "t" },
    capabilities: { memory: true, webSearch: true, reminders: false, readPdfs: true },
    shell: "approval",
    skills: ["a", "b"],
    mcpServers: ["m1"],
    heartbeat: { enabled: true },
  };
  assert.equal(identitySummary(agent), "gpt-x · from a template");
  assert.equal(
    identitySummary({ ...agent, teamMemberId: "m", lifetime: "task", template: null }),
    "follows the lead's model",
  );
  assert.equal(
    capabilitySummary(agent),
    "Memory · Web · PDFs · Shell: With approval · 2 skills",
  );
  assert.equal(
    capabilitySummary({ ...agent, capabilities: {}, shell: "off", skills: [] }),
    "Nothing switched on",
  );
  assert.equal(accessSummary(null, agent), null);
  assert.equal(
    accessSummary(
      {
        projectIds: ["p1", "p2"],
        sshAccesses: [{ accessId: "s" }],
        github: { level: "read" },
        secretIds: [],
      },
      agent,
    ),
    "2 projects · 1 MCP · 1 SSH/SFTP · GitHub Read",
  );
  assert.equal(accessSummary({}, { ...agent, mcpServers: [] }), "Nothing granted yet");
  assert.equal(teamSummary(null, [], "home"), null);
  assert.equal(
    teamSummary({ usage: "autonomous" }, [{ parentAssistantId: "home" }], "home"),
    "Autonomous · 1 active team",
  );
  assert.equal(
    automationSummary(agent),
    "Checks in on its own · Reminders and routines off",
  );
  assert.equal(channelSummary(null, "home"), null);
  assert.equal(
    channelSummary([{ assistantId: "home", hasSecret: true }], "home"),
    "Telegram connected",
  );
  assert.equal(channelSummary([], "home"), "Telegram not connected");
  setLanguage("de");
});
