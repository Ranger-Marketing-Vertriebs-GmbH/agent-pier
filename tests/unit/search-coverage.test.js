// Guard for the ⌘K index (AGENTPIER-418): every routed page, every tab and every
// settings group the UI shows has a search entry that opens it. The tabs come from the
// route definitions, so a new tab without its entry fails here; groups inside a page
// have no route of their own and are listed below.
import test from "node:test";
import assert from "node:assert/strict";
import { buildSearchIndex } from "../../web/app/search-entries.js";
import { routePath } from "../../web/app/routes.js";
import { workspaceEntries } from "../../web/features/quick-open/workspace-entries.js";
import { inboxTabs } from "../../web/features/inbox/routes.js";
import { projectTabs } from "../../web/features/projects/routes.js";
import { pipelineTabs } from "../../web/features/pipelines/routes.js";
import { agentsHubTabs } from "../../web/features/assistants/hub-routes.js";
import { codingExtensionTabs, codingTabs } from "../../web/features/coding/routes.js";
import { connectionSections } from "../../web/features/connections/routes.js";
import { artifactTabs } from "../../web/features/artifacts/routes.js";
import { settingsTabs } from "../../web/features/operations/routes.js";

const index = [
  ...buildSearchIndex({
    agentsEnabled: true,
    offered: ["chat-new", "chat-summarise", "chat-archived", "view-new", "sign-out"],
  }),
  ...workspaceEntries({}, { agentsEnabled: true }),
];
const paths = new Set(
  index.filter((entry) => entry.target.route).map((e) => routePath(e.target.route)),
);
const has = (path) => paths.has(path);
const labelled = (label) =>
  index.some((entry) => entry.label.en === label || entry.label.de === label);

test("every routed area and its tabs have a search entry", () => {
  const expected = [
    "/",
    "/inbox",
    ...inboxTabs.filter((tab) => tab !== "all").map((tab) => `/inbox?tab=${tab}`),
    "/projects",
    ...projectTabs.filter((tab) => tab !== "overview").map((t) => `/projects?tab=${t}`),
    "/projects?tab=agentbus&bus=messages",
    "/craft",
    "/pipelines",
    ...pipelineTabs.filter((tab) => tab !== "runs").map((tab) => `/pipelines/${tab}`),
    "/files",
    "/files?panel=trash",
    ...artifactTabs.map((tab) =>
      tab === "all" ? "/artifacts" : `/artifacts?tab=${tab}`,
    ),
    "/agents",
    ...agentsHubTabs.filter((tab) => tab !== "all").map((tab) => `/agents?tab=${tab}`),
    "/coding/clis",
    ...codingTabs
      .filter((tab) => !["install", "extensions"].includes(tab))
      .map((tab) => `/coding/clis?tab=${tab}`),
    "/connections",
    ...connectionSections.map((section) => `/connections?section=${section}`),
    "/settings",
    "/settings/notifications",
    "/settings/users",
    "/settings/remote",
    "/settings/devices",
    "/settings?tab=operations",
  ];
  for (const path of expected) assert.ok(has(path), path);
  // Every settings tab is found under its own name.
  assert.equal(settingsTabs.length, 5);
  for (const tab of settingsTabs)
    assert.ok(
      index.some((entry) => entry.id === `page:settings-${tab}`),
      tab,
    );
  // The extensions tabs open the CLI extensions page at their tab.
  for (const tab of codingExtensionTabs)
    assert.ok(
      index.some((entry) => entry.target.extensions === tab),
      tab,
    );
});

test("every settings group inside a page has a search entry (en and de)", () => {
  // [English label, German label]: the groups the pages show.
  const groups = [
    // Settings › Remote access
    ["Local", "Lokal"],
    ["Tailscale", "Tailscale"],
    ["Network", "Netzwerk"],
    ["Additional hosts", "Zusätzliche Hosts"],
    ["Previews", "Vorschauen"],
    // Settings › App & notifications
    ["AgentPier as an app", "AgentPier als App"],
    ["Notifications on this device", "Benachrichtigungen auf diesem Gerät"],
    ["Registered devices", "Angemeldete Geräte"],
    ["Detail level", "Detailstufe"],
    ["Grouping and quiet", "Bündeln und Ruhe"],
    ["Quiet hours", "Ruhezeiten"],
    // Files
    ["Trash", "Papierkorb"],
    // Agents › Runtime › Advanced, Agents › All agents
    ["Tasks", "Aufträge"],
    ["Images and media", "Bilder und Medien"],
    ["Agent groups", "Agentengruppen"],
    // Pipelines › Verification and Queue
    ["Risk rules", "Risikoregeln"],
    ["Concurrent runs", "Gleichzeitige Läufe"],
    // Craft Anything, Overview, Connections
    ["Your rebuilds", "Deine Nachbauten"],
    ["Defaults", "Voreinstellungen"],
    ["System status", "Systemstatus"],
    ["ChatGPT for agents", "ChatGPT für Agenten"],
    // Settings › General › Android devices
    ["Android devices", "Android-Geräte"],
    ["Devices", "Geräte"],
    ["Limits", "Limits"],
  ];
  for (const [en, de] of groups) {
    assert.ok(labelled(en), en);
    assert.ok(
      index.some((entry) => entry.label.de === de),
      de,
    );
  }
});

test("every routed page of an agent has a search entry", () => {
  // An agent's own pages: its settings tabs, pinboard and (while on) its browser.
  const agent = { id: "ops", name: "Ops", capabilities: { browser: true } };
  const own = buildSearchIndex({ agents: [agent], agentsEnabled: true });
  const ownPaths = new Set(
    own.filter((entry) => entry.target.route).map((e) => routePath(e.target.route)),
  );
  for (const path of [
    "/agents/ops/settings",
    "/agents/ops/pinboard",
    "/agents/ops/browser",
  ])
    assert.ok(ownPaths.has(path), path);
  // The groups inside its tabs that people search by name (AGENTPIER-445).
  for (const group of [
    "hooks",
    "reminders",
    "routines",
    "check-ins",
    "shell",
    "member-groups",
  ])
    assert.ok(
      own.some((entry) => entry.id === `agent:ops:group:${group}`),
      group,
    );
});
