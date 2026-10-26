import test from "node:test";
import assert from "node:assert/strict";
import { readRoute } from "../../web/app/routes.js";
import * as deApp from "../../web/lib/i18n/de/app.js";
import * as enApp from "../../web/lib/i18n/en/app.js";
import {
  agentsHint,
  clisHint,
  connectionsHint,
  hintText,
  hintTone,
  menuArea,
  menuGroups,
  pipelinesHint,
  projectsHint,
  settingsHint,
} from "../../web/app/sidebar-menu-model.js";

const read = (address) => readRoute(new URL(address, "http://localhost"));
const on = { loading: false, enabled: true, unknown: false };
const off = { loading: false, enabled: false, unknown: false };
const text = (hint, language = deApp) => hintText(hint, language.sidebarCopy.hints);

test("the menu lists exactly the entries of variant A in Arbeiten and Einrichten", () => {
  assert.deepEqual(
    menuGroups.map((group) => [group.id, group.entries.map((entry) => entry.id)]),
    [
      ["work", ["overview", "projects", "pipelines", "files", "artifacts"]],
      ["setup", ["agents", "clis", "connections", "settings"]],
    ],
  );
  // The inbox stays in the sidebar and the mobile header; the old entries are gone.
  const ids = menuGroups.flatMap((group) => group.entries.map((entry) => entry.id));
  for (const gone of ["inbox", "accounts", "extensions"]) assert.ok(!ids.includes(gone));
  assert.equal(deApp.sidebarCopy.workGroup, "Arbeiten");
  assert.equal(deApp.sidebarCopy.setupGroup, "Einrichten");
  assert.equal(enApp.sidebarCopy.workGroup, "Work");
  assert.equal(enApp.sidebarCopy.setupGroup, "Set up");
});

test("every route marks the area it belongs to, old addresses their new place", () => {
  const cases = [
    ["/", "overview"],
    ["/sessions/s-1/chat", ""],
    ["/inbox", ""],
    ["/projects", "projects"],
    ["/projects/p-1?tab=runs", "projects"],
    ["/pipelines", "pipelines"],
    ["/files", "files"],
    ["/artifacts", "artifacts"],
    ["/agents", "agents"],
    ["/agents?tab=runtime", "agents"],
    ["/agents?new=1", "agents"],
    ["/agents/home/settings?tab=access", "agents"],
    ["/agents/home/chats/c-1", ""],
    ["/coding/clis", "clis"],
    ["/coding/clis/extensions/p-1?tab=plugins", "clis"],
    ["/extensions", "clis"],
    ["/connections?section=ssh", "connections"],
    ["/accounts", "connections"],
    ["/settings", "settings"],
    ["/settings/users", "settings"],
  ];
  for (const [address, area] of cases)
    assert.equal(menuArea(read(address)), area, address);
  // The old agent service settings address is the agents hub's Runtime tab.
  assert.equal(menuArea({ view: "settings", settingsSection: "assistants" }), "agents");
  assert.equal(menuArea({ view: "workspace", sessionId: "" }, "s-1"), "");
  assert.equal(menuArea(null), "");
});

test("hints appear only when their source reports something", () => {
  assert.equal(projectsHint({ decisions: 0, failed: 0 }), null);
  assert.equal(text(projectsHint({ decisions: 2, failed: 3 })), "2 Entscheidungen");
  assert.equal(text(projectsHint({ decisions: 0, failed: 1 })), "1 fehlgeschlagen");
  assert.equal(text(pipelinesHint(1)), "1 läuft");
  assert.equal(pipelinesHint(0), null);
  assert.equal(
    text(
      clisHint({
        ready: true,
        tools: [
          { installed: true, versionStatus: "update-required" },
          { installed: true, versionStatus: "ok" },
          { installed: false, versionStatus: "update-required" },
        ],
        utilities: [{ installed: true, updateAvailable: true }],
      }),
    ),
    "2 Updates",
  );
  assert.equal(clisHint({ ready: true, tools: [{ installed: true }] }), null);
  assert.equal(
    text(settingsHint({ operations: { updates: { available: "2.8.0" } } })),
    "Update verfügbar",
  );
  assert.equal(settingsHint({ operations: { updates: { available: null } } }), null);
  assert.equal(hintTone(pipelinesHint(1)), "neutral");
  assert.equal(hintTone(projectsHint({ decisions: 1 })), "warn");
  assert.equal(text(pipelinesHint(3), enApp), "3 running");
  assert.equal(text(projectsHint({ decisions: 1 }), enApp), "1 decision");
});

test("a failed or unknown source shows no hint, never a zero", () => {
  assert.equal(projectsHint({ decisions: null, failed: null }), null);
  assert.equal(projectsHint(), null);
  assert.equal(pipelinesHint(null), null);
  assert.equal(pipelinesHint(undefined), null);
  assert.equal(clisHint({ ready: false, tools: [] }), null);
  assert.equal(connectionsHint({ problems: null, agentsEnabled: true }), null);
  assert.equal(settingsHint(null), null);
  assert.equal(settingsHint({ operations: null }), null);
  assert.equal(agentsHint({ feature: on, runtime: null, updates: null }), null);
  assert.equal(agentsHint({ feature: { ...on, loading: true } }), null);
});

test("Zugänge counts flagged entries of the shown categories only", () => {
  const problems = {
    agentsEnabled: true,
    models: {
      total: 3,
      problems: [{ id: "conn-1" }, { id: "native-codex" }],
      warnings: [],
    },
    services: { total: 3, problems: [], warnings: [{ id: "web-search" }] },
    mcp: { total: 2, problems: [{ id: "m-1" }], warnings: [{ id: "m-2" }] },
    ssh: null,
    secrets: { total: 0, problems: [], warnings: [] },
    github: { total: 1, problems: [{ id: "g-1" }], warnings: [] },
  };
  const hint = connectionsHint({
    problems,
    agentsEnabled: true,
    cliAccountIds: ["native-codex"],
  });
  assert.equal(text(hint), "5 Probleme");
  // Services for agents are hidden while agents are off.
  assert.equal(
    text(
      connectionsHint({
        problems,
        agentsEnabled: false,
        cliAccountIds: ["native-codex"],
      }),
    ),
    "4 Probleme",
  );
  assert.equal(
    connectionsHint({
      problems: { ssh: { total: 2, problems: [], warnings: [] } },
      agentsEnabled: true,
    }),
    null,
  );
  assert.equal(text(hint, enApp), "5 problems");
});

test("Agenten shows off, a stopped service or a ready update", () => {
  assert.equal(text(agentsHint({ feature: off })), "aus");
  assert.equal(text(agentsHint({ feature: off }), enApp), "off");
  // A switch that could not be read is not "off".
  assert.equal(agentsHint({ feature: { ...off, unknown: true } }), null);
  assert.equal(
    text(agentsHint({ feature: on, runtime: { availability: "disabled" } })),
    "Dienst gestoppt",
  );
  assert.equal(
    text(agentsHint({ feature: on, runtime: { availability: "failed" } })),
    "Dienst gestoppt",
  );
  assert.equal(
    text(
      agentsHint({
        feature: on,
        runtime: { availability: "ready" },
        updates: { updateAvailable: true },
      }),
    ),
    "Update bereit",
  );
  assert.equal(
    text(
      agentsHint({
        feature: on,
        updates: { updateAvailable: false, candidateReady: true },
      }),
    ),
    "Update bereit",
  );
  assert.equal(
    agentsHint({
      feature: on,
      runtime: { availability: "ready" },
      updates: { updateAvailable: false, candidateReady: false },
    }),
    null,
  );
});
