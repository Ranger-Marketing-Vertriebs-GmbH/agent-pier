// ⌘K coverage of the areas' tabs, groups and actions (AGENTPIER-418, AGENTPIER-391,
// AGENTPIER-388): each is found in German and English, by its old names, and opens its
// place. Split from search-index.test.js by topic.
import test from "node:test";
import assert from "node:assert/strict";
import { routePath } from "../../web/app/routes.js";
import { buildSearchIndex } from "../../web/app/search-entries.js";
import { searchEntries, swappedTokens } from "../../web/app/search-index.js";
import { workspaceEntries } from "../../web/features/quick-open/workspace-entries.js";
import { buildUserSearchIndex } from "../../web/features/users/user-search-entries.js";

const agents = [
  { id: "ops", name: "Ops-Wache" },
  { id: "tmp", name: "Helfer", teamMemberId: "m-1", lifetime: "temporary" },
  { id: "usr", name: "Mias Agent", userAccess: { users: [] } },
];
const workspace = {
  tools: [
    { id: "claude", name: "Claude Code" },
    { id: "codex", name: "Codex" },
  ],
  accounts: [
    { id: "acc-work", name: "work@example.com", tool: "claude" },
    { id: "acc-home", name: "home", tool: "codex" },
    { id: "local-shell", name: "Terminal", tool: "shell" },
  ],
  sessions: [
    {
      id: "s-run",
      name: "Billing",
      tool: "claude",
      status: "running",
      cwd: "/w/billing",
      agentpierTools: true,
    },
    { id: "s-old", name: "Old shop", tool: "codex", status: "stopped", cwd: "/w/shop" },
    { id: "s-sh", name: "Plain shell", tool: "shell", status: "running", cwd: "/w" },
  ],
};
const sources = {
  workspace,
  projects: [{ id: "p-alpha", name: "alpha", cwd: "/w/alpha" }],
  profiles: [{ id: "bug-hunter", name: "Bug Hunter" }],
  views: [{ id: "v_design", name: "Design review" }],
};
const build = (offered = []) => [
  ...buildSearchIndex({ agents, agentsEnabled: true, offered }),
  ...workspaceEntries(sources, { agentsEnabled: true }),
];
const index = build();
const results = (query, entries = index) =>
  searchEntries(entries, query, {}).flatMap((group) =>
    group.items.map((item) => ({ ...item, group: group.group })),
  );
const first = (query, entries) => results(query, entries)[0];
const pathOf = (item) => (item?.target.route ? routePath(item.target.route) : null);

test("project tabs are found in both languages and by project name", () => {
  for (const [query, path] of [
    ["Knowledge", "/projects?tab=knowledge"],
    ["Wissen", "/projects?tab=knowledge"],
    ["Memory", "/projects?tab=knowledge"],
    ["Gedächtnis", "/projects?tab=knowledge"],
    ["AgentBus", "/projects?tab=agentbus"],
    ["AgentBus Messages", "/projects?tab=agentbus&bus=messages"],
    ["Projekte Läufe", "/projects?tab=runs"],
    ["Projects Approvals", "/projects?tab=approvals"],
    ["Projekte Freigaben", "/projects?tab=approvals"],
    ["Projects Agents", "/projects?tab=agents"],
  ])
    assert.ok(
      results(query).some((item) => pathOf(item) === path),
      `${query} → ${path}`,
    );
  assert.equal(pathOf(first("alpha knowledge")), "/projects/p-alpha?tab=knowledge");
  assert.equal(pathOf(first("alpha wissen")), "/projects/p-alpha?tab=knowledge");
  assert.equal(pathOf(first("alpha agentbus")), "/projects/p-alpha?tab=agentbus");
});

test("groups inside pages open their page", () => {
  for (const [query, path] of [
    ["Pinned", "/artifacts?tab=pinned"],
    ["Angepinnt", "/artifacts?tab=pinned"],
    ["Tailscale", "/settings/remote"],
    ["Netzwerk", "/settings/remote"],
    ["Additional hosts", "/settings/remote"],
    ["Previews", "/settings/remote"],
    ["Vorschauen", "/settings/remote"],
    ["Notifications on this device", "/settings/notifications"],
    ["AgentPier als App", "/settings/notifications"],
    ["Registered devices", "/settings/notifications"],
    ["Risk rules", "/pipelines/verification"],
    ["Concurrent runs", "/pipelines/queue"],
    ["Gleichzeitige Läufe", "/pipelines/queue"],
    ["Your rebuilds", "/craft"],
    ["Images and media", "/agents?tab=runtime&section=advanced"],
    ["Aufträge", "/agents?tab=runtime&section=advanced"],
    ["Agent groups", "/agents"],
    ["E-Mail-Zugänge", "/connections?section=mail"],
    ["Email accounts", "/connections?section=mail"],
    ["ChatGPT for agents", "/connections?section=models"],
  ])
    assert.ok(
      results(query).some((item) => item.group === "pages" && pathOf(item) === path),
      `${query} → ${path}`,
    );
  const status = first("System status");
  assert.equal(pathOf(status), "/");
  assert.equal(status.target.pending, "system-status");
  // ChatGPT for agents belongs to the agent feature.
  const off = buildSearchIndex({ agents, agentsEnabled: false });
  assert.ok(!off.some((entry) => entry.id === "page:connections-chatgpt"));
});

