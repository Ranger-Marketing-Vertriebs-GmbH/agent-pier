// ⌘K search index (handoff §5.9, AC-SR-1): areas, tabs, settings groups and subpages in
// German and English, old names as aliases, agents with their tabs, connection names,
// actions, agents-off filtering, umlaut folding, ranking and speed.
import test from "node:test";
import assert from "node:assert/strict";
import { routePath } from "../../web/app/routes.js";
import { buildSearchIndex } from "../../web/app/search-entries.js";
import {
  normalizeText,
  queryTokens,
  searchEntries,
  termsOf,
} from "../../web/app/search-index.js";
import { getLanguage, setLanguage } from "../../web/lib/i18n/index.js";

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
  // Each hub tab and Runtime group is indexed once.
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
  const helper = results("Helfer").map(
    (item) => item.target.route?.agentTab || "overview",
  );
  assert.deepEqual(helper, ["overview", "identity", "capabilities", "access"]);
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

test("searching stays fast with thousands of entries", () => {
  const many = Array.from({ length: 300 }, (_, n) => ({
    id: `agent-${n}`,
    name: `Agent Nummer ${n}`,
    capabilities: { memory: true },
  }));
  const big = buildSearchIndex({ agents: many, connections, agentsEnabled: true });
  assert.ok(big.length > 3000, `${big.length} entries`);
  const start = performance.now();
  for (const query of ["ssh", "agent 42 zug", "einstellungen zugriff", "x"])
    searchEntries(big, query);
  assert.ok(performance.now() - start < 200, "four queries in under 200 ms");
});
