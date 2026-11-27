// ⌘K search index (handoff §5.9, AC-SR-1): areas, tabs, settings groups and subpages in
// German and English, old names as aliases, agents with their tabs, connection names,
// actions, agents-off filtering, umlaut folding, ranking and speed.
import test from "node:test";
import assert from "node:assert/strict";
import { routePath } from "../../web/app/routes.js";
import { buildSearchIndex } from "../../web/app/search-entries.js";
import { offerPageAction, pageActionOffered } from "../../web/app/page-action.js";
import {
  normalizeText,
  queryTokens,
  searchEntries,
  termsOf,
} from "../../web/app/search-index.js";
import { getLanguage, setLanguage } from "../../web/lib/i18n/index.js";
import { buildUserSearchIndex } from "../../web/features/users/user-search-entries.js";
import { hermesDescriptor } from "../../server/features/assistants/runtimes/hermes/descriptor.js";

const agents = [
  { id: "ops", name: "Ops-Wache", capabilities: { memory: true } },
  { id: "old", name: "Altlast", archivedAt: "2026-01-01T00:00:00Z" },
  { id: "tmp", name: "Helfer", teamMemberId: "m-1", lifetime: "temporary" },
  { id: "usr", name: "Mias Agent", userAccess: { users: [] } },
];
const connections = {
  ssh: [
    { id: "ssh-1", name: "prod-db", words: ["db.example.com", "deploy@db.example.com"] },
  ],
  mcp: [{ id: "mcp-1", name: "Linear", words: [] }],
  secrets: [{ id: "sec-1", name: "STRIPE_KEY", words: [] }],
  github: [{ id: "gh-1", name: "Firmen-Token", words: [] }],
  models: [{ id: "pc-1", name: "OpenRouter privat", words: [] }],
};
const index = buildSearchIndex({ agents, connections, agentsEnabled: true });
const results = (query, entries = index) =>
  searchEntries(entries, query).flatMap((group) =>
    group.items.map((item) => ({ ...item, group: group.group })),
  );
const first = (query, entries) => results(query, entries)[0];
const pathOf = (item) => (item.target.route ? routePath(item.target.route) : null);

test("normalizing folds case, umlauts, ß and separators", () => {
  assert.equal(normalizeText("SSH/SFTP-Zugänge"), "ssh sftp zugange");
  assert.equal(normalizeText("Straße › Café"), "strasse cafe");
  assert.deepEqual(queryTokens("  Einstellungen ›  Zugriff "), [
    "einstellungen",
    "zugriff",
  ]);
  assert.deepEqual(
    termsOf("Zugänge").map((term) => term.text),
    ["zugange", "zugaenge"],
  );
});

test("areas, tabs, settings groups and subpages are indexed with their routes", () => {
  const cases = [
    ["Zugänge", "/connections"],
    ["SSH/SFTP-Zugänge", "/connections?section=ssh"],
    ["Geheimnisse", "/connections?section=secrets"],
    ["CLIs & Erweiterungen", "/coding/clis"],
    ["AgentPier als MCP", "/coding/clis?tab=mcp"],
    ["Laufzeit", "/agents?tab=runtime"],
    ["Vorlagen", "/agents?tab=templates"],
    ["Erweitert", "/agents?tab=runtime&section=advanced"],
    ["Fernzugriff", "/settings/remote"],
    ["Aktivitätsprotokoll", "/settings/audit"],
    ["App & Benachrichtigungen", "/settings/notifications"],
    ["Betrieb", "/settings?tab=operations"],
    ["Sprache", "/settings"],
    ["MCP-Verzeichnis", "/settings"],
    ["Aufgabenprofile", "/pipelines/profiles"],
    ["Eingang", "/inbox"],
    ["Control Room", "/control-room"],
    ["Aktive Pipelines", "/pipelines"],
    ["Active pipelines", "/pipelines"],
  ];
  for (const [query, path] of cases) {
    const hit = first(query);
    assert.equal(hit.group, "pages", query);
    assert.equal(pathOf(hit), path, query);
  }
  assert.equal(first("Unteragenten").target.extensions, "subagents");
});

