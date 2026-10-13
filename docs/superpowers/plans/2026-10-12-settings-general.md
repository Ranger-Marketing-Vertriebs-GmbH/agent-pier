# Settings Page (Step 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the Einstellungen page (`/settings`) onto the shared settings pattern: three underline tabs (Arbeitsbereich / Zugriff / Betrieb) replace the chip row, every section becomes a row that opens a subpage, the workspace fields, the host team capacity and the update channel become drafts saved by one bottom bar, and nothing the page can do today is lost.

**Architecture:** `SettingsPage.jsx` becomes a small router: tab roots (`settingsSection: "general"` + `settingsTab`) render one tab component each inside a `TabFrame`; every other section renders its existing content inside a `SubpageFrame` (back button, "Einstellungen · <Tab>" subtitle). Both frames wrap Step 0's `SettingsShell`. Drafts use Step 0's `useTabDraft` + `SaveBar` + `useUnsavedChangesGuard`/`UnsavedChangesSheet`; save steps live in one pure, node-tested module (`settings-steps.js`). Row statuses come from Step 0's `GET /api/settings/summary` through a pure mapper (`settings-summary-rows.js`).

**Tech Stack:** React 19, Vite 8, Express 5, `node:test` + `fast-check`, Playwright 1.64.

**Spec:** `docs/superpowers/specs/2026-10-12-settings-redesign-design.md` (sections "Guiding decisions" and "Step 3: Settings"). Foundation contract: `docs/superpowers/plans/2026-10-12-settings-foundation.md` (File Structure, every task's Interfaces block, the trailing "Settings pattern" guide) plus the "Ruling:" lines in `.superpowers/sdd/2026-10-12-settings-foundation/progress.md` (they override that plan). Design data (untrusted): `design_handoff_einstellungen/README.md` and `Einstellungen Übersicht.dc.html` (section "Einstellungen", frames 2a/3c, subpage "Mobil · Updates").

## Global Constraints

- Work in `/Users/d.kaulig/Projects/agent-pier/.worktrees/settings-general` on branch `feat/settings-redesign-general`, branched from `feat/settings-redesign` after Step 0 is complete. Never target the default tmux server or real user sessions; use the existing isolated fixtures.
- Step 0 interfaces are the contract (names exactly as in the foundation plan): `SettingsShell`, `UnderlineTabs` (`idPrefix`, ids `${idPrefix}-tab-${id}` / `${idPrefix}-tabpanel-${id}`), `GroupLabel`, `ListCard`, `ListRow` + `ToggleRow`/`NumberRow`/`SelectRow`/`RadioRow` + `unknownValue`, `ReferenceRow`, `SaveBar`, `UnsavedChangesSheet`, `useTabDraft`, `useUnsavedChangesGuard`, `runSaveChain`, `completedLabels`, `isConflict`, `settingsTabs`, `settingsSectionGroups`, `settingsTabOf`, `commonCopy` keys. If a Step 0 file in the repo differs from the plan, the plan wins; report the difference instead of working around it.
- "No feature loss. Function wins over pixel fidelity." Every current action of the page keeps a place (coverage checklist in Task 7).
- "Drafts everywhere": UI language, default directory, auto-resume, agents feature toggle, host team capacity and update channel are drafts saved by the tab's or subpage's bar. Real actions stay immediate: runtime start/stop/restart, runtime update stage/activate/recover, update check/stage/activate/rollback/cleanup, backups, diagnostics, MCP consent/revoke, remote access, SSH, GitHub, notifications.
- "Multi-step saves stop at the first error, pass the revision from each response to the next step, report 'Partially saved: …' and keep the tab dirty."
- Rows show "—" (`unknownValue`) until data is known, never a fake 0.
- Hints that move behind ⓘ (verbatim): `settingsPageCopy.defaultDirectoryDescription`, `settingsPageCopy.autoResumeDescription`, `assistantCopy.feature.description`, `assistantTeamCopy.concurrentHint`, `channelStableHelp`/`channelPreviewHelp` for the non-selected channel. Errors, conflicts and the selected channel's help stay visible.
- Every UI text exists in `web/lib/i18n/de/*.js` and `web/lib/i18n/en/*.js` with matching keys and interpolation arguments; import reactive exports from `web/lib/i18n/messages/`. Do **not** add keys to `web/lib/i18n/*/common.js` (Step 0 owns it). New page copy goes to `web/lib/i18n/{de,en}/settings.js` (`settingsHubCopy`).
- Every source and test file ≤ 600 lines (`npm run check:structure`). Page CSS goes to `web/features/settings/settings-page.css`, not to `web/styles/settings-pattern.css` (its budget belongs to Step 0).
- Prettier (two spaces, double quotes, semicolons, trailing commas, 90 columns): run `npx prettier --write <files>` on every touched file; `npx eslint <files>` must report 0 warnings.
- Commands: single node test `node --test tests/unit/<f>.test.js`; browser `npm run build && npx playwright test tests/browser/<f>.spec.js`; gate `npm run check`.
- Existing browser specs: change how elements are found, not what is asserted. Where a spec asserted that a control applies immediately, the spec's guiding decision 2/3 changes the behaviour; those few assertions change to "applies after Save" and are listed in the PR description.
- Commit messages in English with `feat:`, `fix:`, `test:` or `chore:` prefixes, ending with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A default directory the server rewrites (realpath, `~/work`) must show the server's canonical value after saving and leave the tab clean, not dirty or in "changed elsewhere". Pinned in Task 4 (`settings-workspace.spec.js`, "canonical directories stay clean").
2. Lowering the host capacity below an agent's team size returns 409 from the server; the bar must show the server's message as an error, never "Changed elsewhere" with an "Overwrite anyway" that loops. Pinned in Task 2 (steps unit test) and Task 5 (`assistant-team-policy.test.js` key `capacity`).
3. A job started on the Updates subpage (`?job=…`, same section) while the channel is dirty must not open the unsaved sheet; leaving the subpage must. Pinned in Task 6 (`update-channel.spec.js`).
4. `/settings/summary` failing, or returning `null` parts, must render "—" per row while a real `0` renders "0", without crashing the tab. Pinned in Task 1 (unit) and Task 3 (`settings-tabs.spec.js`).
5. Saving only the language while the workspace state is still loading must not send `PATCH /preferences` (the directory field is still empty then). Pinned in Task 4 (`settings-workspace.spec.js`).

---

## File Structure

New (pure, node-testable):

- `web/features/settings/settings-navigation.js` — `tabRoot(tab)`, `subpage(section)`, `settingsLocation(route)`, `mergeSettingsRoute(route, changes)`, `staysOn(section, tab?)`.
- `web/features/settings/settings-summary-rows.js` — `accessRows(access)`, `operationsRows(operations)`: row descriptors from `GET /settings/summary`.
- `web/features/settings/settings-steps.js` — save-chain steps: `languageStep`, `preferencesStep`, `featureStep`, `hostCapacityStep`, `updateChannelStep`.

New (React):

- `web/features/settings/SettingsFrame.jsx` — `TabFrame` (title, description, tabs, tab panel, bar) and `SubpageFrame` (back to tab root, subtitle, optional wide column, bar).
- `web/features/settings/SummaryTabs.jsx` — `AccessTab`, `OperationsTab` (rows from the summary, reference row to Accounts).
- `web/features/settings/WorkspaceTab.jsx` — Arbeitsbereich draft (language, directory, auto-resume, agents switch), rows Agentendienst and App & Benachrichtigungen.
- `web/features/settings/DirectoryRow.jsx` — directory field + folder picker as a list row.
- `web/features/settings/AgentServiceStatus.jsx` — lazily loaded runtime status text for the Agentendienst row.
- `web/features/settings/SettingsSubpage.jsx` — renders a section's existing content in a `SubpageFrame`.
- `web/features/settings/AgentServiceRoute.jsx` — `/settings/assistants`: redirect to the workspace tab while agents are off, else the lazily loaded service page.
- `web/features/settings/AgentServicePage.jsx` — runtime card, runtime updates, host team capacity draft with its own bar.
- `web/features/operations/UpdateChannelGroup.jsx` — update channel radio rows.
- `web/features/settings/settings-page.css` — page-only styles (replaces `settings-tabs.css`).

Modified:

- `web/features/settings/SettingsPage.jsx` (rewrite), `web/app/App.jsx` (pass `openNavigation`, `navigationOpen`).
- Section content loses its own page title (the shell shows it): `web/features/mcp/McpSettings.jsx`, `web/features/remote/RemoteSettings.jsx`, `web/features/ssh/SshSettings.jsx`, `web/features/settings/GithubAccessPage.jsx`, `web/features/repositories/CredentialList.jsx` (table label prop), `web/features/notifications/NotificationsPage.jsx`, `web/features/operations/{DiagnosticsPage,BackupsPage,AuditPage,UpdatesPage}.jsx`, `web/features/assistants/AssistantRuntimeSettings.jsx`.
- `web/features/operations/UpdatesPage.jsx` (channel draft + own frame).
- `server/features/assistants/team-policy.js` (host capacity 409 key `capacity`), `server/lib/i18n/{de,en}/assistants.js` (key, only if Step 0 did not add it).
- i18n: `web/lib/i18n/{de,en}/settings.js`, `web/lib/i18n/messages/settings.js`.

Deleted: `web/features/settings/DirectorySettings.jsx`, `SessionRecoverySettings.jsx`, `settings-tabs.css`, `web/features/assistants/AssistantFeatureSettings.jsx`, `web/features/operations/OperationsPage.jsx`.

Tests:

- Unit: `tests/unit/settings-navigation.test.js`, `tests/unit/settings-summary-rows.test.js`, `tests/unit/settings-steps.test.js`; extend `tests/unit/assistant-team-policy.test.js`.
- Browser helpers: new `tests/helpers/settings.js`; `tests/browser/operations-fixture.js` (summary, persisted preferences); `tests/helpers/file-explorer-browser.js`.
- New specs: `tests/browser/settings-tabs.spec.js`, `tests/browser/settings-workspace.spec.js`.
- Updated specs: `github-access`, `operations-management`, `pwa`, `assistants`, `i18n`, `session-auto-resume`, `assistant-feature`, `assistant-teams`, `update-channel`, and the language switch line in `file-explorer-{accessibility,accessibility-fix,clipboard,live,upload-recovery}`.

### Decisions that refine the spec

- **Language is the first step of the workspace chain.** It is local and cannot fail, so "applied after save" means applied when the bar saves, never on select. A later server error then reports "Teilweise gespeichert: Sprache." and keeps the rest dirty.
- **Preferences, the agents switch and the update channel have no server revision.** Their steps cannot produce a 409; the last save wins, as today. The host capacity step sends the draft's base revision (`resource: "team"`).
- **`/settings/assistants` with agents off** replaces the address with `/settings` (the switch lives on the workspace tab). With agents on it is the Agentendienst subpage; the feature diagnostic is shown there too.
- **Rows are links** (`ListRow` with `href` + `onClick`), so middle-click opens a subpage in a new tab. Specs find them with `settingsRow(page, label)` (name starts with the label).
- **SSH and Aktivitätsprotokoll** use a wider content column (1080px) because they hold a list/detail split and a table.
- **Update channel** uses radio rows (README); the selected channel's help is its visible sub line, the others' help is behind ⓘ; a managed source shows the checked "Eigene Update-Quelle" row with all rows disabled.

---

### Task 1: Page copy, navigation helpers and summary rows

**Files:**

- Modify: `web/lib/i18n/de/settings.js`, `web/lib/i18n/en/settings.js`, `web/lib/i18n/messages/settings.js`
- Create: `web/features/settings/settings-navigation.js`, `web/features/settings/settings-summary-rows.js`
- Test: `tests/unit/settings-navigation.test.js`, `tests/unit/settings-summary-rows.test.js`

**Interfaces:**

- Consumes: `readRoute`, `routePath` (`web/app/routes.js`); `settingsTabs`, `settingsTabOf` (`web/features/operations/routes.js`, Step 0); `formatTimestamp` (`web/lib/i18n/index.js`); `operationsCopy`, `remoteCopy`.
- Produces:
  - `settingsHubCopy` (reactive, `web/lib/i18n/messages/settings.js`): strings `appGroup`, `mcpSub`, `mcpUnavailable`, `remoteSub`, `sshSub`, `githubSub`, `centralTitle`, `diagnosticsOk`, `upToDate`, `auditSub`; functions `backTo(tab)`, `subpageOf(tab)`, `mcpClients(count)`, `diagnosticsFailed(count)`, `diagnosticsWarnings(count)`, `checkedAt(when)`, `lastBackup(when)`, `installedVersion(version)`, `updateAvailable(version)`.
  - `tabRoot(tab) => { view: "settings", settingsSection: "general", settingsTab }` (unknown tab → `"workspace"`).
  - `subpage(section) => { view: "settings", settingsSection: section, settingsTab: settingsTabOf(section) }`.
  - `settingsLocation(route) => { section, tab }` (section defaults to `"general"`; a real section derives its tab).
  - `mergeSettingsRoute(route, changes) => route` — what subpage content calls `navigate(changes)` with (Ruling F4): keeps `settingsTab` consistent with the resulting section.
  - `staysOn(section, tab = "workspace") => (request) => boolean` — true when `request.next` is the same settings section (and, for `"general"`, the same tab).
  - `accessRows(access) => Row[]` with ids `mcp`, `remote`, `ssh`, `github`; `operationsRows(operations) => Row[]` with ids `diagnostics`, `backups`, `updates`, `audit`. `Row = { id, label, sub?, value?, status? }`; `value === null` means unknown (render `unknownValue`), `value === undefined` means no value; `status = { tone: "ok" | "warn" | "error", text }`.

- [ ] **Step 1: Write the failing unit tests**

Create `tests/unit/settings-navigation.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { readRoute, routePath } from "../../web/app/routes.js";
import {
  mergeSettingsRoute,
  settingsLocation,
  staysOn,
  subpage,
  tabRoot,
} from "../../web/features/settings/settings-navigation.js";

const read = (address) => readRoute(new URL(address, "http://localhost"));

test("tab roots and subpages have stable addresses", () => {
  assert.equal(routePath(tabRoot("workspace")), "/settings");
  assert.equal(routePath(tabRoot("access")), "/settings?tab=access");
  assert.equal(routePath(tabRoot("operations")), "/settings?tab=operations");
  assert.equal(routePath(tabRoot("bogus")), "/settings");
  assert.equal(routePath(subpage("diagnostics")), "/settings/diagnostics");
  assert.equal(subpage("assistants").settingsTab, "workspace");
  assert.equal(subpage("github").settingsTab, "access");
  assert.deepEqual(settingsLocation(read("/settings?tab=operations")), {
    section: "general",
    tab: "operations",
  });
  assert.deepEqual(settingsLocation(read("/settings/updates")), {
    section: "updates",
    tab: "operations",
  });
  assert.deepEqual(settingsLocation({ view: "settings" }), {
    section: "general",
    tab: "workspace",
  });
});

test("subpage navigation keeps the tab of the resulting section", () => {
  const updates = { ...read("/settings/updates"), operationId: "job-1" };
  assert.deepEqual(mergeSettingsRoute(updates, { operationId: "job-2" }), {
    ...updates,
    operationId: "job-2",
  });
  assert.equal(
    mergeSettingsRoute(read("/settings/mcp"), { settingsSection: "audit" }).settingsTab,
    "operations",
  );
  assert.equal(
    mergeSettingsRoute(read("/settings/mcp"), { settingsSection: "general" }).settingsTab,
    "access",
  );
});

test("a draft stays on screen only for its own section and tab", () => {
  const workspace = staysOn("general", "workspace");
  assert.equal(workspace({ next: tabRoot("workspace") }), true);
  assert.equal(workspace({ next: { view: "settings" } }), true);
  assert.equal(workspace({ next: tabRoot("access") }), false);
  assert.equal(workspace({ next: subpage("assistants") }), false);
  assert.equal(workspace({ next: { view: "projects" } }), false);
  assert.equal(workspace({}), false);
  const updates = staysOn("updates");
  assert.equal(updates({ next: { ...subpage("updates"), operationId: "job-1" } }), true);
  assert.equal(updates({ next: tabRoot("operations") }), false);
});
```

Create `tests/unit/settings-summary-rows.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { setLanguage } from "../../web/lib/i18n/index.js";
import {
  accessRows,
  operationsRows,
} from "../../web/features/settings/settings-summary-rows.js";

const byId = (rows) => Object.fromEntries(rows.map((row) => [row.id, row]));
const reset = (t) => t.after(() => setLanguage("de", { persist: false }));

test("unknown summary parts stay unknown and a real zero stays zero", (t) => {
  reset(t);
  setLanguage("de", { persist: false });
  const access = byId(accessRows(undefined));
  for (const id of ["mcp", "remote", "ssh", "github"])
    assert.equal(access[id].value, null, id);
  const operations = byId(
    operationsRows({ diagnostics: null, backups: null, updates: null }),
  );
  assert.equal(operations.diagnostics.value, null);
  assert.equal(operations.backups.value, null);
  assert.equal(operations.updates.value, null);
  assert.equal(operations.audit.value, undefined);
  assert.equal(operations.audit.sub, "Benutzer, System, MCP");
  assert.equal(byId(accessRows({ github: { count: 0 } })).github.value, 0);
  assert.equal(
    byId(operationsRows({ backups: { count: 0, lastAt: null } })).backups.value,
    0,
  );
});

test("access rows describe MCP clients and how AgentPier is reachable", (t) => {
  reset(t);
  setLanguage("de", { persist: false });
  const rows = byId(
    accessRows({
      mcp: { available: true, activeGrants: 1 },
      remote: { tailscale: true, network: true },
      ssh: { count: 3 },
      github: { count: 2 },
    }),
  );
  assert.equal(rows.mcp.label, "MCP & Zugriffe");
  assert.equal(rows.mcp.value, "1 verbundener Client");
  assert.deepEqual(rows.remote.status, { tone: "ok", text: "Tailscale · Netzwerk" });
  assert.equal(rows.ssh.value, 3);
  assert.equal(rows.github.value, 2);
  assert.deepEqual(
    byId(accessRows({ mcp: { available: false, activeGrants: 0 } })).mcp.status,
    { tone: "warn", text: "Nicht verfügbar" },
  );
  assert.equal(
    byId(accessRows({ remote: { tailscale: false, network: false } })).remote.value,
    "Lokal",
  );
  setLanguage("en", { persist: false });
  assert.equal(
    byId(accessRows({ mcp: { available: true, activeGrants: 2 } })).mcp.value,
    "2 connected clients",
  );
});

test("operations rows rank failures over warnings and flag a newer version", (t) => {
  reset(t);
  setLanguage("de", { persist: false });
  const rows = (operations) => byId(operationsRows(operations));
  const at = "2026-10-12T09:14:00.000Z";
  assert.deepEqual(
    rows({ diagnostics: { generatedAt: at, failed: 2, warnings: 1 } }).diagnostics.status,
    { tone: "error", text: "2 Fehler" },
  );
  assert.deepEqual(
    rows({ diagnostics: { generatedAt: at, failed: 0, warnings: 1 } }).diagnostics.status,
    { tone: "warn", text: "1 Warnung" },
  );
  const ok = rows({
    diagnostics: { generatedAt: at, failed: 0, warnings: 0 },
  }).diagnostics;
  assert.deepEqual(ok.status, { tone: "ok", text: "In Ordnung" });
  assert.match(ok.sub, /^Geprüft am /);
  const updates = rows({
    updates: { current: "1.28.1", checked: true, available: "1.29.0" },
  }).updates;
  assert.equal(updates.sub, "Installierte Version 1.28.1");
  assert.deepEqual(updates.status, { tone: "warn", text: "1.29.0 verfügbar" });
  assert.equal(
    rows({ updates: { current: "1.28.1", checked: true, available: null } }).updates
      .value,
    "Aktuell",
  );
  assert.equal(
    rows({ updates: { current: "1.28.1", checked: false, available: null } }).updates
      .value,
    undefined,
  );
  const backups = rows({
    backups: { count: 4, lastAt: "2026-10-11T22:00:00.000Z" },
  }).backups;
  assert.equal(backups.value, 4);
  assert.match(backups.sub, /^Letzte Sicherung /);
  setLanguage("en", { persist: false });
  assert.match(
    rows({ backups: { count: 4, lastAt: "2026-10-11T22:00:00.000Z" } }).backups.sub,
    /^Last backup /,
  );
  assert.equal(
    rows({ updates: { current: "1", checked: true, available: "2" } }).updates.status
      .text,
    "2 available",
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/unit/settings-navigation.test.js tests/unit/settings-summary-rows.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `web/features/settings/settings-navigation.js`.

- [ ] **Step 3: Add the page copy**

Append to `web/lib/i18n/de/settings.js`:

```js
export const settingsHubCopy = {
  backTo: (tab) => `Zurück zu ${tab}`,
  subpageOf: (tab) => `Einstellungen · ${tab}`,
  appGroup: "App",
  mcpSub: "Coding-CLI mit AgentPier verbinden",
  mcpClients: (count) =>
    count === 1 ? "1 verbundener Client" : `${count} verbundene Clients`,
  mcpUnavailable: "Nicht verfügbar",
  remoteSub: "Von anderen Geräten erreichen",
  sshSub: "Schlüssel und Hosts",
  githubSub: "Token für Klone und Pull Requests",
  centralTitle: "Provider-Zugänge, MCP-Server",
  diagnosticsOk: "In Ordnung",
  diagnosticsFailed: (count) => (count === 1 ? "1 Fehler" : `${count} Fehler`),
  diagnosticsWarnings: (count) => (count === 1 ? "1 Warnung" : `${count} Warnungen`),
  checkedAt: (when) => `Geprüft am ${when}`,
  lastBackup: (when) => `Letzte Sicherung ${when}`,
  installedVersion: (version) => `Installierte Version ${version}`,
  updateAvailable: (version) => `${version} verfügbar`,
  upToDate: "Aktuell",
  auditSub: "Benutzer, System, MCP",
};
```

Append to `web/lib/i18n/en/settings.js`:

```js
export const settingsHubCopy = {
  backTo: (tab) => `Back to ${tab}`,
  subpageOf: (tab) => `Settings · ${tab}`,
  appGroup: "App",
  mcpSub: "Connect a coding CLI to AgentPier",
  mcpClients: (count) =>
    count === 1 ? "1 connected client" : `${count} connected clients`,
  mcpUnavailable: "Not available",
  remoteSub: "Reach AgentPier from other devices",
  sshSub: "Keys and hosts",
  githubSub: "Tokens for clones and pull requests",
  centralTitle: "Provider access, MCP servers",
  diagnosticsOk: "OK",
  diagnosticsFailed: (count) => (count === 1 ? "1 failure" : `${count} failures`),
  diagnosticsWarnings: (count) => (count === 1 ? "1 warning" : `${count} warnings`),
  checkedAt: (when) => `Checked ${when}`,
  lastBackup: (when) => `Last backup ${when}`,
  installedVersion: (version) => `Installed version ${version}`,
  updateAvailable: (version) => `${version} available`,
  upToDate: "Up to date",
  auditSub: "User, system, MCP",
};
```

Append to `web/lib/i18n/messages/settings.js`:

```js
export const settingsHubCopy = localizedCopy(de.settingsHubCopy, en.settingsHubCopy);
```

- [ ] **Step 4: Implement the navigation helpers**

Create `web/features/settings/settings-navigation.js`:

```js
import { settingsTabOf, settingsTabs } from "../operations/routes.js";

// The settings page has tab roots (/settings, /settings?tab=…) and one subpage per
// section (/settings/<section>); these build and compare their routes.
export const tabRoot = (tab) => ({
  view: "settings",
  settingsSection: "general",
  settingsTab: settingsTabs.includes(tab) ? tab : "workspace",
});

export const subpage = (section) => ({
  view: "settings",
  settingsSection: section,
  settingsTab: settingsTabOf(section),
});

/** `{ section, tab }` of a settings route; a real section decides its tab. */
export function settingsLocation(route) {
  const section = route?.settingsSection || "general";
  if (section !== "general") return { section, tab: settingsTabOf(section) };
  return {
    section,
    tab: settingsTabs.includes(route?.settingsTab) ? route.settingsTab : "workspace",
  };
}

/** What a subpage's `navigate(changes)` leads to; the tab follows the section. */
export function mergeSettingsRoute(route, changes) {
  const settingsSection = changes.settingsSection ?? route.settingsSection ?? "general";
  return {
    ...route,
    ...changes,
    view: "settings",
    settingsSection,
    settingsTab:
      changes.settingsTab ??
      (settingsSection === "general"
        ? settingsLocation(route).tab
        : settingsTabOf(settingsSection)),
  };
}

/** For useUnsavedChangesGuard: navigations that keep this draft on screen. */
export const staysOn =
  (section, tab = "workspace") =>
  (request) => {
    const next = request?.next;
    if (next?.view !== "settings") return false;
    const location = settingsLocation(next);
    return (
      location.section === section && (section !== "general" || location.tab === tab)
    );
  };
```

- [ ] **Step 5: Implement the summary rows**

Create `web/features/settings/settings-summary-rows.js`:

```js
import { formatTimestamp } from "../../lib/i18n/index.js";
import { operationsCopy } from "../../lib/i18n/messages/operations.js";
import { remoteCopy } from "../../lib/i18n/messages/remote.js";
import { settingsHubCopy as copy } from "../../lib/i18n/messages/settings.js";

// Rows of the Zugriff and Betrieb tabs from GET /settings/summary. `value: null`
// means "not known" (the row shows "—"); a missing value means the row has none.
const count = (part) => (Number.isSafeInteger(part?.count) ? part.count : null);

function mcpState(mcp) {
  if (!mcp) return { value: null };
  if (!mcp.available) return { status: { tone: "warn", text: copy.mcpUnavailable } };
  return { value: copy.mcpClients(mcp.activeGrants) };
}

function remoteState(remote) {
  if (!remote) return { value: null };
  const active = [
    remote.tailscale && remoteCopy.tailscale,
    remote.network && remoteCopy.network,
  ].filter(Boolean);
  return active.length
    ? { status: { tone: "ok", text: active.join(" · ") } }
    : { value: remoteCopy.local };
}

export function accessRows(access) {
  const label = (id) => operationsCopy.sections[id];
  return [
    { id: "mcp", label: label("mcp"), sub: copy.mcpSub, ...mcpState(access?.mcp) },
    {
      id: "remote",
      label: label("remote"),
      sub: copy.remoteSub,
      ...remoteState(access?.remote),
    },
    { id: "ssh", label: label("ssh"), sub: copy.sshSub, value: count(access?.ssh) },
    {
      id: "github",
      label: label("github"),
      sub: copy.githubSub,
      value: count(access?.github),
    },
  ];
}

function diagnosticsState(diagnostics) {
  if (!diagnostics) return { value: null };
  if (diagnostics.failed > 0)
    return {
      status: { tone: "error", text: copy.diagnosticsFailed(diagnostics.failed) },
    };
  if (diagnostics.warnings > 0)
    return {
      status: { tone: "warn", text: copy.diagnosticsWarnings(diagnostics.warnings) },
    };
  return { status: { tone: "ok", text: copy.diagnosticsOk } };
}

function updatesState(updates) {
  if (!updates) return { value: null };
  if (updates.available)
    return { status: { tone: "warn", text: copy.updateAvailable(updates.available) } };
  return updates.checked ? { value: copy.upToDate } : {};
}

export function operationsRows(operations) {
  const { diagnostics, backups, updates } = operations ?? {};
  const label = (id) => operationsCopy.sections[id];
  return [
    {
      id: "diagnostics",
      label: label("diagnostics"),
      sub: diagnostics?.generatedAt
        ? copy.checkedAt(formatTimestamp(diagnostics.generatedAt))
        : undefined,
      ...diagnosticsState(diagnostics),
    },
    {
      id: "backups",
      label: label("backups"),
      sub: backups?.lastAt ? copy.lastBackup(formatTimestamp(backups.lastAt)) : undefined,
      value: count(backups),
    },
    {
      id: "updates",
      label: label("updates"),
      sub: updates?.current ? copy.installedVersion(updates.current) : undefined,
      ...updatesState(updates),
    },
    { id: "audit", label: label("audit"), sub: copy.auditSub },
  ];
}
```

- [ ] **Step 6: Run the tests**

Run: `node --test tests/unit/settings-navigation.test.js tests/unit/settings-summary-rows.test.js tests/unit/i18n-catalogs.test.js tests/unit/i18n-terminology.test.js tests/unit/settings-routes.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
npx prettier --write web/lib/i18n/de/settings.js web/lib/i18n/en/settings.js web/lib/i18n/messages/settings.js web/features/settings/settings-navigation.js web/features/settings/settings-summary-rows.js tests/unit/settings-navigation.test.js tests/unit/settings-summary-rows.test.js
npx eslint web/lib/i18n web/features/settings tests/unit/settings-navigation.test.js tests/unit/settings-summary-rows.test.js
git add web/lib/i18n web/features/settings/settings-navigation.js web/features/settings/settings-summary-rows.js tests/unit/settings-navigation.test.js tests/unit/settings-summary-rows.test.js
git commit -m "feat: describe settings tabs, subpages and summary rows" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Save steps for the settings page

**Files:**

- Create: `web/features/settings/settings-steps.js`
- Test: `tests/unit/settings-steps.test.js`

**Interfaces:**

- Consumes: Step object shape and `runSaveChain`, `completedLabels` (`web/lib/settings/save-chain.js`, Step 0 Task 5); `markSaved` (`web/lib/settings/draft-state.js`).
- Produces (all return a save-chain Step):
  - `languageStep({ label, apply }) ` — `id: "language"`, `keys: ["language"]`; calls `apply(values.language)`; returns `{}`.
  - `preferencesStep({ label, save?, refresh? })` — `id: "preferences"`, `keys: ["defaultCwd", "autoResumeInterrupted"]`; sends only the changed keys (`ctx.changed`) with `save(body)` (default `api("/preferences", "PATCH", body)`), then awaits `refresh()` and ignores its errors; returns the server's preferences.
  - `featureStep({ label, setEnabled })` — `id: "feature"`, `keys: ["agentsEnabled"]`; `setEnabled(values.agentsEnabled)`.
  - `hostCapacityStep({ label, save, refresh? })` — `id: "capacity"`, `keys: ["hostMaxConcurrent"]`, `resource: "team"`; `save({ revision: ctx.revision, hostMaxConcurrent })`; the response's `revision` becomes the new team revision.
  - `updateChannelStep({ label, save, onSaved? })` — `id: "channel"`, `keys: ["updateChannel"]`; `save(values.updateChannel)`, then `onSaved(result)`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/settings-steps.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { completedLabels, runSaveChain } from "../../web/lib/settings/save-chain.js";
import { markSaved } from "../../web/lib/settings/draft-state.js";
import {
  featureStep,
  hostCapacityStep,
  languageStep,
  preferencesStep,
  updateChannelStep,
} from "../../web/features/settings/settings-steps.js";

const base = {
  language: "de",
  defaultCwd: "/home/a",
  autoResumeInterrupted: true,
  agentsEnabled: false,
};
function workspace(calls, { failFeature = false, failRefresh = false } = {}) {
  return [
    languageStep({
      label: "Sprache",
      apply: (language) => calls.push(["language", language]),
    }),
    preferencesStep({
      label: "Allgemein",
      save: async (body) => {
        calls.push(["preferences", body]);
        return body;
      },
      refresh: async () => {
        calls.push(["refresh"]);
        if (failRefresh) throw new Error("offline");
      },
    }),
    featureStep({
      label: "Agenten",
      setEnabled: async (enabled) => {
        calls.push(["feature", enabled]);
        if (failFeature)
          throw Object.assign(new Error("Feature failed"), { status: 500 });
      },
    }),
  ];
}

test("the workspace saves language first and sends only changed preferences", async () => {
  const calls = [];
  const values = {
    ...base,
    language: "en",
    autoResumeInterrupted: false,
    agentsEnabled: true,
  };
  const result = await runSaveChain({ steps: workspace(calls), values, base });
  assert.equal(result.status, "saved");
  assert.deepEqual(calls, [
    ["language", "en"],
    ["preferences", { autoResumeInterrupted: false }],
    ["refresh"],
    ["feature", true],
  ]);
});

test("unchanged steps are skipped and a failed refresh does not fail the save", async () => {
  const calls = [];
  const values = { ...base, defaultCwd: "~/work" };
  const result = await runSaveChain({
    steps: workspace(calls, { failRefresh: true }),
    values,
    base,
  });
  assert.equal(result.status, "saved");
  assert.deepEqual(calls, [["preferences", { defaultCwd: "~/work" }], ["refresh"]]);
});

test("a failed feature step reports what was saved and a retry skips it", async () => {
  const calls = [];
  const steps = workspace(calls, { failFeature: true });
  const values = { ...base, autoResumeInterrupted: false, agentsEnabled: true };
  const first = await runSaveChain({ steps, values, base });
  assert.equal(first.status, "error");
  assert.equal(first.failedStep, "feature");
  assert.deepEqual(completedLabels(steps, first), ["Allgemein"]);
  const retryBase = markSaved(base, values, first.savedKeys);
  calls.length = 0;
  await runSaveChain({ steps, values, base: retryBase });
  assert.deepEqual(calls, [["feature", true]]);
});

test("host capacity sends the draft revision and passes on the new one", async () => {
  const bodies = [];
  const step = hostCapacityStep({
    label: "Team",
    save: async (body) => {
      bodies.push(body);
      return { revision: 8, hostMaxConcurrent: body.hostMaxConcurrent };
    },
  });
  const result = await runSaveChain({
    steps: [step],
    values: { hostMaxConcurrent: 16 },
    base: { hostMaxConcurrent: 12 },
    revisions: { team: 7 },
  });
  assert.equal(result.status, "saved");
  assert.deepEqual(bodies, [{ revision: 7, hostMaxConcurrent: 16 }]);
  assert.equal(result.revisions.team, 8);
});

test("a stale revision is a conflict but a capacity refusal is an error", async () => {
  const refuse = (messageKey) =>
    hostCapacityStep({
      label: "Team",
      save: async () => {
        throw Object.assign(new Error("refused"), { status: 409, messageKey });
      },
    });
  const run = (step) =>
    runSaveChain({
      steps: [step],
      values: { hostMaxConcurrent: 4 },
      base: { hostMaxConcurrent: 8 },
      revisions: { team: 1 },
    });
  assert.equal((await run(refuse("assistants.conflict"))).status, "conflict");
  assert.equal((await run(refuse("assistants.capacity"))).status, "error");
});

test("the update channel step reports the saved releases", async () => {
  const seen = [];
  const step = updateChannelStep({
    label: "Updatekanal",
    save: async (channel) => ({ updateChannel: channel }),
    onSaved: (result) => seen.push(result),
  });
  const result = await runSaveChain({
    steps: [step],
    values: { updateChannel: "preview" },
    base: { updateChannel: "stable" },
  });
  assert.equal(result.status, "saved");
  assert.deepEqual(seen, [{ updateChannel: "preview" }]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/unit/settings-steps.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `web/features/settings/settings-steps.js`.

- [ ] **Step 3: Implement the steps**

Create `web/features/settings/settings-steps.js`:

```js
import api from "../../lib/api.js";

// Save-chain steps of the settings page (see docs/settings-pattern.md). Each step
// owns its draft keys, so a retry after a partial save skips finished steps.
const preferenceKeys = ["defaultCwd", "autoResumeInterrupted"];

/** The UI language: local, cannot fail, applied when the tab is saved. */
export const languageStep = ({ label, apply }) => ({
  id: "language",
  label,
  keys: ["language"],
  run: async ({ values }) => {
    apply(values.language);
    return {};
  },
});

/** PATCH /preferences with only the fields changed in this draft. */
export const preferencesStep = ({
  label,
  save = (body) => api("/preferences", "PATCH", body),
  refresh,
}) => ({
  id: "preferences",
  label,
  keys: preferenceKeys,
  run: async ({ values, changed }) => {
    const body = Object.fromEntries(
      preferenceKeys
        .filter((key) => changed.includes(key))
        .map((key) => [key, values[key]]),
    );
    const result = await save(body);
    // The preferences are stored; a failed reload of the workspace state only delays
    // the canonical directory and must not report the save as failed.
    try {
      await refresh?.();
    } catch {}
    return result;
  },
});

/** PUT /assistant-feature through the shared feature store. */
export const featureStep = ({ label, setEnabled }) => ({
  id: "feature",
  label,
  keys: ["agentsEnabled"],
  run: ({ values }) => setEnabled(values.agentsEnabled),
});

/** PUT /assistant-team-settings with the draft's base revision. */
export const hostCapacityStep = ({ label, save, refresh }) => ({
  id: "capacity",
  label,
  keys: ["hostMaxConcurrent"],
  resource: "team",
  run: async ({ values, revision }) => {
    const result = await save({ revision, hostMaxConcurrent: values.hostMaxConcurrent });
    try {
      await refresh?.();
    } catch {}
    return result;
  },
});

/** PUT /operations/releases/channel; the page adopts the returned releases. */
export const updateChannelStep = ({ label, save, onSaved }) => ({
  id: "channel",
  label,
  keys: ["updateChannel"],
  run: async ({ values }) => {
    const result = await save(values.updateChannel);
    onSaved?.(result);
    return result;
  },
});
```

- [ ] **Step 4: Run the test**

Run: `node --test tests/unit/settings-steps.test.js tests/unit/settings-save-chain.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write web/features/settings/settings-steps.js tests/unit/settings-steps.test.js
npx eslint web/features/settings/settings-steps.js tests/unit/settings-steps.test.js
git add web/features/settings/settings-steps.js tests/unit/settings-steps.test.js
git commit -m "feat: add save steps for the settings page drafts" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Tabs, summary rows and subpages replace the chip row

The page gets its frame. Arbeitsbereich keeps today's immediate controls for one task (an interim `WorkspaceTab`); Task 4 turns it into a draft.

**Files:**

- Rewrite: `web/features/settings/SettingsPage.jsx`
- Create: `web/features/settings/SettingsFrame.jsx`, `SummaryTabs.jsx`, `SettingsSubpage.jsx`, `AgentServiceRoute.jsx` (interim), `WorkspaceTab.jsx` (interim), `settings-page.css`
- Modify: `web/app/App.jsx` (Settings props), `web/features/settings/settings-tabs.css` (delete the `.settings-tabs*` rules), `web/features/settings/DirectorySettings.jsx` (drop its title), `web/features/mcp/McpSettings.jsx`, `web/features/remote/RemoteSettings.jsx`, `web/features/ssh/SshSettings.jsx`, `web/features/settings/GithubAccessPage.jsx`, `web/features/repositories/CredentialList.jsx`, `web/features/notifications/NotificationsPage.jsx`, `web/features/operations/DiagnosticsPage.jsx`, `BackupsPage.jsx`, `AuditPage.jsx`, `UpdatesPage.jsx`, `web/features/assistants/AssistantRuntimeSettings.jsx`
- Delete: `web/features/operations/OperationsPage.jsx`
- Create: `tests/helpers/settings.js`; Modify: `tests/browser/operations-fixture.js`
- Test: create `tests/browser/settings-tabs.spec.js`; update `tests/browser/github-access.spec.js`, `operations-management.spec.js`, `pwa.spec.js`, `assistants.spec.js`

**Interfaces:**

- Consumes: Task 1 (`tabRoot`, `subpage`, `settingsLocation`, `mergeSettingsRoute`, `accessRows`, `operationsRows`, `settingsHubCopy`); Step 0 `SettingsShell`, `UnderlineTabs`, `ListCard`, `ListRow`, `unknownValue`, `ReferenceRow`, `settingsTabs`.
- Produces:
  - `frame` object passed to every tab and subpage: `{ section, tab, go(route, replace = false), navigate(changes, replace = false), openNavigation, navigationOpen }` (`navigate` = `mergeSettingsRoute` + `onNavigate`).
  - `TabFrame({ frame, bar?, children })` — `SettingsShell` with `className="settings-page-shell"`, title `commonCopy.settings`, description/subtitle `operationsCopy.description`, `leading="menu"`, tabs `UnderlineTabs` (`idPrefix="settings"`, labels `operationsCopy.groups`), children inside `div.settings-tab-panel[role=tabpanel]`.
  - `SubpageFrame({ frame, title?, wide = false, bar?, children })` — title defaults to `operationsCopy.sections[frame.section]`; subtitle `settingsHubCopy.subpageOf(tabLabel)`; `leading="back"` labelled `settingsHubCopy.backTo(tabLabel)` going to `tabRoot(frame.tab)`; `wide` adds class `wide` (content max 1080px).
  - `SettingsSubpage({ section, route, state, frame })`; `AgentServiceRoute({ frame })`.
  - Test helpers (`tests/helpers/settings.js`): `settingsBar(page)`, `settingsRow(page, label)`.
  - Operations fixture: `state.summary` (served at `GET /api/settings/summary`).

- [ ] **Step 1: Add the test helpers and the summary fixture**

Create `tests/helpers/settings.js`:

```js
// Locators for the settings pattern pages.
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The bottom bar; it exists only while a tab or subpage has unsaved changes. */
export const settingsBar = (page) =>
  page.getByRole("region", { name: /^(Ungespeicherte Änderungen|Unsaved changes)$/ });

/** A row that opens a subpage; its accessible name starts with the row label. */
export const settingsRow = (page, label) =>
  page.getByRole("link", { name: new RegExp(`^${escape(label)}`) });
```

In `tests/browser/operations-fixture.js`, add to the `state` object (after `requests: [],`):

```js
    summary: {
      access: {
        mcp: { available: true, activeGrants: 2 },
        remote: { tailscale: true, network: false },
        ssh: { count: 3 },
        github: { count: 1 },
      },
      operations: {
        diagnostics: { generatedAt: "2026-10-12T09:14:00.000Z", failed: 0, warnings: 0 },
        backups: { count: 4, lastAt: "2026-10-12T03:00:00.000Z" },
        updates: { current: "1.0.0", checked: true, available: "1.1.0" },
      },
    },
```

and before `else if (path === "/health") result = state.health;` add:

```js
    else if (path === "/settings/summary") result = state.summary;
```

- [ ] **Step 2: Write the failing browser spec**

Create `tests/browser/settings-tabs.spec.js`:

```js
import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { settingsRow } from "../helpers/settings.js";
import { operationsFixture } from "./operations-fixture.js";

for (const locale of ["de-DE", "en-GB"]) {
  const en = locale === "en-GB";
  const t = (german, english) => (en ? english : german);
  test.describe(`settings tabs ${locale}`, () => {
    test.use({ locale });

    test("operations rows show their state and open subpages with a way back", async ({
      page,
    }) => {
      await operationsFixture(page);
      await page.goto(baseURL + "/settings?tab=operations");
      await expect(
        page.getByRole("tab", { name: t("Betrieb", "Operations") }),
      ).toHaveAttribute("aria-selected", "true");
      await expect(settingsRow(page, t("Diagnose", "Diagnostics"))).toContainText(
        t("In Ordnung", "OK"),
      );
      const backups = settingsRow(page, t("Sicherungen", "Backups"));
      await expect(backups).toContainText("4");
      await expect(backups).toContainText(t("Letzte Sicherung", "Last backup"));
      await expect(settingsRow(page, "Updates")).toContainText(
        t("1.1.0 verfügbar", "1.1.0 available"),
      );
      await expect(
        settingsRow(page, t("Aktivitätsprotokoll", "Activity log")),
      ).toContainText(t("Benutzer, System, MCP", "User, system, MCP"));
      await settingsRow(page, "Updates").click();
      await expect(page).toHaveURL(/\/settings\/updates$/);
      await expect(
        page.getByRole("heading", { level: 1, name: "Updates", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText(t("Einstellungen · Betrieb", "Settings · Operations"), {
          exact: true,
        }),
      ).toBeVisible();
      await page
        .getByRole("button", {
          name: t("Zurück zu Betrieb", "Back to Operations"),
          exact: true,
        })
        .click();
      await expect(page).toHaveURL(/\/settings\?tab=operations$/);
    });

    test("access rows show counts and link the central accounts", async ({ page }) => {
      await operationsFixture(page);
      await page.goto(baseURL + "/settings?tab=access");
      await expect(settingsRow(page, t("MCP & Zugriffe", "MCP & access"))).toContainText(
        t("2 verbundene Clients", "2 connected clients"),
      );
      await expect(settingsRow(page, t("Fernzugriff", "Remote access"))).toContainText(
        "Tailscale",
      );
      await expect(settingsRow(page, t("SSH-Zugänge", "SSH accesses"))).toContainText(
        "3",
      );
      const github = settingsRow(page, t("GitHub-Zugänge", "GitHub connections"));
      await expect(github).toContainText("1");
      await expect(
        page.getByRole("link", {
          name: new RegExp(
            t("Provider-Zugänge, MCP-Server", "Provider access, MCP servers"),
          ),
        }),
      ).toHaveAttribute("href", "/accounts");
      await github.click();
      await expect(page).toHaveURL(/\/settings\/github$/);
    });

    test("unknown summary parts show a dash while a real zero stays zero", async ({
      page,
    }) => {
      const state = await operationsFixture(page);
      state.summary = {
        access: {
          mcp: null,
          remote: { tailscale: false, network: false },
          ssh: null,
          github: { count: 0 },
        },
        operations: null,
      };
      await page.goto(baseURL + "/settings?tab=access");
      await expect(settingsRow(page, t("MCP & Zugriffe", "MCP & access"))).toContainText(
        "—",
      );
      await expect(settingsRow(page, t("Fernzugriff", "Remote access"))).toContainText(
        t("Lokal", "Local"),
      );
      await expect(settingsRow(page, t("SSH-Zugänge", "SSH accesses"))).toContainText(
        "—",
      );
      await expect(
        settingsRow(page, t("GitHub-Zugänge", "GitHub connections")),
      ).toContainText("0");
      await page.route("**/api/settings/summary", (route) =>
        route.fulfill({ status: 500, json: { error: "Summary down" } }),
      );
      await page.getByRole("tab", { name: t("Betrieb", "Operations") }).click();
      for (const label of [
        t("Diagnose", "Diagnostics"),
        t("Sicherungen", "Backups"),
        "Updates",
      ])
        await expect(settingsRow(page, label)).toContainText("—");
    });

    test("contradicting addresses and history settle on one tab", async ({ page }) => {
      await operationsFixture(page);
      await page.goto(baseURL + "/settings/diagnostics?tab=access");
      await expect(page).toHaveURL(/\/settings\/diagnostics$/);
      await expect(
        page.getByText(t("Einstellungen · Betrieb", "Settings · Operations"), {
          exact: true,
        }),
      ).toBeVisible();
      await page.goto(baseURL + "/settings");
      const workspace = page.getByRole("tab", { name: t("Arbeitsbereich", "Workspace") });
      await expect(workspace).toHaveAttribute("aria-selected", "true");
      await page.getByRole("tab", { name: t("Zugriff", "Access") }).click();
      await expect(page).toHaveURL(/\/settings\?tab=access$/);
      await page.goBack();
      await expect(page).toHaveURL(/\/settings$/);
      await expect(workspace).toHaveAttribute("aria-selected", "true");
    });
  });
}

test.describe("settings on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test("the page header opens navigation and subpages lead back", async ({ page }) => {
    await operationsFixture(page);
    await page.goto(baseURL + "/settings?tab=operations");
    await expect(page.locator(".mobile-header")).toBeHidden();
    await page.getByRole("button", { name: "Navigation öffnen", exact: true }).click();
    await expect(page.locator(".sidebar")).toHaveClass(/\bopen\b/);
    await page.keyboard.press("Escape");
    await expect(page.locator(".sidebar")).not.toHaveClass(/\bopen\b/);
    const fits = () =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
    expect(await fits()).toBe(true);
    await settingsRow(page, "Sicherungen").click();
    await expect(
      page.getByRole("button", { name: "Zurück zu Betrieb", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Navigation öffnen", exact: true }),
    ).toBeHidden();
    expect(await fits()).toBe(true);
  });
});
```

- [ ] **Step 3: Run the spec to verify it fails**

Run: `npm run build && npx playwright test tests/browser/settings-tabs.spec.js`
Expected: FAIL — no element with role `tab` named "Betrieb" (the chip row has buttons).

- [ ] **Step 4: Build the frames**

Create `web/features/settings/SettingsFrame.jsx`:

```jsx
import React from "react";
import SettingsShell from "../../components/SettingsShell.jsx";
import UnderlineTabs from "../../components/UnderlineTabs.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { operationsCopy } from "../../lib/i18n/messages/operations.js";
import { settingsHubCopy } from "../../lib/i18n/messages/settings.js";
import { settingsTabs } from "../operations/routes.js";
import { tabRoot } from "./settings-navigation.js";

// A tab root of the settings page: header, the three tabs and the tab's own bar.
export function TabFrame({ frame, bar, children }) {
  return (
    <SettingsShell
      className="settings-page-shell"
      title={commonCopy.settings}
      subtitle={operationsCopy.description}
      description={operationsCopy.description}
      leading="menu"
      onLeading={frame.openNavigation}
      navigationOpen={frame.navigationOpen}
      tabs={
        <UnderlineTabs
          label={operationsCopy.title}
          idPrefix="settings"
          tabs={settingsTabs.map((id) => ({ id, label: operationsCopy.groups[id] }))}
          selected={frame.tab}
          onSelect={(id) => frame.go(tabRoot(id))}
        />
      }
      bar={bar}
    >
      <div
        className="settings-tab-panel"
        role="tabpanel"
        id={`settings-tabpanel-${frame.tab}`}
        aria-labelledby={`settings-tab-${frame.tab}`}
      >
        {children}
      </div>
    </SettingsShell>
  );
}

// One section of a tab; the back button returns to that tab on every width.
export function SubpageFrame({ frame, title, wide = false, bar, children }) {
  const tab = operationsCopy.groups[frame.tab];
  return (
    <SettingsShell
      className={["settings-page-shell", "settings-subpage", wide ? "wide" : ""]
        .filter(Boolean)
        .join(" ")}
      title={title ?? operationsCopy.sections[frame.section]}
      subtitle={settingsHubCopy.subpageOf(tab)}
      leading="back"
      leadingLabel={settingsHubCopy.backTo(tab)}
      onLeading={() => frame.go(tabRoot(frame.tab))}
      bar={bar}
    >
      {children}
    </SettingsShell>
  );
}
```

Create `web/features/settings/SummaryTabs.jsx`:

```jsx
import React from "react";
import ListCard from "../../components/ListCard.jsx";
import ListRow, { unknownValue } from "../../components/ListRow.jsx";
import ReferenceRow from "../../components/ReferenceRow.jsx";
import useResource from "../../lib/useResource.js";
import { routePath } from "../../app/routes.js";
import { operationsCopy } from "../../lib/i18n/messages/operations.js";
import { settingsHubCopy } from "../../lib/i18n/messages/settings.js";
import { TabFrame } from "./SettingsFrame.jsx";
import { subpage } from "./settings-navigation.js";
import { accessRows, operationsRows } from "./settings-summary-rows.js";

function SummaryRows({ frame, label, rows }) {
  return (
    <ListCard label={label}>
      {rows.map((row) => (
        <ListRow
          key={row.id}
          label={row.label}
          sub={row.sub}
          status={row.status}
          value={row.value === null ? unknownValue : row.value}
          href={routePath(subpage(row.id))}
          onClick={() => frame.go(subpage(row.id))}
        />
      ))}
    </ListCard>
  );
}

// Zugriff: AgentPier's own access paths; provider access and MCP servers live in Accounts.
export function AccessTab({ frame }) {
  const summary = useResource("/settings/summary");
  return (
    <TabFrame frame={frame}>
      <SummaryRows
        frame={frame}
        label={operationsCopy.groups.access}
        rows={accessRows(summary.data?.access)}
      />
      <ReferenceRow
        title={settingsHubCopy.centralTitle}
        href={routePath({ view: "accounts" })}
        onOpen={() => frame.go({ view: "accounts" })}
      />
    </TabFrame>
  );
}

export function OperationsTab({ frame }) {
  const summary = useResource("/settings/summary");
  return (
    <TabFrame frame={frame}>
      <SummaryRows
        frame={frame}
        label={operationsCopy.groups.operations}
        rows={operationsRows(summary.data?.operations)}
      />
    </TabFrame>
  );
}
```

- [ ] **Step 5: Render the sections as subpages**

Create `web/features/settings/AgentServiceRoute.jsx` (interim; Task 4 replaces it):

```jsx
import React, { lazy, Suspense } from "react";
import { assistantCopy } from "../../lib/i18n/messages/assistants.js";
import { operationsCopy } from "../../lib/i18n/messages/operations.js";
import AssistantFeatureSettings from "../assistants/AssistantFeatureSettings.jsx";
import useAssistantFeature from "../assistants/useAssistantFeature.js";
import { SubpageFrame } from "./SettingsFrame.jsx";
const AssistantRuntimeSettings = lazy(
  () => import("../assistants/AssistantRuntimeSettings.jsx"),
);

export default function AgentServiceRoute({ frame }) {
  const { enabled } = useAssistantFeature();
  return (
    <SubpageFrame frame={frame} title={assistantCopy.runtime}>
      <AssistantFeatureSettings />
      {enabled && (
        <Suspense fallback={<p role="status">{operationsCopy.loading}</p>}>
          <AssistantRuntimeSettings />
        </Suspense>
      )}
    </SubpageFrame>
  );
}
```

Create `web/features/settings/SettingsSubpage.jsx`:

```jsx
import React, { lazy, Suspense } from "react";
import { operationsCopy } from "../../lib/i18n/messages/operations.js";
import AgentServiceRoute from "./AgentServiceRoute.jsx";
import { SubpageFrame } from "./SettingsFrame.jsx";

// Each section keeps its current content; only the frame around it is new.
const pages = {
  mcp: lazy(() => import("../mcp/McpSettings.jsx")),
  remote: lazy(() => import("../remote/RemoteSettings.jsx")),
  ssh: lazy(() => import("../ssh/SshSettings.jsx")),
  github: lazy(() => import("./GithubAccessPage.jsx")),
  notifications: lazy(() => import("../notifications/NotificationsPage.jsx")),
  diagnostics: lazy(() => import("../operations/DiagnosticsPage.jsx")),
  backups: lazy(() => import("../operations/BackupsPage.jsx")),
  updates: lazy(() => import("../operations/UpdatesPage.jsx")),
  audit: lazy(() => import("../operations/AuditPage.jsx")),
};
// A list next to its details and a wide table need more than the 720px column.
const wideSections = new Set(["ssh", "audit"]);
// The former OperationsPage sections keep the `.operations-page` scope of
// operations.css (heading sizes, `overflow-wrap: anywhere` on long paths and hashes).
const operationsSections = new Set([
  "notifications",
  "diagnostics",
  "backups",
  "updates",
  "audit",
]);

export default function SettingsSubpage({ section, route, state, frame }) {
  if (section === "assistants") return <AgentServiceRoute frame={frame} />;
  const Page = pages[section];
  const content = <Page route={route} navigate={frame.navigate} state={state} />;
  return (
    <SubpageFrame frame={frame} wide={wideSections.has(section)}>
      <Suspense fallback={<p role="status">{operationsCopy.loading}</p>}>
        {operationsSections.has(section) ? (
          <div className="operations-page">{content}</div>
        ) : (
          content
        )}
      </Suspense>
    </SubpageFrame>
  );
}
```

Create `web/features/settings/WorkspaceTab.jsx` (interim; Task 4 replaces it):

```jsx
import React from "react";
import ListCard from "../../components/ListCard.jsx";
import ListRow from "../../components/ListRow.jsx";
import { routePath } from "../../app/routes.js";
import { operationsCopy } from "../../lib/i18n/messages/operations.js";
import DirectorySettings from "./DirectorySettings.jsx";
import { TabFrame } from "./SettingsFrame.jsx";
import { subpage } from "./settings-navigation.js";

export default function WorkspaceTab({ frame, state, refresh, ready }) {
  return (
    <TabFrame frame={frame}>
      <DirectorySettings state={state} refresh={refresh} ready={ready} />
      <ListCard label={operationsCopy.groups.workspace}>
        {["assistants", "notifications"].map((id) => (
          <ListRow
            key={id}
            label={operationsCopy.sections[id]}
            href={routePath(subpage(id))}
            onClick={() => frame.go(subpage(id))}
          />
        ))}
      </ListCard>
    </TabFrame>
  );
}
```

Replace `web/features/settings/SettingsPage.jsx` completely:

```jsx
import React from "react";
import SettingsSubpage from "./SettingsSubpage.jsx";
import WorkspaceTab from "./WorkspaceTab.jsx";
import { AccessTab, OperationsTab } from "./SummaryTabs.jsx";
import { mergeSettingsRoute, settingsLocation } from "./settings-navigation.js";
import "../operations/operations.css";
import "./settings-tabs.css";
import "./settings-page.css";

// Tabs Arbeitsbereich / Zugriff / Betrieb; every section is a subpage of its tab.
export default function SettingsPage({
  state,
  refresh,
  ready,
  route,
  onNavigate,
  openNavigation,
  navigationOpen,
}) {
  const { section, tab } = settingsLocation(route);
  const frame = {
    section,
    tab,
    openNavigation,
    navigationOpen,
    go: (next, replace = false) => onNavigate(next, replace),
    navigate: (changes, replace = false) =>
      onNavigate(mergeSettingsRoute(route, changes), replace),
  };
  if (section !== "general")
    return (
      <SettingsSubpage
        key={section}
        section={section}
        route={route}
        state={state}
        frame={frame}
      />
    );
  if (tab === "access") return <AccessTab frame={frame} />;
  if (tab === "operations") return <OperationsTab frame={frame} />;
  return <WorkspaceTab frame={frame} state={state} refresh={refresh} ready={ready} />;
}
```

Delete `web/features/operations/OperationsPage.jsx` (`git rm`). In `web/features/settings/settings-tabs.css` delete every rule whose selector starts with `.settings-tab` (the `.settings-tabs`, `.settings-tab-group`, `.settings-tab-divider` blocks and the `@media` block that only contains them); keep `.assistant-feature` and `.session-recovery` rules (Task 4 deletes the file).

Create `web/features/settings/settings-page.css`:

```css
/* Einstellungen: page-only additions to the shared settings pattern. */
.settings-page-shell .page {
  max-width: none;
  margin: 0;
  padding: 0;
}
.settings-subpage.wide .settings-shell-content {
  max-width: 1080px;
}
.settings-tab-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.settings-tab-panel > .list-card,
.settings-tab-panel > .reference-row {
  margin-bottom: 16px;
}
@media (max-width: 700px) {
  /* The page header carries the sidebar button, as on agent settings. */
  .app:has(.settings-page-shell) .mobile-header {
    display: none;
  }
}
```

In `web/app/App.jsx`, extend the `<Settings … />` element:

```jsx
<Settings
  state={state}
  refresh={refresh}
  ready={ready}
  route={route}
  onNavigate={navigate}
  openNavigation={openNavigation}
  navigationOpen={mobileNav}
/>
```

- [ ] **Step 6: Move every section title into the shell**

The shell's `h1` now names the section; remove each content's own title so the page has one `h1`:

- `web/features/mcp/McpSettings.jsx`: delete `<h1>{copy.title}</h1>`.
- `web/features/remote/RemoteSettings.jsx`: delete `<h2>{copy.title}</h2>` (the `section` keeps `aria-label={copy.title}`).
- `web/features/ssh/SshSettings.jsx`: in `header.ssh-heading` delete `<h1>{copy.title}</h1>` (keep the description and the add button).
- `web/features/settings/GithubAccessPage.jsx`: delete the `div.page-topline` block and `<h1 id="github-access-title">{copy.pageHeadingTitle}</h1>`; remove the now unused `operationsCopy` import; pass `label={copy.pageHeadingTitle}` to `<CredentialList … />`.
- `web/features/repositories/CredentialList.jsx`: signature `CredentialList({ credentials, cloning = false, setModal, label })` and replace `aria-labelledby="github-access-title"` with `aria-label={label}`.
- `web/features/notifications/NotificationsPage.jsx`: delete `<h1>{copy.title}</h1>` inside `div.page-header` (keep `<p>{copy.description}</p>`).
- `web/features/operations/DiagnosticsPage.jsx`: delete `<h1>{copy.diagnostics}</h1>`.
- `web/features/operations/BackupsPage.jsx`: delete `<h1>{copy.backups}</h1>`.
- `web/features/operations/AuditPage.jsx`: delete `<h1>{copy.audit}</h1>`.
- `web/features/operations/UpdatesPage.jsx`: delete `<h1>{copy.updates}</h1>`.
- `web/features/assistants/AssistantRuntimeSettings.jsx`: replace the whole `<header className="assistant-heading">…</header>` with `<p className="assistant-note">{copy.runtimeDescription}</p>`.
- `web/features/settings/DirectorySettings.jsx`: delete the `div.page-topline` and the `header.page-heading` blocks.

- [ ] **Step 7: Find the moved controls in the existing specs**

`tests/browser/github-access.spec.js` (after `await navigateTo(page, "Einstellungen");`), replace the chip click with:

```js
await page.getByRole("tab", { name: "Zugriff", exact: true }).click();
await settingsRow(page, "GitHub-Zugänge").click();
```

and add `import { settingsRow } from "../helpers/settings.js";`.

`tests/browser/operations-management.spec.js` (test "source checkout exposes server capability boundaries …"), replace `await page.getByRole("button", { name: "Sicherungen", exact: true }).click();` with:

```js
await page.getByRole("button", { name: "Zurück zu Betrieb", exact: true }).click();
await settingsRow(page, "Sicherungen").click();
```

and add `import { settingsRow } from "../helpers/settings.js";`.

`tests/browser/pwa.spec.js`: add `import { settingsRow } from "../helpers/settings.js";` and replace each of the three `page.getByRole("button", { name: "App & Benachrichtigungen", exact: true })` with `settingsRow(page, "App & Benachrichtigungen")`.

`tests/browser/assistants.spec.js` (test "late sidebar chat opening preserves newer navigation"), replace `await page.getByRole("button", { name: "General", exact: true }).click();` with:

```js
await page.getByRole("button", { name: "Back to Workspace", exact: true }).click();
```

- [ ] **Step 8: Run the new and the affected specs**

Run: `npm run build && npx playwright test tests/browser/settings-tabs.spec.js tests/browser/github-access.spec.js tests/browser/operations-management.spec.js tests/browser/pwa.spec.js tests/browser/assistants.spec.js tests/browser/assistant-feature.spec.js tests/browser/i18n.spec.js tests/browser/preferences.spec.js tests/browser/mcp-settings.spec.js tests/browser/ssh-settings.spec.js tests/browser/remote-settings.spec.js tests/browser/notifications.spec.js tests/browser/operations-audit.spec.js tests/browser/update-channel.spec.js tests/browser/tool-installer.spec.js tests/browser/update-notice.spec.js`
Expected: PASS. Then run `node --test tests/unit/settings-sections.test.js tests/unit/settings-routes.test.js` — PASS.

- [ ] **Step 9: Commit**

```bash
npx prettier --write web/features/settings web/features/operations web/features/mcp/McpSettings.jsx web/features/remote/RemoteSettings.jsx web/features/ssh/SshSettings.jsx web/features/repositories/CredentialList.jsx web/features/notifications/NotificationsPage.jsx web/features/assistants/AssistantRuntimeSettings.jsx web/app/App.jsx tests/helpers/settings.js tests/browser/operations-fixture.js tests/browser/settings-tabs.spec.js tests/browser/github-access.spec.js tests/browser/operations-management.spec.js tests/browser/pwa.spec.js tests/browser/assistants.spec.js
npx eslint web/features web/app tests/helpers/settings.js tests/browser/settings-tabs.spec.js tests/browser/operations-fixture.js
git add -A web/features/settings web/features/operations web/features/mcp web/features/remote web/features/ssh web/features/repositories web/features/notifications web/features/assistants/AssistantRuntimeSettings.jsx web/app/App.jsx tests/helpers/settings.js tests/browser
git commit -m "feat: show settings as three tabs with rows that open their sections" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Arbeitsbereich as one draft with a save bar

**Files:**

- Rewrite: `web/features/settings/WorkspaceTab.jsx`, `web/features/settings/AgentServiceRoute.jsx`
- Create: `web/features/settings/DirectoryRow.jsx`, `web/features/settings/AgentServiceStatus.jsx`, `web/features/settings/AgentServicePage.jsx`
- Modify: `web/features/settings/SettingsPage.jsx` (drop the `settings-tabs.css` import), `web/features/settings/settings-page.css`
- Delete: `web/features/settings/DirectorySettings.jsx`, `SessionRecoverySettings.jsx`, `settings-tabs.css`, `web/features/assistants/AssistantFeatureSettings.jsx`
- Modify tests: `tests/helpers/settings.js` (`chooseLanguage`), `tests/browser/operations-fixture.js` (persisted preferences), `tests/helpers/file-explorer-browser.js`
- Test: create `tests/browser/settings-workspace.spec.js`; update `tests/browser/i18n.spec.js`, `session-auto-resume.spec.js`, `assistant-feature.spec.js`, `file-explorer-accessibility.spec.js`, `file-explorer-accessibility-fix.spec.js`, `file-explorer-clipboard.spec.js`, `file-explorer-live.spec.js`, `file-explorer-upload-recovery.spec.js`

**Interfaces:**

- Consumes: Task 2 `languageStep`, `preferencesStep`, `featureStep`; Task 1 `staysOn`, `subpage`, `tabRoot`; Task 3 `TabFrame`, `SubpageFrame`, `frame`; Step 0 `useTabDraft({ server })`, `useUnsavedChangesGuard({ draft, tab, save, stays })`, `SaveBar({ draft, onSave, onOverwrite, saveLabel })`, `UnsavedChangesSheet`, `GroupLabel`, `ListCard`, `ListRow`, `SelectRow`, `ToggleRow`, `unknownValue`; `useAssistantFeature()` (`{ enabled, error, loading, setEnabled }`, `FEATURE_CHECK_FAILED`); `useAssistants()` / `idleAssistants`.
- Produces:
  - Workspace draft keys: `language`, `defaultCwd`, `autoResumeInterrupted`, `agentsEnabled`; bar primary `settingsPageCopy.saveSettings`; after a full save a `role="status"` line `settingsPageCopy.settingsSaved`.
  - `DirectoryRow({ value, home, disabled, onChange })` — row class `directory-row`, input labelled `settingsPageCopy.settingsFormFieldLabel`, folder button `settingsPageCopy.iconButtonAriaLabel`.
  - `AgentServicePage({ frame, diagnostic })` (lazy; Task 5 adds the capacity draft).
  - `chooseLanguage(page, language)` test helper.

- [ ] **Step 1: Persist preferences in the operations fixture and add the language helper**

In `tests/browser/operations-fixture.js` add `preferences: {},` to `state`, append `...state.preferences,` as the last property of the `/state` result object (after `defaultCwd: "/fixture",`), and replace `else if (path === "/preferences") result = body;` with:

```js
    else if (path === "/preferences") {
      if (method === "PATCH") state.preferences = { ...state.preferences, ...body };
      result = { defaultCwd: "/fixture", autoResumeInterrupted: true, ...state.preferences };
    }
```

Append to `tests/helpers/settings.js`:

```js
import { expect } from "@playwright/test";

/** The UI language is a draft of the workspace tab: choose it, then save the tab. */
export async function chooseLanguage(page, language) {
  if ((await page.locator("html").getAttribute("lang")) === language) return;
  await page.getByLabel(/^(Sprache|Language)$/).selectOption(language);
  // The primary button is the last one, also when the bar offers "Overwrite anyway".
  await settingsBar(page).getByRole("button").last().click();
  await expect(page.locator("html")).toHaveAttribute("lang", language);
}
```

(Move the `import` to the top of the file.)

- [ ] **Step 2: Write the failing browser spec**

Create `tests/browser/settings-workspace.spec.js`:

```js
import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { settingsBar, settingsRow } from "../helpers/settings.js";
import { operationsFixture } from "./operations-fixture.js";

const calls = (state, method, path) =>
  state.calls.filter((call) => call.method === method && call.path === path);
async function featureRoute(page) {
  const feature = { puts: [], fail: false };
  await page.route("**/api/assistant-feature", async (route) => {
    if (route.request().method() !== "PUT")
      return route.fulfill({ json: { enabled: false, error: null } });
    feature.puts.push(route.request().postDataJSON());
    if (feature.fail)
      return route.fulfill({ status: 500, json: { error: "Feature fixture failure" } });
    return route.fulfill({ json: { enabled: false, error: null } });
  });
  return feature;
}

for (const locale of ["de-DE", "en-GB"]) {
  const en = locale === "en-GB";
  const t = (german, english) => (en ? english : german);
  const resume = t(
    "Unterbrochene Sitzungen automatisch fortsetzen",
    "Resume interrupted sessions automatically",
  );
  test.describe(`settings workspace ${locale}`, () => {
    test.use({ locale });

    test("the bar appears only with changes and cancel restores them", async ({
      page,
    }) => {
      const state = await operationsFixture(page);
      await page.goto(baseURL + "/settings");
      const toggle = page.getByRole("switch", { name: resume });
      await expect(toggle).toBeChecked();
      await expect(settingsBar(page)).toHaveCount(0);
      await toggle.click();
      await expect(
        settingsBar(page).getByRole("button", {
          name: t("Einstellungen speichern", "Save settings"),
          exact: true,
        }),
      ).toBeVisible();
      await settingsBar(page)
        .getByRole("button", { name: t("Abbrechen", "Cancel"), exact: true })
        .click();
      await expect(settingsBar(page)).toHaveCount(0);
      await expect(toggle).toBeChecked();
      expect(calls(state, "PATCH", "/preferences")).toEqual([]);
    });

    test("switching tabs with changes asks first", async ({ page }) => {
      const state = await operationsFixture(page);
      await page.goto(baseURL + "/settings");
      const toggle = page.getByRole("switch", { name: resume });
      await toggle.click();
      const access = page.getByRole("tab", { name: t("Zugriff", "Access") });
      await access.click();
      const sheet = page.getByRole("dialog", {
        name: t("Änderungen speichern?", "Save changes?"),
      });
      await expect(sheet).toContainText(
        t(
          "Im Tab Arbeitsbereich ist 1 Änderung noch nicht gespeichert.",
          "1 change in Workspace is not saved yet.",
        ),
      );
      await sheet
        .getByRole("button", { name: t("Abbrechen", "Cancel"), exact: true })
        .click();
      await expect(page).toHaveURL(/\/settings$/);
      await expect(toggle).not.toBeChecked();
      await access.click();
      await sheet
        .getByRole("button", { name: t("Verwerfen", "Discard"), exact: true })
        .click();
      await expect(page).toHaveURL(/\/settings\?tab=access$/);
      await page.getByRole("tab", { name: t("Arbeitsbereich", "Workspace") }).click();
      await expect(toggle).toBeChecked();
      await toggle.click();
      await page.getByRole("tab", { name: t("Betrieb", "Operations") }).click();
      await sheet
        .getByRole("button", {
          name: t("Speichern und wechseln", "Save and switch"),
          exact: true,
        })
        .click();
      await expect(page).toHaveURL(/\/settings\?tab=operations$/);
      expect(calls(state, "PATCH", "/preferences").map((call) => call.body)).toEqual([
        { autoResumeInterrupted: false },
      ]);
    });
  });
}

test("a save sends only changed fields and canonical directories stay clean", async ({
  page,
}) => {
  const state = await operationsFixture(page);
  await page.route("**/api/preferences", async (route) => {
    const body = route.request().postDataJSON();
    state.calls.push({ path: "/preferences", method: "PATCH", body });
    state.preferences = {
      ...state.preferences,
      ...body,
      ...(body.defaultCwd ? { defaultCwd: "/fixture/canonical" } : {}),
    };
    // Let the 3s state poll publish the canonical directory while the save still
    // runs: the draft sees it as a foreign change and must still end clean.
    const statePolls = () => state.calls.filter((call) => call.path === "/state").length;
    const before = statePolls();
    while (statePolls() === before)
      await new Promise((resolve) => setTimeout(resolve, 100));
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.fulfill({
      json: { defaultCwd: "/fixture", autoResumeInterrupted: true, ...state.preferences },
    });
  });
  await page.goto(baseURL + "/settings");
  const directory = page.getByLabel("Standard-Arbeitsverzeichnis", { exact: true });
  await expect(directory).toHaveValue("/fixture");
  await directory.fill("~/work");
  await settingsBar(page)
    .getByRole("button", { name: "Einstellungen speichern", exact: true })
    .click();
  await expect(directory).toHaveValue("/fixture/canonical");
  await expect(settingsBar(page)).toHaveCount(0);
  await expect(page.getByRole("status")).toHaveText("Einstellungen gespeichert.");
  expect(calls(state, "PATCH", "/preferences").map((call) => call.body)).toEqual([
    { defaultCwd: "~/work" },
  ]);
});

test("a failed second step keeps the tab dirty and a retry skips the first", async ({
  page,
}) => {
  const state = await operationsFixture(page);
  const feature = await featureRoute(page);
  feature.fail = true;
  await page.goto(baseURL + "/settings");
  const resume = page.getByRole("switch", {
    name: "Unterbrochene Sitzungen automatisch fortsetzen",
  });
  const agents = page.getByRole("switch", { name: "Agenten aktivieren" });
  await resume.click();
  await agents.click();
  const bar = settingsBar(page);
  await bar.getByRole("button", { name: "Einstellungen speichern", exact: true }).click();
  await expect(bar.getByRole("alert")).toContainText("Teilweise gespeichert: Allgemein.");
  await expect(bar.getByRole("alert")).toContainText("Feature fixture failure");
  await expect(agents).toBeChecked();
  await bar.getByRole("button", { name: "Einstellungen speichern", exact: true }).click();
  await expect.poll(() => feature.puts.length).toBe(2);
  expect(calls(state, "PATCH", "/preferences")).toHaveLength(1);
  await bar.getByRole("button", { name: "Abbrechen", exact: true }).click();
  await expect(bar).toHaveCount(0);
  await expect(agents).not.toBeChecked();
  await expect(resume).not.toBeChecked();
});

test("rows, browser back and closing the page ask while the tab has changes", async ({
  page,
}) => {
  await operationsFixture(page);
  await page.goto(baseURL + "/settings?tab=access");
  await page.getByRole("tab", { name: "Arbeitsbereich" }).click();
  await page
    .getByRole("switch", { name: "Unterbrochene Sitzungen automatisch fortsetzen" })
    .click();
  const unload = () =>
    page.evaluate(() => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    });
  expect(await unload()).toBe(true);
  const sheet = page.getByRole("dialog", { name: "Änderungen speichern?" });
  await settingsRow(page, "App & Benachrichtigungen").click();
  await expect(sheet).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(page).toHaveURL(/\/settings$/);
  await page.evaluate(() => history.back());
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: "Verwerfen", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\?tab=access$/);
  expect(await unload()).toBe(false);
});

test("hints open as disclosures with their text verbatim", async ({ page }) => {
  await operationsFixture(page);
  await page.goto(baseURL + "/settings");
  const info = page
    .locator(".toggle-row")
    .filter({ hasText: "Unterbrochene Sitzungen automatisch fortsetzen" })
    .getByRole("button", { name: "Hinweis anzeigen" });
  await expect(info).toHaveAttribute("aria-expanded", "false");
  await info.click();
  await expect(info).toHaveAttribute("aria-expanded", "true");
  const panel = page.locator(`#${await info.getAttribute("aria-controls")}`);
  await expect(panel).toHaveText(
    "Nach einem Neustart oder dem Verlust des Terminal-Servers setzt AgentPier jede unterbrochene Sitzung nacheinander mit ihrer eigenen Unterhaltung fort. Von dir beendete Sitzungen bleiben beendet.",
  );
  await info.click();
  await expect(panel).toBeHidden();
});

test("saving the language before the workspace loaded sends no preferences", async ({
  page,
}) => {
  const state = await operationsFixture(page);
  state.hold = "/state";
  await page.goto(baseURL + "/settings");
  await expect(
    page.getByText("Einstellungen werden geladen …", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Sprache", { exact: true }).selectOption("en");
  await settingsBar(page)
    .getByRole("button", { name: "Einstellungen speichern", exact: true })
    .click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  state.hold = "";
  state.release?.();
  await expect(page.getByLabel("Default working directory", { exact: true })).toHaveValue(
    "/fixture",
  );
  await expect(settingsBar(page)).toHaveCount(0);
  expect(calls(state, "PATCH", "/preferences")).toEqual([]);
});
```

- [ ] **Step 3: Run the spec to verify it fails**

Run: `npm run build && npx playwright test tests/browser/settings-workspace.spec.js`
Expected: FAIL — the auto-resume switch saves immediately, no region "Ungespeicherte Änderungen" appears.

- [ ] **Step 4: Implement the directory row and the service status**

Create `web/features/settings/DirectoryRow.jsx`:

```jsx
import React, { useState } from "react";
import Icon from "../../components/Icon.jsx";
import ListRow from "../../components/ListRow.jsx";
import Modal from "../../components/Modal.jsx";
import DirectoryPicker from "../directories/DirectoryPicker.jsx";
import { settingsPageCopy as copy } from "../../lib/i18n/messages/settings.js";

// The default working directory: typed or chosen in the folder picker.
export default function DirectoryRow({ value, home, disabled, onChange }) {
  const [browse, setBrowse] = useState(false);
  return (
    <>
      <ListRow
        className="directory-row"
        label={copy.settingsFormFieldLabel}
        hint={copy.defaultDirectoryDescription}
      >
        <span className="directory-row-field">
          <input
            aria-label={copy.settingsFormFieldLabel}
            value={value}
            required
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
          />
          <button
            type="button"
            className="icon-button"
            aria-label={copy.iconButtonAriaLabel}
            disabled={disabled}
            onClick={() => setBrowse(true)}
          >
            <Icon name="folder" />
          </button>
        </span>
      </ListRow>
      {browse && (
        <Modal title={copy.iconButtonAriaLabel} close={() => setBrowse(false)}>
          <DirectoryPicker
            initialPath={value || home}
            cancel={() => setBrowse(false)}
            choose={(path) => {
              onChange(path);
              setBrowse(false);
            }}
          />
        </Modal>
      )}
    </>
  );
}
```

Create `web/features/settings/AgentServiceStatus.jsx`:

```jsx
import { unknownValue } from "../../components/ListRow.jsx";
import { assistantCopy } from "../../lib/i18n/messages/assistants.js";
import useAssistants, { idleAssistants } from "../assistants/useAssistants.js";

// Loaded only while agents are on; "—" until the agent host has published its state.
export default function AgentServiceStatus() {
  const assistants = useAssistants();
  if (assistants === idleAssistants) return unknownValue;
  return assistantCopy.status[assistants.runtime.availability] ?? unknownValue;
}
```

- [ ] **Step 5: Implement the workspace draft**

Replace `web/features/settings/WorkspaceTab.jsx` completely:

```jsx
import React, { lazy, Suspense, useEffect, useState } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import GroupLabel from "../../components/GroupLabel.jsx";
import ListCard from "../../components/ListCard.jsx";
import ListRow, {
  SelectRow,
  ToggleRow,
  unknownValue,
} from "../../components/ListRow.jsx";
import SaveBar from "../../components/SaveBar.jsx";
import UnsavedChangesSheet from "../../components/UnsavedChangesSheet.jsx";
import { routePath } from "../../app/routes.js";
import { setLanguage } from "../../lib/i18n/index.js";
import useLanguage from "../../lib/i18n/useLanguage.js";
import { assistantCopy } from "../../lib/i18n/messages/assistants.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { notificationCopy } from "../../lib/i18n/messages/notifications.js";
import { operationsCopy } from "../../lib/i18n/messages/operations.js";
import { settingsHubCopy, settingsPageCopy } from "../../lib/i18n/messages/settings.js";
import { sameValue } from "../../lib/settings/draft-state.js";
import useTabDraft from "../../lib/settings/useTabDraft.js";
import useUnsavedChangesGuard from "../../lib/settings/useUnsavedChangesGuard.js";
import useAssistantFeature, {
  FEATURE_CHECK_FAILED,
} from "../assistants/useAssistantFeature.js";
import DirectoryRow from "./DirectoryRow.jsx";
import { TabFrame } from "./SettingsFrame.jsx";
import { staysOn, subpage } from "./settings-navigation.js";
import { featureStep, languageStep, preferencesStep } from "./settings-steps.js";
const AgentServiceStatus = lazy(() => import("./AgentServiceStatus.jsx"));

// Language names are endonyms, the same in every UI language.
const languages = [
  { value: "de", label: "Deutsch" },
  { value: "en", label: "English" },
];
const stays = staysOn("general", "workspace");

export default function WorkspaceTab({ frame, state, refresh, ready }) {
  const language = useLanguage();
  const feature = useAssistantFeature();
  const featureCopy = assistantCopy.feature;
  const server = {
    language,
    defaultCwd: ready ? state.defaultCwd || state.home || "" : "",
    autoResumeInterrupted: state.autoResumeInterrupted !== false,
    agentsEnabled: feature.enabled,
  };
  const draft = useTabDraft({ server });
  const [saved, setSaved] = useState(false);
  // Opening the settings re-checks a feature state that could not be read (as the
  // old AssistantFeatureSettings did); `retry` is a stable module function.
  const retryFeature = feature.retry;
  useEffect(retryFeature, [retryFeature]);
  // The state refresh of the preferences step (or the 3s state poll) can publish the
  // server's canonical directory (realpath, "~/work") while the save is still running;
  // useTabDraft then records a conflict and, once the save marks the typed value as
  // base, never revisits the server. A clean tab always shows the server's values.
  useEffect(() => {
    if (!draft.dirty && !draft.saving && !sameValue(draft.values, server)) draft.reset();
  });
  const steps = [
    languageStep({ label: commonCopy.language, apply: setLanguage }),
    preferencesStep({ label: operationsCopy.sections.general, refresh }),
    featureStep({
      label: operationsCopy.sections.assistants,
      setEnabled: feature.setEnabled,
    }),
  ];
  const finish = (result) => {
    setSaved(result.status === "saved");
    return result;
  };
  const save = async () => finish(await draft.save(steps));
  const overwrite = async () => finish(await draft.overwrite(steps));
  const sheet = useUnsavedChangesGuard({
    draft,
    tab: operationsCopy.groups.workspace,
    save,
    stays,
  });
  const edit = (key) => (value) => {
    setSaved(false);
    draft.set(key, value);
  };
  const open = (section) => ({
    href: routePath(subpage(section)),
    onClick: () => frame.go(subpage(section)),
  });
  const locked = !ready || draft.saving;
  const diagnostic = feature.error
    ? featureCopy.errors[feature.error] || featureCopy.problem(feature.error)
    : "";
  return (
    <TabFrame
      frame={frame}
      bar={
        <SaveBar
          draft={draft}
          onSave={save}
          onOverwrite={overwrite}
          saveLabel={settingsPageCopy.saveSettings}
        />
      }
    >
      {!ready && <p role="status">{settingsPageCopy.loadingSettings}</p>}
      <GroupLabel id="settings-general">{operationsCopy.sections.general}</GroupLabel>
      <ListCard labelledBy="settings-general">
        <SelectRow
          label={commonCopy.language}
          value={draft.values.language}
          options={languages}
          disabled={draft.saving}
          onChange={edit("language")}
        />
        <DirectoryRow
          value={draft.values.defaultCwd}
          home={state.home}
          disabled={locked}
          onChange={edit("defaultCwd")}
        />
        <ToggleRow
          label={settingsPageCopy.autoResumeLabel}
          hint={settingsPageCopy.autoResumeDescription}
          checked={draft.values.autoResumeInterrupted}
          disabled={locked}
          onChange={edit("autoResumeInterrupted")}
        />
      </ListCard>
      <GroupLabel id="settings-agents">{operationsCopy.sections.assistants}</GroupLabel>
      <ListCard labelledBy="settings-agents">
        <ToggleRow
          label={featureCopy.title}
          hint={featureCopy.description}
          checked={draft.values.agentsEnabled}
          disabled={
            feature.loading || feature.error === FEATURE_CHECK_FAILED || draft.saving
          }
          onChange={edit("agentsEnabled")}
        />
        {feature.enabled && (
          <ListRow
            label={assistantCopy.runtime}
            value={
              <Suspense fallback={unknownValue}>
                <AgentServiceStatus />
              </Suspense>
            }
            {...open("assistants")}
          />
        )}
      </ListCard>
      <ErrorMessage error={diagnostic && `${featureCopy.diagnostic}: ${diagnostic}`} />
      <GroupLabel id="settings-app">{settingsHubCopy.appGroup}</GroupLabel>
      <ListCard labelledBy="settings-app">
        <ListRow
          label={operationsCopy.sections.notifications}
          sub={notificationCopy.description}
          {...open("notifications")}
        />
      </ListCard>
      {saved && !draft.dirty && (
        <p className="field-description" role="status">
          {settingsPageCopy.settingsSaved}
        </p>
      )}
      <UnsavedChangesSheet {...sheet} />
    </TabFrame>
  );
}
```

- [ ] **Step 6: Route the agent service page and remove the old pieces**

Replace `web/features/settings/AgentServiceRoute.jsx` completely:

```jsx
import React, { lazy, Suspense, useEffect, useRef } from "react";
import { assistantCopy } from "../../lib/i18n/messages/assistants.js";
import { operationsCopy } from "../../lib/i18n/messages/operations.js";
import useAssistantFeature from "../assistants/useAssistantFeature.js";
import { SubpageFrame } from "./SettingsFrame.jsx";
import { tabRoot } from "./settings-navigation.js";
const AgentServicePage = lazy(() => import("./AgentServicePage.jsx"));

// The agent service needs agents switched on. While they are off, its old address
// (/settings/assistants) lands on the workspace tab, where the switch lives.
export default function AgentServiceRoute({ frame }) {
  const feature = useAssistantFeature();
  const off = !feature.loading && !feature.enabled;
  const { go } = frame;
  const redirected = useRef(false);
  useEffect(() => {
    if (!off || redirected.current) return;
    redirected.current = true;
    go(tabRoot("workspace"), true);
  }, [off, go]);
  const copy = assistantCopy.feature;
  const problem = feature.error
    ? copy.errors[feature.error] || copy.problem(feature.error)
    : "";
  const loading = (
    <SubpageFrame frame={frame} title={assistantCopy.runtime}>
      <p role="status">{operationsCopy.loading}</p>
    </SubpageFrame>
  );
  if (!feature.enabled) return loading;
  return (
    <Suspense fallback={loading}>
      <AgentServicePage
        frame={frame}
        diagnostic={problem && `${copy.diagnostic}: ${problem}`}
      />
    </Suspense>
  );
}
```

Create `web/features/settings/AgentServicePage.jsx` (Task 5 adds the capacity draft):

```jsx
import React from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { assistantCopy } from "../../lib/i18n/messages/assistants.js";
import AssistantRuntimeSettings from "../assistants/AssistantRuntimeSettings.jsx";
import { SubpageFrame } from "./SettingsFrame.jsx";

export default function AgentServicePage({ frame, diagnostic }) {
  return (
    <SubpageFrame frame={frame} title={assistantCopy.runtime}>
      <ErrorMessage error={diagnostic} />
      <AssistantRuntimeSettings />
    </SubpageFrame>
  );
}
```

`git rm web/features/settings/DirectorySettings.jsx web/features/settings/SessionRecoverySettings.jsx web/features/settings/settings-tabs.css web/features/assistants/AssistantFeatureSettings.jsx`; remove `import "./settings-tabs.css";` from `SettingsPage.jsx`. Confirm nothing else imports them: `grep -rn "DirectorySettings\|SessionRecoverySettings\|AssistantFeatureSettings\|settings-tabs.css" web` prints nothing.

Append to `web/features/settings/settings-page.css` (before the `@media` block):

```css
.directory-row {
  flex-wrap: wrap;
}
.directory-row-field {
  display: flex;
  flex: 1 1 100%;
  gap: 8px;
  padding: 0 12px 12px 14px;
}
.directory-row-field input {
  flex: 1;
  min-width: 0;
}
```

- [ ] **Step 7: Save the moved controls in the existing specs**

`tests/browser/session-auto-resume.spec.js`, test "the setting saves a boolean …": directly after `await toggle.click();` add:

```js
await page
  .getByRole("button", {
    name: en ? "Save settings" : "Einstellungen speichern",
    exact: true,
  })
  .click();
```

`tests/browser/assistant-feature.spec.js`:

- Add `const saveSettings = (page) => page.getByRole("button", { name: "Save settings", exact: true }).click();` below the imports.
- "settings switch enables agents …": after `await toggle.click();` add `await saveSettings(page);`; replace `expect(feature.enabled).toBe(true);` with `await expect.poll(() => feature.enabled).toBe(true);`.
- "toggling agents keeps local application state": after `await page.getByRole("switch", { name: "Enable agents" }).click();` add `await saveSettings(page);`.
- "switching agents off removes navigation …": `page.goto(baseURL + "/settings/assistants")` becomes `page.goto(baseURL + "/settings")`; after the switch click add `await saveSettings(page);`.
- "a rejected switch change reports the problem and stays off": after `await toggle.click();` add `await saveSettings(page);`; replace `await expect(toggle).not.toBeChecked();` with:

```js
await page.getByRole("button", { name: "Cancel", exact: true }).click();
await expect(toggle).not.toBeChecked();
```

(The remaining tests open `/settings/assistants`; with agents off the address now lands on `/settings`, where the switch and the check diagnostic are.)

`tests/browser/i18n.spec.js` — add `import { chooseLanguage, settingsBar } from "../helpers/settings.js";`, then:

- Test "settings switches the workspace immediately …": rename to "settings switches the workspace language on save and keeps unsaved form values"; `const directory = page.locator(".directory-row input");`; replace every `page.getByLabel("Sprache", { exact: true }).selectOption("en")` with `chooseLanguage(page, "en")` (awaited), `other.getByLabel("Language", { exact: true }).selectOption("de")` with `await chooseLanguage(other, "de")`.
- Test "directory editing waits …": `const directory = page.locator(".directory-row input");`; replace the assertion on the disabled "Einstellungen speichern" button with `await expect(settingsBar(page)).toHaveCount(0);`; replace each `getByLabel("Sprache"|"Language", { exact: true }).selectOption(x)` with `await chooseLanguage(page, x)`.
- Test "focusing a loaded settings field …": `const directory = page.locator(".directory-row input");`; replace the final `selectOption("en")` with `await chooseLanguage(page, "en");`.
- Behaviour note for the PR description: in these three tests a directory draft exists when `chooseLanguage` saves the tab, so the save also sends `PATCH /preferences` to the real test server. The typed paths (`/tmp/unchanged-language-draft`, `/fixture/…`) do not exist, the server answers `workingDirectoryUnavailable`, the language step is kept ("Partially saved: Language."), and the directory stays a draft — that is what keeps the "directory value kept" assertions meaningful. Never use an existing directory there: the save would succeed and change the shared test server's default directory. In "directory editing waits …" the later state refresh turns the directory into a conflict, so `chooseLanguage` clicks "Overwrite anyway" (the last bar button); it fails the same way.

`tests/helpers/file-explorer-browser.js` (`selectEnglish`), `tests/browser/file-explorer-accessibility.spec.js` (2×, page `mobile`), `file-explorer-accessibility-fix.spec.js` (2×), `file-explorer-clipboard.spec.js`, `file-explorer-live.spec.js` (2×), `file-explorer-upload-recovery.spec.js`: replace each `X.getByLabel(…).selectOption(value)` with `await chooseLanguage(X, value)` and import `chooseLanguage` from `../helpers/settings.js` (`./settings.js` inside `tests/helpers`).

- [ ] **Step 8: Run the specs**

Run: `npm run build && npx playwright test tests/browser/settings-workspace.spec.js tests/browser/settings-tabs.spec.js tests/browser/i18n.spec.js tests/browser/preferences.spec.js tests/browser/session-auto-resume.spec.js tests/browser/assistant-feature.spec.js tests/browser/assistants.spec.js tests/browser/assistant-settings.spec.js tests/browser/assistant-runtime-updates.spec.js tests/browser/pwa.spec.js tests/browser/file-explorer-accessibility.spec.js tests/browser/file-explorer-accessibility-fix.spec.js tests/browser/file-explorer-clipboard.spec.js tests/browser/file-explorer-live.spec.js tests/browser/file-explorer-upload-recovery.spec.js tests/browser/file-explorer-editor-navigation.spec.js`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
npx prettier --write web/features/settings tests/helpers/settings.js tests/helpers/file-explorer-browser.js tests/browser
npx eslint web/features/settings tests/helpers tests/browser/settings-workspace.spec.js
git add -A web/features/settings web/features/assistants/AssistantFeatureSettings.jsx tests/helpers tests/browser
git commit -m "feat: save the settings workspace with one bar" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Host team capacity as a draft on the Agentendienst subpage

**Files:**

- Modify: `web/features/settings/AgentServicePage.jsx`, `web/features/assistants/AssistantRuntimeSettings.jsx`
- Modify: `server/features/assistants/team-policy.js`; `server/lib/i18n/de/assistants.js`, `server/lib/i18n/en/assistants.js` (only if `capacity` is missing)
- Test: `tests/unit/assistant-team-policy.test.js`, `tests/browser/assistant-teams.spec.js`

**Interfaces:**

- Consumes: Task 2 `hostCapacityStep`; Task 1 `staysOn`; `useAssistants()` → `{ teamSettings: { revision, hostMaxConcurrent }, refresh }`; `assistantApi.teamSettings(body)`; `assistantTeamCopy` (`settings`, `capacity`, `concurrentHint`, `save`).
- Produces: capacity draft key `hostMaxConcurrent`, revision slot `team`; server error key `assistants.capacity` (409) when the host capacity is below an agent's team size.

- [ ] **Step 1: Write the failing tests**

In `tests/unit/assistant-team-policy.test.js` replace the last assertion of the first test with:

```js
assert.throws(
  () => normalizeTeamSettings({ hostMaxConcurrent: 4 }, [{ maxMembers: 8 }]),
  { status: 409, key: "capacity" },
);
```

In `tests/browser/assistant-teams.spec.js` replace the body of the test "host settings initialize from server and retain the draft revision across refreshes" after `await expect(capacity).toHaveValue("12");` with:

```js
  await capacity.fill("16");
  teamSettings.revision = 8;
  teamSettings.hostMaxConcurrent = 20;
  await refreshFromEvent(page);
  const bar = page.getByRole("region", { name: "Unsaved changes" });
  await expect(
    bar.getByText("Changed elsewhere in the meantime.", { exact: true }),
  ).toBeVisible();
  await expect(capacity).toHaveValue("16");
  expect(posted.filter((body) => "hostMaxConcurrent" in body)).toEqual([]);
  expect(teamSettings.hostMaxConcurrent).toBe(20);
  await bar.getByRole("button", { name: "Reload", exact: true }).click();
  await expect(capacity).toHaveValue("20");
  await capacity.fill("24");
  await page.getByRole("button", { name: "Save team settings", exact: true }).click();
  await expect.poll(() => teamSettings.revision).toBe(9);
  await capacity.fill("28");
  await page.getByRole("button", { name: "Save team settings", exact: true }).click();
  await expect.poll(() => teamSettings.revision).toBe(10);
  expect(teamSettings.hostMaxConcurrent).toBe(28);
});
```

and add after it:

```js
test("host capacity overwrite uses the newer revision and leaving asks first", async ({
  page,
}) => {
  const { teamSettings, posted } = await setup(page);
  teamSettings.revision = 3;
  teamSettings.hostMaxConcurrent = 12;
  await page.goto(baseURL + "/settings/assistants");
  const capacity = page.getByLabel("Concurrent members on this host");
  await expect(capacity).toHaveValue("12");
  await capacity.fill("16");
  teamSettings.revision = 4;
  teamSettings.hostMaxConcurrent = 20;
  await refreshFromEvent(page);
  await page.getByRole("button", { name: "Overwrite anyway", exact: true }).click();
  await expect.poll(() => teamSettings.revision).toBe(5);
  expect(teamSettings.hostMaxConcurrent).toBe(16);
  expect(
    posted.filter((body) => "hostMaxConcurrent" in body).map((body) => body.revision),
  ).toEqual([4]);
  await expect(page.getByRole("region", { name: "Unsaved changes" })).toHaveCount(0);
  await capacity.fill("8");
  const back = page.getByRole("button", { name: "Back to Workspace", exact: true });
  await back.click();
  const sheet = page.getByRole("dialog", { name: "Save changes?" });
  await expect(sheet).toContainText("1 change in Agent service is not saved yet.");
  await sheet.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/assistants$/);
  await expect(capacity).toHaveValue("8");
  await back.click();
  await sheet.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(page).toHaveURL(/\/settings$/);
  expect(teamSettings.hostMaxConcurrent).toBe(16);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/unit/assistant-team-policy.test.js`
Expected: FAIL — `key` is `"conflict"`, expected `"capacity"`.

Run: `npm run build && npx playwright test tests/browser/assistant-teams.spec.js -g "host"`
Expected: FAIL — no region "Unsaved changes" (the old form saves on its own button).

- [ ] **Step 3: Give the capacity refusal its own key**

Run `grep -n "capacity:" server/lib/i18n/de/assistants.js server/lib/i18n/en/assistants.js`. If Step 0 (Ruling F2) already added `capacity`, keep its text. Otherwise add after `conflict:` in `server/lib/i18n/de/assistants.js`:

```js
  capacity:
    "Die Hostkapazität ist kleiner als die Teamgröße eines Agenten. Verkleinere zuerst das Team.",
```

and in `server/lib/i18n/en/assistants.js`:

```js
  capacity:
    "The host capacity is smaller than an agent's team size. Reduce that team first.",
```

Then run `grep -n 'assistantProblem("capacity"' server/features/assistants/team-policy.js`. If `normalizeTeamSettings` already throws `capacity` (Step 0 Task 11 may have changed it under Ruling F2), skip the replacement below; otherwise, in `server/features/assistants/team-policy.js` (`normalizeTeamSettings`) replace

```js
if (hostMaxConcurrent < Math.max(4, ...policies.map((p) => p.maxMembers)))
  throw assistantProblem("conflict", 409);
```

with

```js
// Not a stale revision: "Overwrite anyway" could never succeed, so it gets its own key.
if (hostMaxConcurrent < Math.max(4, ...policies.map((p) => p.maxMembers)))
  throw assistantProblem("capacity", 409);
```

- [ ] **Step 4: Move the capacity into the subpage's draft**

In `web/features/assistants/AssistantRuntimeSettings.jsx` delete `import AssistantTeamSettings from "./AssistantTeamSettings.jsx";` and the `<AssistantTeamSettings />` element (the agent page still uses `AssistantTeamSettings` with an `assistantId`).

Replace `web/features/settings/AgentServicePage.jsx` completely:

```jsx
import React from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import GroupLabel from "../../components/GroupLabel.jsx";
import ListCard from "../../components/ListCard.jsx";
import { NumberRow } from "../../components/ListRow.jsx";
import SaveBar from "../../components/SaveBar.jsx";
import UnsavedChangesSheet from "../../components/UnsavedChangesSheet.jsx";
import { assistantCopy } from "../../lib/i18n/messages/assistants.js";
import { assistantTeamCopy as teamCopy } from "../../lib/i18n/messages/assistant-team.js";
import useTabDraft from "../../lib/settings/useTabDraft.js";
import useUnsavedChangesGuard from "../../lib/settings/useUnsavedChangesGuard.js";
import AssistantRuntimeSettings from "../assistants/AssistantRuntimeSettings.jsx";
import { assistantApi } from "../assistants/assistant-api.js";
import useAssistants from "../assistants/useAssistants.js";
import { SubpageFrame } from "./SettingsFrame.jsx";
import { staysOn } from "./settings-navigation.js";
import { hostCapacityStep } from "./settings-steps.js";

const stays = staysOn("assistants");

// Runtime, runtime updates (immediate actions) and the host team capacity (a draft).
export default function AgentServicePage({ frame, diagnostic }) {
  const { teamSettings, refresh } = useAssistants();
  const draft = useTabDraft({
    server: { hostMaxConcurrent: teamSettings?.hostMaxConcurrent ?? "" },
    revisions: { team: teamSettings?.revision },
  });
  const steps = [
    hostCapacityStep({
      label: teamCopy.settings,
      save: assistantApi.teamSettings,
      refresh,
    }),
  ];
  const save = () => draft.save(steps);
  const sheet = useUnsavedChangesGuard({
    draft,
    tab: assistantCopy.runtime,
    save,
    stays,
  });
  return (
    <SubpageFrame
      frame={frame}
      title={assistantCopy.runtime}
      bar={
        <SaveBar
          draft={draft}
          onSave={save}
          onOverwrite={() => draft.overwrite(steps)}
          saveLabel={teamCopy.save}
        />
      }
    >
      <ErrorMessage error={diagnostic} />
      <AssistantRuntimeSettings />
      <GroupLabel id="agent-service-team" hint={teamCopy.concurrentHint}>
        {teamCopy.settings}
      </GroupLabel>
      <ListCard labelledBy="agent-service-team">
        <NumberRow
          label={teamCopy.capacity}
          value={draft.values.hostMaxConcurrent}
          min={4}
          max={32}
          disabled={!teamSettings || draft.saving}
          onChange={(value) => draft.set("hostMaxConcurrent", value)}
        />
      </ListCard>
      <UnsavedChangesSheet {...sheet} />
    </SubpageFrame>
  );
}
```

- [ ] **Step 5: Run the tests**

Run: `node --test tests/unit/assistant-team-policy.test.js tests/unit/assistant-team-store.test.js tests/unit/settings-steps.test.js tests/unit/i18n-terminology.test.js`
Expected: PASS. Then `npm run test:integration` — PASS (`saveSettings` still answers 409).

Run: `npm run build && npx playwright test tests/browser/assistant-teams.spec.js tests/browser/assistants.spec.js tests/browser/assistant-runtime-updates.spec.js tests/browser/assistant-settings.spec.js tests/browser/assistant-feature.spec.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
npx prettier --write web/features/settings/AgentServicePage.jsx web/features/assistants/AssistantRuntimeSettings.jsx server/features/assistants/team-policy.js server/lib/i18n/de/assistants.js server/lib/i18n/en/assistants.js tests/unit/assistant-team-policy.test.js tests/browser/assistant-teams.spec.js
npx eslint web/features/settings web/features/assistants/AssistantRuntimeSettings.jsx server/features/assistants/team-policy.js tests/unit/assistant-team-policy.test.js tests/browser/assistant-teams.spec.js
git add web/features/settings/AgentServicePage.jsx web/features/assistants/AssistantRuntimeSettings.jsx server/features/assistants/team-policy.js server/lib/i18n tests/unit/assistant-team-policy.test.js tests/browser/assistant-teams.spec.js
git commit -m "feat: save the host team capacity from the agent service page" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Update channel as a draft on the Updates subpage

**Files:**

- Create: `web/features/operations/UpdateChannelGroup.jsx`
- Modify: `web/features/operations/UpdatesPage.jsx`, `web/features/settings/SettingsSubpage.jsx`
- Test: `tests/browser/update-channel.spec.js`

**Interfaces:**

- Consumes: Task 2 `updateChannelStep`; Task 1 `staysOn`; Task 3 `SubpageFrame`, `frame`; Step 0 `GroupLabel`, `ListCard`, `RadioRow`, `SaveBar`, `UnsavedChangesSheet`, `useTabDraft`, `useUnsavedChangesGuard`.
- Produces: `UpdateChannelGroup({ releases, value, onChange, disabled })`; `UpdatesPage({ route, navigate, frame })` renders its own `SubpageFrame` with the channel bar.

- [ ] **Step 1: Rewrite the channel spec for radio rows and the bar**

Replace `tests/browser/update-channel.spec.js` completely:

```js
import { test, expect } from "@playwright/test";
import { settingsBar } from "../helpers/settings.js";
import { operationsFixture } from "./operations-fixture.js";

for (const locale of ["de-DE", "en-GB"]) {
  const en = locale === "en-GB";
  const t = (german, english) => (en ? english : german);
  test.describe(`update channels ${locale}`, () => {
    test.use({ locale, viewport: { width: 390, height: 844 } });
    const radio = (page, name) => page.getByRole("radio", { name, exact: true });
    const stable = (page) => radio(page, t("Stable — Standard", "Stable — Default"));
    const preview = (page) =>
      radio(page, t("Preview — Vorabversionen", "Preview — Release candidates"));
    const save = (page) =>
      settingsBar(page)
        .getByRole("button", { name: t("Speichern", "Save"), exact: true })
        .click();

    test("selection persists and clears the previous offer", async ({
      page,
    }, testInfo) => {
      const state = await operationsFixture(page);
      await page.goto("/settings/updates");
      await expect(stable(page)).toBeChecked();
      await page
        .getByRole("button", {
          name: t("Nach Updates suchen", "Check for updates"),
          exact: true,
        })
        .click();
      await expect(
        page.getByRole("heading", { name: "1.1.0", exact: true }),
      ).toBeVisible();
      await preview(page).check();
      await save(page);
      await expect(preview(page)).toBeChecked();
      await expect(page.getByRole("heading", { name: "1.1.0", exact: true })).toHaveCount(
        0,
      );
      expect(
        state.calls.some(
          (call) =>
            call.path.endsWith("/releases/channel") &&
            call.method === "PUT" &&
            call.body.updateChannel === "preview",
        ),
      ).toBe(true);
      await page.reload();
      await expect(preview(page)).toBeChecked();
      await expect(
        page.getByText(
          t(/Preview enthält Release Candidates/, /Preview includes release candidates/),
        ),
      ).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      ).toBe(true);
      await page.screenshot({
        path: testInfo.outputPath("update-channel-preview.png"),
        fullPage: true,
      });
      state.fail = "/operations/releases/channel";
      await stable(page).check();
      await save(page);
      await expect(page.getByText("Fixture conflict", { exact: true })).toBeVisible();
      await settingsBar(page)
        .getByRole("button", { name: t("Abbrechen", "Cancel"), exact: true })
        .click();
      await expect(preview(page)).toBeChecked();
      state.fail = "";
      await stable(page).check();
      await save(page);
      await expect(stable(page)).toBeChecked();
      await expect(settingsBar(page)).toHaveCount(0);
    });

    test("custom sources explain why the channel selection is managed", async ({
      page,
    }) => {
      const state = await operationsFixture(page);
      state.releases.updateChannelManaged = true;
      await page.goto("/settings/updates");
      const custom = radio(page, t("Eigene Update-Quelle", "Custom update source"));
      await expect(custom).toBeChecked();
      for (const row of [custom, stable(page), preview(page)])
        await expect(row).toBeDisabled();
      await expect(
        page.getByText(
          t(
            /Eine eigene Update-Quelle ist eingerichtet/,
            /A custom update source is configured/,
          ),
        ),
      ).toBeVisible();
    });

    test("a dirty channel asks before leaving but not for its own jobs", async ({
      page,
    }) => {
      const state = await operationsFixture(page);
      await page.goto("/settings/updates");
      await preview(page).check();
      await page
        .getByRole("button", {
          name: t("Nach Updates suchen", "Check for updates"),
          exact: true,
        })
        .click();
      await page
        .getByRole("button", {
          name: t("Version vorbereiten", "Stage release"),
          exact: true,
        })
        .click();
      await expect(page).toHaveURL(/job=job-stage/);
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await page
        .getByRole("button", {
          name: t("Zurück zu Betrieb", "Back to Operations"),
          exact: true,
        })
        .click();
      const sheet = page.getByRole("dialog", {
        name: t("Änderungen speichern?", "Save changes?"),
      });
      await expect(sheet).toContainText(
        t(
          "Im Tab Updates ist 1 Änderung noch nicht gespeichert.",
          "1 change in Updates is not saved yet.",
        ),
      );
      await sheet
        .getByRole("button", {
          name: t("Speichern und wechseln", "Save and switch"),
          exact: true,
        })
        .click();
      await expect(page).toHaveURL(/\/settings\?tab=operations$/);
      expect(
        state.calls.filter(
          (call) => call.method === "PUT" && call.path.endsWith("/releases/channel"),
        ),
      ).toHaveLength(1);
    });
  });
}
```

- [ ] **Step 2: Run the spec to verify it fails**

Run: `npm run build && npx playwright test tests/browser/update-channel.spec.js`
Expected: FAIL — no `radio` named "Stable — Standard" (the channel is a select).

- [ ] **Step 3: Implement the channel group**

Create `web/features/operations/UpdateChannelGroup.jsx`:

```jsx
import React from "react";
import GroupLabel from "../../components/GroupLabel.jsx";
import ListCard from "../../components/ListCard.jsx";
import { RadioRow } from "../../components/ListRow.jsx";
import { operationsCopy as copy } from "../../lib/i18n/messages/operations.js";

// The selected channel's help stays visible; the others' help is behind ⓘ.
export default function UpdateChannelGroup({ releases, value, onChange, disabled }) {
  const managed = Boolean(releases.updateChannelManaged);
  const options = [
    { value: "stable", label: copy.channelStable, help: copy.channelStableHelp },
    { value: "preview", label: copy.channelPreview, help: copy.channelPreviewHelp },
    ...(managed
      ? [{ value: "custom", label: copy.channelCustom, help: copy.channelManagedHelp }]
      : []),
  ];
  return (
    <>
      <GroupLabel id="update-channel-label">{copy.channel}</GroupLabel>
      <ListCard labelledBy="update-channel-label" className="update-channel">
        {options.map((option) => (
          <RadioRow
            key={option.value}
            name="update-channel"
            value={option.value}
            label={option.label}
            checked={value === option.value}
            disabled={disabled || managed}
            onChange={onChange}
            {...(value === option.value ? { sub: option.help } : { hint: option.help })}
          />
        ))}
      </ListCard>
    </>
  );
}
```

- [ ] **Step 4: Make the channel a draft of the Updates subpage**

In `web/features/operations/UpdatesPage.jsx`:

Add imports:

```js
import SaveBar from "../../components/SaveBar.jsx";
import UnsavedChangesSheet from "../../components/UnsavedChangesSheet.jsx";
import useTabDraft from "../../lib/settings/useTabDraft.js";
import useUnsavedChangesGuard from "../../lib/settings/useUnsavedChangesGuard.js";
import UpdateChannelGroup from "./UpdateChannelGroup.jsx";
import { SubpageFrame } from "../settings/SettingsFrame.jsx";
import { staysOn } from "../settings/settings-navigation.js";
import { updateChannelStep } from "../settings/settings-steps.js";
```

Add above the component:

```js
const stays = staysOn("updates");
const channelOf = (releases) =>
  releases.updateChannelManaged ? "custom" : releases.updateChannel || "stable";
```

Change the signature to `export default function UpdatesPage({ route, navigate, frame }) {` and, after `const presentation = …;`, add:

```js
const draft = useTabDraft({
  server: { updateChannel: releases ? channelOf(releases) : "" },
});
const steps = [
  updateChannelStep({
    label: copy.channel,
    save: (updateChannel) =>
      api("/operations/releases/channel", "PUT", { updateChannel }),
    onSaved: (result) => {
      setPlan(null);
      resource.update(result);
    },
  }),
];
const save = () => draft.save(steps);
const sheet = useUnsavedChangesGuard({ draft, tab: copy.updates, save, stays });
```

Replace the outer `<section>` … `</section>` of the return with a frame (keep every child that is not listed below unchanged; the section gets `className="operations-page"` because `SettingsSubpage` no longer wraps Updates in its `div.operations-page`):

```jsx
return (
  <SubpageFrame
    frame={frame}
    bar={
      <SaveBar draft={draft} onSave={save} onOverwrite={() => draft.overwrite(steps)} />
    }
  >
    <section className="operations-page">{/* … the existing children … */}</section>
    <UnsavedChangesSheet {...sheet} />
  </SubpageFrame>
);
```

Inside, replace the whole `<div className="operations-form">…</div>` that holds `label htmlFor="update-channel"`, the `<select id="update-channel">` and `<p id="update-channel-help">` with:

```jsx
<UpdateChannelGroup
  releases={releases}
  value={draft.values.updateChannel}
  onChange={(value) => draft.set("updateChannel", value)}
  disabled={jobPending || action.busy || draft.saving}
/>
```

In `web/features/settings/SettingsSubpage.jsx` remove `updates` from `pages` and add, below `if (section === "assistants") …`:

```jsx
if (section === "updates")
  return (
    <Suspense
      fallback={
        <SubpageFrame frame={frame}>
          <p role="status">{operationsCopy.loading}</p>
        </SubpageFrame>
      }
    >
      <UpdatesPage route={route} navigate={frame.navigate} frame={frame} />
    </Suspense>
  );
```

with `const UpdatesPage = lazy(() => import("../operations/UpdatesPage.jsx"));` next to `pages`.

- [ ] **Step 5: Run the specs**

Run: `npm run build && npx playwright test tests/browser/update-channel.spec.js tests/browser/update-activate.spec.js tests/browser/update-release-notes.spec.js tests/browser/update-release-notes-range.spec.js tests/browser/release-cleanup.spec.js tests/browser/operations-management.spec.js tests/browser/settings-tabs.spec.js`
Expected: PASS. `wc -l web/features/operations/UpdatesPage.jsx` stays below 600.

- [ ] **Step 6: Commit**

```bash
npx prettier --write web/features/operations/UpdateChannelGroup.jsx web/features/operations/UpdatesPage.jsx web/features/settings/SettingsSubpage.jsx tests/browser/update-channel.spec.js
npx eslint web/features/operations web/features/settings tests/browser/update-channel.spec.js
git add web/features/operations/UpdateChannelGroup.jsx web/features/operations/UpdatesPage.jsx web/features/settings/SettingsSubpage.jsx tests/browser/update-channel.spec.js
git commit -m "feat: save the update channel from the Updates bar" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Coverage check, full gate and screenshots

**Files:**

- Temporary (never committed): `tests/browser/zz-settings-general-screenshots.spec.js`
- Output (git-ignored): `/Users/d.kaulig/Projects/agent-pier/.worktrees/settings-general/.superpowers/screenshots/general/`

**Interfaces:**

- Consumes: everything from Tasks 1–6.

- [ ] **Step 1: Walk the coverage checklist**

Every action the old page offered must have a place and a spec that exercises it. For each line, open the place in the built app (`npm run build && npm start`, disposable data dir via the test server is fine) or confirm the cited spec passed in this branch:

| Old action (chip section)                                                                                               | New place                                                                   | Pinned by                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Change UI language (Allgemein, immediate)                                                                               | Arbeitsbereich › Allgemein › Sprache, applied on save                       | `i18n.spec.js`, `settings-workspace.spec.js`                                                                           |
| Type default directory, choose it in the folder picker, "Einstellungen speichern", saved notice, loading notice         | Arbeitsbereich › Allgemein › Standard-Arbeitsverzeichnis row + bar          | `preferences.spec.js`, `i18n.spec.js`, `settings-workspace.spec.js`                                                    |
| Auto-resume switch + description                                                                                        | Arbeitsbereich › Allgemein toggle + ⓘ                                       | `session-auto-resume.spec.js`, `settings-workspace.spec.js`                                                            |
| Agents switch, description, failure, diagnostics, check-failed state, re-check of a failed state when the settings open | Arbeitsbereich › Agenten toggle + ⓘ + diagnostic (`feature.retry` on mount) | `assistant-feature.spec.js`                                                                                            |
| Runtime state, sync, diagnostic notice, enable/restart, stop, technical details                                         | Agentendienst subpage                                                       | `assistants.spec.js`, `assistant-settings.spec.js`                                                                     |
| Runtime updates stage/activate/recover, blockers, diagnostics path                                                      | Agentendienst subpage                                                       | `assistant-runtime-updates.spec.js`                                                                                    |
| Host team capacity + hint                                                                                               | Agentendienst subpage › Team group + bar                                    | `assistant-teams.spec.js`                                                                                              |
| App install, push enable/disable/test, devices                                                                          | Arbeitsbereich › App › App & Benachrichtigungen subpage                     | `pwa.spec.js`, `notifications.spec.js`                                                                                 |
| MCP consent (`?authorization=`), setup per CLI (`?cli=`), grants paging (`?page=`), revoke                              | Zugriff › MCP & Zugriffe subpage                                            | `mcp-settings.spec.js`, `mcp-oauth.spec.js`                                                                            |
| Remote access (network switch, restart)                                                                                 | Zugriff › Fernzugriff subpage                                               | `remote-settings.spec.js`                                                                                              |
| SSH accesses and keys (tabs, add, edit, import)                                                                         | Zugriff › SSH-Zugänge subpage (wide)                                        | `ssh-settings.spec.js`, `ssh-keys.spec.js`, `ssh-access.spec.js`                                                       |
| GitHub credentials, commit identity                                                                                     | Zugriff › GitHub-Zugänge subpage                                            | `github-access.spec.js`, `git-commit-identity.spec.js`, `tool-installer.spec.js`                                       |
| Diagnostics run (scope, project, deep)                                                                                  | Betrieb › Diagnose subpage                                                  | `operations-diagnostics-project.spec.js`, `operations-adapter-diagnostics.spec.js`                                     |
| Backups create/download/delete/inspect/restore, imported history                                                        | Betrieb › Sicherungen subpage                                               | `operations-management.spec.js`, `operations-history.spec.js`, `backup-agent-credentials.spec.js`                      |
| Update channel (stable/preview/custom)                                                                                  | Betrieb › Updates subpage, radio rows + bar                                 | `update-channel.spec.js`                                                                                               |
| Check/stage/activate (reload sessions)/rollback/history/release notes/cleanup, `?job=`                                  | Betrieb › Updates subpage (immediate)                                       | `update-activate.spec.js`, `update-release-notes*.spec.js`, `release-cleanup.spec.js`, `operations-management.spec.js` |
| Activity log filters and paging                                                                                         | Betrieb › Aktivitätsprotokoll subpage (wide)                                | `operations-audit.spec.js`                                                                                             |
| Jump between any two sections                                                                                           | Tabs, rows, back button, browser history                                    | `settings-tabs.spec.js`                                                                                                |
| Deep links `/settings/<section>`                                                                                        | Unchanged addresses                                                         | `settings-sections.test.js`, `settings-tabs.spec.js`                                                                   |

Expected: every row has a place and its spec passes. A row without a place is a defect: fix it in the owning task's files before continuing.

- [ ] **Step 2: Run the full gate**

Run: `npm run check`
Expected: lint, format, structure (every file ≤ 600 lines), build and all node suites pass.

Run: `npm run test:e2e`
Expected: PASS. Then WebKit for the changed page specs: `AGENTPIER_TEST_BROWSER=webkit npx playwright test tests/browser/settings-tabs.spec.js tests/browser/settings-workspace.spec.js tests/browser/update-channel.spec.js tests/browser/i18n.spec.js tests/browser/assistant-teams.spec.js` (install with `npx playwright install webkit` if missing). Expected: PASS.

- [ ] **Step 3: Take the screenshots**

Create `tests/browser/zz-settings-general-screenshots.spec.js` (temporary):

```js
import fs from "node:fs";
import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { operationsFixture } from "./operations-fixture.js";

const out =
  "/Users/d.kaulig/Projects/agent-pier/.worktrees/settings-general/.superpowers/screenshots/general";
fs.mkdirSync(out, { recursive: true });
const sizes = [
  ["mobile", { width: 390, height: 844 }, { isMobile: true, hasTouch: true }],
  ["desktop", { width: 1280, height: 800 }, {}],
];
for (const [lang, locale] of [
  ["de", "de-DE"],
  ["en", "en-GB"],
])
  for (const [size, viewport, device] of sizes)
    test.describe(`${lang} ${size}`, () => {
      test.use({ locale, viewport, ...device });
      test("settings screenshots", async ({ page }) => {
        const en = lang === "en";
        await page.addInitScript(
          (value) => localStorage.setItem("agentpier-language", value),
          lang,
        );
        await operationsFixture(page);
        const views = [
          ["workspace", "/settings", page.getByRole("switch").first()],
          ["access", "/settings?tab=access", page.getByText("Tailscale")],
          ["operations", "/settings?tab=operations", page.getByText(/1\.1\.0/)],
          ["updates", "/settings/updates", page.getByRole("radio").first()],
        ];
        for (const [name, path, ready] of views) {
          await page.goto(baseURL + path);
          await expect(ready).toBeVisible();
          await page.screenshot({
            path: `${out}/${lang}-${size}-${name}.png`,
            fullPage: true,
            animations: "disabled",
          });
        }
        await page.goto(baseURL + "/settings");
        await page
          .getByRole("switch", {
            name: en
              ? "Resume interrupted sessions automatically"
              : "Unterbrochene Sitzungen automatisch fortsetzen",
          })
          .click();
        await page.screenshot({
          path: `${out}/${lang}-${size}-workspace-dirty.png`,
          fullPage: true,
          animations: "disabled",
        });
        await page.getByRole("tab", { name: en ? "Access" : "Zugriff" }).click();
        await expect(page.getByRole("dialog")).toBeVisible();
        await page.screenshot({
          path: `${out}/${lang}-${size}-unsaved-sheet.png`,
          animations: "disabled",
        });
      });
    });
```

Run: `npm run build && npx playwright test tests/browser/zz-settings-general-screenshots.spec.js`
Expected: PASS; `ls /Users/d.kaulig/Projects/agent-pier/.worktrees/settings-general/.superpowers/screenshots/general | wc -l` prints `24`.

Open a few of them (`Read` the PNGs) and check: tabs fill the row on mobile, no horizontal scroll, the bar sits above the safe area, the sheet is a bottom sheet on mobile and a centred dialog on desktop, English labels fit.

- [ ] **Step 4: Remove the screenshot spec and confirm a clean tree**

```bash
rm tests/browser/zz-settings-general-screenshots.spec.js
git status --short
```

Expected: no output (screenshots live under the ignored `.superpowers/`).

- [ ] **Step 5: Commit any fixes**

If Steps 1–3 required fixes, commit them with a focused message, e.g.:

```bash
git add <fixed files>
git commit -m "fix: <what the coverage walk found>" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Otherwise there is nothing to commit. Report the screenshot directory and the PR-description deviations (see "Decisions that refine the spec" and the changed spec assertions in Tasks 4–6).

---

## Self-Review

- **Spec coverage (Step 3):** tabs replace the chip row (Task 3); Arbeitsbereich groups Allgemein/Agenten/App with one bar chaining language → `PATCH /preferences` → `PUT /assistant-feature` (Tasks 2, 4); Agentendienst subpage with runtime, actions, updates, version details and host capacity with its own bar (Tasks 4, 5); App & Benachrichtigungen subpage (Task 3); Zugriff rows with `/settings/summary` statuses and the Accounts reference row (Tasks 1, 3); Betrieb rows as subpages, Updates channel in the bar with immediate release actions and `?job=` (Tasks 3, 6). Guiding decisions: no feature loss (Task 7 checklist), drafts everywhere (Tasks 4–6), base revision where the server has one (Task 5), partial saves (Tasks 2, 4), summary "—" (Tasks 1, 3), README sizes via Step 0 components, ⓘ disclosures (Task 4 spec).
- **Placeholder scan:** every code step carries the code; the one conditional check (server `capacity` key) names the exact command and the exact text to add.
- **Type consistency:** `frame` (`section`, `tab`, `go`, `navigate`, `openNavigation`, `navigationOpen`) is produced in Task 3 and consumed unchanged in Tasks 4–6; step ids `language`/`preferences`/`feature`/`capacity`/`channel` and keys match between Task 2 and their pages; `staysOn("general", "workspace")`, `staysOn("assistants")`, `staysOn("updates")` match Task 1's signature.
- **Review Focus:** each of the five lines has its test in the owning task (Task 4 canonical directory and loading save; Task 2/5 capacity; Task 6 job navigation; Tasks 1/3 summary).
