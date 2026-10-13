# Accounts Page (Settings Redesign Step 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move `/accounts` onto the shared settings pattern: a hub of four grouped list cards (mobile) or a 320px list column plus a detail pane (desktop), every entry as a detail subpage with its own save bar, "Used by" from `GET /accounts/usage`, and no loss of any current Accounts feature.

**Architecture:** `AccountsPage` renders `SettingsShell` with an `AccountsHub` (four `ListCard` groups of link rows) and a detail pane. The route fields `section`/`item` (Step 0) select an entry through a pure resolver (`accounts-items.js`); a registry maps the entry kind to a lazily loaded detail component. Each detail owns one `useTabDraft` draft (through `useAccountDraft`, which also registers the unsaved-changes guard) and a one-step save chain built by a pure, unit-tested step module. Existing modules (`provider-connections/*`, `mcp-servers/*`, `providers/*`) are reused at their paths; only the dialog/side-panel/section shells are replaced.

**Tech Stack:** React 19, Vite 8, Express 5 (no server change in this step), `node:test` + `fast-check`, Playwright 1.64.

**Spec:** `docs/superpowers/specs/2026-10-12-settings-redesign-design.md` (sections "Guiding decisions" and "Step 2: Accounts"). Contract for shared pieces: `docs/superpowers/plans/2026-10-12-settings-foundation.md` (Interfaces of Tasks 2–10 and 13, the guide `docs/settings-pattern.md`) with the rulings in `.superpowers/sdd/2026-10-12-settings-foundation/progress.md`. Design data (untrusted): handoff `design_handoff_einstellungen/README.md` section "Accounts (1c)" and the final set `Einstellungen Übersicht.dc.html` (frames "Accounts", "Mobil · Provider-Zugang").

## Global Constraints

- Work only in `/Users/d.kaulig/Projects/agent-pier/.worktrees/settings-accounts` on branch `feat/settings-redesign-accounts` (branched from `feat/settings-redesign` after Step 0 is complete). Never target the default tmux server or real user sessions; browser specs use the existing isolated fixtures (`scripts/test-server.mjs`, `tests/browser/*-fixture.js`).
- Node.js 22.13+, JavaScript ES modules, JSX only under `web/`. Prettier: two spaces, double quotes, semicolons, trailing commas, 90 columns. Run `npx prettier --write <files>` on every touched file.
- Every source and test file stays at or below 600 lines (`npm run check:structure`).
- Every UI text exists in `web/lib/i18n/de/*.js` and `web/lib/i18n/en/*.js` with matching keys and interpolation arguments, imported through `web/lib/i18n/messages/`. No hardcoded product copy in `web/`. **Do not add keys to `web/lib/i18n/*/common.js`** (Step 0 owns shared copy); Accounts copy goes to `accounts.js`.
- Guiding decision 1: no feature loss. Every row of the coverage checklist in Task 11 must have a place.
- Guiding decision 2: every field of a detail is a draft saved by the bar. Real actions stay immediate: list add/delete, OAuth login/logout, ChatGPT device login/check/disconnect, CLI-find adoption, MCP CLI conflict resolution (overwrite/adopt), native CLI sign-in, removing a stored speech or Brave key, setting the default CLI account.
- Guiding decision 3: a draft sends its base revision where the resource has one (speech `revision`, web search `revision`, MCP server `revision`); a 409 `…conflict` shows "changed elsewhere" with Reload / Overwrite anyway.
- Guiding decision 5: rows show `unknownValue` ("—") until `/accounts/usage` answered, never a fake 0.
- Guiding decision 6: Accounts is top level (sidebar icon on mobile, ⓘ in the header on mobile and desktop); with agents disabled the "Dienste für Agenten" group and ChatGPT rows are hidden and "Used by" lists only CLIs, sessions and pipeline profiles. `/accounts` makes no `/api/assistant*` request except `/api/assistant-feature` while agents are off.
- README sizes win: bar buttons h40, bar note 11px, ⓘ 20×20, list column 320px, content column max 720px.
- Commands (verified in `package.json`): single node test `node --test tests/unit/<file>.test.js`; browser `npm run build && npx playwright test tests/browser/<file>.spec.js`; full gate `npm run check`.
- Commit messages in English with `feat:`, `fix:`, `test:` or `chore:` prefixes, ending with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Existing browser specs: change how elements are found (open the entry, scope to the detail, the bar instead of a dialog), never what is asserted, except the reformulations listed under "Deviations" (9, 12, 14).

## Review Focus

1. **Creating an entry, then landing on it.** After "Zugang speichern" / "Account erstellen" / "Server speichern" on an `item=new` subpage the page must replace the address with the new item, show no unsaved-changes sheet, and Back must not return to the empty form. Pinned in Task 10 (`accounts-drafts.spec.js` "creating lands on the new entry without a prompt").
2. **Deleting or disconnecting the open entry.** A deleted connection, CLI account, MCP server or disconnected ChatGPT account must return to the hub once (replace), never loop and never leave a stale detail; an unknown `item` deep link behaves the same. Pinned in Task 3 (`accounts-hub.spec.js` "an unknown item returns to its group once") and the migrated restart/delete specs in Tasks 4–8.
3. **Usage endpoint slow or failing.** Rows and "Used by" show "—", saving still works, nothing shows 0. Pinned in Task 3 ("usage stays unknown when the endpoint fails").
4. **A late ChatGPT account list after a disconnect** must not bring the row back (newest load wins). Pinned by the migrated `assistant-accounts.spec.js` test "an older account fetch cannot restore an account after disconnect" (Task 6).
5. **MCP value-reference refusal** shows exactly one alert at the field, no second one in the bar, and both disappear after the field changes. Pinned by the migrated `mcp-value-references.spec.js` (Task 8) and the `consumed` outcome rule in `McpServerDetail`.

---

## File Structure

New (all under `web/features/accounts/` unless noted):

- `accounts-items.js` — pure: `itemRoute`, `sectionLabel`, `resolveAccountItem`, `accountItemTitle`.
- `account-usage-view.js` — pure: `unknownUsage`, `usageEntry`, `usageValue`, `agentRoute`, `restartNote`.
- `useAccountsData.js` — MCP servers, ChatGPT accounts, speech, web search for the hub.
- `useAccountUsage.js` — `GET /api/accounts/usage`.
- `useNarrowViewport.js` — `(max-width: 700px)` as a hook.
- `useAccountDraft.js` — `useTabDraft` + `useUnsavedChangesGuard` for one detail.
- `useCreatedRedirect.js` — navigate to a created entry once the draft is clean.
- `useFieldSetter.js` — updater-style setter for one draft field (endpoint draft).
- `account-details.js` — registry kind → lazy detail component.
- `AccountsHub.jsx`, `McpServersGroup.jsx`, `AddLabel.jsx`.
- `AccountDetail.jsx` (frame + `AccountSaveBar`), `UsedByGroup.jsx`, `FieldRow.jsx`, `KeyField.jsx`.
- `NativeAccountDetail.jsx`, `LegacyProviderEditor.jsx`, `native-account-save.js`.
- `accounts-page.css`.
- `web/features/provider-connections/ConnectionDetail.jsx`, `ConnectionEndpointGroups.jsx`, `ConnectionDeleteSheet.jsx`, `ConnectionRestartBlock.jsx`, `connection-save.js`, `connection-summary.js`.
- `web/features/assistants/ChatgptLoginDetail.jsx`, `ChatgptAccountDetail.jsx`, `useChatgptLogin.js`, `ChatgptOfflineNote.jsx`.
- `web/features/mcp-servers/McpServerDetail.jsx`, `McpServerFields.jsx`, `McpServerInfo.jsx`, `McpServerDetails.jsx`, `McpRemoveConfirmation.jsx`, `McpFindsDetail.jsx`, `mcp-server-save.js`, `mcp-notices.js`.

Rewritten in place: `web/features/accounts/AccountsPage.jsx`, `web/features/assistants/SpeechSettings.jsx`, `web/features/assistants/WebSearchSettings.jsx`.

Modified: `web/components/SaveBar.jsx` (one prop), `web/app/App.jsx` (props), `web/app/AppDialogs.jsx` (drop the `account` modal), `web/lib/i18n/{de,en}/accounts.js`, `web/lib/i18n/messages/accounts.js`.

Deleted: `web/features/accounts/AccountDialog.jsx`, `web/features/provider-connections/ProviderConnections.jsx`, `web/features/provider-connections/ConnectionDialog.jsx`, `web/features/assistants/AssistantModelAccounts.jsx`, `web/features/mcp-servers/McpServersSettings.jsx`, `web/features/mcp-servers/McpServerForm.jsx`. Kept unchanged and reused: `NativeAccountActions.jsx`, `useAccountAuthStatus.js`, every `Endpoint*`/`endpoint-*` module, `AffectedAgents.jsx`, `McpCliStatus.jsx`, `McpCliFinds.jsx`, `McpCodexAccounts.jsx`, `McpAuthFields.jsx`, `McpSecretRows.jsx`, `McpCliChoices.jsx`, `StdioConfirmation.jsx`, `McpOAuthLogin.jsx`, `McpOAuthStatus.jsx`, `RestartConfirmation.jsx`.

Tests:

- Unit: `tests/unit/accounts-copy.test.js`, `tests/unit/accounts-items.test.js`, `tests/unit/account-usage-view.test.js`, `tests/unit/connection-save.test.js`, `tests/unit/native-account-save.test.js`, `tests/unit/mcp-server-save.test.js`.
- Browser helper: `tests/helpers/accounts-browser.js`. Fixture: `tests/browser/providers-fixture.js` answers `/api/accounts/usage`.
- New browser specs: `tests/browser/accounts-hub.spec.js`, `tests/browser/accounts-drafts.spec.js`.
- Migrated browser specs (selectors only, plus the reformulations of deviations 9, 12 and 14): `provider-connections`, `provider-connection-restart`, `endpoint-connections`, `endpoint-model-editing`, `endpoint-adapter-options`, `endpoint-routing`, `endpoint-route-labels`, `providers`, `i18n-plugins-providers`, `account-defaults`, `ui`, `live`, `nono-sandbox`, `assistant-accounts`, `assistant-channels`, `assistant-web-tools`, `agent-mcp-servers`, `mcp-oauth`, `mcp-cli-bindings`, `mcp-cli-notices`, `mcp-codex-login`, `mcp-value-references`, `extensions`; fixture helpers `tests/browser/providers-fixture.js` (`createForm`) and `tests/browser/mcp-cli-fixture.js` (`openAdd`).
- Screenshots (git-ignored): `.superpowers/screenshots/playwright.accounts.config.js`, `.superpowers/screenshots/accounts-screenshots.spec.js`.

### Step 0 interfaces this plan consumes (exact)

- `useTabDraft({ server, revisions, countChanges? }) => draft` with `values, base, set(key, value), update(patch), dirty, changedKeys, changeCount, conflicts, saving, outcome, confirmation, save(steps), overwrite(steps), reset(), reload(), revisions()` (`web/lib/settings/useTabDraft.js`).
- `useUnsavedChangesGuard({ draft, tab, save, stays }) => sheetProps` (`web/lib/settings/useUnsavedChangesGuard.js`); `UnsavedChangesSheet(sheetProps)`; `Sheet({ open, title, onCancel, className, children })`.
- `SaveBar({ draft, onSave, onOverwrite, saveLabel?, cancelLabel?, note? })` — this plan adds `saveDisabled` and `saveFocusKey` (Task 3).
- `runSaveChain`, `confirmationRequest`, step shape `{ id, label, keys?, resource?, run(ctx), revisions?, confirmation?, isConflict? }`, ctx `{ values, base, changed, revision, revisions, confirmations, results }` (`web/lib/settings/save-chain.js`); `sameValue` (`web/lib/settings/draft-state.js`).
- `SettingsShell({ title, subtitle, description, leading, onLeading, leadingLabel, navigationOpen, actions, tabs, bar, className, children })`.
- `GroupLabel({ children, as, id, hint, hintLabel, action: { label, onClick, disabled } })`, `ListCard({ label, labelledBy, disabled, className, children })`, `ListRow({ label, sub, icon, value, status, onClick, href, chevron, menu, onDelete, deleteLabel, hint, hintLabel, disabled, className, children })`, `unknownValue`, `CheckboxRow`, `RadioRow`, `SelectRow`, `ToggleRow` (`web/components/ListRow.jsx`), `useInfoHint`, `InfoHintButton({ hint, label })`, `InfoHintText({ hint, children })`.
- Route: `{ view: "accounts", section?, item?, mcpOAuth? }`; `accountSections = ["models", "services", "mcp-servers", "cli"]` (`web/features/accounts/routes.js`); `routePath(route)` (`web/app/routes.js`); `navigate(next, replace = false)`.
- `commonCopy`: `usedBy`, `agentsCount(n)`, `unsavedChanges`, `save`, `cancel`, `local`, `addAccount`, `createAccount`, `deleteAccount`, `signIn`, `accountName`, `back`.
- `GET /api/accounts/usage` → `{ agentsEnabled, connections: {id: Usage}, chatgpt: {id: Usage}, mcpServers: {id: Usage}, webSearch: Usage|null, speech: Usage|null, cliAccounts: {id: Usage} }`, `Usage = { agents: [{ id, name, kind: "agent"|"teamMember", via: "model"|"pipelines"|"binding"|"capability"|"channel" }], sessions, pipelineProfiles: [{ id, name }], clis: [{ tool, route }] }`.

### Detail props (one contract for every detail component)

Every component in the registry receives `DetailProps`:

```js
{
  entry,          // { kind, section, item, record } from resolveAccountItem
  usage,          // Usage | undefined (undefined = not known yet)
  agentsEnabled,  // boolean
  state,          // App state (/api/state)
  data,           // useAccountsData() result
  refresh,        // App refresh() → Promise
  navigate,       // App navigate(next, replace)
  act,            // App act(type, item) → AppDialogs ("login", "deleteAccount")
  oauth,          // useMcpOAuth() result (shared with the MCP group)
  notifyMcp,      // (text) => void, sets the MCP group's notice
}
```

---

### Task 1: Accounts copy

**Files:**

- Modify: `web/lib/i18n/de/accounts.js`, `web/lib/i18n/en/accounts.js`, `web/lib/i18n/messages/accounts.js`
- Test: `tests/unit/accounts-copy.test.js`

**Interfaces:**

- Produces `accountsHubCopy` (reactive, `web/lib/i18n/messages/accounts.js`): `intro`, `infoLabel`, `groups.{models,services,mcpServers,cli}`, `breadcrumb(group)`, `selectHint`, `loading`, `sessionsOnly`, `sessionsCount(count)`, `pipelineProfile`, `usedByNone`, `agentKinds.{agent,teamMember}`, `compatibleClis`, `restartsAgents(count)`, `replaceKey`, `connectionGroups.{connection,test}`, `chatgptSub(status)`, `chatgptConnectSub`, `speechProvider`, `searchProviders.{duckduckgo,perplexity,brave}`, `notReady`, `cliFindsSub`, `accountActions`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/accounts-copy.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import * as de from "../../web/lib/i18n/de/accounts.js";
import * as en from "../../web/lib/i18n/en/accounts.js";
import { accountsHubCopy } from "../../web/lib/i18n/messages/accounts.js";
import { setLanguage } from "../../web/lib/i18n/index.js";

test("the accounts hub copy exists in German and English", () => {
  for (const catalog of [de, en]) {
    const copy = catalog.accountsHubCopy;
    assert.equal(typeof copy.intro, "string");
    assert.deepEqual(Object.keys(copy.groups).sort(), [
      "cli",
      "mcpServers",
      "models",
      "services",
    ]);
    assert.match(copy.restartsAgents(2), /2/);
    assert.match(copy.restartsAgents(1), /1/);
    assert.match(copy.sessionsCount(3), /3/);
    assert.match(copy.breadcrumb("X"), /X/);
    assert.match(copy.chatgptSub("Y"), /Y/);
  }
});