test("the hub's tabs and Runtime's groups use the hub's names and open their place", () => {
  const cases = [
    ["Alle Agenten", "/agents", "Agenten › Alle Agenten"],
    ["All agents", "/agents", "Agents › All agents"],
    ["Teams", "/agents?tab=teams", "Agenten › Teams"],
    ["Templates", "/agents?tab=templates", "Agents › Templates"],
    ["Runtime", "/agents?tab=runtime", "Agents › Runtime"],
    ["Agentendienst", "/agents?tab=runtime", "Agenten › Laufzeit › Agentendienst"],
    ["OpenClaw-Updates", "/agents?tab=runtime", "Agenten › Laufzeit › OpenClaw-Updates"],
    ["Träumen", "/agents?tab=runtime", "Agenten › Laufzeit › Träumen"],
    [
      "Gleichzeitig aktive Mitglieder",
      "/agents?tab=runtime",
      "Agenten › Laufzeit › Gleichzeitig aktive Mitglieder auf diesem Host",
    ],
    [
      "Erweitert · für alle Agenten",
      "/agents?tab=runtime&section=advanced",
      "Agenten › Laufzeit › Erweitert · für alle Agenten",
    ],
    [
      "Installierte Abhängigkeiten der Agenten",
      "/agents?tab=runtime&section=storage",
      "Agenten › Laufzeit › Speicher",
    ],
  ];
  for (const [query, path, label] of cases) {
    const hit = first(query);
    assert.equal(pathOf(hit), path, query);
    assert.ok([hit.path.de, hit.path.en].includes(label), `${query}: ${hit.path.de}`);
  }
  const ids = index.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length);
  // Speicher in Laufzeit and in Betrieb are both found, each at its own place.
  const storage = results("Speicher");
  assert.ok(storage.map(pathOf).includes("/agents?tab=runtime&section=storage"));
  assert.ok(storage.map(pathOf).includes("/settings?tab=operations"));
  // Both open their clean-up at once (page-action.js).
  const pending = (path) => storage.find((hit) => pathOf(hit) === path).target.pending;
  assert.equal(
    pending("/agents?tab=runtime&section=storage"),
    "agent-dependencies-cleanup",
  );
  assert.equal(pending("/settings?tab=operations"), "storage-cleanup");
  // Funktionen (Einstellungen › Allgemein) holds the agents link row.
  assert.equal(pathOf(first("Funktionen")), "/settings");
});

test("each result carries its path in both languages", () => {
  const ssh = first("SSH/SFTP-Zugänge");
  assert.deepEqual(ssh.path, {
    de: "Zugänge › SSH/SFTP-Zugänge",
    en: "Connections › SSH/SFTP accesses",
  });
  assert.equal(first("Zugänge").path.de, "Menü › Einrichten › Zugänge");
});

test("German and English labels match whatever the UI language is", () => {
  const before = getLanguage();
  try {
    for (const language of ["de", "en"]) {
      setLanguage(language, { persist: false, document: null });
      const entries = buildSearchIndex({ agents, connections, agentsEnabled: true });
      assert.equal(pathOf(first("Zugänge", entries)), "/connections", language);
      assert.equal(pathOf(first("Connections", entries)), "/connections", language);
      assert.equal(pathOf(first("Remote access", entries)), "/settings/remote", language);
      assert.equal(pathOf(first("Fernzugriff", entries)), "/settings/remote", language);
    }
  } finally {
    setLanguage(before, { persist: false, document: null });
  }
});

test("old names lead to the new place and say so", () => {
  const cases = [
    ["Einstellungen › Zugriff › SSH-Zugänge", "/connections?section=ssh"],
    ["Settings › Access › SSH accesses", "/connections?section=ssh"],
    ["Accounts › Modell-Zugänge", "/connections?section=models"],
    ["Accounts › Native CLI-Accounts", "/coding/clis?tab=accounts"],
    ["Einstellungen › Agentendienst", "/agents?tab=runtime"],
    ["Agentendienst › Erweitert", "/agents?tab=runtime&section=advanced"],
    ["Arbeitsbereich", "/settings"],
    ["Workspace", "/settings"],
  ];
  for (const [query, path] of cases) {
    const hit = first(query);
    assert.equal(pathOf(hit), path, query);
    assert.ok(hit.alias, `${query} names the old name`);
  }
  const extensionsAgents = results("Erweiterungen › Agenten");
  assert.ok(extensionsAgents.some((item) => item.target.extensions === "subagents"));
  assert.ok(extensionsAgents.some((item) => pathOf(item) === "/agents?tab=templates"));
});

test("agents get their tabs and subpages; old tab names find the new tabs", () => {
  const ops = results("Ops-Wache").filter((item) => item.group === "agents");
  assert.deepEqual(
    ops.slice(0, 7).map((item) => item.label.de),
    [
      "Ops-Wache · Überblick",
      "Ops-Wache · Identität",
      "Ops-Wache · Fähigkeiten",
      "Ops-Wache · Zugriffe",
      "Ops-Wache · Team",
      "Ops-Wache · Automatisierung",
      "Ops-Wache · Kanäle",
    ],
  );
  assert.equal(pathOf(first("ops ssh")), "/agents/ops/settings?tab=access&page=ssh");
  assert.equal(first("ops ssh").path.de, "Agenten › Ops-Wache › Zugriffe › SSH/SFTP");
  for (const [old, tab] of [
    ["Ops Profil", "identity"],
    ["Ops Routinen", "automation"],
    ["Ops Telegram", "channels"],
    ["Ops Arbeit", "access"],
  ]) {
    const hit = results(old).find((item) => item.group === "agents");
    assert.equal(hit.target.route.agentTab, tab, old);
  }
  assert.equal(results("Altlast").length, 0, "archived agents stay out");
  // A team member has its own pinboard besides its settings tabs.
  const helperHits = results("Helfer");
  assert.ok(helperHits.some((item) => item.id === "agent:tmp:pinboard"));
  const helper = helperHits
    .filter((item) => item.group === "agents" && !item.target.route?.pinboard)
    .map((item) => item.id.split(":").slice(2).join(":"));
  assert.equal(helper.join(), "overview,identity,capabilities,access,group:usage");
  assert.equal(
    results("Mias Agent").some((item) => item.target.route?.agentTab === "team"),
    false,
  );
  assert.equal(
    results("Mias Agent").some((item) => item.target.route?.agentPage === "ssh"),
    false,
  );
});

