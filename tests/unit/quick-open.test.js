// Quick open (AGENTPIER-224): fuzzy matching, recent results, group order, the owner's
// sessions, projects, chats, runs, pipelines and inbox, and the restricted user's index
// that holds only the user's own agents and pages.
import test from "node:test";
import assert from "node:assert/strict";
import { routePath } from "../../web/app/routes.js";
import { buildSearchIndex } from "../../web/app/search-entries.js";
import { fuzzyGaps, searchEntries, termsOf } from "../../web/app/search-index.js";
import {
  readRecent,
  recentKey,
  recentLimit,
  rememberRecent,
} from "../../web/features/quick-open/recent-items.js";
import { workspaceEntries } from "../../web/features/quick-open/workspace-entries.js";
import { buildUserSearchIndex } from "../../web/features/users/user-search-entries.js";
import { userRoutePath } from "../../web/features/users/user-routes.js";
import { getLanguage, setLanguage } from "../../web/lib/i18n/index.js";

const memoryStorage = () => {
  const values = new Map();
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    values,
  };
};

const page = (id, label, extra = {}) => ({
  id,
  group: "pages",
  label: { de: label, en: label },
  path: { de: label, en: label },
  target: {},
  terms: termsOf(label),
  ...extra,
});
const flat = (groups) =>
  groups.flatMap((group) => group.items.map((item) => ({ ...item, group: group.group })));

const sources = {
  workspace: {
    sessions: [
      {
        id: "s1",
        name: "Refactor billing",
        tool: "claude",
        accountId: "work",
        cwd: "/home/me/code/billing-api",
        status: "running",
      },
      {
        id: "s2",
        name: "Pipeline step",
        tool: "codex",
        cwd: "/home/me/code/web",
        status: "stopped",
        pipeline: { headless: true },
      },
    ],
    accounts: [{ id: "work", name: "Firmenkonto" }],
    tools: [{ id: "claude", name: "Claude Code" }],
  },
  agents: [
    { id: "scout", name: "Scout" },
    { id: "old", name: "Altlast", archivedAt: "2026-01-01T00:00:00Z" },
    { id: "mia", name: "Mias Agent", userAccess: { mode: "shared", users: [] } },
  ],
  conversations: [
    { id: "c1", assistantId: "scout", main: true, title: "" },
    { id: "c2", assistantId: "scout", title: "Reiseplanung" },
    { id: "c3", assistantId: "scout", title: "Archiviert", archivedAt: "2026-02-01" },
    { id: "c4", assistantId: "old", title: "Alter Chat" },
    { id: "c5", assistantId: "mia", title: "Mias privater Chat", userId: "u-mia" },
    { id: "c6", assistantId: "mia", title: "Mein Chat mit Mia" },
  ],
  projects: [
    { id: "p1", name: "billing-api", cwd: "/home/me/code/billing-api" },
    { id: "p0", name: "billing-api", cwd: "/old/billing", duplicateOf: "p1" },
  ],
  repositories: [
    { id: "r1", name: "billing-api", path: "/home/me/code/billing-api" },
    { id: "r2", name: "landing-page", path: "/home/me/code/landing" },
  ],
  runs: [
    {
      id: "run-1",
      task: "# Fix the flaky login test\nDetails",
      status: "failed",
      pipelineName: "Review",
    },
  ],
  pipelines: [{ id: "review", name: "Review" }],
  inbox: [
    {
      type: "approval",
      id: "a1",
      kind: "shell",
      title: "rm -rf build",
      source: { name: "Scout" },
    },
  ],
};
const owner = workspaceEntries(sources, { agentsEnabled: true });
const find = (query, entries = owner) => flat(searchEntries(entries, query));
const pathOf = (item) => (item.target.route ? routePath(item.target.route) : null);

test("a token matches fuzzily from a word start with few skipped letters", () => {
  assert.equal(fuzzyGaps("session", "sesion"), 1);
  assert.equal(fuzzyGaps("new session", "nsess"), 3);
  assert.equal(fuzzyGaps("sessions history", "ssh"), null, "too spread out");
  assert.equal(fuzzyGaps("session", "es"), null, "short tokens never match fuzzily");
  assert.equal(fuzzyGaps("sea session", "sess"), 0, "the tightest word start wins");
  assert.equal(fuzzyGaps("projects", "xyz"), null);
});

test("fuzzy matches rank after exact, prefix, word and inner matches", () => {
  const entries = [
    page("fuzzy", "Settings for sessions"),
    page("exact", "Sesion"),
    page("inner", "Obsesion"),
  ];
  assert.deepEqual(
    find("sesion", entries).map((item) => item.id),
    ["exact", "inner", "fuzzy"],
  );
  assert.deepEqual(find("zzqqxx", entries), []);
});