test("CLI accounts are found by name, CLI and the words people use", () => {
  for (const query of ["work@example.com", "Konten", "Claude-Login", "claude login"]) {
    const hit = results(query).find((item) => item.id === "cli-account:acc-work");
    assert.ok(hit, query);
    assert.equal(pathOf(hit), "/coding/clis?tab=accounts&item=acc-work");
  }
  assert.ok(results("Codex-Login").some((item) => item.id === "cli-account:acc-home"));
  assert.ok(!index.some((item) => item.id === "cli-account:local-shell"));
  // The Accounts tab itself is found as "Konten" too.
  assert.ok(results("Konten").some((item) => item.id === "page:coding-accounts"));
});

test("task profiles and views are found by name", () => {
  assert.equal(pathOf(first("Bug Hunter")), "/pipelines/profiles/bug-hunter");
  assert.equal(pathOf(first("Design review")), "/views/v_design");
});

test("the area actions open their place or are offered only where they work", () => {
  const add = first("Add email account");
  assert.equal(add.target.pending, "mail-add");
  assert.equal(pathOf(add), "/connections?section=mail");
  assert.equal(first("E-Mail-Zugang hinzufügen").id, "action:add-mail");
  assert.equal(first("Install skill").target.extensions, "skills");
  assert.equal(pathOf(first("Update CLI")), "/coding/clis");
  assert.equal(pathOf(first("Chrome for Testing")), "/coding/clis");
  for (const [query, kind] of [
    ["New view", "view-new"],
    ["Neue Ansicht", "view-new"],
    ["Sign out", "sign-out"],
    ["Abmelden", "sign-out"],
    ["Archived chats", "chat-archived"],
    ["Archivierte Chats", "chat-archived"],
  ]) {
    assert.ok(!results(query).some((item) => item.target.action === kind), query);
    assert.ok(
      results(query, build([kind])).some((item) => item.target.action === kind),
      query,
    );
  }
});

test("a session's own actions are found by session name and open that session", () => {
  const ids = (query) => results(query).map((item) => item.id);
  assert.ok(ids("Billing reload").includes("session:s-run:reload"));
  assert.ok(ids("Billing Neu laden").includes("session:s-run:reload"));
  assert.ok(ids("Billing AgentPier tools").includes("session:s-run:mcp"));
  assert.ok(ids("Billing stop").includes("session:s-run:stop"));
  assert.ok(ids("Old shop remove").includes("session:s-old:remove"));
  assert.ok(!ids("Billing remove").includes("session:s-run:remove"));
  assert.ok(!ids("Old shop stop").includes("session:s-old:stop"));
  // A shell has no reload, no account switch and no background tasks.
  assert.ok(
    !index.some((item) => /^session:s-sh:(reload|switch-account|tasks)$/.test(item.id)),
  );
  const tasks = index.find((item) => item.id === "session:s-run:tasks");
  assert.deepEqual(tasks.target, {
    session: "s-run",
    mode: "reader",
    pending: "session-tasks:s-run",
  });
  assert.equal(
    index.find((item) => item.id === "session:s-run:stop").target.pending,
    "session-stop:s-run",
  );
});

test("an agent's own actions open its settings or the wizard", () => {
  const duplicate = results("Ops-Wache Duplicate").find(
    (item) => item.group === "actions",
  );
  assert.equal(duplicate.id, "agent:ops:action:duplicate");
  assert.deepEqual(duplicate.target.route, {
    view: "agents",
    creating: true,
    duplicate: "ops",
  });
  assert.equal(
    first("Ops-Wache Hauptchat neu starten").target.pending,
    "agent-main-chat-restart:ops",
  );
  assert.equal(
    first("Ops-Wache Clear attachments").target.pending,
    "agent-attachments-clear:ops",
  );
  assert.equal(pathOf(first("Ops-Wache Archivieren")), "/agents/ops/settings");
  const ids = new Set(index.map((item) => item.id));
  // A temporary member is not duplicated and restarts with its lead; a user's agent
  // keeps its users' attachments.
  assert.ok(!ids.has("agent:tmp:action:duplicate"));
  assert.ok(!ids.has("agent:tmp:action:main-chat-restart"));
  assert.ok(!ids.has("agent:usr:action:attachments-clear"));
  const off = buildSearchIndex({ agents, agentsEnabled: false });
  assert.ok(!off.some((entry) => entry.id.startsWith("agent:")));
});

test("the user's search offers Sign out on the account page, nothing of the owner's", () => {
  const user = buildUserSearchIndex({ agents: [] });
  const hit = searchEntries(user, "Sign out")[0].items[0];
  assert.equal(hit.id, "user:sign-out");
  assert.deepEqual(hit.target.route, { view: "account" });
  for (const query of ["Tailscale", "Konten", "Risk rules", "System status"])
    assert.deepEqual(searchEntries(user, query), [], query);
});

test("a token with two swapped letters still finds its entry", () => {
  assert.deepEqual(swappedTokens("abc"), []);
  assert.ok(swappedTokens("sesison").includes("session"));
  assert.equal(pathOf(first("Tailsacle")), "/settings/remote");
  assert.ok(results("Pipeliens").some((item) => item.id === "page:pipelines"));
  // Short tokens never match that way.
  assert.deepEqual(results("ssh x"), []);
});