test("connection names are found by name and host and open their entry", () => {
  assert.equal(pathOf(first("prod-db")), "/connections?section=ssh&item=ssh-1");
  assert.equal(pathOf(first("db.example")), "/connections?section=ssh&item=ssh-1");
  assert.equal(pathOf(first("linear")), "/connections?section=mcp-servers&item=mcp-1");
  assert.equal(pathOf(first("stripe")), "/connections?section=secrets&item=sec-1");
  assert.equal(pathOf(first("Firmen-Token")), "/connections?section=github&item=gh-1");
  assert.equal(
    pathOf(first("OpenRouter privat")),
    "/connections?section=models&item=pc-1",
  );
});

test("the ticket sources are a connections page, also found by their Plane name", () => {
  assert.equal(pathOf(first("Ticketquellen")), "/connections?section=tickets");
  assert.equal(pathOf(first("Ticket sources")), "/connections?section=tickets");
  assert.equal(pathOf(first("Plane connections")), "/connections?section=tickets");
});

test("Craft Anything is found in both languages and opens CLIs & extensions › Installation", () => {
  const entry = index.find((item) => item.id === "page:craft-anything");
  assert.ok(entry);
  assert.match(entry.label.de, /Craft Anything/);
  assert.match(entry.label.en, /Craft Anything/);
  assert.deepEqual(entry.target.route, { view: "coding", codingTab: "install" });
  // The page of the same name ranks first; the installation card is listed too.
  const hit = results("Craft Anything").find((item) => item.id === "page:craft-anything");
  assert.ok(hit);
  assert.equal(pathOf(hit), "/coding/clis");
  assert.ok([entry.path.de, entry.path.en].some((path) => path.includes("›")));
});

test("REA is found in both languages and opens its card on CLIs & extensions › Installation", () => {
  const entry = index.find((item) => item.id === "page:rea");
  assert.ok(entry);
  assert.equal(entry.label.en, "REA (reverse engineering)");
  assert.equal(entry.label.de, "REA (Reverse Engineering)");
  assert.deepEqual(entry.target.route, { view: "coding", codingTab: "install" });
  for (const query of ["REA", "reverse engineering"])
    assert.ok(
      results(query).some(
        (item) => item.id === "page:rea" && pathOf(item) === "/coding/clis",
      ),
      query,
    );
});

test("Craft Anything is a work area, found in both languages and by its old names", () => {
  const entry = index.find((item) => item.id === "page:craft");
  assert.ok(entry);
  assert.equal(entry.label.en, "Craft Anything");
  assert.equal(entry.label.de, "Craft Anything");
  assert.equal(entry.path.en, "Menu › Work › Craft Anything");
  assert.equal(entry.path.de, "Menü › Arbeiten › Craft Anything");
  for (const query of ["craft", "Rebuilds", "Nachbauten", "rebuild", "Nachbau"]) {
    assert.equal(first(query).id, "page:craft", query);
    assert.equal(pathOf(first(query)), "/craft", query);
  }
  // The product name finds both the page and the installation card.
  const byName = results("Craft Anything").map((item) => item.id);
  assert.ok(byName.includes("page:craft"));
  assert.ok(byName.includes("page:craft-anything"));
});

test("actions open the right dialog or page", () => {
  const action = (query) => results(query).find((item) => item.group === "actions");
  assert.deepEqual(action("Neue Session").target, { action: "launch" });
  assert.equal(pathOf(action("Neuer Agent")), "/agents?new=1");
  assert.equal(action("SSH-Zugang hinzufügen").target.pending, "ssh-add");
  assert.equal(action("Add SSH key").target.pending, "ssh-key-add");
  assert.equal(
    pathOf(action("MCP-Server hinzufügen")),
    "/connections?section=mcp-servers&item=new",
  );
  assert.equal(action("Geheimnis hinzufügen").target.pending, "secret-add");
  assert.equal(action("GitHub-Zugang hinzufügen").target.pending, "github-add");
  assert.equal(action("Plane-Zugang hinzufügen").target.pending, "plane-add");
  assert.equal(action("Add Plane connection").target.pending, "plane-add");
  for (const [query, kind] of Object.entries({
    "Backup wiederherstellen": "restore",
    "Restore from backup": "restore",
    "Backup erstellen": "create",
  }))
    assert.equal(action(query).target.pending, `backup-${kind}`, query);
});

