import test from "node:test";
import assert from "node:assert/strict";
import {
  addIds,
  addMailGrants,
  addProjects,
  addSshGrants,
  candidatesOf,
  firstEntries,
  grantedItems,
  grantedProjectIds,
  inlineLimit,
  removeId,
  removeProject,
  setSessionProject,
} from "../../web/features/assistants/settings/access/access-groups.js";
import {
  accessServer,
  invalidMailGrants,
  recipientLines,
  recipientRulesProblem,
  validRecipientRule,
  setMailGrant,
  workBody,
} from "../../web/features/assistants/settings/agent-settings-fields.js";
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
    sessionProjectIds: [],
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
    sessionProjectIds: [],
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

test("the coding sessions grant is added sorted, removed, and dropped with its project", () => {
  const values = { projectIds: ["a", "p"], projectFiles: {}, sessionProjectIds: ["b"] };
  assert.deepEqual(setSessionProject(values, "p", true), {
    sessionProjectIds: ["b", "p"],
  });
  assert.deepEqual(setSessionProject(values, "a", true), {
    sessionProjectIds: ["a", "b"],
  });
  assert.deepEqual(setSessionProject(values, "b", false), { sessionProjectIds: [] });
  assert.deepEqual(setSessionProject({ projectIds: [] }, "p", true), {
    sessionProjectIds: ["p"],
  });
  const withP = { ...values, sessionProjectIds: ["b", "p"] };
  assert.deepEqual(removeProject(withP, "p", false).sessionProjectIds, ["b"]);
  assert.deepEqual(accessServer({ sessionProjectIds: ["b", "a"] }).sessionProjectIds, [
    "a",
    "b",
  ]);
  assert.deepEqual(accessServer({}).sessionProjectIds, []);
});

test("mail grants are set sorted, keep rules only for send and are removed by null", () => {
  assert.deepEqual(setMailGrant([], "a", "send", ["x.de"]), [
    { accountId: "a", level: "send", recipients: ["x.de"] },
  ]);
  const held = setMailGrant(
    [{ accountId: "c", level: "read", recipients: [] }],
    "a",
    "send",
    ["x.de"],
  );
  assert.deepEqual(
    held.map((g) => g.accountId),
    ["a", "c"],
  );
  // Switching to read empties the rules; switching back starts without rules.
  const read = setMailGrant(held, "a", "read");
  assert.deepEqual(read[0], { accountId: "a", level: "read", recipients: [] });
  assert.deepEqual(setMailGrant(read, "a", "send")[0].recipients, []);
  // A level change at send keeps the rules; new rules replace them.
  assert.deepEqual(setMailGrant(held, "a", "send")[0].recipients, ["x.de"]);
  assert.deepEqual(setMailGrant(held, "a", "send", ["b@y.de"])[0].recipients, ["b@y.de"]);
  assert.deepEqual(setMailGrant(held, "a", null), [
    { accountId: "c", level: "read", recipients: [] },
  ]);
  // Adding keeps existing grants as they are.
  assert.deepEqual(addMailGrants(held, ["a", "b"], "read"), [
    { accountId: "a", level: "send", recipients: ["x.de"] },
    { accountId: "b", level: "read", recipients: [] },
    { accountId: "c", level: "read", recipients: [] },
  ]);
  assert.deepEqual(
    accessServer({
      mailAccesses: [
        { accountId: "b", level: "read", recipients: ["ignored.de"] },
        { accountId: "a", level: "send", recipients: ["x.de"] },
      ],
    }).mailAccesses,
    [
      { accountId: "a", level: "send", recipients: ["x.de"] },
      { accountId: "b", level: "read", recipients: [] },
    ],
  );
  assert.deepEqual(accessServer({}).mailAccesses, []);
});

test("recipient rules are read one per line, trimmed and lower case", () => {
  assert.deepEqual(recipientLines(" Example.com \n\n bob@Example.com\r\n"), [
    "example.com",
    "bob@example.com",
  ]);
  assert.deepEqual(recipientLines(""), []);
  // Repeats count once, as the server keeps them.
  assert.deepEqual(recipientLines("a.de\nA.de\nb.de"), ["a.de", "b.de"]);
});

test("recipient rules are checked like the server checks them", () => {
  for (const rule of ["example.com", "bob@example.com", "a+tag@sub.example.co.uk"])
    assert.equal(validRecipientRule(rule), true, rule);
  for (const rule of [
    '"Bob" <bob@example.com>',
    "Bob <bob@example.com>",
    "*.example.com",
    "localhost",
    "@example.com",
    "a@b@example.com",
    "bob smith@example.com",
    "example..com",
    "-example.com",
    "",
  ])
    assert.equal(validRecipientRule(rule), false, rule);
  assert.deepEqual(recipientRulesProblem(["ok.de", "localhost", "@x.de"]), {
    invalid: "localhost",
  });
  const many = Array.from({ length: 51 }, (_, i) => `r${i}.example.com`);
  assert.deepEqual(recipientRulesProblem(many), { tooMany: 50 });
  assert.equal(recipientRulesProblem(many.slice(0, 50)), null);
  assert.equal(recipientRulesProblem([]), null);
  assert.deepEqual(
    invalidMailGrants([
      { accountId: "a", level: "send", recipients: ["localhost"] },
      { accountId: "b", level: "send", recipients: ["ok.de"] },
      { accountId: "c", level: "read", recipients: [] },
    ]),
    ["a"],
  );
});

test("the work body sends mail grants only when they changed", () => {
  const values = {
    projectIds: [],
    pipelineIds: [],
    memoryWrite: false,
    autonomous: false,
    publish: false,
    mailAccesses: [{ accountId: "a", level: "send", recipients: ["example.com"] }],
  };
  const sent = workBody({ values, changed: ["mailAccesses"], revisions: { access: 3 } });
  assert.deepEqual(sent.access.mailAccesses, values.mailAccesses);
  assert.equal(sent.access.revision, 3);
  const other = workBody({ values, changed: ["publish"], revisions: { access: 3 } });
  assert.equal("mailAccesses" in other.access, false);
});