test("recent results come first on a blank query and win ties", () => {
  const entries = [
    page("a", "Alpha", { suggested: true }),
    page("b", "Beta", { suggested: true }),
    page("c", "Gamma"),
  ];
  const blank = searchEntries(entries, "", undefined, { recent: ["c", "gone", "b"] });
  assert.deepEqual(
    blank.map((group) => [group.group, group.items.map((item) => item.id)]),
    [
      ["recent", ["c", "b"]],
      ["pages", ["a"]],
    ],
    "a recent id without an entry is left out; recent entries are not repeated",
  );
  const ties = [page("x", "Report one"), page("y", "Report two")];
  assert.deepEqual(
    find("report", ties).map((item) => item.id),
    ["x", "y"],
  );
  assert.deepEqual(
    flat(searchEntries(ties, "report", undefined, { recent: ["y"] })).map((i) => i.id),
    ["y", "x"],
  );
});

test("groups follow their best match", () => {
  const billing = searchEntries(owner, "billing").map((group) => group.group);
  assert.deepEqual(billing.slice(0, 2), ["projects", "sessions"]);
  const refactor = searchEntries(owner, "refactor").map((group) => group.group);
  assert.equal(refactor[0], "sessions");
  const actions = searchEntries(owner, "Lauf starten").map((group) => group.group);
  assert.equal(actions[0], "actions");
});

test("recent ids are stored per person, newest first, without duplicates", () => {
  const storage = memoryStorage();
  assert.deepEqual(readRecent("owner", storage), []);
  rememberRecent("owner", "session:s1", storage);
  rememberRecent("owner", "page:inbox", storage);
  rememberRecent("owner", "session:s1", storage);
  assert.deepEqual(readRecent("owner", storage), ["session:s1", "page:inbox"]);
  assert.deepEqual(readRecent("user:mia", storage), [], "people never share them");
  for (let n = 0; n < 20; n += 1) rememberRecent("owner", `id-${n}`, storage);
  assert.equal(readRecent("owner", storage).length, recentLimit);
  storage.setItem(recentKey("broken"), "{not json");
  assert.deepEqual(readRecent("broken", storage), []);
  storage.setItem(recentKey("odd"), JSON.stringify(["ok", 5, null, "x".repeat(500)]));
  assert.deepEqual(readRecent("odd", storage), ["ok"]);
  assert.deepEqual(rememberRecent("owner", "z", null), ["z"], "no storage still works");
});

test("sessions are found by name, project, CLI and account and open themselves", () => {
  for (const query of [
    "Refactor",
    "billing api",
    "Claude Code",
    "Firmenkonto",
    "refactr",
    "billing claude",
  ]) {
    const hit = find(query).find((item) => item.group === "sessions");
    assert.ok(hit, query);
    assert.deepEqual(hit.target, { session: "s1" });
  }
  assert.equal(find("Pipeline step").filter((i) => i.group === "sessions").length, 0);
  const hit = find("Refactor")[0];
  assert.equal(hit.path.en, "Sessions › billing-api");
  assert.equal(hit.meta.en, "Claude Code · Firmenkonto");
});

test("a project's Tickets tab is found by project name", () => {
  const hit = find("billing tickets").find((item) => item.id === "project-tickets:p1");
  assert.equal(pathOf(hit), "/projects/p1?tab=tickets");
  assert.equal(hit.path.en, "Projects › billing-api");
  assert.equal(
    pathOf(find("landing issues").find((item) => item.id === "project-tickets:r2")),
    "/projects/r2?tab=tickets",
  );
  assert.equal(
    find("billing tickets").filter((i) => i.id === "project-tickets:p0").length,
    0,
  );
});

test("projects are listed once per folder and open on the projects page", () => {
  const projects = find("billing").filter(
    (item) => item.group === "projects" && item.id.startsWith("project:"),
  );
  assert.deepEqual(
    projects.map((item) => pathOf(item)),
    ["/projects/p1"],
  );
  assert.equal(pathOf(find("landing")[0]), "/projects/r2");
  assert.equal(find("/old/billing").filter((i) => i.group === "projects").length, 0);
});

test("chats: only the owner's open chats on agents the owner uses", () => {
  const chats = owner.filter((item) => item.group === "chats");
  assert.deepEqual(
    chats.map((item) => item.id),
    ["chat:c1", "chat:c2", "chat:c6"],
  );
  assert.equal(pathOf(find("Reiseplanung")[0]), "/agents/scout/chats/c2");
  assert.equal(pathOf(find("Scout Reiseplanung")[0]), "/agents/scout/chats/c2");
  assert.equal(find("Reiseplanung")[0].path.de, "Agenten › Scout");
  const off = workspaceEntries(sources, { agentsEnabled: false });
  assert.equal(off.filter((item) => item.group === "chats").length, 0);
});

test("runs, pipelines and inbox items open their own page", () => {
  const run = find("flaky login")[0];
  assert.equal(run.group, "runs");
  assert.equal(run.label.en, "Fix the flaky login test");
  assert.equal(pathOf(run), "/pipelines/runs/run-1");
  assert.equal(run.meta.en, "Failed");
  const pipeline = find("Review").find((item) => item.id === "pipeline:review");
  assert.equal(pathOf(pipeline), "/pipelines/definitions/review");
  const inbox = find("rm -rf")[0];
  assert.equal(inbox.group, "inbox");
  assert.equal(pathOf(inbox), "/inbox/approval/a1");
});