test("Start tickets is an action that opens the ticket selection", () => {
  const target = { action: "start-tickets", pending: "tickets-sequence" };
  for (const query of ["Start tickets", "Tickets starten"]) {
    const top = first(query);
    assert.equal(top.id, "action:start-tickets", query);
    assert.deepEqual(top.target, target, query);
  }
});

test("Add label rule is an action that opens the rule dialog", () => {
  const target = { action: "add-label-rule", pending: "ticket-rule-add" };
  for (const query of ["Add label rule", "Label-Regel hinzufügen"]) {
    const top = first(query);
    assert.equal(top.id, "action:add-label-rule", query);
    assert.deepEqual(top.target, target, query);
  }
});

test("Delete project is an action that opens the delete dialog", () => {
  const target = { action: "delete-project", pending: "project-delete" };
  for (const query of [
    "Delete project",
    "Projekt löschen",
    "Remove project",
    "Projekt entfernen",
  ]) {
    const top = first(query);
    assert.equal(top.id, "action:delete-project", query);
    assert.deepEqual(top.target, target, query);
  }
});

test("a blank query suggests the areas and the actions", () => {
  const groups = searchEntries(index, "", { pages: 99, agents: 99, actions: 99 });
  assert.deepEqual(
    groups.map((group) => group.group),
    ["pages", "actions"],
  );
  assert.ok(groups[0].items.some((item) => item.label.de === "Zugänge"));
});

test("with agents off only the Agenten area stays of the agent entries", () => {
  const off = buildSearchIndex({ agents, connections, agentsEnabled: false });
  const agentsArea = first("Agenten", off);
  assert.equal(pathOf(agentsArea), "/agents");
  assert.equal(results("Ops-Wache", off).length, 0);
  assert.equal(results("Laufzeit", off).length, 0);
  assert.equal(
    results("Neuer Agent", off).filter((i) => i.group === "actions").length,
    0,
  );
  assert.equal(results("Dienste für Agenten", off).length, 0);
  assert.ok(results("SSH-Zugang hinzufügen", off).length > 0);
});

test("prefix and word matches rank before inner matches", () => {
  const entries = [
    { label: "Aufgabenprofile", id: "inner" },
    { label: "Profil", id: "exact" },
    { label: "Profilbild ändern", id: "prefix" },
    { label: "Mein Profilfoto", id: "word" },
  ].map(({ label, id }) => ({
    id,
    group: "pages",
    label: { de: label, en: label },
    path: { de: label, en: label },
    target: {},
    terms: termsOf(label),
  }));
  assert.deepEqual(
    results("profil", entries).map((item) => item.id),
    ["exact", "prefix", "word", "inner"],
  );
});

test("Show changes opens the open session's Changes tab and only then", () => {
  const withSession = buildSearchIndex({
    agents,
    connections,
    agentsEnabled: true,
    sessionOpen: true,
  });
  const hit = results("Änderungen anzeigen", withSession).find(
    (item) => item.group === "actions",
  );
  assert.deepEqual(hit.target, { action: "session-changes" });
  assert.equal(results("Show changes", withSession)[0].id, "action:session-changes");
  for (const alias of ["diff", "Review changes", "Änderungen prüfen"])
    assert.ok(
      results(alias, withSession).some((item) => item.id === "action:session-changes"),
      alias,
    );
  assert.ok(!index.some((item) => item.id === "action:session-changes"));
  assert.equal(
    results("Änderungen anzeigen").filter((item) => item.id === "action:session-changes")
      .length,
    0,
  );
});

test("Review changes opens the open run's changes and only then", () => {
  const withRun = buildSearchIndex({
    agents,
    connections,
    agentsEnabled: true,
    runOpen: true,
  });
  const hit = results("Änderungen prüfen", withRun).find(
    (item) => item.group === "actions",
  );
  assert.equal(hit.id, "action:run-changes");
  assert.deepEqual(hit.target, { action: "run-changes", pending: "run-changes" });
  assert.equal(hit.label.en, "Review changes");
  assert.equal(results("Review changes", withRun)[0].id, "action:run-changes");
  assert.ok(results("diff", withRun).some((item) => item.id === "action:run-changes"));
  // Not without a run on screen, and the session's action stays the session's.
  assert.ok(!index.some((item) => item.id === "action:run-changes"));
  assert.ok(!withRun.some((item) => item.id === "action:session-changes"));
  const withSession = buildSearchIndex({ agents, connections, sessionOpen: true });
  assert.ok(!withSession.some((item) => item.id === "action:run-changes"));
});

