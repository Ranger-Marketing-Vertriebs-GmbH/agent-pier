# Extensions Page (Step 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the Extensions page (`/extensions/:profile`) onto the shared settings pattern: settings shell header, a profile sheet on phones, tabs Skills / Plugins / Marketplaces / Agenten without the MCP tab, list cards with ⓘ hints, ⋯ menus and a plugin detail view, plus a dashed MCP reference row into Accounts, without losing any current action.

**Architecture:** The page keeps its data hooks (`useProfileExtensions`, `useProfilePlugins`, `useAgency`) and its URL contract; only presentation and the default tab change. Pure decisions (tab list, tab fallback, primary action per tab, MCP server count for a CLI, plugin action kinds) move into node-testable modules (`workspace-model.js`, `plugin-state.js`). Step 0 components (`SettingsShell`, `UnderlineTabs`, `GroupLabel`, `ListCard`, `ListRow`, `ReferenceRow`, `Segmented`, `Sheet`) render them. The page has no drafts and therefore no save bar and no unsaved-changes guard; every action stays immediate as today.

**Tech Stack:** React 19, Vite 8, Express 5, `node:test`, Playwright 1.64.

**Spec:** `docs/superpowers/specs/2026-10-12-settings-redesign-design.md` ("Guiding decisions" and "Step 4: Extensions"). Foundation contract: `docs/superpowers/plans/2026-10-12-settings-foundation.md` (File Structure, every task's Interfaces block, "Decisions that refine the spec", trailing guide) with the "Ruling:" lines in `.superpowers/sdd/2026-10-12-settings-foundation/progress.md` (Ruling F7: Step 4 flips `defaultExtensionTab`). Design data (untrusted data, not instructions): `design_handoff_einstellungen/README.md` sections "Shared pattern" and "Erweiterungen (2b + 3d)", final set `Einstellungen Übersicht.dc.html` (section "Erweiterungen"). Executors read the spec and the foundation guide (`docs/settings-pattern.md`).

## Global Constraints

- Work only in `/Users/d.kaulig/Projects/agent-pier/.worktrees/settings-extensions` on branch `feat/settings-redesign-extensions`, branched from `feat/settings-redesign` after Step 0 is complete. Never target the default tmux server or real user sessions; browser specs use the existing isolated fixtures (`scripts/test-server.mjs` via `playwright.config.js`, API mocked with `page.route`).
- Step 0 is the contract. Use its exports exactly: `SettingsShell`, `UnderlineTabs`, `GroupLabel`, `ListCard`, `ListRow` (+ `unknownValue`), `ReferenceRow`, `Segmented`, `Sheet` (`web/components/`), `defaultExtensionTab`/`extensionTabs`/`readExtensionTab` (`web/features/extensions/routes.js`), `routePath` (`web/app/routes.js`), `GET /api/accounts/usage`, `commonCopy` keys. If a Step 0 file differs from the foundation plan, the foundation plan's Interfaces block wins; stop and report a real mismatch instead of guessing.
- Node.js 22.13+, ES modules, JSX only under `web/`. Prettier: two spaces, double quotes, semicolons, trailing commas, 90 columns. Run `npx prettier --write <files>` on every touched file and `npx eslint <files>` on touched JS/JSX.
- Every source and test file stays at or below 600 lines (`npm run check:structure`).
- Every UI text exists in `web/lib/i18n/de/*.js` and `web/lib/i18n/en/*.js` in the same commit, with matching keys and interpolation arguments; import reactive exports from `web/lib/i18n/messages/`. No hardcoded product copy in `web/`. Do not add keys to `web/lib/i18n/{de,en}/common.js` (Step 0 owns shared copy); page copy goes to `extensions.js`, `plugins.js`, `mcp-cli.js`, `agency.js`.
- Guiding decisions are binding: no feature loss (function wins over pixels); rows show "—" (`unknownValue`) until data is known, never a fake 0; hints behind ⓘ are disclosures (`aria-expanded`, `aria-controls`) with verbatim text; README sizes win (row ⋯/trash 40×40, ⓘ 20×20, mobile header 56px, desktop header 64px, tab fade 48px).
- Extensions has **no save bar** (spec Step 4). All actions stay immediate: skill install/remove, plugin install/enable/disable/update/remove, marketplace add/update/remove, Agency install/remove, sharing import.
- Browser specs that relied on old selectors change how elements are found, not what they assert. The only assertion changes allowed are those the spec forces: the MCP tab is gone (its assertions move to the reference row) and `skills` is the default tab (its URL no longer carries `?tab=skills`). Each such change is listed in its task.
- Commands: single node test `node --test tests/unit/<f>.test.js`; browser `npm run build && npx playwright test tests/browser/<f>.spec.js`; full gate `npm run check`.
- Commits in English with `feat:`, `fix:`, `test:` or `chore:` (docs-only: `chore:`), body ending with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **`/accounts/usage` is slow, fails, or lacks MCP data** (agents off, older server, a fixture answering `{}`): the reference row must show "— für Codex", never "0 für Codex", and the page must stay usable. Pinned in Task 1 (`cliServerCount` returns `null` for missing/malformed data) and Task 7 (held usage response shows "—" first, then the count).
2. **A mutation is running while the user tries to switch profile or tab on a phone**: the header profile switcher, the tabs and the desktop profile column must all be disabled (`locked`), so the sheet cannot open mid-write. Pinned in Task 3 (`expectProfilesDisabled` understands the switcher) and Task 7 (held plugin write on mobile).
3. **The plugin shown in the detail view disappears** (removed from the detail view, a reload, or a Codex catalog-account switch): the view must fall back to the list, never show stale actions for a plugin that no longer exists. The detail is selected by `pluginKey` (id + scope + path), so one id installed in two scopes never opens the wrong entry. Pinned in Task 5 (`PluginsTab` effect) and Task 7 (remove from the detail view returns to the empty list).
4. **The ⋯ menu sits inside a clipped list card near the viewport edge**: the popover must stay fully visible (fixed position, opening above its trigger when there is no room below), close on outside press, scroll and Escape, and return focus to its trigger. Pinned in Task 5 (`RowMenu`) and Task 7 (keyboard, Escape focus return, bounding box inside the viewport at the top and at the bottom edge).
5. **Legacy and junk addresses** (`?tab=mcp`, `/plugins/<id>`, `?tab=agents` on a non-shared profile, `?tab=bogus`, `?tab=marketplaces` before capabilities load): each must normalise once to one canonical address without a loop or an extra history entry. Pinned in Task 2 (unit) and Task 7 (browser, history length).

---

## File Structure

Pure logic (node-testable):

- `web/features/extensions/routes.js` (Step 0; modify) — tabs without `mcp`, `defaultExtensionTab = "skills"`, legacy `?tab=mcp` → `skills`.
- `web/features/extensions/workspace-model.js` (create) — `workspaceTabs`, `resolveWorkspaceTab`, `primaryAction`, `cliServerCount`.
- `web/features/plugins/plugin-state.js` (create) — `pluginStatus`, `pluginActionKinds`, `pluginKey`.

Page and workspace:

- `web/features/extensions/ExtensionsPage.jsx` (rewrite) — `SettingsShell` frame, desktop profile column (`ListDetail`), header profile switcher, usage read.
- `web/features/extensions/ProfileSwitcher.jsx` (create) — subtitle button + "CLI-Profile" sheet with check marks.
- `web/features/extensions/useMcpUsage.js` (create) — reads `GET /accounts/usage` once per page mount.
- `web/features/extensions/McpReferenceRow.jsx` (create) — dashed row "MCP-Server · n für <CLI>" into Accounts.
- `web/features/extensions/ExtensionWorkspace.jsx` (rewrite) — tabs, desktop detail header with config path and primary, group label with mobile primary and ⓘ, tab panels.
- `web/features/extensions/ExtensionPanels.jsx` (create) — skill / marketplace / npm add panels moved out of the workspace.
- `web/features/extensions/McpTab.jsx` (delete).
- `web/features/extensions/ExtensionHint.jsx` (create; moved from `ExtensionTable.jsx`), `ExtensionTable.jsx` (delete in Task 6).
- `web/features/extensions/RowLines.jsx` (create) — extra lines under a row label.
- `web/features/extensions/RowMenu.jsx` (create) — `useRowMenu`, `RowMenu` popover for ⋯ buttons.
- `web/features/extensions/SkillsTab.jsx`, `ExtensionsFrame.jsx` (modify).
- `web/features/extensions/extensions-hub.css` (rewrite in Task 3, extended in Tasks 4–6).
- `web/app/App.jsx` (modify) — pass `openNavigation`/`navigationOpen` to the page.

Plugins and Agency:

- `web/features/plugins/plugin-actions.js` (create) — labelled, callable plugin actions shared by menu and detail.
- `web/features/plugins/PluginRow.jsx`, `PluginDetail.jsx` (create); `PluginsTab.jsx`, `InstalledPlugins.jsx`, `PluginCatalog.jsx`, `Marketplaces.jsx`, `PluginFrame.jsx`, `CatalogAccount.jsx` (modify).
- `web/features/agency/AgentsTab.jsx` (modify).

Copy:

- `web/lib/i18n/{de,en}/extensions.js`, `web/lib/i18n/{de,en}/mcp-cli.js` (modify). No changes to `common.js`.

Docs:

- `docs/mcp.md`, `docs/shared-cli-extensions.md`, `README.de.md` (MCP tab wording; `README.md` does not mention the tab).

Tests:

- Unit: `tests/unit/extension-workspace-model.test.js` (create), `tests/unit/routes.test.js` (extend), `tests/property/routes.test.js` (modify).
- Browser helpers: `tests/helpers/extensions.js` (modify), `tests/helpers/extensions-page-fixture.js` (create).
- Browser specs updated: `extensions.spec.js`, `plugins.spec.js`, `codex-marketplace.spec.js`, `shared-agency.spec.js`, `i18n-plugins-providers.spec.js`, `navigation.spec.js`.
- Browser spec added: `tests/browser/extensions-pattern.spec.js`.
- Screenshots (not committed): `.superpowers/screenshots/extensions.config.js`, `.superpowers/screenshots/extensions-shots.spec.js`, output `.superpowers/screenshots/extensions/`.

### Decisions that refine the spec

- **The MCP count comes from `GET /accounts/usage`** (Step 0, Task 13): count = central servers whose `clis` list contains the profile's CLI tool. Bindings are per CLI, not per account, so every profile of one CLI shows the same count. `null` until known → "—".
- **The reference row sits under the Skills and Plugins lists** (as drawn), not on Marketplaces and Agenten.
- **Primary actions render twice, one hidden per breakpoint**: the desktop detail header button and the group-label text action ("+ …", the "+" is `aria-hidden`). CSS (`display: none`) removes the hidden one from the accessibility tree, so each viewport exposes exactly one button with the existing accessible name.
- **The config path stays visible on phones** inside the profile sheet (current row), because the mobile header drops the detail header; desktop shows it in the detail header (spec).
- **The content column is 976px wide on desktop** (`.extensions-page .settings-shell-content`), not the pattern's 720px: Extensions keeps its profile column beside the detail pane (README: tabs sit inside the detail pane when there is a left list), so the detail pane itself stays close to 720px. List this deviation in the PR description.
- **Plugin detail is local view state**, not a route: Step 0 defines no extension subpage route and the spec does not ask for one. On phones a row opens it; on desktop the ⋯ menu's "Details" (and a row click) opens it inside the detail pane.
- **Marketplace rows get the same ⋯ menu** (update, remove) because the drawing shows no actions and the actions must survive. Built-in marketplaces have no menu, as they have no buttons today.
- **The MCP explanation text (`mcpCliCopy.extensionsMoved`) and "MCP-Server öffnen" are removed**: the reference row ("MCP-Server · n für Codex", sub "Zentral unter Accounts", link "Accounts ↗") replaces both. `extensionsPageCopy.eyebrow`/`subtitle` are removed with the old page heading.
- **Group labels**: Skills → "Skills" (ⓘ `extensionScopeNote` for Codex only, server `skills.note` stays visible), Plugins → "Installiert" (`commonCopy.installed`) or "Plugin-Katalog", Marketplaces → "Marketplaces", Agenten → "Agenten". Rendered by the workspace as `h3` (the detail header's profile name is the `h2`).

---

### Task 1: Pure workspace decisions

Tab list, tab fallback, primary action per tab, the MCP server count for a CLI, and plugin action kinds, all node-testable.

**Files:**

- Create: `web/features/extensions/workspace-model.js`, `web/features/plugins/plugin-state.js`
- Test: `tests/unit/extension-workspace-model.test.js`

**Interfaces:**

- Consumes: `defaultExtensionTab` from `web/features/extensions/routes.js` (Step 0 Task 6).
- Produces:
  - `workspaceTabs({ shared, marketplaces, counts = {} }) => [{ id, count }]` — ids in order `skills`, `plugins`, `marketplaces` (only when `marketplaces`), `agents` (only when `shared`); `count` copied from `counts[id]` (may be `undefined`).
  - `resolveWorkspaceTab(requested, ids, known) => { tab, pending }` — `pending` when `requested === "marketplaces"` and `known === null` (capabilities not loaded yet); `tab` is `requested` when pending or listed, else `defaultExtensionTab`.
  - `primaryAction({ tab, tool, catalogSupported, extensionsReady, pluginsReady, pluginInstall }) => { kind: "skill" | "npm" | "discover" | "market" | "catalog", disabled: boolean }`.
  - `cliServerCount(usage, tool) => number | null` — `null` when `usage?.mcpServers` is not a plain object.
  - `pluginStatus(plugin) => "enabled" | "disabled" | "unknown"`.
  - `pluginActionKinds(plugin, capabilities = {}) => Array<"toggle" | "update" | "remove">` — empty when `plugin.removable === false`.
  - `pluginKey(plugin) => string` — identifies one installed entry (`id`, `scope`, `path`); the same plugin id can be installed in a user and a project scope, so the detail view must not select by `id` alone.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/extension-workspace-model.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { defaultExtensionTab } from "../../web/features/extensions/routes.js";
import {
  cliServerCount,
  primaryAction,
  resolveWorkspaceTab,
  workspaceTabs,
} from "../../web/features/extensions/workspace-model.js";
import {
  pluginActionKinds,
  pluginKey,
  pluginStatus,
} from "../../web/features/plugins/plugin-state.js";

test("workspace tabs list marketplaces only when supported and agents only when shared", () => {
  assert.deepEqual(
    workspaceTabs({ shared: false, marketplaces: false }).map((tab) => tab.id),
    ["skills", "plugins"],
  );
  assert.deepEqual(
    workspaceTabs({
      shared: true,
      marketplaces: true,
      counts: { skills: 2, plugins: 0, marketplaces: 1 },
    }),
    [
      { id: "skills", count: 2 },
      { id: "plugins", count: 0 },
      { id: "marketplaces", count: 1 },
      { id: "agents", count: undefined },
    ],
  );
});

test("unknown or unsupported tabs fall back; marketplaces waits for capabilities", () => {
  const ids = ["skills", "plugins"];
  assert.deepEqual(resolveWorkspaceTab("plugins", ids, true), {
    tab: "plugins",
    pending: false,
  });
  assert.deepEqual(resolveWorkspaceTab("agents", ids, true), {
    tab: defaultExtensionTab,
    pending: false,
  });
  assert.deepEqual(resolveWorkspaceTab("bogus", ids, false), {
    tab: defaultExtensionTab,
    pending: false,
  });
  assert.deepEqual(resolveWorkspaceTab("marketplaces", ids, null), {
    tab: "marketplaces",
    pending: true,
  });
  assert.deepEqual(resolveWorkspaceTab("marketplaces", ids, false), {
    tab: defaultExtensionTab,
    pending: false,
  });
});

test("each tab has one primary action with today's enablement rules", () => {
  const ready = {
    tool: "claude",
    catalogSupported: true,
    extensionsReady: true,
    pluginsReady: true,
    pluginInstall: true,
  };
  assert.deepEqual(primaryAction({ ...ready, tab: "skills" }), {
    kind: "skill",
    disabled: false,
  });
  assert.deepEqual(primaryAction({ ...ready, tab: "skills", extensionsReady: false }), {
    kind: "skill",
    disabled: true,
  });
  assert.deepEqual(primaryAction({ ...ready, tab: "plugins" }), {
    kind: "discover",
    disabled: false,
  });
  assert.deepEqual(primaryAction({ ...ready, tab: "plugins", catalogSupported: false }), {
    kind: "discover",
    disabled: true,
  });
  const openCode = {
    ...ready,
    tab: "plugins",
    tool: "opencode",
    catalogSupported: false,
  };
  assert.deepEqual(primaryAction(openCode), { kind: "npm", disabled: false });
  assert.deepEqual(primaryAction({ ...openCode, pluginInstall: false }), {
    kind: "npm",
    disabled: true,
  });
  assert.deepEqual(primaryAction({ ...openCode, pluginsReady: false }), {
    kind: "npm",
    disabled: true,
  });
  assert.deepEqual(
    primaryAction({ ...ready, tab: "marketplaces", pluginsReady: false }),
    {
      kind: "market",
      disabled: true,
    },
  );
  assert.deepEqual(primaryAction({ ...ready, tab: "agents" }), {
    kind: "catalog",
    disabled: false,
  });
});

const usage = (clis) => ({ agents: [], sessions: 0, pipelineProfiles: [], clis });

test("the MCP count is unknown until usage arrives and never invented", () => {
  assert.equal(cliServerCount(null, "codex"), null);
  assert.equal(cliServerCount({}, "codex"), null);
  assert.equal(cliServerCount({ mcpServers: null }, "codex"), null);
  assert.equal(cliServerCount({ mcpServers: [] }, "codex"), null);
  assert.equal(cliServerCount({ mcpServers: {} }, "codex"), 0);
  const servers = {
    github: usage([
      { tool: "claude", route: null },
      { tool: "codex", route: null },
    ]),
    files: usage([{ tool: "claude", route: null }]),
    broken: { agents: [] },
  };
  assert.equal(cliServerCount({ mcpServers: servers }, "codex"), 1);
  assert.equal(cliServerCount({ mcpServers: servers }, "claude"), 2);
  assert.equal(cliServerCount({ mcpServers: servers }, "opencode"), 0);
});

test("plugin status and actions follow the plugin and the CLI's capabilities", () => {
  assert.equal(pluginStatus({ enabled: true }), "enabled");
  assert.equal(pluginStatus({ enabled: false }), "disabled");
  assert.equal(pluginStatus({}), "unknown");
  assert.deepEqual(
    pluginActionKinds({ removable: true }, { enable: true, update: true }),
    ["toggle", "update", "remove"],
  );
  assert.deepEqual(pluginActionKinds({}, {}), ["remove"]);
  assert.deepEqual(pluginActionKinds({}), ["remove"]);
  assert.deepEqual(pluginActionKinds({ removable: false }, { enable: true }), []);
  // One plugin id installed in two scopes stays two distinct entries.
  const user = { id: "demo@m", scope: "user", path: "/u/demo" };
  const project = { id: "demo@m", scope: "project", path: "/p/demo" };
  assert.notEqual(pluginKey(user), pluginKey(project));
  assert.equal(pluginKey(user), pluginKey({ ...user, enabled: false }));
  assert.equal(pluginKey({ id: "x" }), pluginKey({ id: "x" }));
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/unit/extension-workspace-model.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `workspace-model.js`.

- [ ] **Step 3: Implement**

Create `web/features/extensions/workspace-model.js`:

```js
import { defaultExtensionTab } from "./routes.js";

/** The tabs of one CLI profile: marketplaces only when the CLI supports them, agents only for shared profiles. */
export function workspaceTabs({ shared, marketplaces, counts = {} }) {
  return [
    { id: "skills", count: counts.skills },
    { id: "plugins", count: counts.plugins },
    ...(marketplaces ? [{ id: "marketplaces", count: counts.marketplaces }] : []),
    ...(shared ? [{ id: "agents", count: counts.agents }] : []),
  ];
}

/**
 * The tab to show for a requested tab. A marketplaces link waits while the CLI's
 * capabilities are unknown (`known === null`) instead of flashing the default.
 */
export function resolveWorkspaceTab(requested, ids, known) {
  const pending = requested === "marketplaces" && known === null;
  return {
    tab: pending || ids.includes(requested) ? requested : defaultExtensionTab,
    pending,
  };
}

/** The tab's primary action: header button on desktop, group-label action on phones. */
export function primaryAction({
  tab,
  tool,
  catalogSupported,
  extensionsReady,
  pluginsReady,
  pluginInstall,
}) {
  if (tab === "plugins")
    return tool === "opencode" && !catalogSupported
      ? { kind: "npm", disabled: !pluginsReady || !pluginInstall }
      : { kind: "discover", disabled: !catalogSupported };
  if (tab === "marketplaces") return { kind: "market", disabled: !pluginsReady };
  if (tab === "agents") return { kind: "catalog", disabled: false };
  return { kind: "skill", disabled: !extensionsReady };
}

const plainObject = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Central MCP servers bound to a CLI, from GET /accounts/usage; null while unknown. */
export function cliServerCount(usage, tool) {
  if (!plainObject(usage?.mcpServers)) return null;
  return Object.values(usage.mcpServers).filter(
    (server) =>
      Array.isArray(server?.clis) && server.clis.some((cli) => cli?.tool === tool),
  ).length;
}
```

Create `web/features/plugins/plugin-state.js`:

```js
/** "enabled" / "disabled" when the CLI reports it, otherwise "unknown". */
export const pluginStatus = (plugin) =>
  plugin.enabled === true ? "enabled" : plugin.enabled === false ? "disabled" : "unknown";

/** Actions a plugin row offers; a plugin the CLI marks as not removable offers none. */
export function pluginActionKinds(plugin, capabilities = {}) {
  if (plugin.removable === false) return [];
  return [
    ...(capabilities.enable ? ["toggle"] : []),
    ...(capabilities.update ? ["update"] : []),
    "remove",
  ];
}

/** One installed entry; the same id may be installed in several scopes. */
export const pluginKey = (plugin) =>
  [plugin.id, plugin.scope ?? "", plugin.path ?? ""].join("\u0000");
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test tests/unit/extension-workspace-model.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
npx prettier --write web/features/extensions/workspace-model.js web/features/plugins/plugin-state.js tests/unit/extension-workspace-model.test.js
npx eslint web/features/extensions/workspace-model.js web/features/plugins/plugin-state.js tests/unit/extension-workspace-model.test.js
git add web/features/extensions/workspace-model.js web/features/plugins/plugin-state.js tests/unit/extension-workspace-model.test.js
git commit -m "feat: add pure extension workspace decisions" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Skills by default, MCP as a reference row

Flip the default tab, map legacy `?tab=mcp`, remove the MCP tab and add the dashed MCP reference row with the server count from `/accounts/usage`.

**Files:**

- Modify: `web/features/extensions/routes.js`, `web/features/extensions/ExtensionWorkspace.jsx`, `web/features/extensions/ExtensionsPage.jsx`
- Create: `web/features/extensions/useMcpUsage.js`, `web/features/extensions/McpReferenceRow.jsx`
- Delete: `web/features/extensions/McpTab.jsx`
- Modify: `web/lib/i18n/{de,en}/extensions.js`, `web/lib/i18n/{de,en}/mcp-cli.js`, `docs/mcp.md`, `docs/shared-cli-extensions.md`, `README.de.md`
- Test: `tests/unit/routes.test.js`, `tests/property/routes.test.js`, `tests/unit/extension-workspace-model.test.js`; browser `tests/browser/extensions.spec.js`, `plugins.spec.js`, `navigation.spec.js`, `shared-agency.spec.js`, `i18n-plugins-providers.spec.js`

**Interfaces:**

- Consumes: Task 1 (`workspaceTabs`, `resolveWorkspaceTab`, `cliServerCount`); Step 0 `ReferenceRow({ title, sub?, count?, href, onOpen, linkLabel? })`, `unknownValue`, `routePath`, `GET /api/accounts/usage` (`{ mcpServers: { [id]: { clis: [{ tool, route }] } } }`).
- Produces:
  - `extensionTabs = ["skills", "plugins", "marketplaces", "agents"]`, `defaultExtensionTab = "skills"`, `readExtensionTab(search)` maps `mcp` → `skills`.
  - `useMcpUsage(request) => usage | null`.
  - `McpReferenceRow({ tool, count, onNavigate })` → link to `{ view: "accounts", section: "mcp-servers" }`.
  - `ExtensionWorkspace` gains prop `serverCount: number | null`.
  - Copy: `extensionsHubCopy.mcpServers` (replaces `tabMcp`), `extensionsHubCopy.serversForCli(count, cli)`.

- [ ] **Step 1: Write the failing route tests**

In `tests/unit/routes.test.js`, after the line `assert.equal(path(read("/extensions/local-codex")), "/extensions/local-codex");` add:

```js
// The MCP tab became a reference row on Skills (settings redesign step 4).
assert.equal(read("/extensions/local-codex?tab=mcp").extensionTab, "skills");
assert.equal(path(read("/extensions/local-codex?tab=mcp")), "/extensions/local-codex");
assert.equal(path(read("/extensions/local-codex?tab=skills")), "/extensions/local-codex");
assert.equal(
  path(read("/extensions/local-codex?tab=marketplaces")),
  "/extensions/local-codex?tab=marketplaces",
);
```

In `tests/property/routes.test.js` add the import

```js
import { extensionTabs } from "../../web/features/extensions/routes.js";
```

and replace `for (const extensionTab of ["mcp", "skills", "plugins", "marketplaces", "agents"]) {` with `for (const extensionTab of extensionTabs) {`.

In `tests/unit/extension-workspace-model.test.js` append:

```js
test("skills is the extensions default tab", () => {
  assert.equal(defaultExtensionTab, "skills");
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/unit/routes.test.js tests/unit/extension-workspace-model.test.js`
Expected: FAIL — `extensionTab` is `"mcp"`, `defaultExtensionTab` is `"mcp"`.

- [ ] **Step 3: Flip the routes**

Replace `web/features/extensions/routes.js` with:

```js
// The tabs of a CLI profile's extensions. MCP servers are managed in Accounts; an old
// `?tab=mcp` link opens Skills, where the MCP reference row points there.
export const extensionTabs = ["skills", "plugins", "marketplaces", "agents"];
export const defaultExtensionTab = "skills";
const legacyTabs = { mcp: "skills" };

export function readExtensionTab(search) {
  const requested = new URLSearchParams(search).get("tab");
  const tab = Object.hasOwn(legacyTabs, requested ?? "")
    ? legacyTabs[requested]
    : requested;
  return extensionTabs.includes(tab) ? tab : defaultExtensionTab;
}
```

Run: `node --test tests/unit/routes.test.js tests/unit/settings-routes.test.js tests/property/routes.test.js tests/unit/extension-workspace-model.test.js`
Expected: PASS.

- [ ] **Step 4: Copy for the reference row; drop the MCP tab copy**

`web/lib/i18n/de/extensions.js`, in `extensionsHubCopy` replace `tabMcp: "MCP-Server",` with:

```js
  mcpServers: "MCP-Server",
  serversForCli: (count, cli) => `${count} für ${cli}`,
```

`web/lib/i18n/en/extensions.js`, in `extensionsHubCopy` replace `tabMcp: "MCP servers",` with:

```js
  mcpServers: "MCP servers",
  serversForCli: (count, cli) => `${count} for ${cli}`,
```

In `web/lib/i18n/de/mcp-cli.js` and `web/lib/i18n/en/mcp-cli.js` delete the `extensionsMoved: …` entry (two lines) and the `openCentralList: …` line. Confirm no other user: `grep -rn "extensionsMoved\|openCentralList\|tabMcp" web tests` must only list `ExtensionWorkspace.jsx` and `McpTab.jsx` (both changed below).

- [ ] **Step 5: Read the usage and render the row**

Create `web/features/extensions/useMcpUsage.js`:

```js
import { useEffect, useState } from "react";

/**
 * GET /accounts/usage once per page visit. It feeds the MCP reference row's count;
 * a failed or pending read stays null, so the row shows "—" instead of a made-up 0.
 */
export default function useMcpUsage(request) {
  const [usage, setUsage] = useState(null);
  useEffect(() => {
    let current = true;
    request("/accounts/usage")
      .then((next) => {
        if (current) setUsage(next);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [request]);
  return usage;
}
```

Create `web/features/extensions/McpReferenceRow.jsx`:

```jsx
import React from "react";
import { unknownValue } from "../../components/ListRow.jsx";
import ReferenceRow from "../../components/ReferenceRow.jsx";
import { extensionsHubCopy as hub } from "../../lib/i18n/messages/extensions.js";
import { names } from "../../lib/providers.js";
import { routePath } from "../../app/routes.js";

const target = { view: "accounts", section: "mcp-servers" };

/** MCP servers are central: a dashed row with the CLI's server count, into Accounts. */
export default function McpReferenceRow({ tool, count, onNavigate }) {
  return (
    <ReferenceRow
      title={hub.mcpServers}
      count={hub.serversForCli(count ?? unknownValue, names[tool] || tool)}
      href={routePath(target)}
      onOpen={() => onNavigate(target)}
    />
  );
}
```

In `web/features/extensions/ExtensionsPage.jsx` add the imports

```js
import useMcpUsage from "./useMcpUsage.js";
import { cliServerCount } from "./workspace-model.js";
```

add `const usage = useMcpUsage(request);` directly after `const locked = …;`, and pass `serverCount={cliServerCount(usage, account.tool)}` to `<ExtensionWorkspace …>`.

In `web/features/extensions/ExtensionWorkspace.jsx`:

1. Delete the imports of `mcpCliCopy`, `McpTab` and `defaultExtensionTab`; add

```js
import McpReferenceRow from "./McpReferenceRow.jsx";
import { resolveWorkspaceTab, workspaceTabs } from "./workspace-model.js";
```

2. Add `serverCount,` to the destructured props (after `onNavigate,`).
3. Replace everything from `const tabs = [` through the end of the `const tab =` statement (its last line is `      : defaultExtensionTab;`), including the "A marketplaces deep link …" comment and `const pending = …`, with:

```js
const tabLabels = {
  skills: hub.tabSkills,
  plugins: hub.tabPlugins,
  marketplaces: hub.tabMarketplaces,
  agents: hub.tabAgents,
};
const tabs = workspaceTabs({
  shared: account.shared,
  marketplaces: supported,
  counts: {
    skills: ext.data?.skills.items.length,
    plugins: plugins.data?.installed.length,
    marketplaces: plugins.data?.marketplaces.length,
    agents: agentCount,
  },
}).map((item) => ({ ...item, label: tabLabels[item.id] }));
// A marketplaces deep link waits for the CLI's capabilities instead of
// flashing a tab the CLI may not support.
const { tab } = resolveWorkspaceTab(
  requestedTab,
  tabs.map((item) => item.id),
  known,
);
```

4. In the `primary` map delete the whole `mcp: { … },` entry, and replace `<Icon name={primary.icon || "plus"} size={16} />` with `<Icon name="plus" size={16} />`.
5. Replace `{tab === "mcp" && <McpTab {...extProps} />}` with nothing, and directly after the `{tab === "marketplaces" && (…)}` block (still inside the tabpanel `<section>`) add:

```jsx
{
  (tab === "skills" || tab === "plugins") && (
    <McpReferenceRow tool={account.tool} count={serverCount} onNavigate={onNavigate} />
  );
}
```

Delete `web/features/extensions/McpTab.jsx` (`git rm web/features/extensions/McpTab.jsx`).

- [ ] **Step 6: Update the docs**

`docs/mcp.md`: replace the bullet

```markdown
- The MCP tab of **Extensions** no longer edits MCP servers; it links to Accounts →
  **MCP servers**.
```

with

```markdown
- **Extensions** does not edit MCP servers: Skills and Plugins show a reference row
  with the number of central servers bound to that CLI, linking to Accounts →
  **MCP servers**.
```

`docs/shared-cli-extensions.md`: in the first paragraph replace `(the MCP tab links to the central MCP list)` with `(a reference row links to the central MCP list)`, and in the MCP paragraph replace `the Extensions MCP tab only links there.` with `Extensions only shows a reference row that links there; old \`?tab=mcp\` links open Skills.`

`README.de.md` (explicitly German, stays German): in the paragraph that starts `Unter **Erweiterungen** zunächst das CLI-Profil wählen.` replace `Die Tabs **MCP-Server** und **Skills** zeigen deren gemeinsame MCP-Konfiguration und bekannte Skill-Ordner einschließlich Pfad und Geltungsbereich.` with `Der Tab **Skills** zeigt die bekannten Skill-Ordner einschließlich Pfad und Geltungsbereich; eine Verweiszeile nennt die Zahl der zentralen MCP-Server dieser CLI und führt zu Accounts → **MCP-Server**.`

- [ ] **Step 7: Update the browser specs the MCP tab removal touches**

Allowed assertion changes in this step (forced by the spec): MCP tab entries leave the tab lists; MCP tab content assertions become reference-row assertions; URLs of the default tab lose `?tab=skills`; "MCP tab selected" becomes "Skills tab selected".

Several tab-list arrays below are written on one line here but span several lines in the spec files (Prettier); match the entries, not the line layout.

`tests/browser/extensions.spec.js`:

- In `fixture`, before `if (url.pathname.endsWith("/extensions"))` add:

```js
if (url.pathname === "/api/accounts/usage")
  return route.fulfill({
    json: {
      agentsEnabled: false,
      connections: {},
      chatgpt: {},
      webSearch: null,
      speech: null,
      cliAccounts: {},
      mcpServers: {
        github: {
          agents: [],
          sessions: 0,
          pipelineProfiles: [],
          clis: [{ tool: "claude", route: null }],
        },
      },
    },
  });
```

- Replace the first test with:

```js
test("the MCP reference row points to the central MCP server list", async ({ page }) => {
  const { writes } = await fixture(page);
  await open(page);
  await expect(
    page.getByRole("heading", { name: "Erweiterungen", level: 1 }),
  ).toBeVisible();
  const claude = profileList(page).getByRole("button", { name: /Claude Code/ });
  await claude.click();
  await expect(claude).toHaveAttribute("aria-current", "true");
  await expect(page).toHaveURL(/\/extensions\/managed-claude$/);
  await expect(page.getByRole("tab")).toHaveText([/^Skills/, /^Plugins/]);
  const reference = page.getByRole("link", { name: /^MCP-Server · 1 für Claude Code/ });
  await expect(reference).toContainText("Zentral unter Accounts");
  await expect(
    page.getByRole("button", { name: "MCP-Server hinzufügen", exact: true }),
  ).toHaveCount(0);
  await reference.click();
  await expect(page).toHaveURL(/\/accounts\?section=mcp-servers$/);
  await expect(page.getByRole("region", { name: "In den CLIs gefunden" })).toBeVisible();
  expect(writes).toHaveLength(0);
});
```

- In the skill upload test replace `await expect(page).toHaveURL(/\/extensions\/local-codex\?tab=skills$/);` with `await expect(page).toHaveURL(/\/extensions\/local-codex$/);`.
- In the pagination test replace `await expect(page).toHaveURL(/\/extensions\/managed-claude\?tab=skills$/);` with `await expect(page).toHaveURL(/\/extensions\/managed-claude$/);`.

`tests/browser/plugins.spec.js`:

- Replace the tab assertion `[/^MCP-Server/, /^Skills/, /^Plugins/, /^Marketplaces/]` with `[/^Skills/, /^Plugins/, /^Marketplaces/]`, and `[/^MCP-Server/, /^Skills/, /^Plugins/]` with `[/^Skills/, /^Plugins/]`.
- Rename the last test to `"a marketplaces link for OpenCode normalises to Skills without showing the tab"` and replace both `/^MCP-Server/` tab locators in it with `/^Skills/`.

`tests/browser/navigation.spec.js`:

- In "unsupported extension tabs …" replace `name: /^MCP-Server/` with `name: /^Skills/`.
- In "profile deep links and navigation survive reload and history" replace

```js
  await page.getByRole("tab", { name: /^Skills/ }).click();
  await expect(page).toHaveURL(/\/extensions\/work-claude\?tab=skills$/);
  await page.goBack();
  await expect(page.getByRole("tab", { name: /^MCP-Server/ })).toHaveAttribute(
```

with

```js
  await page.getByRole("tab", { name: /^Plugins/ }).click();
  await expect(page).toHaveURL(/\/extensions\/work-claude\?tab=plugins$/);
  await page.goBack();
  await expect(page.getByRole("tab", { name: /^Skills/ })).toHaveAttribute(
```

(the behaviour pinned stays the same: a tab click adds a history entry, Back restores the default tab).

`tests/browser/shared-agency.spec.js`:

- In the fixture add, directly after `if (endpoint === "/api/state") result = state;`: `else if (endpoint === "/api/accounts/usage") result = { mcpServers: {} };`
- Replace the tab list `[/^MCP-Server/, /^Skills/, /^Plugins/, /^Marketplaces/, /^Agenten/]` with `[/^Skills/, /^Plugins/, /^Marketplaces/, /^Agenten/]`.

`tests/browser/i18n-plugins-providers.spec.js`:

- Replace the tab list `[/^MCP servers/, /^Skills/, /^Plugins/, /^Marketplaces/, /^Agents/]` with `[/^Skills/, /^Plugins/, /^Marketplaces/, /^Agents/]`.
- Replace

```js
await page.getByRole("tab", { name: /^MCP servers/ }).click();
await expect(
  page.getByText(/^MCP servers are managed centrally under Accounts → MCP servers\./),
).toBeVisible();
await expect(
  page.getByRole("button", { name: "Open MCP servers", exact: true }),
).toBeVisible();
```

with

```js
await page.getByRole("tab", { name: /^Skills/ }).click();
await expect(
  page.getByRole("link", { name: /^MCP servers · — for Codex/ }),
).toContainText("Managed centrally in Accounts");
```

(this fixture answers `/api/accounts/usage` with `{}`, so the count is unknown and shows "—").

- [ ] **Step 8: Run the checks**

Run: `node --test tests/unit/routes.test.js tests/unit/settings-routes.test.js tests/property/routes.test.js tests/unit/extension-workspace-model.test.js tests/unit/i18n-catalogs.test.js tests/unit/i18n.test.js`
Expected: PASS.

Run: `npm run build && npx playwright test tests/browser/extensions.spec.js tests/browser/plugins.spec.js tests/browser/navigation.spec.js tests/browser/shared-agency.spec.js tests/browser/i18n-plugins-providers.spec.js tests/browser/codex-marketplace.spec.js`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
npx prettier --write web/features/extensions web/lib/i18n/de/extensions.js web/lib/i18n/en/extensions.js web/lib/i18n/de/mcp-cli.js web/lib/i18n/en/mcp-cli.js docs/mcp.md docs/shared-cli-extensions.md README.de.md tests/unit/routes.test.js tests/property/routes.test.js tests/unit/extension-workspace-model.test.js tests/browser/extensions.spec.js tests/browser/plugins.spec.js tests/browser/navigation.spec.js tests/browser/shared-agency.spec.js tests/browser/i18n-plugins-providers.spec.js
npx eslint web/features/extensions tests/unit/routes.test.js tests/property/routes.test.js tests/browser/extensions.spec.js tests/browser/plugins.spec.js tests/browser/navigation.spec.js tests/browser/shared-agency.spec.js tests/browser/i18n-plugins-providers.spec.js
git add -A web/features/extensions web/lib/i18n docs/mcp.md docs/shared-cli-extensions.md README.de.md tests/unit tests/property tests/browser
git commit -m "feat: open extensions on Skills and show MCP servers as a reference row" -m "Old ?tab=mcp links open Skills. The row counts the central MCP servers bound to the profile's CLI and links to Accounts." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Settings shell, profile sheet and primary actions

The page moves into `SettingsShell`: sidebar button on phones, title + description on desktop, the profile switcher as the mobile subtitle (sheet "CLI-Profile"), the desktop profile column unchanged. The tab's primary action moves to the group label on phones and stays in the detail header on desktop; the fixed mobile bottom button goes away. Add panels move into their own file.

**Files:**

- Rewrite: `web/features/extensions/ExtensionsPage.jsx`, `web/features/extensions/ExtensionWorkspace.jsx`, `web/features/extensions/extensions-hub.css`
- Create: `web/features/extensions/ProfileSwitcher.jsx`, `web/features/extensions/ExtensionPanels.jsx`
- Modify: `web/app/App.jsx` (Extensions element), `web/lib/i18n/{de,en}/extensions.js`
- Test: `tests/helpers/extensions.js`; browser `tests/browser/extensions.spec.js`, `tests/browser/shared-agency.spec.js`

**Interfaces:**

- Consumes: Step 0 `SettingsShell({ title, subtitle?, description?, leading, onLeading, navigationOpen, className, children })`, `Sheet({ open, title, onCancel, className, children })` (`.sheet-body`, `.sheet-actions`), `GroupLabel({ children, as, hint?, action? })`, `ListCard({ label, className, children })`, `UnderlineTabs`, `Icon` names `down`, `check`; Task 1 `primaryAction`; Task 2 `useMcpUsage`, `McpReferenceRow`.
- Produces:
  - `ExtensionsPage` props: existing + `openNavigation`, `navigationOpen`.
  - `ProfileSwitcher({ profiles, selected, sub(item), configPath, locked, onSelect(id) })` — button named `extensionsHubCopy.switchProfile(name)` with class `extension-profile-switch`; sheet `dialog.extension-profile-sheet` titled `hub.profiles` with a `ListCard` group of the same name whose buttons carry `aria-current="true"` for the current profile.
  - `ExtensionWorkspace` props: `{ account, request, tab, onTab, busySetters, locked, onNavigate, serverCount, onConfigPath }`; state `pluginDetail`/`setPluginDetail` passed to `PluginsTab` as `detail`/`setDetail` (consumed in Task 5).
  - `ExtensionPanels({ panel, ext, plugins, request, subtitle, submitted, setSubmitted, close })`.
  - Test helpers: `openProfiles(page, name?) => Promise<Locator>` (sheet group on phones, profile column on desktop), `closeProfiles(page)`, `expectProfilesDisabled(page, name?)` (switcher on phones).
  - Copy: `extensionsHubCopy.switchProfile(name)`; removed `extensionsPageCopy.eyebrow`, `extensionsPageCopy.subtitle`.

- [ ] **Step 1: Update the helpers and the mobile profile steps (failing first)**

In `tests/helpers/extensions.js` add after `profileList`:

```js
const profileSwitch = /^(CLI-Profil wechseln|Switch CLI profile)/;

// Desktop lists CLI profiles in a column; phones open them from the header subtitle as
// a sheet. Returns the group of profile buttons in either case.
export async function openProfiles(page, name = "CLI-Profile") {
  const switcher = page.getByRole("button", { name: profileSwitch });
  await expect(
    switcher.or(profileList(page, name)).filter({ visible: true }),
  ).toHaveCount(1);
  if (!(await switcher.isVisible())) return profileList(page, name);
  await switcher.click();
  return page
    .getByRole("dialog", { name, exact: true })
    .getByRole("group", { name, exact: true });
}

export async function closeProfiles(page) {
  if (await page.locator("dialog.extension-profile-sheet").isVisible())
    await page.keyboard.press("Escape");
}
```

and replace `expectProfilesDisabled` with:

```js
export async function expectProfilesDisabled(page, name) {
  const switcher = page.getByRole("button", { name: profileSwitch });
  if (await switcher.isVisible()) return expect(switcher).toBeDisabled();
  const buttons = profileList(page, name).getByRole("button");
  expect(await buttons.count()).toBeGreaterThan(0);
  for (const button of await buttons.all()) await expect(button).toBeDisabled();
}
```

`tests/browser/extensions.spec.js` (mobile pagination variant, profile switch): add `openProfiles` to the helper import and replace

```js
await profileList(page)
  .getByRole("button", { name: /Claude Code/ })
  .click();
```

with

```js
await (await openProfiles(page)).getByRole("button", { name: /Claude Code/ }).click();
```

`tests/browser/shared-agency.spec.js`: add `closeProfiles, openProfiles` to the helper import (drop `profileList`) and replace

```js
const profiles = profileList(page).getByRole("button");
await expect(profiles).toHaveCount(2);
await expect(profiles.filter({ hasText: "Claude Code" })).toHaveAttribute(
  "aria-current",
  "true",
);
```

with

```js
const profiles = (await openProfiles(page)).getByRole("button");
await expect(profiles).toHaveCount(2);
await expect(profiles.filter({ hasText: "Claude Code" })).toHaveAttribute(
  "aria-current",
  "true",
);
await closeProfiles(page);
```

Run: `npm run build && npx playwright test tests/browser/shared-agency.spec.js tests/browser/extensions.spec.js`
Expected: the desktop variants PASS (the helpers fall back to the profile column). The mobile variants may still pass against the old chip row, because today's chips are a visible "CLI-Profile" navigation; that is fine — this step only moves the specs onto helpers that work for both layouts. The implementation below must keep every variant green once the chips are gone.

- [ ] **Step 2: Copy for the switcher; drop the old heading copy**

`web/lib/i18n/de/extensions.js`: in `extensionsPageCopy` delete `eyebrow` and `subtitle`; in `extensionsHubCopy` add after `sharedProfile`:

```js
  switchProfile: (name) => `CLI-Profil wechseln, aktuell ${name}`,
```

`web/lib/i18n/en/extensions.js`: in `extensionsPageCopy` delete `eyebrow` and `subtitle`; in `extensionsHubCopy` add after `sharedProfile`:

```js
  switchProfile: (name) => `Switch CLI profile, current: ${name}`,
```

- [ ] **Step 3: The profile switcher**

Create `web/features/extensions/ProfileSwitcher.jsx`:

```jsx
import React, { useState } from "react";
import Icon from "../../components/Icon.jsx";
import ListCard from "../../components/ListCard.jsx";
import ProviderMark from "../../components/ProviderMark.jsx";
import Sheet from "../../components/Sheet.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { extensionsHubCopy as hub } from "../../lib/i18n/messages/extensions.js";

// Phones: the header subtitle names the profile and opens the "CLI-Profile" sheet.
// The current row also carries the CLI's config path, which desktop shows in the
// detail header.
export default function ProfileSwitcher({
  profiles,
  selected,
  sub,
  configPath,
  locked,
  onSelect,
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="extension-profile-switch"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={hub.switchProfile(selected.name)}
        disabled={locked}
        onClick={() => setOpen(true)}
      >
        <span>{selected.name}</span>
        <Icon name="down" size={12} />
      </button>
      <Sheet
        open={open && !locked}
        title={hub.profiles}
        onCancel={() => setOpen(false)}
        className="extension-profile-sheet"
      >
        <div className="sheet-body">
          <ListCard label={hub.profiles}>
            {profiles.map((item) => {
              const current = item.id === selected.id;
              return (
                <div key={item.id} className="list-row two-line">
                  <button
                    type="button"
                    className="list-row-main"
                    aria-current={current ? "true" : undefined}
                    onClick={() => {
                      setOpen(false);
                      if (!current) onSelect(item.id);
                    }}
                  >
                    <ProviderMark tool={item.tool} small />
                    <span className="list-row-text">
                      <span className="list-row-label">{item.name}</span>
                      <span className="list-row-sub">
                        {sub(item)}
                        {current && configPath && (
                          <>
                            {" · "}
                            <code>{configPath}</code>
                          </>
                        )}
                      </span>
                    </span>
                    {current && (
                      <Icon name="check" size={16} className="extension-profile-check" />
                    )}
                  </button>
                </div>
              );
            })}
          </ListCard>
        </div>
        <div className="sheet-actions">
          <button
            type="button"
            className="button secondary"
            onClick={() => setOpen(false)}
          >
            {commonCopy.cancel}
          </button>
        </div>
      </Sheet>
    </>
  );
}
```

- [ ] **Step 4: The page**

Replace `web/features/extensions/ExtensionsPage.jsx` with:

```jsx
import React, { useMemo, useState } from "react";
import ListDetail from "../../components/ListDetail.jsx";
import ProviderMark from "../../components/ProviderMark.jsx";
import SettingsShell from "../../components/SettingsShell.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import {
  extensionsHubCopy as hub,
  extensionsPageCopy as copy,
} from "../../lib/i18n/messages/extensions.js";
import { names } from "../../lib/providers.js";
import ExtensionWorkspace from "./ExtensionWorkspace.jsx";
import ProfileSwitcher from "./ProfileSwitcher.jsx";
import { defaultExtensionTab } from "./routes.js";
import { extensionProfiles } from "./sharedProfiles.js";
import useMcpUsage from "./useMcpUsage.js";
import { cliServerCount } from "./workspace-model.js";
import "./extensions-hub.css";

const busySources = ["extensions", "plugins", "agency"];

export default function ExtensionsPage({
  shared = false,
  accounts = [],
  request,
  profileId,
  extensionTab = defaultExtensionTab,
  onNavigate,
  openNavigation,
  navigationOpen = false,
}) {
  const profiles = extensionProfiles(accounts, shared);
  const [busy, setBusy] = useState({});
  const [configPath, setConfigPath] = useState("");
  // Each data source reports its own pending mutation; the profile list, the profile
  // switcher and the tabs stay locked until every source has finished.
  const busySetters = useMemo(
    () =>
      Object.fromEntries(
        busySources.map((source) => [
          source,
          (value) => setBusy((current) => ({ ...current, [source]: Boolean(value) })),
        ]),
      ),
    [],
  );
  const locked = Object.values(busy).some(Boolean);
  const usage = useMcpUsage(request);
  const account =
    profiles.find((item) => item.id === profileId) || (!profileId ? profiles[0] : null);
  const sub = (item) => (shared ? hub.sharedProfile : names[item.tool] || item.tool);
  const go = (next, replace = false) =>
    onNavigate(
      {
        view: "extensions",
        profileId: account?.id,
        extensionTab,
        ...next,
      },
      replace,
    );
  return (
    <SettingsShell
      className="extensions-page extensions-hub"
      title={copy.title}
      description={copy.description}
      leading="menu"
      onLeading={openNavigation}
      navigationOpen={navigationOpen}
      subtitle={
        account && (
          <ProfileSwitcher
            profiles={profiles}
            selected={account}
            sub={sub}
            configPath={configPath}
            locked={locked}
            onSelect={(id) => go({ profileId: id })}
          />
        )
      }
    >
      <ListDetail
        className="extension-profiles"
        listLabel={hub.profiles}
        items={profiles}
        selectedId={account?.id || ""}
        disabled={locked}
        onSelect={(id) => id && go({ profileId: id })}
        renderItem={(item) => (
          <>
            <ProviderMark tool={item.tool} small />
            <span className="extension-profile-name">
              <strong>{item.name}</strong>
              <small>{sub(item)}</small>
            </span>
          </>
        )}
        detail={
          account ? (
            <ExtensionWorkspace
              key={account.id}
              account={account}
              request={request}
              tab={extensionTab}
              onTab={(extensionTab, replace) => go({ extensionTab }, replace)}
              busySetters={busySetters}
              locked={locked}
              onNavigate={onNavigate}
              serverCount={cliServerCount(usage, account.tool)}
              onConfigPath={setConfigPath}
            />
          ) : (
            <p className="loading" role="status">
              {commonCopy.profilesLoading}
            </p>
          )
        }
      />
    </SettingsShell>
  );
}
```

In `web/app/App.jsx`, give the `<Extensions … />` element two more props after `onNavigate={navigate}`:

```jsx
openNavigation = { openNavigation };
navigationOpen = { mobileNav };
```

- [ ] **Step 5: Move the add panels out of the workspace**

Create `web/features/extensions/ExtensionPanels.jsx`:

```jsx
import React from "react";
import { marketplacesCopy, profilePluginsCopy } from "../../lib/i18n/messages/plugins.js";
import PluginSourceForm from "../plugins/PluginSourceForm.jsx";
import SkillInstallForm from "./SkillInstallForm.jsx";

// The add panels of a profile: a skill, a marketplace source or an OpenCode package.
export default function ExtensionPanels({
  panel,
  ext,
  plugins,
  request,
  subtitle,
  submitted,
  setSubmitted,
  close,
}) {
  // A plugin panel shows only errors of its own submission, never an older one.
  const error = submitted ? plugins.error : "";
  if (panel === "skill")
    return (
      <SkillInstallForm {...ext} request={request} subtitle={subtitle} close={close} />
    );
  if (panel === "market")
    return (
      <PluginSourceForm
        title={marketplacesCopy.addMarketplace}
        subtitle={subtitle}
        label={marketplacesCopy.extensionWide}
        placeholder={marketplacesCopy.extensionWidePlaceholder}
        description={marketplacesCopy.marketplaceSourceDescription}
        submitLabel={marketplacesCopy.addMarketplace}
        value={plugins.source}
        setValue={plugins.setSource}
        disabled={plugins.disabled}
        busy={plugins.busy}
        error={error}
        close={close}
        submit={() => {
          setSubmitted(true);
          plugins.mutate(
            { action: "marketplace-add", source: plugins.source.trim() },
            marketplacesCopy.extensionInstallOnSubmit,
            () => {
              plugins.setSource("");
              close();
            },
          );
        }}
      />
    );
  if (panel === "npm")
    return (
      <PluginSourceForm
        title={profilePluginsCopy.extensionInstallHeading}
        subtitle={subtitle}
        label={profilePluginsCopy.extensionWide}
        placeholder={profilePluginsCopy.extensionWidePlaceholder}
        description={profilePluginsCopy.packageSourceDescription}
        submitLabel={profilePluginsCopy.installPackage}
        value={plugins.pkg}
        setValue={plugins.setPkg}
        disabled={plugins.disabled || !plugins.capabilities.install}
        busy={plugins.busy}
        error={error}
        close={close}
        submit={() => {
          setSubmitted(true);
          plugins.mutate(
            { action: "install", source: plugins.pkg.trim() },
            profilePluginsCopy.extensionInstallOnSubmit,
            () => {
              plugins.setPkg("");
              close();
            },
          );
        }}
      />
    );
  return null;
}
```

- [ ] **Step 6: The workspace**

Replace `web/features/extensions/ExtensionWorkspace.jsx` with:

```jsx
import React, { useCallback, useEffect, useState } from "react";
import GroupLabel from "../../components/GroupLabel.jsx";
import Icon from "../../components/Icon.jsx";
import UnderlineTabs from "../../components/UnderlineTabs.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { extensionsHubCopy as hub } from "../../lib/i18n/messages/extensions.js";
import {
  marketplacesCopy,
  pluginCatalogCopy,
  profilePluginsCopy,
} from "../../lib/i18n/messages/plugins.js";
import { names } from "../../lib/providers.js";
import AgentsTab from "../agency/AgentsTab.jsx";
import MarketplacesTab from "../plugins/MarketplacesTab.jsx";
import PluginsTab from "../plugins/PluginsTab.jsx";
import useProfilePlugins from "../plugins/useProfilePlugins.js";
import ExtensionPanels from "./ExtensionPanels.jsx";
import McpReferenceRow from "./McpReferenceRow.jsx";
import SkillsTab from "./SkillsTab.jsx";
import useProfileExtensions from "./useProfileExtensions.js";
import { primaryAction, resolveWorkspaceTab, workspaceTabs } from "./workspace-model.js";

// "+ Skill installieren" on the group label (phones); the "+" stays out of the name.
const groupAction = (primary) => ({
  label: (
    <>
      <span aria-hidden="true">+ </span>
      {primary.label}
    </>
  ),
  onClick: primary.run,
  disabled: primary.disabled,
});

// One instance per profile (keyed by the page): the data hooks live here so
// switching tabs neither refetches nor drops notices, drafts or confirmations.
export default function ExtensionWorkspace({
  account,
  request,
  tab: requestedTab,
  onTab,
  busySetters,
  locked,
  onNavigate,
  serverCount,
  onConfigPath,
}) {
  const ext = useProfileExtensions({
    account,
    request,
    setParentBusy: busySetters.extensions,
  });
  const plugins = useProfilePlugins({
    account,
    request,
    setParentBusy: busySetters.plugins,
  });
  const [panel, setPanel] = useState(null);
  const [pluginMode, setPluginMode] = useState("installed");
  const [pluginDetail, setPluginDetail] = useState(null);
  const [agentMode, setAgentMode] = useState("installed");
  const [agentCount, setAgentCount] = useState(undefined);
  const [agentsSeen, setAgentsSeen] = useState(false);
  // null until the first plugin inventory arrives; afterwards the last known
  // value is kept while a catalog account reloads.
  const [catalogKnown, setCatalogKnown] = useState(null);
  const known = plugins.data ? Boolean(plugins.capabilities.marketplaces) : catalogKnown;
  if (known !== catalogKnown) setCatalogKnown(known);
  const supported = known === true;
  const [submitted, setSubmitted] = useState(false);
  const tabLabels = {
    skills: hub.tabSkills,
    plugins: hub.tabPlugins,
    marketplaces: hub.tabMarketplaces,
    agents: hub.tabAgents,
  };
  const tabs = workspaceTabs({
    shared: account.shared,
    marketplaces: supported,
    counts: {
      skills: ext.data?.skills.items.length,
      plugins: plugins.data?.installed.length,
      marketplaces: plugins.data?.marketplaces.length,
      agents: agentCount,
    },
  }).map((item) => ({ ...item, label: tabLabels[item.id] }));
  // A marketplaces deep link waits for the CLI's capabilities instead of
  // flashing a tab the CLI may not support.
  const { tab } = resolveWorkspaceTab(
    requestedTab,
    tabs.map((item) => item.id),
    known,
  );
  useEffect(() => {
    if (tab !== requestedTab) onTab(tab, true);
  }, [tab, requestedTab, onTab]);
  const configPath = ext.data?.mcp.path || "";
  useEffect(() => onConfigPath?.(configPath), [configPath, onConfigPath]);
  if (tab === "agents" && !agentsSeen) setAgentsSeen(true);
  const openPanel = (kind) => {
    if (kind === "skill") ext.setError("");
    setSubmitted(false);
    setPanel(kind);
  };
  const closePanel = useCallback(() => setPanel(null), []);
  const action = primaryAction({
    tab,
    tool: account.tool,
    catalogSupported: supported,
    extensionsReady: Boolean(ext.data),
    pluginsReady: Boolean(plugins.data),
    pluginInstall: Boolean(plugins.capabilities.install),
  });
  const primary = {
    label: {
      skill: commonCopy.installSkill,
      npm: profilePluginsCopy.extensionInstallHeading,
      discover: pluginCatalogCopy.catalogHeading,
      market: marketplacesCopy.addMarketplace,
      catalog: hub.browseCatalog,
    }[action.kind],
    run: {
      skill: () => openPanel("skill"),
      npm: () => openPanel("npm"),
      discover: () => {
        setPluginDetail(null);
        setPluginMode("discover");
      },
      market: () => openPanel("market"),
      catalog: () => setAgentMode("catalog"),
    }[action.kind],
    disabled: action.disabled || locked,
  };
  const groupText = {
    skills: hub.tabSkills,
    plugins:
      supported && pluginMode === "discover"
        ? pluginCatalogCopy.extensionSectionLabel
        : commonCopy.installed,
    marketplaces: hub.tabMarketplaces,
    agents: hub.tabAgents,
  }[tab];
  const groupLabel = !(tab === "plugins" && pluginDetail) && (
    <GroupLabel as="h3" action={groupAction(primary)}>
      {groupText}
    </GroupLabel>
  );
  const extPanel = panel === "skill";
  // A plugin panel shows only errors of its own submission, never an older one.
  const pluginPanel = (panel === "market" || panel === "npm") && submitted;
  const extProps = { ext, account, request, hideError: extPanel };
  return (
    <section className="extension-hub-card" aria-labelledby="extension-hub-profile">
      <header className="extension-hub-header">
        <div>
          <h2 id="extension-hub-profile">{account.name}</h2>
          <span>
            {names[account.tool] || account.tool}
            {configPath && (
              <>
                {" · "}
                <code>{configPath}</code>
              </>
            )}
          </span>
        </div>
        <div className="extension-hub-primary">
          <button
            type="button"
            className="button primary"
            disabled={primary.disabled}
            onClick={primary.run}
          >
            <Icon name="plus" size={16} />
            {primary.label}
          </button>
        </div>
      </header>
      <UnderlineTabs
        label={hub.tabs}
        tabs={tabs}
        selected={tab}
        onSelect={onTab}
        disabled={locked}
      />
      {tab !== "agents" && (
        <section
          role="tabpanel"
          id={`underline-tabpanel-${tab}`}
          aria-labelledby={`underline-tab-${tab}`}
          className="extension-tabpanel"
        >
          {groupLabel}
          {tab === "skills" && <SkillsTab {...extProps} />}
          {tab === "plugins" && (
            <PluginsTab
              plugins={plugins}
              account={account}
              mode={pluginMode}
              setMode={setPluginMode}
              catalogSupported={supported}
              hideError={pluginPanel}
              detail={pluginDetail}
              setDetail={setPluginDetail}
            />
          )}
          {tab === "marketplaces" && (
            <MarketplacesTab
              plugins={plugins}
              account={account}
              hideError={pluginPanel}
            />
          )}
          {(tab === "skills" || tab === "plugins") && (
            <McpReferenceRow
              tool={account.tool}
              count={serverCount}
              onNavigate={onNavigate}
            />
          )}
        </section>
      )}
      {account.shared && agentsSeen && (
        <section
          role="tabpanel"
          id="underline-tabpanel-agents"
          aria-labelledby="underline-tab-agents"
          className="extension-tabpanel"
          hidden={tab !== "agents"}
        >
          {tab === "agents" && groupLabel}
          <AgentsTab
            account={account}
            request={request}
            setParentBusy={busySetters.agency}
            mode={agentMode}
            setMode={setAgentMode}
            onCount={setAgentCount}
          />
        </section>
      )}
      <ExtensionPanels
        panel={panel}
        ext={ext}
        plugins={plugins}
        request={request}
        subtitle={hub.panelSubtitle(account.name)}
        submitted={submitted}
        setSubmitted={setSubmitted}
        close={closePanel}
      />
    </section>
  );
}
```

(`PluginsTab` ignores `detail`/`setDetail` until Task 5.)

- [ ] **Step 7: Page styles**

Replace `web/features/extensions/extensions-hub.css` with the content below. The block between `/* Extension tables` and `/* end extension tables */` (desktop and mobile) is today's table styling verbatim; it stays until Task 6 removes the last table.

```css
/* Extensions (settings pattern, handoff 2b + 3d): a profile column beside one card per
   CLI profile on desktop; on phones the profile switcher sits in the header subtitle. */
.extensions-page .settings-shell-content {
  max-width: 976px;
}
.extension-profiles .list-detail-caps {
  padding: 0 12px;
}
.extension-profiles .list-detail-items {
  gap: 4px;
}
.extension-profiles .list-detail-items > button {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 10px 12px;
  color: #cfd0d4;
}
.extension-profiles .list-detail-items > button:hover:not(:disabled) {
  background: #222327;
}
.extension-profiles .list-detail-items > button.selected {
  background: #26272b;
}
.extension-profile-name {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.extension-profile-name strong {
  font-size: 12px;
  font-weight: 500;
  overflow-wrap: anywhere;
}
.extension-profiles .selected .extension-profile-name strong {
  color: #ffc99d;
}
.extension-profile-name small {
  font-size: 10px;
  color: #8a8b8f;
}
.extension-profile-switch {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  padding: 0;
  border: 0;
  background: none;
  font-size: 12px;
  color: #ffc99d;
}
.extension-profile-switch span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.extension-profile-switch:disabled {
  opacity: 0.5;
}
.extension-profile-sheet .list-row-main {
  gap: 12px;
}
.extension-profile-sheet .list-row-sub code {
  font-size: 11px;
  overflow-wrap: anywhere;
}
.extension-profile-check {
  flex: none;
  margin-left: auto;
  color: #f49a58;
}
.extension-hub-card {
  min-width: 0;
  background: #16171b;
  border: 1px solid #28292d;
  border-radius: 12px;
}
.extension-hub-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 20px 22px 0;
}
.extension-hub-header > div:first-child {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.extension-hub-header h2 {
  font:
    700 17px/1.3 "Manrope",
    sans-serif;
  overflow-wrap: anywhere;
}
.extension-hub-header span {
  font-size: 12px;
  color: #92949d;
  overflow-wrap: anywhere;
}
.extension-hub-header code {
  color: #a3a4a8;
}
.extension-hub-primary .button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 40px;
  padding: 0 15px;
  font-size: 13px;
}
.extension-hub-card .underline-tabs-frame {
  margin: 14px 22px 0;
}
.extension-tabpanel {
  display: grid;
  gap: 12px;
  align-content: start;
  min-width: 0;
  padding: 14px 22px 22px;
}
.extension-tabpanel[hidden] {
  display: none;
}
.extension-tabpanel .group-label {
  margin: 0;
}
/* Desktop: the tab's primary action sits in the detail header. */
.extensions-page .group-label-action {
  display: none;
}
.extension-tabpanel .extension-confirm,
.extension-tabpanel .extension-notice,
.extension-tabpanel .extension-feedback,
.extension-tabpanel .plugin-catalog-account {
  margin: 0;
}
.extension-tabpanel .extension-profile {
  margin-bottom: 9px;
}
.extension-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.extension-toolbar:empty {
  display: none;
}
.extension-toolbar input {
  flex: 1;
  min-width: 0;
}
.extension-toolbar select {
  flex: 0 1 220px;
  min-width: 0;
}
.extension-toolbar .segment {
  flex: 0 0 auto;
  margin-left: auto;
}
.extension-hint {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  color: #9d9ea2;
  font-size: 12px;
  line-height: 1.6;
}
.extension-hint > svg {
  flex-shrink: 0;
  margin-top: 2px;
  color: #8b8c90;
}
.extension-hint > div {
  display: grid;
  gap: 8px;
  justify-items: start;
  min-width: 0;
  overflow-wrap: anywhere;
}
.extension-hint details summary {
  cursor: pointer;
  color: #cdced2;
}
.extension-hint ul {
  margin: 8px 0 0;
  padding-left: 18px;
}
/* Extension tables (until every tab uses list cards) */
/* (paste today's rules from `.extension-table {` through
   `.extension-table .extension-empty { margin: 20px 22px; }` here, unchanged) */
/* end extension tables */
.extension-panel-form .extension-fields {
  padding: 0;
  gap: 19px 18px;
}
.extension-field {
  display: flex;
  flex-direction: column;
  gap: 9px;
  min-width: 0;
  font-size: 11px;
  font-weight: 500;
  color: #cdced2;
}
.extension-field .extension-path {
  margin: 0;
  font-weight: 400;
}
.agency-filters {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 12px;
}
@media (max-width: 700px) {
  /* The settings shell brings its own 56px header with the sidebar button. */
  .app:has(.extensions-page) .mobile-header {
    display: none;
  }
  .extensions-page .settings-shell-header {
    border-bottom: 0;
  }
  .extensions-page .settings-shell-body {
    padding-top: 0;
  }
  /* Phones pick profiles from the header sheet, never from the column. */
  .extension-profiles .list-detail-list {
    display: none;
  }
  .extension-profiles.list-detail .list-detail-detail {
    display: block;
  }
  .extensions-page .group-label-action {
    display: inline-flex;
  }
  .extension-hub-header {
    display: none;
  }
  .extension-hub-card {
    background: none;
    border: 0;
    border-radius: 0;
  }
  .extension-hub-card .underline-tabs-frame {
    margin: 0 -12px;
    background: #16171b;
  }
  .extension-tabpanel {
    padding: 14px 0 0;
  }
  .extension-toolbar {
    flex-direction: column;
    align-items: stretch;
  }
  .extension-toolbar select {
    flex: none;
  }
  .extension-toolbar .segment {
    margin-left: 0;
  }
  .extension-hint {
    font-size: 11px;
    line-height: 1.7;
  }
  /* Extension tables, phones (until every tab uses list cards) */
  /* (paste today's mobile rules from `.extension-table { margin: 0; }` through
     `.extension-table .extension-empty { margin: 16px 0; padding: 16px; }` here) */
  /* end extension tables, phones */
  .extension-panel-form .extension-fields {
    grid-template-columns: minmax(0, 1fr);
  }
}
```

The two "paste" comments are instructions for this step, not file content: replace each comment pair with the exact rule blocks from the current file (desktop: `.extension-table`, `.extension-table-head, .extension-row`, `.extension-table-head`, `.extension-row`, `.extension-row:hover`, `.extension-row-main` (+ `h3`, `p`, `a`, `.extension-path`), `.extension-row-mono`, `.extension-row-tag, .extension-row-status`, `.extension-tag`, `.extension-status` (+ `i`, `.on i`), `.extension-row-actions`, `.extension-row-toggle`, `.extension-table .extension-empty`; phones: `.extension-table`, `.extension-table-head`, `.extension-row` (grid areas), `.extension-row:hover`, `.extension-row-main` (+ `h3`, `p`), `.extension-row-status`, `.extension-row-tag`, `.extension-status` (+ `i`), `.extension-row-actions`, `.extension-row.open .extension-row-actions`, `.extension-row-toggle`, `.extension-row.open .extension-row-toggle svg`, `.extension-table .extension-empty`) and keep the `/* Extension tables … */` and `/* end extension tables … */` marker comments around them. Dropped on purpose: `.extensions-hub .page-heading` (old heading), the mobile profile chips (`.extension-profiles` row layout, `.extension-profile-name small` clip, `.provider-mark.small` sizing), `.extensions-hub { padding-bottom: 100px }` and the fixed mobile `.extension-hub-primary` bar.

- [ ] **Step 8: Run the checks**

Run: `node --test tests/unit/i18n-catalogs.test.js tests/unit/i18n.test.js tests/unit/extension-workspace-model.test.js`
Expected: PASS.

Run: `npm run build && npx playwright test tests/browser/extensions.spec.js tests/browser/shared-agency.spec.js tests/browser/plugins.spec.js tests/browser/codex-marketplace.spec.js tests/browser/i18n-plugins-providers.spec.js tests/browser/navigation.spec.js`
Expected: PASS. On phones the group-label action ("Skill installieren", "npm-Plugin hinzufügen", "Katalog durchsuchen") is the only visible primary; on desktop the header button is.

- [ ] **Step 9: Commit**

```bash
npx prettier --write web/features/extensions web/app/App.jsx web/lib/i18n/de/extensions.js web/lib/i18n/en/extensions.js tests/helpers/extensions.js tests/browser/extensions.spec.js tests/browser/shared-agency.spec.js
npx eslint web/features/extensions web/app/App.jsx tests/helpers/extensions.js tests/browser/extensions.spec.js tests/browser/shared-agency.spec.js
git add -A web/features/extensions web/app/App.jsx web/lib/i18n tests/helpers/extensions.js tests/browser
git commit -m "feat: move extensions into the settings shell with a profile sheet on phones" -m "The tab's primary action sits on the group label on phones and in the detail header on desktop; the profile switcher lives in the header subtitle and locks with the tabs." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Skills as a list card with ⓘ

Skills render as list rows (description, scope · state, path, trash button). The Codex scope note moves behind ⓘ on the Skills label; the server's skills note, the sharing import and the conflict list stay visible.

**Files:**

- Create: `web/features/extensions/ExtensionHint.jsx`, `web/features/extensions/RowLines.jsx`
- Modify: `web/features/extensions/ExtensionTable.jsx` (re-export `ExtensionHint`), `SkillsTab.jsx`, `ExtensionsFrame.jsx`, `ExtensionWorkspace.jsx` (group-label hint), `extensions-hub.css`, `web/lib/i18n/{de,en}/extensions.js` (`extensionsLoading`)
- Test: `tests/helpers/extensions.js` (`extensionRow`), `tests/browser/extensions.spec.js`

**Interfaces:**

- Consumes: Step 0 `ListCard`, `ListRow({ label, sub, onDelete, deleteLabel, disabled })`, `GroupLabel({ hint })`, `commonCopy.showHint` ("Hinweis anzeigen").
- Produces:
  - `ExtensionHint({ children, className })` default export of `ExtensionHint.jsx` (still re-exported by `ExtensionTable.jsx` until Task 6).
  - `RowLines({ lines })` — renders each non-empty line as `<span class="row-line">`.
  - `.extension-list` list cards; rows are `.list-row` with `.list-row-label`.
  - Test helper `extensionRow(scope, name) => Locator` (row whose label is exactly `name`).

- [ ] **Step 1: Point the skills spec at rows and the ⓘ (failing first)**

Add to `tests/helpers/extensions.js`:

```js
const exactText = (text) =>
  new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);

// A list row by its exact label; `scope` is the page or a locator inside it.
export function extensionRow(scope, name) {
  const page = typeof scope.page === "function" ? scope.page() : scope;
  return scope
    .locator(".list-row")
    .filter({ has: page.locator(".list-row-label", { hasText: exactText(name) }) });
}
```

`tests/browser/extensions.spec.js` (add `extensionRow` to the helper import):

- Skill upload test: replace

```js
await expect(
  page.getByText(
    "Codex-Skills werden im Benutzerordner geteilt und gelten für alle Codex-Profile.",
    { exact: true },
  ),
).toBeVisible();
```

with

```js
await page.getByRole("button", { name: "Hinweis anzeigen", exact: true }).click();
await expect(
  page.getByText(
    "Codex-Skills werden im Benutzerordner geteilt und gelten für alle Codex-Profile.",
    { exact: true },
  ),
).toBeVisible();
```

and replace every `page.getByRole("heading", { name: "demo-skill", exact: true })` with `extensionRow(page, "demo-skill")`. Replace `await revealRow(page, "demo-skill");` with `await expect(extensionRow(page, "demo-skill")).toBeVisible();` and drop `revealRow` from the import if unused.

- Pagination test: replace `section.locator("article.extension-row")` (four times) with `section.locator(".extension-list .list-row")`, and every `section.getByRole("heading", { name: "skill-NN", exact: true })` with `extensionRow(section, "skill-NN")` (same NN).

Run: `npm run build && npx playwright test tests/browser/extensions.spec.js`
Expected: FAIL (`Hinweis anzeigen` not found; no `.list-row` rows).

- [ ] **Step 2: Implement**

Create `web/features/extensions/ExtensionHint.jsx` (moved verbatim from `ExtensionTable.jsx`):

```jsx
import React from "react";
import Icon from "../../components/Icon.jsx";

export default function ExtensionHint({ children, className = "" }) {
  return (
    <div className={["extension-hint", className].filter(Boolean).join(" ")}>
      <Icon name="info" size={15} aria-hidden="true" />
      <div>{children}</div>
    </div>
  );
}
```

In `web/features/extensions/ExtensionTable.jsx` delete the `export function ExtensionHint …` block and add at the end:

```js
export { default as ExtensionHint } from "./ExtensionHint.jsx";
```

Create `web/features/extensions/RowLines.jsx`:

```jsx
import React from "react";

// Lines under a row label (description, scope · state, path); empty lines are left out.
// Elements passed in `lines` carry a key anyway (react-x/no-missing-key checks array
// literals); the wrapping spans are keyed by position.
export default function RowLines({ lines }) {
  return lines
    .filter(
      (line) => line !== null && line !== undefined && line !== false && line !== "",
    )
    .map((line, index) => (
      <span key={index} className="row-line">
        {line}
      </span>
    ));
}
```

Replace `web/features/extensions/SkillsTab.jsx` with:

```jsx
import React from "react";
import ListCard from "../../components/ListCard.jsx";
import ListRow from "../../components/ListRow.jsx";
import { Pagination } from "../../components/Pagination.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import {
  extensionsHubCopy as hub,
  profileExtensionsCopy as copy,
} from "../../lib/i18n/messages/extensions.js";
import ExtensionHint from "./ExtensionHint.jsx";
import ExtensionsFrame from "./ExtensionsFrame.jsx";
import RowLines from "./RowLines.jsx";

export default function SkillsTab({ ext, account, request, hideError }) {
  const { data, busy, setConfirm, skillQuery, setSkillQuery, skillPaging, skillSearch } =
    ext;
  return (
    <ExtensionsFrame {...{ ext, account, request, hideError }}>
      <div className="extension-toolbar">
        <input
          type="search"
          aria-label={commonCopy.searchSkills}
          value={skillQuery}
          onChange={(event) => setSkillQuery(event.target.value)}
          placeholder={copy.extensionSectionPlaceholder}
        />
      </div>
      {data?.skills.note && (
        <ExtensionHint>
          <p>{data.skills.note}</p>
        </ExtensionHint>
      )}
      {skillPaging.items.length ? (
        <ListCard label={copy.skillsHeading} className="extension-list">
          {skillPaging.items.map((skill) => (
            <ListRow
              key={skill.id}
              label={skill.name}
              sub={
                <RowLines
                  lines={[
                    skill.description,
                    `${skill.scope} · ${skill.removable ? hub.installedHere : hub.readOnly}`,
                    <code key="path" className="extension-path">
                      {skill.path}
                    </code>,
                  ]}
                />
              }
              onDelete={
                skill.removable
                  ? () => setConfirm({ kind: "skill", id: skill.id, name: skill.name })
                  : undefined
              }
              deleteLabel={commonCopy.removeSkillLabel(skill.name)}
              disabled={Boolean(busy)}
            />
          ))}
        </ListCard>
      ) : (
        <p className="extension-empty">
          {skillSearch ? copy.noMatchingSkills : copy.noSkills}
        </p>
      )}
      <Pagination paging={skillPaging} label={copy.skillsHeading} />
    </ExtensionsFrame>
  );
}
```

In `web/features/extensions/ExtensionsFrame.jsx` replace `import { ExtensionHint } from "./ExtensionTable.jsx";` with `import ExtensionHint from "./ExtensionHint.jsx";` and the comment line `// Loading, sharing, feedback and removal confirmation for the MCP and Skills tabs,` with `// Loading, sharing, feedback and removal confirmation for the Skills tab,`.

In `web/features/extensions/ExtensionWorkspace.jsx` import `profileExtensionsCopy` from `../../lib/i18n/messages/extensions.js` (next to `extensionsHubCopy as hub`) and change the group label to:

```jsx
const groupLabel = !(tab === "plugins" && pluginDetail) && (
  <GroupLabel
    as="h3"
    hint={
      tab === "skills" && account.tool === "codex"
        ? profileExtensionsCopy.extensionScopeNote
        : undefined
    }
    action={groupAction(primary)}
  >
    {groupText}
  </GroupLabel>
);
```

Copy: `web/lib/i18n/de/extensions.js` → `extensionsLoading: "Skills werden geladen …",`; `web/lib/i18n/en/extensions.js` → `extensionsLoading: "Loading skills …",`.

Append to `web/features/extensions/extensions-hub.css` (before the `@media` block):

```css
.extension-list .row-line {
  display: block;
}
.extension-list .row-line + .row-line {
  margin-top: 3px;
}
.extension-list .extension-path {
  margin: 0;
}
.extension-list .list-row > .button {
  flex: none;
  margin-right: 8px;
}
```

- [ ] **Step 3: Run the checks**

Run: `node --test tests/unit/i18n-catalogs.test.js`
Expected: PASS.

Run: `npm run build && npx playwright test tests/browser/extensions.spec.js tests/browser/shared-agency.spec.js tests/browser/navigation.spec.js`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
npx prettier --write web/features/extensions web/lib/i18n/de/extensions.js web/lib/i18n/en/extensions.js tests/helpers/extensions.js tests/browser/extensions.spec.js
npx eslint web/features/extensions tests/helpers/extensions.js tests/browser/extensions.spec.js
git add -A web/features/extensions web/lib/i18n tests/helpers/extensions.js tests/browser/extensions.spec.js
git commit -m "feat: list skills as rows with the Codex scope note behind an info hint" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Plugin rows, ⋯ menu and plugin detail

Installed plugins become rows (name, scope · marketplace · version, description, "Aktiv"/"Deaktiviert"). Desktop: ⋯ menu with Details, enable/disable, update, remove. Phones: the row opens a detail view with version, source, status, path and the same actions. Catalog rows keep their install button.

**Files:**

- Create: `web/features/extensions/RowMenu.jsx`, `web/features/plugins/plugin-actions.js`, `web/features/plugins/PluginRow.jsx`, `web/features/plugins/PluginDetail.jsx`
- Modify: `web/features/plugins/PluginsTab.jsx`, `InstalledPlugins.jsx`, `PluginCatalog.jsx`, `web/features/extensions/extensions-hub.css`, `web/lib/i18n/{de,en}/extensions.js`
- Test: `tests/helpers/extensions.js` (`rowMenuItem`); browser `tests/browser/plugins.spec.js`, `tests/browser/codex-marketplace.spec.js`

**Interfaces:**

- Consumes: Task 1 `pluginStatus`, `pluginActionKinds`, `pluginKey`; Task 3 `detail`/`setDetail` props; Task 4 `RowLines`, `extensionRow`; Step 0 `ListRow({ menu: { label, onClick(event), expanded } })`, `Segmented`.
- Produces:
  - `useRowMenu() => { open, position, trigger, close(restore = true), toggle(event) }`; `RowMenu({ label, state, items: [{ id, label, ariaLabel?, disabled?, danger?, restoreFocus?, run() }] })` — `role="menu"` popover, fixed to the viewport.
  - `pluginActions(plugin, { capabilities, mutate, setConfirm }) => [{ id: "toggle" | "update" | "remove", label, ariaLabel, danger?, restoreFocus?, run }]`.
  - `PluginRow({ plugin, capabilities, disabled, mutate, setConfirm, onDetails(key) })` (key = `pluginKey(plugin)`); `PluginDetail({ plugin, capabilities, disabled, mutate, setConfirm, onBack })`.
  - `PluginsTab` props add `detail`, `setDetail`.
  - Copy (`extensionsHubCopy`): `pluginActive`, `pluginDisabled`, `pluginDetails`, `pluginDetailsLabel(name)`, `backToPlugins`, `path`.
  - Test helper `rowMenuItem(page, row, name) => Promise<Locator>` (opens the row's ⋯ menu when the item is not visible).

- [ ] **Step 1: Point the plugin specs at rows and menus (failing first)**

Add to `tests/helpers/extensions.js`:

```js
// Desktop rows keep their actions in a ⋯ menu; open it when the item is not shown yet.
export async function rowMenuItem(page, row, name) {
  const item = page.getByRole("menuitem", { name, exact: true });
  if (!(await item.isVisible()))
    await extensionRow(page, row)
      .getByRole("button", { name: /^(Aktionen für|Actions for) / })
      .click();
  return item;
}
```

`tests/browser/plugins.spec.js` (add `extensionRow, rowMenuItem` to the helper import):

- First test: replace `await expect(page.getByRole("heading", { name: "Demo", exact: true })).toBeVisible();` with `await expect(extensionRow(page, "Demo")).toBeVisible();`, and replace

```js
await expect(
  page.getByRole("button", { name: "Plugin Demo deaktivieren" }),
).toBeVisible();
await page.getByRole("button", { name: "Plugin Demo deaktivieren" }).click();
await expect(page.getByRole("button", { name: "Plugin Demo aktivieren" })).toBeVisible();
await page.getByRole("button", { name: "Plugin Demo entfernen" }).click();
```

with

```js
await expect(await rowMenuItem(page, "Demo", "Plugin Demo deaktivieren")).toBeVisible();
await (await rowMenuItem(page, "Demo", "Plugin Demo deaktivieren")).click();
await expect(await rowMenuItem(page, "Demo", "Plugin Demo aktivieren")).toBeVisible();
await (await rowMenuItem(page, "Demo", "Plugin Demo entfernen")).click();
```

- OpenCode test: replace `page.getByRole("heading", { name: "Demo", exact: true })` with `extensionRow(page, "Demo")`.
- "marketplace removal …" test: replace `page.getByRole("heading", { name: "Remaining plugin", exact: true })` with `extensionRow(page, "Remaining plugin")`.
- "installed plugin pagination …" test: replace

```js
await expect(
  page.getByRole("button", { name: /Plugin Installed .* entfernen/ }),
).toHaveCount(20);
```

with `await expect(page.locator(".extension-list .plugin-row")).toHaveCount(20);` and every `page.getByRole("heading", { name: "Installed NN", exact: true })` with `extensionRow(page, "Installed NN")` (same NN).

`tests/browser/codex-marketplace.spec.js` (add `extensionRow` to the helper import): replace `const remove = page.getByRole("button", { name: "Plugin Remote Demo entfernen" });` with `const remove = extensionRow(page, "Remote Demo");` (it is only asserted in the installed view, where the row exists exactly when the removable plugin is installed).

Run: `npm run build && npx playwright test tests/browser/plugins.spec.js`
Expected: FAIL (no ⋯ menu, no `.plugin-row`).

- [ ] **Step 2: Copy**

`web/lib/i18n/de/extensions.js`, add to `extensionsHubCopy`:

```js
  pluginActive: "Aktiv",
  pluginDisabled: "Deaktiviert",
  pluginDetails: "Details",
  pluginDetailsLabel: (name) => `Details zu ${name}`,
  backToPlugins: "Zurück zu Plugins",
  path: "Pfad",
```

`web/lib/i18n/en/extensions.js`, add to `extensionsHubCopy`:

```js
  pluginActive: "Active",
  pluginDisabled: "Disabled",
  pluginDetails: "Details",
  pluginDetailsLabel: (name) => `Details for ${name}`,
  backToPlugins: "Back to plugins",
  path: "Path",
```

- [ ] **Step 3: The row menu**

Create `web/features/extensions/RowMenu.jsx`:

```jsx
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

// ⋯ menus of list rows. List cards clip their rows, so the popover is fixed to the
// viewport under its trigger (above it when there is no room below); it closes on
// outside press, scroll, resize and Escape.
export function useRowMenu() {
  const [position, setPosition] = useState(null);
  const trigger = useRef(null);
  const close = useCallback((restore = true) => {
    setPosition(null);
    if (restore) queueMicrotask(() => trigger.current?.focus());
  }, []);
  const toggle = useCallback((event) => {
    trigger.current = event.currentTarget;
    const rect = event.currentTarget.getBoundingClientRect();
    setPosition((open) =>
      open
        ? null
        : { top: rect.bottom + 4, right: Math.max(8, window.innerWidth - rect.right) },
    );
  }, []);
  return { open: position !== null, position, trigger, close, toggle };
}

const enabledItems = (menu) => [
  ...menu.querySelectorAll("[role='menuitem']:not(:disabled)"),
];

export function RowMenu({ label, state, items }) {
  const menu = useRef(null);
  const { open, close, trigger, position } = state;
  // Near the bottom edge the menu opens above its trigger, never below the viewport.
  useLayoutEffect(() => {
    const node = menu.current;
    const anchor = trigger.current?.getBoundingClientRect();
    if (!open || !node || !anchor) return;
    const { height } = node.getBoundingClientRect();
    if (position.top + height > window.innerHeight - 8)
      node.style.top = `${Math.max(8, anchor.top - height - 4)}px`;
  }, [open, position, trigger]);
  useEffect(() => {
    if (!open) return undefined;
    enabledItems(menu.current)[0]?.focus({ preventScroll: true });
    const outside = (event) => {
      if (
        !menu.current?.contains(event.target) &&
        !trigger.current?.contains(event.target)
      )
        close(false);
    };
    const dismiss = (event) => {
      if (!(event.target instanceof Node) || !menu.current?.contains(event.target))
        close(false);
    };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [open, close, trigger]);
  if (!open) return null;
  return (
    <div
      role="menu"
      ref={menu}
      aria-label={label}
      className="row-menu"
      style={{ top: position.top, right: position.right }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          close();
          return;
        }
        if (event.key === "Tab") {
          close(false);
          return;
        }
        const controls = enabledItems(event.currentTarget);
        const index = controls.indexOf(document.activeElement);
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? controls.length - 1
              : event.key === "ArrowDown"
                ? (index + 1) % controls.length
                : event.key === "ArrowUp"
                  ? (index - 1 + controls.length) % controls.length
                  : null;
        if (next !== null) {
          event.preventDefault();
          controls[next]?.focus();
        }
      }}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          aria-label={item.ariaLabel}
          className={item.danger ? "danger" : undefined}
          disabled={item.disabled}
          onClick={() => {
            close(item.restoreFocus !== false);
            item.run();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Plugin actions, row, detail**

Create `web/features/plugins/plugin-actions.js`:

```js
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { installedPluginsCopy as copy } from "../../lib/i18n/messages/plugins.js";
import { pluginActionKinds } from "./plugin-state.js";

/** The plugin's immediate actions, shared by the ⋯ menu and the detail view. */
export function pluginActions(plugin, { capabilities, mutate, setConfirm }) {
  const enabling = plugin.enabled === false;
  const actions = {
    toggle: {
      id: "toggle",
      label: enabling ? commonCopy.enable : commonCopy.disable,
      ariaLabel: commonCopy.togglePluginLabel(
        plugin.name,
        enabling ? commonCopy.enableAction : commonCopy.disableAction,
      ),
      run: () =>
        mutate(
          { action: enabling ? "enable" : "disable", pluginId: plugin.id },
          copy.toggleNotice(
            plugin.name,
            enabling ? commonCopy.enabledResult : commonCopy.disabledResult,
          ),
        ),
    },
    update: {
      id: "update",
      label: commonCopy.refresh,
      ariaLabel: commonCopy.updatePluginLabel(plugin.name),
      run: () =>
        mutate(
          { action: "update", pluginId: plugin.id },
          copy.updatedNotice(plugin.name),
        ),
    },
    remove: {
      id: "remove",
      label: commonCopy.remove,
      ariaLabel: commonCopy.removePluginLabel(plugin.name),
      danger: true,
      // The removal confirmation takes focus (PluginFrame).
      restoreFocus: false,
      run: () =>
        setConfirm({
          action: "remove",
          name: plugin.name,
          body: { action: "remove", pluginId: plugin.id },
        }),
    },
  };
  return pluginActionKinds(plugin, capabilities).map((kind) => actions[kind]);
}
```

Create `web/features/plugins/PluginRow.jsx`:

```jsx
import React from "react";
import ListRow from "../../components/ListRow.jsx";
import { extensionsHubCopy as hub } from "../../lib/i18n/messages/extensions.js";
import { installedPluginsCopy as copy } from "../../lib/i18n/messages/plugins.js";
import RowLines from "../extensions/RowLines.jsx";
import { RowMenu, useRowMenu } from "../extensions/RowMenu.jsx";
import { pluginActions } from "./plugin-actions.js";
import { pluginKey, pluginStatus } from "./plugin-state.js";

export const pluginMeta = (plugin) =>
  [plugin.scope, plugin.marketplace, plugin.version || copy.extensionScope]
    .filter(Boolean)
    .join(" · ");

// Phones: the row opens the detail view (chevron). Desktop: the ⋯ menu carries
// Details and the actions; a row click opens the details as well.
export default function PluginRow({
  plugin,
  capabilities,
  disabled,
  mutate,
  setConfirm,
  onDetails,
}) {
  const menu = useRowMenu();
  const status = pluginStatus(plugin);
  const label = hub.rowActions(plugin.name);
  const items = [
    {
      id: "details",
      label: hub.pluginDetails,
      ariaLabel: hub.pluginDetailsLabel(plugin.name),
      restoreFocus: false,
      run: () => onDetails(pluginKey(plugin)),
    },
    ...pluginActions(plugin, { capabilities, mutate, setConfirm }).map((action) => ({
      ...action,
      disabled,
    })),
  ];
  return (
    <div className="row-menu-anchor plugin-row">
      <ListRow
        label={plugin.name}
        sub={<RowLines lines={[plugin.description, pluginMeta(plugin)]} />}
        status={status === "enabled" ? { tone: "ok", text: hub.pluginActive } : undefined}
        value={status === "disabled" ? hub.pluginDisabled : undefined}
        onClick={() => onDetails(pluginKey(plugin))}
        menu={{ label, expanded: menu.open, onClick: menu.toggle }}
      />
      <RowMenu label={label} state={menu} items={items} />
    </div>
  );
}
```

Create `web/features/plugins/PluginDetail.jsx`:

```jsx
import React, { useEffect, useRef } from "react";
import Icon from "../../components/Icon.jsx";
import ListCard from "../../components/ListCard.jsx";
import ListRow, { unknownValue } from "../../components/ListRow.jsx";
import { extensionsHubCopy as hub } from "../../lib/i18n/messages/extensions.js";
import { installedPluginsCopy as copy } from "../../lib/i18n/messages/plugins.js";
import { pluginActions } from "./plugin-actions.js";
import { pluginStatus } from "./plugin-state.js";

// The plugin subpage: version, source, state, path and the immediate actions.
export default function PluginDetail({
  plugin,
  capabilities,
  disabled,
  mutate,
  setConfirm,
  onBack,
}) {
  const heading = useRef(null);
  useEffect(() => heading.current?.focus({ preventScroll: true }), []);
  const status = pluginStatus(plugin);
  const actions = pluginActions(plugin, { capabilities, mutate, setConfirm });
  return (
    <div className="plugin-detail">
      <div className="plugin-detail-head">
        <button
          type="button"
          className="list-row-icon-button"
          aria-label={hub.backToPlugins}
          onClick={onBack}
        >
          <Icon name="back" />
        </button>
        <h3 ref={heading} tabIndex={-1}>
          {plugin.name}
        </h3>
      </div>
      {plugin.description && (
        <p className="plugin-detail-description">{plugin.description}</p>
      )}
      <ListCard label={plugin.name} className="extension-list">
        <ListRow label={hub.headVersion} value={plugin.version || copy.extensionScope} />
        <ListRow
          label={hub.headSource}
          value={
            [plugin.scope, plugin.marketplace].filter(Boolean).join(" · ") || unknownValue
          }
        />
        {status !== "unknown" && (
          <ListRow
            label={hub.headStatus}
            status={
              status === "enabled" ? { tone: "ok", text: hub.pluginActive } : undefined
            }
            value={status === "disabled" ? hub.pluginDisabled : undefined}
          />
        )}
        {plugin.path && (
          <ListRow
            label={hub.path}
            sub={<code className="extension-path">{plugin.path}</code>}
          />
        )}
      </ListCard>
      {actions.length > 0 && (
        <div className="plugin-detail-actions">
          {actions.map((action) => (
            <button
              key={action.id}
              type="button"
              className={`button ${action.danger ? "danger" : "secondary"}`}
              aria-label={action.ariaLabel}
              disabled={disabled}
              onClick={action.run}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Lists and the tab**

Replace `web/features/plugins/InstalledPlugins.jsx` with:

```jsx
import React from "react";
import ListCard from "../../components/ListCard.jsx";
import { Pagination } from "../../components/Pagination.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { installedPluginsCopy as copy } from "../../lib/i18n/messages/plugins.js";
import PluginRow from "./PluginRow.jsx";

export default function InstalledPlugins({
  installed,
  installedQuery,
  installedPages,
  capabilities,
  disabled,
  mutate,
  setConfirm,
  onDetails,
}) {
  const items = installed.length ? installedPages.items : [];
  return (
    <>
      {items.length ? (
        <ListCard label={copy.installedPluginsHeading} className="extension-list">
          {items.map((plugin, index) => (
            <PluginRow
              key={`${plugin.id}-${index}`}
              plugin={plugin}
              {...{ capabilities, disabled, mutate, setConfirm, onDetails }}
            />
          ))}
        </ListCard>
      ) : (
        <p className="extension-empty">
          {installedQuery ? copy.extensionEmpty : commonCopy.noInstalledPlugins}
        </p>
      )}
      <Pagination paging={installedPages} label={copy.installedPluginsHeading} />
    </>
  );
}
```

Replace `web/features/plugins/PluginCatalog.jsx` with:

```jsx
import React from "react";
import ListCard from "../../components/ListCard.jsx";
import ListRow from "../../components/ListRow.jsx";
import { Pagination } from "../../components/Pagination.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { extensionsHubCopy as hub } from "../../lib/i18n/messages/extensions.js";
import { pluginCatalogCopy as copy } from "../../lib/i18n/messages/plugins.js";
import RowLines from "../extensions/RowLines.jsx";
import { marketplaceLabel } from "./marketplace-label.js";

export default function PluginCatalog({
  catalog,
  data,
  catalogPages,
  disabled,
  capabilities,
  mutate,
}) {
  const items = catalog.length ? catalogPages.items : [];
  return (
    <>
      {items.length ? (
        <ListCard label={copy.extensionSectionLabel} className="extension-list">
          {items.map((plugin) => (
            <ListRow
              key={plugin.id}
              label={plugin.name}
              sub={
                <RowLines
                  lines={[
                    plugin.description,
                    marketplaceLabel(
                      data.marketplaces.find(
                        (item) => item.name === plugin.marketplace,
                      ) || {
                        name: plugin.marketplace,
                      },
                    ),
                  ]}
                />
              }
              status={
                plugin.installed ? { tone: "ok", text: commonCopy.installed } : undefined
              }
              value={plugin.installed ? undefined : hub.available}
            >
              <button
                type="button"
                className="button primary compact"
                disabled={disabled || plugin.installed || !capabilities.install}
                aria-label={commonCopy.installPluginLabel(plugin.name)}
                onClick={() =>
                  mutate(
                    { action: "install", pluginId: plugin.id },
                    copy.buttonOnClick(plugin.name),
                  )
                }
              >
                {plugin.installed ? commonCopy.installed : commonCopy.install}
              </button>
            </ListRow>
          ))}
        </ListCard>
      ) : (
        <p className="extension-empty">{copy.extensionEmpty}</p>
      )}
      <Pagination paging={catalogPages} label={copy.extensionSectionLabel} />
    </>
  );
}
```

Replace `web/features/plugins/PluginsTab.jsx` with:

```jsx
import React, { useEffect } from "react";
import { unknownValue } from "../../components/ListRow.jsx";
import Segmented from "../../components/Segmented.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { extensionsHubCopy as hub } from "../../lib/i18n/messages/extensions.js";
import {
  installedPluginsCopy,
  pluginCatalogCopy,
} from "../../lib/i18n/messages/plugins.js";
import CatalogAccount from "./CatalogAccount.jsx";
import InstalledPlugins from "./InstalledPlugins.jsx";
import { marketplaceLabel } from "./marketplace-label.js";
import PluginCatalog from "./PluginCatalog.jsx";
import PluginDetail from "./PluginDetail.jsx";
import PluginFrame from "./PluginFrame.jsx";
import { pluginKey } from "./plugin-state.js";

export default function PluginsTab({
  plugins,
  account,
  mode,
  setMode,
  catalogSupported,
  hideError,
  detail,
  setDetail,
}) {
  const { data, capabilities, disabled, mutate, setConfirm } = plugins;
  const discover = catalogSupported && mode === "discover";
  const selected = detail
    ? (data?.installed || []).find((plugin) => pluginKey(plugin) === detail)
    : null;
  // A plugin that left the inventory (removed, reloaded, other catalog account)
  // closes its detail view instead of offering actions for something gone.
  useEffect(() => {
    if (detail && data && !selected) setDetail(null);
  }, [detail, data, selected, setDetail]);
  return (
    <>
      {!selected && (
        <div className="extension-toolbar">
          {data &&
            (discover ? (
              <>
                <input
                  type="search"
                  aria-label={pluginCatalogCopy.searchPlugins}
                  value={plugins.query}
                  onChange={(e) => plugins.setQuery(e.target.value)}
                  placeholder={commonCopy.searchDescription}
                />
                <select
                  aria-label={pluginCatalogCopy.filterMarketplace}
                  value={plugins.market}
                  onChange={(e) => plugins.setMarket(e.target.value)}
                >
                  <option value="">{pluginCatalogCopy.extensionFieldsOption}</option>
                  {data.marketplaces.map((m) => (
                    <option key={m.name} value={m.name}>
                      {marketplaceLabel(m)}
                    </option>
                  ))}
                </select>
              </>
            ) : (
              <input
                type="search"
                aria-label={installedPluginsCopy.pluginListSearch}
                value={plugins.installedQuery}
                onChange={(e) => plugins.setInstalledQuery(e.target.value)}
                placeholder={commonCopy.searchDescription}
              />
            ))}
          {catalogSupported && (
            <Segmented
              label={hub.viewLabel}
              className="extension-mode"
              value={discover ? "discover" : "installed"}
              onChange={setMode}
              options={[
                {
                  value: "installed",
                  // "—" until the inventory is known, never a made-up 0.
                  label: hub.installedView(
                    data ? (data.installed || []).length : unknownValue,
                  ),
                },
                {
                  value: "discover",
                  label: hub.discoverView(
                    data ? (data.catalog || []).length : unknownValue,
                  ),
                },
              ]}
            />
          )}
        </div>
      )}
      <PluginFrame
        plugins={plugins}
        hideError={hideError}
        before={<CatalogAccount plugins={plugins} account={account} />}
      >
        {selected ? (
          <PluginDetail
            plugin={selected}
            {...{ capabilities, disabled, mutate, setConfirm }}
            onBack={() => setDetail(null)}
          />
        ) : discover ? (
          <PluginCatalog
            catalog={plugins.catalog}
            data={data}
            catalogPages={plugins.catalogPages}
            {...{ disabled, capabilities, mutate }}
          />
        ) : (
          <InstalledPlugins
            installed={plugins.installed}
            installedQuery={plugins.installedQuery}
            installedPages={plugins.installedPages}
            {...{ capabilities, disabled, mutate, setConfirm }}
            onDetails={setDetail}
          />
        )}
      </PluginFrame>
    </>
  );
}
```

Append to `web/features/extensions/extensions-hub.css` (before the `@media` block):

```css
.row-menu-anchor {
  position: relative;
}
.row-menu {
  position: fixed;
  z-index: 80;
  display: grid;
  min-width: 200px;
  padding: 4px;
  border: 1px solid #303137;
  border-radius: 10px;
  background: #1b1c20;
  box-shadow: 0 14px 34px rgb(0 0 0 / 36%);
}
.row-menu > button {
  min-height: 40px;
  padding: 0 12px;
  border-radius: 7px;
  font-size: 13px;
  text-align: left;
  color: #e8e8ec;
}
.row-menu > button:hover:not(:disabled),
.row-menu > button:focus-visible {
  background: #26272b;
}
.row-menu > button.danger {
  color: #e7a3a3;
}
.row-menu > button:disabled {
  opacity: 0.5;
}
/* Desktop opens plugin actions from ⋯; the chevron is the phone affordance. */
.plugin-row .list-row-chevron {
  display: none;
}
.plugin-detail {
  display: grid;
  gap: 12px;
  min-width: 0;
}
.plugin-detail-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.plugin-detail-head h3 {
  font-size: 15px;
  font-weight: 600;
  overflow-wrap: anywhere;
}
.plugin-detail-description {
  font-size: 13px;
  line-height: 1.5;
  color: #a2a3a7;
}
.plugin-detail-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.plugin-detail-actions .button {
  height: 40px;
}
```

and inside the `@media (max-width: 700px)` block add:

```css
.plugin-row .list-row-chevron {
  display: inline-block;
}
.plugin-row .list-row-icon-button[aria-haspopup="menu"] {
  display: none;
}
.plugin-detail-actions .button {
  flex: 1;
}
```

- [ ] **Step 6: Run the checks**

Run: `node --test tests/unit/i18n-catalogs.test.js tests/unit/extension-workspace-model.test.js`
Expected: PASS.

Run: `npm run build && npx playwright test tests/browser/plugins.spec.js tests/browser/codex-marketplace.spec.js tests/browser/i18n-plugins-providers.spec.js tests/browser/extensions.spec.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
npx prettier --write web/features/extensions web/features/plugins web/lib/i18n/de/extensions.js web/lib/i18n/en/extensions.js tests/helpers/extensions.js tests/browser/plugins.spec.js tests/browser/codex-marketplace.spec.js
npx eslint web/features/extensions web/features/plugins tests/helpers/extensions.js tests/browser/plugins.spec.js tests/browser/codex-marketplace.spec.js
git add -A web/features/extensions web/features/plugins web/lib/i18n tests/helpers/extensions.js tests/browser
git commit -m "feat: list plugins as rows with a menu on desktop and a detail view on phones" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Marketplace and Agency rows, tables removed

Marketplaces and Agency agents become list rows; custom marketplaces get the ⋯ menu (update, remove); the last tables and their CSS and copy go.

**Files:**

- Modify: `web/features/plugins/Marketplaces.jsx`, `web/features/plugins/PluginFrame.jsx`, `web/features/plugins/CatalogAccount.jsx`, `web/features/agency/AgentsTab.jsx`, `web/features/extensions/extensions-hub.css`, `web/lib/i18n/{de,en}/extensions.js`
- Delete: `web/features/extensions/ExtensionTable.jsx`
- Test: `tests/helpers/extensions.js` (`revealRow`); browser `tests/browser/plugins.spec.js`, `codex-marketplace.spec.js`, `i18n-plugins-providers.spec.js`, `shared-agency.spec.js`

**Interfaces:**

- Consumes: Task 4 `ExtensionHint`, `RowLines`, `extensionRow`; Task 5 `useRowMenu`, `RowMenu`, `rowMenuItem`.
- Produces: no `ExtensionTable`; `revealRow(page, row)` only waits for the row; copy keys `headSkill`, `headScope`, `headType`, `headPlugin`, `headMarketplace`, `headAgent` removed (`headStatus`, `headSource`, `headVersion` stay for the plugin detail).

- [ ] **Step 1: Point the specs at rows (failing first)**

`tests/helpers/extensions.js`: replace `revealRow` with:

```js
// Rows show their actions directly; wait until the row is there.
export async function revealRow(page, row) {
  await expect(extensionRow(page, row)).toBeVisible();
}
```

`tests/browser/plugins.spec.js`:

- Replace `page.getByRole("heading", { name: "demo-market", exact: true })` with `extensionRow(page, "demo-market")`.
- "marketplace removal …": replace `await page.getByRole("button", { name: "Marketplace A entfernen" }).click();` with `await (await rowMenuItem(page, "A", "Marketplace A entfernen")).click();` and `page.getByRole("heading", { name: "A", exact: true })` with `extensionRow(page, "A")`.
- "an earlier plugin error …": replace `await page.getByRole("button", { name: "Marketplace A aktualisieren" }).click();` with `await (await rowMenuItem(page, "A", "Marketplace A aktualisieren")).click();`.

`tests/browser/codex-marketplace.spec.js`: replace

```js
const market = page.getByRole("article").filter({
  has: page.getByRole("heading", { name: "Codex-Standard-Marketplace", exact: true }),
});
```

with `const market = extensionRow(page, "Codex-Standard-Marketplace");` and the later `page.getByRole("heading", { name: "Codex-Standard-Marketplace", exact: true })` with `extensionRow(page, "Codex-Standard-Marketplace")`.

`tests/browser/i18n-plugins-providers.spec.js` (import `extensionRow` from `../helpers/extensions.js`): replace `page.getByRole("heading", { name: "Codex default marketplace", exact: true })` with `extensionRow(page, "Codex default marketplace")`.

`tests/browser/shared-agency.spec.js` (add `extensionRow` to the import): replace `page.getByRole("heading", { name: "frontend", exact: true })` with `extensionRow(page, "frontend")`.

Run: `npm run build && npx playwright test tests/browser/plugins.spec.js tests/browser/shared-agency.spec.js`
Expected: FAIL (marketplace and agent rows are still tables).

- [ ] **Step 2: Marketplaces**

Replace `web/features/plugins/Marketplaces.jsx` with:

```jsx
import React from "react";
import ListCard from "../../components/ListCard.jsx";
import ListRow from "../../components/ListRow.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { extensionsHubCopy as hub } from "../../lib/i18n/messages/extensions.js";
import { marketplacesCopy as copy } from "../../lib/i18n/messages/plugins.js";
import RowLines from "../extensions/RowLines.jsx";
import { RowMenu, useRowMenu } from "../extensions/RowMenu.jsx";
import { marketplaceLabel } from "./marketplace-label.js";

function MarketplaceRow({ marketplace: m, count, disabled, mutate, setConfirm }) {
  const menu = useRowMenu();
  const label = marketplaceLabel(m);
  const items = m.builtin
    ? []
    : [
        {
          id: "update",
          label: commonCopy.refresh,
          ariaLabel: commonCopy.updateMarketplaceLabel(m.name),
          disabled: disabled || m.updatable === false,
          run: () =>
            mutate(
              { action: "marketplace-update", marketplace: m.name },
              copy.buttonOnClick(m.name),
            ),
        },
        {
          id: "remove",
          label: commonCopy.remove,
          ariaLabel: commonCopy.removeMarketplaceLabel(m.name),
          danger: true,
          restoreFocus: false,
          disabled: disabled || m.removable === false,
          run: () =>
            setConfirm({
              action: "marketplace-remove",
              name: m.name,
              body: { action: "marketplace-remove", marketplace: m.name },
            }),
        },
      ];
  return (
    <div className="row-menu-anchor">
      <ListRow
        label={label}
        sub={
          <RowLines
            lines={[
              `${m.builtin ? hub.builtin : hub.customMarketplace} · ${hub.pluginCount(count)}`,
              m.builtin ? (
                copy.builtinDescription
              ) : (
                <code key="source" className="extension-path">
                  {m.source}
                </code>
              ),
            ]}
          />
        }
        menu={
          items.length
            ? { label: hub.rowActions(label), expanded: menu.open, onClick: menu.toggle }
            : undefined
        }
      />
      {items.length > 0 && (
        <RowMenu label={hub.rowActions(label)} state={menu} items={items} />
      )}
    </div>
  );
}

export default function Marketplaces({ data, disabled, mutate, setConfirm }) {
  if (!data.marketplaces.length) return <p className="extension-empty">{copy.empty}</p>;
  return (
    <ListCard label={hub.tabMarketplaces} className="extension-list">
      {data.marketplaces.map((m) => (
        <MarketplaceRow
          key={m.name}
          marketplace={m}
          count={(data.catalog || []).filter((p) => p.marketplace === m.name).length}
          {...{ disabled, mutate, setConfirm }}
        />
      ))}
    </ListCard>
  );
}
```

In `web/features/plugins/PluginFrame.jsx` and `web/features/plugins/CatalogAccount.jsx` replace `import { ExtensionHint } from "../extensions/ExtensionTable.jsx";` with `import ExtensionHint from "../extensions/ExtensionHint.jsx";`.

- [ ] **Step 3: Agency rows**

In `web/features/agency/AgentsTab.jsx`:

1. Replace `import ExtensionTable, { ExtensionHint } from "../extensions/ExtensionTable.jsx";` with

```js
import ListCard from "../../components/ListCard.jsx";
import ListRow from "../../components/ListRow.jsx";
import ExtensionHint from "../extensions/ExtensionHint.jsx";
import RowLines from "../extensions/RowLines.jsx";
```

2. Replace the catalog `<ExtensionTable heads={[hub.headAgent, copy.category, hub.headStatus]} … />` element with:

```jsx
{
  data.items.length ? (
    <ListCard label={hub.browseCatalog} className="extension-list">
      {data.items.map((item) => (
        <ListRow
          key={item.id}
          label={item.name}
          sub={item.category}
          status={item.installed ? { tone: "ok", text: copy.installed } : undefined}
          value={item.installed ? undefined : hub.available}
        >
          <button
            type="button"
            className="button secondary compact"
            disabled={busy}
            onClick={() => state.show(item)}
          >
            {copy.preview}
          </button>
        </ListRow>
      ))}
    </ListCard>
  ) : (
    <p className="extension-empty">{copy.empty}</p>
  );
}
```

3. Replace the installed `<ExtensionTable heads={[hub.headAgent, copy.revision, ""]} … />` element with:

```jsx
{
  installed.items.length ? (
    <ListCard label={copy.installedTitle} className="extension-list">
      {installed.items.map((item) => (
        <ListRow
          key={item.id}
          label={item.name}
          sub={
            <RowLines
              lines={[
                <a key="source" href={item.source} target="_blank" rel="noreferrer">
                  {copy.source}
                </a>,
                item.revision && `${copy.revision}: ${item.revision.slice(0, 8)}`,
              ]}
            />
          }
        >
          <button
            type="button"
            className="button secondary compact"
            disabled={busy}
            onClick={() => state.setConfirm(item)}
          >
            {copy.remove}
          </button>
        </ListRow>
      ))}
    </ListCard>
  ) : (
    <p className="extension-empty">{copy.noInstalled}</p>
  );
}
```

4. Replace `<Segment` / `import Segment from "../../components/Segment.jsx";` with `<Segmented` / `import Segmented from "../../components/Segmented.jsx";` (same props).
5. Segment counts show "—" until known instead of a made-up 0 (guiding decision 5): change the ListRow import from step 1 to `import ListRow, { unknownValue } from "../../components/ListRow.jsx";`, replace `hub.installedView(installedCount ?? 0)` with `hub.installedView(installedCount ?? unknownValue)` and `copy.catalogView(data?.total ?? 0)` with `copy.catalogView(data?.total ?? unknownValue)`. (`shared-agency.spec.js` matches these radios by `/^Installiert/` and `/^Katalog/`, so no spec changes.)

- [ ] **Step 4: Remove the table, its CSS and copy**

`git rm web/features/extensions/ExtensionTable.jsx`. Confirm: `grep -rn "ExtensionTable\|extension-row\|extension-table\|headSkill\|headScope\|headType\|headPlugin\|headMarketplace\|headAgent" web tests` lists only the CSS blocks and catalog keys removed next.

In `web/features/extensions/extensions-hub.css` delete everything between and including `/* Extension tables (until every tab uses list cards) */` … `/* end extension tables */` and between and including `/* Extension tables, phones (until every tab uses list cards) */` … `/* end extension tables, phones */`. Add (before `@media`):

```css
.extension-list .list-row-sub a {
  color: #f49a58;
}
```

In `web/lib/i18n/de/extensions.js` and `web/lib/i18n/en/extensions.js` delete `headSkill`, `headScope`, `headType`, `headPlugin`, `headMarketplace`, `headAgent` from `extensionsHubCopy`.

- [ ] **Step 5: Run the checks**

Run: `node --test tests/unit/i18n-catalogs.test.js tests/unit/i18n.test.js`
Expected: PASS.

Run: `npm run build && npx playwright test tests/browser/plugins.spec.js tests/browser/codex-marketplace.spec.js tests/browser/i18n-plugins-providers.spec.js tests/browser/shared-agency.spec.js tests/browser/extensions.spec.js tests/browser/navigation.spec.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
npx prettier --write web/features/extensions web/features/plugins web/features/agency web/lib/i18n/de/extensions.js web/lib/i18n/en/extensions.js tests/helpers/extensions.js tests/browser
npx eslint web/features/extensions web/features/plugins web/features/agency tests/helpers/extensions.js tests/browser/plugins.spec.js tests/browser/codex-marketplace.spec.js tests/browser/i18n-plugins-providers.spec.js tests/browser/shared-agency.spec.js
git add -A web/features web/lib/i18n tests/helpers/extensions.js tests/browser
git commit -m "feat: list marketplaces and Agency agents as rows and drop extension tables" -m "Custom marketplaces keep update and remove in a row menu; built-in ones stay read-only." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Extensions pattern regression spec

Pin the new behaviour in one browser spec with a shared isolated fixture: deep links, ⓘ disclosure, no save bar / no unsaved prompt, the reference row ("—" then count), the profile sheet and lock on phones, desktop primary and config path, the ⋯ menu with keyboard and viewport bounds, the detail view fallback, and English copy with four tabs.

The page has no drafts, so "dirty bar", "unsaved sheet" and "multi-step save incl. partial failure" are pinned as their absence (no bar, no sheet, no `beforeunload` prompt across tab, profile and history changes); there is no multi-step save to fail.

**Files:**

- Create: `tests/helpers/extensions-page-fixture.js`, `tests/browser/extensions-pattern.spec.js`

**Interfaces:**

- Consumes: helpers `extensionRow`, `openTab`, `expectNoHorizontalOverflow`, `emptyAgency`; Step 0 `commonCopy.unsavedChanges` ("Ungespeicherte Änderungen", SaveBar region), `commonCopy.unsavedTitle` ("Änderungen speichern?").
- Produces: `extensionsPageFixture(page, { shared = false, holdUsage = false, holdPluginWrites = false }) => Promise<{ writes, releaseUsage(), releaseWrites(), plugins, usage }>` — profiles `local-codex` (Codex Lokal) and `managed-claude` (Claude Arbeit) or, shared, `local-codex`/`local-claude`; one removable skill; one plugin `superpowers` (enabled, version 4.1.0, path) with marketplace `official`; usage with `github` (claude, codex) and `files` (claude).

- [ ] **Step 1: The fixture**

Create `tests/helpers/extensions-page-fixture.js`:

```js
import { emptyAgency } from "./extensions.js";

// Isolated API for the Extensions page: two CLI profiles, one skill, one plugin with
// a custom marketplace, and an /accounts/usage answer that a test can hold back.
export async function extensionsPageFixture(
  page,
  { shared = false, holdUsage = false, holdPluginWrites = false } = {},
) {
  const writes = [];
  let releaseUsage = () => {};
  let releaseWrites = () => {};
  const usageReady = holdUsage
    ? new Promise((resolve) => (releaseUsage = resolve))
    : Promise.resolve();
  const writesReady = holdPluginWrites
    ? new Promise((resolve) => (releaseWrites = resolve))
    : Promise.resolve();
  const accounts = [
    { id: "local-codex", name: "Codex Lokal", tool: "codex", kind: "local" },
    { id: "managed-claude", name: "Claude Arbeit", tool: "claude", kind: "managed" },
  ];
  const skills = {
    installPath: "/fixture/.agents/skills",
    note: "Benutzer · von Codex und kompatiblen CLIs geteilt.",
    items: [
      {
        id: "review",
        name: "project-review",
        description: "Prüft Änderungen und dokumentiert Ergebnisse.",
        path: "/fixture/.agents/skills/project-review",
        scope: "Benutzer · geteilt",
        removable: true,
      },
    ],
  };
  const plugins = {
    available: true,
    busy: false,
    reason: null,
    note: "Änderungen gelten für neue Sitzungen.",
    capabilities: { marketplaces: true, enable: true, update: true, install: true },
    installed: [
      {
        id: "superpowers@official",
        name: "superpowers",
        description: "Skills für Coding-Agenten",
        version: "4.1.0",
        enabled: true,
        scope: "user",
        marketplace: "official",
        path: "/fixture/.claude/plugins/superpowers",
        removable: true,
      },
    ],
    marketplaces: [{ name: "official", source: "example/claude-plugins" }],
    catalog: [
      {
        id: "superpowers@official",
        name: "superpowers",
        marketplace: "official",
        installed: true,
      },
    ],
  };
  const usage = {
    agentsEnabled: false,
    connections: {},
    chatgpt: {},
    webSearch: null,
    speech: null,
    cliAccounts: {},
    mcpServers: {
      github: {
        agents: [],
        sessions: 0,
        pipelineProfiles: [],
        clis: [
          { tool: "claude", route: null },
          { tool: "codex", route: null },
        ],
      },
      files: {
        agents: [],
        sessions: 0,
        pipelineProfiles: [],
        clis: [{ tool: "claude", route: null }],
      },
    },
  };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const codex = url.pathname.includes("codex");
    if (request.method() !== "GET")
      writes.push({
        path: url.pathname,
        method: request.method(),
        body: request.postDataJSON(),
      });
    if (url.pathname === "/api/state")
      return route.fulfill({
        json: {
          accounts,
          sharedCliExtensions: shared,
          tools: accounts.map((a) => ({ id: a.tool, name: a.tool, installed: true })),
          sessions: [],
          home: "/fixture",
        },
      });
    if (url.pathname === "/api/accounts/usage") {
      await usageReady;
      return route.fulfill({ json: usage });
    }
    if (url.pathname.endsWith("/extensions"))
      return route.fulfill({
        json: {
          mcp: {
            path: codex
              ? "/fixture/.codex/config.toml"
              : "/fixture/.claude/settings.json",
            servers: [],
            note: "",
          },
          skills,
        },
      });
    if (url.pathname.endsWith("/plugins")) {
      if (request.method() === "POST") {
        await writesReady;
        const body = request.postDataJSON();
        if (body.action === "disable") plugins.installed[0].enabled = false;
        if (body.action === "enable") plugins.installed[0].enabled = true;
        if (body.action === "remove") plugins.installed = [];
        return route.fulfill({ json: { ok: true } });
      }
      return route.fulfill({ json: { ...plugins, tool: codex ? "codex" : "claude" } });
    }
    if (url.pathname.endsWith("/agency")) return route.fulfill({ json: emptyAgency() });
    return route.fulfill({ json: {} });
  });
  return { writes, releaseUsage, releaseWrites, plugins, usage };
}
```

- [ ] **Step 2: The spec**

Create `tests/browser/extensions-pattern.spec.js`:

```js
import { test, expect } from "@playwright/test";
import { baseURL as base } from "../helpers/browser.js";
import { extensionsPageFixture } from "../helpers/extensions-page-fixture.js";
import {
  expectNoHorizontalOverflow,
  extensionRow,
  openTab,
} from "../helpers/extensions.js";

const mcpLink = (page) => page.getByRole("link", { name: /^MCP-Server · / });
const profileColumn = (page) =>
  page.getByRole("navigation", { name: "CLI-Profile", exact: true });

test("legacy MCP links open Skills and the reference row counts central servers", async ({
  page,
}) => {
  const fixture = await extensionsPageFixture(page, { holdUsage: true });
  await page.goto(`${base}/extensions/local-codex?tab=mcp`);
  await expect(page).toHaveURL(/\/extensions\/local-codex$/);
  await expect(page.getByRole("tab")).toHaveText([
    /^Skills/,
    /^Plugins/,
    /^Marketplaces/,
  ]);
  await expect(page.getByRole("tab", { name: /^Skills/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  // Unknown until the usage summary arrives: never a made-up 0.
  await expect(mcpLink(page)).toContainText("— für Codex");
  fixture.releaseUsage();
  await expect(mcpLink(page)).toContainText("1 für Codex");
  await expect(mcpLink(page)).toContainText("Zentral unter Accounts");
  await profileColumn(page)
    .getByRole("button", { name: /Claude Code/ })
    .click();
  await expect(page).toHaveURL(/\/extensions\/managed-claude$/);
  await expect(mcpLink(page)).toContainText("2 für Claude Code");
  await openTab(page, "Plugins");
  await expect(mcpLink(page)).toBeVisible();
  await openTab(page, "Marketplaces");
  await expect(mcpLink(page)).toHaveCount(0);
  await openTab(page, "Skills");
  await mcpLink(page).click();
  await expect(page).toHaveURL(/\/accounts\?section=mcp-servers$/);
  expect(fixture.writes).toEqual([]);
});

test("old and junk extension addresses normalise once to one canonical address", async ({
  page,
}) => {
  await extensionsPageFixture(page);
  for (const [from, to] of [
    ["/plugins/local-codex", /\/extensions\/local-codex\?tab=plugins$/],
    ["/extensions/local-codex?tab=skills", /\/extensions\/local-codex$/],
    ["/extensions/local-codex?tab=bogus", /\/extensions\/local-codex$/],
    ["/extensions/local-codex?tab=agents", /\/extensions\/local-codex$/],
    [
      "/extensions/local-codex?tab=marketplaces",
      /\/extensions\/local-codex\?tab=marketplaces$/,
    ],
  ]) {
    await page.goto(base + from);
    await expect(page).toHaveURL(to);
  }
  // Normalisation replaces the entry instead of stacking a new one.
  const before = await page.evaluate(() => history.length);
  await page.goto(`${base}/extensions/local-codex?tab=mcp`);
  await expect(page).toHaveURL(/\/extensions\/local-codex$/);
  expect(await page.evaluate(() => history.length)).toBe(before + 1);
});

test("the ⓘ on the Codex skills label discloses the scope note verbatim", async ({
  page,
}) => {
  await extensionsPageFixture(page);
  await page.goto(`${base}/extensions/local-codex`);
  const text =
    "Codex-Skills werden im Benutzerordner geteilt und gelten für alle Codex-Profile.";
  const hint = page.getByRole("button", { name: "Hinweis anzeigen", exact: true });
  await expect(hint).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByText(text, { exact: true })).toBeHidden();
  await hint.click();
  await expect(hint).toHaveAttribute("aria-expanded", "true");
  const controlled = page.locator(`[id="${await hint.getAttribute("aria-controls")}"]`);
  await expect(controlled).toHaveText(text);
  await expect(controlled).toBeVisible();
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await hint.click();
  await expect(controlled).toBeHidden();
  // The server's own skills note stays visible; other CLIs have no scope hint.
  await expect(
    page.getByText("Benutzer · von Codex und kompatiblen CLIs geteilt.", { exact: true }),
  ).toBeVisible();
  await page.goto(`${base}/extensions/managed-claude`);
  await expect(extensionRow(page, "project-review")).toBeVisible();
  await expect(hint).toHaveCount(0);
});

test("extensions never show a save bar or ask to save on tab, profile or history changes", async ({
  page,
}) => {
  await extensionsPageFixture(page);
  let prompted = false;
  page.on("dialog", (dialog) => {
    prompted = true;
    dialog.dismiss();
  });
  await page.goto(`${base}/extensions/local-codex`);
  const bar = page.getByRole("region", { name: "Ungespeicherte Änderungen" });
  const sheet = page.getByRole("dialog", { name: "Änderungen speichern?" });
  await page.getByRole("searchbox", { name: "Skills suchen" }).fill("review");
  for (const tab of ["Plugins", "Marketplaces", "Skills"]) {
    await openTab(page, tab);
    await expect(bar).toHaveCount(0);
    await expect(sheet).toHaveCount(0);
  }
  await profileColumn(page)
    .getByRole("button", { name: /Claude Code/ })
    .click();
  await expect(page).toHaveURL(/\/extensions\/managed-claude$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/extensions\/local-codex$/);
  await expect(sheet).toHaveCount(0);
  await expect(bar).toHaveCount(0);
  await page.reload();
  await expect(extensionRow(page, "project-review")).toBeVisible();
  expect(prompted).toBe(false);
});

test("desktop keeps the primary action and config path in the detail header", async ({
  page,
}) => {
  await extensionsPageFixture(page);
  await page.goto(`${base}/extensions/managed-claude?tab=marketplaces`);
  const header = page.locator(".extension-hub-header");
  await expect(header).toContainText("Claude Code · /fixture/.claude/settings.json");
  const add = page.getByRole("button", { name: "Marketplace hinzufügen", exact: true });
  await expect(add).toHaveCount(1);
  await expect(
    header.getByRole("button", { name: "Marketplace hinzufügen" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /^CLI-Profil wechseln/ })).toBeHidden();
  const market = extensionRow(page, "official");
  await expect(market).toContainText("Eigene Quelle · 1 Plugins");
  await market.getByRole("button", { name: "Aktionen für official" }).click();
  await expect(page.getByRole("menu").getByRole("menuitem")).toHaveText([
    "Aktualisieren",
    "Entfernen",
  ]);
});

test("desktop plugin rows offer Details and actions behind ⋯ with keyboard support", async ({
  page,
}) => {
  const fixture = await extensionsPageFixture(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${base}/extensions/managed-claude?tab=plugins`);
  const row = extensionRow(page, "superpowers");
  await expect(row).toContainText("Aktiv");
  const trigger = row.getByRole("button", {
    name: "Aktionen für superpowers",
    exact: true,
  });
  await trigger.click();
  const menu = page.getByRole("menu", { name: "Aktionen für superpowers" });
  await expect(menu.getByRole("menuitem")).toHaveText([
    "Details",
    "Deaktivieren",
    "Aktualisieren",
    "Entfernen",
  ]);
  const box = await menu.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(1280);
  expect(box.y + box.height).toBeLessThanOrEqual(800);
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(
    menu.getByRole("menuitem", { name: "Plugin superpowers deaktivieren" }),
  ).toBeFocused();
  await page.keyboard.press("End");
  await expect(
    menu.getByRole("menuitem", { name: "Plugin superpowers entfernen" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  // An outside press closes the menu; the page title is inert, unlike the sidebar corner.
  await page.getByRole("heading", { name: "Erweiterungen", level: 1 }).click();
  await expect(menu).toHaveCount(0);
  await trigger.click();
  await page.getByRole("menuitem", { name: "Plugin superpowers deaktivieren" }).click();
  await expect(row).toContainText("Deaktiviert");
  expect(fixture.writes.at(-1).body).toEqual({
    action: "disable",
    pluginId: "superpowers@official",
  });
  await trigger.click();
  await page.getByRole("menuitem", { name: "Details zu superpowers" }).click();
  await expect(
    page.getByRole("heading", { name: "superpowers", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("4.1.0", { exact: true })).toBeVisible();
  await expect(page.getByText("/fixture/.claude/plugins/superpowers")).toBeVisible();
  await page.getByRole("button", { name: "Zurück zu Plugins" }).click();
  await expect(row).toBeVisible();
  // Near the bottom edge the menu opens above its trigger instead of leaving the viewport.
  const rowBox = await row.boundingBox();
  const height = Math.ceil(rowBox.y + rowBox.height + 24);
  await page.setViewportSize({ width: 1280, height });
  await trigger.click();
  await expect(menu).toBeVisible();
  const low = await menu.boundingBox();
  expect(low.y).toBeGreaterThanOrEqual(0);
  expect(low.y + low.height).toBeLessThanOrEqual(height);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
});

test("removing a plugin from its detail view returns to the list", async ({ page }) => {
  await extensionsPageFixture(page);
  await page.goto(`${base}/extensions/managed-claude?tab=plugins`);
  await extensionRow(page, "superpowers")
    .getByRole("button", { name: /^superpowers/ })
    .click();
  await page.getByRole("button", { name: "Plugin superpowers entfernen" }).click();
  await page.getByRole("button", { name: "Entfernen bestätigen", exact: true }).click();
  await expect(
    page.getByText("Noch keine Plugins installiert.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Zurück zu Plugins" })).toHaveCount(0);
});

test("phones: sidebar button, profile sheet, plugin detail and a locked switcher", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await extensionsPageFixture(page, { holdPluginWrites: true });
  await page.goto(`${base}/extensions/local-codex`);
  await expect(page.locator(".mobile-header")).toBeHidden();
  await expect(
    page.getByRole("heading", { name: "Erweiterungen", level: 1 }),
  ).toBeVisible();
  await expect(profileColumn(page)).toBeHidden();
  await page
    .getByRole("button", { name: /^CLI-Profil wechseln, aktuell Codex Lokal/ })
    .click();
  const sheet = page.getByRole("dialog", { name: "CLI-Profile" });
  const profiles = sheet.getByRole("group", { name: "CLI-Profile" }).getByRole("button");
  await expect(profiles).toHaveCount(2);
  await expect(profiles.filter({ hasText: "Codex Lokal" })).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(sheet).toContainText("/fixture/.codex/config.toml");
  await profiles.filter({ hasText: "Claude Arbeit" }).click();
  await expect(sheet).toHaveCount(0);
  await expect(page).toHaveURL(/\/extensions\/managed-claude$/);
  await expect(
    page.getByRole("button", { name: "Skill installieren", exact: true }),
  ).toHaveCount(1);
  await openTab(page, "Plugins");
  const row = extensionRow(page, "superpowers");
  await expect(
    row.getByRole("button", { name: "Aktionen für superpowers" }),
  ).toBeHidden();
  await row.getByRole("button", { name: /^superpowers/ }).click();
  await expect(
    page.getByRole("heading", { name: "superpowers", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Plugin superpowers deaktivieren" }).click();
  const switcher = page.getByRole("button", { name: /^CLI-Profil wechseln/ });
  await expect(switcher).toBeDisabled();
  await expect(page.getByRole("tab", { name: /^Skills/ })).toBeDisabled();
  fixture.releaseWrites();
  await expect(
    page.getByRole("button", { name: "Plugin superpowers aktivieren" }),
  ).toBeVisible();
  await expect(switcher).toBeEnabled();
  await page.getByRole("button", { name: "Zurück zu Plugins" }).click();
  await expect(row).toContainText("Deaktiviert");
  await page.getByRole("button", { name: "Navigation öffnen" }).click();
  await expect(page.locator(".sidebar")).toHaveClass(/open/);
  await expectNoHorizontalOverflow(page);
});

test.describe("in English", () => {
  test.use({ locale: "en-GB" });
  test("shared profiles show four tabs, the profile sheet and the reference row", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await extensionsPageFixture(page, { shared: true });
    await page.goto(`${base}/extensions/local-claude?tab=agents`);
    await expect(page.getByRole("tab")).toHaveText([
      /^Skills/,
      /^Plugins/,
      /^Marketplaces/,
      /^Agents/,
    ]);
    const agents = page.getByRole("tab", { name: /^Agents/ });
    await expect(agents).toHaveAttribute("aria-selected", "true");
    await expect(agents).toBeInViewport();
    await expect(
      page.getByRole("button", { name: "Browse catalog", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: /^Switch CLI profile, current: Claude Code/ })
      .click();
    const sheet = page.getByRole("dialog", { name: "CLI profiles" });
    await expect(
      sheet.getByRole("group", { name: "CLI profiles" }).getByRole("button"),
    ).toHaveText([
      /Codex.*All accounts using this CLI/,
      /Claude Code.*All accounts using this CLI/,
    ]);
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
    await openTab(page, "Skills");
    await expect(
      page.getByRole("link", { name: /^MCP servers · 2 for Claude Code/ }),
    ).toContainText("Managed centrally in Accounts");
    await expectNoHorizontalOverflow(page);
  });
});
```

- [ ] **Step 3: Run it**

Run: `npm run build && npx playwright test tests/browser/extensions-pattern.spec.js`
Expected: PASS (9 tests). A failure here is a product bug in Tasks 2–6, not a test to loosen: fix the component (for example the ⋯ menu bounds or the detail fallback) and rerun.

Then WebKit once: `AGENTPIER_TEST_BROWSER=webkit npx playwright test tests/browser/extensions-pattern.spec.js` (install with `npx playwright install webkit` if missing).
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
npx prettier --write tests/helpers/extensions-page-fixture.js tests/browser/extensions-pattern.spec.js
npx eslint tests/helpers/extensions-page-fixture.js tests/browser/extensions-pattern.spec.js
git add tests/helpers/extensions-page-fixture.js tests/browser/extensions-pattern.spec.js
git commit -m "test: pin the extensions settings pattern in the browser" -m "Covers legacy links, the info hint, the absent save bar, the MCP reference row, the profile sheet and lock on phones, and the plugin menu and detail view." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Feature coverage, full gate and screenshots

**Files:**

- Create (git-ignored, not committed): `.superpowers/screenshots/extensions.config.js`, `.superpowers/screenshots/extensions-shots.spec.js`; output `.superpowers/screenshots/extensions/*.png`

**Interfaces:**

- Consumes: everything above; `tests/helpers/extensions-page-fixture.js`.

- [ ] **Step 1: Walk the no-feature-loss checklist**

For each row, open the place named in "New place" (`npm run build && npm start` is not needed; use the specs listed, or the screenshot run below) and confirm the proof passes. Every row must be ticked before the gate.

| #   | Current user action (component)                                                               | New place                                                                                          | Proof                                                                                   |
| --- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 1   | Pick a CLI profile from the list (`ExtensionsPage` `ListDetail`)                              | Desktop: profile column (unchanged). Phones: header subtitle → sheet "CLI-Profile" with check mark | `navigation.spec` profile deep links; `extensions-pattern` phones test                  |
| 2   | Profiles grouped per CLI in shared mode ("Alle Accounts dieser CLI")                          | Same sub line in column and sheet                                                                  | `shared-agency.spec`; `extensions-pattern` English test                                 |
| 3   | Profiles and tabs locked during a mutation                                                    | Column, header switcher and tabs disabled                                                          | `plugins.spec` failure test; `codex-marketplace.spec`; `extensions-pattern` phones test |
| 4   | Open the sidebar on phones (global mobile header)                                             | `SettingsShell` sidebar button                                                                     | `extensions-pattern` phones test                                                        |
| 5   | "Profile werden geladen …" while no profile; "Profil nicht gefunden"                          | Detail area / App (unchanged)                                                                      | `navigation.spec` shell deep links                                                      |
| 6   | Switch tabs with counts (`UnderlineTabs`)                                                     | Same, without MCP; EN scroll fade                                                                  | `extensions.spec`; `extensions-pattern` English test                                    |
| 7   | MCP tab: read that MCP lives in Accounts, "MCP-Server öffnen"                                 | Reference row "MCP-Server · n für CLI" on Skills and Plugins → Accounts                            | `extensions.spec` first test; `extensions-pattern` reference-row test                   |
| 8   | See the CLI config path (detail header)                                                       | Desktop detail header; phones: profile sheet current row                                           | `extensions-pattern` desktop header and phones tests                                    |
| 9   | Tab primary action (header button / fixed mobile bar)                                         | Desktop header button; phones group-label "+ …"                                                    | `extensions-pattern` desktop + phones; `plugins.spec` OpenCode mobile                   |
| 10  | Marketplaces deep link waits for capabilities; unsupported tab normalises                     | Same (`resolveWorkspaceTab`)                                                                       | `plugins.spec` last test; `navigation.spec`; unit test                                  |
| 11  | Sharing note, "Vorhandene Account-Konfigurationen übernehmen", conflict list                  | Skills tab (`ExtensionsFrame`)                                                                     | `shared-agency.spec`                                                                    |
| 12  | Skills load error + "Erneut laden"; loading text                                              | `ExtensionsFrame` (unchanged)                                                                      | code review of `ExtensionsFrame.jsx`                                                    |
| 13  | Search skills                                                                                 | Toolbar above the list                                                                             | `extensions.spec` pagination                                                            |
| 14  | Server skills note; Codex scope note                                                          | Note visible; scope note behind ⓘ on "Skills"                                                      | `extensions-pattern` ⓘ test; `extensions.spec` upload                                   |
| 15  | Read skill name, description, scope, state, path                                              | Row label + lines                                                                                  | `extensions.spec`                                                                       |
| 16  | Remove an installed skill (confirm/cancel)                                                    | Trash button 40×40 → inline confirmation                                                           | `extensions.spec` upload                                                                |
| 17  | Page through skills                                                                           | Pagination under the card                                                                          | `extensions.spec` pagination                                                            |
| 18  | Install a skill (file, drag & drop, GitHub link, destination)                                 | Same side panel                                                                                    | `extensions.spec` upload                                                                |
| 19  | Codex Marketplace-Account select                                                              | Above the plugin views (unchanged)                                                                 | `codex-marketplace.spec`                                                                |
| 20  | Plugin note + "Neu laden"; CLI reason; busy notice                                            | `PluginFrame` (unchanged)                                                                          | `plugins.spec`; `i18n-plugins-providers.spec`                                           |
| 21  | Installed / Entdecken segments with counts                                                    | `Segmented` in the toolbar                                                                         | `plugins.spec`; `i18n-plugins-providers.spec`                                           |
| 22  | Search installed; search + marketplace filter in the catalog                                  | Toolbar (unchanged)                                                                                | `plugins.spec`                                                                          |
| 23  | Read installed plugin version, state, scope, marketplace, description, path                   | Row (meta, state) + detail (version, source, status, path)                                         | `extensions-pattern` desktop plugin test                                                |
| 24  | Enable/disable, update, remove a plugin (confirm)                                             | Desktop ⋯ menu; phones detail view; desktop "Details"                                              | `plugins.spec` first test; `extensions-pattern`                                         |
| 25  | Page through installed plugins and the catalog                                                | Pagination (unchanged)                                                                             | `plugins.spec`                                                                          |
| 26  | Install from the catalog                                                                      | Inline row button                                                                                  | `plugins.spec`; `codex-marketplace.spec`                                                |
| 27  | OpenCode npm package panel                                                                    | Same panel via the primary action                                                                  | `plugins.spec` OpenCode                                                                 |
| 28  | Read marketplaces (built-in/custom, source, plugin count)                                     | Rows with two lines                                                                                | `codex-marketplace.spec`; `extensions-pattern` desktop header                           |
| 29  | Update / remove a custom marketplace (focused confirmation)                                   | Row ⋯ menu                                                                                         | `plugins.spec` removal + error tests                                                    |
| 30  | Add a marketplace                                                                             | Same panel via the primary action                                                                  | `plugins.spec`                                                                          |
| 31  | Agency: installed/catalog segments, search, category, refresh, hints, notices, stale, loading | `AgentsTab` (unchanged controls)                                                                   | `shared-agency.spec`                                                                    |
| 32  | Agency catalog rows: preview → side panel → install; paging                                   | Rows with "Agent ansehen"                                                                          | `shared-agency.spec`                                                                    |
| 33  | Agency installed rows: source link, revision, remove (modal)                                  | Rows with link line and button                                                                     | `shared-agency.spec`                                                                    |
| 34  | Agent count in the tab                                                                        | Same                                                                                               | `shared-agency.spec` (tab text)                                                         |

- [ ] **Step 2: Run the full gate**

Run: `npm run check`
Expected: lint, format, structure (every file ≤ 600 lines), build and all node suites pass.

Run: `npx playwright test tests/browser/extensions.spec.js tests/browser/extensions-pattern.spec.js tests/browser/plugins.spec.js tests/browser/codex-marketplace.spec.js tests/browser/shared-agency.spec.js tests/browser/i18n-plugins-providers.spec.js tests/browser/navigation.spec.js tests/browser/settings-pattern-tabs.spec.js tests/browser/settings-pattern-list.spec.js tests/browser/settings-pattern-shell.spec.js`
Expected: PASS.

Run once: `npm run test:e2e`
Expected: PASS.

- [ ] **Step 3: Take the screenshots**

Create `.superpowers/screenshots/extensions.config.js`:

```js
import path from "node:path";
import { fileURLToPath } from "node:url";
import base from "../../playwright.config.js";

// Screenshot run for the Extensions page against the disposable test server.
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
export default {
  ...base,
  testDir: here,
  testMatch: "extensions-shots.spec.js",
  globalSetup: path.join(root, "tests/helpers/browser-login-setup.js"),
  use: { ...base.use, storageState: path.join(root, base.use.storageState) },
  webServer: { ...base.webServer, cwd: root },
  projects: [{ name: "desktop" }],
};
```

Create `.superpowers/screenshots/extensions-shots.spec.js`:

```js
import { test } from "@playwright/test";
import { baseURL as base } from "../../tests/helpers/browser.js";
import { extensionsPageFixture } from "../../tests/helpers/extensions-page-fixture.js";

const out = new URL("./extensions/", import.meta.url).pathname;
const tabs = [
  ["skills", ""],
  ["plugins", "?tab=plugins"],
  ["marketplaces", "?tab=marketplaces"],
  ["agents", "?tab=agents"],
];
for (const [locale, lang] of [
  ["de-DE", "de"],
  ["en-GB", "en"],
])
  for (const [width, height, size] of [
    [390, 844, "mobile"],
    [1280, 800, "desktop"],
  ])
    test.describe(`${lang} ${size}`, () => {
      test.use({ locale, viewport: { width, height } });
      test("extensions tabs", async ({ page }) => {
        await extensionsPageFixture(page, { shared: true });
        for (const [name, query] of tabs) {
          await page.goto(`${base}/extensions/local-claude${query}`);
          await page.locator(".extension-tabpanel:not([hidden])").first().waitFor();
          await page.screenshot({
            path: `${out}${lang}-${size}-${name}.png`,
            fullPage: true,
            animations: "disabled",
          });
        }
        await page.goto(`${base}/extensions/local-claude?tab=plugins`);
        if (size === "mobile") {
          await page.locator(".extension-profile-switch").click();
          await page.screenshot({ path: `${out}${lang}-${size}-profile-sheet.png` });
          await page.keyboard.press("Escape");
          await page.locator(".plugin-row .list-row-main").first().click();
          await page.screenshot({ path: `${out}${lang}-${size}-plugin-detail.png` });
        } else {
          await page.locator(".plugin-row [aria-haspopup='menu']").first().click();
          await page.screenshot({ path: `${out}${lang}-${size}-plugin-menu.png` });
        }
      });
    });
```

Run: `mkdir -p .superpowers/screenshots/extensions && npm run build && npx playwright test -c .superpowers/screenshots/extensions.config.js`
Expected: PASS; `ls .superpowers/screenshots/extensions` lists 22 PNGs (`{de,en}-{mobile,desktop}-{skills,plugins,marketplaces,agents}.png`, `{de,en}-mobile-profile-sheet.png`, `{de,en}-mobile-plugin-detail.png`, `{de,en}-desktop-plugin-menu.png`). Look at each: no clipped text, the active tab visible, the reference row dashed, the switcher in the mobile subtitle, the ⓘ only on Codex skills (not in these shared Claude shots). `git status --short` shows nothing under `.superpowers/` (ignored).

- [ ] **Step 4: Commit (only if Steps 1–3 required fixes)**

If the checklist or the screenshots exposed a defect, fix it in the owning file, rerun the affected spec and `npm run check`, then:

```bash
git add -A web tests
git commit -m "fix: <the defect, in one line>" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Report the screenshot directory `/Users/d.kaulig/Projects/agent-pier/.worktrees/settings-extensions/.superpowers/screenshots/extensions/` and the PR-description deviations listed under "Decisions that refine the spec".

---

## Self-Review

**Spec coverage (Step 4):**

| Spec item                                                                                                           | Task                                                               |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| MCP tab removed; reference row with the count of central servers enabled for the profile's CLI                      | 2 (row, count from `/accounts/usage`), 1 (`cliServerCount`)        |
| Tabs Skills, Plugins, Marketplaces (if supported), Agenten (shared)                                                 | 1 (`workspaceTabs`), 2                                             |
| `defaultExtensionTab` flips to `skills`; `?tab=mcp` → `skills`; old links redirect                                  | 2 (routes + unit/property), 7 (browser, history)                   |
| Mobile profile switcher in the header subtitle → sheet "CLI-Profile", one group (own or shared)                     | 3                                                                  |
| Primary actions on the group label (mobile) or detail header (desktop)                                              | 1 (`primaryAction`), 3                                             |
| Plugin row: mobile detail subpage (version, source, enable/disable, remove); desktop ⋯ with the same plus "Details" | 5                                                                  |
| Import into shared and the conflict list stay visible on Skills                                                     | 3 (frame stays on Skills), 4                                       |
| Config path in the desktop header                                                                                   | 3                                                                  |
| Installed/discover segments and the OpenCode npm panel stay                                                         | 3 (panel), 5 (segments)                                            |
| `locked` disables tabs and the profile switcher                                                                     | 3, 7                                                               |
| No save bar                                                                                                         | 7 (pinned as absence)                                              |
| Hints behind ⓘ (`extensionScopeNote`)                                                                               | 4, 7                                                               |
| Guiding decisions: no feature loss                                                                                  | 8 (checklist)                                                      |
| "—" until known, never fake 0                                                                                       | 1, 2, 7                                                            |
| Empty states from the pattern                                                                                       | 4–6 (`extension-empty`)                                            |
| Browser specs updated for new selectors                                                                             | 2–6                                                                |
| New regression specs (deep links, ⓘ, no bar/sheet, partial failure n/a)                                             | 7                                                                  |
| EN + DE, mobile 390×844 and desktop 1280×800 screenshots                                                            | 7 (EN test), 8                                                     |
| Files ≤ 600 lines                                                                                                   | all new files < 300 lines; `extensions-hub.css` ≈ 420 after Task 6 |

**Placeholder scan:** The only "paste" instruction (Task 3 Step 7) names the exact rule blocks to carry over verbatim from the current file and the markers that bracket them; Task 6 deletes them by those markers. No TBD/TODO.

**Type consistency:** `workspaceTabs`/`resolveWorkspaceTab`/`primaryAction`/`cliServerCount` signatures match between Task 1, Task 2 and Task 3. `pluginActionKinds` (Task 1) feeds `pluginActions` (Task 5), used by `PluginRow` and `PluginDetail`. `useRowMenu`/`RowMenu({ label, state, items })` are used identically by `PluginRow` (Task 5) and `MarketplaceRow` (Task 6). `PluginsTab` props `detail`/`setDetail` are passed in Task 3 and consumed in Task 5. Helper names `openProfiles`, `closeProfiles`, `expectProfilesDisabled`, `extensionRow`, `rowMenuItem`, `revealRow` match their uses. Copy keys added (`mcpServers`, `serversForCli`, `switchProfile`, `pluginActive`, `pluginDisabled`, `pluginDetails`, `pluginDetailsLabel`, `backToPlugins`, `path`) exist in DE and EN with the same arguments.

**Review Focus:** each of the five lines has a test in its owning task (Task 1 and 7; 3 and 7; 5 and 7; 5 and 7; 2 and 7).