test("New run and Open inbox are actions", () => {
  const action = (query) => find(query).find((item) => item.group === "actions");
  assert.equal(pathOf(action("Start run")), "/pipelines/runs/new");
  assert.equal(pathOf(action("Lauf starten")), "/pipelines/runs/new");
  assert.equal(pathOf(action("Open inbox")), "/inbox");
  assert.equal(pathOf(action("Eingang öffnen")), "/inbox");
});

test("Start tickets is an owner action only, not in the user's search", () => {
  const owners = buildSearchIndex({ agents: [], connections: null, agentsEnabled: true });
  const action = (query) => flat(searchEntries(owners, query))[0];
  assert.equal(action("Start tickets").id, "action:start-tickets");
  assert.equal(action("Tickets starten").id, "action:start-tickets");
  const users = buildUserSearchIndex({ agents: [{ id: "lumi", name: "Lumi" }] });
  assert.equal(
    users.some((item) => item.id === "action:start-tickets"),
    false,
  );
});

test("Add label rule is an owner action only, not in the user's search", () => {
  const owners = buildSearchIndex({ agents: [], connections: null, agentsEnabled: true });
  const action = (query) => flat(searchEntries(owners, query))[0];
  assert.equal(action("Add label rule").id, "action:add-label-rule");
  assert.equal(action("Label-Regel hinzufügen").id, "action:add-label-rule");
  const users = buildUserSearchIndex({ agents: [{ id: "lumi", name: "Lumi" }] });
  assert.equal(
    users.some((item) => item.id === "action:add-label-rule"),
    false,
  );
});

test("a source not loaded yet adds nothing", () => {
  const entries = workspaceEntries({}, { agentsEnabled: true });
  assert.deepEqual([...new Set(entries.map((item) => item.group))], ["actions"]);
});

test("a restricted user's index holds only the user's agents and pages", () => {
  const index = buildUserSearchIndex({
    agents: [
      { id: "lumi", name: "Lumi", avatar: "🦊", conversationId: "main-1" },
      { id: "helper", name: "Helper", shared: true },
    ],
  });
  const owners = buildSearchIndex({ agents: [], connections: null, agentsEnabled: true });
  const ownerIds = new Set([...owners, ...owner].map((item) => item.id));
  assert.equal(
    index.some((item) => ownerIds.has(item.id)),
    false,
  );
  const groups = new Set(index.map((item) => item.group));
  assert.deepEqual([...groups].sort(), ["agents", "chats", "pages"]);
  // Every target is a route of the user's app or opens one of their agents' chats.
  for (const item of index) {
    if (item.target.route)
      assert.notEqual(userRoutePath(item.target.route), undefined, item.id);
    else assert.ok(["lumi", "helper"].includes(item.target.openAgent), item.id);
  }
  const search = (query) => flat(searchEntries(index, query));
  assert.deepEqual(search("Lumi")[0].target, { openAgent: "lumi" });
  assert.equal(
    userRoutePath(search("Helper memory").find((i) => i.group === "agents").target.route),
    "/agents/helper/settings?page=memory",
  );
  assert.equal(userRoutePath(search("Konto")[0].target.route), "/account");
  for (const owners of ["Sessions", "Pipelines", "Zugänge", "SSH", "Projekte", "Eingang"])
    assert.deepEqual(search(owners), [], owners);
});

test("the user's labels follow the language", () => {
  const before = getLanguage();
  try {
    setLanguage("en");
    const index = buildUserSearchIndex({ agents: [{ id: "lumi", name: "Lumi" }] });
    const chat = index.find((item) => item.group === "chats");
    assert.equal(chat.label.en, "Chat with Lumi");
    assert.equal(chat.label.de, "Chat mit Lumi");
  } finally {
    setLanguage(before);
  }
});

test("Show changes is an owner action only, not in the user's search", () => {
  const users = buildUserSearchIndex({ agents: [{ id: "lumi", name: "Lumi" }] });
  assert.ok(!users.some((item) => item.id === "action:session-changes"));
  const owners = buildSearchIndex({ agentsEnabled: true, sessionOpen: true });
  assert.ok(owners.some((item) => item.id === "action:session-changes"));
});

test("Review changes is an owner action only, not in the user's search", () => {
  const users = buildUserSearchIndex({ agents: [{ id: "lumi", name: "Lumi" }] });
  assert.ok(!users.some((item) => item.id === "action:run-changes"));
  const owners = buildSearchIndex({ agentsEnabled: true, runOpen: true });
  assert.ok(owners.some((item) => item.id === "action:run-changes"));
});

test("choosing an agent's pinboard entry navigates to the pinboard route", () => {
  const entries = buildSearchIndex({
    agents: [{ id: "ops", name: "Ops-Wache" }],
    agentsEnabled: true,
  });
  const hit = flat(searchEntries(entries, "Ops-Wache Pinnwand")).find(
    (item) => item.id === "agent:ops:pinboard",
  );
  assert.deepEqual(hit.target, {
    route: { view: "agents", assistantId: "ops", pinboard: true },
  });
  assert.equal(routePath(hit.target.route), "/agents/ops/pinboard");
});