test("Review changes is offered only while the run on screen takes it", () => {
  // AppSearch offers the action when a run page is open and its Changes section takes
  // it; an imported history run's page does not (RunChanges offers it only otherwise).
  assert.equal(pageActionOffered("run-changes"), false);
  const first = offerPageAction("run-changes");
  const second = offerPageAction("run-changes");
  assert.equal(pageActionOffered("run-changes"), true);
  first();
  first(); // ending twice changes nothing
  assert.equal(pageActionOffered("run-changes"), true);
  second();
  assert.equal(pageActionOffered("run-changes"), false);
  const index = buildSearchIndex({ runOpen: pageActionOffered("run-changes") });
  assert.ok(!index.some((item) => item.id === "action:run-changes"));
});

test("an agent's pinboard is found in both languages, not on a user's own agent", () => {
  for (const query of ["pinboard", "pinnwand", "Pinned files", "Angepinnte Dateien"]) {
    const hit = results(query).find((item) => item.id === "agent:ops:pinboard");
    assert.ok(hit, query);
    assert.equal(pathOf(hit), "/agents/ops/pinboard");
  }
  assert.ok(!index.some((entry) => entry.id === "agent:old:pinboard"));
  const own = buildSearchIndex({
    agents: [{ id: "mine", name: "Mias Agent", userAccess: { mode: "own" } }],
    agentsEnabled: true,
  });
  assert.ok(!own.some((entry) => entry.id.endsWith(":pinboard")));
});

test("New chat and Summarize this chat are offered only by a chat that takes them", () => {
  const ids = (offered) =>
    buildSearchIndex({ agentsEnabled: true, offered })
      .filter((entry) => entry.id.startsWith("action:chat-"))
      .map((entry) => entry.id);
  assert.deepEqual(ids(), []);
  assert.deepEqual(ids(["chat-summarise"]), ["action:chat-summarise"]);
  const all = buildSearchIndex({
    agentsEnabled: true,
    offered: ["chat-new", "chat-summarise"],
  });
  // The old chat-bar names stay searchable.
  for (const query of ["Jetzt zusammenfassen", "Summarize now", "Neuer Chat", "New chat"])
    assert.ok(
      results(query, all).some((item) => item.id.startsWith("action:chat-")),
      query,
    );
});

test("pinning memory entries finds the agent's memory page in both languages", () => {
  for (const query of ["pin", "anheften", "Pin memory entries", "Einträge anheften"]) {
    const hit = results(query).find((item) => item.id === "agent:ops:memory");
    assert.ok(hit, query);
    assert.equal(
      pathOf(hit),
      pathOf(index.find((item) => item.id === "agent:ops:memory")),
    );
    assert.ok(hit.alias, query);
  }
});

test("sessions talking to agents finds the agent's Projects page in both languages", () => {
  for (const query of ["talk", "sprechen", "Sessions talk to agents"]) {
    const hit = results(query).find((item) => item.id === "agent:ops:projects");
    assert.ok(hit, query);
    assert.equal(
      pathOf(hit),
      pathOf(index.find((item) => item.id === "agent:ops:projects")),
    );
    assert.ok(hit.alias, query);
  }
});

test("new agent group is searchable in both languages and opens its form", () => {
  for (const query of ["Neue Gruppe", "New group"]) {
    const hit = results(query).find((r) => r.id === "action:new-agent-group");
    assert.equal(pathOf(hit), "/agents");
    assert.equal(hit.target.pending, "agent-group-add");
  }
});

test("Delete project opens the dialog only for a project on screen", async () => {
  const { projectOnScreen } = await import("../../web/app/project-search-entries.js");
  assert.equal(projectOnScreen({ view: "projects", projectId: "p1" }), true);
  assert.equal(projectOnScreen({ view: "projects" }), false);
  assert.equal(projectOnScreen({ view: "workspace", projectId: "p1" }), false);
  assert.equal(projectOnScreen(null), false);
});

test("an agent's 'Learns its own skills' is found by its names in both languages", () => {
  for (const query of [
    "Ops Lernt eigene Skills",
    "Ops Learns its own skills",
    "Ops self-learning",
    "Ops selbst lernen",
    "Ops Skills lernen",
    "Ops Skill Workshop",
  ]) {
    const hit = results(query).find((item) => item.group === "agents");
    assert.equal(hit?.id, "agent:ops:capabilities", query);
    assert.equal(pathOf(hit), "/agents/ops/settings?tab=capabilities", query);
  }
  const entry = index.find((item) => item.id === "agent:ops:capabilities");
  assert.ok(
    entry.aliases.some((alias) => alias.de === "Ops-Wache · Lernt eigene Skills"),
  );
  assert.ok(
    entry.aliases.some((alias) => alias.en === "Ops-Wache · Learns its own skills"),
  );
});