test("the accounts hub copy follows the UI language", () => {
  setLanguage("en");
  assert.equal(accountsHubCopy.groups.models, "Model access");
  assert.equal(accountsHubCopy.restartsAgents(2), "Briefly restarts 2 agents.");
  setLanguage("de");
  assert.equal(accountsHubCopy.groups.models, "Modell-Zugänge");
  assert.equal(accountsHubCopy.restartsAgents(2), "Startet 2 Agenten kurz neu.");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/unit/accounts-copy.test.js`
Expected: FAIL — `copy` is undefined (`Cannot read properties of undefined (reading 'intro')`).

- [ ] **Step 3: Add the copy**

Append to `web/lib/i18n/de/accounts.js`:

```js
export const accountsHubCopy = {
  intro:
    "Hier richtest du Zugänge einmal ein. Welcher Agent was nutzt, stellst du beim Agenten ein.",
  infoLabel: "Hinweis zu Accounts anzeigen",
  groups: {
    models: "Modell-Zugänge",
    services: "Dienste für Agenten",
    mcpServers: "MCP-Server",
    cli: "Native CLI-Accounts",
  },
  breadcrumb: (group) => `Accounts · ${group}`,
  selectHint: "Wähle links einen Eintrag.",
  loading: "Wird geladen …",
  sessionsOnly: "Sitzungen",
  sessionsCount: (count) => (count === 1 ? "1 Sitzung" : `${count} Sitzungen`),
  pipelineProfile: "Pipeline-Profil",
  usedByNone: "Noch nicht genutzt.",
  agentKinds: { agent: "Agent", teamMember: "Temporäres Teammitglied" },
  compatibleClis: "Kompatible CLIs",
  restartsAgents: (count) =>
    count === 1 ? "Startet 1 Agenten kurz neu." : `Startet ${count} Agenten kurz neu.`,
  replaceKey: "Ersetzen",
  connectionGroups: { connection: "Verbindung", test: "Test" },
  chatgptSub: (status) => `Für Agenten · ${status}`,
  chatgptConnectSub: "Anmeldung mit Gerätecode starten",
  speechProvider: "Deepgram",
  searchProviders: {
    duckduckgo: "DuckDuckGo",
    perplexity: "Perplexity",
    brave: "Brave Search",
  },
  notReady: "Nicht eingerichtet",
  cliFindsSub: "Einträge aus Claude Code, Codex und OpenCode übernehmen",
  accountActions: "Anmeldung und Standard",
};
```

Append to `web/lib/i18n/en/accounts.js`:

```js
export const accountsHubCopy = {
  intro:
    "Set up access here once. Which agent uses what is set in that agent's settings.",
  infoLabel: "Show note about accounts",
  groups: {
    models: "Model access",
    services: "Services for agents",
    mcpServers: "MCP servers",
    cli: "Native CLI accounts",
  },
  breadcrumb: (group) => `Accounts · ${group}`,
  selectHint: "Choose an entry on the left.",
  loading: "Loading …",
  sessionsOnly: "Sessions",
  sessionsCount: (count) => (count === 1 ? "1 session" : `${count} sessions`),
  pipelineProfile: "Pipeline profile",
  usedByNone: "Not in use yet.",
  agentKinds: { agent: "Agent", teamMember: "Temporary team member" },
  compatibleClis: "Compatible CLIs",
  restartsAgents: (count) =>
    count === 1 ? "Briefly restarts 1 agent." : `Briefly restarts ${count} agents.`,
  replaceKey: "Replace",
  connectionGroups: { connection: "Connection", test: "Test" },
  chatgptSub: (status) => `For agents · ${status}`,
  chatgptConnectSub: "Start a device-code sign-in",
  speechProvider: "Deepgram",
  searchProviders: {
    duckduckgo: "DuckDuckGo",
    perplexity: "Perplexity",
    brave: "Brave Search",
  },
  notReady: "Not configured",
  cliFindsSub: "Adopt entries from Claude Code, Codex and OpenCode",
  accountActions: "Sign-in and default",
};
```

Append to `web/lib/i18n/messages/accounts.js`:

```js
export const accountsHubCopy = localizedCopy(de.accountsHubCopy, en.accountsHubCopy);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/unit/accounts-copy.test.js tests/unit/i18n-catalogs.test.js tests/unit/i18n-terminology.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write web/lib/i18n/de/accounts.js web/lib/i18n/en/accounts.js web/lib/i18n/messages/accounts.js tests/unit/accounts-copy.test.js
git add web/lib/i18n/de/accounts.js web/lib/i18n/en/accounts.js web/lib/i18n/messages/accounts.js tests/unit/accounts-copy.test.js
git commit -m "feat: add the copy of the accounts hub" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Item resolution and usage presentation

Pure modules: which entry an address shows, its title, and how usage reads.

**Files:**

- Create: `web/features/accounts/accounts-items.js`, `web/features/accounts/account-usage-view.js`
- Test: `tests/unit/accounts-items.test.js`, `tests/unit/account-usage-view.test.js`

**Interfaces:**

- Consumes: `accountsHubCopy` (Task 1); `commonCopy.agentsCount`, `commonCopy.addAccount`; `connectionCopy.add`; `assistantCopy.accountsTitle`, `assistantCopy.speech.title`, `assistantCopy.webSearch.title`; `mcpServerCopy.add`; `mcpCliCopy.foundTitle`.
- Produces (`accounts-items.js`):
  - `itemRoute(section?, item?) => { view: "accounts", section?, item? }` (item only with a section).
  - `sectionLabel(section) => string` (group title).
  - `resolveAccountItem(route, data) => null | { kind, section, item, record }` where `data = { agentsEnabled: boolean | null, connections: array | null, chatgpt: array | null, mcpServers: array | null, accounts: array | null }` (`null` list = not loaded; `agentsEnabled: null` = feature still loading). Kinds: `connection`, `connection-new`, `chatgpt`, `chatgpt-login`, `speech`, `web-search`, `mcp-server`, `mcp-new`, `mcp-finds`, `cli-account`, `cli-new`, `loading`, `missing`. Reserved item ids: `new` (models, mcp-servers, cli), `chatgpt` (models), `speech`/`web-search` (services), `cli-finds` (mcp-servers); real ids are UUIDs or `openclaw:<hex>`, so they never collide.
  - `accountItemTitle(entry) => string`.
- Produces (`account-usage-view.js`):
  - `unknownUsage = "—"` (equals `unknownValue` of `ListRow.jsx`; that file is JSX and cannot be imported by node tests).
  - `usageEntry(usage, kind, id) => Usage | undefined` (a ChatGPT account missing from a loaded `chatgpt` map is unused, per the Step 0 contract that lists only referenced accounts).
  - `usageValue(entry) => string` — "—" when unknown, `agentsCount(n)` with agents, `sessionsOnly` with sessions only, `""` when unused.
  - `agentRoute(agent) => { view: "agents", assistantId, agentSettings: true, agentTab? }` (`via`: model → profile (no field), capability/binding → `capabilities`, pipelines → `work`, channel → `telegram`).
  - `restartNote(entry) => string` — `restartsAgents(n)` when the entry lists agents, else `""`.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/accounts-items.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { setLanguage } from "../../web/lib/i18n/index.js";
import {
  accountItemTitle,
  itemRoute,
  resolveAccountItem,
  sectionLabel,
} from "../../web/features/accounts/accounts-items.js";

const data = {
  agentsEnabled: true,
  connections: [{ id: "c1", name: "Router" }],
  chatgpt: [{ id: `openclaw:${"a".repeat(64)}`, name: "Personal" }],
  mcpServers: [{ id: "s1", name: "docs" }],
  accounts: [
    { id: "managed-1", name: "Work", tool: "codex" },
    { id: "local-shell", name: "Shell", tool: "shell" },
  ],
};
const at = (section, item, extra = data) =>
  resolveAccountItem({ view: "accounts", section, item }, extra);

test("the hub shows no entry without section and item", () => {
  assert.equal(resolveAccountItem({ view: "accounts" }, data), null);
  assert.equal(resolveAccountItem({ view: "accounts", section: "models" }, data), null);
});

test("entries resolve by section and item", () => {
  assert.equal(at("models", "c1").kind, "connection");
  assert.equal(at("models", "c1").record.name, "Router");
  assert.equal(at("models", "new").kind, "connection-new");
  assert.equal(at("models", "chatgpt").kind, "chatgpt-login");
  assert.equal(at("models", data.chatgpt[0].id).kind, "chatgpt");
  assert.equal(at("services", "speech").kind, "speech");
  assert.equal(at("services", "web-search").kind, "web-search");
  assert.equal(at("mcp-servers", "s1").kind, "mcp-server");
  assert.equal(at("mcp-servers", "new").kind, "mcp-new");
  assert.equal(at("mcp-servers", "cli-finds").kind, "mcp-finds");
  assert.equal(at("cli", "managed-1").kind, "cli-account");
  assert.equal(at("cli", "new").kind, "cli-new");
});

test("unknown or hidden entries are missing, unloaded ones loading", () => {
  assert.equal(at("models", "gone").kind, "missing");
  assert.equal(at("services", "other").kind, "missing");
  assert.equal(at("cli", "local-shell").kind, "missing");
  assert.equal(at("mcp-servers", "s1", { ...data, mcpServers: null }).kind, "loading");
  assert.equal(at("models", "c1", { ...data, connections: null }).kind, "loading");
  const off = { ...data, agentsEnabled: false };
  assert.equal(at("services", "speech", off).kind, "missing");
  assert.equal(at("models", "chatgpt", off).kind, "missing");
  assert.equal(at("models", data.chatgpt[0].id, off).kind, "missing");
  const pending = { ...data, agentsEnabled: null };
  assert.equal(at("services", "speech", pending).kind, "loading");
  assert.equal(at("mcp-servers", "s1", pending).kind, "mcp-server");
});

test("routes and titles", () => {
  assert.deepEqual(itemRoute(), { view: "accounts" });
  assert.deepEqual(itemRoute("cli"), { view: "accounts", section: "cli" });
  assert.deepEqual(itemRoute("cli", "new"), {
    view: "accounts",
    section: "cli",
    item: "new",
  });
  assert.deepEqual(itemRoute(undefined, "x"), { view: "accounts" });
  setLanguage("en");
  assert.equal(sectionLabel("mcp-servers"), "MCP servers");
  assert.equal(accountItemTitle(at("models", "c1")), "Router");
  assert.equal(accountItemTitle(at("services", "web-search")), "Web search");
  assert.equal(accountItemTitle(at("models", "chatgpt")), "ChatGPT for agents");
  assert.equal(accountItemTitle(at("cli", "new")), "Add account");
  setLanguage("de");
});
```

Create `tests/unit/account-usage-view.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { setLanguage } from "../../web/lib/i18n/index.js";
import {
  agentRoute,
  restartNote,
  unknownUsage,
  usageEntry,
  usageValue,
} from "../../web/features/accounts/account-usage-view.js";

const used = (agents = [], sessions = 0) => ({
  agents,
  sessions,
  pipelineProfiles: [],
  clis: [],
});
const home = { id: "home", name: "Home", kind: "agent", via: "model" };
const usage = {
  agentsEnabled: true,
  connections: { c1: used([home]) },
  chatgpt: {},
  mcpServers: { s1: used() },
  webSearch: used([{ ...home, via: "capability" }]),
  speech: null,
  cliAccounts: { a1: used([], 3) },
};

test("entries are unknown until usage arrived", () => {
  assert.equal(unknownUsage, "—");
  assert.equal(usageEntry(null, "connection", "c1"), undefined);
  assert.equal(usageEntry(usage, "connection", "c2"), undefined);
  assert.equal(usageEntry(usage, "speech"), undefined);
  assert.deepEqual(usageEntry(usage, "connection", "c1"), usage.connections.c1);
  assert.deepEqual(usageEntry(usage, "web-search"), usage.webSearch);
  assert.deepEqual(usageEntry(usage, "cli-account", "a1"), usage.cliAccounts.a1);
  assert.equal(usageEntry(usage, "connection-new", "new"), undefined);
  // ChatGPT accounts no agent references are absent from the map: known unused.
  assert.deepEqual(usageEntry(usage, "chatgpt", "openclaw:x"), used());
  assert.equal(usageEntry(null, "chatgpt", "openclaw:x"), undefined);
});

test("row values never show a made-up zero", () => {
  setLanguage("en");
  assert.equal(usageValue(undefined), "—");
  assert.equal(usageValue(usage.connections.c1), "1 agent");
  assert.equal(usageValue(used([home, { ...home, id: "b" }])), "2 agents");
  assert.equal(usageValue(usage.cliAccounts.a1), "Sessions");
  assert.equal(usageValue(usage.mcpServers.s1), "");
  assert.equal(restartNote(usage.connections.c1), "Briefly restarts 1 agent.");
  assert.equal(restartNote(usage.mcpServers.s1), "");
  assert.equal(restartNote(undefined), "");
  setLanguage("de");
});

test("agents open the settings tab that uses the entry", () => {
  const base = { view: "agents", assistantId: "home", agentSettings: true };
  assert.deepEqual(agentRoute(home), base);
  assert.deepEqual(agentRoute({ ...home, via: "capability" }), {
    ...base,
    agentTab: "capabilities",
  });
  assert.deepEqual(agentRoute({ ...home, via: "binding" }), {
    ...base,
    agentTab: "capabilities",
  });
  assert.deepEqual(agentRoute({ ...home, via: "pipelines" }), {
    ...base,
    agentTab: "work",
  });
  assert.deepEqual(agentRoute({ ...home, via: "channel" }), {
    ...base,
    agentTab: "telegram",
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/unit/accounts-items.test.js tests/unit/account-usage-view.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for both modules.

- [ ] **Step 3: Implement**

Create `web/features/accounts/accounts-items.js`:

```js
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { connectionCopy } from "../../lib/i18n/messages/connections.js";
import { assistantCopy } from "../../lib/i18n/messages/assistants.js";
import { mcpServerCopy } from "../../lib/i18n/messages/mcp-servers.js";
import { mcpCliCopy } from "../../lib/i18n/messages/mcp-cli.js";
import { accountsHubCopy } from "../../lib/i18n/messages/accounts.js";

// /accounts?section=<group>&item=<id>: the hub, or one entry's subpage.
export const itemRoute = (section, item) => ({
  view: "accounts",
  ...(section ? { section } : {}),
  ...(section && item ? { item } : {}),
});

const groupKeys = {
  models: "models",
  services: "services",
  "mcp-servers": "mcpServers",
  cli: "cli",
};
export const sectionLabel = (section) => accountsHubCopy.groups[groupKeys[section]] ?? "";

/**
 * The entry an address shows: null for the hub, `loading` while the list it needs is
 * unknown, `missing` for an id that does not exist (the page returns to the group).
 * Reserved ids: new, chatgpt, speech, web-search, cli-finds; real ids are UUIDs or
 * openclaw:<hex>.
 */
export function resolveAccountItem(route, data) {
  const { section, item } = route;
  if (!section || !item) return null;
  const at = (kind, record = null) => ({ kind, section, item, record });
  const lookup = (list, kind) => {
    if (!Array.isArray(list)) return at("loading");
    const record = list.find((entry) => entry.id === item);
    return record ? at(kind, record) : at("missing");
  };
  const withAgents = (resolve) =>
    data.agentsEnabled === null
      ? at("loading")
      : data.agentsEnabled
        ? resolve()
        : at("missing");
  if (section === "models") {
    if (item === "new") return at("connection-new");
    if (item === "chatgpt") return withAgents(() => at("chatgpt-login"));
    if (item.startsWith("openclaw:"))
      return withAgents(() => lookup(data.chatgpt, "chatgpt"));
    return lookup(data.connections, "connection");
  }
  if (section === "services")
    return withAgents(() =>
      item === "speech"
        ? at("speech")
        : item === "web-search"
          ? at("web-search")
          : at("missing"),
    );
  if (section === "mcp-servers") {
    if (item === "new") return at("mcp-new");
    if (item === "cli-finds") return at("mcp-finds");
    return lookup(data.mcpServers, "mcp-server");
  }
  if (section === "cli") {
    if (item === "new") return at("cli-new");
    return lookup(
      data.accounts?.filter((account) => account.tool !== "shell"),
      "cli-account",
    );
  }
  return null;
}

export function accountItemTitle(entry) {
  switch (entry?.kind) {
    case "connection":
    case "chatgpt":
    case "mcp-server":
    case "cli-account":
      return entry.record.name;
    case "connection-new":
      return connectionCopy.add;
    case "chatgpt-login":
      return assistantCopy.accountsTitle;
    case "speech":
      return assistantCopy.speech.title;
    case "web-search":
      return assistantCopy.webSearch.title;
    case "mcp-new":
      return mcpServerCopy.add;
    case "mcp-finds":
      return mcpCliCopy.foundTitle;
    case "cli-new":
      return commonCopy.addAccount;
    default:
      return "";
  }
}
```

Create `web/features/accounts/account-usage-view.js`:

```js
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { accountsHubCopy } from "../../lib/i18n/messages/accounts.js";

// Same text as ListRow's unknownValue (a JSX module node tests cannot import).
export const unknownUsage = "—";

const unusedUsage = Object.freeze({
  agents: [],
  sessions: 0,
  pipelineProfiles: [],
  clis: [],
});

const groups = {
  connection: "connections",
  chatgpt: "chatgpt",
  "mcp-server": "mcpServers",
  "cli-account": "cliAccounts",
};

/** One entry's usage from GET /accounts/usage; undefined while it is not known. */
export function usageEntry(usage, kind, id) {
  if (!usage || typeof usage !== "object") return undefined;
  if (kind === "speech") return usage.speech ?? undefined;
  if (kind === "web-search") return usage.webSearch ?? undefined;
  const group = usage[groups[kind]];
  if (!group || typeof group !== "object") return undefined;
  // The endpoint lists only ChatGPT accounts an agent's model references; once the
  // list arrived, a missing account is known to be unused (not unknown).
  if (kind === "chatgpt") return group[id] ?? unusedUsage;
  return group[id] ?? undefined;
}

export function usageValue(entry) {
  if (!entry) return unknownUsage;
  const agents = entry.agents?.length ?? 0;
  if (agents) return commonCopy.agentsCount(agents);
  if (entry.sessions > 0) return accountsHubCopy.sessionsOnly;
  return "";
}

const agentTabs = {
  capability: "capabilities",
  binding: "capabilities",
  pipelines: "work",
  channel: "telegram",
};

/** The agent settings tab where the agent chose this entry. */
export function agentRoute(agent) {
  const tab = agentTabs[agent.via];
  return {
    view: "agents",
    assistantId: agent.id,
    agentSettings: true,
    ...(tab ? { agentTab: tab } : {}),
  };
}

export function restartNote(entry) {
  const count = entry?.agents?.length ?? 0;
  return count ? accountsHubCopy.restartsAgents(count) : "";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/unit/accounts-items.test.js tests/unit/account-usage-view.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write web/features/accounts/accounts-items.js web/features/accounts/account-usage-view.js tests/unit/accounts-items.test.js tests/unit/account-usage-view.test.js
git add web/features/accounts/accounts-items.js web/features/accounts/account-usage-view.js tests/unit/accounts-items.test.js tests/unit/account-usage-view.test.js
git commit -m "feat: resolve accounts entries and their usage from the address" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Hub, layout, detail frame and data

Replaces the stacked page with `SettingsShell` + hub + detail pane. The registry starts empty; Tasks 4–8 register their details. Old section components stay in the tree until their task deletes them, unused.

**Files:**

- Rewrite: `web/features/accounts/AccountsPage.jsx`
- Create: `web/features/accounts/AccountsHub.jsx`, `McpServersGroup.jsx`, `AddLabel.jsx`, `AccountDetail.jsx`, `UsedByGroup.jsx`, `FieldRow.jsx`, `KeyField.jsx`, `useAccountsData.js`, `useAccountUsage.js`, `useNarrowViewport.js`, `useAccountDraft.js`, `useCreatedRedirect.js`, `useFieldSetter.js`, `account-details.js`, `accounts-page.css`; `web/features/provider-connections/connection-summary.js`; `web/features/mcp-servers/mcp-notices.js`
- Modify: `web/components/SaveBar.jsx` (prop `saveDisabled`), `web/app/App.jsx` (accounts props)
- Test: `tests/helpers/accounts-browser.js`, `tests/browser/providers-fixture.js` (usage answer), `tests/browser/accounts-hub.spec.js`

**Interfaces:**

- Consumes: Tasks 1–2; Step 0 components and hooks (see "Step 0 interfaces"); `useMcpOAuth`, `McpOAuthResultBanner` (`web/features/mcp-servers/McpOAuthLogin.jsx`); `useAccountAuthStatus`; `assistantApi.mcpServers/accounts/speech/webSearch`.
- Produces:
  - `AccountsPage({ state, ready, act, refresh, route, onNavigate, openNavigation, navigationOpen })`.
  - `detailComponents` (`account-details.js`): `{ [kind]: LazyComponent<DetailProps> }`, empty here.
  - `useAccountsData({ agentsEnabled }) => { mcpServers, mcpError, mcpGeneration, reloadMcp(), chatgpt, reloadChatgpt(), speech, setSpeech(next), reloadSpeech(), webSearch, setWebSearch(next), reloadWebSearch(), serviceError }`.
  - Conflict rule for every detail with a revision (speech, web search, MCP server): when `draft.outcome?.status === "conflict"` the detail re-reads its record (`reloadSpeech`, `reloadWebSearch`, `reloadMcp`) so the latest revision is known before "Overwrite anyway".
  - `useAccountUsage(signature) => usage | null`.
  - `useAccountDraft({ server, revisions, tab, entry, steps }) => form = { draft, sheet, save(), overwrite() }`. After a `"saved"` result it calls `draft.reset()` in an effect one render later (the refreshed record is in props by then), so typed keys/secret values are cleared even when the record's draft fields did not change (old dialogs cleared them with `setKey("")` or by closing).
  - `AccountDetail({ title, className?, destructive?, bar?, children })` — `<section class="accounts-detail" aria-labelledby=title>`; region named by the title.
  - `AccountSaveBar({ form, draft?, formRef?, saveLabel?, note?, saveDisabled?, saveFocusKey? })` — `SaveBar` + `UnsavedChangesSheet`; validates `formRef` (`reportValidity`) before saving.
  - `UsedByGroup({ usage, agentsEnabled, navigate, clis? })` where `clis = [{ tool, route }]` (`route` `undefined` = no route column).
  - `FieldRow({ label, help?, className?, children })`, `KeyField({ label, saved, savedText, value, onChange, disabled?, placeholder?, hint? })`.
  - `useCreatedRedirect({ created, draft, navigate, section })`, `useFieldSetter(draft, key) => (valueOrUpdater) => void`.
  - `AddLabel({ text })` — visible "+", accessible name `text`.
  - `connectionSummary(connection) => string[]` (moved verbatim from `ProviderConnections.jsx`).
  - `savedNotice(result) => string` (moved verbatim from `McpServersSettings.jsx`).
  - `SaveBar` new props `saveDisabled = false` (primary disabled while true) and `saveFocusKey?` (`data-focus-key` of the primary).
  - Browser helper `tests/helpers/accounts-browser.js`: `accountRow(page, name)`, `accountDetail(page)`, `saveBar(page)`, `openAccountItem(page, name) => detail`, `backToAccounts(page)`, `keyInput(scope, label)`.
  - `providers-fixture.js` `controls.usage` (default empty usage object) answers `GET /api/accounts/usage`.

- [ ] **Step 1: Add the browser helper and the fixture answer**

Create `tests/helpers/accounts-browser.js`:

```js
import { expect } from "@playwright/test";

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The hub entry (a link row) whose label starts with `name`. */
export const accountRow = (page, name) =>
  page
    .locator(".accounts-hub")
    .getByRole("link", { name: new RegExp(`^${escape(name)}`) });

/** The open detail subpage: the desktop pane or the phone subpage. */
export const accountDetail = (page) => page.locator(".accounts-detail");

/** The bottom save bar of the open detail. */
export const saveBar = (page) =>
  page.getByRole("region", { name: /^(Ungespeicherte Änderungen|Unsaved changes)$/ });

export async function openAccountItem(page, name) {
  await accountRow(page, name).first().click();
  await expect(accountDetail(page)).toBeVisible();
  return accountDetail(page);
}

/** Phones show the hub and a subpage one at a time; this returns to the hub. */
export async function backToAccounts(page) {
  const back = page.locator(".settings-shell-leading.back");
  if (await back.isVisible()) await back.click();
  await expect(page.locator(".accounts-hub")).toBeVisible();
}

/** A provider connection's key input; a saved key hides it behind "Replace". */
export async function keyInput(scope, label) {
  const replace = scope.getByRole("button", { name: /^(Ersetzen|Replace)$/ });
  if (await replace.count()) await replace.click();
  return scope.getByLabel(label, { exact: true });
}
```

In `tests/browser/providers-fixture.js`, add `usage: null,` to the `controls` object literal (next to `calls: []`), add above `export async function fixture`:

```js
const emptyUsage = {
  agentsEnabled: false,
  connections: {},
  chatgpt: {},
  mcpServers: {},
  webSearch: null,
  speech: null,
  cliAccounts: {},
};
```

and directly after the line `if (path === "/api/state") return route.fulfill({ json: state });` add:

```js
if (path === "/api/accounts/usage")
  return route.fulfill({ json: controls.usage ?? emptyUsage });
```

- [ ] **Step 2: Write the failing hub spec**

Create `tests/browser/accounts-hub.spec.js`:

```js
import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { fulfillEnabledAssistantFeature } from "../helpers/assistant-browser-fixture.js";
import { accountRow } from "../helpers/accounts-browser.js";
import { fixture } from "./providers-fixture.js";

test.use({ locale: "en-GB" });

const connection = {
  id: "c1",
  name: "Shared router",
  providerId: "openrouter",
  hasSecret: true,
  launchable: true,
  tools: ["codex", "claude", "opencode"],
};
const used = (agents) => ({ agents, sessions: 0, pipelineProfiles: [], clis: [] });

async function setup(page, { agents = true, usage = "ok" } = {}) {
  const controls = await fixture(page);
  controls.state.providerConnections = [connection];
  controls.state.accounts = [
    { id: "managed-codex", name: "Work Codex", tool: "codex", kind: "managed" },
  ];
  controls.usage = {
    agentsEnabled: agents,
    connections: {
      c1: used([{ id: "home", name: "Home", kind: "agent", via: "model" }]),
    },
    chatgpt: {},
    mcpServers: {},
    webSearch: agents ? used([]) : null,
    speech: agents ? used([]) : null,
    cliAccounts: {},
  };
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  if (agents)
    await page.route("**/api/assistant-feature", (route) =>
      fulfillEnabledAssistantFeature(route),
    );
  if (usage === "fail")
    await page.route("**/api/accounts/usage", (route) =>
      route.fulfill({ status: 500, json: { error: "usage down" } }),
    );
  return controls;
}

test("the hub lists the four groups with usage", async ({ page }) => {
  await setup(page);
  await page.goto(baseURL + "/accounts");
  for (const name of [
    "Model access",
    "Services for agents",
    "MCP servers",
    "Native CLI accounts",
  ])
    await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await expect(accountRow(page, "Shared router")).toContainText("1 agent");
  await expect(accountRow(page, "Shared router")).toContainText("OpenRouter");
  await expect(accountRow(page, "Speech recognition")).toBeVisible();
  await expect(accountRow(page, "Web search")).toContainText("DuckDuckGo");
  await expect(accountRow(page, "ChatGPT for agents")).toBeVisible();
  await expect(accountRow(page, "Work Codex")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Add provider connection", exact: true }),
  ).toBeVisible();
});

test("usage stays unknown when the endpoint fails", async ({ page }) => {
  await setup(page, { usage: "fail" });
  await page.goto(baseURL + "/accounts");
  await expect(accountRow(page, "Shared router")).toContainText("—");
  await expect(accountRow(page, "Shared router")).not.toContainText("0");
});

test("without agents the services group is hidden and no agent request is made", async ({
  page,
}) => {
  const controls = await setup(page, { agents: false });
  await page.goto(baseURL + "/accounts");
  await expect(
    page.getByRole("heading", { name: "MCP servers", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Services for agents" })).toHaveCount(0);
  await expect(accountRow(page, "ChatGPT for agents")).toHaveCount(0);
  expect(
    controls.calls
      .map((call) => call.path)
      .filter(
        (path) => path.startsWith("/api/assistant") && path !== "/api/assistant-feature",
      ),
  ).toEqual([]);
});

test("the header note is a disclosure with the stored-locally text", async ({ page }) => {
  await setup(page);
  await page.goto(baseURL + "/accounts");
  const button = page.getByRole("button", { name: "Show note about accounts" });
  await expect(button).toHaveAttribute("aria-expanded", "false");
  const panel = page.locator(`#${await button.getAttribute("aria-controls")}`);
  await expect(panel).toBeHidden();
  await button.click();
  await expect(button).toHaveAttribute("aria-expanded", "true");
  await expect(panel).toContainText("Everything stays on your computer.");
  await expect(panel).toContainText("Separate profiles have their own sign-in");
  await expect(page.getByText("Stored locally").first()).toBeVisible();
});

test("an unknown item returns to its group once", async ({ page }) => {
  await setup(page);
  await page.goto(baseURL + "/accounts?section=models&item=gone");
  await expect(page).toHaveURL(`${baseURL}/accounts?section=models`);
  await expect(accountRow(page, "Shared router")).toBeVisible();
});

test("phones show the hub with the sidebar button and the intro", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await page.goto(baseURL + "/accounts");
  await expect(page.getByRole("button", { name: "Open navigation" })).toBeVisible();
  await expect(page.locator(".mobile-header")).toBeHidden();
  await expect(
    page.getByText("Set up access here once.", { exact: false }).first(),
  ).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
});

test("the extensions link lands on the MCP group", async ({ page }) => {
  await setup(page, { agents: false });
  await page.goto(baseURL + "/accounts?section=mcp-servers");
  await expect(page.getByRole("region", { name: "MCP servers" })).toBeInViewport();
  await expect(accountRow(page, "Found in the CLIs")).toBeVisible();
});
```

Note: `mobileHeaderCopy.iconButtonAriaLabel` is "Open navigation" in English (verify with `grep -n iconButtonAriaLabel web/lib/i18n/en/app.js`; use that exact text if it differs).

- [ ] **Step 3: Run the spec to verify it fails**

Run: `npm run build && npx playwright test tests/browser/accounts-hub.spec.js`
Expected: FAIL — headings "Model access" etc. are not found (old page).

- [ ] **Step 4: Add the small building blocks**

`web/components/SaveBar.jsx`: add `saveDisabled = false,` and `saveFocusKey,` to the destructured props (after `note,`), change the primary button's `disabled={draft.saving || !draft.dirty}` to `disabled={draft.saving || !draft.dirty || saveDisabled}` and give the primary button `data-focus-key={saveFocusKey}`. Add to the component comment: "`saveDisabled` keeps the primary disabled while the form is not savable (e.g. a required key re-entry); `saveFocusKey` lets an inline confirmation (`useAlertDialogFocus(onCancel, returnKey)`) return focus to the primary, also in WebKit where a clicked button never had focus."

Create `web/features/provider-connections/connection-summary.js` (moved from `ProviderConnections.jsx`, unchanged logic):

```js
import { connectionCopy as copy } from "../../lib/i18n/messages/connections.js";

function endpointHost(connection) {
  const url = connection.endpoint?.openaiBaseUrl || connection.endpoint?.anthropicBaseUrl;
  if (!url) return "";
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/** Provider · endpoint host · key state, as the connection list shows it. */
export function connectionSummary(connection) {
  return [
    copy.providerNames[connection.providerId] || connection.providerId,
    endpointHost(connection),
    connection.hasSecret
      ? copy.keySaved
      : connection.launchable
        ? copy.keyNotRequired
        : copy.keyMissing,
  ].filter(Boolean);
}
```

Create `web/features/mcp-servers/mcp-notices.js` (moved from `McpServersSettings.jsx`):

```js
import { mcpOAuthCopy } from "../../lib/i18n/messages/mcp-oauth.js";
import { mcpServerCopy as copy } from "../../lib/i18n/messages/mcp-servers.js";

/** A saved change's notices: a pending apply and a deferred OAuth logout. */
export const savedNotice = (saved) =>
  [
    saved?.pending ? copy.pendingNotice : "",
    saved?.oauthWarning?.code === "oauth-logout-deferred"
      ? mcpOAuthCopy.logoutDeferred
      : "",
  ]
    .filter(Boolean)
    .join(" ");
```

Create `web/features/accounts/AddLabel.jsx`:

```jsx
import React from "react";

// The "+" of a group label; screen readers hear what it adds.
export default function AddLabel({ text }) {
  return (
    <>
      <span aria-hidden="true">+</span>
      <span className="visually-hidden">{text}</span>
    </>
  );
}
```

Create `web/features/accounts/FieldRow.jsx`:

```jsx
import React from "react";

// A labelled input inside a list card; the help line sits outside the label so the
// input's accessible name stays the label text alone.
export default function FieldRow({ label, help, className = "", children }) {
  return (
    <div className={["field-row", className].filter(Boolean).join(" ")}>
      <label>
        <span className="field-row-label">{label}</span>
        {children}
      </label>
      {help && <p className="field-row-help">{help}</p>}
    </div>
  );
}
```

Create `web/features/accounts/KeyField.jsx`:

```jsx
import React, { useState } from "react";
import { InfoHintButton, InfoHintText, useInfoHint } from "../../components/InfoHint.jsx";
import { accountsHubCopy } from "../../lib/i18n/messages/accounts.js";

// A stored key shows as a status line with "Replace"; the input appears on demand.
export default function KeyField({
  label,
  saved,
  savedText,
  value,
  onChange,
  disabled = false,
  placeholder,
  hint,
}) {
  const [replacing, setReplacing] = useState(false);
  const info = useInfoHint();
  const editing = !saved || replacing || value !== "";
  return (
    <div className="field-row key-field">
      <div className="key-field-line">
        {editing ? (
          <label>
            <span className="field-row-label">{label}</span>
            <input
              type="password"
              autoComplete="new-password"
              value={value}
              disabled={disabled}
              placeholder={placeholder}
              autoFocus={replacing}
              onChange={(event) => onChange(event.target.value)}
            />
          </label>
        ) : (
          <div className="key-field-status">
            <span className="field-row-label">{label}</span>
            <span className="key-field-saved">{savedText}</span>
            <button
              type="button"
              className="button secondary compact"
              disabled={disabled}
              onClick={() => setReplacing(true)}
            >
              {accountsHubCopy.replaceKey}
            </button>
          </div>
        )}
        {hint && <InfoHintButton hint={info} />}
      </div>
      {hint && <InfoHintText hint={info}>{hint}</InfoHintText>}
    </div>
  );
}
```

Create `web/features/accounts/useFieldSetter.js`:

```js
import { useCallback, useRef } from "react";

/**
 * A setter for one draft field that also accepts an updater, like useState's. Several
 * updates before the next render compose (the endpoint editors rely on that).
 */
export default function useFieldSetter(draft, key) {
  const latest = useRef(draft.values[key]);
  latest.current = draft.values[key];
  const set = draft.set;
  return useCallback(
    (update) => {
      const next = typeof update === "function" ? update(latest.current) : update;
      latest.current = next;
      set(key, next);
    },
    [key, set],
  );
}
```

Create `web/features/accounts/useNarrowViewport.js`:

```js
import { useSyncExternalStore } from "react";

const query = "(max-width: 700px)";
const subscribe = (notify) => {
  const list = window.matchMedia(query);
  list.addEventListener("change", notify);
  return () => list.removeEventListener("change", notify);
};

/** Phones show the hub and an entry's subpage one at a time. */
export default function useNarrowViewport() {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}
```

Create `web/features/accounts/useAccountUsage.js`:

```js
import { useEffect, useState } from "react";
import api from "../../lib/api.js";

/** "Used by" for every entry; null while unknown or when the request failed. */
export default function useAccountUsage(signature) {
  const [usage, setUsage] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    api("/accounts/usage", "GET", undefined, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted)
          setUsage(result && typeof result === "object" ? result : null);
      })
      .catch(() => {
        if (!controller.signal.aborted) setUsage(null);
      });
    return () => controller.abort();
  }, [signature]);
  return usage;
}
```

Create `web/features/accounts/useAccountsData.js`:

```js
import { useCallback, useEffect, useRef, useState } from "react";
import { assistantApi } from "../assistants/assistant-api.js";

/**
 * What the hub lists besides /api/state: the central MCP servers (always) and, with
 * agents, the ChatGPT accounts, speech and web search settings. The newest load of the
 * ChatGPT accounts wins over an older one still in flight.
 */
export default function useAccountsData({ agentsEnabled }) {
  const [mcpServers, setMcpServers] = useState(null);
  const [mcpError, setMcpError] = useState("");
  const [mcpGeneration, setMcpGeneration] = useState(0);
  const [chatgpt, setChatgpt] = useState(null);
  const [speech, setSpeech] = useState(null);
  const [webSearch, setWebSearch] = useState(null);
  const [serviceError, setServiceError] = useState("");
  const chatgptLoad = useRef(null);
  const reloadMcp = useCallback(async () => {
    try {
      setMcpServers(await assistantApi.mcpServers());
      setMcpError("");
    } catch (error) {
      setMcpError(error.message);
    } finally {
      // The CLI finds load again with every reload, also after a failed one.
      setMcpGeneration((value) => value + 1);
    }
  }, []);
  useEffect(() => {
    reloadMcp();
  }, [reloadMcp]);
  const reloadChatgpt = useCallback(async () => {
    const load = {};
    chatgptLoad.current = load;
    const result = await assistantApi.accounts();
    if (chatgptLoad.current === load) setChatgpt(result.accounts);
  }, []);
  // A detail re-reads its settings after a 409 so "Overwrite anyway" sends the newer
  // revision.
  const reloadSpeech = useCallback(async () => {
    try {
      setSpeech(await assistantApi.speech());
    } catch (error) {
      setServiceError(error.message);
    }
  }, []);
  const reloadWebSearch = useCallback(async () => {
    try {
      setWebSearch(await assistantApi.webSearch());
    } catch (error) {
      setServiceError(error.message);
    }
  }, []);
  useEffect(() => {
    if (!agentsEnabled) return undefined;
    const controller = new AbortController();
    const fail = (error) => {
      if (!controller.signal.aborted) setServiceError(error.message);
    };
    reloadChatgpt().catch(fail);
    assistantApi
      .speech(controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) setSpeech(next);
      })
      .catch(fail);
    assistantApi
      .webSearch(controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) setWebSearch(next);
      })
      .catch(fail);
    return () => {
      controller.abort();
      chatgptLoad.current = null;
    };
  }, [agentsEnabled, reloadChatgpt]);
  return {
    mcpServers,
    mcpError,
    mcpGeneration,
    reloadMcp,
    chatgpt,
    reloadChatgpt,
    speech,
    setSpeech,
    reloadSpeech,
    webSearch,
    setWebSearch,
    reloadWebSearch,
    serviceError,
  };
}
```

Create `web/features/accounts/useAccountDraft.js`:

```js
import { useCallback, useEffect, useRef, useState } from "react";
import useTabDraft from "../../lib/settings/useTabDraft.js";
import useUnsavedChangesGuard from "../../lib/settings/useUnsavedChangesGuard.js";

/**
 * One entry's draft and its unsaved-changes guard. Navigations that keep the same
 * entry on screen never ask; the steps are read at save time. After a full save the
 * draft restarts from the server record (one render later, when the refreshed record
 * has arrived), so typed keys and secret values never stay in the form and a
 * "remove key" checkbox does not stay ticked when the record itself did not change.
 */
export default function useAccountDraft({ server, revisions, tab, entry, steps }) {
  const draft = useTabDraft({ server, revisions });
  const current = useRef(steps);
  current.current = steps;
  const [savedCount, setSavedCount] = useState(0);
  const { save: saveDraft, overwrite: overwriteDraft, reset } = draft;
  const settle = useCallback((result) => {
    if (result?.status === "saved") setSavedCount((value) => value + 1);
    return result;
  }, []);
  const save = useCallback(
    async () => settle(await saveDraft(current.current)),
    [saveDraft, settle],
  );
  const overwrite = useCallback(
    async () => settle(await overwriteDraft(current.current)),
    [overwriteDraft, settle],
  );
  useEffect(() => {
    if (savedCount) reset();
  }, [savedCount, reset]);
  const sheet = useUnsavedChangesGuard({
    draft,
    tab,
    save,
    stays: (request) =>
      request.next?.view === "accounts" &&
      request.next.section === entry.section &&
      request.next.item === entry.item,
  });
  return { draft, sheet, save, overwrite };
}
```

Create `web/features/accounts/useCreatedRedirect.js`:

```js
import { useEffect } from "react";
import { itemRoute } from "./accounts-items.js";

/** After a create, show the new entry in place of the empty form (Back skips it). */
export default function useCreatedRedirect({ created, draft, navigate, section }) {
  useEffect(() => {
    if (created && !draft.dirty) navigate(itemRoute(section, created), true);
  }, [created, draft.dirty, navigate, section]);
}
```

Create `web/features/accounts/AccountDetail.jsx`:

```jsx
import React, { useId } from "react";
import SaveBar from "../../components/SaveBar.jsx";
import UnsavedChangesSheet from "../../components/UnsavedChangesSheet.jsx";

// One entry's subpage: a region named by its title, its groups, the destructive
// action at the bottom and the save bar.
export default function AccountDetail({
  title,
  className = "",
  destructive,
  bar,
  children,
}) {
  const id = useId();
  return (
    <section
      className={["accounts-detail", className].filter(Boolean).join(" ")}
      aria-labelledby={`${id}-title`}
    >
      <h2 id={`${id}-title`} className="accounts-detail-title">
        {title}
      </h2>
      {children}
      {destructive && <div className="accounts-detail-danger">{destructive}</div>}
      {bar}
    </section>
  );
}

export function AccountSaveBar({
  form,
  draft = form.draft,
  formRef,
  saveLabel,
  note,
  saveDisabled = false,
  saveFocusKey,
}) {
  const save = () => {
    if (formRef?.current && !formRef.current.reportValidity()) return;
    form.save();
  };
  return (
    <>
      <SaveBar
        draft={draft}
        onSave={save}
        onOverwrite={form.overwrite}
        saveLabel={saveLabel}
        note={note}
        saveDisabled={saveDisabled}
        saveFocusKey={saveFocusKey}
      />
      <UnsavedChangesSheet {...form.sheet} />
    </>
  );
}
```

Create `web/features/accounts/UsedByGroup.jsx`:

```jsx
import React, { useId } from "react";
import GroupLabel from "../../components/GroupLabel.jsx";
import ListCard from "../../components/ListCard.jsx";
import ListRow, { unknownValue } from "../../components/ListRow.jsx";
import { routePath } from "../../app/routes.js";
import { names } from "../../lib/providers.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { connectionCopy } from "../../lib/i18n/messages/connections.js";
import { accountsHubCopy as copy } from "../../lib/i18n/messages/accounts.js";
import { routeLabel } from "../provider-connections/route-label.js";
import { agentRoute } from "./account-usage-view.js";

const initial = (name) => (name || "?").slice(0, 1).toUpperCase();

/**
 * "Used by": agents (each opens the settings tab that chose this entry), sessions and
 * pipeline profiles; for provider access also the compatible CLIs with their route.
 * Without agents only sessions, profiles and CLIs are listed.
 */
export default function UsedByGroup({ usage, agentsEnabled, navigate, clis }) {
  const id = useId();
  const agents = agentsEnabled ? (usage?.agents ?? []) : [];
  const rows = [
    ...agents.map((agent) => {
      const route = agentRoute(agent);
      return (
        <ListRow
          key={`agent-${agent.id}`}
          icon={<span className="accounts-avatar">{initial(agent.name)}</span>}
          label={agent.name}
          sub={copy.agentKinds[agent.kind] ?? copy.agentKinds.agent}
          href={routePath(route)}
          onClick={() => navigate(route)}
        />
      );
    }),
    ...((usage?.sessions ?? 0) > 0
      ? [<ListRow key="sessions" label={copy.sessionsCount(usage.sessions)} />]
      : []),
    ...(usage?.pipelineProfiles ?? []).map((profile) => (
      <ListRow
        key={`profile-${profile.id}`}
        label={profile.name}
        sub={copy.pipelineProfile}
      />
    )),
  ];
  return (
    <>
      <section className="accounts-detail-group" aria-labelledby={`${id}-used`}>
        <GroupLabel id={`${id}-used`}>{commonCopy.usedBy}</GroupLabel>
        {usage === undefined ? (
          <ListCard labelledBy={`${id}-used`}>
            <ListRow label={commonCopy.usedBy} value={unknownValue} />
          </ListCard>
        ) : rows.length ? (
          <ListCard labelledBy={`${id}-used`}>{rows}</ListCard>
        ) : (
          <p className="accounts-note">{copy.usedByNone}</p>
        )}
      </section>
      {clis && (
        <section className="accounts-detail-group" aria-labelledby={`${id}-clis`}>
          <GroupLabel id={`${id}-clis`}>{copy.compatibleClis}</GroupLabel>
          {clis.length ? (
            <ListCard labelledBy={`${id}-clis`}>
              {clis.map(({ tool, route }) => (
                <ListRow
                  key={tool}
                  label={names[tool] ?? tool}
                  value={route === undefined ? undefined : routeLabel(route)}
                />
              ))}
            </ListCard>
          ) : (
            <p className="accounts-note">{connectionCopy.noCompatible}</p>
          )}
        </section>
      )}
    </>
  );
}
```

Create `web/features/accounts/account-details.js`:

```js
// Detail subpages by entry kind (see accounts-items.js). Each detail is loaded on
// demand, so agent modules and their requests stay out of /accounts while agents are
// off. Every component receives the DetailProps documented in AccountsPage.jsx.
export const detailComponents = {};
```

- [ ] **Step 5: Add the hub and the MCP group**

Create `web/features/accounts/McpServersGroup.jsx`:

```jsx
import React, { useEffect, useId, useRef, useState } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import GroupLabel from "../../components/GroupLabel.jsx";
import ListCard from "../../components/ListCard.jsx";
import ListRow from "../../components/ListRow.jsx";
import { routePath } from "../../app/routes.js";
import { mcpCliCopy as cliCopy } from "../../lib/i18n/messages/mcp-cli.js";
import { mcpOAuthCopy } from "../../lib/i18n/messages/mcp-oauth.js";
import { mcpServerCopy as copy } from "../../lib/i18n/messages/mcp-servers.js";
import { accountsHubCopy as hubCopy } from "../../lib/i18n/messages/accounts.js";
import { McpOAuthResultBanner } from "../mcp-servers/McpOAuthLogin.jsx";
import AddLabel from "./AddLabel.jsx";
import { itemRoute } from "./accounts-items.js";
import { usageEntry, usageValue } from "./account-usage-view.js";
import "../mcp-servers/mcp-servers.css";
import "../mcp-servers/mcp-cli.css";

/**
 * The central MCP servers: restart note, the OAuth result a login brought back, the
 * list's notices, one row per server and the CLI finds. The extensions link and an
 * OAuth result scroll this group into view.
 */
export default function McpServersGroup({
  servers,
  error,
  notice,
  oauth,
  oauthResult,
  focus,
  usage,
  selected,
  navigate,
}) {
  const id = useId();
  const ref = useRef(null);
  const [resultShown, setResultShown] = useState(true);
  useEffect(() => {
    if (!oauthResult) return;
    setResultShown(true);
    ref.current?.scrollIntoView?.({ block: "start" });
  }, [oauthResult]);
  useEffect(() => {
    if (focus) ref.current?.scrollIntoView?.({ block: "start" });
  }, [focus]);
  const open = (item) => {
    const route = itemRoute("mcp-servers", item);
    return { href: routePath(route), onClick: () => navigate(route) };
  };
  const current = (item) =>
    selected?.section === "mcp-servers" && selected.item === item ? "is-selected" : "";
  return (
    <section className="accounts-group" aria-labelledby={`${id}-label`} ref={ref}>
      <GroupLabel
        id={`${id}-label`}
        hint={copy.description}
        action={{
          label: <AddLabel text={copy.add} />,
          onClick: () => navigate(itemRoute("mcp-servers", "new")),
        }}
      >
        {copy.title}
      </GroupLabel>
      <p className="accounts-note">{cliCopy.restartNote}</p>
      {oauthResult && resultShown && (
        <McpOAuthResultBanner
          result={oauthResult}
          servers={servers}
          onDismiss={() => setResultShown(false)}
        />
      )}
      <ErrorMessage error={error} />
      {oauth.originBlocked && (
        <p role="status" className="mcp-notice">
          {mcpOAuthCopy.originBlocked}
        </p>
      )}
      {notice && (
        <p role="status" className="mcp-hint">
          {notice}
        </p>
      )}
      {servers && !servers.length && <p className="accounts-note">{copy.empty}</p>}
      <ListCard labelledBy={`${id}-label`}>
        {(servers || []).map((server) => (
          <ListRow
            key={server.id}
            label={server.name}
            sub={
              <>
                {copy.transports[server.transport]}
                {server.transport === "stdio" && (
                  <span className="list-row-pill">{copy.stdioBadge}</span>
                )}
              </>
            }
            value={usageValue(usageEntry(usage, "mcp-server", server.id))}
            className={current(server.id)}
            {...open(server.id)}
          />
        ))}
        <ListRow
          label={cliCopy.foundTitle}
          sub={hubCopy.cliFindsSub}
          className={current("cli-finds")}
          {...open("cli-finds")}
        />
      </ListCard>
    </section>
  );
}
```

Create `web/features/accounts/AccountsHub.jsx`:

```jsx
import React, { useId } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import GroupLabel from "../../components/GroupLabel.jsx";
import ListCard from "../../components/ListCard.jsx";
import ListRow, { unknownValue } from "../../components/ListRow.jsx";
import ProviderMark from "../../components/ProviderMark.jsx";
import { routePath } from "../../app/routes.js";
import { names } from "../../lib/providers.js";
import {
  accountsHubCopy as hubCopy,
  accountsPageCopy as copy,
} from "../../lib/i18n/messages/accounts.js";
import { assistantCopy } from "../../lib/i18n/messages/assistants.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { connectionCopy } from "../../lib/i18n/messages/connections.js";
import { connectionSummary } from "../provider-connections/connection-summary.js";
import useAccountAuthStatus from "./useAccountAuthStatus.js";
import McpServersGroup from "./McpServersGroup.jsx";
import AddLabel from "./AddLabel.jsx";
import { itemRoute } from "./accounts-items.js";
import { usageEntry, usageValue } from "./account-usage-view.js";

function HubGroup({ title, hint, action, children }) {
  const id = useId();
  return (
    <section className="accounts-group" aria-labelledby={`${id}-label`}>
      <GroupLabel id={`${id}-label`} hint={hint} action={action}>
        {title}
      </GroupLabel>
      {typeof children === "function" ? children(`${id}-label`) : children}
    </section>
  );
}

function ItemRow({ section, id, selected, navigate, ...row }) {
  const route = itemRoute(section, id);
  const current = selected?.section === section && selected.item === id;
  return (
    <ListRow
      {...row}
      href={routePath(route)}
      onClick={() => navigate(route)}
      className={current ? "is-selected" : ""}
    />
  );
}

// A local profile appears once its CLI login is confirmed (polled every 10 s).
function NativeAccountRow({ account, state, usage, selected, navigate }) {
  const auth = useAccountAuthStatus(account);
  if (account.kind === "local" && auth !== "authenticated") return null;
  const isDefault =
    (state.defaultAccountIds?.[account.tool] || `local-${account.tool}`) === account.id;
  const description =
    account.kind === "local"
      ? copy.localProfileDescription
      : account.hasSecret
        ? copy.managedProfileWithKey
        : copy.managedProfileDescription;
  return (
    <ItemRow
      section="cli"
      id={account.id}
      selected={selected}
      navigate={navigate}
      icon={<ProviderMark tool={account.tool} />}
      label={account.name}
      sub={[names[account.tool], description, isDefault ? copy.defaultAccount : ""]
        .filter(Boolean)
        .join(" · ")}
      value={
        account.kind === "local"
          ? commonCopy.local
          : usageValue(usageEntry(usage, "cli-account", account.id))
      }
    />
  );
}

export default function AccountsHub({
  state,
  data,
  usage,
  agentsEnabled,
  selected,
  navigate,
  oauth,
  oauthResult,
  mcpNotice,
  focusMcp,
}) {
  const connections = state.providerConnections || [];
  const accounts = (state.accounts || []).filter((account) => account.tool !== "shell");
  const row = { selected, navigate };
  const speech = assistantCopy.speech;
  const webSearch = assistantCopy.webSearch;
  return (
    <div className="accounts-hub">
      <p className="accounts-intro">{hubCopy.intro}</p>
      <HubGroup
        title={hubCopy.groups.models}
        hint={connectionCopy.description}
        action={{
          label: <AddLabel text={connectionCopy.add} />,
          onClick: () => navigate(itemRoute("models", "new")),
        }}
      >
        {(labelId) => (
          <>
            {agentsEnabled && <ErrorMessage error={data.serviceError} />}
            {!connections.length && (
              <p className="accounts-note">{connectionCopy.empty}</p>
            )}
            <ListCard labelledBy={labelId}>
              {connections.map((connection) => (
                <ItemRow
                  key={connection.id}
                  section="models"
                  id={connection.id}
                  {...row}
                  label={connection.name}
                  sub={connectionSummary(connection).join(" · ")}
                  value={usageValue(usageEntry(usage, "connection", connection.id))}
                />
              ))}
              {agentsEnabled &&
                (data.chatgpt || []).map((account) => (
                  <ItemRow
                    key={account.id}
                    section="models"
                    id={account.id}
                    {...row}
                    label={account.name}
                    sub={hubCopy.chatgptSub(
                      assistantCopy.accountStatus[account.status] ||
                        assistantCopy.accountStatus.unknown,
                    )}
                    value={usageValue(usageEntry(usage, "chatgpt", account.id))}
                  />
                ))}
              {agentsEnabled && (
                <ItemRow
                  section="models"
                  id="chatgpt"
                  {...row}
                  label={assistantCopy.accountsTitle}
                  sub={hubCopy.chatgptConnectSub}
                />
              )}
            </ListCard>
          </>
        )}
      </HubGroup>
      {agentsEnabled && (
        <HubGroup title={hubCopy.groups.services}>
          {(labelId) => (
            <ListCard labelledBy={labelId}>
              <ItemRow
                section="services"
                id="speech"
                {...row}
                label={speech.title}
                sub={
                  data.speech
                    ? `${hubCopy.speechProvider} · ${data.speech.hasSecret ? speech.saved : speech.missing}`
                    : unknownValue
                }
                value={usageValue(usageEntry(usage, "speech"))}
              />
              <ItemRow
                section="services"
                id="web-search"
                {...row}
                label={webSearch.title}
                sub={
                  data.webSearch
                    ? `${hubCopy.searchProviders[data.webSearch.provider] ?? data.webSearch.provider} · ${data.webSearch.ready ? webSearch.ready : hubCopy.notReady}`
                    : unknownValue
                }
                value={usageValue(usageEntry(usage, "web-search"))}
              />
            </ListCard>
          )}
        </HubGroup>
      )}
      <McpServersGroup
        servers={data.mcpServers}
        error={data.mcpError}
        notice={mcpNotice}
        oauth={oauth}
        oauthResult={oauthResult}
        focus={focusMcp}
        usage={usage}
        selected={selected}
        navigate={navigate}
      />
      <HubGroup
        title={hubCopy.groups.cli}
        action={{
          label: <AddLabel text={commonCopy.addAccount} />,
          onClick: () => navigate(itemRoute("cli", "new")),
        }}
      >
        {(labelId) => (
          <ListCard labelledBy={labelId}>
            {accounts.map((account) => (
              <NativeAccountRow
                key={account.id}
                account={account}
                state={state}
                usage={usage}
                {...row}
              />
            ))}
          </ListCard>
        )}
      </HubGroup>
    </div>
  );
}
```

- [ ] **Step 6: Rewrite the page and wire it**

Replace `web/features/accounts/AccountsPage.jsx` with:

```jsx
import React, { Suspense, useEffect, useState } from "react";
import SettingsShell from "../../components/SettingsShell.jsx";
import Icon from "../../components/Icon.jsx";
import { InfoHintButton, InfoHintText, useInfoHint } from "../../components/InfoHint.jsx";
import {
  accountsHubCopy as hubCopy,
  accountsPageCopy as copy,
} from "../../lib/i18n/messages/accounts.js";
import useAssistantFeature from "../assistants/useAssistantFeature.js";
import { useMcpOAuth } from "../mcp-servers/McpOAuthLogin.jsx";
import AccountsHub from "./AccountsHub.jsx";
import { detailComponents } from "./account-details.js";
import {
  accountItemTitle,
  itemRoute,
  resolveAccountItem,
  sectionLabel,
} from "./accounts-items.js";
import { usageEntry } from "./account-usage-view.js";
import useAccountUsage from "./useAccountUsage.js";
import useAccountsData from "./useAccountsData.js";
import useNarrowViewport from "./useNarrowViewport.js";
import "./accounts-page.css";

const ids = (list) => (list || []).map((item) => item.id);

/**
 * Accounts: a hub of four groups (models, services for agents, MCP servers, native CLI
 * accounts); each entry opens as a subpage (phones) or in the detail pane (desktop).
 * Detail components receive DetailProps:
 * { entry, usage, agentsEnabled, state, data, refresh, navigate, act, oauth, notifyMcp }.
 */
export default function AccountsPage({
  state,
  ready = true,
  act,
  refresh,
  route,
  onNavigate,
  openNavigation,
  navigationOpen = false,
}) {
  const feature = useAssistantFeature();
  const agentsEnabled = feature.loading ? null : Boolean(feature.enabled);
  const data = useAccountsData({ agentsEnabled: agentsEnabled === true });
  const [mcpNotice, setMcpNotice] = useState("");
  const oauth = useMcpOAuth({ reload: data.reloadMcp, notify: setMcpNotice });
  const usage = useAccountUsage(
    JSON.stringify([
      agentsEnabled,
      ids(state.providerConnections),
      ids(state.accounts),
      (data.mcpServers || []).map((server) => [server.id, server.revision]),
      ids(data.chatgpt),
      data.speech?.revision,
      data.webSearch?.revision,
    ]),
  );
  const entry = resolveAccountItem(route, {
    agentsEnabled,
    connections: ready ? (state.providerConnections ?? null) : null,
    accounts: ready ? state.accounts : null,
    chatgpt: data.chatgpt,
    mcpServers: data.mcpServers,
  });
  const narrow = useNarrowViewport();
  const info = useInfoHint();
  const missing = entry?.kind === "missing";
  useEffect(() => {
    if (missing) onNavigate(itemRoute(route.section), true);
  }, [missing, route.section, onNavigate]);
  const Detail = entry ? detailComponents[entry.kind] : null;
  const open = Boolean(Detail) || entry?.kind === "loading";
  const subpage = open && narrow;
  const local = (
    <span className="accounts-local">
      <Icon name="shield" size={12} />
      {copy.subtle.trim()}
    </span>
  );
  const loadingLine = (
    <p className="loading" role="status">
      {hubCopy.loading}
    </p>
  );
  return (
    <SettingsShell
      className="accounts-page"
      title={subpage ? accountItemTitle(entry) : copy.pageHeadingTitle}
      subtitle={subpage ? hubCopy.breadcrumb(sectionLabel(entry.section)) : local}
      description={hubCopy.intro}
      leading={subpage ? "back" : "menu"}
      onLeading={subpage ? () => onNavigate(itemRoute(entry.section)) : openNavigation}
      navigationOpen={navigationOpen}
      actions={
        subpage ? null : (
          <>
            {local}
            <InfoHintButton hint={info} label={hubCopy.infoLabel} />
          </>
        )
      }
    >
      {!subpage && (
        <InfoHintText hint={info}>
          <strong>{copy.accountInfoHeading}</strong> {copy.accountInfoDescription}
        </InfoHintText>
      )}
      <div className={["accounts-layout", open ? "has-detail" : ""].join(" ").trim()}>
        <AccountsHub
          state={state}
          data={data}
          usage={usage}
          agentsEnabled={agentsEnabled === true}
          selected={entry}
          navigate={onNavigate}
          oauth={oauth}
          oauthResult={route.mcpOAuth}
          mcpNotice={mcpNotice}
          focusMcp={route.section === "mcp-servers" && !route.item}
        />
        <div className="accounts-pane">
          {Detail ? (
            <Suspense fallback={loadingLine}>
              <Detail
                key={`${entry.section}:${entry.item}`}
                entry={entry}
                usage={usageEntry(usage, entry.kind, entry.item)}
                agentsEnabled={agentsEnabled === true}
                state={state}
                data={data}
                refresh={refresh}
                navigate={onNavigate}
                act={act}
                oauth={oauth}
                notifyMcp={setMcpNotice}
              />
            </Suspense>
          ) : entry?.kind === "loading" ? (
            loadingLine
          ) : (
            <p className="accounts-empty">{hubCopy.selectHint}</p>
          )}
        </div>
      </div>
    </SettingsShell>
  );
}
```

In `web/app/App.jsx`, replace the `AccountsPage` props object with:

```jsx
<AccountsPage
  {...{
    refresh,
    state,
    ready,
    act,
    route,
    onNavigate: navigate,
    openNavigation,
    navigationOpen: mobileNav,
  }}
/>
```

(`setModal`, `mcpOAuth`, `mcpSection` are no longer passed; the page reads `route`.)

Create `web/features/accounts/accounts-page.css`:

```css
.accounts-page .settings-shell-content {
  max-width: 1120px;
}
.accounts-layout {
  display: grid;
  grid-template-columns: 320px minmax(0, 1fr);
  gap: 24px;
  align-items: start;
}
.accounts-hub,
.accounts-group,
.accounts-detail,
.accounts-detail-group {
  display: grid;
  min-width: 0;
}
.accounts-hub {
  gap: 22px;
}
.accounts-group,
.accounts-detail-group {
  gap: 8px;
}
.accounts-pane {
  min-width: 0;
}
.accounts-detail {
  gap: 22px;
  max-width: 720px;
}
.accounts-detail-title {
  font:
    700 17px "Manrope",
    sans-serif;
}
.accounts-note,
.accounts-empty {
  padding: 0 4px;
  font-size: 13px;
  line-height: 1.5;
  color: #a2a3a7;
}
.accounts-empty {
  padding-top: 24px;
  color: #92949d;
}
.accounts-intro {
  display: none;
}
.accounts-local {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #92949d;
}
.accounts-avatar {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  background: #30261c;
  color: #ffc99d;
  font-size: 13px;
  font-weight: 600;
}
.accounts-hub .list-row.is-selected {
  background: #1d1a17;
}
.list-card:empty {
  display: none;
}
.field-row {
  display: grid;
  gap: 6px;
  padding: 12px 12px 12px 14px;
  background: #16171b;
}
.field-row label {
  display: grid;
  gap: 6px;
  font-size: 13px;
  color: #c4c5c9;
}
.field-row-help {
  font-size: 12px;
  line-height: 1.5;
  color: #92949d;
}
.key-field-line,
.key-field-status {
  display: flex;
  align-items: center;
  gap: 10px;
}
.key-field-line > label {
  flex: 1;
}
.key-field-saved {
  flex: 1;
  font-size: 13px;
  color: #9fd3a8;
}
.accounts-confirmation,
.accounts-detail .assistant-restart-confirmation {
  display: grid;
  gap: 10px;
  padding: 14px;
  border: 1px solid #f49a5833;
  border-radius: 12px;
  background: #1d1a17;
}
.accounts-confirmation-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.accounts-detail-danger .button {
  justify-self: start;
}
.accounts-device-code {
  font-size: 22px;
  letter-spacing: 0.12em;
}
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
@media (max-width: 700px) {
  .app:has(.accounts-page) .mobile-header {
    display: none;
  }
  .accounts-layout {
    grid-template-columns: minmax(0, 1fr);
  }
  .accounts-layout.has-detail .accounts-hub,
  .accounts-layout:not(.has-detail) .accounts-pane,
  .accounts-detail-title,
  .settings-shell-actions .accounts-local {
    display: none;
  }
  .accounts-intro {
    display: block;
  }
}
```

- [ ] **Step 7: Run the hub spec and the unit suite**

Run: `npm run build && npx playwright test tests/browser/accounts-hub.spec.js`
Expected: PASS (7 tests).

Run: `npm run lint && npm run check:structure`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
npx prettier --write web/components/SaveBar.jsx web/app/App.jsx web/features/accounts web/features/provider-connections/connection-summary.js web/features/mcp-servers/mcp-notices.js tests/helpers/accounts-browser.js tests/browser/providers-fixture.js tests/browser/accounts-hub.spec.js
git add web/components/SaveBar.jsx web/app/App.jsx web/features/accounts web/features/provider-connections/connection-summary.js web/features/mcp-servers/mcp-notices.js tests/helpers/accounts-browser.js tests/browser/providers-fixture.js tests/browser/accounts-hub.spec.js
git commit -m "feat: show accounts as a hub of grouped entries with usage" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Provider connection subpage

Create and edit become one subpage (dialog removed); delete keeps its two-step restart flow in a `Sheet`.

**Files:**

- Create: `web/features/provider-connections/connection-save.js`, `ConnectionDetail.jsx`, `ConnectionEndpointGroups.jsx`, `ConnectionDeleteSheet.jsx`, `ConnectionRestartBlock.jsx`
- Modify: `web/features/accounts/account-details.js`
- Delete: `web/features/provider-connections/ProviderConnections.jsx`, `web/features/provider-connections/ConnectionDialog.jsx`
- Test: `tests/unit/connection-save.test.js`; migrate `tests/browser/provider-connections.spec.js`, `provider-connection-restart.spec.js`, `endpoint-connections.spec.js`, `endpoint-model-editing.spec.js`, `endpoint-adapter-options.spec.js`, `endpoint-routing.spec.js`, `endpoint-route-labels.spec.js`

**Interfaces:**

- Consumes: Task 3 (`AccountDetail`, `AccountSaveBar`, `useAccountDraft`, `useCreatedRedirect`, `useFieldSetter`, `FieldRow`, `KeyField`, `UsedByGroup`, `restartNote`, `itemRoute`, `accountItemTitle`); existing `endpoint-draft.js` (`initialEndpoint`, `endpointPayload`, `withoutTest`, `keyReentryRequired`, `modelsInvalid`, `applyProposal`), `useEndpointTest`, `EndpointFields`, `EndpointTestResult`, `EndpointRouting`, `EndpointAdapterOptions`, `EndpointModelTable`, `AffectedAgents`, `restartRequired`.
- Produces:
  - `connectionValues(connection | null) => { name, providerId, apiKey: "", removeApiKey: false, responsesAccess, endpoint }`.
  - `connectionBody(values, connection | null, confirmations = {}) => object` (same body as the old dialog).
  - `connectionSaveStep({ connection, label, request = api, saved(result) }) => Step` — `id: "connection"`, no `resource` (connections have no revision).
  - Registry kinds `connection`, `connection-new` → `ConnectionDetail(DetailProps)`.

- [ ] **Step 1: Write the failing unit test**

Create `tests/unit/connection-save.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { runSaveChain } from "../../web/lib/settings/save-chain.js";
import {
  connectionBody,
  connectionSaveStep,
  connectionValues,
} from "../../web/features/provider-connections/connection-save.js";

const router = {
  id: "c1",
  name: "Router",
  providerId: "zai",
  responsesAccess: false,
  hasSecret: true,
};

test("a new connection sends name, provider and key only", () => {
  const values = { ...connectionValues(null), name: " Shared ", apiKey: "k" };
  assert.deepEqual(connectionBody(values, null), {
    name: "Shared",
    providerId: "openrouter",
    apiKey: "k",
  });
});

test("an edit sends only what changed and responses access only for non-OpenRouter", () => {
  const values = connectionValues(router);
  assert.deepEqual(connectionBody(values, router), { name: "Router" });
  assert.deepEqual(connectionBody({ ...values, responsesAccess: true }, router), {
    name: "Router",
    responsesAccess: true,
  });
  assert.deepEqual(connectionBody({ ...values, removeApiKey: true }, router), {
    name: "Router",
    removeApiKey: true,
  });
  const created = connectionValues(null);
  assert.equal("responsesAccess" in connectionBody(created, null), false);
});

test("an endpoint connection sends its endpoint payload", () => {
  const values = { ...connectionValues(null), name: "Box", providerId: "endpoint" };
  const body = connectionBody(values, null);
  assert.equal(body.providerId, "endpoint");
  assert.equal(body.endpoint.openaiBaseUrl, "http://127.0.0.1:11434/v1");
  assert.equal("responsesAccess" in body, false);
});

test("a restart request is confirmed and repeated with the flag", async () => {
  const calls = [];
  const saved = [];
  const request = async (path, method, body) => {
    calls.push({ path, method, body });
    if (calls.length === 1)
      throw Object.assign(new Error("restart"), {
        code: "ASSISTANT_RESTART_REQUIRED",
        affected: { agents: [{ name: "Olli" }] },
      });
    return { id: "c1" };
  };
  const step = connectionSaveStep({
    connection: router,
    label: "Save connection",
    request,
    saved: async (result) => saved.push(result),
  });
  const values = { ...connectionValues(router), name: "Router 2" };
  const asked = [];
  const result = await runSaveChain({
    steps: [step],
    values,
    base: connectionValues(router),
    ask: async (confirmation) => {
      asked.push(confirmation);
      return true;
    },
  });
  assert.equal(result.status, "saved");
  assert.equal(asked[0].kind, "restart");
  assert.deepEqual(asked[0].data.affected.agents, [{ name: "Olli" }]);
  assert.deepEqual(calls[1], {
    path: "/provider-connections/c1",
    method: "PATCH",
    body: { name: "Router 2", confirmRestart: true },
  });
  assert.deepEqual(saved, [{ id: "c1" }]);
});

test("a new connection posts and reports the created record", async () => {
  const calls = [];
  const step = connectionSaveStep({
    connection: null,
    label: "Save connection",
    request: async (path, method, body) => {
      calls.push({ path, method, body });
      return { id: "new-id" };
    },
    saved: async () => {},
  });
  const values = { ...connectionValues(null), name: "Shared" };
  const result = await runSaveChain({
    steps: [step],
    values,
    base: connectionValues(null),
  });
  assert.equal(result.status, "saved");
  assert.equal(calls[0].path, "/provider-connections");
  assert.equal(calls[0].method, "POST");
  assert.equal(result.results.connection.id, "new-id");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/unit/connection-save.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement the save module**

Create `web/features/provider-connections/connection-save.js`:

```js
import api from "../../lib/api.js";
import { endpointPayload, initialEndpoint } from "./endpoint-draft.js";

/** The draft fields of one provider connection subpage. */
export function connectionValues(connection) {
  return {
    name: connection?.name || "",
    providerId: connection?.providerId || "openrouter",
    apiKey: "",
    removeApiKey: false,
    responsesAccess: Boolean(connection?.responsesAccess),
    endpoint: initialEndpoint(connection),
  };
}

/** The request body the connection dialog sent, plus confirmed flags. */
export function connectionBody(values, connection, confirmations = {}) {
  const endpoint = values.providerId === "endpoint";
  return {
    name: values.name.trim(),
    ...(!connection ? { providerId: values.providerId } : {}),
    ...(values.apiKey ? { apiKey: values.apiKey } : {}),
    ...(values.removeApiKey ? { removeApiKey: true } : {}),
    ...(values.providerId !== "openrouter" &&
    !endpoint &&
    (!connection || values.responsesAccess !== Boolean(connection.responsesAccess))
      ? { responsesAccess: values.responsesAccess }
      : {}),
    ...(endpoint ? { endpoint: endpointPayload(values.endpoint) } : {}),
    ...confirmations,
  };
}

/**
 * Saves a connection in one request. Changing one that agents use asks to restart
 * their Gateway first (ASSISTANT_RESTART_REQUIRED → confirmRestart).
 */
export function connectionSaveStep({ connection, label, request = api, saved }) {
  return {
    id: "connection",
    label,
    async run({ values, confirmations }) {
      const result = await request(
        connection
          ? `/provider-connections/${encodeURIComponent(connection.id)}`
          : "/provider-connections",
        connection ? "PATCH" : "POST",
        connectionBody(values, connection, confirmations),
      );
      await saved(result);
      return result;
    },
  };
}
```

Run: `node --test tests/unit/connection-save.test.js`
Expected: PASS.

- [ ] **Step 4: Build the subpage**

Create `web/features/provider-connections/ConnectionRestartBlock.jsx`:

```jsx
import React from "react";
import { useAlertDialogFocus } from "../../components/useAlertDialogFocus.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { connectionCopy as copy } from "../../lib/i18n/messages/connections.js";
import AffectedAgents from "./AffectedAgents.jsx";

/** The save chain's restart question for a connection agents use, above the bar. */
export default function ConnectionRestartBlock({ confirmation }) {
  const focus = useAlertDialogFocus(confirmation.cancel);
  return (
    <div
      {...focus}
      className="accounts-confirmation"
      role="alertdialog"
      aria-label={copy.saveAndRestart}
    >
      <p role="status">{copy.restartRequired}</p>
      <AffectedAgents affected={confirmation.data?.affected} />
      <div className="accounts-confirmation-actions">
        <button type="button" className="button primary" onClick={confirmation.confirm}>
          {copy.saveAndRestart}
        </button>
        <button
          type="button"
          className="button secondary"
          data-autofocus
          onClick={confirmation.cancel}
        >
          {commonCopy.cancel}
        </button>
      </div>
    </div>
  );
}
```

Create `web/features/provider-connections/ConnectionDeleteSheet.jsx`:

```jsx
import React, { useState } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import Sheet from "../../components/Sheet.jsx";
import api from "../../lib/api.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { connectionCopy as copy } from "../../lib/i18n/messages/connections.js";
import AffectedAgents from "./AffectedAgents.jsx";
import { restartRequired } from "./restart-confirmation.js";

/** Deleting asks once; a connection agents use asks again to restart them. */
export default function ConnectionDeleteSheet({ connection, open, onClose, onDeleted }) {
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [affected, setAffected] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const close = () => {
    if (busy) return;
    setConfirmRestart(false);
    setAffected(null);
    setError("");
    onClose();
  };
  async function remove() {
    setBusy(true);
    setError("");
    try {
      await api(
        `/provider-connections/${encodeURIComponent(connection.id)}`,
        "DELETE",
        confirmRestart ? { confirmRestart: true } : undefined,
      );
    } catch (failure) {
      setBusy(false);
      if (!restartRequired(failure)) return setError(failure.message);
      setConfirmRestart(true);
      setAffected(failure.affected);
      return undefined;
    }
    await onDeleted();
    return undefined;
  }
  return (
    <Sheet open={open} title={copy.delete} onCancel={close}>
      <p className="sheet-body">
        {copy.deleteConfirm(connection.name, connection.hasSecret === true)}
      </p>
      {confirmRestart && (
        <p className="sheet-body" role="status">
          {copy.restartRequired}
        </p>
      )}
      {confirmRestart && <AffectedAgents affected={affected} />}
      <ErrorMessage error={error} />
      <div className="sheet-actions">
        <button type="button" className="button danger" disabled={busy} onClick={remove}>
          {confirmRestart ? copy.deleteAndRestart : copy.delete}
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={close}
        >
          {commonCopy.cancel}
        </button>
      </div>
    </Sheet>
  );
}
```

Create `web/features/provider-connections/ConnectionEndpointGroups.jsx`:

```jsx
import React from "react";
import AnchoredSelect from "../../components/AnchoredSelect.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import GroupLabel from "../../components/GroupLabel.jsx";
import { connectionCopy } from "../../lib/i18n/messages/connections.js";
import { accountsHubCopy } from "../../lib/i18n/messages/accounts.js";
import EndpointFields from "./EndpointFields.jsx";
import EndpointTestResult from "./EndpointTestResult.jsx";
import EndpointRouting from "./EndpointRouting.jsx";
import EndpointAdapterOptions from "./EndpointAdapterOptions.jsx";
import EndpointModelTable from "./EndpointModelTable.jsx";
import { applyProposal } from "./endpoint-draft.js";

/** An own endpoint's groups: connection, test, routing per CLI, adapter, models. */
export default function ConnectionEndpointGroups({
  endpoint,
  setEndpoint,
  editAddress,
  tester,
  probeModelId,
  setProbeModel,
}) {
  const copy = connectionCopy.endpoint;
  // A test model that left the list falls back to "Automatic".
  const probe = endpoint.models.some((model) => model.modelId === probeModelId)
    ? probeModelId
    : "";
  return (
    <>
      <section className="accounts-detail-group">
        <GroupLabel>{accountsHubCopy.connectionGroups.connection}</GroupLabel>
        <div className="connection-fields">
          <EndpointFields draft={endpoint} setDraft={editAddress} locked={false} />
        </div>
      </section>
      <section className="accounts-detail-group">
        <GroupLabel>{accountsHubCopy.connectionGroups.test}</GroupLabel>
        <div className="endpoint-test">
          <label>
            {copy.probeModel}
            <AnchoredSelect
              label={copy.probeModel}
              value={probe}
              onChange={setProbeModel}
              options={[
                { value: "", label: copy.probeAuto },
                ...endpoint.models.map((model) => ({
                  value: model.modelId,
                  label: model.modelId,
                })),
              ]}
            />
            <small>{copy.probeHint}</small>
          </label>
          <button
            type="button"
            className="button secondary"
            disabled={tester.busy || !endpoint.openaiBaseUrl.trim()}
            onClick={async () => {
              const proposal = await tester.run(probe);
              if (proposal) setEndpoint((current) => applyProposal(current, proposal));
            }}
          >
            {tester.busy ? copy.testing : copy.test}
          </button>
          <small>{copy.testCost}</small>
          <ErrorMessage error={tester.error} />
        </div>
        <EndpointTestResult
          draft={endpoint}
          setDraft={setEndpoint}
          result={tester.result}
        />
      </section>
      <EndpointRouting draft={endpoint} setDraft={setEndpoint} />
      <EndpointAdapterOptions draft={endpoint} setDraft={setEndpoint} />
      <EndpointModelTable draft={endpoint} setDraft={setEndpoint} />
    </>
  );
}
```

Create `web/features/provider-connections/ConnectionDetail.jsx`:

```jsx
import React, { useMemo, useRef, useState } from "react";
import AnchoredSelect from "../../components/AnchoredSelect.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import ListCard from "../../components/ListCard.jsx";
import { CheckboxRow } from "../../components/ListRow.jsx";
import useResource from "../../lib/useResource.js";
import { connectionCopy as copy } from "../../lib/i18n/messages/connections.js";
import AccountDetail, { AccountSaveBar } from "../accounts/AccountDetail.jsx";
import FieldRow from "../accounts/FieldRow.jsx";
import KeyField from "../accounts/KeyField.jsx";
import UsedByGroup from "../accounts/UsedByGroup.jsx";
import useAccountDraft from "../accounts/useAccountDraft.js";
import useCreatedRedirect from "../accounts/useCreatedRedirect.js";
import useFieldSetter from "../accounts/useFieldSetter.js";
import { accountItemTitle, itemRoute } from "../accounts/accounts-items.js";
import { restartNote } from "../accounts/account-usage-view.js";
import ConnectionDeleteSheet from "./ConnectionDeleteSheet.jsx";
import ConnectionEndpointGroups from "./ConnectionEndpointGroups.jsx";
import ConnectionRestartBlock from "./ConnectionRestartBlock.jsx";
import useEndpointTest from "./useEndpointTest.js";
import { connectionSaveStep, connectionValues } from "./connection-save.js";
import {
  initialEndpoint,
  keyReentryRequired,
  modelsInvalid,
  withoutTest,
} from "./endpoint-draft.js";
import "./connections.css";

/** One central provider connection: create (item=new) or edit, use, delete. */
export default function ConnectionDetail({
  entry,
  usage,
  agentsEnabled,
  refresh,
  navigate,
}) {
  const connection = entry.kind === "connection" ? entry.record : null;
  const signature = JSON.stringify(connection);
  // The record changes identity on every refresh; its content decides the base.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const server = useMemo(() => connectionValues(connection), [signature]);
  const providers = useResource("/providers");
  const formRef = useRef(null);
  const [created, setCreated] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [probeModelId, setProbeModel] = useState("");
  const form = useAccountDraft({
    server,
    tab: accountItemTitle(entry),
    entry,
    steps: [
      connectionSaveStep({
        connection,
        label: copy.save,
        saved: async (result) => {
          await refresh();
          if (!connection) setCreated(result.id);
        },
      }),
    ],
  });
  const { draft } = form;
  const values = draft.values;
  useCreatedRedirect({ created, draft, navigate, section: "models" });
  const setEndpoint = useFieldSetter(draft, "endpoint");
  const endpoint = values.providerId === "endpoint";
  const tester = useEndpointTest({
    connection,
    draft: values.endpoint,
    apiKey: values.apiKey,
    removeApiKey: values.removeApiKey,
  });
  // Address, header, preset or key changes invalidate a test of the old values.
  const invalidateTest = () => {
    tester.reset();
    setEndpoint(withoutTest);
  };
  const editAddress = (update) => {
    tester.reset();
    setEndpoint((current) => withoutTest(update(current)));
  };
  const keyReentry =
    endpoint &&
    keyReentryRequired({
      connection,
      draft: values.endpoint,
      apiKey: values.apiKey,
      removeApiKey: values.removeApiKey,
    });
  const modelsBlocked = endpoint && modelsInvalid(values.endpoint.models);
  const options =
    providers.data?.providers ||
    (connection
      ? [
          {
            id: connection.providerId,
            name: copy.providerNames[connection.providerId] || connection.providerId,
          },
        ]
      : []);
  const clis = connection
    ? connection.tools.map((tool) => ({
        tool,
        route: connection.toolRoutes ? connection.toolRoutes[tool] : undefined,
      }))
    : null;
  return (
    <AccountDetail
      title={accountItemTitle(entry)}
      destructive={
        connection && (
          <button
            type="button"
            className="button secondary danger-text"
            onClick={() => setDeleting(true)}
          >
            {copy.delete}
          </button>
        )
      }
      bar={
        <AccountSaveBar
          form={form}
          formRef={formRef}
          saveLabel={copy.save}
          note={restartNote(usage)}
          saveDisabled={keyReentry || modelsBlocked || (!connection && !providers.data)}
        />
      }
    >
      <form
        ref={formRef}
        className="accounts-detail-group"
        onSubmit={(event) => {
          event.preventDefault();
          form.save();
        }}
      >
        <fieldset className="connection-fields" disabled={draft.saving}>
          <ListCard>
            <FieldRow label={copy.name}>
              <input
                required
                maxLength={100}
                autoFocus={!connection}
                value={values.name}
                onChange={(event) => draft.set("name", event.target.value)}
              />
            </FieldRow>
            <FieldRow label={copy.provider}>
              <AnchoredSelect
                label={copy.provider}
                value={values.providerId}
                disabled={Boolean(connection) || providers.loading}
                required
                onChange={(value) => {
                  draft.update({
                    providerId: value,
                    responsesAccess: false,
                    apiKey: "",
                    endpoint: initialEndpoint(null),
                  });
                  setProbeModel("");
                  tester.reset();
                }}
                options={options.map((provider) => ({
                  value: provider.id,
                  label: copy.providerNames[provider.id] || provider.name,
                }))}
              />
            </FieldRow>
            <KeyField
              label={copy.key}
              saved={Boolean(connection?.hasSecret)}
              savedText={copy.keySaved}
              value={values.apiKey}
              disabled={values.removeApiKey}
              placeholder={
                connection?.hasSecret
                  ? copy.keyPlaceholder
                  : endpoint
                    ? copy.endpoint.keyOptional
                    : copy.keyOptional
              }
              hint={copy.keyHelp}
              onChange={(value) => {
                draft.set("apiKey", value);
                if (endpoint) invalidateTest();
              }}
            />
            {connection?.hasSecret && (
              <CheckboxRow
                label={copy.removeKey}
                checked={values.removeApiKey}
                onChange={(checked) => {
                  draft.update({
                    removeApiKey: checked,
                    ...(checked ? { apiKey: "" } : {}),
                  });
                  if (endpoint) invalidateTest();
                }}
              />
            )}
            {values.providerId !== "openrouter" && !endpoint && (
              <CheckboxRow
                label={copy.responses}
                sub={copy.responsesHelp}
                checked={values.responsesAccess}
                onChange={(checked) => draft.set("responsesAccess", checked)}
              />
            )}
          </ListCard>
          {providers.loading && !connection && <p role="status">{copy.loading}</p>}
          <ErrorMessage error={providers.error} />
          {keyReentry && <p role="alert">{copy.endpoint.keyReentry}</p>}
          {endpoint && (
            <ConnectionEndpointGroups
              endpoint={values.endpoint}
              setEndpoint={setEndpoint}
              editAddress={editAddress}
              tester={tester}
              probeModelId={probeModelId}
              setProbeModel={setProbeModel}
            />
          )}
        </fieldset>
      </form>
      {draft.confirmation?.kind === "restart" && (
        <ConnectionRestartBlock confirmation={draft.confirmation} />
      )}
      {connection && (
        <UsedByGroup
          usage={usage}
          agentsEnabled={agentsEnabled}
          navigate={navigate}
          clis={clis}
        />
      )}
      {connection && (
        <ConnectionDeleteSheet
          connection={connection}
          open={deleting}
          onClose={() => setDeleting(false)}
          onDeleted={async () => {
            await refresh();
            navigate(itemRoute("models"), true);
          }}
        />
      )}
    </AccountDetail>
  );
}
```

Add to `web/features/accounts/accounts-page.css`:

```css
.accounts-detail-danger .danger-text {
  border-color: #754b42;
  color: #e7a3a3;
}
```

Register it in `web/features/accounts/account-details.js` (replace the file body):

```js
import { lazy } from "react";

const ConnectionDetail = lazy(
  () => import("../provider-connections/ConnectionDetail.jsx"),
);

// Detail subpages by entry kind (see accounts-items.js). Each detail is loaded on
// demand, so agent modules and their requests stay out of /accounts while agents are
// off. Every component receives the DetailProps documented in AccountsPage.jsx.
export const detailComponents = {
  connection: ConnectionDetail,
  "connection-new": ConnectionDetail,
};
```

Delete `web/features/provider-connections/ProviderConnections.jsx` and `web/features/provider-connections/ConnectionDialog.jsx` (`git rm`). Verify nothing imports them: `grep -rn "ProviderConnections.jsx\|ConnectionDialog" web` → no output.

- [ ] **Step 5: Migrate the provider and endpoint specs**

Rules (selectors only; assertions stay):

| Old                                                                 | New                                                                                                                                    |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `page.getByRole("dialog")` used for the connection form             | `accountDetail(page)`                                                                                                                  |
| click "Add provider connection" / "Provider-Zugang hinzufügen"      | unchanged (the group "+" has that name)                                                                                                |
| click "Edit X" / "X bearbeiten" (`copy.editNamed`)                  | `await openAccountItem(page, "X")`                                                                                                     |
| click "Delete X" / "X löschen" (`copy.deleteNamed`)                 | `await openAccountItem(page, "X")` then `accountDetail(page).getByRole("button", { name: "Delete connection" })` (DE "Zugang löschen") |
| the delete confirmation `page.getByRole("dialog")`                  | unchanged (the `Sheet` is a dialog)                                                                                                    |
| `expect(dialog).toHaveCount(0)` after a successful save             | `await expect(saveBar(page)).toHaveCount(0)`                                                                                           |
| `getByLabel("API key"/"API-Key")` on a connection with a saved key  | `await keyInput(accountDetail(page), "API key")`                                                                                       |
| restart status/"Save and restart agents" after saving an edit       | inside `accountDetail(page)` (inline confirmation)                                                                                     |
| a dialog of the session launch ("Start session", "Reload & resume") | unchanged                                                                                                                              |

Import in each migrated spec: `import { accountDetail, keyInput, openAccountItem, saveBar } from "../helpers/accounts-browser.js";` (only the names used).

Per file:

- `provider-connections.spec.js` test 1: `const dialog = page.getByRole("dialog");` → `const dialog = accountDetail(page);`; first `await expect(dialog).toHaveCount(0);` → `await expect(saveBar(page)).toHaveCount(0);`; the click on "Shared OpenRouter bearbeiten" → `await openAccountItem(page, "Shared OpenRouter");`; the following `page.getByLabel("API-Key", { exact: true })` → `await keyInput(accountDetail(page), "API-Key")`. The end of test 1 (~50–54) saved the unchanged dialog and asserted the PATCH body `{ name: "Shared OpenRouter" }`; an unchanged subpage has no bar (deviation 14), so replace the click on "Zugang speichern" and the PATCH assertion with `await expect(saveBar(page)).toHaveCount(0); expect(controls.calls.some((call) => call.method === "PATCH")).toBe(false);`. Test at line ~172–222 (Responses access): the edit openers ("Shared Z.ai bearbeiten", twice) → `openAccountItem(page, "Shared Z.ai")`; `page.getByLabel("API-Key", { exact: true })` → `await keyInput(accountDetail(page), "API-Key")`; `expect(page.getByRole("dialog")).toHaveCount(0)` after "Zugang speichern" → `expect(saveBar(page)).toHaveCount(0)`; `page.locator(".provider-connection-card")).toContainText("Codex")` → `accountDetail(page).getByRole("group", { name: "Kompatible CLIs" })).toContainText("Codex")`; `.provider-connection-card` `toContainText("API-Key fehlt")` → `accountRow(page, "Shared Z.ai")`; both "Shared Z.ai löschen" clicks → `accountDetail(page).getByRole("button", { name: "Zugang löschen", exact: true })` (the sheet's own "Zugang löschen" stays scoped to `page.getByRole("dialog")`); the final `.provider-connection-card` `toHaveCount(0)` → `accountRow(page, "Shared Z.ai")).toHaveCount(0)`. Other `getByRole("dialog")` in this file belong to the launch dialog or the delete sheet: unchanged.
- `provider-connection-restart.spec.js`: "Edit Agent router" → `openAccountItem(page, "Agent router")`; `const dialog = page.getByRole("dialog")` → `const dialog = accountDetail(page)`; `await expect(dialog).toHaveCount(0)` after "Save and restart agents" → `await expect(saveBar(page)).toHaveCount(0)`; "Delete Agent router 2" → `await openAccountItem(page, "Agent router 2"); await accountDetail(page).getByRole("button", { name: "Delete connection", exact: true }).click();`; `removal` stays `page.getByRole("dialog")`. Second test: "Delete Agent router" → same two lines with "Agent router".
- `endpoint-model-editing.spec.js`: in `openEndpointDialog` → `const dialog = accountDetail(page);`; German test: `page.getByRole("dialog").getByLabel("API-Anbieter")` → `accountDetail(page).getByLabel("API-Anbieter")`; any `expect(dialog).toHaveCount(0)` after saving → `saveBar(page)`.
- `endpoint-connections.spec.js`: every `const dialog = page.getByRole("dialog")` directly after clicking "Add provider connection" → `accountDetail(page)`; "Edit Gateway box" → `openAccountItem(page, "Gateway box")` and `dialog = accountDetail(page)`; the `.getByRole("dialog")` before "Start session" (line ~94) stays; `expect(dialog).toHaveCount(0)` after save → `saveBar`. Key re-entry test (~137–147): `const save = saveBar(page).getByRole("button", { name: "Save connection", exact: true });` and replace `await expect(save).toBeEnabled();` on the untouched form with `await expect(saveBar(page)).toHaveCount(0);` (deviation 14: an unchanged subpage has no bar); after the URL edit `await expect(save).toBeDisabled()` stays.
- `endpoint-adapter-options.spec.js` (`openEndpoint`) and `endpoint-routing.spec.js` (`openNewEndpoint`, German test at ~233): `page.getByRole("dialog")` → `accountDetail(page)`; `toHaveCount(0)` after save → `saveBar`.
- `endpoint-route-labels.spec.js` tests "connection list and launch dialog label adapter routes" and "OpenCode SDK routes show only the protocol": the joined text no longer exists in one line (deviation 9). Replace the `page.getByText("Compatible CLIs: …")` assertions with:

```js
const detail = await openAccountItem(page, chatOnly.name);
await expect(
  detail.getByRole("group", { name: "Compatible CLIs" }).locator(".list-row"),
).toHaveText([
  /Codex.*via adapter · Chat Completions/,
  /Claude Code.*via adapter · Chat Completions/,
  /OpenCode.*native/,
]);
```

and for the SDK test `[/Claude Code.*native/, /OpenCode.*Responses/]`. The `page.getByRole("dialog")` in its reload helper (~187) stays.

Run: `npm run build && npx playwright test tests/browser/provider-connections.spec.js tests/browser/provider-connection-restart.spec.js tests/browser/endpoint-connections.spec.js tests/browser/endpoint-model-editing.spec.js tests/browser/endpoint-adapter-options.spec.js tests/browser/endpoint-routing.spec.js tests/browser/endpoint-route-labels.spec.js tests/browser/accounts-hub.spec.js`
Expected: PASS. If a test still fails on a selector, apply the rule table to that line; do not change an assertion.

- [ ] **Step 6: Commit**

```bash
npx prettier --write web/features/provider-connections web/features/accounts tests/unit/connection-save.test.js tests/browser/provider-connections.spec.js tests/browser/provider-connection-restart.spec.js tests/browser/endpoint-*.spec.js
git add -A web/features/provider-connections web/features/accounts tests/unit/connection-save.test.js tests/browser/provider-connections.spec.js tests/browser/provider-connection-restart.spec.js tests/browser/endpoint-*.spec.js
git commit -m "feat: edit provider connections on an accounts subpage" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Native CLI account subpage

`AccountDialog` becomes subpage content; sign-in, default and delete move into the subpage.

**Files:**

- Create: `web/features/accounts/native-account-save.js`, `NativeAccountDetail.jsx`, `LegacyProviderEditor.jsx`
- Modify: `web/features/accounts/account-details.js`, `web/app/AppDialogs.jsx` (remove the `account` modal and the `AccountDialog` import)
- Delete: `web/features/accounts/AccountDialog.jsx`
- Test: `tests/unit/native-account-save.test.js`; migrate `tests/browser/account-defaults.spec.js`, `ui.spec.js`, `nono-sandbox.spec.js`, `providers.spec.js`, `i18n-plugins-providers.spec.js`, `live.spec.js`, and `createForm` in `tests/browser/providers-fixture.js`

**Interfaces:**

- Consumes: Task 3; `NativeAccountActions({ account, state, act, refresh, auth })` (unchanged), `useAccountAuthStatus`, `useAccountProvider`, `ProviderFields`, `ProviderAccountSummary`; `act("login" | "deleteAccount", account)`.
- Produces:
  - `nativeAccountValues(account | null, tools) => { name, tool, apiKey: "", removeApiKey: false, provider: null }` — `provider` is `null` (unchanged) or `{ selection }` (changed; `selection` null removes it).
  - `nativeAccountBody(values, account | null) => object` (same body as `AccountDialog`).
  - `keyChangeRequired(values, account, providerId) => boolean`.
  - `nativeAccountStep({ account, label, request = api, saved(result) }) => Step` (`id: "account"`).
  - `LegacyProviderEditor({ account, onChange({ value, ready, providerId }) })`.
  - Registry kinds `cli-account`, `cli-new` → `NativeAccountDetail(DetailProps)`.

- [ ] **Step 1: Write the failing unit test**

Create `tests/unit/native-account-save.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { runSaveChain } from "../../web/lib/settings/save-chain.js";
import {
  keyChangeRequired,
  nativeAccountBody,
  nativeAccountStep,
  nativeAccountValues,
} from "../../web/features/accounts/native-account-save.js";

const tools = [
  { id: "shell", installed: true },
  { id: "codex", installed: true },
];
const legacy = {
  id: "legacy-gateway",
  name: "Gateway",
  tool: "codex",
  kind: "managed",
  hasSecret: true,
  provider: { id: "zai-coding-plan", modelId: "m" },
};

test("a new account picks the first non-shell tool and sends tool and key", () => {
  const values = { ...nativeAccountValues(null, tools), name: " Arbeit ", apiKey: "k" };
  assert.equal(values.tool, "codex");
  assert.deepEqual(nativeAccountBody(values, null), {
    name: "Arbeit",
    tool: "codex",
    apiKey: "k",
  });
});

test("an edit sends the provider only when it changed", () => {
  const values = nativeAccountValues(legacy, tools);
  assert.deepEqual(nativeAccountBody(values, legacy), { name: "Gateway" });
  const selection = { id: "openrouter", modelId: "x" };
  assert.deepEqual(nativeAccountBody({ ...values, provider: { selection } }, legacy), {
    name: "Gateway",
    provider: selection,
  });
  assert.deepEqual(
    nativeAccountBody({ ...values, provider: { selection: null } }, legacy),
    { name: "Gateway", provider: null },
  );
  assert.deepEqual(nativeAccountBody({ ...values, removeApiKey: true }, legacy), {
    name: "Gateway",
    removeApiKey: true,
  });
});

test("switching the provider of an account with a key requires a new key", () => {
  const values = nativeAccountValues(legacy, tools);
  assert.equal(keyChangeRequired(values, legacy, "zai-coding-plan"), false);
  assert.equal(keyChangeRequired(values, legacy, "openrouter"), true);
  assert.equal(
    keyChangeRequired({ ...values, apiKey: "n" }, legacy, "openrouter"),
    false,
  );
  assert.equal(
    keyChangeRequired({ ...values, removeApiKey: true }, legacy, "openrouter"),
    false,
  );
});

test("the step posts or patches and reports the result", async () => {
  const calls = [];
  const request = async (path, method, body) => {
    calls.push({ path, method, body });
    return { id: "managed-1" };
  };
  for (const account of [null, legacy]) {
    const values = { ...nativeAccountValues(account, tools), name: "Team" };
    const result = await runSaveChain({
      steps: [
        nativeAccountStep({ account, label: "Save", request, saved: async () => {} }),
      ],
      values,
      base: nativeAccountValues(account, tools),
    });
    assert.equal(result.status, "saved");
  }
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}`),
    ["POST /accounts", "PATCH /accounts/legacy-gateway"],
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/unit/native-account-save.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement the save module**

Create `web/features/accounts/native-account-save.js`:

```js
import api from "../../lib/api.js";

/** The draft fields of a native CLI account; `provider` null means "unchanged". */
export function nativeAccountValues(account, tools = []) {
  return {
    name: account?.name || "",
    tool: account?.tool || tools.find((item) => item.id !== "shell")?.id || "",
    apiKey: "",
    removeApiKey: false,
    provider: null,
  };
}

/** The body AccountDialog sent. */
export function nativeAccountBody(values, account) {
  const body = { name: values.name.trim() };
  if (!account) body.tool = values.tool;
  if (values.apiKey) body.apiKey = values.apiKey;
  if (values.removeApiKey) body.removeApiKey = true;
  if (values.provider) {
    if (values.provider.selection) body.provider = values.provider.selection;
    else if (account?.provider) body.provider = null;
  }
  return body;
}

/** A stored key belongs to the old provider: switching needs a new one or removal. */
export const keyChangeRequired = (values, account, providerId) =>
  Boolean(
    account?.hasSecret &&
    (account.provider?.id || "") !== providerId &&
    !values.apiKey.trim() &&
    !values.removeApiKey,
  );

export function nativeAccountStep({ account, label, request = api, saved }) {
  return {
    id: "account",
    label,
    async run({ values }) {
      const result = await request(
        account ? `/accounts/${account.id}` : "/accounts",
        account ? "PATCH" : "POST",
        nativeAccountBody(values, account),
      );
      await saved(result);
      return result;
    },
  };
}
```

Run: `node --test tests/unit/native-account-save.test.js`
Expected: PASS.

- [ ] **Step 4: Build the subpage**

Create `web/features/accounts/LegacyProviderEditor.jsx`:

```jsx
import React, { useEffect, useRef } from "react";
import { connectionCopy } from "../../lib/i18n/messages/connections.js";
import ProviderFields from "../providers/ProviderFields.jsx";
import useAccountProvider from "../providers/useAccountProvider.js";

/**
 * The legacy per-account provider of an older managed account. It keeps its own
 * catalog state and reports the selection to the draft; the parent remounts it to
 * discard the selection.
 */
export default function LegacyProviderEditor({ account, onChange }) {
  const provider = useAccountProvider(account, account.tool);
  const report = useRef(onChange);
  report.current = onChange;
  const value = provider.changed ? { selection: provider.selection } : null;
  const key = JSON.stringify(value);
  useEffect(() => {
    report.current({ value, ready: provider.ready, providerId: provider.providerId });
    // `key` captures every change of `value`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, provider.ready, provider.providerId]);
  return (
    <>
      <p className="field-description">{connectionCopy.legacyHelp}</p>
      <ProviderFields controller={provider} tool={account.tool} />
    </>
  );
}
```

Create `web/features/accounts/NativeAccountDetail.jsx`:

```jsx
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AnchoredSelect from "../../components/AnchoredSelect.jsx";
import GroupLabel from "../../components/GroupLabel.jsx";
import Icon from "../../components/Icon.jsx";
import ListCard from "../../components/ListCard.jsx";
import ListRow, { CheckboxRow } from "../../components/ListRow.jsx";
import { names } from "../../lib/providers.js";
import { sameValue } from "../../lib/settings/draft-state.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { connectionCopy } from "../../lib/i18n/messages/connections.js";
import { providerCopy } from "../../lib/i18n/messages/providers.js";
import {
  accountDialogCopy as dialogCopy,
  accountsHubCopy as hubCopy,
  accountsPageCopy as copy,
} from "../../lib/i18n/messages/accounts.js";
import ProviderAccountSummary from "../providers/ProviderAccountSummary.jsx";
import AccountDetail, { AccountSaveBar } from "./AccountDetail.jsx";
import FieldRow from "./FieldRow.jsx";
import LegacyProviderEditor from "./LegacyProviderEditor.jsx";
import NativeAccountActions from "./NativeAccountActions.jsx";
import UsedByGroup from "./UsedByGroup.jsx";
import useAccountAuthStatus from "./useAccountAuthStatus.js";
import useAccountDraft from "./useAccountDraft.js";
import useCreatedRedirect from "./useCreatedRedirect.js";
import { accountItemTitle } from "./accounts-items.js";
import {
  keyChangeRequired,
  nativeAccountStep,
  nativeAccountValues,
} from "./native-account-save.js";

function SignInGroup({ account, state, act, refresh }) {
  const auth = useAccountAuthStatus(account);
  if (account.provider || account.internal) return null;
  return (
    <section className="accounts-detail-group">
      <GroupLabel>{hubCopy.accountActions}</GroupLabel>
      <div className="account-actions accounts-actions-row">
        <NativeAccountActions
          account={account}
          auth={auth}
          state={state}
          act={act}
          refresh={refresh}
        />
      </div>
    </section>
  );
}

/** A native CLI account: local profiles read only, managed ones editable. */
export default function NativeAccountDetail({
  entry,
  usage,
  agentsEnabled,
  state,
  refresh,
  navigate,
  act,
}) {
  const account = entry.kind === "cli-account" ? entry.record : null;
  const managed = !account || account.kind === "managed";
  const signature = JSON.stringify([account?.id, account?.name, account?.provider]);
  const server = useMemo(
    () => nativeAccountValues(account, state.tools),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [signature],
  );
  const formRef = useRef(null);
  const [created, setCreated] = useState(null);
  const [legacy, setLegacy] = useState({
    ready: true,
    providerId: account?.provider?.id || "",
  });
  const [generation, setGeneration] = useState(0);
  const reported = useRef(null);
  const form = useAccountDraft({
    server,
    tab: accountItemTitle(entry),
    entry,
    steps: [
      nativeAccountStep({
        account,
        label: account ? commonCopy.save : commonCopy.createAccount,
        saved: async (result) => {
          await refresh();
          if (!account) setCreated(result.id);
        },
      }),
    ],
  });
  const { draft } = form;
  const values = draft.values;
  const live = useRef(draft);
  live.current = draft;
  useCreatedRedirect({ created, draft, navigate, section: "cli" });
  const onLegacy = useCallback(({ value, ready, providerId }) => {
    reported.current = value;
    setLegacy({ ready, providerId });
    if (!sameValue(live.current.values.provider, value))
      live.current.set("provider", value);
  }, []);
  // Cancel or a saved change returns `provider` to null: start the editor afresh.
  useEffect(() => {
    if (values.provider === null && reported.current !== null) {
      reported.current = null;
      setGeneration((value) => value + 1);
    }
  }, [values.provider]);
  const description = !account
    ? ""
    : account.kind === "local"
      ? copy.localProfileDescription
      : account.hasSecret
        ? copy.managedProfileWithKey
        : copy.managedProfileDescription;
  const keyChange = keyChangeRequired(values, account, legacy.providerId);
  const tools = (state.tools || []).filter((item) => item.id !== "shell");
  return (
    <AccountDetail
      title={accountItemTitle(entry)}
      destructive={
        account?.kind === "managed" && (
          <button
            type="button"
            className="button secondary danger-text"
            onClick={() => act("deleteAccount", account)}
          >
            {commonCopy.deleteAccount}
          </button>
        )
      }
      bar={
        managed && (
          <AccountSaveBar
            form={form}
            formRef={formRef}
            saveLabel={account ? commonCopy.save : commonCopy.createAccount}
            saveDisabled={!legacy.ready || keyChange}
          />
        )
      }
    >
      {account && (
        <ListCard>
          <ListRow
            icon={<Icon name="shield" size={14} />}
            label={names[account.tool]}
            sub={description}
            value={account.kind === "local" ? commonCopy.local : undefined}
          />
        </ListCard>
      )}
      {account && (
        <SignInGroup account={account} state={state} act={act} refresh={refresh} />
      )}
      {account?.provider && (
        <section className="accounts-detail-group">
          <p className="field-description">{connectionCopy.legacy}</p>
          <ProviderAccountSummary account={account} />
        </section>
      )}
      {managed && (
        <form
          ref={formRef}
          className="accounts-detail-group"
          onSubmit={(event) => {
            event.preventDefault();
            form.save();
          }}
        >
          <fieldset disabled={draft.saving}>
            <p className="field-description">{dialogCopy.profileIsolationDescription}</p>
            <ListCard>
              <FieldRow label={commonCopy.accountName}>
                <input
                  name="name"
                  required
                  autoFocus={!account}
                  maxLength={100}
                  value={values.name}
                  placeholder={dialogCopy.accountNamePlaceholder}
                  onChange={(event) => draft.set("name", event.target.value)}
                />
              </FieldRow>
              {!account && (
                <FieldRow label={dialogCopy.toolLabel}>
                  <AnchoredSelect
                    label={dialogCopy.toolLabel}
                    value={values.tool}
                    onChange={(tool) => draft.set("tool", tool)}
                    options={tools.map((item) => ({
                      value: item.id,
                      label:
                        item.name +
                        (!item.installed ? dialogCopy.uninstalledToolSuffix : ""),
                    }))}
                  />
                </FieldRow>
              )}
              <FieldRow label={dialogCopy.apiKeyLabel}>
                <input
                  name="apiKey"
                  type="password"
                  autoComplete="new-password"
                  value={values.apiKey}
                  disabled={values.removeApiKey}
                  placeholder={
                    account?.hasSecret
                      ? dialogCopy.savedKeyPlaceholder
                      : dialogCopy.nativeKeyPlaceholder
                  }
                  onChange={(event) => draft.set("apiKey", event.target.value)}
                />
              </FieldRow>
              {account?.hasSecret && (
                <CheckboxRow
                  label={providerCopy.keyRemove}
                  checked={values.removeApiKey}
                  onChange={(checked) =>
                    draft.update({
                      removeApiKey: checked,
                      ...(checked ? { apiKey: "" } : {}),
                    })
                  }
                />
              )}
            </ListCard>
            {account?.provider && (
              <LegacyProviderEditor
                key={generation}
                account={account}
                onChange={onLegacy}
              />
            )}
            {keyChange && <p className="field-description">{providerCopy.switchKey}</p>}
            <p className="field-description">
              {legacy.providerId
                ? providerCopy.keyHelp
                : dialogCopy.nativeAuthenticationHelp}
            </p>
            <div className="form-note">
              <Icon name="shield" />
              {dialogCopy.formNote}
            </div>
          </fieldset>
        </form>
      )}
      {account && (
        <UsedByGroup usage={usage} agentsEnabled={agentsEnabled} navigate={navigate} />
      )}
    </AccountDetail>
  );
}
```

Register in `web/features/accounts/account-details.js` (add next to `ConnectionDetail`):

```js
const NativeAccountDetail = lazy(() => import("./NativeAccountDetail.jsx"));
```

and in `detailComponents`:

```js
  "cli-account": NativeAccountDetail,
  "cli-new": NativeAccountDetail,
```

In `web/app/AppDialogs.jsx` delete the import `import AccountDialog from "../features/accounts/AccountDialog.jsx";` and the block `{modal?.type === "account" && ( <AccountDialog … /> )}`. `git rm web/features/accounts/AccountDialog.jsx`. Verify: `grep -rn "AccountDialog\|type: \"account\"" web` → no output.

Add to `accounts-page.css`:

```css
.accounts-actions-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
```

- [ ] **Step 5: Migrate the native account specs**

Rules: an `.account-card` (or its `heading`) becomes the hub row `accountRow(page, name)` for presence checks and `await openAccountItem(page, name)` + `accountDetail(page)` for its content and buttons; "X bearbeiten" (`commonCopy.editNamedItem`) → `openAccountItem(page, "X")`; `expect(page.getByRole("dialog")).toHaveCount(0)` after saving the account form → `expect(saveBar(page)).toHaveCount(0)`; the sign-in confirmation `getByRole("dialog", { name: "Codex anmelden" })` stays (AppDialogs).

- `account-defaults.spec.js` test 1: `const card = page.locator(".account-card").filter({ has: … "Work Claude" })` → `const card = await openAccountItem(page, "Work Claude");` (after `page.reload()` the URL keeps the item, so `card` still resolves). Tests "local … only shown with a confirmed login": `page.getByRole("heading", { name: "Work Claude", exact: true })` → `accountRow(page, "Work Claude")`, same for "Local CLI". Test "new managed … remains visible before login": `card.getByRole("heading", { name: "New account" })` → `accountRow(page, "New account")`; before the "Anmelden" assertion add `const card = await openAccountItem(page, "New account");`. Test "local login and logout …": `page.getByText("Angemeldet", { exact: true })` → first `await openAccountItem(page, "Work Claude");` then `accountDetail(page).getByText("Angemeldet", { exact: true })`; `local` → `accountRow(page, "Server Claude")`.
- `ui.spec.js`: after "Account erstellen", `page.getByText("Arbeit", { exact: true })` → `accountRow(page, "Arbeit")`; `page.getByRole("button", { name: "Team bearbeiten" })` → `await openAccountItem(page, "Team")`; the `page.getByRole("alert")` after the 409 → `saveBar(page).getByRole("alert")`. The click on "Account hinzufügen" stays (group "+"). Delete (~283–284): `page.getByRole("button", { name: "Team privat löschen" })` → `accountDetail(page).getByRole("button", { name: "Account löschen", exact: true })`, and the confirmation click → `page.getByRole("dialog").getByRole("button", { name: "Account löschen", exact: true })` (two buttons now share that name); `page.getByRole("heading", { name: "Lokales Konto", exact: true })` → `accountRow(page, "Lokales Konto")` (hub rows are links, not headings). Native login test (~307): before the click on "Anmelden" add `await openAccountItem(page, "Arbeit");` and scope the click to `accountDetail(page)`.
- `live.spec.js` (~75–78, runs in `npm run test:e2e`): after "Account erstellen" the page shows the new account twice (hub row and subpage title), so `page.getByText("Browser Test", { exact: true })` → `accountRow(page, "Browser Test")` (import from `../helpers/accounts-browser.js`).
- `nono-sandbox.spec.js` (~77): before `page.getByRole("button", { name: "Anmelden", exact: true }).click()` add `await openAccountItem(page, "Managed Codex");` and scope the click to `accountDetail(page)`.
- `tests/browser/providers-fixture.js` `createForm`: replace the click on "Gateway account bearbeiten" with `await page.locator(".accounts-hub").getByRole("link", { name: /^Gateway account/ }).click();` (no helper import needed here, keeps the fixture standalone).
- `providers.spec.js`: `page.locator(".account-card")` → `accountDetail(page)` after `await openAccountItem(page, "Gateway account")` (or `"Gateway"`) where the card was not opened yet; `expect(page.getByRole("dialog")).toHaveCount(0)` after "Speichern" → `expect(saveBar(page)).toHaveCount(0)`; `page.getByRole("dialog").getByText("Gebündelter Katalog", …)` (~21, the account form) → `accountDetail(page).getByText(…)` (the "Modellauswahl" dialog at ~266 stays); every "Gateway bearbeiten" → `openAccountItem(page, "Gateway")`. Test "provider account retains a blank key …" (~96–143): its first round saved the unchanged form and asserted the PATCH has no `apiKey`; an unchanged subpage has no bar (deviation 14), so replace that `Speichern` click, the dialog check and the PATCH assertion with `await expect(saveBar(page)).toHaveCount(0); expect(controls.calls.some((c) => c.method === "PATCH")).toBe(false);` — the rotate and remove rounds stay as they are (the third round's PATCH body `{ name, provider: null, removeApiKey: true }` relies on `useAccountDraft` clearing the rotated key after the second save).
- `i18n-plugins-providers.spec.js` (~152): "Edit Gateway account" → `await openAccountItem(page, "Gateway account")`.

Run: `npm run build && npx playwright test tests/browser/account-defaults.spec.js tests/browser/ui.spec.js tests/browser/nono-sandbox.spec.js tests/browser/providers.spec.js tests/browser/i18n-plugins-providers.spec.js tests/browser/live.spec.js tests/browser/tool-installer.spec.js tests/browser/navigation.spec.js tests/browser/file-explorer-editor-navigation.spec.js`
Expected: PASS (`navigation` and `file-explorer-editor-navigation` assert the unchanged page heading "Deine Accounts"/"Your accounts" and need no edit; `tool-installer` clicks the group "+" "Account hinzufügen" and reads the "Tool" combobox of the `cli/new` subpage, no edit).

- [ ] **Step 6: Commit**

```bash
npx prettier --write web/features/accounts web/app/AppDialogs.jsx tests/unit/native-account-save.test.js tests/browser/account-defaults.spec.js tests/browser/ui.spec.js tests/browser/nono-sandbox.spec.js tests/browser/providers.spec.js tests/browser/i18n-plugins-providers.spec.js tests/browser/live.spec.js tests/browser/providers-fixture.js
git add -A web/features/accounts web/app/AppDialogs.jsx tests/unit/native-account-save.test.js tests/browser/account-defaults.spec.js tests/browser/ui.spec.js tests/browser/nono-sandbox.spec.js tests/browser/providers.spec.js tests/browser/i18n-plugins-providers.spec.js tests/browser/live.spec.js tests/browser/providers-fixture.js
git commit -m "feat: manage native CLI accounts on an accounts subpage" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: ChatGPT account and device login

**Files:**

- Create: `web/features/assistants/useChatgptLogin.js`, `ChatgptOfflineNote.jsx`, `ChatgptLoginDetail.jsx`, `ChatgptAccountDetail.jsx`
- Modify: `web/features/accounts/account-details.js`
- Delete: `web/features/assistants/AssistantModelAccounts.jsx`
- Test: migrate `tests/browser/assistant-accounts.spec.js`

**Interfaces:**

- Consumes: `assistantApi.startLogin/loginStatus/cancelLogin/checkAccount/logoutAccount`, `useAssistants()` (`runtime.availability`, `refresh`), `usePolling`, `RouteLink`; Task 3 frame; `data.reloadChatgpt`.
- Produces:
  - `useChatgptLogin({ reload }) => { attempt, active, busy, error, start(), cancel(), perform(operation) }` — keeps the attempt id in `sessionStorage["agentpier-assistant-login"]` and resumes it.
  - `ChatgptOfflineNote({ navigate })`.
  - Registry kinds `chatgpt-login` → `ChatgptLoginDetail`, `chatgpt` → `ChatgptAccountDetail`.

- [ ] **Step 1: Migrate the spec first (fails against the empty registry)**

In `tests/browser/assistant-accounts.spec.js` add `import { accountDetail, accountRow, openAccountItem } from "../helpers/accounts-browser.js";` and:

- Test "device login …" (first test): after `page.goto(baseURL + "/accounts")` replace `const panel = page.getByRole("region", { name: "ChatGPT for agents" });` with `const panel = await openAccountItem(page, "ChatGPT for agents");`. After `state.status = "completed";` replace `await expect(panel.getByText("Personal ChatGPT")).toBeVisible();` with `await expect(accountRow(page, "Personal ChatGPT")).toBeVisible();`, keep `ABCD-EFGHI` count 0 on `panel`, then add `const account = await openAccountItem(page, "Personal ChatGPT");` and use `account` instead of `panel` for "Check connection", "Connection verified" and "Disconnect"; the final `panel.getByText("Personal ChatGPT")).toHaveCount(0)` → `accountRow(page, "Personal ChatGPT")).toHaveCount(0)`.
- Test "device login can be cancelled and fits mobile": `const panel = await openAccountItem(page, "ChatGPT for agents");` (phone: the subpage replaces the hub).
- Test "offline account UI …": `const panel = await openAccountItem(page, "ChatGPT for agents");`.
- Test "an older account fetch …": `const panel = page.getByRole("region", …)` → `const panel = await openAccountItem(page, "ChatGPT for agents");`; `panel.getByText("Personal ChatGPT")` (both before and after Connect) → `accountRow(page, "Personal ChatGPT")`; before `panel.getByRole("button", { name: "Disconnect" })` add `const account = await openAccountItem(page, "Personal ChatGPT");` and click "Disconnect" on `account`; the two final `toHaveCount(0)` checks → `accountRow(page, "Personal ChatGPT")`.

Run: `npm run build && npx playwright test tests/browser/assistant-accounts.spec.js`
Expected: FAIL — the ChatGPT row opens no detail yet (`.accounts-detail` not visible).

- [ ] **Step 2: Implement the hook and the subpages**

Create `web/features/assistants/useChatgptLogin.js`:

```js
import { useState } from "react";
import { assistantApi } from "./assistant-api.js";
import usePolling from "./usePolling.js";

const savedLogin = "agentpier-assistant-login";
export const activeAttempt = (attempt) =>
  ["starting", "awaiting_user"].includes(attempt?.status);

/** The device-code login; a reload of the page resumes a login still waiting. */
export default function useChatgptLogin({ reload }) {
  const [attempt, setAttempt] = useState(() => {
    const id = sessionStorage.getItem(savedLogin);
    return id ? { id, status: "starting" } : null;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const id = activeAttempt(attempt) ? attempt.id : null;
  usePolling(
    async (signal) => {
      try {
        const next = await assistantApi.loginStatus(id);
        if (signal.aborted) return;
        setAttempt(next);
        if (!activeAttempt(next)) {
          sessionStorage.removeItem(savedLogin);
          await reload();
        }
      } catch (failure) {
        if (!signal.aborted) {
          sessionStorage.removeItem(savedLogin);
          setAttempt({ id, status: "failed" });
          setError(failure.message);
        }
      }
    },
    1000,
    { enabled: !!id, restartKey: id },
  );
  async function perform(operation) {
    setBusy(true);
    setError("");
    try {
      await operation();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  return {
    attempt,
    active: activeAttempt(attempt),
    busy,
    error,
    perform,
    start: () =>
      perform(async () => {
        const next = await assistantApi.startLogin();
        sessionStorage.setItem(savedLogin, next.id);
        setAttempt(next);
      }),
    cancel: () =>
      perform(async () => {
        setAttempt(await assistantApi.cancelLogin(attempt.id));
        sessionStorage.removeItem(savedLogin);
        await reload();
      }),
  };
}
```

Create `web/features/assistants/ChatgptOfflineNote.jsx`:

```jsx
import React from "react";
import { assistantCopy as copy } from "../../lib/i18n/messages/assistants.js";
import RouteLink from "./RouteLink.jsx";

export default function ChatgptOfflineNote({ navigate }) {
  return (
    <p className="accounts-note">
      {copy.accountsOffline}{" "}
      <RouteLink
        route={{ view: "settings", settingsSection: "assistants" }}
        navigate={navigate}
      >
        {copy.runtimeLink}
      </RouteLink>
    </p>
  );
}
```

Create `web/features/assistants/ChatgptLoginDetail.jsx`:

```jsx
import React, { useCallback, useEffect } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { assistantCopy as copy } from "../../lib/i18n/messages/assistants.js";
import AccountDetail from "../accounts/AccountDetail.jsx";
import { accountItemTitle } from "../accounts/accounts-items.js";
import ChatgptOfflineNote from "./ChatgptOfflineNote.jsx";
import useAssistants from "./useAssistants.js";
import useChatgptLogin from "./useChatgptLogin.js";

/** "+ ChatGPT": the device-code login for agents (code, open link, cancel, resume). */
export default function ChatgptLoginDetail({ entry, data, navigate }) {
  const { runtime, refresh } = useAssistants();
  const ready = runtime.availability === "ready";
  const { reloadChatgpt } = data;
  const reload = useCallback(async () => {
    await reloadChatgpt();
    await refresh();
  }, [reloadChatgpt, refresh]);
  // The accounts are read again whenever the agent service becomes (un)available.
  useEffect(() => {
    reloadChatgpt().catch(() => {});
  }, [ready, reloadChatgpt]);
  const login = useChatgptLogin({ reload });
  const { attempt } = login;
  return (
    <AccountDetail title={accountItemTitle(entry)}>
      <p className="accounts-note">{copy.accountsDescription}</p>
      <ErrorMessage error={login.error} />
      {!ready && <ChatgptOfflineNote navigate={navigate} />}
      {attempt && (
        <div className="accounts-confirmation" role="status">
          <p>{copy.loginStatus[attempt.status] || copy.loginStatus.failed}</p>
          {login.active && attempt.code && (
            <>
              <code className="accounts-device-code">{attempt.code}</code>
              <p>{copy.loginInstructions}</p>
              <a
                className="button secondary"
                href={attempt.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                {copy.loginOpen}
              </a>
            </>
          )}
          {login.active && (
            <button
              type="button"
              className="button secondary"
              disabled={login.busy}
              onClick={login.cancel}
            >
              {copy.loginCancel}
            </button>
          )}
        </div>
      )}
      {!login.active && (
        <button
          type="button"
          className="button primary"
          disabled={!ready || login.busy}
          onClick={login.start}
        >
          {login.busy ? copy.loading : copy.accountConnect}
        </button>
      )}
    </AccountDetail>
  );
}
```

Create `web/features/assistants/ChatgptAccountDetail.jsx`:

```jsx
import React, { useEffect, useState } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import ListCard from "../../components/ListCard.jsx";
import ListRow from "../../components/ListRow.jsx";
import { assistantCopy as copy } from "../../lib/i18n/messages/assistants.js";
import AccountDetail from "../accounts/AccountDetail.jsx";
import UsedByGroup from "../accounts/UsedByGroup.jsx";
import { accountItemTitle, itemRoute } from "../accounts/accounts-items.js";
import { assistantApi } from "./assistant-api.js";
import ChatgptOfflineNote from "./ChatgptOfflineNote.jsx";
import useAssistants from "./useAssistants.js";

/** One ChatGPT account of the agents: status, check, disconnect. */
export default function ChatgptAccountDetail({
  entry,
  usage,
  agentsEnabled,
  data,
  navigate,
}) {
  const account = entry.record;
  const { runtime, refresh } = useAssistants();
  const ready = runtime.availability === "ready";
  const { reloadChatgpt } = data;
  const [check, setCheck] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    reloadChatgpt().catch(() => {});
  }, [ready, reloadChatgpt]);
  async function perform(operation) {
    setBusy(true);
    setError("");
    try {
      await operation();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <AccountDetail
      title={accountItemTitle(entry)}
      destructive={
        <button
          type="button"
          className="button secondary danger-text"
          disabled={!ready || busy}
          onClick={() =>
            perform(async () => {
              await assistantApi.logoutAccount(account.id);
              await reloadChatgpt();
              await refresh();
              navigate(itemRoute("models"), true);
            })
          }
        >
          {copy.accountDisconnect}
        </button>
      }
    >
      <ErrorMessage error={error} />
      {!ready && <ChatgptOfflineNote navigate={navigate} />}
      <ListCard>
        <ListRow
          label={copy.accountsTitle}
          value={
            copy.accountStatus[ready ? account.status : "offline"] ||
            copy.accountStatus.unknown
          }
        />
      </ListCard>
      {check && (
        <p role="status" className="accounts-note">
          {check === "ok" ? copy.accountVerified : copy.accountCheckFailed}
        </p>
      )}
      <button
        type="button"
        className="button secondary"
        disabled={!ready || busy}
        onClick={() =>
          perform(async () => {
            const result = await assistantApi.checkAccount(account.id);
            setCheck(result.status);
            await reloadChatgpt();
          })
        }
      >
        {copy.accountCheck}
      </button>
      <UsedByGroup usage={usage} agentsEnabled={agentsEnabled} navigate={navigate} />
    </AccountDetail>
  );
}
```

Register in `account-details.js`:

```js
const ChatgptLoginDetail = lazy(() => import("../assistants/ChatgptLoginDetail.jsx"));
const ChatgptAccountDetail = lazy(() => import("../assistants/ChatgptAccountDetail.jsx"));
```

```js
  "chatgpt-login": ChatgptLoginDetail,
  chatgpt: ChatgptAccountDetail,
```

`git rm web/features/assistants/AssistantModelAccounts.jsx`; verify `grep -rn "AssistantModelAccounts.jsx" web` → no output (the server module `server/features/assistants/model-accounts.js` is unrelated and stays).

- [ ] **Step 3: Run the spec to verify it passes**

Run: `npm run build && npx playwright test tests/browser/assistant-accounts.spec.js`
Expected: PASS (4 tests).

- [ ] **Step 4: Commit**

```bash
npx prettier --write web/features/assistants/useChatgptLogin.js web/features/assistants/ChatgptOfflineNote.jsx web/features/assistants/ChatgptLoginDetail.jsx web/features/assistants/ChatgptAccountDetail.jsx web/features/accounts/account-details.js tests/browser/assistant-accounts.spec.js
git add -A web/features/assistants web/features/accounts/account-details.js tests/browser/assistant-accounts.spec.js
git commit -m "feat: connect and check ChatGPT for agents on accounts subpages" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Speech recognition and web search subpages

**Files:**

- Rewrite: `web/features/assistants/SpeechSettings.jsx`, `web/features/assistants/WebSearchSettings.jsx`
- Modify: `web/features/accounts/account-details.js`
- Test: migrate `tests/browser/assistant-channels.spec.js` (speech test), `tests/browser/assistant-web-tools.spec.js` (three web search tests)

**Interfaces:**

- Consumes: `assistantApi.saveSpeech/saveWebSearch`, `runSaveChain`, `RestartConfirmation({ affected, busy, onConfirm, onCancel })`, Task 3 frame, `data.speech/setSpeech/webSearch/setWebSearch`, `state.providerConnections`.
- Produces: registry kinds `speech` → `SpeechSettings(DetailProps)`, `web-search` → `WebSearchSettings(DetailProps)`. Draft revisions `{ speech: settings.revision }` and `{ webSearch: settings.revision }`.

- [ ] **Step 1: Migrate the specs first**

`assistant-channels.spec.js` speech test (~98): replace `const panel = page.getByRole("region", { name: "Speech recognition" });` with `const panel = await openAccountItem(page, "Speech recognition");` (import `openAccountItem` from `../helpers/accounts-browser.js`). Everything else stays: the bar's "Save speech settings" and the immediate "Remove speech key" are inside the region.

`assistant-web-tools.spec.js` web search tests (~253, ~295, ~313): replace each `const panel = page.getByRole("region", { name: "Web search" });` with `const panel = await openAccountItem(page, "Web search");`. `panel.getByRole("alertdialog")` stays (inline `RestartConfirmation`).

Run: `npm run build && npx playwright test tests/browser/assistant-channels.spec.js tests/browser/assistant-web-tools.spec.js`
Expected: FAIL in the four migrated tests (no detail registered).

- [ ] **Step 2: Rewrite `SpeechSettings.jsx`**

```jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import ListCard from "../../components/ListCard.jsx";
import { SelectRow } from "../../components/ListRow.jsx";
import { assistantCopy } from "../../lib/i18n/messages/assistants.js";
import AccountDetail, { AccountSaveBar } from "../accounts/AccountDetail.jsx";
import FieldRow from "../accounts/FieldRow.jsx";
import UsedByGroup from "../accounts/UsedByGroup.jsx";
import useAccountDraft from "../accounts/useAccountDraft.js";
import { accountItemTitle } from "../accounts/accounts-items.js";
import { assistantApi } from "./assistant-api.js";

/** The central Deepgram connection for agent voice messages. */
export default function SpeechSettings({ entry, usage, agentsEnabled, data, navigate }) {
  const copy = assistantCopy.speech;
  const settings = data.speech;
  const formRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const server = useMemo(
    () => ({
      apiKey: "",
      model: settings?.model ?? "",
      language: settings?.language ?? "auto",
    }),
    [settings?.model, settings?.language],
  );
  const form = useAccountDraft({
    server,
    revisions: settings ? { speech: settings.revision } : {},
    tab: accountItemTitle(entry),
    entry,
    steps: [
      {
        id: "speech",
        label: copy.save,
        resource: "speech",
        async run({ values, revision }) {
          const next = await assistantApi.saveSpeech({
            revision,
            model: values.model,
            language: values.language,
            ...(values.apiKey ? { apiKey: values.apiKey } : {}),
          });
          data.setSpeech(next);
          return next;
        },
      },
    ],
  });
  const { draft } = form;
  const { reloadSpeech } = data;
  const conflict = draft.outcome?.status === "conflict";
  useEffect(() => {
    if (conflict) reloadSpeech();
  }, [conflict, reloadSpeech]);
  async function removeKey() {
    setBusy(true);
    setError("");
    try {
      data.setSpeech(
        await assistantApi.saveSpeech({
          revision: settings.revision,
          model: settings.model,
          language: settings.language,
          removeApiKey: true,
        }),
      );
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <AccountDetail
      title={accountItemTitle(entry)}
      destructive={
        settings?.hasSecret && (
          <button
            type="button"
            className="button secondary danger-text"
            disabled={busy}
            onClick={removeKey}
          >
            {copy.remove}
          </button>
        )
      }
      bar={<AccountSaveBar form={form} formRef={formRef} saveLabel={copy.save} />}
    >
      <p className="accounts-note">{copy.description}</p>
      <ErrorMessage error={error || data.serviceError} />
      {settings && (
        <form
          ref={formRef}
          className="accounts-detail-group"
          onSubmit={(event) => {
            event.preventDefault();
            form.save();
          }}
        >
          <p className="accounts-note" role="status">
            {settings.hasSecret ? copy.saved : copy.missing}
          </p>
          <ListCard>
            <FieldRow label={copy.key}>
              <input
                type="password"
                autoComplete="new-password"
                maxLength={1024}
                value={draft.values.apiKey}
                onChange={(event) => draft.set("apiKey", event.target.value)}
              />
            </FieldRow>
            <FieldRow label={copy.model}>
              <input
                required
                value={draft.values.model}
                onChange={(event) => draft.set("model", event.target.value)}
              />
            </FieldRow>
            <SelectRow
              label={copy.language}
              value={draft.values.language}
              onChange={(value) => draft.set("language", value)}
              options={[
                { value: "auto", label: copy.auto },
                { value: "de", label: copy.german },
                { value: "en", label: copy.english },
              ]}
            />
          </ListCard>
        </form>
      )}
      <UsedByGroup usage={usage} agentsEnabled={agentsEnabled} navigate={navigate} />
    </AccountDetail>
  );
}
```

- [ ] **Step 3: Rewrite `WebSearchSettings.jsx`**

```jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import GroupLabel from "../../components/GroupLabel.jsx";
import ListCard from "../../components/ListCard.jsx";
import { RadioRow, SelectRow } from "../../components/ListRow.jsx";
import { assistantCopy } from "../../lib/i18n/messages/assistants.js";
import { runSaveChain } from "../../lib/settings/save-chain.js";
import AccountDetail, { AccountSaveBar } from "../accounts/AccountDetail.jsx";
import FieldRow from "../accounts/FieldRow.jsx";
import UsedByGroup from "../accounts/UsedByGroup.jsx";
import useAccountDraft from "../accounts/useAccountDraft.js";
import { accountItemTitle } from "../accounts/accounts-items.js";
import { restartNote } from "../accounts/account-usage-view.js";
import { assistantApi } from "./assistant-api.js";
import RestartConfirmation from "./RestartConfirmation.jsx";

const providers = ["duckduckgo", "perplexity", "brave"];

/** The search provider agents use; keys are written here and never shown again. */
export default function WebSearchSettings({
  entry,
  usage,
  agentsEnabled,
  state,
  data,
  navigate,
}) {
  const copy = assistantCopy.webSearch;
  const settings = data.webSearch;
  const formRef = useRef(null);
  const [removal, setRemoval] = useState(null);
  const [error, setError] = useState("");
  const openRouter = (state.providerConnections || []).filter(
    (connection) => connection.providerId === "openrouter",
  );
  const server = useMemo(
    () => ({
      provider: settings?.provider ?? "duckduckgo",
      connectionId: settings?.connectionId || "",
      braveKey: "",
    }),
    [settings?.provider, settings?.connectionId],
  );
  const form = useAccountDraft({
    server,
    revisions: settings ? { webSearch: settings.revision } : {},
    tab: accountItemTitle(entry),
    entry,
    steps: [
      {
        id: "web-search",
        label: copy.save,
        resource: "webSearch",
        async run({ values, revision, confirmations }) {
          const next = await assistantApi.saveWebSearch({
            revision,
            provider: values.provider,
            ...(values.provider === "perplexity" && values.connectionId
              ? { connectionId: values.connectionId }
              : {}),
            ...(values.provider === "brave" && values.braveKey
              ? { braveKey: values.braveKey }
              : {}),
            ...confirmations,
          });
          data.setWebSearch(next);
          return next;
        },
      },
    ],
  });
  const { draft } = form;
  const values = draft.values;
  const { reloadWebSearch } = data;
  const conflict = draft.outcome?.status === "conflict";
  useEffect(() => {
    if (conflict) reloadWebSearch();
  }, [conflict, reloadWebSearch]);
  // Any change withdraws an open restart question; it was about the previous state.
  const edit = (key, value) => {
    draft.confirmation?.cancel();
    draft.set(key, value);
  };
  async function removeKey() {
    setError("");
    const result = await runSaveChain({
      steps: [
        {
          id: "remove-key",
          label: copy.removeKey,
          run: ({ confirmations }) =>
            assistantApi.saveWebSearch({
              revision: settings.revision,
              provider: "brave",
              braveKey: null,
              ...confirmations,
            }),
        },
      ],
      values: {},
      base: {},
      ask: (request) =>
        new Promise((resolve) =>
          setRemoval({
            ...request,
            confirm: () => {
              setRemoval(null);
              resolve(true);
            },
            cancel: () => {
              setRemoval(null);
              resolve(false);
            },
          }),
        ),
    });
    if (result.status === "saved") data.setWebSearch(result.results["remove-key"]);
    else if (result.error) setError(result.error.message);
  }
  const restart = draft.confirmation?.kind === "restart" ? draft.confirmation : removal;
  return (
    <AccountDetail
      title={accountItemTitle(entry)}
      destructive={
        values.provider === "brave" &&
        settings?.hasBraveKey && (
          <button
            type="button"
            className="button secondary danger-text"
            disabled={draft.saving || Boolean(removal)}
            onClick={removeKey}
          >
            {copy.removeKey}
          </button>
        )
      }
      bar={
        <AccountSaveBar
          form={form}
          formRef={formRef}
          saveLabel={copy.save}
          note={restartNote(usage)}
        />
      }
    >
      <ErrorMessage error={error || data.serviceError} />
      {settings && (
        <form
          ref={formRef}
          className="accounts-detail-group"
          onSubmit={(event) => {
            event.preventDefault();
            form.save();
          }}
        >
          <p className="accounts-note" role="status">
            {settings.ready ? copy.ready : copy.notConfigured}
          </p>
          <GroupLabel hint={copy.description}>{copy.provider}</GroupLabel>
          <ListCard label={copy.provider}>
            {providers.map((id) => (
              <RadioRow
                key={id}
                name="web-search-provider"
                value={id}
                label={copy[id]}
                checked={values.provider === id}
                onChange={(value) => edit("provider", value)}
              />
            ))}
          </ListCard>
          {values.provider === "perplexity" &&
            (openRouter.length ? (
              <ListCard>
                <SelectRow
                  label={copy.connection}
                  value={values.connectionId}
                  onChange={(value) => edit("connectionId", value)}
                  options={[
                    { value: "", label: copy.noConnection },
                    ...openRouter.map((connection) => ({
                      value: connection.id,
                      label: connection.name,
                    })),
                  ]}
                />
              </ListCard>
            ) : (
              <p className="accounts-note">{copy.noConnections}</p>
            ))}
          {values.provider === "brave" && (
            <>
              <p className="accounts-note" role="status">
                {settings.hasBraveKey ? copy.braveKeyStored : copy.braveKeyMissing}
              </p>
              <ListCard>
                <FieldRow label={copy.braveKey}>
                  <input
                    type="password"
                    autoComplete="new-password"
                    maxLength={1024}
                    value={values.braveKey}
                    onChange={(event) => edit("braveKey", event.target.value)}
                  />
                </FieldRow>
              </ListCard>
            </>
          )}
        </form>
      )}
      {restart && (
        <RestartConfirmation
          affected={restart.data?.affected}
          busy={false}
          onConfirm={restart.confirm}
          onCancel={restart.cancel}
        />
      )}
      <UsedByGroup usage={usage} agentsEnabled={agentsEnabled} navigate={navigate} />
    </AccountDetail>
  );
}
```

Register in `account-details.js`:

```js
const SpeechSettings = lazy(() => import("../assistants/SpeechSettings.jsx"));
const WebSearchSettings = lazy(() => import("../assistants/WebSearchSettings.jsx"));
```

```js
  speech: SpeechSettings,
  "web-search": WebSearchSettings,
```

- [ ] **Step 4: Run the specs to verify they pass**

Run: `npm run build && npx playwright test tests/browser/assistant-channels.spec.js tests/browser/assistant-web-tools.spec.js tests/browser/assistant-settings.spec.js`
Expected: PASS (`assistant-settings` "links to Accounts …" asserts `/accounts$` and needs no edit).

- [ ] **Step 5: Commit**

```bash
npx prettier --write web/features/assistants/SpeechSettings.jsx web/features/assistants/WebSearchSettings.jsx web/features/accounts/account-details.js tests/browser/assistant-channels.spec.js tests/browser/assistant-web-tools.spec.js
git add web/features/assistants/SpeechSettings.jsx web/features/assistants/WebSearchSettings.jsx web/features/accounts/account-details.js tests/browser/assistant-channels.spec.js tests/browser/assistant-web-tools.spec.js
git commit -m "feat: set speech and web search on accounts subpages" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: MCP server subpages and CLI finds

The side panel becomes a subpage; server details, CLI statuses, Codex logins, agent OAuth and removal move into the server's subpage; the finds get their own subpage.

**Files:**

- Create: `web/features/mcp-servers/mcp-server-save.js`, `McpServerFields.jsx`, `McpServerDetails.jsx`, `McpServerInfo.jsx`, `McpRemoveConfirmation.jsx`, `McpServerDetail.jsx`, `McpFindsDetail.jsx`
- Modify: `web/features/accounts/account-details.js`, `tests/browser/mcp-cli-fixture.js` (`openAdd`)
- Delete: `web/features/mcp-servers/McpServersSettings.jsx`, `web/features/mcp-servers/McpServerForm.jsx`
- Test: `tests/unit/mcp-server-save.test.js`; migrate `agent-mcp-servers.spec.js`, `mcp-oauth.spec.js`, `mcp-cli-bindings.spec.js`, `mcp-cli-notices.spec.js`, `mcp-codex-login.spec.js`, `mcp-value-references.spec.js`, `extensions.spec.js`

**Interfaces:**

- Consumes: `draftFrom`, `requestBody`, `dropsStoredHeaders` (`mcp-server-draft.js`), `cliSupport`, `confirmationRequest`, `assistantApi.createMcpServer/updateMcpServer/removeMcpServer`, `savedNotice` (Task 3), existing MCP components, Task 3 frame, `data.mcpServers/reloadMcp/mcpGeneration`, `oauth`, `notifyMcp`.
- Produces:
  - `mcpServerValues(server | null) => { ...draftFrom(server), clis: string[] }`.
  - `mcpTargets(values, server) => { target, wanted, added, clisChanged }`.
  - `OAUTH_SWITCH_REQUIRED`, `CLI_STDIO_REQUIRED` (client-side confirmation codes).
  - `mcpServerStep({ server, label, saveServer?(server, body), saved(result) }) => Step` — `id: "mcp-server"`, `resource: "mcp"`; confirmations `oauthSwitch` (`confirmSwitch`), `cliStdio` (`confirmStdio`, asked before any request), server `stdio` (`confirmStdio`); sends the draft's base `revision`.
  - `McpServerFields({ formId, values, server, set, fieldError })`, `McpServerDetails({ server })`, `usersText(server)`, `McpServerInfo({ server, agentsEnabled, oauth, reload })`, `McpRemoveConfirmation({ server, busy, onConfirm, onCancel })`.
  - Registry kinds `mcp-server`, `mcp-new` → `McpServerDetail`, `mcp-finds` → `McpFindsDetail`.

- [ ] **Step 1: Write the failing unit test**

Create `tests/unit/mcp-server-save.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { runSaveChain } from "../../web/lib/settings/save-chain.js";
import {
  mcpServerStep,
  mcpServerValues,
  mcpTargets,
} from "../../web/features/mcp-servers/mcp-server-save.js";

const docs = {
  id: "s1",
  name: "docs",
  transport: "http",
  url: "https://a.example/mcp",
  auth: "headers",
  headerNames: ["Authorization"],
  envNames: [],
  clis: [],
  revision: 4,
};
const chain = (step, values, base, answers = []) => {
  const asked = [];
  return runSaveChain({
    steps: [step],
    values,
    base,
    revisions: { mcp: 3 },
    ask: async (request) => {
      asked.push(request.kind);
      return answers.shift() ?? true;
    },
  }).then((result) => ({ result, asked }));
};

test("an edit sends the draft's base revision, not the latest record's", async () => {
  const bodies = [];
  const step = mcpServerStep({
    server: docs,
    label: "Save server",
    saveServer: async (server, body) => bodies.push(body) && { id: "s1", revision: 5 },
    saved: async () => {},
  });
  const base = mcpServerValues(docs);
  const { result } = await chain(step, { ...base, name: "docs2" }, base);
  assert.equal(result.status, "saved");
  assert.deepEqual(bodies[0], { revision: 3, name: "docs2" });
  assert.equal(result.revisions.mcp, 5);
});

test("switching to OAuth asks before deleting stored headers", async () => {
  const bodies = [];
  const step = mcpServerStep({
    server: docs,
    label: "Save server",
    saveServer: async (server, body) => bodies.push(body) && { revision: 5 },
    saved: async () => {},
  });
  const base = mcpServerValues(docs);
  const cancelled = await chain(step, { ...base, auth: "oauth" }, base, [false]);
  assert.equal(cancelled.result.status, "cancelled");
  assert.deepEqual(cancelled.asked, ["oauthSwitch"]);
  assert.equal(bodies.length, 0);
  const confirmed = await chain(step, { ...base, auth: "oauth" }, base);
  assert.equal(confirmed.result.status, "saved");
  assert.equal(bodies[0].auth, "oauth");
});

test("a local command for a newly chosen CLI is confirmed before anything is sent", async () => {
  const bodies = [];
  const step = mcpServerStep({
    server: null,
    label: "Save server",
    saveServer: async (server, body) => bodies.push(body) && { id: "new" },
    saved: async () => {},
  });
  const base = mcpServerValues(null);
  const values = {
    ...base,
    name: "local",
    transport: "stdio",
    command: "npx",
    clis: ["claude"],
  };
  const cancelled = await chain(step, values, base, [false]);
  assert.deepEqual(cancelled.asked, ["cliStdio"]);
  assert.equal(bodies.length, 0);
  const confirmed = await chain(step, values, base);
  assert.equal(confirmed.result.status, "saved");
  assert.equal(bodies[0].confirmStdio, true);
  assert.deepEqual(bodies[0].clis, ["claude"]);
});

test("the server's stdio question and a value refusal come back", async () => {
  let calls = 0;
  const refusal = Object.assign(new Error("literal"), {
    code: "MCP_SERVER_VALUE_REFERENCE",
    field: "cwd",
    status: 400,
  });
  const step = mcpServerStep({
    server: null,
    label: "Save server",
    saveServer: async () => {
      calls += 1;
      if (calls === 1)
        throw Object.assign(new Error("stdio"), {
          code: "MCP_STDIO_CONFIRMATION_REQUIRED",
        });
      throw refusal;
    },
    saved: async () => {},
  });
  const base = mcpServerValues(null);
  const values = { ...base, name: "local", transport: "stdio", command: "npx" };
  const { result, asked } = await chain(step, values, base);
  assert.deepEqual(asked, ["stdio"]);
  assert.equal(result.status, "error");
  assert.equal(result.error, refusal);
});

test("targets drop CLIs that cannot run the server", () => {
  const values = {
    ...mcpServerValues(null),
    transport: "sse",
    clis: ["claude", "codex"],
  };
  const { wanted, added, clisChanged } = mcpTargets(values, null);
  assert.equal(wanted.includes("codex"), false);
  assert.deepEqual(added, wanted);
  assert.equal(clisChanged, wanted.length > 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/unit/mcp-server-save.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement the save module**

Create `web/features/mcp-servers/mcp-server-save.js`:

```js
import { confirmationRequest } from "../../lib/settings/save-chain.js";
import { assistantApi } from "../assistants/assistant-api.js";
import { cliSupport } from "./cli-support.js";
import { draftFrom, dropsStoredHeaders, requestBody } from "./mcp-server-draft.js";

// Client-side questions the form asked before sending anything.
export const OAUTH_SWITCH_REQUIRED = "MCP_OAUTH_SWITCH_CONFIRMATION_REQUIRED";
export const CLI_STDIO_REQUIRED = "MCP_CLI_STDIO_CONFIRMATION_REQUIRED";
const question = (code) => Object.assign(new Error(code), { code });

/** The draft of one server: its form fields plus the coding CLIs it goes to. */
export const mcpServerValues = (server) => ({
  ...draftFrom(server),
  clis: server?.clis || [],
});

/** The CLIs the server goes to: unsupported ones fall away as the draft changes. */
export function mcpTargets(values, server) {
  const target = { transport: values.transport, cwd: values.cwd.trim() };
  const wanted = values.clis.filter((cli) => cliSupport(cli, target).supported);
  const before = server?.clis || [];
  const added = wanted.filter((cli) => !before.includes(cli));
  return {
    target,
    wanted,
    added,
    clisChanged: added.length > 0 || wanted.length !== before.length,
  };
}

const defaultSave = (server, body) =>
  server
    ? assistantApi.updateMcpServer(server.id, body)
    : assistantApi.createMcpServer(body);

/**
 * One request stores the definition and its CLIs together or neither. A switch to
 * OAuth that deletes stored headers and a local command for a newly chosen CLI are
 * confirmed first; the server may still ask for its own stdio confirmation.
 */
export function mcpServerStep({ server, label, saveServer = defaultSave, saved }) {
  return {
    id: "mcp-server",
    label,
    resource: "mcp",
    async run({ values, revision, confirmations }) {
      if (dropsStoredHeaders(values, server) && !confirmations.confirmSwitch)
        throw question(OAUTH_SWITCH_REQUIRED);
      const { wanted, added, clisChanged } = mcpTargets(values, server);
      if (values.transport === "stdio" && added.length && !confirmations.confirmStdio)
        throw question(CLI_STDIO_REQUIRED);
      const body = {
        ...requestBody(values, server),
        ...(server ? { revision } : {}),
        ...(clisChanged ? { clis: wanted } : {}),
        ...(confirmations.confirmStdio ? { confirmStdio: true } : {}),
      };
      const result = await saveServer(server, body);
      await saved(result);
      return result;
    },
    confirmation: (error) =>
      error?.code === OAUTH_SWITCH_REQUIRED
        ? { kind: "oauthSwitch", flags: { confirmSwitch: true } }
        : error?.code === CLI_STDIO_REQUIRED
          ? { kind: "cliStdio", flags: { confirmStdio: true } }
          : confirmationRequest(error),
  };
}
```

Run: `node --test tests/unit/mcp-server-save.test.js`
Expected: PASS.

- [ ] **Step 4: Move the presentational parts**

Create `web/features/mcp-servers/McpServerDetails.jsx` with `names`, `usersText` and `ServerDetails` moved verbatim from `McpServersSettings.jsx` lines 17–90, exported as:

```jsx
import React from "react";
import { mcpCliCopy as cliCopy } from "../../lib/i18n/messages/mcp-cli.js";
import { mcpOAuthCopy } from "../../lib/i18n/messages/mcp-oauth.js";
import { mcpServerCopy as copy } from "../../lib/i18n/messages/mcp-servers.js";
import { names as cliNames } from "../../lib/providers.js";
import { usesOAuth } from "./McpOAuthStatus.jsx";

const names = (list) => (list.length ? list.join(", ") : copy.noNames);

/** "Agents: Home, Lead · CLIs: Claude Code, Codex": who uses a server, by name. */
export function usersText(server) {
  const parts = [];
  if (server.users?.agents?.length)
    parts.push(cliCopy.agentsUsing(server.users.agents.join(", ")));
  if (server.users?.clis?.length)
    parts.push(
      cliCopy.clisUsing(server.users.clis.map((cli) => cliNames[cli] || cli).join(", ")),
    );
  return parts.length ? parts.join(" · ") : cliCopy.unused;
}

export default function McpServerDetails({ server }) {
  const stdio = server.transport === "stdio";
  return (
    <dl className="mcp-details">
      {stdio ? (
        <>
          <dt>{copy.resolvedCommand}</dt>
          <dd>
            <code>{server.command}</code>
          </dd>
          {server.args?.length > 0 && (
            <>
              <dt>{copy.argsLabel}</dt>
              <dd>
                <code>{server.args.join(" ")}</code>
              </dd>
            </>
          )}
          {server.cwd && (
            <>
              <dt>{copy.cwdLabel}</dt>
              <dd>
                <code>{server.cwd}</code>
              </dd>
            </>
          )}
          <dt>{copy.envNames}</dt>
          <dd>{names(server.envNames)}</dd>
        </>
      ) : (
        <>
          <dt>{copy.urlLabel}</dt>
          <dd>
            <code>{server.url}</code>
          </dd>
          {usesOAuth(server) ? (
            <>
              <dt>{mcpOAuthCopy.authDetail}</dt>
              <dd>{mcpOAuthCopy.auths.oauth}</dd>
              {server.oauthScope && (
                <>
                  <dt>{mcpOAuthCopy.scopeDetail}</dt>
                  <dd>
                    <code>{server.oauthScope}</code>
                  </dd>
                </>
              )}
            </>
          ) : (
            <>
              <dt>{copy.headerNames}</dt>
              <dd>{names(server.headerNames)}</dd>
            </>
          )}
        </>
      )}
    </dl>
  );
}
```

Create `web/features/mcp-servers/McpRemoveConfirmation.jsx` with `RemoveConfirmation` moved verbatim from `McpServersSettings.jsx` lines 103–138 as the default export `McpRemoveConfirmation({ server, busy, onConfirm, onCancel })` (imports: `React, { useId }`, `useAlertDialogFocus`, `mcpServerCopy as copy`).

Create `web/features/mcp-servers/McpServerInfo.jsx`:

```jsx
import React from "react";
import { mcpServerCopy as copy } from "../../lib/i18n/messages/mcp-servers.js";
import McpCliStatus from "./McpCliStatus.jsx";
import McpServerDetails, { usersText } from "./McpServerDetails.jsx";
import { McpOAuthActions } from "./McpOAuthLogin.jsx";
import McpOAuthStatus, { McpOAuthStatusHint, usesOAuth } from "./McpOAuthStatus.jsx";

/**
 * What a saved server is: transport, details, users, per-CLI status (overwrite/adopt,
 * Codex account logins) and, with agents, its OAuth login. Agent OAuth logins exist
 * only with agents; the rest works without.
 */
export default function McpServerInfo({ server, agentsEnabled, oauth, reload }) {
  const agentLogin = agentsEnabled && usesOAuth(server);
  return (
    <div className="mcp-item">
      <div className="mcp-item-head">
        <strong>{server.name}</strong>
        <span className="mcp-badge">{copy.transports[server.transport]}</span>
        {server.transport === "stdio" && (
          <span className="mcp-badge mcp-badge-warn">{copy.stdioBadge}</span>
        )}
        {agentLogin && <McpOAuthStatus server={server} />}
      </div>
      <McpServerDetails server={server} />
      {server.users && <p className="mcp-hint">{usersText(server)}</p>}
      <McpCliStatus server={server} onChanged={reload} />
      {agentLogin && <McpOAuthStatusHint server={server} />}
      {agentLogin && (
        <div className="mcp-actions">
          <McpOAuthActions server={server} oauth={oauth} />
        </div>
      )}
    </div>
  );
}
```

Create `web/features/mcp-servers/McpServerFields.jsx` — the form body of `McpServerForm.jsx` (its lines 39–48 helpers and the JSX from `<div className="mcp-field">` for the name through the two `mcp-hint` secret notes), with `draft` renamed to `values`, `server.transport` locked display unchanged, and the CLI choices reading `values.clis`:

```jsx
import React from "react";
import Segment from "../../components/Segment.jsx";
import { mcpServerCopy as copy } from "../../lib/i18n/messages/mcp-servers.js";
import McpAuthFields from "./McpAuthFields.jsx";
import McpCliChoices from "./McpCliChoices.jsx";
import McpSecretRows from "./McpSecretRows.jsx";

/** The fields of one MCP server; a refused value is shown at its field. */
export default function McpServerFields({ formId, values, server, set, fieldError }) {
  const errorId = `${formId}-field-error`;
  const errorOf = (field) => (fieldError?.field === field ? fieldError.text : "");
  const describe = (field) =>
    errorOf(field) ? { "aria-invalid": true, "aria-describedby": errorId } : {};
  const fieldMessage = (field) =>
    errorOf(field) && (
      <small id={errorId} role="alert" className="mcp-field-error">
        {errorOf(field)}
      </small>
    );
  const text = (key) => (event) => set(key)(event.target.value);
  const stdio = values.transport === "stdio";
  const oauth = !stdio && values.auth === "oauth";
  const target = { transport: values.transport, cwd: values.cwd.trim() };
  return (
    <div className="mcp-form">
      <div className="mcp-field">
        <label htmlFor={`${formId}-name`}>
          {copy.nameLabel}
          <input
            id={`${formId}-name`}
            aria-describedby={`${formId}-name-rule`}
            value={values.name}
            required
            maxLength={30}
            pattern="[A-Za-z][A-Za-z0-9_\-]{0,29}"
            autoCapitalize="none"
            spellCheck={false}
            onChange={text("name")}
          />
        </label>
        <small className="mcp-hint" id={`${formId}-name-rule`}>
          {copy.nameRule}
        </small>
      </div>
      <div className="mcp-field">
        <span aria-hidden="true">{copy.transportLabel}</span>
        {server ? (
          <p className="mcp-hint">
            {copy.transports[server.transport]} · {copy.transportLocked}
          </p>
        ) : (
          <Segment
            label={copy.transportLabel}
            value={values.transport}
            onChange={set("transport")}
            options={["http", "sse", "stdio"].map((value) => ({
              value,
              label: copy.transports[value],
            }))}
          />
        )}
      </div>
      {stdio ? (
        <>
          <label>
            {copy.commandLabel}
            <input
              value={values.command}
              required
              autoCapitalize="none"
              spellCheck={false}
              {...describe("command")}
              onChange={text("command")}
            />
            {fieldMessage("command")}
            <small className="mcp-hint">{copy.commandHint}</small>
          </label>
          <label>
            {copy.argsLabel}
            <textarea
              rows={3}
              value={values.args}
              autoCapitalize="none"
              spellCheck={false}
              {...describe("args")}
              onChange={text("args")}
            />
            {fieldMessage("args")}
          </label>
          <label>
            {copy.cwdLabel}
            <input
              value={values.cwd}
              autoCapitalize="none"
              spellCheck={false}
              {...describe("cwd")}
              onChange={text("cwd")}
            />
            {fieldMessage("cwd")}
          </label>
          <McpSecretRows
            label={copy.envLabel}
            rows={values.env}
            onChange={set("env")}
            error={errorOf("env")}
            invalidNames={fieldError?.names}
            errorId={errorId}
          />
        </>
      ) : (
        <>
          <label>
            {copy.urlLabel}
            <input
              value={values.url}
              required
              type="url"
              placeholder="https://example.com/mcp"
              autoCapitalize="none"
              spellCheck={false}
              {...describe("url")}
              onChange={text("url")}
            />
            {fieldMessage("url")}
            {server && <small className="mcp-hint">{copy.urlHint}</small>}
          </label>
          <McpAuthFields draft={values} server={server} set={set} />
          {!oauth && (
            <McpSecretRows
              label={copy.headersLabel}
              rows={values.headers}
              onChange={set("headers")}
              error={errorOf("headers")}
              invalidNames={fieldError?.names}
              errorId={errorId}
            />
          )}
        </>
      )}
      <McpCliChoices
        id={`${formId}-clis`}
        target={target}
        selected={values.clis}
        bound={server?.clis || []}
        name={server?.name}
        onChange={set("clis")}
      />
      <p className="mcp-hint">{copy.secretNote}</p>
      <p className="mcp-hint">{copy.secretPlacement}</p>
    </div>
  );
}
```

- [ ] **Step 5: Build the subpages**

Create `web/features/mcp-servers/McpServerDetail.jsx`:

```jsx
import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { mcpServerCopy as copy } from "../../lib/i18n/messages/mcp-servers.js";
import AccountDetail, { AccountSaveBar } from "../accounts/AccountDetail.jsx";
import UsedByGroup from "../accounts/UsedByGroup.jsx";
import useAccountDraft from "../accounts/useAccountDraft.js";
import useCreatedRedirect from "../accounts/useCreatedRedirect.js";
import { accountItemTitle, itemRoute } from "../accounts/accounts-items.js";
import { assistantApi } from "../assistants/assistant-api.js";
import { OAuthSwitchConfirmation } from "./McpAuthFields.jsx";
import McpRemoveConfirmation from "./McpRemoveConfirmation.jsx";
import McpServerFields from "./McpServerFields.jsx";
import McpServerInfo from "./McpServerInfo.jsx";
import StdioConfirmation from "./StdioConfirmation.jsx";
import { savedNotice } from "./mcp-notices.js";
import { mcpServerStep, mcpServerValues } from "./mcp-server-save.js";
import "./mcp-servers.css";
import "./mcp-cli.css";

const valueReference = (error) => error?.code === "MCP_SERVER_VALUE_REFERENCE";

/** One central MCP server: create (item=new) or view, edit, log in, remove. */
export default function McpServerDetail({
  entry,
  usage,
  agentsEnabled,
  data,
  navigate,
  oauth,
  notifyMcp,
}) {
  const server = entry.kind === "mcp-server" ? entry.record : null;
  const formId = useId();
  const formRef = useRef(null);
  // Status refreshes do not change the definition; only a new revision does.
  const signature = JSON.stringify([server?.id, server?.revision, server?.clis]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const initial = useMemo(() => mcpServerValues(server), [signature]);
  const [created, setCreated] = useState(null);
  const [fieldError, setFieldError] = useState(null);
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const consumed = useRef(null);
  const form = useAccountDraft({
    server: initial,
    revisions: server ? { mcp: server.revision } : {},
    tab: accountItemTitle(entry),
    entry,
    steps: [
      mcpServerStep({
        server,
        label: copy.save,
        saved: async (result) => {
          notifyMcp(savedNotice(result));
          await data.reloadMcp();
          if (!server) setCreated(result.id);
        },
      }),
    ],
  });
  const { draft } = form;
  useCreatedRedirect({ created, draft, navigate, section: "mcp-servers" });
  const { reloadMcp } = data;
  const conflict = draft.outcome?.status === "conflict";
  // The newer revision must be known before "Overwrite anyway".
  useEffect(() => {
    if (conflict) reloadMcp();
  }, [conflict, reloadMcp]);
  // A refused value belongs to its field, not to the bar.
  useEffect(() => {
    const failure = draft.outcome?.error;
    if (!valueReference(failure)) return;
    consumed.current = draft.outcome;
    setFieldError({
      field: failure.field,
      names: failure.names || [],
      text: failure.names?.length
        ? `${failure.message} ${copy.referenceNames(failure.names.join(", "))}`
        : failure.message,
    });
  }, [draft.outcome]);
  const barDraft =
    draft.outcome && draft.outcome === consumed.current
      ? { ...draft, outcome: null }
      : draft;
  // Any change withdraws an open question; it was about the previous state.
  const set = (key) => (value) => {
    draft.confirmation?.cancel();
    if (fieldError?.field === key) setFieldError(null);
    draft.set(key, value);
  };
  async function remove() {
    setBusy(true);
    try {
      const result = await assistantApi.removeMcpServer(server.id);
      notifyMcp(savedNotice(result));
      await data.reloadMcp();
      navigate(itemRoute("mcp-servers"), true);
    } catch (failure) {
      setError(failure.message);
      setBusy(false);
    }
  }
  const confirmation = draft.confirmation;
  return (
    <AccountDetail
      title={accountItemTitle(entry)}
      destructive={
        server &&
        (removing ? (
          <McpRemoveConfirmation
            server={server}
            busy={busy}
            onConfirm={remove}
            onCancel={() => setRemoving(false)}
          />
        ) : (
          <button
            type="button"
            className="button secondary danger-text"
            aria-label={copy.removeNamed(server.name)}
            data-focus-key={`remove-${server.id}`}
            onClick={() => setRemoving(true)}
          >
            {copy.remove}
          </button>
        ))
      }
      bar={
        <AccountSaveBar
          form={form}
          draft={barDraft}
          formRef={formRef}
          saveLabel={copy.save}
          saveFocusKey="mcp-form-save"
        />
      }
    >
      {server && (
        <McpServerInfo
          server={server}
          agentsEnabled={agentsEnabled}
          oauth={oauth}
          reload={data.reloadMcp}
        />
      )}
      <ErrorMessage error={error} />
      <form
        id={formId}
        ref={formRef}
        className="accounts-detail-group"
        onSubmit={(event) => {
          event.preventDefault();
          form.save();
        }}
      >
        <fieldset disabled={draft.saving}>
          <McpServerFields
            formId={formId}
            values={draft.values}
            server={server}
            set={set}
            fieldError={fieldError}
          />
        </fieldset>
      </form>
      {confirmation?.kind === "oauthSwitch" && (
        <OAuthSwitchConfirmation
          names={server.headerNames}
          busy={false}
          onConfirm={confirmation.confirm}
          onCancel={confirmation.cancel}
        />
      )}
      {confirmation?.kind === "stdio" && (
        <StdioConfirmation
          returnKey="mcp-form-save"
          busy={false}
          onConfirm={confirmation.confirm}
          onCancel={confirmation.cancel}
        />
      )}
      {confirmation?.kind === "cliStdio" && (
        <StdioConfirmation
          cli
          returnKey="mcp-form-save"
          busy={false}
          onConfirm={confirmation.confirm}
          onCancel={confirmation.cancel}
        />
      )}
      {server && (
        <UsedByGroup usage={usage} agentsEnabled={agentsEnabled} navigate={navigate} />
      )}
    </AccountDetail>
  );
}
```

Create `web/features/mcp-servers/McpFindsDetail.jsx`:

```jsx
import React from "react";
import McpCliFinds from "./McpCliFinds.jsx";
import "./mcp-servers.css";
import "./mcp-cli.css";

// The finds bring their own region and heading ("In den CLIs gefunden"); a second
// frame heading would duplicate the region name.
export default function McpFindsDetail({ data }) {
  return (
    <div className="accounts-detail accounts-finds">
      <McpCliFinds refresh={data.mcpGeneration} onAdopted={data.reloadMcp} />
    </div>
  );
}
```

Register in `account-details.js`:

```js
const McpServerDetail = lazy(() => import("../mcp-servers/McpServerDetail.jsx"));
const McpFindsDetail = lazy(() => import("../mcp-servers/McpFindsDetail.jsx"));
```

```js
  "mcp-server": McpServerDetail,
  "mcp-new": McpServerDetail,
  "mcp-finds": McpFindsDetail,
```

`git rm web/features/mcp-servers/McpServersSettings.jsx web/features/mcp-servers/McpServerForm.jsx`; verify `grep -rn "McpServersSettings\|McpServerForm" web` → no output.

- [ ] **Step 6: Migrate the MCP specs**

Rules:

| Old                                                                                                       | New                                                                                                         |
| --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `page.getByRole("region", { name: "MCP servers" })` (list, banner, notices, "Add MCP server", empty text) | unchanged — the hub group is that region                                                                    |
| `page.getByRole("dialog")` of the server form                                                             | `accountDetail(page)`                                                                                       |
| "Edit X"                                                                                                  | `await openAccountItem(page, "X")`                                                                          |
| `panel.getByRole("listitem")` / `.filter({ hasText: "X" })` for a server                                  | `await openAccountItem(page, "X")` then `accountDetail(page)`                                               |
| `page.locator(".mcp-item")` for a server                                                                  | `await openAccountItem(page, "X")` then `accountDetail(page).locator(".mcp-item")`                          |
| "Remove X"                                                                                                | `await openAccountItem(page, "X")`, then `accountDetail(page).getByRole("button", { name: "Remove X" })`    |
| `expect(dialog).toHaveCount(0)` after "Save server"                                                       | `await expect(saveBar(page)).toHaveCount(0)`                                                                |
| `page.getByRole("region", { name: "Found in the CLIs" / "In den CLIs gefunden" })`                        | `await openAccountItem(page, "Found in the CLIs")` first; the region inside stays                           |
| `page.getByRole("group", { name: "Codex accounts for search" })`                                          | open "search" first; the group stays                                                                        |
| on phones (`label === "phone"`) a hub element after a detail one                                          | `await backToAccounts(page)` before the hub locator, `openAccountItem` again before the next detail locator |

Per file:

- `tests/browser/mcp-cli-fixture.js` `openAdd`: keep the click on "Add MCP server" inside the region and `return accountDetail(page);` (import from `../helpers/accounts-browser.js`).
- `mcp-cli-bindings.spec.js`: test 1 unchanged (hub). Tests with `const dialog = await openAdd(page)` unchanged except `expect(dialog).toHaveCount(0)` → `saveBar`. "Edit docs" tests (~136, ~157): `openAccountItem(page, "docs")`, `dialog = accountDetail(page)`. Status test (~211): before the first `page.getByText("Agents: Home · CLIs: Claude Code, Codex")` add `await openAccountItem(page, "docs");`; assertions about the server "search" (Codex accounts group, OpenCode/Claude login hints, "Adopt search from OpenCode") need `await openAccountItem(page, "search");` before them; `page.locator(".mcp-item").first()` refers to the opened server; group the assertions per server in their original order and open the server before each block. The conflict test (~289): `openAccountItem(page, "docs")` before the assertions.
- `mcp-cli-notices.spec.js`: "Edit docs" → `openAccountItem`; `found` regions → `await openAccountItem(page, "Found in the CLIs");` before `const found = page.getByRole("region", { name: "Found in the CLIs" })`.
- `mcp-codex-login.spec.js`: after each `page.goto(baseURL + "/accounts…")` add `await openAccountItem(page, "search");` before `area`/`page.getByText(...)` lines that belong to the server. The OAuth result tests (~221, ~245) keep their URL assertions; open "search" after the banner assertions.
- `mcp-value-references.spec.js`: no edit besides `openAdd` (fixture); the "general error line stays empty" count (`dialog.getByRole("alert")` = 1) holds because the bar suppresses a consumed value refusal.
- `mcp-oauth.spec.js`: create flow: `dialog` → `accountDetail(page)`; after "Save server" the page lands on the new server (`item` = `accountDetail(page)`); banner assertions stay on `panel`; for `label === "phone"` call `backToAccounts(page)` before `panel` assertions and `openAccountItem(page, "docs")` before `item` assertions. "Edit docs" (~350) → `openAccountItem`; the `alertdialog` "Switch to OAuth?" lives in `accountDetail(page)`. Origin-blocked test (~266): `item` → `await openAccountItem(page, "docs")`; `item.getByRole("alert")` stays; the list notice is in `panel` (on phones `backToAccounts` first).
- `agent-mcp-servers.spec.js`: ~226 create → `dialog = accountDetail(page)`, `toHaveCount(0)` → `saveBar`; `item = panel.getByRole("listitem")` → `accountDetail(page)` (the created server is open); "Edit docs" → stays on the open server: `await openAccountItem(page, "docs")`; ~359 "Remove more" → `await openAccountItem(page, "more"); await accountDetail(page).getByRole("button", { name: "Remove more" }).click(); await accountDetail(page).getByRole("button", { name: "Remove server" }).click();` then the notice and the absence of "more" on `settings` (hub group; phones: the page already returned to the hub). ~405 focus test: `panel.getByRole("button", { name: "Remove docs" })` → open "docs" first, `removal = accountDetail(page).getByRole("alertdialog")`, the refocus assertion on `accountDetail(page).getByRole("button", { name: "Remove docs" })`; "Add MCP server" stays on `panel` (on phones `backToAccounts` first); `dialog` → `accountDetail(page)`; `warning = accountDetail(page).getByRole("alertdialog")`; `save = accountDetail(page).getByRole("button", { name: "Save server" })`.
- `extensions.spec.js` (~113): `page.getByRole("region", { name: "In den CLIs gefunden" })).toBeVisible()` → `accountRow(page, "In den CLIs gefunden")).toBeVisible()` (deviation 13: the finds are a subpage reached from that row).

Run: `npm run build && npx playwright test tests/browser/agent-mcp-servers.spec.js tests/browser/mcp-oauth.spec.js tests/browser/mcp-cli-bindings.spec.js tests/browser/mcp-cli-notices.spec.js tests/browser/mcp-codex-login.spec.js tests/browser/mcp-value-references.spec.js tests/browser/extensions.spec.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
npx prettier --write web/features/mcp-servers web/features/accounts/account-details.js tests/unit/mcp-server-save.test.js tests/browser/mcp-cli-fixture.js tests/browser/agent-mcp-servers.spec.js tests/browser/mcp-*.spec.js tests/browser/extensions.spec.js
git add -A web/features/mcp-servers web/features/accounts/account-details.js tests/unit/mcp-server-save.test.js tests/browser/mcp-cli-fixture.js tests/browser/agent-mcp-servers.spec.js tests/browser/mcp-*.spec.js tests/browser/extensions.spec.js
git commit -m "feat: manage central MCP servers on accounts subpages" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Old styles and dead code

**Files:**

- Modify: `web/features/accounts/accounts.css` (remove only rules no file uses any more)
- Test: none new; gate commands

**Interfaces:** none.

- [ ] **Step 1: Find unused selectors**

Run: `for c in account-list account-card account-details account-info; do echo "== $c"; grep -rn "$c" web/app web/features web/components | grep -v "\.css:"; done`
Expected: no output under any of the four headings once Tasks 3–8 landed. Keep `.account-actions` (used by `NativeAccountDetail`), `.badge`, `.compact`, `.icon-button`, `.mobile-header`, `.global-error`, `.error`, `.loading` (used elsewhere).

- [ ] **Step 2: Delete the unused rules**

Remove from `web/features/accounts/accounts.css` exactly the rule blocks whose selectors had no JSX use in Step 1 (`.account-list`, `.account-card`, `.account-details` and its children, `.account-info` and its children). Check `web/styles` for `.page-topline` before touching it: `grep -rn "page-topline" web` — it is shared with other pages; leave it.

- [ ] **Step 3: Run lint, structure and build**

Run: `npm run lint && npm run format:check && npm run check:structure && npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add web/features/accounts/accounts.css
git commit -m "chore: drop the card styles of the old accounts page" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Draft regression specs

**Files:**

- Create: `tests/browser/accounts-drafts.spec.js`
- Test: itself

**Interfaces:**

- Consumes: everything above; `providers-fixture.js` controls (`state`, `calls`, `failConnection`, `assistantConnections`, `usage`).

- [ ] **Step 1: Write the spec**

```js
import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { fulfillEnabledAssistantFeature } from "../helpers/assistant-browser-fixture.js";
import {
  accountDetail,
  accountRow,
  backToAccounts,
  openAccountItem,
  saveBar,
} from "../helpers/accounts-browser.js";
import { fixture } from "./providers-fixture.js";

test.use({ locale: "en-GB" });

const router = {
  id: "c1",
  name: "Agent router",
  providerId: "openrouter",
  hasSecret: true,
  launchable: true,
  tools: ["codex"],
};
const other = { ...router, id: "c2", name: "Second router" };

async function setup(page) {
  const controls = await fixture(page);
  controls.state.providerConnections = [router, other];
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  return controls;
}

test("the bar appears only while a subpage has changes", async ({ page }) => {
  await setup(page);
  await page.goto(baseURL + "/accounts");
  const detail = await openAccountItem(page, "Agent router");
  await expect(saveBar(page)).toHaveCount(0);
  await detail.getByLabel("Connection name", { exact: true }).fill("Agent router 2");
  await expect(saveBar(page)).toBeVisible();
  const bar = saveBar(page);
  const save = bar.getByRole("button", { name: "Save connection", exact: true });
  const box = await save.boundingBox();
  expect(Math.round(box.height)).toBe(40);
  await bar.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(saveBar(page)).toHaveCount(0);
  await expect(detail.getByLabel("Connection name", { exact: true })).toHaveValue(
    "Agent router",
  );
});

test("switching entries with changes asks; cancel stays, discard switches", async ({
  page,
}) => {
  await setup(page);
  await page.goto(baseURL + "/accounts");
  const detail = await openAccountItem(page, "Agent router");
  await detail.getByLabel("Connection name", { exact: true }).fill("Changed");
  await accountRow(page, "Second router").click();
  const sheet = page.getByRole("dialog", { name: "Save changes?" });
  await expect(sheet).toContainText("1 change in Agent router is not saved yet.");
  await sheet.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page).toHaveURL(/item=c1/);
  await expect(detail.getByLabel("Connection name", { exact: true })).toHaveValue(
    "Changed",
  );
  await accountRow(page, "Second router").click();
  await page.getByRole("dialog").getByRole("button", { name: "Discard" }).click();
  await expect(page).toHaveURL(/item=c2/);
});

test("save and switch saves first, then opens the other entry", async ({ page }) => {
  const controls = await setup(page);
  await page.goto(baseURL + "/accounts");
  const detail = await openAccountItem(page, "Agent router");
  await detail.getByLabel("Connection name", { exact: true }).fill("Renamed");
  await accountRow(page, "Second router").click();
  await page.getByRole("button", { name: "Save and switch" }).click();
  await expect(page).toHaveURL(/item=c2/);
  expect(controls.calls.filter((call) => call.method === "PATCH").at(-1).body).toEqual({
    name: "Renamed",
  });
});

test("a failed save keeps the changes and reports in the bar", async ({ page }) => {
  const controls = await setup(page);
  await page.goto(baseURL + "/accounts");
  const detail = await openAccountItem(page, "Agent router");
  await detail.getByLabel("Connection name", { exact: true }).fill("Failing");
  controls.failConnection = true;
  await saveBar(page).getByRole("button", { name: "Save connection" }).click();
  await expect(saveBar(page).getByRole("alert")).toContainText(
    "Fixture connection conflict",
  );
  await expect(detail.getByLabel("Connection name", { exact: true })).toHaveValue(
    "Failing",
  );
});

test("phones ask before Back leaves a changed subpage", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await page.goto(baseURL + "/accounts?section=models&item=c1");
  await expect(
    page.getByRole("heading", { name: "Agent router", level: 1 }),
  ).toBeVisible();
  await expect(page.getByText("Accounts · Model access")).toBeVisible();
  await accountDetail(page)
    .getByLabel("Connection name", { exact: true })
    .fill("Changed");
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByRole("dialog", { name: "Save changes?" })).toBeVisible();
  await page.getByRole("button", { name: "Discard" }).click();
  await expect(page).toHaveURL(`${baseURL}/accounts?section=models`);
  await expect(accountRow(page, "Agent router")).toBeVisible();
});

test("leaving the page with changes is held by beforeunload", async ({ page }) => {
  await setup(page);
  await page.goto(baseURL + "/accounts?section=models&item=c1");
  await accountDetail(page)
    .getByLabel("Connection name", { exact: true })
    .fill("Changed");
  let asked = false;
  page.on("dialog", async (dialog) => {
    asked = dialog.type() === "beforeunload";
    await dialog.dismiss();
  });
  await page.close({ runBeforeUnload: true });
  await expect.poll(() => asked).toBe(true);
});

test("creating lands on the new entry without a prompt", async ({ page }) => {
  const controls = await setup(page);
  await page.goto(baseURL + "/accounts");
  await page
    .getByRole("button", { name: "Add provider connection", exact: true })
    .click();
  await expect(page).toHaveURL(/section=models&item=new/);
  const detail = accountDetail(page);
  await detail.getByLabel("Connection name", { exact: true }).fill("Fresh");
  await detail.getByLabel("API key", { exact: true }).fill("fixture-key");
  await saveBar(page).getByRole("button", { name: "Save connection" }).click();
  await expect(page).toHaveURL(/section=models&item=connection-one/);
  await expect(page.getByRole("dialog", { name: "Save changes?" })).toHaveCount(0);
  await page.goBack();
  await expect(page).not.toHaveURL(/item=new/);
  expect(controls.calls.filter((call) => call.method === "POST").length).toBe(1);
});

test("a restart note names how many agents restart", async ({ page }) => {
  const controls = await setup(page);
  controls.usage = {
    agentsEnabled: true,
    connections: {
      c1: {
        agents: [
          { id: "a", name: "Olli", kind: "agent", via: "model" },
          { id: "b", name: "Tmp", kind: "teamMember", via: "model" },
        ],
        sessions: 0,
        pipelineProfiles: [],
        clis: [],
      },
    },
    chatgpt: {},
    mcpServers: {},
    webSearch: null,
    speech: null,
    cliAccounts: {},
  };
  await page.route("**/api/assistant-feature", (route) =>
    fulfillEnabledAssistantFeature(route),
  );
  await page.goto(baseURL + "/accounts");
  const detail = await openAccountItem(page, "Agent router");
  await expect(detail.getByRole("link", { name: /^Olli/ })).toHaveAttribute(
    "href",
    "/agents/a/settings",
  );
  await expect(detail.getByText("Temporary team member")).toBeVisible();
  await detail.getByLabel("Connection name", { exact: true }).fill("Changed");
  await expect(saveBar(page)).toContainText("Briefly restarts 2 agents.");
});

test("a speech change made elsewhere offers reload and overwrite", async ({ page }) => {
  const controls = await setup(page);
  let revision = 0;
  const puts = [];
  await page.route("**/api/assistant-feature", (route) =>
    fulfillEnabledAssistantFeature(route),
  );
  await page.route("**/api/assistant-speech", async (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({
        json: { revision, model: "nova-3", language: "auto", hasSecret: false },
      });
    const body = route.request().postDataJSON();
    puts.push(body);
    if (body.revision !== revision)
      return route.fulfill({
        status: 409,
        json: { error: "Changed elsewhere", messageKey: "assistants.conflict" },
      });
    revision += 1;
    return route.fulfill({
      json: { revision, model: body.model, language: body.language, hasSecret: false },
    });
  });
  expect(controls.state).toBeTruthy();
  await page.goto(baseURL + "/accounts");
  const detail = await openAccountItem(page, "Speech recognition");
  await detail.getByLabel("Recognition model").fill("nova-4");
  // Someone else saves meanwhile: the server is at revision 7 now.
  revision = 7;
  await saveBar(page).getByRole("button", { name: "Save speech settings" }).click();
  await expect(saveBar(page).getByRole("alert")).toContainText("Changed elsewhere");
  expect(puts[0].revision).toBe(0);
  // The conflict re-read the settings, so overwriting sends the newer revision.
  await saveBar(page).getByRole("button", { name: "Overwrite anyway" }).click();
  await expect.poll(() => puts.at(-1)?.revision).toBe(7);
  await expect(saveBar(page)).toHaveCount(0);
  expect(puts.at(-1).model).toBe("nova-4");
});

test("the agents-off detail lists only CLIs in Used by", async ({ page }) => {
  const controls = await setup(page);
  controls.usage = {
    agentsEnabled: false,
    connections: {
      c1: {
        agents: [{ id: "a", name: "Olli", kind: "agent", via: "model" }],
        sessions: 2,
        pipelineProfiles: [],
        clis: [],
      },
    },
    chatgpt: {},
    mcpServers: {},
    webSearch: null,
    speech: null,
    cliAccounts: {},
  };
  await page.goto(baseURL + "/accounts");
  const detail = await openAccountItem(page, "Agent router");
  await expect(detail.getByText("2 sessions")).toBeVisible();
  await expect(detail.getByRole("link", { name: /^Olli/ })).toHaveCount(0);
  await expect(detail.getByRole("group", { name: "Compatible CLIs" })).toContainText(
    "Codex",
  );
  await backToAccounts(page);
});
```

How the conflict test works: the draft froze base revision 0 at the first edit; the save sends 0 and gets 409 `assistants.conflict`; `SpeechSettings` re-reads the settings on a conflict outcome (`data.reloadSpeech()`, Task 7 Step 2), so the latest revision becomes 7 and "Overwrite anyway" (`draft.overwrite` → `followRevisions`) sends 7. The edited model survives because the re-read model ("nova-3") equals the base.

- [ ] **Step 2: Run the spec**

Run: `npm run build && npx playwright test tests/browser/accounts-drafts.spec.js`
Expected: PASS (10 tests). A failure here is a product bug in Tasks 3–8 (fix the component, not the assertion).

- [ ] **Step 3: Repeat in WebKit**

Run: `AGENTPIER_TEST_BROWSER=webkit npx playwright test tests/browser/accounts-drafts.spec.js tests/browser/accounts-hub.spec.js tests/browser/assistant-accounts.spec.js` (install with `npx playwright install webkit` if missing)
Expected: PASS (the `assistant*` spec also runs in the tablet project).

- [ ] **Step 4: Commit**

```bash
npx prettier --write tests/browser/accounts-drafts.spec.js
git add tests/browser/accounts-drafts.spec.js
git commit -m "test: pin accounts drafts, prompts, creation and conflicts" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Coverage check, full gate and screenshots

**Files:**

- Create (git-ignored): `.superpowers/screenshots/playwright.accounts.config.js`, `.superpowers/screenshots/accounts-screenshots.spec.js`; output `.superpowers/screenshots/accounts/*.png`

**Interfaces:** none.

- [ ] **Step 1: Walk the coverage checklist**

Open the app (`npm run build && npm start`, disposable data dir per `docs/installation.md`) or use the specs; tick every row. Each row names today's action and its new place. A row without a place is a bug: add it to the owning detail before continuing.

| #   | Today (component)                                                                                                                                     | New place                                                                                |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 1   | "Lokal gespeichert" + shield (AccountsPage topline)                                                                                                   | header subtitle (phone) / header actions (desktop)                                       |
| 2   | Info box "Alles bleibt auf deinem Rechner." (AccountsPage)                                                                                            | ⓘ in the header, disclosure with heading + text                                          |
| 3   | "Account hinzufügen" (page header)                                                                                                                    | "+" on "Native CLI-Accounts" → `cli/new`                                                 |
| 4   | Provider list: title + description "Save one API key per provider connection …", name, provider · host · key state                                    | group "Modell-Zugänge" (description behind ⓘ), hub row label + sub (`connectionSummary`) |
| 5   | "Kompatible CLIs" with routes (card)                                                                                                                  | connection subpage group "Kompatible CLIs"                                               |
| 6   | "Provider-Zugang hinzufügen"                                                                                                                          | "+" on "Modell-Zugänge" → `models/new`                                                   |
| 7   | Edit connection (dialog)                                                                                                                              | row → connection subpage                                                                 |
| 8   | Name, provider (locked on edit), providers loading/error                                                                                              | subpage fields + status/error lines                                                      |
| 9   | API key, placeholder variants, remove key                                                                                                             | `KeyField` ("Ersetzen"), "Gespeicherten API-Key entfernen" checkbox                      |
| 10  | Key re-entry alert, invalid models, providers not loaded → save disabled                                                                              | alert + `saveDisabled`                                                                   |
| 11  | Endpoint: preset, OpenAI URL, advanced Anthropic URL/auth header                                                                                      | group "Verbindung" (`EndpointFields`)                                                    |
| 12  | Probe model, test, cost, error, protocols + statuses + reasons, listing notes, warnings                                                               | group "Test" (`EndpointTestResult`)                                                      |
| 13  | Routing per CLI, adapter options (capabilities, reset, think tag), model table                                                                        | `EndpointRouting`, `EndpointAdapterOptions`, `EndpointModelTable`                        |
| 14  | `responsesAccess` checkbox + help; key help                                                                                                           | checkbox row with sub; key help behind ⓘ                                                 |
| 15  | Save restart confirmation ("Speichern und neu starten")                                                                                               | chain confirmation above the bar + bar note "Startet n Agenten kurz neu."                |
| 16  | Delete connection, key-dependent text, restart + affected agents                                                                                      | "Zugang löschen" → `Sheet` with the same two steps                                       |
| 17  | ChatGPT accounts with status                                                                                                                          | hub rows "ChatGPT …" (sub status)                                                        |
| 18  | Check connection + result; disconnect                                                                                                                 | ChatGPT account subpage                                                                  |
| 19  | Offline note + "Agentendienst-Einstellungen" link                                                                                                     | both ChatGPT subpages                                                                    |
| 20  | Connect: device code, open link, cancel, polling, sessionStorage resume, errors                                                                       | row "ChatGPT für Agenten" → login subpage                                                |
| 21  | Speech: status, key, model, language, save, remove key, error                                                                                         | speech subpage (bar + immediate remove)                                                  |
| 22  | Web search: status, provider radios, Perplexity connection / none note, Brave key status + input, restart confirmation, save, remove Brave key, error | web search subpage (bar + inline restart + immediate remove)                             |
| 23  | MCP: title, description, restart note                                                                                                                 | MCP group label (description behind ⓘ) + visible restart note                            |
| 24  | OAuth result banner + dismiss; origin-blocked notice; list notices; error; empty                                                                      | MCP group                                                                                |
| 25  | Server badges (transport, stdio, OAuth status), details list, users text                                                                              | hub row (transport + stdio pill) and server subpage (`McpServerInfo`)                    |
| 26  | Per-CLI status, overwrite/adopt, adopt taken name, stdio confirmation                                                                                 | server subpage (`McpCliStatus`)                                                          |
| 27  | Codex account logins (login, cancel, link fallback)                                                                                                   | server subpage (`McpCodexAccounts`)                                                      |
| 28  | Agent OAuth login/logout, errors, expiry/unknown hints                                                                                                | server subpage (agents only)                                                             |
| 29  | Edit server (side panel): every field, OAuth switch / stdio / CLI stdio confirmations, value-reference errors, CLI choices, secret notes              | server subpage form + inline confirmations                                               |
| 30  | Remove server with focus-managed confirmation                                                                                                         | "Entfernen" (aria "X entfernen") → inline `McpRemoveConfirmation`                        |
| 31  | Add server                                                                                                                                            | "+" on "MCP-Server" → `mcp-servers/new`                                                  |
| 32  | CLI finds: adopt, rename, adopt all, problems, notice, loading, none                                                                                  | row "In den CLIs gefunden ›" → finds subpage                                             |
| 33  | `mcpSection` focus from Extensions                                                                                                                    | `?section=mcp-servers` scrolls the MCP group into view                                   |
| 34  | Native account card: name, tool, description, local hidden until signed in                                                                            | hub row (sub, "Lokal"), hidden rule kept                                                 |
| 35  | Legacy note + `ProviderAccountSummary`                                                                                                                | CLI account subpage                                                                      |
| 36  | Signed in badge / "Anmelden" (confirm modal, disabled without CLI)                                                                                    | CLI account subpage group "Anmeldung und Standard"                                       |
| 37  | Default badge / "Als Standard verwenden" + error                                                                                                      | same group (immediate)                                                                   |
| 38  | Edit account: name, legacy provider fields, key, remove key, key-change note, help, form note                                                         | CLI account subpage form + bar                                                           |
| 39  | Create account: name, tool (uninstalled suffix), key                                                                                                  | `cli/new` subpage + bar "Account erstellen"                                              |
| 40  | Delete account with keychain note                                                                                                                     | "Account löschen" → AppDialogs confirm (unchanged)                                       |
| 41  | "Used by" (new)                                                                                                                                       | every subpage, agents link to their settings tab                                         |

- [ ] **Step 2: Run the full gate**

Run: `npm run check`
Expected: PASS (lint, format, structure ≤ 600 lines, build, all node suites).

Run: `npx playwright test tests/browser/accounts-hub.spec.js tests/browser/accounts-drafts.spec.js tests/browser/provider-connections.spec.js tests/browser/provider-connection-restart.spec.js tests/browser/endpoint-connections.spec.js tests/browser/endpoint-model-editing.spec.js tests/browser/endpoint-adapter-options.spec.js tests/browser/endpoint-routing.spec.js tests/browser/endpoint-route-labels.spec.js tests/browser/providers.spec.js tests/browser/i18n-plugins-providers.spec.js tests/browser/account-defaults.spec.js tests/browser/ui.spec.js tests/browser/nono-sandbox.spec.js tests/browser/assistant-accounts.spec.js tests/browser/assistant-channels.spec.js tests/browser/assistant-web-tools.spec.js tests/browser/assistant-settings.spec.js tests/browser/assistant-feature.spec.js tests/browser/agent-mcp-servers.spec.js tests/browser/mcp-oauth.spec.js tests/browser/mcp-cli-bindings.spec.js tests/browser/mcp-cli-notices.spec.js tests/browser/mcp-codex-login.spec.js tests/browser/mcp-value-references.spec.js tests/browser/extensions.spec.js tests/browser/navigation.spec.js tests/browser/file-explorer-editor-navigation.spec.js tests/browser/settings-pattern-draft.spec.js`
Expected: PASS.

Run the complete browser suite once: `npm run test:e2e`
Expected: PASS.

- [ ] **Step 3: Write the screenshot script**

Create `.superpowers/screenshots/playwright.accounts.config.js`:

```js
import path from "node:path";
import { fileURLToPath } from "node:url";
import base from "../../playwright.config.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");

export default {
  ...base,
  testDir: here,
  testMatch: "accounts-screenshots.spec.js",
  globalSetup: path.join(root, "tests/helpers/browser-login-setup.js"),
  webServer: { ...base.webServer, cwd: root },
  projects: [{ name: "screenshots" }],
};
```

Create `.superpowers/screenshots/accounts-screenshots.spec.js`:

```js
import { test } from "@playwright/test";
import { baseURL } from "../../tests/helpers/browser.js";
import { fulfillEnabledAssistantFeature } from "../../tests/helpers/assistant-browser-fixture.js";
import { fixture } from "../../tests/browser/providers-fixture.js";

const out = new URL("./accounts/", import.meta.url).pathname;
const views = [
  ["mobile", { width: 390, height: 844 }],
  ["desktop", { width: 1280, height: 800 }],
];
const pages = [
  ["hub", "/accounts"],
  ["connection", "/accounts?section=models&item=c1"],
  ["connection-new", "/accounts?section=models&item=new"],
  ["chatgpt-login", "/accounts?section=models&item=chatgpt"],
  ["speech", "/accounts?section=services&item=speech"],
  ["web-search", "/accounts?section=services&item=web-search"],
  ["mcp-server", "/accounts?section=mcp-servers&item=s1"],
  ["mcp-finds", "/accounts?section=mcp-servers&item=cli-finds"],
  ["cli-account", "/accounts?section=cli&item=managed-claude"],
];
const used = (agents, sessions = 0) => ({
  agents,
  sessions,
  pipelineProfiles: [],
  clis: [],
});
const home = { id: "home", name: "Home", kind: "agent", via: "model" };

for (const language of ["en", "de"])
  for (const [view, viewport] of views)
    test(`accounts ${language} ${view}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      const controls = await fixture(page);
      controls.state.providerConnections = [
        {
          id: "c1",
          name: "OpenRouter shared",
          providerId: "openrouter",
          hasSecret: true,
          launchable: true,
          tools: ["codex", "claude", "opencode"],
        },
      ];
      controls.state.accounts = [
        { id: "managed-claude", name: "Work Claude", tool: "claude", kind: "managed" },
      ];
      controls.usage = {
        agentsEnabled: true,
        connections: { c1: used([home], 2) },
        chatgpt: {},
        mcpServers: { s1: used([{ ...home, via: "binding" }]) },
        webSearch: used([{ ...home, via: "capability" }]),
        speech: used([]),
        cliAccounts: { "managed-claude": used([], 3) },
      };
      await page.addInitScript(
        (value) => localStorage.setItem("agentpier-language", value),
        language,
      );
      await page.route("**/api/assistant-feature", (route) =>
        fulfillEnabledAssistantFeature(route),
      );
      await page.route("**/api/mcp-servers", (route) =>
        route.request().method() === "GET"
          ? route.fulfill({
              json: [
                {
                  id: "s1",
                  name: "docs",
                  transport: "http",
                  url: "https://docs.example/mcp",
                  auth: "headers",
                  headerNames: ["Authorization"],
                  envNames: [],
                  clis: ["claude"],
                  cliStatus: { claude: { status: "written" } },
                  revision: 1,
                },
              ],
            })
          : route.fallback(),
      );
      for (const [name, path] of pages) {
        await page.goto(baseURL + path);
        await page.locator(".accounts-page").waitFor();
        await page.waitForLoadState("networkidle");
        await page.screenshot({
          path: `${out}${language}-${view}-${name}.png`,
          fullPage: true,
        });
      }
    });
```

- [ ] **Step 4: Take the screenshots**

Run: `npm run build && npx playwright test --config .superpowers/screenshots/playwright.accounts.config.js`
Expected: PASS, 36 files in `/Users/d.kaulig/Projects/agent-pier/.worktrees/settings-accounts/.superpowers/screenshots/accounts/` (`{en,de}-{mobile,desktop}-{hub,connection,connection-new,chatgpt-login,speech,web-search,mcp-server,mcp-finds,cli-account}.png`). Open three of them (EN mobile hub, DE desktop connection, EN mobile web-search) with the Read tool and check: no horizontal overflow, bar not covering fields, ⓘ 20px round, "—" never shown as 0. `git status --short` shows nothing under `.superpowers/` (ignored).

- [ ] **Step 5: Final commit (only if Step 1 or 2 required fixes)**

```bash
git add -A web tests
git commit -m "fix: close the gaps found in the accounts coverage walk" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Self-Review

| Spec item (Step 2)                                                                                                                                                                                                                                                      | Task           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| Hub on mobile (sidebar icon, "Lokal gespeichert", ⓘ info box, intro); list 320 + detail pane on desktop                                                                                                                                                                 | 3              |
| Groups with "+": Modell-Zugänge, Dienste für Agenten (agents only), MCP-Server, Native CLI-Accounts; rows sub = provider · state, right = usage                                                                                                                         | 3              |
| Every subpage: fields, "Genutzt von" (agents → their settings tab; provider adds "Kompatible CLIs"), destructive button at the bottom, bar with restart note, restart confirmation as chain step                                                                        | 3 (frame), 4–8 |
| Provider connection create/edit subpage, all endpoint groups, key status + "Ersetzen", remove key, `responsesAccess`, key help ⓘ, delete with key-dependent text and restart flow; modules keep paths                                                                   | 4              |
| ChatGPT detail (status, check, disconnect, offline note); device-code login subpage (code, link, cancel, polling, resume)                                                                                                                                               | 6              |
| Speech and web search with remove key, Perplexity select, Brave key, restart confirmation                                                                                                                                                                               | 7              |
| MCP create/edit subpage (SidePanel removed), confirmations, value-reference errors, CLI choices, details, per-CLI status, Codex OAuth, agent OAuth, remove; group restart note, banner, origin-blocked, pending notices, finds row → import subpage; `mcpSection` focus | 3, 8           |
| Native CLI account create/edit subpage, local read-only, login (confirm, disabled without CLI), default, delete with keychain note, legacy summary, auth polling, server 409 in the bar                                                                                 | 5              |
| Drafts everywhere, base revision + conflict, "—" until known, agents-off rules                                                                                                                                                                                          | 3, 7, 8, 10    |
| Regression specs: dirty bar, unsaved sheet (switch, back, beforeunload), conflict, deep links, ⓘ; partial failure n/a (deviation 13)                                                                                                                                    | 3, 10          |
| EN + DE, phone + desktop screenshots; files ≤ 600 lines; gate                                                                                                                                                                                                           | 1, 11          |

Placeholder scan: every code step carries code; the spec-migration steps give a rule table plus per-file edits with the exact old and new locators. Type consistency: `DetailProps`, `useAccountDraft` (`form.draft/sheet/save/overwrite`), `AccountSaveBar` props, `useAccountsData` fields (incl. `reloadSpeech`/`reloadWebSearch`), step ids (`connection`, `account`, `speech`, `web-search`, `mcp-server`) and helper names (`accountRow`, `accountDetail`, `saveBar`, `openAccountItem`, `backToAccounts`, `keyInput`) are used with the same names in every task.

## Deviations from the spec and the design (with reasons)

1. **Page title stays "Deine Accounts" / "Your accounts"** (drawing: "Accounts"). `navigation.spec.js` and `file-explorer-editor-navigation.spec.js` assert this heading; the task forbids changing assertions.
2. **ChatGPT is connected from a row "ChatGPT für Agenten ›"** in Modell-Zugänge, not from the group's "+". `GroupLabel` has one action; the "+" stays "Provider-Zugang hinzufügen", whose exact name existing specs click.
3. **Save-chain confirmations render inline above the bar** (restart for connections and web search, stdio, CLI stdio, OAuth switch) with the existing `role="alertdialog"` components instead of a `Sheet`. Their focus trapping/return and the `alertdialog` role are pinned by `agent-mcp-servers.spec.js`, `mcp-oauth.spec.js` and `assistant-web-tools.spec.js`. The connection delete uses a `Sheet` (it was a modal before).
4. **Removing a stored speech or Brave key stays an immediate action** (as today, a separate button that sends the saved values). The connection's "remove saved key" stays a draft checkbox, as it was part of the dialog form.
5. **Provider connections and native CLI accounts have no server revision**, so their subpages cannot show "changed elsewhere"; last write wins as today. Speech, web search and MCP servers send the draft's base revision.
6. **Setting the default CLI account stays immediate** (it writes `/preferences`, a different resource than the account).
7. **`SaveBar` gains `saveDisabled` and `saveFocusKey`** (Step 0 component, backwards compatible) to keep today's disabled-save rules (key re-entry, invalid models, providers not loaded, legacy provider not ready, key change required), which specs assert with `toBeDisabled()`, and today's focus return to the save button after an inline confirmation is cancelled (`data-focus-key="mcp-form-save"`).
8. **The MCP and web search descriptions move behind ⓘ** (consistent with `webSearch.description` in the README list); the speech description stays visible (it states that audio leaves the machine).
9. **"Compatible CLIs" is a list of rows**, so two assertions in `endpoint-route-labels.spec.js` that matched one joined text line are reformulated to the same facts per row.
10. **After saving an edit the subpage stays open** (pattern); spec checks "the dialog closed" become "the save bar is gone".
11. **The finds subpage has no extra frame heading**, because `McpCliFinds` already is a region named "In den CLIs gefunden"; a second one would break `getByRole` strictness.
12. **`?section=mcp-servers` shows the hub with the MCP group in view**; the finds are a subpage. `extensions.spec.js` now checks for the finds row instead of the finds region.
13. **Multi-step save with partial failure does not apply to Accounts**: every Accounts subpage saves with one request (provider, CLI account, speech, web search, MCP definition + CLIs). The partial-failure path stays covered by Step 0's harness spec; Task 10 covers failure, conflict and confirmation steps instead.
14. **An unchanged subpage cannot be saved** (the bar only appears while dirty, Step 0 pattern). Three spec steps that saved an untouched dialog become "no bar, no request": the end of `provider-connections.spec.js` test 1, the first round of `providers.spec.js` "provider account retains a blank key …", and the `toBeEnabled()` check on the untouched form in `endpoint-connections.spec.js` (key re-entry test).

## Risks

- **Step 0 must be complete before this branch starts, Task 13 included.** At review time Step 0 Tasks 1–12 had landed (components, hooks and class names `settings-shell-leading`, `list-row-main`, `.list-row-pill`, `unknownValue`, `Sheet`, `SaveBar` were checked against the code and match this plan); Task 13 (`GET /api/accounts/usage`, `server/features/accounts/account-usage.js`) was still in progress. The browser specs here mock the endpoint through `providers-fixture.js`, but `npm run check` and every spec that reaches the isolated test server need the real route; do not branch before the ledger shows `Task 13: complete` and Task 14 (guide) is done.
- **Parallel page branches touching `SaveBar.jsx`** (agent settings may need a similar prop): merge conflict at integration; resolve by keeping one `saveDisabled` prop.
- **Focus return after cancelling the MCP stdio warning**: the confirmations keep `returnKey="mcp-form-save"` and the bar's primary carries `data-focus-key="mcp-form-save"` (`saveFocusKey`, Task 3), so focus returns even where the click did not focus the button (WebKit). It still needs the primary re-enabled before the next animation frame (the chain resolves "cancelled" before React re-renders); if `toBeFocused()` flakes, wait for `draft.saving` to clear before refocusing rather than changing the spec.
- **Spec migration volume** (~25 files) and WebKit/tablet repeats of `assistant*.spec.js`; the phone variants in `mcp-oauth.spec.js` and `agent-mcp-servers.spec.js` need explicit hub/detail switching.
- **Fixtures that throw on unknown paths**: only `providers-fixture.js` serves `/api/accounts/usage`; other fixtures fall through to the isolated test server (which has the endpoint) or answer `{}` (treated as unknown).
- **`state.providerConnections` missing in some fixtures** keeps `section=models&item=<id>` deep links in "loading"; only affects specs that deep-link a connection without providing the list.
- **`useAssistantFeature` loading**: agent kinds show "loading" for a moment on deep links; specs wait on visible elements, not on timing.
- **CSS scope**: `.visually-hidden` and `.list-card:empty` are global rules added from `accounts-page.css`; if Step 0 defines a different visually-hidden class, reuse it.