// ADR 0007, step 7a: a Hermes agent's Mixture of Agents (more in
// search-index-runtimes.test.js).
test("a Hermes agent's Mixture of Agents is found by MoA", () => {
  const heron = {
    id: "her",
    name: "Heron",
    runtime: "hermes",
    runtimeInfo: { id: "hermes" },
  };
  const mixture = {
    id: "mixture",
    slot: "agent.capabilities",
    kind: "built",
    shows: "whileEnabled",
  };
  const runtimes = [
    { id: "hermes", name: "Hermes Agent", ready: true, surfaces: [mixture] },
  ];
  const entries = buildSearchIndex({ agents: [heron], agentsEnabled: true, runtimes });
  assert.equal(first("Heron MoA", entries)?.id, "agent:her:hermes-mixture");
  assert.equal(
    results("Ops MoA").some((item) => item.id.includes("mixture")),
    false,
  );
});

// ADR 0007, step 7b: an OpenClaw agent's memory wiki switch, and its wiki page while
// it keeps one, by "wiki", "Memory wiki" and "Wissens-Wiki".
test("an OpenClaw agent's memory wiki and its wiki page are found", () => {
  const built = (id, slot) => ({ id, slot, kind: "built", shows: "whileEnabled" });
  const runtimes = [
    {
      id: "openclaw",
      name: "OpenClaw",
      ready: true,
      surfaces: [built("memoryWiki", "agent.capabilities"), built("wiki", "agent.page")],
    },
  ];
  const owl = { id: "owl", name: "Owl", runtimeInfo: { id: "openclaw" } };
  const keeper = { ...owl, runtimePages: ["wiki"] };
  const without = buildSearchIndex({ agents: [owl], agentsEnabled: true, runtimes });
  assert.equal(first("Owl Memory wiki", without)?.id, "agent:owl:openclaw-memoryWiki");
  assert.equal(
    without.some((item) => item.id === "agent:owl:openclaw-wiki"),
    false,
  );
  const entries = buildSearchIndex({ agents: [keeper], agentsEnabled: true, runtimes });
  for (const query of [
    "Owl Wissens-Wiki",
    "Owl wiki",
    "Owl Memory-Wiki",
    "Owl Memory wiki",
  ])
    assert.ok(
      results(query, entries).some((item) => item.id === "agent:owl:openclaw-wiki"),
      query,
    );
});

test("Email accounts and its add action are indexed (AGENTPIER-418, 388)", () => {
  assert.equal(pathOf(first("E-Mail-Zugänge")), "/connections?section=mail");
  assert.equal(first("Add email account").target.pending, "mail-add");
});

// ⌘K entries found missing in feature test W8 (B15): services for agents, Free up
// space, Restore backup, and German names people type.
const serviceIndex = buildSearchIndex({ agentsEnabled: true });
const firstService = (query) => searchEntries(serviceIndex, query)[0]?.items[0];

test("each service for agents opens its own detail in both languages", () => {
  for (const [queries, item] of [
    [["Web search", "Websuche"], "web-search"],
    [["PDF reading", "PDF-Lesen"], "pdf-model"],
    [["Speech recognition", "Spracherkennung"], "speech"],
  ])
    for (const query of queries)
      assert.equal(
        pathOf(firstService(query)),
        `/connections?section=services&item=${item}`,
        query,
      );
  // They need agents, like their category.
  const off = buildSearchIndex({ agentsEnabled: false });
  assert.equal(
    off.some((entry) => entry.id === "page:connections-services-web-search"),
    false,
  );
});

test("Free up space opens the storage cleanup in both languages", () => {
  for (const query of ["Free up space", "Speicher freigeben", "Speicher aufräumen"]) {
    const item = firstService(query);
    assert.equal(item.id, "page:settings-free-space", query);
    assert.equal(item.target.pending, "storage-cleanup", query);
  }
});

test("Restore backup and Create backup open their dialogs on the backups page", () => {
  for (const [query, pending] of [
    ["Restore backup", "backup-restore"],
    ["Sicherung wiederherstellen", "backup-restore"],
    ["Inspect and restore backup", "backup-restore"],
    ["Create backup", "backup-create"],
    ["Sicherung erstellen", "backup-create"],
  ]) {
    const item = firstService(query);
    assert.equal(pathOf(item), "/settings/backups", query);
    assert.equal(item.target.pending, pending, query);
  }
});

test("German names people type find their place", () => {
  for (const [query, path] of [
    ["E-Mail-Konten", "/connections?section=mail"],
    ["E-Mail-Konto", "/connections?section=mail"],
    ["Plane-Verbindung", "/connections?section=tickets"],
    ["Standardordner", "/settings"],
    ["Email accounts", "/connections?section=mail"],
  ])
    assert.equal(pathOf(firstService(query)), path, query);
  assert.equal(firstService("E-Mail-Konto hinzufügen").target.pending, "mail-add");
  assert.equal(firstService("Plane-Verbindung hinzufügen").target.pending, "plane-add");
});

// ⌘K search index, the runtimes' part (ADR 0007): a surface a runtime registers is
// found while it shows, the Hermes group of Agents › Runtime and the surfaces of an
// agent's Capabilities tab (slot agent.capabilities) per agent of that runtime.
const runtimeAgents = [{ id: "ops", name: "Ops-Wache", capabilities: { memory: true } }];
const runtimeConnections = {
  models: [{ id: "pc-1", name: "OpenRouter privat", words: [] }],
};
const runtimeIndex = buildSearchIndex({
  agents: runtimeAgents,
  connections: runtimeConnections,
  agentsEnabled: true,
});
// ADR 0007, step 3: a runtime's surface is found while it shows.
const hermesListed = (ready, surfaces) => ({
  id: "hermes",
  name: "Hermes Agent",
  ready,
  surfaces: surfaces ?? [
    { id: "install", slot: "hub.runtime", kind: "built", shows: "always" },
  ],
});
const withRuntimes = (runtimes, agentsEnabled = true) =>
  buildSearchIndex({
    agents: runtimeAgents,
    connections: runtimeConnections,
    agentsEnabled,
    runtimes,
  });

test("the Hermes group of Runtime is found in both languages and lands on it", () => {
  const entries = withRuntimes([{ id: "openclaw", surfaces: [] }, hermesListed(false)]);
  const id = "page:runtime-hermes-install";
  const entry = entries.find((item) => item.id === id);
  assert.deepEqual(entry.label, { de: "Hermes Agent", en: "Hermes Agent" });
  assert.deepEqual(entry.path, {
    de: "Agenten › Laufzeit › Hermes Agent",
    en: "Agents › Runtime › Hermes Agent",
  });
  assert.equal(pathOf(entry), "/agents?tab=runtime&section=runtimes");
  for (const query of ["Hermes", "Hermes Agent", "hermes agent laufzeit"])
    assert.equal(first(query, entries).id, id, query);
  for (const query of [
    "Second runtime",
    "Zweite Laufzeit",
    "Install Hermes Agent",
    "Hermes Agent installieren",
    "Update Hermes Agent",
    "Hermes Agent aktualisieren",
  ]) {
    const hit = results(query, entries).find((item) => item.id === id);
    assert.ok(hit, query);
    assert.ok(hit.alias, `${query} is an alias`);
  }
  const ids = entries.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("a surface's search entry shows when the surface shows", () => {
  const id = "page:runtime-hermes-install";
  const has = (entries) => entries.some((item) => item.id === id);
  // An install group shows before the runtime is installed, and after.
  assert.equal(has(withRuntimes([hermesListed(false)])), true);
  assert.equal(has(withRuntimes([hermesListed(true)])), true);
  // One that shows only while the runtime is enabled follows `ready`.
  const whileEnabled = [
    { id: "install", slot: "hub.runtime", kind: "built", shows: "whileEnabled" },
  ];
  assert.equal(has(withRuntimes([hermesListed(false, whileEnabled)])), false);
  assert.equal(has(withRuntimes([hermesListed(true, whileEnabled)])), true);
  // No list (not read yet, or a server without it), no surface, or agents off.
  assert.equal(has(runtimeIndex), false);
  assert.equal(has(withRuntimes([])), false);
  assert.equal(has(withRuntimes([hermesListed(true, [])])), false);
  assert.equal(has(withRuntimes([hermesListed(true)], false)), false);
  assert.equal(results("Hermes", runtimeIndex).length, 0);
});

const hermes = (ready = true) => ({
  id: "hermes",
  name: "Hermes Agent",
  ready,
  surfaces: hermesDescriptor.surfaces,
});
const heron = {
  id: "her",
  name: "Heron",
  runtime: "hermes",
  runtimeInfo: { id: "hermes" },
};
const ops = { id: "ops", name: "Ops-Wache", capabilities: { memory: true } };
const indexOf = (agents, runtimes = [{ id: "openclaw", surfaces: [] }, hermes()]) =>
  buildSearchIndex({ agents, agentsEnabled: true, runtimes });
const id = "agent:her:hermes-mixture";

test("a Hermes agent's Mixture of Agents is found by its names in both languages", () => {
  const entries = indexOf([heron, ops]);
  const entry = entries.find((item) => item.id === id);
  assert.deepEqual(entry.label, {
    de: "Heron · Mixture of Agents",
    en: "Heron · Mixture of Agents",
  });
  assert.deepEqual(entry.path, {
    de: "Agenten › Heron › Fähigkeiten › Mixture of Agents",
    en: "Agents › Heron › Capabilities › Mixture of Agents",
  });
  assert.equal(routePath(entry.target.route), "/agents/her/settings?tab=capabilities");
  for (const query of [
    "Heron Mixture of Agents",
    "Heron MoA",
    "Heron Beratermodelle",
    "Heron advisor models",
    "Heron mehrere Modelle",
    "Heron several models",
  ])
    assert.ok(
      results(query, entries).some((item) => item.id === id),
      query,
    );
  // An agent of another runtime has none.
  assert.equal(
    entries.some((item) => item.id.startsWith("agent:ops:hermes")),
    false,
  );
  const ids = entries.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("it shows while Hermes may run agents, for agents that are not archived", () => {
  const has = (entries) => entries.some((item) => item.id === id);
  assert.equal(has(indexOf([heron], [hermes(false)])), false);
  assert.equal(has(indexOf([heron], [])), false);
  assert.equal(has(indexOf([{ ...heron, archivedAt: "2026-01-01T00:00:00Z" }])), false);
  assert.equal(
    has(
      buildSearchIndex({ agents: [heron], agentsEnabled: false, runtimes: [hermes()] }),
    ),
    false,
  );
  // Users never see the setting: their own index holds no such entry.
  assert.equal(
    buildUserSearchIndex({ agents: [heron] }).some((item) => /mixture/.test(item.id)),
    false,
  );
});

// An OpenClaw agent's "Model behaviour" (slot agent.identity): found per agent on
// its Identity tab, never for a Hermes agent or in a user's search.
test("an OpenClaw agent's model behaviour is found on its Identity tab", () => {
  const openclaw = {
    id: "openclaw",
    name: "OpenClaw",
    ready: true,
    surfaces: [
      {
        id: "modelOptions",
        slot: "agent.identity",
        kind: "built",
        shows: "whileEnabled",
      },
      {
        id: "memoryWiki",
        slot: "agent.capabilities",
        kind: "built",
        shows: "whileEnabled",
      },
    ],
  };
  const owl = { id: "owl", name: "Owl", runtimeInfo: { id: "openclaw" } };
  const entries = indexOf([owl, heron], [openclaw, hermes()]);
  const own = "agent:owl:openclaw-modelOptions";
  const entry = entries.find((item) => item.id === own);
  assert.deepEqual(entry.label, {
    de: "Owl · Modellverhalten",
    en: "Owl · Model behaviour",
  });
  assert.deepEqual(entry.path, {
    de: "Agenten › Owl › Identität › Modellverhalten",
    en: "Agents › Owl › Identity › Model behaviour",
  });
  assert.equal(routePath(entry.target.route), "/agents/owl/settings?tab=identity");
  for (const query of [
    "Owl Modellverhalten",
    "Owl Model behaviour",
    "Owl Schleifenschutz",
    "Owl Loop protection",
    "Owl Denkstufe",
    "Owl Thinking level",
    "Owl Schnellmodus",
    "Owl Fast mode",
    "Owl Denkaufwand",
    "Owl Reasoning effort",
    // Its fallback models are rows of the same group.
    "Owl Ersatzmodelle",
    "Owl Fallback models",
    "Owl Ausweichmodell",
    "Owl Failover",
    "Owl Reservemodell",
    "Owl Backup model",
  ])
    assert.ok(
      results(query, entries).some((item) => item.id === own),
      query,
    );
  // The wiki's entry still opens the Capabilities tab.
  assert.equal(
    routePath(
      entries.find((item) => item.id === "agent:owl:openclaw-memoryWiki").target.route,
    ),
    "/agents/owl/settings?tab=capabilities",
  );
  // A Hermes agent has no such group, an archived agent no entry at all.
  assert.equal(
    entries.some((item) => item.id.startsWith("agent:her:openclaw")),
    false,
  );
  const archived = indexOf([{ ...owl, archivedAt: "2026-01-01T00:00:00Z" }], [openclaw]);
  assert.equal(
    archived.some((item) => item.id === own),
    false,
  );
  // A temporary member has the Identity tab and shows that it follows its lead.
  const member = { ...owl, id: "m1", teamMemberId: "tm-1", lifetime: "task" };
  assert.ok(
    indexOf([member], [openclaw]).some(
      (item) => item.id === "agent:m1:openclaw-modelOptions",
    ),
  );
  const ids = entries.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length);
  // The users' own search never lists the owner's settings.
  const users = buildUserSearchIndex({ agents: [owl] });
  for (const query of [
    "Denkstufe",
    "Thinking level",
    "Fast mode",
    "Schnellmodus",
    "Loop protection",
    "Schleifenschutz",
    "Fallback models",
    "Ersatzmodelle",
  ])
    assert.equal(results(query, users).length, 0, query);
});
