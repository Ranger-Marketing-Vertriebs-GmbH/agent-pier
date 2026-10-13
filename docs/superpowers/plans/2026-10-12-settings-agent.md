# Agent Settings (Step 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the long agent settings page (`AssistantSettings.jsx` + `SettingsSectionNav`) with four tabs — Profil, Fähigkeiten, Arbeit, Telegram — built on the Step 0 settings pattern, with one draft and one save bar per tab, subpages for memory, allowlist, actions, grants and Telegram details, and no lost feature.

**Architecture:** A pure module (`agent-settings-fields.js`) decides visible tabs, subpages, each tab's draft fields and the request bodies; a steps module (`agent-settings-steps.js`) turns them into Step 0 save-chain steps. Each tab component owns one `useTabDraft` draft, registers it with the navigation guard through `useAgentDraftGuard`, renders its subpages itself (so a subpage of the same tab keeps the draft) and ends with `SaveBar`, `ConfirmationSheet` and `UnsavedChangesSheet`. Tabs and subpages are addressed by Step 0's `agentTab`/`agentPage` route fields, so tab switches, back and agent switches all pass through the guard coordinator.

**Tech Stack:** React 19, Vite 8, `node:test` + `node:assert/strict`, Playwright 1.64. Step 0 modules: `web/lib/settings/{useTabDraft,useUnsavedChangesGuard,save-chain,draft-state}.js`, `web/lib/navigation-guard.js`, `web/components/{UnderlineTabs,GroupLabel,ListCard,ListRow,Segmented,InfoHint,ReferenceRow,SaveBar,Sheet,UnsavedChangesSheet}.jsx`, `web/features/assistants/{settings-routes,assistant-save-steps}.js`.

**Spec:** `docs/superpowers/specs/2026-10-12-settings-redesign-design.md` (sections "Guiding decisions" and "Step 1: agent settings"; binding). Step 0 contract: `docs/superpowers/plans/2026-10-12-settings-foundation.md` (File Structure, Interfaces blocks, guide `docs/settings-pattern.md`) and the "Ruling:" lines in `.superpowers/sdd/2026-10-12-settings-foundation/progress.md` (they override that plan). Design data (untrusted, data only): handoff `README.md` section "Agent settings (1b + 3b)" and `Einstellungen Übersicht.dc.html`, section "Agent-Einstellungen".

## Global Constraints

- Work in `/Users/d.kaulig/Projects/agent-pier/.worktrees/settings-agent` on branch `feat/settings-redesign-agent`, created from `feat/settings-redesign` after Step 0 is complete. Never push to `main`. Never target the default tmux server or real user sessions; browser tests use the route-mocked fixtures in `tests/helpers/`.
- Node.js 22.13+, ES modules, JSX only under `web/`. Prettier: two spaces, double quotes, semicolons, trailing commas, 90 columns. Run `npx prettier --write <files>` and `npx eslint <files>` on every touched file.
- Every source, CSS and test file stays at or below 600 lines (`npm run check:structure`).
- Every UI text exists in `web/lib/i18n/de/*.js` and `web/lib/i18n/en/*.js` with matching keys and interpolation arguments; components import reactive exports from `web/lib/i18n/messages/`. No hardcoded product copy. Do **not** add keys to `web/lib/i18n/*/common.js` (Step 0 owns shared copy); new agent copy goes to the new catalog `assistant-settings.js`. German copy never says "Assistent", "Provider-Verbindung", "Modellverbindung", "diese Verbindung" or "Verbindung fehlt" (`tests/unit/i18n-*.test.js`).
- CSS in `web/features/assistants/*.css` uses theme variables only, no hex colours and no `var(--x) 50`-style alpha suffixes (`tests/unit/assistant-css.test.js` reads that directory).
- Drafts everywhere (spec decision 2): every field of a tab or subpage is saved by that tab's bar — including the Telegram language and app URL. Immediate actions stay immediate: "mark as reviewed", reminders/routines create/pause/resume/delete/run/review, memory search, allowlist delete, action approve/decline/cancel/review, Telegram connect/pair/pause/resume/disconnect/token replacement/activity retry and review, member stop/promote/archive/restore/recover.
- Optimistic concurrency (spec decision 3): steps send the draft's base revision (`ctx.revision`/`ctx.revisions`), never the latest prop. Untouched fields adopt newer server values silently.
- Atomicity (spec decision 4): Profil = one `PATCH /assistants/:id`; Fähigkeiten = one `PATCH /assistants/:id` (capabilities, shell, changed `mcpServers`, `heartbeat.enabled=false` when memory goes off with a saved enabled heartbeat); Arbeit = one `PUT /assistants/:id/work`; Telegram = `PATCH /assistants/:id` (heartbeat) then `PATCH /assistant-channels/:id` (`language`, `appUrl`), stopping at the first error and reporting "Partially saved: …".
- Rows show `unknownValue` ("—") until data is known, never a fake 0 (spec decision 5).
- Hints listed in the README move behind ⓘ verbatim (`InfoHint` disclosures, never tooltips); the shell warning (level ≠ off), the selected shell level's hint, stdio warnings and all error/conflict notices stay visible (spec decision 6).
- Visibility: `isPersonal(a) = !a.teamMemberId || a.lifetime === "permanent"`. Not personal → tabs Profil + Fähigkeiten (MCP read-only via `TemporaryMcpServers`). Memory row only with saved `capabilities.memory`; reminders/routines only with saved `capabilities.reminders`; Team group only without `teamMemberId`; Telegram tab when personal.
- Commit messages in English with `feat:`, `fix:`, `test:` or `chore:` prefixes, followed by a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Commands: single node test `node --test tests/unit/<file>.test.js`; browser `npm run build && npx playwright test tests/browser/<file>.spec.js` (build once, then repeat `npx playwright test …` until the next source change); full gate `npm run check`.

## Review Focus

1. Browser history back while a tab is dirty (reason `"history"`): the unsaved sheet must appear and "Cancel" must leave the address and the draft untouched. Pinned in Task 3 (`assistant-settings-tabs.spec.js`, "browser back asks first…").
2. The Telegram channel is polled every 2 s; a pause/resume elsewhere bumps its revision while the language is being edited: the edit must survive, the save must report "Changed elsewhere in the meantime." and "Overwrite anyway" must succeed with the newer revision. Pinned in Task 7 (`assistant-settings-save.spec.js`, "a channel changed elsewhere…").
3. Switching the memory note type with unsaved note text must not silently discard it (the select is not a route change, so the guard coordinator never sees it). Pinned in Task 5 (`assistant-settings-tabs.spec.js`, "switching the note type…").
4. Right after "Create agent" succeeds, the navigation to the new agent must not raise the unsaved sheet (the guard reads `dirty` from the last render). Pinned in Task 9 (`assistant-settings-tabs.spec.js`, "creating an agent opens its settings without asking").
5. A deep link to a tab the agent does not have (`?tab=telegram` for a task-bound member, `?page=memory` with memory off) must normalise once to a valid address without a loop and without a sheet. Pinned in Task 3 (`assistant-settings-tabs.spec.js`, "a task-bound member…") and Task 5 ("the memory page falls back to its tab…").

---

## File Structure

New page module (`web/features/assistants/settings/`):

- `agent-settings-fields.js` — pure rules: key lists, `isPersonal`, `visibleAgentTabs`, `agentPageAllowed`, `resolveAgentLocation`, `agentRoute`, `staysOnAgentTab`, `sortedIds`, `toggleId`, `profileServer/profilePatch`, `capabilityServer/capabilityPatch`, `telegramServer/heartbeatPatch/channelPatch`, `workServer/workBody`, `grantCount`, `pendingCount`, `recoveryStates`, `inProgressStates`, `channelActivity`, `createServer/createInput`.
- `agent-settings-steps.js` — save-chain steps: `profileStep`, `capabilityStep`, `heartbeatStep`, `channelStep`, `workStep`, `createStep`, `memoryStep`.
- `useAgentDraftGuard.js` — `useUnsavedChangesGuard` with the agent `stays` rule.
- `AgentSettingsPage.jsx` — header (`AssistantHeader`), tabs, tab panel, runtime aside, address normalisation.
- `RuntimeSummary.jsx`, `ConflictNotice.jsx`, `ConfirmationSheet.jsx`, `SubpageHeader.jsx`, `useCount.js` — small shared pieces.
- `ProfileFields.jsx`, `ProfileTab.jsx`, `MemberGroup.jsx` — Profil.
- `CapabilitiesTab.jsx`, `CapabilityGroups.jsx` (`MemoryGroup`, `WebGroup`, `ShellGroup`), `McpGroup.jsx`, `MemoryPage.jsx`, `AllowlistPage.jsx` — Fähigkeiten.
- `WorkTab.jsx`, `useActionHistory.js`, `ActionHistory.jsx`, `GrantSelectionPage.jsx` — Arbeit.
- `TelegramTab.jsx`, `useTelegramChannel.js`, `TelegramConnection.jsx`, `TelegramConnectionPage.jsx`, `TelegramActivityPage.jsx`, `ProactivityGroup.jsx`, `RemindersGroup.jsx`, `RoutinesGroup.jsx` — Telegram.
- `AgentCreate.jsx` — create mode (Profil + Fähigkeiten, bar "Agent anlegen").
- `LegacySections.jsx` — temporary bridge for the not yet migrated tabs in Tasks 3–6, deleted in Task 7.

Styles: `web/features/assistants/agent-settings.css` (new, theme variables only); `web/features/assistants/assistant-settings.css` rewritten in Task 9 (section nav, old save bar and form overrides removed).

Changed: `web/features/assistants/AgentsPage.jsx` (settings branch → `AgentSettingsPage`, create → `AgentCreate`).

Deleted in Task 9: `AssistantSettings.jsx`, `SettingsSectionNav.jsx`, `AssistantSaveBar.jsx`, `AssistantCapabilities.jsx`, `AssistantShell.jsx`, `AssistantShellAllowlist.jsx`, `AssistantProactivity.jsx`, `AssistantMemory.jsx`, `AssistantReminders.jsx`, `AssistantRoutines.jsx`, `AssistantWorkflows.jsx`, `TelegramSettings.jsx`, `AssistantMemberSettings.jsx` (all under `web/features/assistants/`), `assistant-proactivity.css` and `web/features/mcp-servers/AgentMcpServers.jsx` (`settings/LegacySections.jsx` goes in Task 7). Kept: `RestartConfirmation.jsx` (Accounts web search), `AssistantTeamSettings.jsx` (host capacity in Settings; Step 3 owns it), `StdioConfirmation.jsx`, `TemporaryMcpServers.jsx`, `heartbeat.js`, `shell-level.js`.

i18n: new `web/lib/i18n/{de,en}/assistant-settings.js` and `web/lib/i18n/messages/assistant-settings.js`.

Tests:

- Unit: `tests/unit/assistant-settings-copy.test.js`, `tests/unit/agent-settings-fields.test.js`, `tests/unit/agent-settings-steps.test.js`.
- Helpers: extend `tests/helpers/assistant-settings-browser.js`; new `tests/helpers/agent-settings-page.js`.
- New browser specs: `tests/browser/assistant-settings-tabs.spec.js`, `tests/browser/assistant-settings-save.spec.js` (named `assistant*` so the WebKit tablet project also runs them).
- Updated browser specs (how elements are found): `assistant-settings`, `assistant-settings-mobile`, `assistant-shell`, `assistant-web-tools`, `assistant-native-capabilities`, `assistant-proactivity`, `assistant-channels`, `assistant-routines`, `assistant-workflows`, `assistant-teams`, `agent-mcp-servers`, `mcp-oauth`, `assistant-accounts`, `assistant-model-picker` (the last two only for the create-mode "Create agent" button).
- Screenshots (git-ignored): `.superpowers/screenshots/agent/{screens.config.mjs,capture.spec.js}` and the PNGs.

### Decisions that refine the spec

- **Header stays `AssistantHeader`.** It already is the handoff 1d agent header (back "Zurück zur Unterhaltung", avatar tile, name, "Einstellungen", shell chip, missing-connection status and notice, phone drawer button that `assistant-chat-layout.spec.js` relies on). `SettingsShell` has no avatar, chip or status slot, so the page composes `AssistantHeader` + `UnderlineTabs` + content column + `SaveBar` with the pattern's CSS instead of `SettingsShell`.
- **One draft per tab, subpages inside the tab.** A tab component renders its own subpages (`agentPage`), so moving between a tab and its subpage never unmounts the draft; `staysOnAgentTab(assistantId, tab)` keeps the guard quiet for that. The memory editor is the one subpage with its own draft and bar (spec: "memory editor subpage with its own bar and hash check"); its guard stays only on `page === "memory"`.
- **Reminder and routine details expand inline.** Step 0 defines no `agentPage` for them; a row toggles a detail block (`aria-expanded`) with history, review, pause/resume, delete, run.
- **Work saves only the changed half.** `workStep` builds the `PUT /work` body from `ctx.changed`, so a team-only change is not refused by the access half's maintenance rule. Revisions come from whichever halves the response returns.
- **Telegram not connected** (`!channel?.hasSecret`): the heartbeat toggle and the "+ create" actions of reminders and routines are disabled and the groups dimmed with their hints (`heartbeatChannel`, `remindersHint`, routine `description`); existing reminder/routine rows stay operable (pause, delete, review) so nothing becomes unreachable.
- **Runtime card:** right column (`aside`) at ≥ 1100 px; below that the same `RuntimeSummary` renders as a group at the end of Profil. CSS shows exactly one of them.
- **Telegram language/app URL send only changed fields**, so a language-only save is `PATCH {language, revision}` as before.
- **Speech link** keeps `{ view: "accounts" }` (existing assertion `toHaveURL(/\/accounts$/)`); Step 2 may deep-link it later.

---

### Task 1: Agent settings copy catalog

Preflight for the whole plan plus the new catalog every later task imports.

**Files:**

- Create: `web/lib/i18n/de/assistant-settings.js`, `web/lib/i18n/en/assistant-settings.js`, `web/lib/i18n/messages/assistant-settings.js`
- Test: `tests/unit/assistant-settings-copy.test.js`

**Interfaces:**

- Consumes: `localizedCopy(german, english)` from `web/lib/i18n/index.js`.
- Produces: `assistantSettingsCopy` (reactive, `web/lib/i18n/messages/assistant-settings.js`) with keys `tabsLabel`, `tabs.{profile,capabilities,work,telegram}`, `createAgent`, `backTo(tab)`, `searchProvider(name)`, `searchProviders.{duckduckgo,perplexity,brave}`, `manageMcpServers`, `pendingApprovals(count)`, `teamGroup`, `connectionGroup`, `connectionPage`, `activityAttention(count)`, `allDelivered`, `noActivity`, `replaceToken`, `replaceTokenHint`, `addReminder`, `addRoutine`, `heartbeatNeedsMemory`.

- [ ] **Step 1: Verify the Step 0 contract is present**

Run (from the worktree root):

```bash
git log --oneline -1 && ls web/lib/settings/useTabDraft.js web/lib/settings/useUnsavedChangesGuard.js web/lib/settings/save-chain.js web/lib/settings/draft-state.js web/lib/navigation-guard.js web/components/SaveBar.jsx web/components/Sheet.jsx web/components/UnsavedChangesSheet.jsx web/components/GroupLabel.jsx web/components/ListCard.jsx web/components/ListRow.jsx web/components/Segmented.jsx web/components/InfoHint.jsx web/components/ReferenceRow.jsx web/features/assistants/settings-routes.js web/features/assistants/assistant-save-steps.js docs/settings-pattern.md
grep -n "export" web/features/assistants/settings-routes.js web/features/assistants/assistant-save-steps.js web/lib/settings/save-chain.js web/components/ListRow.jsx web/components/InfoHint.jsx
grep -n "saveWork" web/features/assistants/assistant-api.js
```

Expected: every file exists; exports include `agentSettingsLocation`, `assistantPatchStep`, `assistantWorkStep`, `runSaveChain`, `confirmationRequest`, `unknownValue`, `ToggleRow`, `NumberRow`, `SelectRow`, `CheckboxRow`, `useInfoHint`, `InfoHintButton`, `InfoHintText`; `assistantApi.saveWork` exists. If a name differs, stop and report — the foundation plan is the contract.

- [ ] **Step 2: Write the failing test**

Create `tests/unit/assistant-settings-copy.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import * as de from "../../web/lib/i18n/de/assistant-settings.js";
import * as en from "../../web/lib/i18n/en/assistant-settings.js";

test("agent settings name the four tabs and the create action in both languages", () => {
  assert.deepEqual(Object.values(de.assistantSettingsCopy.tabs), [
    "Profil",
    "Fähigkeiten",
    "Arbeit",
    "Telegram",
  ]);
  assert.deepEqual(Object.values(en.assistantSettingsCopy.tabs), [
    "Profile",
    "Capabilities",
    "Work",
    "Telegram",
  ]);
  assert.equal(de.assistantSettingsCopy.createAgent, "Agent anlegen");
  assert.equal(en.assistantSettingsCopy.createAgent, "Create agent");
});

test("counted agent settings texts take their numbers", () => {
  assert.equal(
    de.assistantSettingsCopy.pendingApprovals(2),
    "Wartet auf deine Freigabe · 2",
  );
  assert.equal(en.assistantSettingsCopy.activityAttention(1), "1 needs your decision");
  assert.equal(en.assistantSettingsCopy.activityAttention(3), "3 need your decision");
  assert.equal(de.assistantSettingsCopy.backTo("Arbeit"), "Zurück zu Arbeit");
  assert.equal(
    en.assistantSettingsCopy.searchProvider("Brave Search"),
    "Search provider · Brave Search",
  );
});
```

- [ ] **Step 3: Run it to make sure it fails**

Run: `node --test tests/unit/assistant-settings-copy.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `assistant-settings.js`.

- [ ] **Step 4: Write the catalogs**

Create `web/lib/i18n/de/assistant-settings.js`:

```js
export const assistantSettingsCopy = {
  tabsLabel: "Agenten-Einstellungen",
  tabs: {
    profile: "Profil",
    capabilities: "Fähigkeiten",
    work: "Arbeit",
    telegram: "Telegram",
  },
  createAgent: "Agent anlegen",
  backTo: (tab) => `Zurück zu ${tab}`,
  searchProvider: (name) => `Suchanbieter · ${name}`,
  searchProviders: {
    duckduckgo: "DuckDuckGo",
    perplexity: "Perplexity",
    brave: "Brave Search",
  },
  manageMcpServers: "MCP-Server verwalten",
  pendingApprovals: (count) => `Wartet auf deine Freigabe · ${count}`,
  teamGroup: "Team",
  connectionGroup: "Verbindung",
  connectionPage: "Verbindung",
  activityAttention: (count) =>
    count === 1 ? "1 braucht deine Entscheidung" : `${count} brauchen deine Entscheidung`,
  allDelivered: "Alles zugestellt",
  noActivity: "Noch keine Aktivität",
  replaceToken: "Bot-Token ersetzen",
  replaceTokenHint: "Nur ein neuer Token desselben Bots wird angenommen.",
  addReminder: "+ Erinnerung erstellen",
  addRoutine: "+ Routine",
  heartbeatNeedsMemory:
    "Braucht das Gedächtnis: Schalte „Informationen merken“ unter Fähigkeiten ein.",
};
```

Create `web/lib/i18n/en/assistant-settings.js`:

```js
export const assistantSettingsCopy = {
  tabsLabel: "Agent settings",
  tabs: {
    profile: "Profile",
    capabilities: "Capabilities",
    work: "Work",
    telegram: "Telegram",
  },
  createAgent: "Create agent",
  backTo: (tab) => `Back to ${tab}`,
  searchProvider: (name) => `Search provider · ${name}`,
  searchProviders: {
    duckduckgo: "DuckDuckGo",
    perplexity: "Perplexity",
    brave: "Brave Search",
  },
  manageMcpServers: "Manage MCP servers",
  pendingApprovals: (count) => `Waiting for your approval · ${count}`,
  teamGroup: "Team",
  connectionGroup: "Connection",
  connectionPage: "Connection",
  activityAttention: (count) =>
    count === 1 ? "1 needs your decision" : `${count} need your decision`,
  allDelivered: "All delivered",
  noActivity: "No activity yet",
  replaceToken: "Replace bot token",
  replaceTokenHint: "Only a new token for the same bot is accepted.",
  addReminder: "+ Create reminder",
  addRoutine: "+ Routine",
  heartbeatNeedsMemory:
    "Needs memory: switch on “Remember information” under Capabilities.",
};
```

Create `web/lib/i18n/messages/assistant-settings.js`:

```js
import * as de from "../de/assistant-settings.js";
import * as en from "../en/assistant-settings.js";
import { localizedCopy } from "../index.js";
export const assistantSettingsCopy = localizedCopy(
  de.assistantSettingsCopy,
  en.assistantSettingsCopy,
);
```

- [ ] **Step 5: Run the copy tests**

Run: `node --test tests/unit/assistant-settings-copy.test.js tests/unit/i18n-catalogs.test.js tests/unit/i18n-terminology.test.js`
Expected: PASS (the catalog parity test discovers the new file in `de/`, `en/` and `messages/`).

- [ ] **Step 6: Commit**

```bash
npx prettier --write web/lib/i18n/de/assistant-settings.js web/lib/i18n/en/assistant-settings.js web/lib/i18n/messages/assistant-settings.js tests/unit/assistant-settings-copy.test.js
git add web/lib/i18n/de/assistant-settings.js web/lib/i18n/en/assistant-settings.js web/lib/i18n/messages/assistant-settings.js tests/unit/assistant-settings-copy.test.js
git commit -m "feat: add agent settings tab copy" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Pure rules and save steps for the agent tabs

All decisions that do not need React: visible tabs and subpages, each tab's draft fields, the request bodies and the save-chain steps.

**Files:**

- Create: `web/features/assistants/settings/agent-settings-fields.js`, `web/features/assistants/settings/agent-settings-steps.js`
- Test: `tests/unit/agent-settings-fields.test.js`, `tests/unit/agent-settings-steps.test.js`

**Interfaces:**

- Consumes: `sameValue` (`web/lib/settings/draft-state.js`); `agentSettingsLocation(route) => { tab, page }` (`web/features/assistants/settings-routes.js`); `runSaveChain`, `confirmationRequest` (`web/lib/settings/save-chain.js`); `assistantPatchStep({ assistantId, label, keys, body, update })` (`web/features/assistants/assistant-save-steps.js`); `heartbeatForm` (`../heartbeat.js`); `shellEligible`, `shellLevel` (`../shell-level.js`); `restartRequired` (`web/features/provider-connections/restart-confirmation.js`); `assistantApi.{update,updateChannel,saveWork,create,saveMemory}`.
- Produces (`agent-settings-fields.js`):
  - key lists `capabilityKeys`, `webCapabilityKeys`, `capabilityFormKeys`, `profileKeys`, `heartbeatKeys`, `channelKeys`, `accessKeys`, `teamKeys`, `permissionKeys`; `capabilityDefaults`
  - `isPersonal(assistant) => boolean`, `visibleAgentTabs(assistant) => string[]`, `agentPageAllowed(assistant, page) => boolean`
  - `resolveAgentLocation(assistant, route) => { tab, page, tabs, normalized }`
  - `agentRoute(assistantId, tab = "profile", page = "") => route`
  - `staysOnAgentTab(assistantId, tab, page?) => (request) => boolean`
  - `sortedIds(ids) => string[]`, `toggleId(ids, id, on) => string[]`
  - `profileServer(assistant)`, `profilePatch(values)`; `capabilityServer(assistant)`, `capabilityPatch({ values, base, assistant })`; `telegramServer(assistant, channel)`, `heartbeatPatch(values, assistant)`, `channelPatch({ values, base })`; `workServer(policy, team)`, `workBody({ values, changed, revisions, withTeam })`; `createServer()`, `createInput(values)`
  - `grantCount(ids, items) => number`, `pendingCount(actions) => number`, `recoveryStates`, `inProgressStates`, `channelActivity(channel) => { entries, visible, attention }`
- Produces (`agent-settings-steps.js`), all Step 0 Step objects:
  - `profileStep({ assistantId, label, update? })` — id `"assistant"`, resource `"assistant"`, keys `profileKeys`
  - `capabilityStep({ assistant, label, update? })` — id `"assistant"`, resource `"assistant"`, keys `capabilityFormKeys`
  - `heartbeatStep({ assistant, label, update? })` — id `"assistant"`, resource `"assistant"`, keys `heartbeatKeys`
  - `channelStep({ channelId, label, updateChannel? })` — id `"channel"`, resource `"channel"`, keys `channelKeys`
  - `workStep({ assistantId, label, withTeam, save? })` — id `"work"`, keys access (+ team), `revisions(result)` from the halves present
  - `createStep({ label, create? })` — id `"create"`, no keys (always runs); a restart request is an error, other confirmations use the default mapping
  - `memoryStep({ assistantId, name, file, label, saveMemory? })` — id `"memory"`, keys `["content"]`

- [ ] **Step 1: Write the failing field tests**

Create `tests/unit/agent-settings-fields.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  agentRoute,
  capabilityPatch,
  capabilityServer,
  channelActivity,
  channelPatch,
  createInput,
  createServer,
  grantCount,
  heartbeatPatch,
  pendingCount,
  profilePatch,
  profileServer,
  resolveAgentLocation,
  staysOnAgentTab,
  telegramServer,
  toggleId,
  visibleAgentTabs,
  workBody,
  workServer,
} from "../../web/features/assistants/settings/agent-settings-fields.js";

const agent = (extra = {}) => ({
  id: "home",
  name: "Home",
  instructions: "Plan meals",
  revision: 3,
  model: { connectionId: "router", modelId: "model" },
  capabilities: { memory: true, reminders: false },
  mcpServers: ["b", "a"],
  ...extra,
});
const settings = (extra = {}) => ({
  view: "agents",
  assistantId: "home",
  agentSettings: true,
  ...extra,
});

test("personal agents get four tabs, task-bound members two", () => {
  assert.deepEqual(visibleAgentTabs(agent()), [
    "profile",
    "capabilities",
    "work",
    "telegram",
  ]);
  assert.deepEqual(
    visibleAgentTabs(agent({ teamMemberId: "m", lifetime: "permanent" })),
    ["profile", "capabilities", "work", "telegram"],
  );
  assert.deepEqual(visibleAgentTabs(agent({ teamMemberId: "m", lifetime: "task" })), [
    "profile",
    "capabilities",
  ]);
});

test("locations the agent cannot show normalise to a valid tab", () => {
  assert.deepEqual(resolveAgentLocation(agent(), settings({ agentTab: "work" })), {
    tab: "work",
    page: "",
    tabs: ["profile", "capabilities", "work", "telegram"],
    normalized: false,
  });
  const member = agent({ teamMemberId: "m", lifetime: "task" });
  const hidden = resolveAgentLocation(member, settings({ agentTab: "telegram" }));
  assert.equal(hidden.tab, "profile");
  assert.equal(hidden.normalized, true);
  const noMemory = agent({ capabilities: { memory: false } });
  const memory = resolveAgentLocation(
    noMemory,
    settings({ agentTab: "capabilities", agentPage: "memory" }),
  );
  assert.deepEqual(
    [memory.tab, memory.page, memory.normalized],
    ["capabilities", "", true],
  );
  const archived = agent({ archivedAt: "2026-10-01" });
  const allowlist = resolveAgentLocation(
    archived,
    settings({ agentTab: "capabilities", agentPage: "allowlist" }),
  );
  assert.equal(allowlist.page, "");
});

test("agent routes leave the default tab out and carry a subpage's tab", () => {
  assert.deepEqual(agentRoute("home"), settings());
  assert.deepEqual(agentRoute("home", "work"), settings({ agentTab: "work" }));
  assert.deepEqual(
    agentRoute("home", "capabilities", "memory"),
    settings({ agentTab: "capabilities", agentPage: "memory" }),
  );
});

test("a draft stays only for navigations within its own tab", () => {
  const stays = staysOnAgentTab("home", "work");
  assert.equal(
    stays({ next: settings({ agentTab: "work", agentPage: "projects" }) }),
    true,
  );
  assert.equal(stays({ next: settings({ agentTab: "telegram" }) }), false);
  assert.equal(
    stays({ next: { ...settings({ agentTab: "work" }), assistantId: "other" } }),
    false,
  );
  assert.equal(
    stays({ next: { view: "agents", assistantId: "home", conversationId: "c" } }),
    false,
  );
  assert.equal(stays({}), false);
  const memory = staysOnAgentTab("home", "capabilities", "memory");
  assert.equal(
    memory({ next: settings({ agentTab: "capabilities", agentPage: "memory" }) }),
    true,
  );
  assert.equal(memory({ next: settings({ agentTab: "capabilities" }) }), false);
});

test("profile drafts send name, instructions and the model together", () => {
  const server = profileServer(agent());
  assert.deepEqual(server, {
    name: "Home",
    instructions: "Plan meals",
    connectionId: "router",
    modelId: "model",
  });
  assert.deepEqual(profilePatch({ ...server, modelId: "other" }), {
    name: "Home",
    instructions: "Plan meals",
    model: { connectionId: "router", modelId: "other" },
  });
  assert.deepEqual(profileServer(undefined), {
    name: "",
    instructions: "",
    connectionId: "",
    modelId: "",
  });
});

test("capability drafts flatten switches and send only what changed", () => {
  const assistant = agent();
  const base = capabilityServer(assistant);
  assert.deepEqual(base, {
    memory: true,
    reminders: false,
    webSearch: false,
    webFetch: false,
    browser: false,
    documents: false,
    shell: "off",
    mcpServers: ["a", "b"],
  });
  assert.deepEqual(
    capabilityPatch({ values: { ...base, webFetch: true }, base, assistant }),
    {
      capabilities: {
        memory: true,
        reminders: false,
        webSearch: false,
        webFetch: true,
        browser: false,
        documents: false,
      },
    },
  );
  assert.deepEqual(
    capabilityPatch({
      values: { ...base, shell: "approval", mcpServers: ["a"] },
      base,
      assistant,
    }),
    { shell: "approval", mcpServers: ["a"] },
  );
  const member = agent({ teamMemberId: "m", lifetime: "task" });
  assert.deepEqual(
    capabilityPatch({ values: { ...base, shell: "full" }, base, assistant: member }),
    {},
  );
});

test("switching memory off also switches a saved check-in schedule off", () => {
  const assistant = agent({
    heartbeat: { enabled: true, interval: "4h", start: 9, end: 18, timeZone: "UTC" },
  });
  const base = capabilityServer(assistant);
  assert.deepEqual(
    capabilityPatch({ values: { ...base, memory: false }, base, assistant }),
    {
      capabilities: {
        memory: false,
        reminders: false,
        webSearch: false,
        webFetch: false,
        browser: false,
        documents: false,
      },
      heartbeat: { enabled: false, interval: "4h", start: 9, end: 18, timeZone: "UTC" },
    },
  );
});

test("telegram drafts keep the heartbeat flat and send only changed channel fields", () => {
  const assistant = agent({
    heartbeat: { enabled: true, interval: "2h", start: 8, end: 20, timeZone: "UTC" },
  });
  const base = telegramServer(assistant, { language: "en", appUrl: null });
  assert.deepEqual(base, {
    heartbeatEnabled: true,
    interval: "2h",
    start: 8,
    end: 20,
    timeZone: "UTC",
    language: "en",
    appUrl: "",
  });
  assert.deepEqual(heartbeatPatch({ ...base, interval: "1h" }, assistant), {
    heartbeat: { enabled: true, interval: "1h", start: 8, end: 20, timeZone: "UTC" },
  });
  const noMemory = { ...assistant, capabilities: { memory: false } };
  assert.equal(heartbeatPatch(base, noMemory).heartbeat.enabled, false);
  assert.deepEqual(channelPatch({ values: { ...base, language: "de" }, base }), {
    language: "de",
  });
  assert.deepEqual(channelPatch({ values: { ...base, appUrl: "  " }, base }), {
    appUrl: null,
  });
  assert.equal(telegramServer(assistant, null).language, "de");
});

test("work drafts send only the half that changed, each with its revision", () => {
  const base = workServer(
    { revision: 4, projectIds: ["p2", "p1"], pipelineIds: [], memoryWrite: true },
    { revision: 7, autonomous: false, maxMembers: 4, runTimeoutMinutes: 30 },
  );
  assert.deepEqual(base, {
    projectIds: ["p1", "p2"],
    pipelineIds: [],
    memoryWrite: true,
    autonomous: false,
    publish: false,
    teamAutonomous: false,
    maxMembers: 4,
    runTimeoutMinutes: 30,
  });
  const revisions = { access: 4, team: 7 };
  assert.deepEqual(
    workBody({
      values: { ...base, maxMembers: 6 },
      changed: ["maxMembers"],
      revisions,
      withTeam: true,
    }),
    { team: { revision: 7, autonomous: false, maxMembers: 6, runTimeoutMinutes: 30 } },
  );
  assert.deepEqual(
    workBody({
      values: { ...base, publish: true },
      changed: ["publish"],
      revisions,
      withTeam: false,
    }),
    {
      access: {
        revision: 4,
        projectIds: ["p1", "p2"],
        pipelineIds: [],
        memoryWrite: true,
        autonomous: false,
        publish: true,
      },
    },
  );
  assert.deepEqual(workServer(null, null).maxMembers, "");
});

test("counts never invent numbers", () => {
  assert.equal(grantCount(["p1", "gone"], [{ id: "p1" }, { id: "p2" }]), 1);
  assert.equal(pendingCount([{ state: "awaiting_approval" }, { state: "running" }]), 1);
  assert.deepEqual(toggleId(["b"], "a", true), ["a", "b"]);
  assert.deepEqual(toggleId(["a", "b"], "a", false), ["b"]);
});

test("Telegram activity keeps entries that need a decision ahead of the recent ones", () => {
  const channel = {
    inputs: [
      { id: "old", state: "delivery_failed" },
      ...Array.from({ length: 25 }, (_, i) => ({ id: `i${i}`, state: "delivered" })),
    ],
    notifications: [{ id: "n", state: "delivered", needsReview: true }],
  };
  const activity = channelActivity(channel);
  assert.equal(activity.attention, 2);
  assert.equal(activity.visible[0].id, "old");
  assert.equal(activity.visible.length, 21);
  assert.deepEqual(channelActivity(null), { entries: [], visible: [], attention: 0 });
});

test("create mode starts empty and sends shell only when raised", () => {
  const values = { ...createServer(), name: "Fresh", memory: true };
  assert.deepEqual(createInput(values), {
    name: "Fresh",
    instructions: "",
    model: { connectionId: "", modelId: "" },
    capabilities: {
      memory: true,
      reminders: false,
      webSearch: false,
      webFetch: false,
      browser: false,
      documents: false,
    },
  });
  assert.equal(createInput({ ...values, shell: "approval" }).shell, "approval");
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test tests/unit/agent-settings-fields.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement the fields module**

Create `web/features/assistants/settings/agent-settings-fields.js`:

```js
import { sameValue } from "../../../lib/settings/draft-state.js";
import { agentSettingsLocation } from "../settings-routes.js";
import { heartbeatForm } from "../heartbeat.js";
import { shellEligible, shellLevel } from "../shell-level.js";

// Pure rules of the agent settings page (docs/settings-pattern.md): which tabs and
// subpages an agent has, what each tab's draft holds and what a save sends.
export const capabilityKeys = [
  "memory",
  "reminders",
  "webSearch",
  "webFetch",
  "browser",
  "documents",
];
export const webCapabilityKeys = capabilityKeys.slice(2);
export const capabilityDefaults = Object.fromEntries(
  capabilityKeys.map((key) => [key, false]),
);
export const capabilityFormKeys = [...capabilityKeys, "shell", "mcpServers"];
export const profileKeys = ["name", "instructions", "connectionId", "modelId"];
export const heartbeatKeys = ["heartbeatEnabled", "interval", "start", "end", "timeZone"];
export const channelKeys = ["language", "appUrl"];
export const permissionKeys = ["memoryWrite", "autonomous", "publish"];
export const accessKeys = ["projectIds", "pipelineIds", ...permissionKeys];
export const teamKeys = ["teamAutonomous", "maxMembers", "runTimeoutMinutes"];

const pageTabs = {
  memory: "capabilities",
  allowlist: "capabilities",
  actions: "work",
  projects: "work",
  pipelines: "work",
  "telegram-activity": "telegram",
  "telegram-connection": "telegram",
};

export const isPersonal = (assistant) =>
  !assistant?.teamMemberId || assistant.lifetime === "permanent";

export const visibleAgentTabs = (assistant) =>
  isPersonal(assistant)
    ? ["profile", "capabilities", "work", "telegram"]
    : ["profile", "capabilities"];

/** Whether the agent has this subpage; Telegram subpages also need a channel (tab). */
export function agentPageAllowed(assistant, page) {
  if (!page) return true;
  if (!pageTabs[page] || !isPersonal(assistant)) return false;
  if (page === "memory") return assistant.capabilities?.memory === true;
  if (page === "allowlist") return shellEligible(assistant);
  return true;
}

/** The tab and subpage to show, and whether the address has to be replaced. */
export function resolveAgentLocation(assistant, route) {
  const wanted = agentSettingsLocation(route);
  const tabs = visibleAgentTabs(assistant);
  const tab = tabs.includes(wanted.tab) ? wanted.tab : "profile";
  const page =
    tab === wanted.tab && agentPageAllowed(assistant, wanted.page) ? wanted.page : "";
  return { tab, page, tabs, normalized: tab !== wanted.tab || page !== wanted.page };
}

export const agentRoute = (assistantId, tab = "profile", page = "") => ({
  view: "agents",
  assistantId,
  agentSettings: true,
  ...(tab !== "profile" || page ? { agentTab: tab } : {}),
  ...(page ? { agentPage: page } : {}),
});

/** A tab's draft stays on screen for navigations within the same agent and tab. */
export const staysOnAgentTab = (assistantId, tab, page) => (request) => {
  const next = request?.next;
  if (
    next?.view !== "agents" ||
    next.assistantId !== assistantId ||
    !next.agentSettings ||
    next.conversationId
  )
    return false;
  const location = agentSettingsLocation(next);
  return location.tab === tab && (page === undefined || location.page === page);
};

export const sortedIds = (ids) => [...new Set(ids || [])].sort();
export const toggleId = (ids, id, on) =>
  sortedIds(on ? [...ids, id] : ids.filter((value) => value !== id));
const pick = (source, keys) =>
  Object.fromEntries(keys.map((key) => [key, source?.[key] === true]));

export const profileServer = (assistant) => ({
  name: assistant?.name || "",
  instructions: assistant?.instructions || "",
  connectionId: assistant?.model?.connectionId || "",
  modelId: assistant?.model?.modelId || "",
});
export const profilePatch = (values) => ({
  name: values.name,
  instructions: values.instructions,
  model: { connectionId: values.connectionId, modelId: values.modelId },
});

export const capabilityServer = (assistant) => ({
  ...pick(assistant?.capabilities, capabilityKeys),
  shell: shellLevel(assistant),
  mcpServers: sortedIds(assistant?.mcpServers),
});

/** One PATCH for the Capabilities tab; only changed parts are sent. */
export function capabilityPatch({ values, base, assistant }) {
  const changed = (key) => !sameValue(values[key], base[key]);
  const patch = {};
  if (capabilityKeys.some(changed))
    patch.capabilities = {
      ...capabilityDefaults,
      ...assistant.capabilities,
      ...pick(values, capabilityKeys),
    };
  // Only a changed level is sent: the server asks to confirm a raise.
  if (shellEligible(assistant) && changed("shell")) patch.shell = values.shell;
  if (changed("mcpServers")) patch.mcpServers = values.mcpServers;
  // Check-ins need memory: switching memory off switches a saved schedule off too.
  if (!values.memory && assistant.heartbeat?.enabled)
    patch.heartbeat = { ...heartbeatForm(assistant), enabled: false };
  return patch;
}

export function telegramServer(assistant, channel) {
  const heartbeat = heartbeatForm(assistant);
  return {
    heartbeatEnabled: heartbeat.enabled === true,
    interval: heartbeat.interval,
    start: heartbeat.start,
    end: heartbeat.end,
    timeZone: heartbeat.timeZone,
    language: channel?.language || "de",
    appUrl: channel?.appUrl ?? "",
  };
}
export const heartbeatPatch = (values, assistant) => ({
  heartbeat: {
    enabled: values.heartbeatEnabled && assistant.capabilities?.memory === true,
    interval: values.interval,
    start: values.start,
    end: values.end,
    timeZone: values.timeZone,
  },
});
export function channelPatch({ values, base }) {
  const patch = {};
  if (values.language !== base.language) patch.language = values.language;
  if (values.appUrl !== base.appUrl) patch.appUrl = values.appUrl.trim() || null;
  return patch;
}

export const workServer = (policy, team) => ({
  projectIds: sortedIds(policy?.projectIds),
  pipelineIds: sortedIds(policy?.pipelineIds),
  memoryWrite: policy?.memoryWrite === true,
  autonomous: policy?.autonomous === true,
  publish: policy?.publish === true,
  teamAutonomous: team?.autonomous === true,
  maxMembers: team?.maxMembers ?? "",
  runTimeoutMinutes: team?.runTimeoutMinutes ?? "",
});

/** The PUT /assistants/:id/work body: only the halves with changes, each with its revision. */
export function workBody({ values, changed, revisions, withTeam }) {
  const body = {};
  if (accessKeys.some((key) => changed.includes(key)))
    body.access = {
      revision: revisions.access,
      ...Object.fromEntries(accessKeys.map((key) => [key, values[key]])),
    };
  if (withTeam && teamKeys.some((key) => changed.includes(key)))
    body.team = {
      revision: revisions.team,
      autonomous: values.teamAutonomous,
      maxMembers: values.maxMembers,
      runTimeoutMinutes: values.runTimeoutMinutes,
    };
  return body;
}

export const grantCount = (ids, items) =>
  items.filter((item) => ids.includes(item.id)).length;
export const pendingCount = (actions) =>
  actions.filter((action) => action.state === "awaiting_approval").length;

export const recoveryStates = [
  "transcription_failed",
  "delivery_failed",
  "delivery_uncertain",
  "reply_unavailable",
  "model_reviewed",
  "model_uncertain",
];
export const inProgressStates = [
  "queued",
  "voice_pending",
  "transcribing",
  "dispatching",
  "running",
  "outbound",
  "delivering",
];
const needsAttention = (entry) =>
  entry.needsReview || recoveryStates.includes(entry.state);

/** Telegram inputs and notices: the ones to act on first, then the 20 newest. */
export function channelActivity(channel) {
  const entries = [...(channel?.inputs || []), ...(channel?.notifications || [])];
  const visible = [
    ...new Map(
      [
        ...entries.filter((entry) => recoveryStates.includes(entry.state)),
        ...entries.slice(-20).reverse(),
      ].map((entry) => [entry.id, entry]),
    ).values(),
  ];
  return { entries, visible, attention: entries.filter(needsAttention).length };
}

export const createServer = () => ({
  ...profileServer(),
  ...capabilityDefaults,
  shell: "off",
});
export const createInput = (values) => ({
  ...profilePatch(values),
  capabilities: pick(values, capabilityKeys),
  ...(values.shell !== "off" ? { shell: values.shell } : {}),
});
```

- [ ] **Step 4: Run the field tests**

Run: `node --test tests/unit/agent-settings-fields.test.js`
Expected: PASS (12 tests).

- [ ] **Step 5: Write the failing step tests**

Create `tests/unit/agent-settings-steps.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { runSaveChain } from "../../web/lib/settings/save-chain.js";
import {
  capabilityServer,
  heartbeatKeys,
  telegramServer,
  workServer,
} from "../../web/features/assistants/settings/agent-settings-fields.js";
import {
  capabilityStep,
  channelStep,
  createStep,
  heartbeatStep,
  memoryStep,
  workStep,
} from "../../web/features/assistants/settings/agent-settings-steps.js";

const assistant = {
  id: "home",
  revision: 2,
  capabilities: { memory: true },
  heartbeat: { enabled: false, interval: "4h", start: 9, end: 18, timeZone: "UTC" },
};

test("the Capabilities save is one PATCH with the base revision and confirmations", async () => {
  const bodies = [];
  const update = async (id, body) => {
    bodies.push([id, body]);
    if (!body.confirmShell)
      throw Object.assign(new Error("confirm"), {
        code: "ASSISTANT_SHELL_CONFIRMATION_REQUIRED",
        required: ["confirmShell"],
      });
    return { revision: 3 };
  };
  const base = capabilityServer(assistant);
  const result = await runSaveChain({
    steps: [capabilityStep({ assistant, label: "Capabilities", update })],
    values: { ...base, shell: "approval" },
    base,
    revisions: { assistant: 2 },
    ask: async (request) => request.kind === "shell",
  });
  assert.equal(result.status, "saved");
  assert.deepEqual(bodies, [
    ["home", { shell: "approval", revision: 2 }],
    ["home", { shell: "approval", revision: 2, confirmShell: true }],
  ]);
  assert.equal(result.revisions.assistant, 3);
});

test("a Telegram save that fails at the channel keeps the heartbeat as saved", async () => {
  const calls = [];
  const steps = [
    heartbeatStep({
      assistant,
      label: "Acting on its own",
      update: async (id, body) => {
        calls.push(["assistant", body]);
        return { revision: 3 };
      },
    }),
    channelStep({
      channelId: "c1",
      label: "Connection",
      updateChannel: async (id, body) => {
        calls.push(["channel", id, body]);
        throw Object.assign(new Error("down"), { status: 500 });
      },
    }),
  ];
  const base = telegramServer(assistant, { language: "de", appUrl: "", revision: 5 });
  const values = { ...base, heartbeatEnabled: true, language: "en" };
  const result = await runSaveChain({
    steps,
    values,
    base,
    revisions: { assistant: 2, channel: 5 },
  });
  assert.equal(result.status, "error");
  assert.deepEqual(result.completed, ["assistant"]);
  assert.deepEqual(result.savedKeys, heartbeatKeys);
  assert.deepEqual(calls, [
    [
      "assistant",
      {
        heartbeat: { enabled: true, interval: "4h", start: 9, end: 18, timeZone: "UTC" },
        revision: 2,
      },
    ],
    ["channel", "c1", { language: "en", revision: 5 }],
  ]);
  assert.equal(result.revisions.assistant, 3);
});

test("the Work save sends one request and takes both revisions from the answer", async () => {
  const sent = [];
  const base = workServer(
    { revision: 4, projectIds: [] },
    { revision: 7, autonomous: false, maxMembers: 4, runTimeoutMinutes: 30 },
  );
  const result = await runSaveChain({
    steps: [
      workStep({
        assistantId: "home",
        label: "Work",
        withTeam: true,
        save: async (id, body) => {
          sent.push([id, body]);
          return { access: { revision: 5 }, team: { revision: 8 } };
        },
      }),
    ],
    values: { ...base, projectIds: ["p1"], maxMembers: 6 },
    base,
    revisions: { access: 4, team: 7 },
  });
  assert.equal(result.status, "saved");
  assert.equal(sent.length, 1);
  assert.deepEqual(Object.keys(sent[0][1]).sort(), ["access", "team"]);
  assert.deepEqual(result.revisions, { access: 5, team: 8 });
});

test("creating an agent treats a restart request as an error", async () => {
  const result = await runSaveChain({
    steps: [
      createStep({
        label: "Create agent",
        create: async () => {
          throw Object.assign(new Error("restart"), {
            code: "ASSISTANT_RESTART_REQUIRED",
          });
        },
      }),
    ],
    values: { name: "Fresh", shell: "off" },
    base: {},
    ask: async () => {
      throw new Error("must not ask");
    },
  });
  assert.equal(result.status, "error");
});

test("a memory note is saved against the hash it was loaded with", async () => {
  const sent = [];
  const saveMemory = async (id, body) => {
    sent.push(body);
    return { hash: "h2", content: body.content };
  };
  const step = memoryStep({
    assistantId: "home",
    name: "USER.md",
    file: { hash: "h1" },
    label: "Memory",
    saveMemory,
  });
  await runSaveChain({
    steps: [step],
    values: { content: "tea" },
    base: { content: "" },
  });
  const missing = memoryStep({
    assistantId: "home",
    name: "MEMORY.md",
    file: { missing: true },
    label: "Memory",
    saveMemory,
  });
  await runSaveChain({
    steps: [missing],
    values: { content: "x" },
    base: { content: "" },
  });
  assert.deepEqual(sent, [
    { name: "USER.md", content: "tea", expectedHash: "h1" },
    { name: "MEMORY.md", content: "x", expectedMissing: true },
  ]);
});
```

- [ ] **Step 6: Run it to make sure it fails**

Run: `node --test tests/unit/agent-settings-steps.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `agent-settings-steps.js`.

- [ ] **Step 7: Implement the steps module**

Create `web/features/assistants/settings/agent-settings-steps.js`:

```js
import { assistantApi } from "../assistant-api.js";
import { assistantPatchStep } from "../assistant-save-steps.js";
import { confirmationRequest } from "../../../lib/settings/save-chain.js";
import { restartRequired } from "../../provider-connections/restart-confirmation.js";
import {
  accessKeys,
  capabilityFormKeys,
  capabilityPatch,
  channelKeys,
  channelPatch,
  createInput,
  heartbeatKeys,
  heartbeatPatch,
  profileKeys,
  profilePatch,
  teamKeys,
  workBody,
} from "./agent-settings-fields.js";

// Save-chain steps of the agent tabs (docs/settings-pattern.md). Every step sends the
// revision the draft started from, so a change made elsewhere comes back as a 409.
export const profileStep = ({ assistantId, label, update }) =>
  assistantPatchStep({
    assistantId,
    label,
    keys: profileKeys,
    body: profilePatch,
    update,
  });

export const capabilityStep = ({ assistant, label, update = assistantApi.update }) => ({
  id: "assistant",
  label,
  keys: capabilityFormKeys,
  resource: "assistant",
  run: ({ values, base, revision, confirmations }) =>
    update(assistant.id, {
      ...capabilityPatch({ values, base, assistant }),
      revision,
      ...confirmations,
    }),
});

export const heartbeatStep = ({ assistant, label, update }) =>
  assistantPatchStep({
    assistantId: assistant.id,
    label,
    keys: heartbeatKeys,
    body: (values) => heartbeatPatch(values, assistant),
    update,
  });

export const channelStep = ({
  channelId,
  label,
  updateChannel = assistantApi.updateChannel,
}) => ({
  id: "channel",
  label,
  keys: channelKeys,
  resource: "channel",
  run: ({ values, base, revision }) =>
    updateChannel(channelId, { ...channelPatch({ values, base }), revision }),
});

export const workStep = ({
  assistantId,
  label,
  withTeam,
  save = assistantApi.saveWork,
}) => ({
  id: "work",
  label,
  keys: withTeam ? [...accessKeys, ...teamKeys] : accessKeys,
  run: ({ values, changed, revisions }) =>
    save(assistantId, workBody({ values, changed, revisions, withTeam })),
  revisions: (result) => ({
    ...(result?.access ? { access: result.access.revision } : {}),
    ...(result?.team ? { team: result.team.revision } : {}),
  }),
});

// A new agent has no running service to restart for: that request is reported as is.
export const createStep = ({ label, create = assistantApi.create }) => ({
  id: "create",
  label,
  run: ({ values, confirmations }) =>
    create({ ...createInput(values), ...confirmations }),
  confirmation: (error) => (restartRequired(error) ? null : confirmationRequest(error)),
});

export const memoryStep = ({
  assistantId,
  name,
  file,
  label,
  saveMemory = assistantApi.saveMemory,
}) => ({
  id: "memory",
  label,
  keys: ["content"],
  run: ({ values }) =>
    saveMemory(assistantId, {
      name,
      content: values.content,
      ...(file.missing ? { expectedMissing: true } : { expectedHash: file.hash }),
    }),
});
```

- [ ] **Step 8: Run both unit files**

Run: `node --test tests/unit/agent-settings-fields.test.js tests/unit/agent-settings-steps.test.js`
Expected: PASS (17 tests).

- [ ] **Step 9: Commit**

```bash
npx prettier --write web/features/assistants/settings tests/unit/agent-settings-fields.test.js tests/unit/agent-settings-steps.test.js
npx eslint web/features/assistants/settings tests/unit/agent-settings-fields.test.js tests/unit/agent-settings-steps.test.js
git add web/features/assistants/settings tests/unit/agent-settings-fields.test.js tests/unit/agent-settings-steps.test.js
git commit -m "feat: describe agent settings tabs, drafts and save steps" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Tabbed page frame and the Profil tab

The page gets its tabs, address handling, guard wiring, runtime summary and the complete Profil tab. The other three tabs show the existing standalone sections through a temporary bridge until Tasks 4–8 replace them.

**Files:**

- Create (all in `web/features/assistants/settings/`): `useAgentDraftGuard.js`, `useCount.js`, `ConflictNotice.jsx`, `ConfirmationSheet.jsx`, `SubpageHeader.jsx`, `RuntimeSummary.jsx`, `ProfileFields.jsx`, `ProfileTab.jsx`, `MemberGroup.jsx`, `AgentSettingsPage.jsx`, `LegacySections.jsx`
- Create: `web/features/assistants/agent-settings.css`
- Modify: `web/features/assistants/AgentsPage.jsx` (settings branch, imports)
- Modify: `tests/helpers/assistant-settings-browser.js`; Create: `tests/helpers/agent-settings-page.js`
- Test: `tests/browser/assistant-settings-tabs.spec.js`, `tests/browser/assistant-settings-save.spec.js`

**Interfaces:**

- Consumes: Task 1 `assistantSettingsCopy`; Task 2 `resolveAgentLocation`, `agentRoute`, `staysOnAgentTab`, `profileServer`, `profileStep`; Step 0 `useTabDraft({ server, revisions })`, `useUnsavedChangesGuard({ draft, tab, save, stays })`, `SaveBar({ draft, onSave, onOverwrite, saveLabel, note })`, `Sheet({ open, title, onCancel, className, children })`, `UnsavedChangesSheet(sheetProps)`, `UnderlineTabs({ label, tabs, selected, onSelect, idPrefix })`, `GroupLabel`, `ListCard`, `ListRow`/`unknownValue`, `ReferenceRow({ title, href, onOpen })`, `routePath(route)` (`web/app/routes.js`).
- Produces:
  - `useAgentDraftGuard({ draft, assistantId, tab, page?, label, save }) => sheetProps`
  - `useCount(load, enabled, key) => number | null`
  - `ConflictNotice({ draft, labels })` — `labels` maps draft keys to copy getters
  - `ConfirmationSheet({ confirmation, onShellCancel? })` — renders `draft.confirmation` (`shell`, `fullShell`, `stdio`, `restart`) as a `Sheet`
  - `SubpageHeader({ title, tab, onBack, hint? })` — back button named `assistantSettingsCopy.backTo(tabLabel)`, `h2`, optional ⓘ disclosure
  - `RuntimeSummary({ runtime, navigate, as?, className })`
  - `ProfileFields({ draft, models, modelKey, navigate })` (also used by `AgentCreate` in Task 9)
  - `AgentSettingsPage({ assistant, route, navigate, onBack, openNavigation, navigationOpen, error })`; tab components receive `{ assistant, page, go(tab, page?), navigate }`; tab panel id `agent-settings-tabpanel-<tab>`, tab ids `agent-settings-tab-<tab>`
  - Test helpers: `setupAssistantSettings(page, options)` gains `policies`, `access`, `catalog`, `saveFailures`, `channelFailures`, `mcpServers` options and `state.work`, `state.channelPatches`; exports `connectedChannel(extra)`. `tests/helpers/agent-settings-page.js` exports `agentTab(page, name)`, `saveBar(page, name?)`, `unsavedSheet(page, name?)`, `settingsPath(tab?, subpage?, id?)`, `beforeUnloadPrevented(page)`.

- [ ] **Step 1: Extend the browser fixture**

In `tests/helpers/assistant-settings-browser.js`:

1. After the `home` export add:

```js
export const connectedChannel = (extra = {}) => ({
  id: "telegram",
  assistantId: "home",
  conversationId: "chat",
  username: "bot",
  enabled: true,
  hasSecret: true,
  chatId: "42",
  language: "en",
  appUrl: null,
  revision: 1,
  inputs: [],
  notifications: [],
  ...extra,
});
```

2. In the `state` object add (after `opened: 0,`):

```js
    policies: options.policies || {
      home: { revision: 1, autonomous: false, maxMembers: 4, runTimeoutMinutes: 30 },
    },
    access: options.access || { revision: 0 },
    catalog: options.catalog || { projects: [], pipelines: [] },
    saveFailures: [...(options.saveFailures || [])],
    channelFailures: [...(options.channelFailures || [])],
    work: [],
    channelPatches: [],
```

3. Directly before `await page.route(/\/api\/assistant/, …)` add:

```js
if (options.mcpServers)
  await page.route("**/api/mcp-servers", (route) =>
    route.fulfill({ json: options.mcpServers }),
  );
```

4. In the `PATCH /api/assistants/home` branch, directly after `state.updates.push(body);` add:

```js
const failure = state.saveFailures.shift();
if (failure)
  return route.fulfill({
    status: failure.status,
    json: {
      error: failure.error,
      ...(failure.messageKey ? { messageKey: failure.messageKey } : {}),
    },
  });
```

5. In the `/api/assistants` list response add `policies: state.policies,` next to `conversations`.

6. Replace the `/api/assistants/home/access` and `/api/assistant-workspace-catalog` branches with:

```js
if (path === "/api/assistants/home/access") return route.fulfill({ json: state.access });
if (path === "/api/assistant-workspace-catalog")
  return route.fulfill({ json: state.catalog });
if (path === "/api/assistants/home/work" && method === "PUT") {
  const body = route.request().postDataJSON();
  state.work.push(body);
  if (body.access)
    state.access = {
      ...state.access,
      ...body.access,
      revision: state.access.revision + 1,
    };
  const team = state.policies.home;
  if (body.team)
    state.policies.home = { ...team, ...body.team, revision: team.revision + 1 };
  return route.fulfill({ json: { access: state.access, team: state.policies.home } });
}
if (/^\/api\/assistant-channels\/[^/]+$/.test(path) && method === "PATCH") {
  const body = route.request().postDataJSON();
  state.channelPatches.push(body);
  const failure = state.channelFailures.shift();
  if (failure)
    return route.fulfill({ status: failure.status, json: { error: failure.error } });
  if (body.revision !== state.channel.revision)
    return route.fulfill({
      status: 409,
      json: { error: "Revision conflict", messageKey: "assistants.conflict" },
    });
  const { revision: _revision, ...fields } = body;
  state.channel = { ...state.channel, ...fields, revision: state.channel.revision + 1 };
  return route.fulfill({ json: state.channel });
}
```

Create `tests/helpers/agent-settings-page.js`:

```js
// Locators for the tabbed agent settings page (settings pattern).
export const agentTab = (page, name) => page.getByRole("tab", { name, exact: true });
export const saveBar = (page, name = "Unsaved changes") =>
  page.getByRole("region", { name });
export const unsavedSheet = (page, name = "Save changes?") =>
  page.getByRole("dialog", { name });
export function settingsPath(tab, subpage, id = "home") {
  const query = new URLSearchParams();
  if (tab) query.set("tab", tab);
  if (subpage) query.set("page", subpage);
  const search = query.toString();
  return `/agents/${id}/settings${search ? `?${search}` : ""}`;
}
// What a real unload would do: the page holds the warning while a draft is dirty.
export const beforeUnloadPrevented = (page) =>
  page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
```

- [ ] **Step 2: Write the failing browser specs**

Create `tests/browser/assistant-settings-tabs.spec.js`:

```js
import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import {
  home,
  setupAssistantSettings as setup,
} from "../helpers/assistant-settings-browser.js";
import {
  agentTab,
  beforeUnloadPrevented,
  saveBar,
  settingsPath,
  unsavedSheet,
} from "../helpers/agent-settings-page.js";

const name = (page) => page.getByRole("textbox", { name: "Name", exact: true });

test("deep links select their tab and junk falls back to the profile", async ({
  page,
}) => {
  await setup(page);
  await page.goto(baseURL + settingsPath("work"));
  await expect(agentTab(page, "Work")).toHaveAttribute("aria-selected", "true");
  await page.goto(baseURL + settingsPath("nope"));
  await expect(page).toHaveURL(/\/agents\/home\/settings$/);
  await expect(agentTab(page, "Profile")).toHaveAttribute("aria-selected", "true");
  await agentTab(page, "Telegram").click();
  await expect(page).toHaveURL(/\/agents\/home\/settings\?tab=telegram$/);
});

test("a task-bound member has two tabs and other tabs normalise without asking", async ({
  page,
}) => {
  await setup(page, { assistants: [home({ teamMemberId: "m1", lifetime: "task" })] });
  await page.goto(baseURL + settingsPath("telegram"));
  await expect(page).toHaveURL(/\/agents\/home\/settings$/);
  await expect(page.getByRole("tab")).toHaveText(["Profile", "Capabilities"]);
  await expect(unsavedSheet(page)).toHaveCount(0);
});

test("switching tabs with unsaved changes asks first", async ({ page }) => {
  const state = await setup(page, { applyUpdates: true });
  await page.goto(baseURL + settingsPath());
  await name(page).fill("Home 2");
  await expect(saveBar(page)).toBeVisible();
  await agentTab(page, "Capabilities").click();
  const sheet = unsavedSheet(page);
  await expect(sheet).toContainText("1 change in Profile is not saved yet.");
  await sheet.getByRole("button", { name: "Cancel" }).click();
  await expect(sheet).toHaveCount(0);
  await expect(page).toHaveURL(/\/agents\/home\/settings$/);
  await expect(name(page)).toHaveValue("Home 2");
  await agentTab(page, "Capabilities").click();
  await unsavedSheet(page).getByRole("button", { name: "Discard" }).click();
  await expect(page).toHaveURL(/tab=capabilities$/);
  expect(state.updates).toEqual([]);
  await agentTab(page, "Profile").click();
  await expect(name(page)).toHaveValue("Home");
  await name(page).fill("Home 3");
  await agentTab(page, "Work").click();
  await unsavedSheet(page).getByRole("button", { name: "Save and switch" }).click();
  await expect(page).toHaveURL(/tab=work$/);
  await expect.poll(() => state.updates.at(-1)?.name).toBe("Home 3");
});

test("going back to the conversation with unsaved changes asks first", async ({
  page,
}) => {
  await setup(page);
  await page.goto(baseURL + settingsPath());
  await name(page).fill("Home 2");
  await page.getByRole("button", { name: "Back to conversation" }).click();
  await unsavedSheet(page).getByRole("button", { name: "Cancel" }).click();
  await expect(page).toHaveURL(/\/agents\/home\/settings$/);
  await expect(name(page)).toHaveValue("Home 2");
  await page.getByRole("button", { name: "Back to conversation" }).click();
  await unsavedSheet(page).getByRole("button", { name: "Discard" }).click();
  await expect(page).toHaveURL(/\/agents\/home\/chats\/c1$/);
});

test("browser back asks first and cancelling keeps the address", async ({ page }) => {
  await setup(page);
  await page.goto(baseURL + settingsPath());
  await agentTab(page, "Work").click();
  await agentTab(page, "Profile").click();
  await name(page).fill("Home 2");
  await page.goBack();
  await unsavedSheet(page).getByRole("button", { name: "Cancel" }).click();
  await expect(page).toHaveURL(/\/agents\/home\/settings$/);
  await expect(name(page)).toHaveValue("Home 2");
});

test("an unsaved tab warns before the page unloads until it is reset", async ({
  page,
}) => {
  await setup(page);
  await page.goto(baseURL + settingsPath());
  expect(await beforeUnloadPrevented(page)).toBe(false);
  await name(page).fill("Home 2");
  await expect.poll(() => beforeUnloadPrevented(page)).toBe(true);
  await saveBar(page).getByRole("button", { name: "Cancel" }).click();
  await expect(name(page)).toHaveValue("Home");
  await expect.poll(() => beforeUnloadPrevented(page)).toBe(false);
});
```

Create `tests/browser/assistant-settings-save.spec.js`:

```js
import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import {
  emitChange as change,
  home,
  setupAssistantSettings as setup,
} from "../helpers/assistant-settings-browser.js";
import { saveBar, settingsPath } from "../helpers/agent-settings-page.js";

const conflict = {
  status: 409,
  error: "Revision conflict",
  messageKey: "assistants.conflict",
};
const name = (page) => page.getByRole("textbox", { name: "Name", exact: true });

test("a profile changed elsewhere can be reloaded", async ({ page }) => {
  const state = await setup(page, { saveFailures: [conflict] });
  await page.goto(baseURL + settingsPath());
  await name(page).fill("Mine");
  await saveBar(page).getByRole("button", { name: "Save agent" }).click();
  await expect(saveBar(page).getByRole("alert")).toContainText(
    "Changed elsewhere in the meantime.",
  );
  expect(state.updates[0]).toMatchObject({ name: "Mine", revision: 1 });
  await saveBar(page).getByRole("button", { name: "Reload", exact: true }).click();
  await expect(name(page)).toHaveValue("Home");
  await expect(saveBar(page)).toHaveCount(0);
});

test("a profile changed elsewhere can be overwritten with the newer revision", async ({
  page,
}) => {
  const state = await setup(page, { saveFailures: [conflict], applyUpdates: true });
  await page.goto(baseURL + settingsPath());
  await name(page).fill("Mine");
  await saveBar(page).getByRole("button", { name: "Save agent" }).click();
  await expect(
    saveBar(page).getByRole("button", { name: "Overwrite anyway" }),
  ).toBeVisible();
  state.assistants = [home({ revision: 4, instructions: "Theirs" })];
  await change(page);
  await expect(page.getByRole("textbox", { name: "Instructions" })).toHaveValue("Theirs");
  await saveBar(page).getByRole("button", { name: "Overwrite anyway" }).click();
  await expect.poll(() => state.updates.length).toBe(2);
  expect(state.updates[1]).toMatchObject({
    name: "Mine",
    instructions: "Theirs",
    revision: 4,
  });
  await expect(saveBar(page)).toHaveCount(0);
});

test("the profile bar shows the apply note and saves name, instructions and model", async ({
  page,
}) => {
  const state = await setup(page, { applyUpdates: true });
  await page.goto(baseURL + settingsPath());
  await expect(saveBar(page)).toHaveCount(0);
  await name(page).fill("Home 2");
  await expect(saveBar(page)).toContainText("Applies before the next message.");
  await saveBar(page).getByRole("button", { name: "Save agent" }).click();
  await expect.poll(() => state.updates.length).toBe(1);
  expect(state.updates[0]).toEqual({
    name: "Home 2",
    instructions: "Plan meals",
    model: { connectionId: "router", modelId: "model" },
    revision: 1,
  });
  await expect(saveBar(page)).toHaveCount(0);
});
```

- [ ] **Step 3: Run them to make sure they fail**

Run: `npm run build && npx playwright test tests/browser/assistant-settings-tabs.spec.js tests/browser/assistant-settings-save.spec.js`
Expected: FAIL — no `tab` roles on the settings page yet ("locator.click: … getByRole('tab', { name: 'Telegram' })" times out).

- [ ] **Step 4: Add the shared pieces**

`web/features/assistants/settings/useAgentDraftGuard.js`:

```js
import useUnsavedChangesGuard from "../../../lib/settings/useUnsavedChangesGuard.js";
import { staysOnAgentTab } from "./agent-settings-fields.js";

/** The unsaved-changes guard of one agent tab (or one subpage with its own draft). */
export default function useAgentDraftGuard({
  draft,
  assistantId,
  tab,
  page,
  label,
  save,
}) {
  return useUnsavedChangesGuard({
    draft,
    tab: label,
    save,
    stays: staysOnAgentTab(assistantId, tab, page),
  });
}
```

`web/features/assistants/settings/useCount.js`:

```js
import { useEffect, useState } from "react";

/** A row count loaded on demand; null ("—") until it is known or when loading failed. */
export default function useCount(load, enabled, key) {
  const [count, setCount] = useState(null);
  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    load().then(
      (value) => live && setCount(Number.isInteger(value) ? value : null),
      () => live && setCount(null),
    );
    return () => {
      live = false;
    };
    // `key` identifies what is counted; `load` is a new function every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, key]);
  return enabled ? count : null;
}
```

`web/features/assistants/settings/ConflictNotice.jsx`:

```jsx
import React from "react";
import { assistantCopy as copy } from "../../../lib/i18n/messages/assistants.js";

// Fields edited here and changed on the server: the edit is kept until reloaded.
export default function ConflictNotice({ draft, labels }) {
  if (!draft.conflicts.length) return null;
  return (
    <p role="status" className="assistant-notice">
      {copy.remoteChanged(
        draft.conflicts.map((key) => labels[key]?.() ?? key).join(", "),
      )}{" "}
      <button type="button" className="button secondary" onClick={draft.reload}>
        {copy.reloadLatest}
      </button>
    </p>
  );
}
```

`web/features/assistants/settings/ConfirmationSheet.jsx`:

```jsx
import React from "react";
import Sheet from "../../../components/Sheet.jsx";
import { assistantCopy } from "../../../lib/i18n/messages/assistants.js";
import { assistantShellCopy as shell } from "../../../lib/i18n/messages/assistant-shell.js";
import { mcpServerCopy as mcp } from "../../../lib/i18n/messages/mcp-servers.js";

function texts({ kind, data }) {
  if (kind === "fullShell")
    return [shell.fullTitle, [shell.fullBody], shell.confirmFull, shell.cancel];
  if (kind === "shell")
    return [shell.confirmTitle, [shell.warning], shell.confirm, shell.cancel];
  if (kind === "stdio")
    return [
      mcp.stdioBindingTitle,
      [mcp.stdioBindingWarning],
      mcp.stdioBindingConfirm,
      mcp.cancel,
    ];
  const copy = assistantCopy.personal;
  const names = (data?.affected?.agents || []).map((agent) => agent.name).join(", ");
  return [
    copy.restartTitle,
    [copy.restartBody, copy.restartAffected(names, data?.affected?.teamMembers)],
    copy.restartConfirm,
    copy.restartCancel,
  ];
}

/** A save-chain confirmation (shell, full shell, stdio, restart) as a sheet. */
export default function ConfirmationSheet({ confirmation, onShellCancel }) {
  if (!confirmation) return null;
  const [title, body, confirm, cancelLabel] = texts(confirmation);
  const cancel = () => {
    confirmation.cancel();
    if (confirmation.kind === "shell" || confirmation.kind === "fullShell")
      onShellCancel?.();
  };
  return (
    <Sheet open title={title} onCancel={cancel} className="agent-confirmation-sheet">
      <div className="sheet-body">
        {body.map((text) => (
          <p key={text}>{text}</p>
        ))}
      </div>
      <div className="sheet-actions">
        <button type="button" className="button primary" onClick={confirmation.confirm}>
          {confirm}
        </button>
        <button type="button" className="button secondary" onClick={cancel}>
          {cancelLabel}
        </button>
      </div>
    </Sheet>
  );
}
```

`web/features/assistants/settings/SubpageHeader.jsx`:

```jsx
import React from "react";
import Icon from "../../../components/Icon.jsx";
import {
  InfoHintButton,
  InfoHintText,
  useInfoHint,
} from "../../../components/InfoHint.jsx";
import { assistantSettingsCopy as copy } from "../../../lib/i18n/messages/assistant-settings.js";

// A subpage inside a tab: back to the tab's list, the subpage title and an optional ⓘ.
export default function SubpageHeader({ title, tab, onBack, hint }) {
  const info = useInfoHint();
  return (
    <>
      <div className="agent-subpage-header">
        <button
          type="button"
          className="agent-subpage-back"
          aria-label={copy.backTo(copy.tabs[tab])}
          onClick={onBack}
        >
          <Icon name="back" />
        </button>
        <h2>{title}</h2>
        {hint && <InfoHintButton hint={info} />}
      </div>
      {hint && <InfoHintText hint={info}>{hint}</InfoHintText>}
    </>
  );
}
```

`web/features/assistants/settings/RuntimeSummary.jsx`:

```jsx
import React, { useId } from "react";
import GroupLabel from "../../../components/GroupLabel.jsx";
import ListCard from "../../../components/ListCard.jsx";
import ListRow, { unknownValue } from "../../../components/ListRow.jsx";
import { routePath } from "../../../app/routes.js";
import { assistantCopy as copy } from "../../../lib/i18n/messages/assistants.js";

// The agent service at a glance: a right column on wide screens, a Profile group otherwise.
export default function RuntimeSummary({
  runtime,
  navigate,
  as: Tag = "section",
  className,
}) {
  const id = useId();
  const settings = { view: "settings", settingsSection: "assistants" };
  const diagnostic = copy.runtimeDiagnostics[runtime.diagnostic];
  return (
    <Tag className={`agent-runtime ${className}`} aria-labelledby={id}>
      <GroupLabel id={id} hint={copy.runtimeDescription}>
        {copy.runtime}
      </GroupLabel>
      {diagnostic && (
        <p role="status" className="assistant-notice">
          {diagnostic}
        </p>
      )}
      <ListCard labelledBy={id}>
        <ListRow
          label={copy.serviceState}
          value={copy.status[runtime.availability] ?? unknownValue}
        />
        <ListRow
          label={copy.syncState}
          value={copy.status[runtime.sync] ?? unknownValue}
        />
        <ListRow
          label={copy.runtimeLink}
          href={routePath(settings)}
          onClick={() => navigate(settings)}
        />
      </ListCard>
    </Tag>
  );
}
```

- [ ] **Step 5: Add the Profil tab**

`web/features/assistants/settings/ProfileFields.jsx`:

```jsx
import React from "react";
import ReferenceRow from "../../../components/ReferenceRow.jsx";
import { routePath } from "../../../app/routes.js";
import { assistantCopy as copy } from "../../../lib/i18n/messages/assistants.js";
import AssistantModelFields from "../AssistantModelFields.jsx";

/** Name, instructions and model of an agent draft (Profile tab and create mode). */
export default function ProfileFields({ draft, models, modelKey, navigate }) {
  const { name, instructions, connectionId, modelId } = draft.values;
  const accounts = { view: "accounts", section: "models" };
  return (
    <>
      <div className="list-card agent-fields">
        <label className="agent-field">
          {copy.name}
          <input
            required
            maxLength={100}
            value={name}
            onChange={(event) => draft.set("name", event.target.value)}
          />
        </label>
        <label className="agent-field">
          {copy.instructions}
          <textarea
            rows={7}
            maxLength={65536}
            value={instructions}
            onChange={(event) => draft.set("instructions", event.target.value)}
          />
        </label>
        <div className="agent-field">
          <AssistantModelFields
            key={modelKey}
            models={models}
            connectionId={connectionId}
            modelId={modelId}
            setConnection={(value) => draft.set("connectionId", value)}
            setModel={(value) => draft.set("modelId", value)}
          />
        </div>
      </div>
      {!models.some((model) => model.available) && (
        <p className="assistant-note">{copy.noConnections}</p>
      )}
      <ReferenceRow
        title={copy.connections}
        href={routePath(accounts)}
        onOpen={() => navigate(accounts)}
      />
    </>
  );
}
```

`web/features/assistants/settings/MemberGroup.jsx` (the member card of `AssistantMemberSettings.jsx`, unchanged texts and actions; `TemporaryMcpServers` moves to Capabilities in Task 4):

```jsx
import React, { useId, useState } from "react";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import GroupLabel from "../../../components/GroupLabel.jsx";
import { assistantCopy as copy } from "../../../lib/i18n/messages/assistants.js";
import useAssistants from "../useAssistants.js";
import { assistantApi } from "../assistant-api.js";

/** Provenance, assignment, phase and lifecycle actions of a team member. */
export default function MemberGroup({ assistant }) {
  const { members = [], assistants, refresh } = useAssistants();
  const member = members.find((m) => m.assistantId === assistant.id);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const id = useId();
  if (!member) return null;
  const parent = assistants.find((a) => a.id === member.parentAssistantId),
    active = !["completed", "failed", "cancelled"].includes(member.phase);
  async function action(name) {
    setBusy(true);
    try {
      if (name === "recover")
        await assistantApi.recoverTeamMember(member.id, member.revision);
      else
        await assistantApi.teamAction(
          "team-members",
          member.id,
          name,
          name === "stop" ? undefined : member.revision,
        );
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="agent-member" aria-labelledby={id}>
      <GroupLabel id={id}>{copy.team.memberSettings}</GroupLabel>
      <ErrorMessage error={error} />
      <div className="list-card agent-member-card">
        <p>{copy.team.inherited(parent?.name || copy.title, member.inheritedRevision)}</p>
        <p>
          {member.lifetime === "permanent" ? copy.team.permanent : copy.team.taskBound}
        </p>
        <p className="assistant-note">{copy.team.independent}</p>
        {member.overrides && (
          <div className="assistant-member-provenance">
            <p>
              {member.overrides.model ? copy.team.modelChanged : copy.team.modelOriginal}
            </p>
            <p>
              {member.overrides.instructions
                ? copy.team.instructionsChanged
                : copy.team.instructionsOriginal}
            </p>
          </div>
        )}
        <p>{member.assignment}</p>
        <p>{copy.team.states[member.phase]}</p>
        {member.phase === "provisioning_uncertain" && (
          <div className="assistant-notice">
            <p>{copy.team.setupUnknown}</p>
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() => action("recover")}
            >
              {copy.recover}
            </button>
          </div>
        )}
        <div className="assistant-actions">
          {active ? (
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => action("stop")}
            >
              {copy.team.stopMember}
            </button>
          ) : (
            <>
              {member.lifetime !== "permanent" && (
                <button
                  className="button primary"
                  disabled={busy}
                  onClick={() => action("promote")}
                >
                  {copy.team.promote}
                </button>
              )}
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => action(member.archivedAt ? "restore" : "archive")}
              >
                {member.archivedAt ? copy.team.restore : copy.team.archive}
              </button>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
```

`web/features/assistants/settings/ProfileTab.jsx`:

```jsx
import React, { useState } from "react";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import SaveBar from "../../../components/SaveBar.jsx";
import UnsavedChangesSheet from "../../../components/UnsavedChangesSheet.jsx";
import useTabDraft from "../../../lib/settings/useTabDraft.js";
import { assistantCopy as copy } from "../../../lib/i18n/messages/assistants.js";
import { assistantSettingsCopy as settingsCopy } from "../../../lib/i18n/messages/assistant-settings.js";
import useAssistants from "../useAssistants.js";
import { assistantApi } from "../assistant-api.js";
import { profileServer } from "./agent-settings-fields.js";
import { profileStep } from "./agent-settings-steps.js";
import useAgentDraftGuard from "./useAgentDraftGuard.js";
import ConflictNotice from "./ConflictNotice.jsx";
import ConfirmationSheet from "./ConfirmationSheet.jsx";
import ProfileFields from "./ProfileFields.jsx";
import MemberGroup from "./MemberGroup.jsx";
import RuntimeSummary from "./RuntimeSummary.jsx";

const conflictLabels = {
  name: () => copy.name,
  instructions: () => copy.instructions,
  connectionId: () => copy.connection,
  modelId: () => copy.model,
};

/** Profile: name, instructions, model; team member card; one PATCH per save. */
export default function ProfileTab({ assistant, navigate }) {
  const { models, refresh, runtime } = useAssistants();
  const draft = useTabDraft({
    server: profileServer(assistant),
    revisions: { assistant: assistant.revision },
  });
  const label = settingsCopy.tabs.profile;
  const steps = [profileStep({ assistantId: assistant.id, label })];
  const after = async (result) => {
    if (result.status === "saved") await refresh();
    return result;
  };
  const save = async () => after(await draft.save(steps));
  const overwrite = async () => after(await draft.overwrite(steps));
  const sheet = useAgentDraftGuard({
    draft,
    assistantId: assistant.id,
    tab: "profile",
    label,
    save,
  });
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function confirmInstructions() {
    setBusy(true);
    setError("");
    try {
      await assistantApi.update(assistant.id, {
        confirmInstructions: true,
        revision: assistant.revision,
      });
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <form
        id="agent-profile"
        className="agent-settings-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (draft.dirty) save();
        }}
      >
        <ErrorMessage error={error} />
        <ConflictNotice draft={draft} labels={conflictLabels} />
        {assistant.instructionsSource === "model" && (
          <p className="assistant-note agent-review-strip" role="note">
            {copy.generatedInstructions}{" "}
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={confirmInstructions}
            >
              {copy.confirmInstructions}
            </button>
          </p>
        )}
        <ProfileFields
          draft={draft}
          models={models}
          modelKey={assistant.id}
          navigate={navigate}
        />
        <p className="agent-revision">
          {copy.revisions(assistant.revision, assistant.effectiveRevision)}
          <br />
          {copy.pendingConfig}
        </p>
      </form>
      {assistant.teamMemberId && <MemberGroup assistant={assistant} />}
      <RuntimeSummary
        className="agent-runtime-group"
        runtime={runtime}
        navigate={navigate}
      />
      <SaveBar
        draft={draft}
        onSave={save}
        onOverwrite={overwrite}
        saveLabel={copy.save}
        note={copy.pendingConfigShort}
      />
      <ConfirmationSheet confirmation={draft.confirmation} />
      <UnsavedChangesSheet {...sheet} />
    </>
  );
}
```

- [ ] **Step 6: Add the page, the temporary bridge and the styles**

`web/features/assistants/settings/LegacySections.jsx`:

```jsx
import React from "react";
import AgentMcpServers from "../../mcp-servers/AgentMcpServers.jsx";
import AssistantMemory from "../AssistantMemory.jsx";
import AssistantWorkflows from "../AssistantWorkflows.jsx";
import AssistantTeamSettings from "../AssistantTeamSettings.jsx";
import AssistantReminders from "../AssistantReminders.jsx";
import AssistantRoutines from "../AssistantRoutines.jsx";
import TelegramSettings from "../TelegramSettings.jsx";
import useAssistants from "../useAssistants.js";

// Bridge for tabs that still use their standalone sections; removed once every tab
// uses the settings pattern.
export default function LegacySections({ assistant, navigate, tab }) {
  const { refresh } = useAssistants();
  if (tab === "capabilities")
    return (
      <>
        {Array.isArray(assistant.mcpServers) && (
          <AgentMcpServers assistant={assistant} refresh={refresh} navigate={navigate} />
        )}
        {assistant.capabilities?.memory && <AssistantMemory assistantId={assistant.id} />}
      </>
    );
  if (tab === "work")
    return (
      <>
        <AssistantWorkflows assistantId={assistant.id} />
        {!assistant.teamMemberId && <AssistantTeamSettings assistantId={assistant.id} />}
      </>
    );
  return (
    <>
      <TelegramSettings assistantId={assistant.id} navigate={navigate} />
      {assistant.capabilities?.reminders && (
        <>
          <AssistantReminders assistantId={assistant.id} />
          <AssistantRoutines assistantId={assistant.id} />
        </>
      )}
    </>
  );
}
```

`web/features/assistants/settings/AgentSettingsPage.jsx`:

```jsx
import React, { useEffect } from "react";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import UnderlineTabs from "../../../components/UnderlineTabs.jsx";
import { assistantSettingsCopy as copy } from "../../../lib/i18n/messages/assistant-settings.js";
import AssistantHeader from "../AssistantHeader.jsx";
import useAssistants from "../useAssistants.js";
import { agentRoute, resolveAgentLocation } from "./agent-settings-fields.js";
import ProfileTab from "./ProfileTab.jsx";
import LegacySections from "./LegacySections.jsx";
import RuntimeSummary from "./RuntimeSummary.jsx";
import "../agent-settings.css";

const panels = { profile: ProfileTab };

/**
 * Agent settings as tabs (handoff 1b/3b): one draft and save bar per tab, subpages
 * inside their tab, all addressed by `agentTab`/`agentPage` so every switch passes
 * the unsaved-changes guard.
 */
export default function AgentSettingsPage({
  assistant,
  route,
  navigate,
  onBack,
  openNavigation,
  navigationOpen,
  error,
}) {
  const { runtime } = useAssistants();
  const { tab, page, tabs, normalized } = resolveAgentLocation(assistant, route);
  useEffect(() => {
    if (normalized) navigate(agentRoute(assistant.id, tab, page), true, true);
  }, [normalized, assistant.id, tab, page, navigate]);
  const go = (nextTab, nextPage = "") =>
    navigate(agentRoute(assistant.id, nextTab, nextPage));
  const Panel = panels[tab];
  const props = { assistant, page, go, navigate };
  return (
    <section className="assistant-detail assistant-settings-page agent-settings">
      <AssistantHeader
        assistant={assistant}
        variant="settings"
        navigate={navigate}
        onBack={onBack}
        openNavigation={openNavigation}
        navigationOpen={navigationOpen}
      />
      <div className="agent-settings-tabs">
        <UnderlineTabs
          label={copy.tabsLabel}
          idPrefix="agent-settings"
          tabs={tabs.map((id) => ({ id, label: copy.tabs[id] }))}
          selected={tab}
          onSelect={(id) => {
            if (id !== tab || page) go(id);
          }}
        />
      </div>
      <div className="assistant-settings-scroll">
        <ErrorMessage error={error} />
        <div className="agent-settings-layout">
          <div
            className="agent-settings-main"
            role="tabpanel"
            id={`agent-settings-tabpanel-${tab}`}
            aria-labelledby={`agent-settings-tab-${tab}`}
          >
            {Panel ? (
              <Panel key={assistant.id} {...props} />
            ) : (
              <LegacySections key={assistant.id} tab={tab} {...props} />
            )}
          </div>
          <RuntimeSummary
            as="aside"
            className="agent-runtime-aside"
            runtime={runtime}
            navigate={navigate}
          />
        </div>
      </div>
    </section>
  );
}
```

Create `web/features/assistants/agent-settings.css`:

```css
/* Agent settings tabs (settings pattern, docs/settings-pattern.md). Theme variables only. */
.agent-settings-tabs {
  padding: 0 24px;
  border-bottom: 1px solid var(--header-line);
  background: var(--header-bg);
}
.agent-settings-layout {
  display: grid;
  grid-template-columns: minmax(0, 720px) 270px;
  gap: 24px;
  align-items: start;
  justify-content: center;
}
.agent-settings-main {
  min-width: 0;
}
.agent-runtime-aside {
  position: sticky;
  top: 0;
}
.agent-runtime-group {
  display: none;
}
@media (max-width: 1099px) {
  .agent-settings-layout {
    grid-template-columns: minmax(0, 720px);
  }
  .agent-runtime-aside {
    display: none;
  }
  .agent-runtime-group {
    display: block;
  }
}
.agent-fields {
  display: grid;
}
.agent-field {
  display: grid;
  gap: 6px;
  padding: 12px 14px;
  background: var(--panel);
  color: var(--muted);
  font-size: 13px;
}
.agent-field :is(input, textarea, select) {
  color: var(--text);
  font-size: 16px;
}
.agent-revision {
  margin: 10px 4px 0;
  color: var(--text-faint);
  font-size: 12px;
}
.agent-review-strip {
  margin: 12px 0 0;
  padding: 10px 14px;
  border: 1px solid var(--accent-line);
  border-radius: 12px;
  background: var(--surface-accent);
}
.agent-subpage-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 12px 0 4px;
}
.agent-subpage-header h2 {
  font-size: 17px;
  font-weight: 600;
}
.agent-subpage-back {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: 10px;
  color: var(--text);
}
.agent-row-note,
.agent-detail,
.agent-empty,
.agent-member-card,
.agent-pairing {
  display: grid;
  gap: 8px;
  padding: 10px 14px 12px;
  background: var(--panel);
  color: var(--muted);
  font-size: 13px;
  line-height: 1.5;
}
.agent-shell-levels {
  padding: 8px 12px;
}
.agent-shell-levels .segmented {
  width: 100%;
}
.agent-pending-strip {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  min-height: 48px;
  margin-top: 12px;
  padding: 0 14px;
  border: 1px solid var(--accent-line);
  border-radius: 12px;
  background: var(--surface-accent);
  color: var(--accent-text);
  font-size: 14px;
  font-weight: 600;
}
.agent-create {
  display: grid;
  gap: 4px;
  margin-top: 16px;
}
@media (max-width: 700px) {
  .agent-settings-tabs {
    padding: 0;
  }
  .agent-settings-layout {
    padding: 0 12px;
  }
  /* Selects shrink their text box below the 16px line; one size keeps them like inputs. */
  .agent-field :is(input:not([type="checkbox"], [type="radio"]), select) {
    height: 47px;
    line-height: 21px;
  }
  .agent-field select {
    appearance: none;
    padding-right: 40px;
    background-image: var(--select-chevron);
    background-repeat: no-repeat;
    background-position: right 12px center;
    background-size: 16px 16px;
  }
}
```

- [ ] **Step 7: Use the page in `AgentsPage.jsx`**

In `web/features/assistants/AgentsPage.jsx`: remove the `import AssistantHeader from "./AssistantHeader.jsx";` line, remove `runtime,` from the `useAssistants()` destructuring (its only user was the old runtime aside; ESLint `no-unused-vars` fails otherwise — `RuntimeSummary` reads it itself), add `import AgentSettingsPage from "./settings/AgentSettingsPage.jsx";`, and replace the whole `if (route.agentSettings && assistant) return ( <section className="assistant-detail assistant-settings-page"> … </section> );` block with:

```jsx
if (route.agentSettings && assistant)
  return (
    <AgentSettingsPage
      key={assistant.id}
      assistant={assistant}
      route={route}
      navigate={navigate}
      onBack={() => back(assistant)}
      openNavigation={openNavigation}
      navigationOpen={navigationOpen}
      error={error || loadError}
    />
  );
```

The create branch (`creating && <AssistantSettings … />`) stays until Task 9.

- [ ] **Step 8: Run the new specs**

Run: `npm run build && npx playwright test tests/browser/assistant-settings-tabs.spec.js tests/browser/assistant-settings-save.spec.js`
Expected: PASS (6 + 3 tests).

- [ ] **Step 9: Commit**

```bash
npx prettier --write web/features/assistants/settings web/features/assistants/agent-settings.css web/features/assistants/AgentsPage.jsx tests/helpers/assistant-settings-browser.js tests/helpers/agent-settings-page.js tests/browser/assistant-settings-tabs.spec.js tests/browser/assistant-settings-save.spec.js
npx eslint web/features/assistants tests/helpers tests/browser/assistant-settings-tabs.spec.js tests/browser/assistant-settings-save.spec.js
git add web/features/assistants tests/helpers/assistant-settings-browser.js tests/helpers/agent-settings-page.js tests/browser/assistant-settings-tabs.spec.js tests/browser/assistant-settings-save.spec.js
git commit -m "feat: show agent settings as tabs with a guarded profile draft" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Fähigkeiten tab

Memory, web and shell switches plus MCP bindings in one draft and one `PATCH`; shell, full-shell, stdio and restart confirmations as sheets; read-only MCP servers for task-bound members.

**Files:**

- Create: `web/features/assistants/settings/CapabilityGroups.jsx`, `web/features/assistants/settings/McpGroup.jsx`, `web/features/assistants/settings/CapabilitiesTab.jsx`
- Modify: `web/features/assistants/settings/AgentSettingsPage.jsx` (`panels`), `web/features/assistants/settings/LegacySections.jsx` (drop the capabilities branch; memory notes return as a subpage in Task 5)
- Test: `tests/browser/assistant-settings-save.spec.js`, `tests/browser/assistant-settings-tabs.spec.js`

**Interfaces:**

- Consumes: Task 2 `capabilityServer`, `capabilityStep`, `webCapabilityKeys`, `toggleId`, `isPersonal`, `agentRoute`; Task 3 `useAgentDraftGuard`, `useCount`, `ConflictNotice`, `ConfirmationSheet`; Step 0 `ToggleRow`, `CheckboxRow`, `ListRow`, `ListCard`, `GroupLabel`, `Segmented`, `useInfoHint`/`InfoHintButton`/`InfoHintText`, `ReferenceRow`; `McpOAuthStatus` + `oauthStatusOf` + `usesOAuth` (`web/features/mcp-servers/McpOAuthStatus.jsx`); `TemporaryMcpServers`.
- Produces:
  - `MemoryGroup({ assistant?, draft, go? })`, `WebGroup({ draft, browser, creating?, navigate? })`, `ShellGroup({ assistant?, draft, go?, creating? })` (named exports of `CapabilityGroups.jsx`, reused by `AgentCreate` in Task 9). Group sections are regions named by their heading; the shell section keeps `id="agent-shell"`.
  - `McpGroup({ assistant, draft, notice, reloadKey, navigate })` — region "MCP servers", `id="agent-mcp"`; reads the server list again when `assistant.revision` or `reloadKey` changes.
  - `CapabilitiesTab({ assistant, page, go, navigate })` — renders `MemoryPage`/`AllowlistPage` for `page` from Task 5 (until then the main view).

- [ ] **Step 1: Write the failing browser tests**

Append to `tests/browser/assistant-settings-save.spec.js`:

```js
test("the Capabilities tab saves switches and MCP servers in one request", async ({
  page,
}) => {
  const state = await setup(page, {
    applyUpdates: true,
    assistant: { mcpServers: [] },
    mcpServers: [{ id: "docs", name: "docs", transport: "http" }],
  });
  await page.goto(baseURL + settingsPath("capabilities"));
  await page.getByRole("switch", { name: "Remember information" }).check();
  await page.getByLabel("docs").check();
  await expect(saveBar(page)).toBeVisible();
  await saveBar(page).getByRole("button", { name: "Save agent" }).click();
  await expect.poll(() => state.updates.length).toBe(1);
  expect(state.updates[0]).toMatchObject({
    revision: 1,
    capabilities: { memory: true },
    mcpServers: ["docs"],
  });
  expect(state.updates[0]).not.toHaveProperty("shell");
  await expect(
    page.getByRole("region", { name: "MCP servers" }).getByRole("status"),
  ).toHaveText("MCP servers saved.");
  await expect(saveBar(page)).toHaveCount(0);
});

test("a task-bound member sees granted MCP servers read-only and the shell reason", async ({
  page,
}) => {
  await setup(page, {
    assistants: [home({ teamMemberId: "m1", lifetime: "task", shell: "approval" })],
  });
  await page.goto(baseURL + settingsPath("capabilities"));
  await expect(page.locator("#agent-shell")).toContainText(
    "Task-bound team members never get shell access.",
  );
  await expect(page.getByRole("switch", { name: "Remember information" })).toHaveCount(0);
  await expect(saveBar(page)).toHaveCount(0);
});
```

Append to `tests/browser/assistant-settings-tabs.spec.js`:

```js
test("hints sit behind an info disclosure; the shell warning never does", async ({
  page,
}) => {
  await setup(page);
  await page.goto(baseURL + settingsPath("capabilities"));
  const web = page.getByRole("region", { name: "Web & documents" });
  const button = web.getByRole("button", { name: "Show hint" }).first();
  await expect(button).toHaveAttribute("aria-expanded", "false");
  const text = page.locator(`#${await button.getAttribute("aria-controls")}`);
  await expect(text).toBeHidden();
  await button.click();
  await expect(button).toHaveAttribute("aria-expanded", "true");
  await expect(text).toHaveText(
    "Web pages can contain instructions meant to mislead the agent. Switch these on only for agents whose other tools you would trust with that.",
  );
  await button.click();
  await expect(text).toBeHidden();
  const shell = page.locator("#agent-shell");
  await shell.getByRole("radio", { name: "With approval" }).check();
  await expect(
    shell.getByText(/With shell access the agent works as your user account/),
  ).toBeVisible();
  await expect(
    shell.getByText(
      "The agent asks you before every command that is not always allowed.",
    ),
  ).toBeVisible();
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `npm run build && npx playwright test tests/browser/assistant-settings-save.spec.js tests/browser/assistant-settings-tabs.spec.js -g "Capabilities tab|task-bound member sees|info disclosure"`
Expected: FAIL — `getByRole('switch', { name: 'Remember information' })` not found.

- [ ] **Step 3: Implement the groups**

`web/features/assistants/settings/CapabilityGroups.jsx`:

```jsx
import React, { useEffect, useId, useState } from "react";
import GroupLabel from "../../../components/GroupLabel.jsx";
import ListCard from "../../../components/ListCard.jsx";
import ListRow, { ToggleRow, unknownValue } from "../../../components/ListRow.jsx";
import Segmented from "../../../components/Segmented.jsx";
import ReferenceRow from "../../../components/ReferenceRow.jsx";
import {
  InfoHintButton,
  InfoHintText,
  useInfoHint,
} from "../../../components/InfoHint.jsx";
import { routePath } from "../../../app/routes.js";
import { assistantCopy } from "../../../lib/i18n/messages/assistants.js";
import { assistantShellCopy as shellCopy } from "../../../lib/i18n/messages/assistant-shell.js";
import { assistantSettingsCopy as settingsCopy } from "../../../lib/i18n/messages/assistant-settings.js";
import { assistantApi } from "../assistant-api.js";
import { shellEligible, shellLevels } from "../shell-level.js";
import { agentRoute, webCapabilityKeys } from "./agent-settings-fields.js";
import useCount from "./useCount.js";

const names = {
  webSearch: ["enableWebSearch", "webSearchDescription"],
  webFetch: ["enableWebFetch", "webFetchDescription"],
  browser: ["enableBrowser", "browserDescription"],
  documents: ["enableDocuments", "documentsDescription"],
};

/** Memory and reminders switches; the saved-notes row opens the memory editor. */
export function MemoryGroup({ assistant, draft, go }) {
  const id = useId();
  const copy = assistantCopy.personal;
  const saved = Boolean(assistant) && assistant.capabilities?.memory === true;
  const notes = useCount(
    () =>
      assistantApi
        .memoryFiles(assistant.id)
        .then((result) => (Array.isArray(result?.files) ? result.files.length : null)),
    saved,
    assistant?.id,
  );
  return (
    <section aria-labelledby={id}>
      <GroupLabel id={id} hint={`${copy.capabilityHint} ${copy.memoryHint}`}>
        {copy.memoryGroup}
      </GroupLabel>
      <ListCard labelledBy={id}>
        <ToggleRow
          label={copy.enableMemory}
          sub={copy.memoryDescription}
          checked={draft.values.memory}
          onChange={(on) => draft.set("memory", on)}
        />
        {saved && (
          <ListRow
            label={copy.notes}
            value={notes ?? unknownValue}
            href={routePath(agentRoute(assistant.id, "capabilities", "memory"))}
            onClick={() => go("capabilities", "memory")}
          />
        )}
        <ToggleRow
          label={copy.enableReminders}
          sub={copy.remindersDescription}
          checked={draft.values.reminders}
          onChange={(on) => draft.set("reminders", on)}
        />
      </ListCard>
    </section>
  );
}

/** Web switches with today's availability rules and the search provider reference. */
export function WebGroup({ draft, browser, creating = false, navigate }) {
  const id = useId();
  const copy = assistantCopy.personal;
  const [search, setSearch] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    // Unknown stays usable: the server decides when the agent starts.
    assistantApi
      .webSearch(controller.signal)
      .then(setSearch)
      .catch(() => {});
    return () => controller.abort();
  }, []);
  const missing = {
    browser: browser?.available === false ? copy.browserUnavailable : "",
    webSearch: search && search.ready === false ? copy.searchUnavailable : "",
  };
  const provider = search?.provider
    ? (settingsCopy.searchProviders[search.provider] ?? search.provider)
    : unknownValue;
  const accounts = { view: "accounts", section: "services", item: "web-search" };
  return (
    <section aria-labelledby={id}>
      <GroupLabel id={id} hint={copy.webHint}>
        {copy.webGroup}
      </GroupLabel>
      <ListCard labelledBy={id}>
        {webCapabilityKeys.map((key) => {
          const [label, description] = names[key];
          // A new agent has no stored profile yet: web tools are switched on after saving.
          const reason = creating ? copy.availableAfterSaving : missing[key];
          const on = !creating && draft.values[key] === true;
          return (
            <ToggleRow
              key={key}
              label={copy[label]}
              sub={reason || copy[description]}
              checked={on}
              // A switched-on capability can always be turned off.
              disabled={creating || (Boolean(reason) && !on)}
              onChange={(next) => draft.set(key, next)}
            />
          );
        })}
      </ListCard>
      {!creating && (
        <ReferenceRow
          title={settingsCopy.searchProvider(provider)}
          href={routePath(accounts)}
          onOpen={() => navigate(accounts)}
        />
      )}
    </section>
  );
}

/** Shell level: selected hint and warning visible, the other levels' hints behind ⓘ. */
export function ShellGroup({ assistant, draft, go, creating = false }) {
  const id = useId();
  const others = useInfoHint();
  const eligible = shellEligible(assistant);
  const reason = eligible
    ? ""
    : assistant?.archivedAt
      ? shellCopy.archived
      : shellCopy.temporary;
  const level = draft.values.shell;
  const otherHints = shellLevels
    .filter((value) => value !== level)
    .map((value) => `${shellCopy.levels[value]}: ${shellCopy.levelHints[value]}`)
    .join(" ");
  const listed = Boolean(assistant) && eligible && !creating;
  const entries = useCount(
    () =>
      assistantApi
        .shellAllowlist(assistant.id)
        .then((result) => (result.entries || []).length),
    listed,
    assistant?.id,
  );
  return (
    <section id="agent-shell" aria-labelledby={id}>
      <GroupLabel id={id} hint={shellCopy.intro}>
        {shellCopy.title}
      </GroupLabel>
      <div className="list-card">
        <div className="list-row agent-shell-levels">
          <Segmented
            label={shellCopy.title}
            options={shellLevels.map((value) => ({
              value,
              label: shellCopy.levels[value],
            }))}
            value={level}
            disabled={!eligible || draft.saving}
            onChange={(next) => draft.set("shell", next)}
          />
        </div>
        {reason ? (
          <p className="agent-row-note">{reason}</p>
        ) : (
          <div className="agent-row-note">
            <p>
              {shellCopy.levelHints[level]} <InfoHintButton hint={others} />
            </p>
            <InfoHintText hint={others}>{otherHints}</InfoHintText>
          </div>
        )}
        {listed && (
          <ListRow
            label={shellCopy.allowlist}
            value={entries ?? unknownValue}
            href={routePath(agentRoute(assistant.id, "capabilities", "allowlist"))}
            onClick={() => go("capabilities", "allowlist")}
          />
        )}
      </div>
      {eligible &&
        (level === "off" ? (
          <p className="assistant-note">{shellCopy.offHint}</p>
        ) : (
          <p className="assistant-shell-warning">{shellCopy.warning}</p>
        ))}
      {eligible && assistant?.shellPending && (
        <p role="status" className="assistant-notice">
          {shellCopy.pending}
        </p>
      )}
    </section>
  );
}
```

`web/features/assistants/settings/McpGroup.jsx`:

```jsx
import React, { useEffect, useId, useState } from "react";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import GroupLabel from "../../../components/GroupLabel.jsx";
import ListCard from "../../../components/ListCard.jsx";
import { CheckboxRow } from "../../../components/ListRow.jsx";
import ReferenceRow from "../../../components/ReferenceRow.jsx";
import { routePath } from "../../../app/routes.js";
import { mcpOAuthCopy } from "../../../lib/i18n/messages/mcp-oauth.js";
import { mcpServerCopy as copy } from "../../../lib/i18n/messages/mcp-servers.js";
import { assistantSettingsCopy as settingsCopy } from "../../../lib/i18n/messages/assistant-settings.js";
import { assistantApi } from "../assistant-api.js";
import McpOAuthStatus, {
  oauthStatusOf,
  usesOAuth,
} from "../../mcp-servers/McpOAuthStatus.jsx";
import RouteLink from "../RouteLink.jsx";
import { toggleId } from "./agent-settings-fields.js";
import "../../mcp-servers/mcp-servers.css";

/** Which central MCP servers the agent may use; saved with the Capabilities tab. */
export default function McpGroup({ assistant, draft, notice, reloadKey, navigate }) {
  const id = useId();
  const [servers, setServers] = useState(null),
    [error, setError] = useState("");
  const bound = assistant.mcpServers || [];
  // A saved binding compiles the server: its login status is read again after a save.
  useEffect(() => {
    let live = true;
    assistantApi
      .mcpServers()
      .then((list) => live && setServers(list))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [assistant.revision, reloadKey]);
  const loginShown = (server) => usesOAuth(server) && bound.includes(server.id);
  const loginMissing = (servers || []).some(
    (server) => loginShown(server) && oauthStatusOf(server) !== "connected",
  );
  const accounts = { view: "accounts", section: "mcp-servers" };
  return (
    <section id="agent-mcp" aria-labelledby={id}>
      <GroupLabel id={id} hint={copy.agentDescription}>
        {copy.agentTitle}
      </GroupLabel>
      <ErrorMessage error={error} />
      {servers && !servers.length ? (
        <div className="list-card agent-empty">
          <p>{copy.agentNone}</p>
          <RouteLink route={accounts} navigate={navigate}>
            {copy.agentOpenAccounts}
          </RouteLink>
        </div>
      ) : (
        <ListCard labelledBy={id}>
          {(servers || []).map((server) => (
            <CheckboxRow
              key={server.id}
              label={server.name}
              sub={loginShown(server) ? <McpOAuthStatus server={server} /> : undefined}
              pill={server.transport === "stdio" ? copy.stdioBadge : undefined}
              checked={draft.values.mcpServers.includes(server.id)}
              disabled={draft.saving}
              onChange={(on) =>
                draft.set("mcpServers", toggleId(draft.values.mcpServers, server.id, on))
              }
            />
          ))}
        </ListCard>
      )}
      {loginMissing && <p className="mcp-hint">{mcpOAuthCopy.agentLoginHint}</p>}
      {notice && (
        <p role="status" className="mcp-hint">
          {notice}
        </p>
      )}
      <ReferenceRow
        title={settingsCopy.manageMcpServers}
        href={routePath(accounts)}
        onOpen={() => navigate(accounts)}
      />
    </section>
  );
}
```

- [ ] **Step 4: Implement the tab**

`web/features/assistants/settings/CapabilitiesTab.jsx`:

```jsx
import React, { useEffect, useState } from "react";
import SaveBar from "../../../components/SaveBar.jsx";
import UnsavedChangesSheet from "../../../components/UnsavedChangesSheet.jsx";
import useTabDraft from "../../../lib/settings/useTabDraft.js";
import { sameValue } from "../../../lib/settings/draft-state.js";
import { assistantCopy as copy } from "../../../lib/i18n/messages/assistants.js";
import { assistantShellCopy } from "../../../lib/i18n/messages/assistant-shell.js";
import { mcpServerCopy } from "../../../lib/i18n/messages/mcp-servers.js";
import { assistantSettingsCopy as settingsCopy } from "../../../lib/i18n/messages/assistant-settings.js";
import TemporaryMcpServers from "../../mcp-servers/TemporaryMcpServers.jsx";
import useAssistants from "../useAssistants.js";
import { capabilityServer, isPersonal } from "./agent-settings-fields.js";
import { capabilityStep } from "./agent-settings-steps.js";
import useAgentDraftGuard from "./useAgentDraftGuard.js";
import ConflictNotice from "./ConflictNotice.jsx";
import ConfirmationSheet from "./ConfirmationSheet.jsx";
import { MemoryGroup, ShellGroup, WebGroup } from "./CapabilityGroups.jsx";
import McpGroup from "./McpGroup.jsx";

const subpages = {};
const conflictLabels = {
  memory: () => copy.personal.enableMemory,
  reminders: () => copy.personal.enableReminders,
  webSearch: () => copy.personal.enableWebSearch,
  webFetch: () => copy.personal.enableWebFetch,
  browser: () => copy.personal.enableBrowser,
  documents: () => copy.personal.enableDocuments,
  shell: () => assistantShellCopy.title,
  mcpServers: () => mcpServerCopy.agentTitle,
};

/** Capabilities: memory, web, shell and MCP servers in one draft and one PATCH. */
export default function CapabilitiesTab({ assistant, page, go, navigate }) {
  const { refresh, runtime, members = [] } = useAssistants();
  const personal = isPersonal(assistant);
  const draft = useTabDraft({
    server: capabilityServer(assistant),
    revisions: { assistant: assistant.revision },
  });
  const label = settingsCopy.tabs.capabilities;
  const steps = [capabilityStep({ assistant, label })];
  const [notice, setNotice] = useState(""),
    [mcpReload, setMcpReload] = useState(0);
  useEffect(() => {
    if (draft.dirty) setNotice("");
  }, [draft.dirty]);
  const after = async (result, mcpChanged) => {
    if (result.status === "saved") {
      if (mcpChanged) setMcpReload((n) => n + 1);
      if (mcpChanged)
        setNotice(
          result.results.assistant?.pending
            ? mcpServerCopy.pendingNotice
            : mcpServerCopy.agentSaved,
        );
      await refresh();
    }
    return result;
  };
  const mcpChanged = () => !sameValue(draft.values.mcpServers, draft.base.mcpServers);
  const save = async () => {
    const changed = mcpChanged();
    return after(await draft.save(steps), changed);
  };
  const overwrite = async () => {
    const changed = mcpChanged();
    return after(await draft.overwrite(steps), changed);
  };
  const sheet = useAgentDraftGuard({
    draft,
    assistantId: assistant.id,
    tab: "capabilities",
    label,
    save,
  });
  const member = members.find((m) => m.assistantId === assistant.id);
  const Subpage = subpages[page];
  if (Subpage)
    return (
      <>
        <Subpage assistant={assistant} onBack={() => go("capabilities")} />
        <UnsavedChangesSheet {...sheet} />
      </>
    );
  return (
    <>
      <ConflictNotice draft={draft} labels={conflictLabels} />
      {personal && <MemoryGroup assistant={assistant} draft={draft} go={go} />}
      {personal && (
        <WebGroup draft={draft} browser={runtime?.browser} navigate={navigate} />
      )}
      <ShellGroup assistant={assistant} draft={draft} go={go} />
      {personal && Array.isArray(assistant.mcpServers) && (
        <McpGroup
          assistant={assistant}
          draft={draft}
          notice={notice}
          reloadKey={mcpReload}
          navigate={navigate}
        />
      )}
      {!personal && member && <TemporaryMcpServers servers={member.mcpServers} />}
      <SaveBar
        draft={draft}
        onSave={save}
        onOverwrite={overwrite}
        saveLabel={copy.save}
        note={copy.pendingConfigShort}
      />
      <ConfirmationSheet
        confirmation={draft.confirmation}
        onShellCancel={() => draft.set("shell", draft.base.shell)}
      />
      <UnsavedChangesSheet {...sheet} />
    </>
  );
}
```

(`subpages` is filled in Task 5.)

- [ ] **Step 5: Wire the tab and narrow the bridge**

In `AgentSettingsPage.jsx` add `import CapabilitiesTab from "./CapabilitiesTab.jsx";` and change `const panels = { profile: ProfileTab };` to:

```js
const panels = { profile: ProfileTab, capabilities: CapabilitiesTab };
```

In `LegacySections.jsx` delete the `if (tab === "capabilities") return (…);` branch, the `AgentMcpServers`/`AssistantMemory` imports, the now unused `const { refresh } = useAssistants();` line and the now unused `import useAssistants from "../useAssistants.js";` (ESLint `no-unused-vars` fails otherwise). (Memory notes return as a subpage in Task 5.)

- [ ] **Step 6: Run the specs**

Run: `npm run build && npx playwright test tests/browser/assistant-settings-save.spec.js tests/browser/assistant-settings-tabs.spec.js`
Expected: PASS (all tests in both files, 12 total).

- [ ] **Step 7: Commit**

```bash
npx prettier --write web/features/assistants/settings tests/browser/assistant-settings-save.spec.js tests/browser/assistant-settings-tabs.spec.js
npx eslint web/features/assistants/settings tests/browser/assistant-settings-save.spec.js tests/browser/assistant-settings-tabs.spec.js
git add web/features/assistants/settings tests/browser/assistant-settings-save.spec.js tests/browser/assistant-settings-tabs.spec.js
git commit -m "feat: save agent capabilities, shell and MCP servers from one tab" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Memory editor and allowlist subpages

"Gespeicherte Notizen ›" opens the memory editor with its own draft, bar and hash check; "Immer erlaubte Befehle ›" opens the allowlist with immediate deletes.

**Files:**

- Create: `web/features/assistants/settings/MemoryPage.jsx`, `web/features/assistants/settings/AllowlistPage.jsx`
- Modify: `web/features/assistants/settings/CapabilitiesTab.jsx` (`subpages`), `web/features/assistants/agent-settings.css` (entry lines), `tests/helpers/assistant-settings-browser.js` (memory files)
- Test: `tests/browser/assistant-settings-tabs.spec.js`

**Interfaces:**

- Consumes: Task 2 `memoryStep`; Task 3 `useAgentDraftGuard`, `SubpageHeader({ title, tab, onBack, hint })`; Step 0 `useTabDraft`, `SaveBar`, `UnsavedChangesSheet`, `ListCard`, `ListRow`; `assistantApi.{memory,memoryFiles,saveMemory,searchMemory,shellAllowlist,removeShellAllowlistEntry}`.
- Produces: `MemoryPage({ assistant, onBack })` (region "Memory"), `AllowlistPage({ assistant, onBack })` (`id="agent-allowlist"`, rows `.assistant-shell-entry`). Fixture option `memory: { [name]: file }` and `state.memorySaves`.

- [ ] **Step 1: Let the fixture serve and store memory notes**

In `tests/helpers/assistant-settings-browser.js` add to `state`:

```js
    memory: options.memory || {},
    memorySaves: [],
```

and replace the `/api/assistants/home/memory` branch with:

```js
if (path === "/api/assistants/home/memory") {
  if (method === "PUT") {
    const body = route.request().postDataJSON();
    state.memorySaves.push(body);
    // Like native-memory.js: a stale hash is a 409 "assistants.conflict".
    if (body.expectedHash && state.memory[body.name]?.hash !== body.expectedHash)
      return route.fulfill({
        status: 409,
        json: { error: "Revision conflict", messageKey: "assistants.conflict" },
      });
    state.memory[body.name] = {
      name: body.name,
      content: body.content,
      hash: `saved-${state.memorySaves.length}`,
    };
    return route.fulfill({ json: state.memory[body.name] });
  }
  const name = new URL(route.request().url()).searchParams.get("name");
  return route.fulfill({
    json: state.memory[name] || { name, content: "", missing: true },
  });
}
```

- [ ] **Step 2: Write the failing tests**

Append to `tests/browser/assistant-settings-tabs.spec.js`:

```js
test("switching the note type with unsaved text asks first", async ({ page }) => {
  const state = await setup(page, {
    assistant: { capabilities: { memory: true, reminders: false } },
    memory: {
      "MEMORY.md": { name: "MEMORY.md", content: "Facts", hash: "h1" },
      "USER.md": { name: "USER.md", content: "Tea", hash: "h2" },
    },
  });
  await page.goto(baseURL + settingsPath("capabilities"));
  await page.getByRole("link", { name: /^Saved notes/ }).click();
  await expect(page).toHaveURL(/tab=capabilities&page=memory$/);
  const notes = page.getByLabel("Saved notes");
  await expect(notes).toHaveValue("Facts");
  await notes.fill("Facts and more");
  await page.getByLabel("Note type").selectOption("USER.md");
  const sheet = unsavedSheet(page);
  await expect(sheet).toContainText("1 change in Memory is not saved yet.");
  await sheet.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByLabel("Note type")).toHaveValue("MEMORY.md");
  await expect(notes).toHaveValue("Facts and more");
  await page.getByLabel("Note type").selectOption("USER.md");
  await unsavedSheet(page).getByRole("button", { name: "Save and switch" }).click();
  await expect(notes).toHaveValue("Tea");
  expect(state.memorySaves).toEqual([
    { name: "MEMORY.md", content: "Facts and more", expectedHash: "h1" },
  ]);
  await page.getByRole("button", { name: "Back to Capabilities" }).click();
  await expect(page).toHaveURL(/\/agents\/home\/settings\?tab=capabilities$/);
});

test("a note changed elsewhere can be overwritten against its current hash", async ({
  page,
}) => {
  const state = await setup(page, {
    assistant: { capabilities: { memory: true, reminders: false } },
    memory: { "MEMORY.md": { name: "MEMORY.md", content: "Facts", hash: "h1" } },
  });
  await page.goto(baseURL + settingsPath("capabilities", "memory"));
  const notes = page.getByLabel("Saved notes");
  await expect(notes).toHaveValue("Facts");
  await notes.fill("Mine");
  state.memory["MEMORY.md"] = { name: "MEMORY.md", content: "Theirs", hash: "h9" };
  await saveBar(page).getByRole("button", { name: "Save notes" }).click();
  await expect(saveBar(page).getByRole("alert")).toContainText(
    "Changed elsewhere in the meantime.",
  );
  await expect(notes).toHaveValue("Mine");
  // The page has read the newer hash once the edited note shows as changed elsewhere.
  await expect(
    page.getByRole("status").filter({ hasText: "changed on the server" }),
  ).toBeVisible();
  await saveBar(page).getByRole("button", { name: "Overwrite anyway" }).click();
  await expect.poll(() => state.memorySaves.length).toBe(2);
  expect(state.memorySaves[1]).toEqual({
    name: "MEMORY.md",
    content: "Mine",
    expectedHash: "h9",
  });
  await expect(saveBar(page)).toHaveCount(0);
});

test("the memory page falls back to its tab while memory is off", async ({ page }) => {
  await setup(page);
  await page.goto(baseURL + settingsPath("capabilities", "memory"));
  await expect(page).toHaveURL(/\/agents\/home\/settings\?tab=capabilities$/);
  await expect(page.getByRole("link", { name: /^Saved notes/ })).toHaveCount(0);
  await expect(unsavedSheet(page)).toHaveCount(0);
});

test("a capabilities draft survives a visit to its own subpage", async ({ page }) => {
  await setup(page, { assistant: { shell: "approval" } });
  await page.goto(baseURL + settingsPath("capabilities"));
  await page.getByRole("switch", { name: "Read web pages" }).check();
  await page.getByRole("link", { name: /^Always allowed commands/ }).click();
  await expect(unsavedSheet(page)).toHaveCount(0);
  await expect(page.locator("#agent-allowlist")).toContainText(
    "No always allowed commands.",
  );
  await page.getByRole("button", { name: "Back to Capabilities" }).click();
  await expect(page.getByRole("switch", { name: "Read web pages" })).toBeChecked();
  await expect(saveBar(page)).toBeVisible();
});
```

- [ ] **Step 3: Run them to make sure they fail**

Run: `npm run build && npx playwright test tests/browser/assistant-settings-tabs.spec.js -g "note type|note changed elsewhere|memory page|own subpage"`
Expected: FAIL — the "Saved notes" row navigates, but no "Note type" field renders on `page=memory` (the tab shows its main view).

- [ ] **Step 4: Implement the memory editor**

`web/features/assistants/settings/MemoryPage.jsx`:

```jsx
import React, { useEffect, useState } from "react";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import SaveBar from "../../../components/SaveBar.jsx";
import UnsavedChangesSheet from "../../../components/UnsavedChangesSheet.jsx";
import useTabDraft from "../../../lib/settings/useTabDraft.js";
import { assistantCopy } from "../../../lib/i18n/messages/assistants.js";
import { assistantApi } from "../assistant-api.js";
import { memoryStep } from "./agent-settings-steps.js";
import useAgentDraftGuard from "./useAgentDraftGuard.js";
import ConflictNotice from "./ConflictNotice.jsx";
import SubpageHeader from "./SubpageHeader.jsx";

/**
 * The agent's two root notes (editable, saved against the loaded hash) and its own
 * notes under memory/ (read only), plus a search over all of them.
 */
export default function MemoryPage({ assistant, onBack }) {
  const copy = assistantCopy.personal;
  const assistantId = assistant.id;
  const [name, setName] = useState("MEMORY.md"),
    [file, setFile] = useState(null),
    [notes, setNotes] = useState([]),
    [nextName, setNextName] = useState(null);
  const [query, setQuery] = useState(""),
    [results, setResults] = useState(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    assistantApi
      .memoryFiles(assistantId)
      .then((next) => active && setNotes(Array.isArray(next?.files) ? next.files : []))
      .catch(() => active && setNotes([]));
    return () => {
      active = false;
    };
  }, [assistantId, reload]);
  useEffect(() => {
    let active = true;
    setFile(null);
    setError("");
    assistantApi
      .memory(assistantId, name)
      .then((next) => active && setFile(next))
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [assistantId, name, reload]);
  const readOnly = Boolean(file?.readOnly);
  const savable = Boolean(file) && !readOnly && Boolean(file.missing || file.hash);
  const draft = useTabDraft({ server: { content: file?.content ?? "" } });
  const steps = savable
    ? [memoryStep({ assistantId, name, file, label: copy.memory })]
    : [];
  const save = async () => {
    const result = await draft.save(steps);
    if (result.status === "saved" && result.results.memory)
      setFile(result.results.memory);
    // Changed elsewhere (409 "assistants.conflict"): read the note's current hash and
    // content without touching the draft, so "Reload" shows the newer note and
    // "Overwrite anyway" saves against the newer hash instead of failing again.
    if (result.status === "conflict")
      assistantApi.memory(assistantId, name).then(
        (next) => setFile(next),
        () => {},
      );
    return result;
  };
  const sheet = useAgentDraftGuard({
    draft,
    assistantId,
    tab: "capabilities",
    page: "memory",
    label: copy.memory,
    save,
  });
  // Another note is not a route change: this page asks itself before switching.
  const choose = (next) => (draft.dirty ? setNextName(next) : setName(next));
  const switchTo = () => {
    setName(nextName);
    setNextName(null);
  };
  async function search(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      setResults((await assistantApi.searchMemory(assistantId, query)).results);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="agent-subpage" aria-label={copy.memory}>
      <SubpageHeader title={copy.memory} tab="capabilities" onBack={onBack} />
      <ErrorMessage error={error} />
      <ConflictNotice draft={draft} labels={{ content: () => copy.notes }} />
      <div className="list-card agent-fields">
        <label className="agent-field">
          {copy.noteType}
          <select
            value={name}
            disabled={busy || draft.saving}
            onChange={(event) => choose(event.target.value)}
          >
            <option value="MEMORY.md">{copy.facts}</option>
            <option value="USER.md">{copy.preferences}</option>
            {notes.length > 0 && (
              <optgroup label={copy.agentNotes}>
                {notes.map((note) => (
                  <option key={note.name} value={note.name}>
                    {note.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </label>
        <label className="agent-field">
          {copy.notes}
          <textarea
            rows={9}
            maxLength={65536}
            disabled={!file || busy || (!savable && !readOnly)}
            readOnly={readOnly}
            value={file ? draft.values.content : ""}
            onChange={(event) => draft.set("content", event.target.value)}
          />
        </label>
      </div>
      {readOnly && <p className="assistant-note">{copy.agentNotesHint}</p>}
      <div className="assistant-actions">
        {!readOnly && (
          <button
            type="button"
            className="button secondary"
            disabled={!savable || busy}
            onClick={() => draft.set("content", "")}
          >
            {copy.clearNotes}
          </button>
        )}
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={() => {
            draft.reset();
            setReload((n) => n + 1);
          }}
        >
          {copy.reload}
        </button>
      </div>
      <p className="assistant-note">{copy.clearHint}</p>
      <form className="list-card agent-fields" onSubmit={search}>
        <label className="agent-field">
          {copy.searchMemory}
          <input
            required
            maxLength={1000}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="agent-field">
          <button className="button secondary" disabled={busy}>
            {copy.search}
          </button>
        </div>
      </form>
      {results?.length === 0 && <p className="assistant-note">{copy.noResults}</p>}
      {results?.map((result, index) => (
        <article className="assistant-card" key={`${result.path}-${index}`}>
          <strong>{result.path}</strong>
          <p className="assistant-memory-text">{result.snippet}</p>
        </article>
      ))}
      <SaveBar
        draft={draft}
        onSave={save}
        onOverwrite={save}
        saveLabel={copy.saveNotes}
      />
      <UnsavedChangesSheet {...sheet} />
      <UnsavedChangesSheet
        open={nextName !== null}
        tab={copy.memory}
        count={draft.changeCount}
        busy={draft.saving}
        onSave={async () => {
          if ((await save()).status === "saved") switchTo();
          else setNextName(null);
        }}
        onDiscard={() => {
          draft.reset();
          switchTo();
        }}
        onCancel={() => setNextName(null)}
      />
    </section>
  );
}
```

- [ ] **Step 5: Implement the allowlist page**

`web/features/assistants/settings/AllowlistPage.jsx`:

```jsx
import React, { useCallback, useEffect, useState } from "react";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import ListCard from "../../../components/ListCard.jsx";
import ListRow from "../../../components/ListRow.jsx";
import { formatTimestamp } from "../../../lib/i18n/index.js";
import { assistantShellCopy as copy } from "../../../lib/i18n/messages/assistant-shell.js";
import { assistantApi } from "../assistant-api.js";
import SubpageHeader from "./SubpageHeader.jsx";

const entryName = (entry) =>
  entry.kind === "command" ? copy.commandEntry : entry.pattern;

function EntryDetails({ entry }) {
  return (
    <>
      <span className="agent-entry-line">
        {copy.sources[entry.source] || copy.sources.other}
        {entry.kind === "program" &&
          ` · ${entry.argPattern ? copy.exactArguments : copy.anyArguments}`}
      </span>
      {(entry.command || entry.lastUsedCommand) && (
        <span className="agent-entry-line">
          {copy.command}: <code>{entry.command || entry.lastUsedCommand}</code>
        </span>
      )}
      {entry.cwd && (
        <span className="agent-entry-line">
          {copy.folder}: <code>{entry.cwd}</code>
        </span>
      )}
      {entry.lastUsedAt && (
        <span className="agent-entry-line">
          {copy.lastUsed(formatTimestamp(entry.lastUsedAt))}
        </span>
      )}
      {entry.companions?.length > 0 && (
        <span className="agent-entry-line">{copy.linked(entry.companions.length)}</span>
      )}
    </>
  );
}

/**
 * The commands this agent may always run (OpenClaw's exec allowlist). A path entry's
 * linked command entries are folded into it by the server and deleted with it.
 */
export default function AllowlistPage({ assistant, onBack }) {
  const assistantId = assistant.id;
  const [entries, setEntries] = useState(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState("");
  const load = useCallback(async () => {
    try {
      const result = await assistantApi.shellAllowlist(assistantId);
      setEntries(result.entries || []);
      setError("");
    } catch (e) {
      setError(e.message);
    }
  }, [assistantId]);
  useEffect(() => {
    load();
  }, [load]);
  async function remove(entry) {
    setBusy(entry.id);
    setError("");
    try {
      const result = await assistantApi.removeShellAllowlistEntry(assistantId, entry.id);
      if (Array.isArray(result.entries)) setEntries(result.entries);
      else await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  }
  return (
    <section id="agent-allowlist" className="agent-subpage" aria-label={copy.allowlist}>
      <SubpageHeader
        title={copy.allowlist}
        tab="capabilities"
        onBack={onBack}
        hint={copy.allowlistHint}
      />
      <ErrorMessage error={error} />
      {entries === null && !error && (
        <p className="assistant-note">{copy.allowlistLoading}</p>
      )}
      {entries?.length === 0 && <p className="assistant-note">{copy.allowlistEmpty}</p>}
      {entries?.length > 0 && (
        <ListCard label={copy.allowlist}>
          {entries.map((entry) => (
            <ListRow
              key={entry.id}
              className="assistant-shell-entry"
              label={<code>{entryName(entry)}</code>}
              sub={<EntryDetails entry={entry} />}
              disabled={Boolean(busy)}
              onDelete={() => remove(entry)}
              deleteLabel={copy.removeLabel(entryName(entry))}
            />
          ))}
        </ListCard>
      )}
    </section>
  );
}
```

Append to `web/features/assistants/agent-settings.css`:

```css
.agent-entry-line {
  display: block;
}
```

- [ ] **Step 6: Register the subpages**

In `CapabilitiesTab.jsx` add `import MemoryPage from "./MemoryPage.jsx";` and `import AllowlistPage from "./AllowlistPage.jsx";` and replace `const subpages = {};` with:

```js
const subpages = { memory: MemoryPage, allowlist: AllowlistPage };
```

- [ ] **Step 7: Run the specs**

Run: `npm run build && npx playwright test tests/browser/assistant-settings-tabs.spec.js tests/browser/assistant-settings-save.spec.js`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
npx prettier --write web/features/assistants/settings web/features/assistants/agent-settings.css tests/helpers/assistant-settings-browser.js tests/browser/assistant-settings-tabs.spec.js
npx eslint web/features/assistants/settings tests/helpers/assistant-settings-browser.js tests/browser/assistant-settings-tabs.spec.js
git add web/features/assistants tests/helpers/assistant-settings-browser.js tests/browser/assistant-settings-tabs.spec.js
git commit -m "feat: open agent memory notes and allowed commands as subpages" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Arbeit tab

Project and pipeline grants (selection subpages), three permission toggles, the team policy and the complete action history, saved with one `PUT /assistants/:id/work`.

**Files:**

- Create: `web/features/assistants/settings/useActionHistory.js`, `web/features/assistants/settings/ActionHistory.jsx`, `web/features/assistants/settings/GrantSelectionPage.jsx`, `web/features/assistants/settings/WorkTab.jsx`
- Modify: `web/features/assistants/settings/AgentSettingsPage.jsx` (`panels`), `web/features/assistants/settings/LegacySections.jsx` (drop the work branch), `tests/helpers/assistant-settings-browser.js` (`actions` option)
- Test: `tests/browser/assistant-settings-save.spec.js`, `tests/browser/assistant-settings-tabs.spec.js`

**Interfaces:**

- Consumes: Task 2 `workServer`, `workStep`, `grantCount`, `pendingCount`, `permissionKeys`, `toggleId`, `agentRoute`; Task 3 `useAgentDraftGuard`, `ConflictNotice`, `SubpageHeader`; Step 0 `ToggleRow`, `NumberRow`, `CheckboxRow`, `ListRow`, `ListCard`, `GroupLabel`, `SaveBar`, `UnsavedChangesSheet`, `commonCopy.ofCount`; `usePolling(task, ms, { restartKey })`; `api(path, method?, body?)`.
- Produces: `useActionHistory(assistantId) => { actions, loaded, pending, error, busy, act(operation) }` (polls every 3 s); `ActionHistory({ history, assistantId, onBack })` (region "Actions and coding tasks"); `GrantSelectionPage({ title, items, selected, disabled, onToggle(id, on), onBack })`; `WorkTab({ assistant, page, go })` with sections `#agent-access` (region "Projects and coding tasks") and `#agent-team` (region "Team"). Fixture option `actions`.

- [ ] **Step 1: Let the fixture serve actions**

In `tests/helpers/assistant-settings-browser.js` add `actions: options.actions || [],` to `state` and in the `/api/assistants/home/actions` branch replace `json: { actions: [] }` with `json: { actions: state.actions }`.

- [ ] **Step 2: Write the failing tests**

Append to `tests/browser/assistant-settings-save.spec.js` (add `unsavedSheet` to the `agent-settings-page.js` import):

```js
test("the Work tab saves grants and team policy in one request, then only what changed", async ({
  page,
}) => {
  const state = await setup(page, {
    catalog: {
      projects: [
        { id: "p1", name: "Demo" },
        { id: "p2", name: "Other" },
      ],
      pipelines: [{ id: "b1", name: "Build" }],
    },
  });
  await page.goto(baseURL + settingsPath("work"));
  const projects = page.getByRole("link", { name: /^Allowed projects/ });
  await expect(projects).toContainText("0 of 2");
  await projects.click();
  await page.getByLabel("Demo", { exact: true }).check();
  await expect(unsavedSheet(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Back to Work" }).click();
  await expect(projects).toContainText("1 of 2");
  await page.getByRole("spinbutton", { name: "Maximum team size" }).fill("6");
  await saveBar(page).getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => state.work.length).toBe(1);
  expect(state.work[0]).toEqual({
    access: {
      revision: 0,
      projectIds: ["p1"],
      pipelineIds: [],
      memoryWrite: false,
      autonomous: false,
      publish: false,
    },
    team: { revision: 1, autonomous: false, maxMembers: 6, runTimeoutMinutes: 30 },
  });
  await expect(saveBar(page)).toHaveCount(0);
  await page.getByRole("spinbutton", { name: "Member time limit (minutes)" }).fill("45");
  await saveBar(page).getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => state.work.length).toBe(2);
  expect(state.work[1]).toEqual({
    team: { revision: 2, autonomous: false, maxMembers: 6, runTimeoutMinutes: 45 },
  });
});
```

Append to `tests/browser/assistant-settings-tabs.spec.js`:

```js
test("waiting approvals lead to the full action history", async ({ page }) => {
  await setup(page, {
    actions: [
      {
        id: "a1",
        state: "awaiting_approval",
        revision: 1,
        projectName: "Demo",
        payload: { action: "coding_start", title: "Fix it", task: "Fix the bug" },
      },
    ],
  });
  await page.goto(baseURL + settingsPath("work"));
  await page.getByRole("button", { name: /Waiting for your approval · 1/ }).click();
  await expect(page).toHaveURL(/tab=work&page=actions$/);
  const history = page.getByRole("region", { name: "Actions and coding tasks" });
  await expect(history.getByText("Fix the bug")).toBeVisible();
  await expect(history.getByRole("button", { name: "Approve action" })).toBeVisible();
});
```

- [ ] **Step 3: Run them to make sure they fail**

Run: `npm run build && npx playwright test tests/browser/assistant-settings-save.spec.js tests/browser/assistant-settings-tabs.spec.js -g "Work tab|action history"`
Expected: FAIL — no link "Allowed projects" (the bridge still renders checkboxes).

- [ ] **Step 4: Implement the action history**

`web/features/assistants/settings/useActionHistory.js`:

```js
import { useCallback, useState } from "react";
import api from "../../../lib/api.js";
import usePolling from "../usePolling.js";
import { pendingCount } from "./agent-settings-fields.js";

// Every action of the agent (coding tasks, project memory changes), polled while the
// Work tab is open; slow responses never overlap (usePolling).
export default function useActionHistory(assistantId) {
  const [actions, setActions] = useState(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const path = `/assistants/${encodeURIComponent(assistantId)}/actions`;
  usePolling(
    async (signal) => {
      try {
        const result = await api(path);
        if (!signal.aborted) setActions(result.actions || []);
      } catch (e) {
        if (!signal.aborted) setError(e.message);
      }
    },
    3000,
    { restartKey: assistantId },
  );
  const act = useCallback(
    async (operation) => {
      setBusy(true);
      setError("");
      try {
        await operation();
        setActions((await api(path)).actions || []);
      } catch (e) {
        setError(e.message);
      } finally {
        setBusy(false);
      }
    },
    [path],
  );
  const list = actions || [];
  return {
    actions: list,
    loaded: actions !== null,
    pending: pendingCount(list),
    error,
    busy,
    act,
  };
}
```

`web/features/assistants/settings/ActionHistory.jsx` (the action list of `AssistantWorkflows.jsx`, same texts and requests):

```jsx
import React from "react";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import api from "../../../lib/api.js";
import { assistantWorkflowCopy as copy } from "../../../lib/i18n/messages/assistant-workflows.js";
import SubpageHeader from "./SubpageHeader.jsx";

const decide = (action, decision) =>
  api(`/assistant-actions/${encodeURIComponent(action.id)}/decision`, "POST", {
    revision: action.revision,
    decision,
  });

function ActionCard({ action: a, assistantId, busy, act }) {
  return (
    <article className="assistant-card assistant-reminder-row">
      <h3>{a.payload.action === "coding_start" ? copy.coding : copy.memory}</h3>
      {a.requestedBy && <p>{copy.requestedBy(a.memberName)}</p>}
      {a.requestedBy && a.state === "awaiting_approval" && (
        <p className="assistant-note">{copy.memberApprovalHint}</p>
      )}
      <p>
        {a.projectName}
        {a.pipelineName ? ` · ${a.pipelineName}` : ""}
      </p>
      <p>{copy.states[a.state]}</p>
      {a.diagnostic && copy.diagnostics[a.diagnostic] && (
        <p className="assistant-note">{copy.diagnostics[a.diagnostic]}</p>
      )}
      {a.payload.title && <strong>{a.payload.title}</strong>}
      <p className="assistant-memory-text">{a.payload.task || a.payload.content}</p>
      {a.payload.baseBranch && (
        <p>
          {copy.branch}: {a.payload.baseBranch}
        </p>
      )}
      {a.payload.expectedRevision && (
        <p>
          {copy.revision}: {a.payload.expectedRevision}
        </p>
      )}
      {a.run && (
        <>
          <p>
            {copy.runStatus}: {copy.runStates[a.run.status] || copy.states.unknown}
          </p>
          <a href={a.run.url} className="button secondary">
            {a.run.status === "awaiting-human" ? copy.humanGate : copy.openRun}
          </a>
          {a.run.nodes?.map((n) => (
            <p key={n.id}>
              {n.profileName} · {copy.nodeStates[n.status] || copy.states.running}
            </p>
          ))}
        </>
      )}
      <div className="assistant-actions">
        {a.state === "awaiting_approval" &&
          ["approve", "decline"].map((decision) => (
            <button
              key={decision}
              disabled={busy}
              className={`button ${decision === "approve" ? "primary" : "secondary"}`}
              onClick={() => act(() => decide(a, decision))}
            >
              {copy[decision]}
            </button>
          ))}
        {a.state === "running" && (
          <button
            className="button secondary"
            disabled={busy}
            onClick={() =>
              act(() =>
                api(
                  `/assistants/${encodeURIComponent(assistantId)}/actions/${encodeURIComponent(a.id)}/cancel`,
                  "POST",
                  {},
                ),
              )
            }
          >
            {copy.cancel}
          </button>
        )}
        {a.state === "unknown" && (
          <>
            <p className="assistant-note">{copy.unknownHint}</p>
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => act(() => decide(a, "review"))}
            >
              {copy.review}
            </button>
          </>
        )}
      </div>
    </article>
  );
}

/** "Aktionen und Coding-Aufträge": every action, newest first, with its decisions. */
export default function ActionHistory({ history, assistantId, onBack }) {
  return (
    <section className="agent-subpage" aria-label={copy.actions}>
      <SubpageHeader title={copy.actions} tab="work" onBack={onBack} />
      <ErrorMessage error={history.error} />
      {history.loaded && !history.actions.length && (
        <p className="assistant-note">{copy.noActions}</p>
      )}
      {history.actions
        .slice()
        .reverse()
        .map((action) => (
          <ActionCard
            key={action.id}
            action={action}
            assistantId={assistantId}
            busy={history.busy}
            act={history.act}
          />
        ))}
    </section>
  );
}
```

`web/features/assistants/settings/GrantSelectionPage.jsx`:

```jsx
import React from "react";
import ListCard from "../../../components/ListCard.jsx";
import { CheckboxRow } from "../../../components/ListRow.jsx";
import { assistantCopy } from "../../../lib/i18n/messages/assistants.js";
import { assistantWorkflowCopy as copy } from "../../../lib/i18n/messages/assistant-workflows.js";
import SubpageHeader from "./SubpageHeader.jsx";

/** Choose the projects or pipelines the agent may use; part of the Work draft. */
export default function GrantSelectionPage({
  title,
  items,
  selected,
  disabled,
  onToggle,
  onBack,
}) {
  return (
    <section className="agent-subpage" aria-label={title}>
      <SubpageHeader title={title} tab="work" onBack={onBack} />
      {!items && <p className="assistant-note">{assistantCopy.loading}</p>}
      {items?.length === 0 && <p className="assistant-note">{copy.noResources}</p>}
      {items?.length > 0 && (
        <ListCard label={title}>
          {items.map((item) => (
            <CheckboxRow
              key={item.id}
              label={item.name}
              checked={selected.includes(item.id)}
              disabled={disabled}
              onChange={(on) => onToggle(item.id, on)}
            />
          ))}
        </ListCard>
      )}
    </section>
  );
}
```

- [ ] **Step 5: Implement the tab**

`web/features/assistants/settings/WorkTab.jsx`:

```jsx
import React, { useEffect, useId, useState } from "react";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import GroupLabel from "../../../components/GroupLabel.jsx";
import Icon from "../../../components/Icon.jsx";
import ListCard from "../../../components/ListCard.jsx";
import ListRow, {
  NumberRow,
  ToggleRow,
  unknownValue,
} from "../../../components/ListRow.jsx";
import SaveBar from "../../../components/SaveBar.jsx";
import UnsavedChangesSheet from "../../../components/UnsavedChangesSheet.jsx";
import useTabDraft from "../../../lib/settings/useTabDraft.js";
import api from "../../../lib/api.js";
import { routePath } from "../../../app/routes.js";
import { commonCopy } from "../../../lib/i18n/messages/common.js";
import { assistantCopy } from "../../../lib/i18n/messages/assistants.js";
import { assistantWorkflowCopy as wf } from "../../../lib/i18n/messages/assistant-workflows.js";
import { assistantSettingsCopy as settingsCopy } from "../../../lib/i18n/messages/assistant-settings.js";
import useAssistants from "../useAssistants.js";
import {
  agentRoute,
  grantCount,
  permissionKeys,
  toggleId,
  workServer,
} from "./agent-settings-fields.js";
import { workStep } from "./agent-settings-steps.js";
import useAgentDraftGuard from "./useAgentDraftGuard.js";
import useActionHistory from "./useActionHistory.js";
import ConflictNotice from "./ConflictNotice.jsx";
import ActionHistory from "./ActionHistory.jsx";
import GrantSelectionPage from "./GrantSelectionPage.jsx";

const teamCopy = assistantCopy.team;
const conflictLabels = {
  projectIds: () => wf.projects,
  pipelineIds: () => wf.pipelines,
  memoryWrite: () => wf.memoryWrite,
  autonomous: () => wf.autonomous,
  publish: () => wf.publish,
  teamAutonomous: () => teamCopy.autonomous,
  maxMembers: () => teamCopy.maxMembers,
  runTimeoutMinutes: () => teamCopy.timeout,
};

/** Work: grants, permissions and team policy in one draft, saved in one transaction. */
export default function WorkTab({ assistant, page, go }) {
  const { policies = {}, refresh } = useAssistants();
  const withTeam = !assistant.teamMemberId;
  const teamPolicy = withTeam ? policies[assistant.id] : null;
  const accessId = useId(),
    teamId = useId();
  const [policy, setPolicy] = useState(null),
    [catalog, setCatalog] = useState(null),
    [loadError, setLoadError] = useState("");
  useEffect(() => {
    let active = true;
    Promise.all([
      api(`/assistants/${encodeURIComponent(assistant.id)}/access`),
      api("/assistant-workspace-catalog"),
    ])
      .then(([access, list]) => {
        if (!active) return;
        setPolicy(access);
        setCatalog({ projects: list.projects || [], pipelines: list.pipelines || [] });
      })
      .catch((e) => active && setLoadError(e.message));
    return () => {
      active = false;
    };
  }, [assistant.id]);
  const history = useActionHistory(assistant.id);
  const draft = useTabDraft({
    server: workServer(policy, teamPolicy),
    revisions: { access: policy?.revision, team: teamPolicy?.revision },
  });
  const label = settingsCopy.tabs.work;
  const steps = [workStep({ assistantId: assistant.id, label, withTeam })];
  const after = async (result) => {
    if (result.status === "saved") {
      if (result.results.work?.access) setPolicy(result.results.work.access);
      await refresh();
    }
    return result;
  };
  const save = async () => after(await draft.save(steps));
  const overwrite = async () => after(await draft.overwrite(steps));
  const sheet = useAgentDraftGuard({
    draft,
    assistantId: assistant.id,
    tab: "work",
    label,
    save,
  });
  const bar = (
    <>
      <SaveBar draft={draft} onSave={save} onOverwrite={overwrite} />
      <UnsavedChangesSheet {...sheet} />
    </>
  );
  const back = () => go("work");
  const link = (subpage) => ({
    href: routePath(agentRoute(assistant.id, "work", subpage)),
    onClick: () => go("work", subpage),
  });
  if (page === "actions")
    return (
      <>
        <ActionHistory history={history} assistantId={assistant.id} onBack={back} />
        {bar}
      </>
    );
  if (page === "projects" || page === "pipelines") {
    const key = page === "projects" ? "projectIds" : "pipelineIds";
    return (
      <>
        <GrantSelectionPage
          title={page === "projects" ? wf.projects : wf.pipelines}
          items={catalog?.[page] ?? null}
          selected={draft.values[key]}
          disabled={!policy || draft.saving}
          onToggle={(id, on) => draft.set(key, toggleId(draft.values[key], id, on))}
          onBack={back}
        />
        {bar}
      </>
    );
  }
  const values = draft.values;
  return (
    <>
      {history.pending > 0 && (
        <button
          type="button"
          className="agent-pending-strip"
          onClick={() => go("work", "actions")}
        >
          {settingsCopy.pendingApprovals(history.pending)}
          <Icon name="chevron" size={14} />
        </button>
      )}
      <ConflictNotice draft={draft} labels={conflictLabels} />
      <section id="agent-access" aria-labelledby={accessId}>
        <GroupLabel id={accessId} hint={`${wf.hint} ${wf.policyHint}`}>
          {wf.title}
        </GroupLabel>
        <ErrorMessage error={loadError} />
        <ListCard labelledBy={accessId}>
          <ListRow
            label={wf.projects}
            value={
              catalog
                ? commonCopy.ofCount(
                    grantCount(values.projectIds, catalog.projects),
                    catalog.projects.length,
                  )
                : unknownValue
            }
            disabled={!catalog}
            {...link("projects")}
          />
          <ListRow
            label={wf.pipelines}
            value={
              catalog ? grantCount(values.pipelineIds, catalog.pipelines) : unknownValue
            }
            disabled={!catalog}
            {...link("pipelines")}
          />
          {permissionKeys.map((key) => (
            <ToggleRow
              key={key}
              label={wf[key]}
              checked={values[key]}
              disabled={!policy || draft.saving}
              onChange={(on) => draft.set(key, on)}
            />
          ))}
          <ListRow
            label={wf.actions}
            value={history.loaded ? history.actions.length : unknownValue}
            {...link("actions")}
          />
        </ListCard>
      </section>
      {withTeam && (
        <section id="agent-team" aria-labelledby={teamId}>
          <GroupLabel
            id={teamId}
            hint={`${teamCopy.permissionHint} ${teamCopy.concurrentHint}`}
          >
            {settingsCopy.teamGroup}
          </GroupLabel>
          <ListCard labelledBy={teamId} disabled={!teamPolicy}>
            <ToggleRow
              label={teamCopy.autonomous}
              checked={values.teamAutonomous}
              disabled={!teamPolicy || draft.saving}
              onChange={(on) => draft.set("teamAutonomous", on)}
            />
            <NumberRow
              label={teamCopy.maxMembers}
              value={values.maxMembers}
              min={1}
              max={8}
              disabled={!teamPolicy || draft.saving}
              onChange={(next) => draft.set("maxMembers", next)}
            />
            <NumberRow
              label={teamCopy.timeout}
              value={values.runTimeoutMinutes}
              min={1}
              max={60}
              disabled={!teamPolicy || draft.saving}
              onChange={(next) => draft.set("runTimeoutMinutes", next)}
            />
          </ListCard>
        </section>
      )}
      {bar}
    </>
  );
}
```

- [ ] **Step 6: Wire the tab and narrow the bridge**

In `AgentSettingsPage.jsx` add `import WorkTab from "./WorkTab.jsx";` and set:

```js
const panels = { profile: ProfileTab, capabilities: CapabilitiesTab, work: WorkTab };
```

In `LegacySections.jsx` delete the `if (tab === "work") return (…);` branch and the `AssistantWorkflows`/`AssistantTeamSettings` imports.

- [ ] **Step 7: Run the specs**

Run: `npm run build && npx playwright test tests/browser/assistant-settings-save.spec.js tests/browser/assistant-settings-tabs.spec.js`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
npx prettier --write web/features/assistants/settings tests/helpers/assistant-settings-browser.js tests/browser/assistant-settings-save.spec.js tests/browser/assistant-settings-tabs.spec.js
npx eslint web/features/assistants/settings tests/helpers/assistant-settings-browser.js tests/browser/assistant-settings-save.spec.js tests/browser/assistant-settings-tabs.spec.js
git add web/features/assistants/settings tests/helpers/assistant-settings-browser.js tests/browser/assistant-settings-save.spec.js tests/browser/assistant-settings-tabs.spec.js
git commit -m "feat: save an agent's grants and team policy from the Work tab" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Telegram tab — connection, check-ins and the two-step save

Connection group (status, pause/resume, disconnect, language, app URL, activity and connection rows), the not-connected token form with pairing, the check-in group, the activity and connection subpages, and the heartbeat-then-channel save chain. Reminders and routines keep their current components inside the tab until Task 8.

**Files:**

- Create: `web/features/assistants/settings/useTelegramChannel.js`, `TelegramConnection.jsx`, `TelegramConnectionPage.jsx`, `TelegramActivityPage.jsx`, `ProactivityGroup.jsx`, `TelegramTab.jsx` (all in `web/features/assistants/settings/`)
- Modify: `web/features/assistants/settings/AgentSettingsPage.jsx` (all four `panels`, no bridge)
- Delete: `web/features/assistants/settings/LegacySections.jsx`
- Test: `tests/browser/assistant-settings-save.spec.js`, `tests/browser/assistant-settings-tabs.spec.js`

**Interfaces:**

- Consumes: Task 2 `telegramServer`, `heartbeatStep`, `channelStep`, `channelActivity`, `inProgressStates`, `agentRoute`; Task 3 `useAgentDraftGuard`, `ConflictNotice`, `ConfirmationSheet`, `SubpageHeader`; Step 0 `ToggleRow`, `SelectRow`, `ListRow`, `ListCard`, `GroupLabel`, `SaveBar`, `UnsavedChangesSheet`; `heartbeatIntervals`, `heartbeatRuns`, `browserTimeZone` (`../heartbeat.js`); `RouteLink`; `assistantApi.{channels,createChannel,updateChannel,pairChannel,disconnectChannel,recoverInput,recoverNotification}`.
- Produces:
  - `useTelegramChannel(assistantId) => { channel, loaded, token, setToken, pairing, setPairing, showPair, error, busy, act(operation), connect(), pair(record), reload(), origin }` (polls every 2 s)
  - `ConnectionGroup({ assistant, telegram, draft, go, navigate })` and `PairingBlock({ pairing })` (exports of `TelegramConnection.jsx`)
  - `TelegramConnectionPage({ telegram, onBack })`, `TelegramActivityPage({ assistant, telegram, onBack, navigate })`
  - `ProactivityGroup({ assistant?, values, set(key, value), connected?, creating? })` — region "Acting on its own", `id="agent-proactivity"` (reused by `AgentCreate` in Task 9)
  - `TelegramTab({ assistant, page, go, navigate })` — wrapper region "Telegram" (`id="agent-telegram"`) around the main view and both subpages

- [ ] **Step 1: Write the failing tests**

Append to `tests/browser/assistant-settings-save.spec.js` (extend the fixture import with `connectedChannel`):

```js
test("a Telegram save that fails at the channel reports the saved part and retries only the rest", async ({
  page,
}) => {
  const state = await setup(page, {
    applyUpdates: true,
    assistant: { capabilities: { memory: true, reminders: false } },
    channel: connectedChannel(),
    channelFailures: [{ status: 500, error: "Telegram is unavailable" }],
  });
  await page.goto(baseURL + settingsPath("telegram"));
  await page.getByRole("switch", { name: "Check in on its own" }).check();
  await page.getByLabel("Language of Telegram notices").selectOption("de");
  await saveBar(page).getByRole("button", { name: "Save", exact: true }).click();
  const alert = saveBar(page).getByRole("alert");
  await expect(alert).toContainText("Partially saved: Acting on its own.");
  await expect(alert).toContainText("Telegram is unavailable");
  expect(state.updates).toHaveLength(1);
  expect(state.updates[0].heartbeat.enabled).toBe(true);
  expect(state.channelPatches).toEqual([{ language: "de", revision: 1 }]);
  await saveBar(page).getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => state.channelPatches.length).toBe(2);
  expect(state.updates).toHaveLength(1);
  await expect(saveBar(page)).toHaveCount(0);
});

test("a channel changed elsewhere keeps the edit and can be overwritten", async ({
  page,
}) => {
  const state = await setup(page, { channel: connectedChannel() });
  await page.goto(baseURL + settingsPath("telegram"));
  await page.getByLabel("Language of Telegram notices").selectOption("de");
  state.channel = { ...state.channel, enabled: false, revision: 2 };
  await expect(page.getByRole("button", { name: "Resume Telegram" })).toBeVisible();
  await expect(page.getByLabel("Language of Telegram notices")).toHaveValue("de");
  await saveBar(page).getByRole("button", { name: "Save", exact: true }).click();
  await expect(saveBar(page).getByRole("alert")).toContainText(
    "Changed elsewhere in the meantime.",
  );
  expect(state.channelPatches).toEqual([{ language: "de", revision: 1 }]);
  await saveBar(page).getByRole("button", { name: "Overwrite anyway" }).click();
  await expect.poll(() => state.channelPatches.length).toBe(2);
  expect(state.channelPatches[1]).toEqual({ language: "de", revision: 2 });
  await expect(saveBar(page)).toHaveCount(0);
});
```

Append to `tests/browser/assistant-settings-tabs.spec.js` (extend the fixture import with `connectedChannel`):

```js
test("without Telegram the check-in group waits for a connection", async ({ page }) => {
  await setup(page, { assistant: { capabilities: { memory: true, reminders: false } } });
  await page.goto(baseURL + settingsPath("telegram"));
  await expect(page.getByLabel("Telegram bot token")).toBeVisible();
  await expect(page.getByRole("switch", { name: "Check in on its own" })).toBeDisabled();
  await expect(page.getByRole("region", { name: "Acting on its own" })).toContainText(
    "Needs a paired Telegram chat for this agent.",
  );
});

test("Telegram activity and connection details open as subpages", async ({ page }) => {
  await setup(page, {
    channel: connectedChannel({
      ignoredMessages: { private: 2, group: 1 },
      inputs: [{ id: "a", state: "reply_unavailable", text: "One" }],
    }),
  });
  await page.goto(baseURL + settingsPath("telegram"));
  const panel = page.getByRole("region", { name: "Telegram" });
  await expect(panel.getByRole("link", { name: /^Telegram activity/ })).toContainText(
    "1 needs your decision",
  );
  await panel.getByRole("link", { name: /^Telegram activity/ }).click();
  await expect(page).toHaveURL(/tab=telegram&page=telegram-activity$/);
  await expect(panel.getByText("One")).toBeVisible();
  await page.getByRole("button", { name: "Back to Telegram" }).click();
  await panel.getByRole("link", { name: /^Connection/ }).click();
  await expect(
    panel.getByText("Ignored messages: 2 from other private chats, 1 from groups."),
  ).toBeVisible();
  await expect(panel.getByLabel("Replace bot token")).toBeVisible();
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `npm run build && npx playwright test tests/browser/assistant-settings-save.spec.js tests/browser/assistant-settings-tabs.spec.js -g "Telegram|channel changed|check-in group"`
Expected: FAIL — no "Check in on its own" switch on the Telegram tab.

- [ ] **Step 3: Implement the channel hook**

`web/features/assistants/settings/useTelegramChannel.js`:

```js
import { useCallback, useEffect, useRef, useState } from "react";
import { getLanguage } from "../../../lib/i18n/index.js";
import usePolling from "../usePolling.js";
import { assistantApi } from "../assistant-api.js";

// Telegram notices link back to the address the owner uses AgentPier from.
const browserOrigin = () => window.location.origin;

/** The agent's Telegram channel, polled every 2 s, with its immediate actions. */
export default function useTelegramChannel(assistantId) {
  const [channel, setChannel] = useState(null),
    [loaded, setLoaded] = useState(false),
    [token, setToken] = useState(""),
    [pairing, setPairing] = useState(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const generation = useRef(null);
  const load = useCallback(async () => {
    const ticket = {};
    generation.current = ticket;
    const result = await assistantApi.channels();
    if (generation.current !== ticket) return;
    setChannel(result.channels.find((c) => c.assistantId === assistantId) || null);
    setLoaded(true);
  }, [assistantId]);
  useEffect(
    () => () => {
      generation.current = null;
    },
    [assistantId],
  );
  usePolling(
    async (signal) => {
      try {
        await load();
      } catch (e) {
        if (!signal.aborted) setError(e.message);
      }
    },
    2000,
    { restartKey: assistantId },
  );
  async function act(operation) {
    setBusy(true);
    setError("");
    try {
      await operation();
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const pair = (record) =>
    assistantApi.pairChannel(
      record.id,
      record.revision,
      record.appUrl || browserOrigin(),
      record.language || getLanguage(),
    );
  // A new token for a stored channel replaces the old one (same bot only).
  async function connect() {
    const record = channel
      ? await assistantApi.updateChannel(channel.id, {
          token,
          revision: channel.revision,
        })
      : await assistantApi.createChannel({
          assistantId,
          token,
          appUrl: browserOrigin(),
          language: getLanguage(),
        });
    setToken("");
    setPairing(record.chatId ? null : await pair(record));
  }
  const showPair = Boolean(
    pairing &&
    channel &&
    !channel.enabled &&
    pairing.channel.revision === channel.revision &&
    (!pairing.expiresAt || pairing.expiresAt > Date.now()),
  );
  return {
    channel,
    loaded,
    token,
    setToken,
    pairing,
    setPairing,
    showPair,
    error,
    busy,
    act,
    connect,
    pair,
    reload: load,
    origin: browserOrigin(),
  };
}
```

- [ ] **Step 4: Implement the connection group and subpages**

`web/features/assistants/settings/TelegramConnection.jsx`:

```jsx
import React, { useId } from "react";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import GroupLabel from "../../../components/GroupLabel.jsx";
import ListCard from "../../../components/ListCard.jsx";
import ListRow, { SelectRow, unknownValue } from "../../../components/ListRow.jsx";
import { routePath } from "../../../app/routes.js";
import { assistantCopy } from "../../../lib/i18n/messages/assistants.js";
import { assistantSettingsCopy as settingsCopy } from "../../../lib/i18n/messages/assistant-settings.js";
import { assistantApi } from "../assistant-api.js";
import RouteLink from "../RouteLink.jsx";
import { agentRoute, channelActivity } from "./agent-settings-fields.js";

/** The start message and link that pair the owner's private chat. */
export function PairingBlock({ pairing }) {
  const copy = assistantCopy.channel;
  return (
    <div className="list-card agent-pairing">
      <p>{copy.pairHint}</p>
      <code className="assistant-pair-code">/start {pairing.code}</code>
      <a
        className="button secondary"
        href={pairing.url}
        target="_blank"
        rel="noopener noreferrer"
      >
        {copy.pair}
      </a>
    </div>
  );
}

function activityStatus({ attention, entries }) {
  if (attention) return { tone: "warn", text: settingsCopy.activityAttention(attention) };
  return entries.length ? { tone: "ok", text: settingsCopy.allDelivered } : undefined;
}

/** "Verbindung": the bot's state and actions, language and address drafts, subpage rows. */
export function ConnectionGroup({ assistant, telegram, draft, go, navigate }) {
  const id = useId();
  const copy = assistantCopy.channel;
  const { channel } = telegram;
  const connected = Boolean(channel?.hasSecret);
  const activity = channelActivity(channel);
  const link = (page) => ({
    href: routePath(agentRoute(assistant.id, "telegram", page)),
    onClick: () => go("telegram", page),
  });
  const toggle = () =>
    telegram.act(() =>
      assistantApi.updateChannel(channel.id, {
        enabled: !channel.enabled,
        revision: channel.revision,
      }),
    );
  return (
    <section aria-labelledby={id}>
      <GroupLabel
        id={id}
        hint={`${copy.description} ${copy.languageHint} ${copy.appUrlHint}`}
      >
        {settingsCopy.connectionGroup}
      </GroupLabel>
      <ErrorMessage error={telegram.error} />
      {channel?.diagnostic && (
        <p role="status" className="assistant-notice">
          {copy.diagnostics[channel.diagnostic] || copy.failed}
        </p>
      )}
      {channel?.notificationDiagnostic && (
        <p className="assistant-notice">
          {copy.diagnostics[channel.notificationDiagnostic] || copy.failed}
        </p>
      )}
      {!telegram.loaded ? (
        <ListCard labelledBy={id}>
          <ListRow label={copy.title} value={unknownValue} />
        </ListCard>
      ) : !connected ? (
        <form
          className="list-card agent-fields"
          onSubmit={(event) => {
            event.preventDefault();
            telegram.act(telegram.connect);
          }}
        >
          {channel && (
            <p className="agent-row-note">
              @{channel.username} · {copy.disconnected}
            </p>
          )}
          <label className="agent-field">
            {copy.token}
            <input
              required
              type="password"
              autoComplete="new-password"
              maxLength={256}
              value={telegram.token}
              onChange={(event) => telegram.setToken(event.target.value)}
            />
          </label>
          <p className="agent-row-note">{copy.botHint}</p>
          <div className="agent-field">
            <button className="button primary" disabled={telegram.busy}>
              {copy.connect}
            </button>
          </div>
        </form>
      ) : (
        <ListCard labelledBy={id}>
          <ListRow
            label={`@${channel.username}`}
            sub={channel.enabled ? copy.connected(channel.chatId) : copy.paused}
          />
          {channel.chatId && (
            <ListRow
              label={channel.enabled ? copy.pause : copy.resume}
              chevron={false}
              disabled={telegram.busy}
              onClick={toggle}
            />
          )}
          <ListRow
            label={copy.disconnect}
            chevron={false}
            className="danger"
            disabled={telegram.busy}
            onClick={() =>
              telegram.act(() =>
                assistantApi.disconnectChannel(channel.id, channel.revision),
              )
            }
          />
          <SelectRow
            label={copy.language}
            value={draft.values.language}
            options={[
              { value: "de", label: copy.languageDe },
              { value: "en", label: copy.languageEn },
            ]}
            disabled={draft.saving}
            onChange={(value) => draft.set("language", value)}
          />
          <label className="list-row agent-field">
            {copy.appUrl}
            <input
              type="url"
              value={draft.values.appUrl}
              placeholder={telegram.origin}
              maxLength={2048}
              disabled={draft.saving}
              onChange={(event) => draft.set("appUrl", event.target.value)}
            />
          </label>
          <ListRow
            label={copy.activity}
            status={activityStatus(activity)}
            value={activity.entries.length ? undefined : settingsCopy.noActivity}
            {...link("telegram-activity")}
          />
          <ListRow label={settingsCopy.connectionPage} {...link("telegram-connection")} />
        </ListCard>
      )}
      {telegram.showPair && <PairingBlock pairing={telegram.pairing} />}
      <RouteLink route={{ view: "accounts" }} navigate={navigate}>
        {copy.speechLink}
      </RouteLink>
    </section>
  );
}
```

`web/features/assistants/settings/TelegramConnectionPage.jsx`:

```jsx
import React from "react";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import { commonCopy } from "../../../lib/i18n/messages/common.js";
import { assistantCopy } from "../../../lib/i18n/messages/assistants.js";
import { assistantSettingsCopy as settingsCopy } from "../../../lib/i18n/messages/assistant-settings.js";
import SubpageHeader from "./SubpageHeader.jsx";
import { PairingBlock } from "./TelegramConnection.jsx";

/** Bot identity, diagnostics, ignored messages, a new pairing code and token replacement. */
export default function TelegramConnectionPage({ telegram, onBack }) {
  const copy = assistantCopy.channel;
  const { channel } = telegram;
  const ignored = channel.ignoredMessages || {};
  return (
    <>
      <SubpageHeader
        title={settingsCopy.connectionPage}
        tab="telegram"
        onBack={onBack}
        hint={copy.description}
      />
      <ErrorMessage error={telegram.error} />
      <div className="list-card agent-fields">
        <p className="agent-row-note">
          <strong>@{channel.username}</strong> ·{" "}
          {channel.enabled
            ? copy.connected(channel.chatId)
            : channel.hasSecret
              ? copy.paused
              : copy.disconnected}
        </p>
        {channel.diagnostic && (
          <p role="status" className="agent-row-note">
            {copy.diagnostics[channel.diagnostic] || copy.failed}
          </p>
        )}
        {Boolean(ignored.private || ignored.group) && (
          <p className="agent-row-note">
            {copy.ignored(ignored.private || 0, ignored.group || 0)}
          </p>
        )}
        {channel.notificationDiagnostic && (
          <p className="agent-row-note">
            {copy.diagnostics[channel.notificationDiagnostic] || copy.failed}
          </p>
        )}
      </div>
      {channel.hasSecret && !channel.enabled && (
        <button
          type="button"
          className="button secondary"
          disabled={telegram.busy}
          onClick={() =>
            telegram.act(async () => telegram.setPairing(await telegram.pair(channel)))
          }
        >
          {copy.newPair}
        </button>
      )}
      {telegram.showPair && <PairingBlock pairing={telegram.pairing} />}
      {channel.hasSecret && (
        <form
          className="list-card agent-fields"
          onSubmit={(event) => {
            event.preventDefault();
            telegram.act(telegram.connect);
          }}
        >
          <label className="agent-field">
            {settingsCopy.replaceToken}
            <input
              required
              type="password"
              autoComplete="new-password"
              maxLength={256}
              value={telegram.token}
              onChange={(event) => telegram.setToken(event.target.value)}
            />
          </label>
          <p className="agent-row-note">{settingsCopy.replaceTokenHint}</p>
          <div className="agent-field">
            <button className="button secondary" disabled={telegram.busy}>
              {commonCopy.saveToken}
            </button>
          </div>
        </form>
      )}
    </>
  );
}
```

`web/features/assistants/settings/TelegramActivityPage.jsx` (the activity list of `TelegramSettings.jsx`, same texts and recovery requests):

```jsx
import React from "react";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import { assistantCopy } from "../../../lib/i18n/messages/assistants.js";
import { assistantSettingsCopy as settingsCopy } from "../../../lib/i18n/messages/assistant-settings.js";
import { assistantApi } from "../assistant-api.js";
import RouteLink from "../RouteLink.jsx";
import {
  channelActivity,
  inProgressStates,
  recoveryStates,
} from "./agent-settings-fields.js";
import SubpageHeader from "./SubpageHeader.jsx";

/** Telegram inputs and notices with retry, acknowledge and "review agent chat". */
export default function TelegramActivityPage({ assistant, telegram, onBack, navigate }) {
  const copy = assistantCopy.channel;
  const { channel } = telegram;
  const { visible } = channelActivity(channel);
  const recover = (entry, action) =>
    telegram.act(() =>
      (entry.notification ? assistantApi.recoverNotification : assistantApi.recoverInput)(
        channel.id,
        entry.id,
        action,
      ),
    );
  return (
    <>
      <SubpageHeader title={copy.activity} tab="telegram" onBack={onBack} />
      <ErrorMessage error={telegram.error} />
      {!visible.length && <p className="assistant-note">{settingsCopy.noActivity}</p>}
      <div className="assistant-channel-inputs">
        {visible.map((entry) => (
          <article className="assistant-card" key={entry.id}>
            <strong>{copy.states[entry.state] || copy.failed}</strong>
            {entry.notification && (
              <p className="assistant-note">{copy.teamNotification}</p>
            )}
            <p className="assistant-channel-text">{entry.text || copy.voice}</p>
            {entry.diagnostic && (
              <p className="assistant-note">
                {copy.diagnostics[entry.diagnostic] || copy.failed}
              </p>
            )}
            {entry.diagnosticDetail && (
              <p className="assistant-note">
                <code>{entry.diagnosticDetail}</code>
              </p>
            )}
            {inProgressStates.includes(entry.state) && (
              <p className="assistant-note">{copy.inProgress}</p>
            )}
            <div className="assistant-actions">
              {["transcription_failed", "delivery_failed"].includes(entry.state) &&
                entry.diagnostic !== "CHANNEL_DESTINATION_CHANGED" && (
                  <button
                    className="button secondary"
                    disabled={telegram.busy}
                    onClick={() => recover(entry, "retry")}
                  >
                    {copy.retry}
                  </button>
                )}
              {(entry.needsReview || recoveryStates.includes(entry.state)) && (
                <button
                  className="button secondary"
                  disabled={telegram.busy}
                  onClick={() => recover(entry, "review")}
                >
                  {copy.review}
                </button>
              )}
              {entry.state === "model_uncertain" && (
                <RouteLink
                  route={{
                    view: "agents",
                    assistantId: assistant.id,
                    conversationId: channel.conversationId,
                  }}
                  navigate={navigate}
                >
                  {copy.openChat}
                </RouteLink>
              )}
            </div>
          </article>
        ))}
      </div>
    </>
  );
}
```

- [ ] **Step 5: Implement the check-in group**

`web/features/assistants/settings/ProactivityGroup.jsx`:

```jsx
import React, { useId } from "react";
import GroupLabel from "../../../components/GroupLabel.jsx";
import ListCard from "../../../components/ListCard.jsx";
import { SelectRow, ToggleRow } from "../../../components/ListRow.jsx";
import { assistantCopy } from "../../../lib/i18n/messages/assistants.js";
import { assistantProactivityCopy as copy } from "../../../lib/i18n/messages/assistant-proactivity.js";
import { assistantSettingsCopy as settingsCopy } from "../../../lib/i18n/messages/assistant-settings.js";
import { browserTimeZone, heartbeatIntervals, heartbeatRuns } from "../heartbeat.js";

const hours = Array.from({ length: 25 }, (_, hour) => hour);
const hourOptions = (list) =>
  list.map((hour) => ({ value: String(hour), label: copy.hour(hour) }));

/**
 * Scheduled check-ins: they need saved memory and a connected Telegram chat; the extra
 * model runs are shown. A new agent switches them on after saving.
 */
export default function ProactivityGroup({
  assistant,
  values,
  set,
  connected = false,
  creating = false,
}) {
  const id = useId();
  const memory = assistant?.capabilities?.memory === true;
  const available = !creating && memory && connected;
  const on = available && values.heartbeatEnabled === true;
  const sub = creating
    ? assistantCopy.personal.availableAfterSaving
    : !memory
      ? settingsCopy.heartbeatNeedsMemory
      : !connected
        ? copy.heartbeatChannel
        : undefined;
  // A saved zone stays until the owner adopts the browser's (after travelling).
  const zone = browserTimeZone();
  return (
    <section id="agent-proactivity" aria-labelledby={id}>
      <GroupLabel id={id} hint={`${copy.intro} ${copy.heartbeatDescription}`}>
        {copy.title}
      </GroupLabel>
      <ListCard labelledBy={id} disabled={!creating && !available}>
        <ToggleRow
          label={copy.heartbeat}
          sub={sub}
          checked={on}
          disabled={!available}
          onChange={(next) => set("heartbeatEnabled", next)}
        />
        {on && (
          <>
            <SelectRow
              label={copy.interval}
              value={values.interval}
              options={Object.keys(heartbeatIntervals).map((key) => ({
                value: key,
                label: copy.intervals[key],
              }))}
              onChange={(next) => set("interval", next)}
            />
            <SelectRow
              label={copy.activeFrom}
              value={String(values.start)}
              options={hourOptions(hours.slice(0, 24))}
              onChange={(next) => {
                const start = Number(next);
                set("start", start);
                if (values.end <= start) set("end", start + 1);
              }}
            />
            <SelectRow
              label={copy.activeUntil}
              value={String(values.end)}
              options={hourOptions(hours.slice(values.start + 1))}
              onChange={(next) => set("end", Number(next))}
            />
            <div className="agent-row-note">
              <p>{copy.heartbeatReply}</p>
              <p>
                {copy.timeZone(values.timeZone)}{" "}
                {copy.heartbeatCost(heartbeatRuns(values))}
              </p>
              {zone !== values.timeZone && (
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => set("timeZone", zone)}
                >
                  {copy.adoptZone(zone)}
                </button>
              )}
            </div>
          </>
        )}
      </ListCard>
    </section>
  );
}
```

- [ ] **Step 6: Implement the tab**

`web/features/assistants/settings/TelegramTab.jsx`:

```jsx
import React from "react";
import SaveBar from "../../../components/SaveBar.jsx";
import UnsavedChangesSheet from "../../../components/UnsavedChangesSheet.jsx";
import useTabDraft from "../../../lib/settings/useTabDraft.js";
import { assistantCopy } from "../../../lib/i18n/messages/assistants.js";
import { assistantProactivityCopy as proactivity } from "../../../lib/i18n/messages/assistant-proactivity.js";
import { assistantSettingsCopy as settingsCopy } from "../../../lib/i18n/messages/assistant-settings.js";
import useAssistants from "../useAssistants.js";
import AssistantReminders from "../AssistantReminders.jsx";
import AssistantRoutines from "../AssistantRoutines.jsx";
import { telegramServer } from "./agent-settings-fields.js";
import { channelStep, heartbeatStep } from "./agent-settings-steps.js";
import useAgentDraftGuard from "./useAgentDraftGuard.js";
import useTelegramChannel from "./useTelegramChannel.js";
import ConflictNotice from "./ConflictNotice.jsx";
import ConfirmationSheet from "./ConfirmationSheet.jsx";
import ProactivityGroup from "./ProactivityGroup.jsx";
import { ConnectionGroup } from "./TelegramConnection.jsx";
import TelegramConnectionPage from "./TelegramConnectionPage.jsx";
import TelegramActivityPage from "./TelegramActivityPage.jsx";

const channelCopy = assistantCopy.channel;
const conflictLabels = {
  heartbeatEnabled: () => proactivity.heartbeat,
  interval: () => proactivity.interval,
  start: () => proactivity.activeFrom,
  end: () => proactivity.activeUntil,
  timeZone: () => proactivity.title,
  language: () => channelCopy.language,
  appUrl: () => channelCopy.appUrl,
};

/** Telegram: connection, check-ins, reminders and routines; heartbeat then channel save. */
export default function TelegramTab({ assistant, page, go, navigate }) {
  const { refresh } = useAssistants();
  const telegram = useTelegramChannel(assistant.id);
  const { channel } = telegram;
  const connected = Boolean(channel?.hasSecret);
  const draft = useTabDraft({
    server: telegramServer(assistant, channel),
    revisions: { assistant: assistant.revision, channel: channel?.revision },
  });
  const label = settingsCopy.tabs.telegram;
  const steps = [
    heartbeatStep({ assistant, label: proactivity.title }),
    ...(channel
      ? [channelStep({ channelId: channel.id, label: settingsCopy.connectionGroup })]
      : []),
  ];
  const after = async (result) => {
    if (result.completed?.length) await Promise.all([refresh(), telegram.reload()]);
    return result;
  };
  const save = async () => after(await draft.save(steps));
  const overwrite = async () => after(await draft.overwrite(steps));
  const sheet = useAgentDraftGuard({
    draft,
    assistantId: assistant.id,
    tab: "telegram",
    label,
    save,
  });
  const back = () => go("telegram");
  const subpage =
    channel && page === "telegram-activity" ? (
      <TelegramActivityPage
        assistant={assistant}
        telegram={telegram}
        onBack={back}
        navigate={navigate}
      />
    ) : channel && page === "telegram-connection" ? (
      <TelegramConnectionPage telegram={telegram} onBack={back} />
    ) : null;
  return (
    <section id="agent-telegram" aria-label={channelCopy.title}>
      {subpage ?? (
        <>
          <ConflictNotice draft={draft} labels={conflictLabels} />
          <ConnectionGroup
            assistant={assistant}
            telegram={telegram}
            draft={draft}
            go={go}
            navigate={navigate}
          />
          <ProactivityGroup
            assistant={assistant}
            values={draft.values}
            set={draft.set}
            connected={connected}
          />
          {assistant.capabilities?.reminders && (
            <>
              <AssistantReminders assistantId={assistant.id} />
              <AssistantRoutines assistantId={assistant.id} />
            </>
          )}
        </>
      )}
      <SaveBar
        draft={draft}
        onSave={save}
        onOverwrite={overwrite}
        note={assistantCopy.pendingConfigShort}
      />
      <ConfirmationSheet confirmation={draft.confirmation} />
      <UnsavedChangesSheet {...sheet} />
    </section>
  );
}
```

- [ ] **Step 7: Wire all four tabs and remove the bridge**

In `AgentSettingsPage.jsx`: add `import TelegramTab from "./TelegramTab.jsx";`, delete the `LegacySections` import, set

```js
const panels = {
  profile: ProfileTab,
  capabilities: CapabilitiesTab,
  work: WorkTab,
  telegram: TelegramTab,
};
```

and replace the `{Panel ? (…) : (…)}` expression with `<Panel key={assistant.id} {...props} />`. Then delete the bridge:

```bash
git rm web/features/assistants/settings/LegacySections.jsx
```

- [ ] **Step 8: Run the specs**

Run: `npm run build && npx playwright test tests/browser/assistant-settings-save.spec.js tests/browser/assistant-settings-tabs.spec.js`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
npx prettier --write web/features/assistants/settings tests/browser/assistant-settings-save.spec.js tests/browser/assistant-settings-tabs.spec.js
npx eslint web/features/assistants/settings tests/browser/assistant-settings-save.spec.js tests/browser/assistant-settings-tabs.spec.js
git add -A web/features/assistants/settings tests/browser/assistant-settings-save.spec.js tests/browser/assistant-settings-tabs.spec.js
git commit -m "feat: manage Telegram and check-ins from the agent's Telegram tab" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Reminders and routines in the Telegram tab

Lists with "+ Erinnerung erstellen" / "+ Routine" on the group label, details expanding in place (history, review, pause/resume, delete, run now, event status). Immediate actions, no draft.

**Files:**

- Create: `web/features/assistants/settings/RemindersGroup.jsx`, `web/features/assistants/settings/RoutinesGroup.jsx`
- Modify: `web/features/assistants/settings/TelegramTab.jsx`, `web/features/assistants/agent-settings.css`
- Test: `tests/browser/assistant-settings-tabs.spec.js`

**Interfaces:**

- Consumes: `assistantApi.{reminders,createReminder,updateReminder,removeReminder,reviewReminder,reminderRuns}`, `routineApi.{list,create,update,remove,trigger}` (`../routine-api.js`), `usePolling`, `formatTimestamp`; Step 0 `GroupLabel({ id, hint, action })`, `ListCard({ labelledBy, disabled })`, `Icon`.
- Produces: `RemindersGroup({ assistantId, connected })` (region "Reminders", `id="agent-reminders"`), `RoutinesGroup({ assistantId, connected })` (region "Routines", `id="agent-routines"`). Row buttons carry `aria-expanded`; review-required and event notices stay visible below the row.

- [ ] **Step 1: Write the failing test**

Append to `tests/browser/assistant-settings-tabs.spec.js`:

```js
test("reminders open their details in place and wait for Telegram before creating", async ({
  page,
}) => {
  await setup(page, {
    assistant: { capabilities: { memory: false, reminders: true } },
    reminders: [
      {
        id: "r1",
        name: "Water",
        status: "ready",
        enabled: true,
        revision: 1,
        schedule: { kind: "at" },
        nextRunAtMs: Date.UTC(2026, 9, 20, 13, 5),
      },
    ],
  });
  await page.goto(baseURL + settingsPath("telegram"));
  const reminders = page.getByRole("region", { name: "Reminders" });
  await expect(
    reminders.getByRole("button", { name: "+ Create reminder" }),
  ).toBeDisabled();
  await expect(reminders).toContainText("Receive one-time or daily reminders");
  const row = reminders.getByRole("button", { name: /^Water/ });
  await expect(row).toHaveAttribute("aria-expanded", "false");
  await row.click();
  await expect(row).toHaveAttribute("aria-expanded", "true");
  await expect(reminders.getByRole("button", { name: "Pause reminder" })).toBeEnabled();
  await expect(reminders.getByRole("button", { name: "Remove reminder" })).toBeEnabled();
  await expect(page.getByRole("region", { name: "Routines" })).toContainText(
    "No routines yet.",
  );
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm run build && npx playwright test tests/browser/assistant-settings-tabs.spec.js -g "reminders open"`
Expected: FAIL — no button "+ Create reminder".

- [ ] **Step 3: Implement the reminders group**

`web/features/assistants/settings/RemindersGroup.jsx` (create form and actions as in `AssistantReminders.jsx`):

```jsx
import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import GroupLabel from "../../../components/GroupLabel.jsx";
import Icon from "../../../components/Icon.jsx";
import ListCard from "../../../components/ListCard.jsx";
import { formatTimestamp } from "../../../lib/i18n/index.js";
import { commonCopy } from "../../../lib/i18n/messages/common.js";
import { assistantCopy } from "../../../lib/i18n/messages/assistants.js";
import { assistantSettingsCopy as settingsCopy } from "../../../lib/i18n/messages/assistant-settings.js";
import { assistantApi } from "../assistant-api.js";
import usePolling from "../usePolling.js";

const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Reminders delivered to the paired Telegram chat; every action applies at once. */
export default function RemindersGroup({ assistantId, connected }) {
  const copy = assistantCopy.personal;
  const id = useId();
  const [items, setItems] = useState([]),
    [runs, setRuns] = useState({}),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [creating, setCreating] = useState(false),
    [open, setOpen] = useState(null);
  const [name, setName] = useState(""),
    [message, setMessage] = useState(""),
    [repeat, setRepeat] = useState("once"),
    [at, setAt] = useState(""),
    [time, setTime] = useState("09:00"),
    [timezone, setTimezone] = useState(browserZone());
  const identity = useRef(crypto.randomUUID()),
    alive = useRef(true);
  const refresh = useCallback(async () => {
    const result = await assistantApi.reminders(assistantId);
    if (alive.current) setItems(result.reminders || []);
  }, [assistantId]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, [refresh]);
  usePolling(
    () =>
      refresh().catch((e) => {
        if (alive.current) setError(e.message);
      }),
    10000,
    { restartKey: assistantId },
  );
  async function act(operation) {
    setBusy(true);
    setError("");
    try {
      await operation();
      return true;
    } catch (e) {
      if (alive.current) setError(e.message);
      return false;
    } finally {
      try {
        await refresh();
      } catch (e) {
        if (alive.current) setError(e.message);
      }
      if (alive.current) setBusy(false);
    }
  }
  async function create(event) {
    event.preventDefault();
    const done = await act(async () => {
      const date = new Date(at),
        [hours, minutes] = time.split(":").map(Number);
      if (repeat === "once" && !Number.isFinite(date.getTime()))
        throw Error(copy.invalidTime);
      await assistantApi.createReminder(assistantId, {
        clientRequestId: identity.current,
        name,
        message,
        schedule:
          repeat === "once"
            ? { kind: "at", at: date.toISOString() }
            : { kind: "cron", expr: `${minutes} ${hours} * * *`, tz: timezone },
      });
      identity.current = crypto.randomUUID();
      setName("");
      setMessage("");
    });
    if (done && alive.current) setCreating(false);
  }
  const status = (item) =>
    item.status !== "ready"
      ? copy.states[item.status]
      : item.enabled
        ? copy.states.active
        : item.schedule?.kind === "at" && item.lastRunStatus === "ok"
          ? copy.states.completed
          : copy.states.paused;
  return (
    <section id="agent-reminders" aria-labelledby={id}>
      <GroupLabel
        id={id}
        hint={connected ? copy.remindersHint : undefined}
        action={{
          label: settingsCopy.addReminder,
          onClick: () => setCreating((value) => !value),
          disabled: !connected || busy,
        }}
      >
        {copy.reminders}
      </GroupLabel>
      {!connected && <p className="assistant-note">{copy.remindersHint}</p>}
      <ErrorMessage error={error} />
      {creating && connected && (
        <form
          className="list-card agent-fields"
          onSubmit={create}
          onChange={() => {
            identity.current = crypto.randomUUID();
          }}
        >
          <label className="agent-field">
            {copy.reminderName}
            <input
              disabled={busy}
              required
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="agent-field">
            {copy.reminderText}
            <textarea
              rows={3}
              disabled={busy}
              required
              maxLength={8192}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
          </label>
          <label className="agent-field">
            {copy.repeat}
            <select
              disabled={busy}
              value={repeat}
              onChange={(e) => setRepeat(e.target.value)}
            >
              <option value="once">{copy.once}</option>
              <option value="daily">{copy.daily}</option>
            </select>
          </label>
          {repeat === "once" ? (
            <label className="agent-field">
              {copy.when}
              <input
                type="datetime-local"
                disabled={busy}
                required
                value={at}
                onChange={(e) => setAt(e.target.value)}
              />
              <span className="assistant-note">{copy.localTime(browserZone())}</span>
            </label>
          ) : (
            <>
              <label className="agent-field">
                {copy.time}
                <input
                  type="time"
                  disabled={busy}
                  required
                  value={time}
                  onChange={(e) => setTime(e.target.value)}
                />
              </label>
              <label className="agent-field">
                {copy.timezone}
                <input
                  disabled={busy}
                  required
                  value={timezone}
                  onChange={(e) => setTimezone(e.target.value)}
                />
              </label>
            </>
          )}
          <div className="agent-field assistant-actions">
            <button className="button primary" disabled={busy}>
              {copy.createReminder}
            </button>
            <button
              type="button"
              className="button secondary"
              onClick={() => setCreating(false)}
            >
              {commonCopy.cancel}
            </button>
          </div>
        </form>
      )}
      <ListCard labelledBy={id} disabled={!connected}>
        {!items.length && <p className="agent-row-note">{copy.noReminders}</p>}
        {items.map((item) => (
          <React.Fragment key={item.id}>
            <div className="list-row two-line">
              <button
                type="button"
                className="list-row-main"
                aria-expanded={open === item.id}
                onClick={() => setOpen(open === item.id ? null : item.id)}
              >
                <span className="list-row-text">
                  <span className="list-row-label">
                    {item.name || copy.unknownReminder}
                  </span>
                  <span className="list-row-sub">
                    <span>{status(item)}</span>
                    {item.nextRunAtMs && (
                      <span className="agent-sub-part">
                        {copy.nextRun(formatTimestamp(item.nextRunAtMs))}
                      </span>
                    )}
                  </span>
                </span>
                <Icon name="down" size={14} className="list-row-chevron" />
              </button>
            </div>
            {item.reviewRequired && (
              <div className="agent-row-note">
                <p>{copy.reviewReminderHint}</p>
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() =>
                    act(() => assistantApi.reviewReminder(assistantId, item.id))
                  }
                >
                  {copy.reviewReminder}
                </button>
              </div>
            )}
            {open === item.id && (
              <div className="agent-detail">
                {item.deliveryState && (
                  <p>
                    {copy.telegramDelivery(
                      assistantCopy.channel.states[item.deliveryState] ||
                        copy.states.unknown,
                    )}
                  </p>
                )}
                <div className="assistant-actions">
                  {item.status === "ready" && (
                    <button
                      className="button secondary"
                      disabled={busy}
                      onClick={() =>
                        act(() =>
                          assistantApi.updateReminder(assistantId, item.id, {
                            enabled: !item.enabled,
                            revision: item.revision,
                          }),
                        )
                      }
                    >
                      {item.enabled ? copy.pauseReminder : copy.resumeReminder}
                    </button>
                  )}
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() =>
                      act(() => assistantApi.removeReminder(assistantId, item.id))
                    }
                  >
                    {copy.removeReminder}
                  </button>
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() =>
                      act(async () => {
                        const result = await assistantApi.reminderRuns(
                          assistantId,
                          item.id,
                        );
                        if (alive.current)
                          setRuns((current) => ({
                            ...current,
                            [item.id]: result.entries,
                          }));
                      })
                    }
                  >
                    {copy.history}
                  </button>
                </div>
                {runs[item.id]?.length === 0 && <p>{copy.noRuns}</p>}
                {runs[item.id]?.map((run, index) => (
                  <p key={index}>
                    {formatTimestamp(run.runAtMs)} ·{" "}
                    {copy.states[run.completionStatus] ||
                      copy.states[run.status] ||
                      copy.states.unknown}
                  </p>
                ))}
              </div>
            )}
          </React.Fragment>
        ))}
      </ListCard>
    </section>
  );
}
```

- [ ] **Step 4: Implement the routines group**

`web/features/assistants/settings/RoutinesGroup.jsx` (create form, trigger handling and actions as in `AssistantRoutines.jsx`):

```jsx
import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import GroupLabel from "../../../components/GroupLabel.jsx";
import Icon from "../../../components/Icon.jsx";
import ListCard from "../../../components/ListCard.jsx";
import { formatTimestamp } from "../../../lib/i18n/index.js";
import { commonCopy } from "../../../lib/i18n/messages/common.js";
import { routineCopy as copy } from "../../../lib/i18n/messages/assistant-routines.js";
import { assistantSettingsCopy as settingsCopy } from "../../../lib/i18n/messages/assistant-settings.js";
import { routineApi } from "../routine-api.js";

function scheduleLabel(trigger) {
  if (trigger?.kind === "event")
    return trigger.eventKind === "coding.completed" ? copy.codingCompleted : copy.manual;
  if (trigger?.kind === "at") return formatTimestamp(trigger.at);
  const daily = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(trigger?.expr || "");
  return daily
    ? copy.dailyAt(
        `${daily[2].padStart(2, "0")}:${daily[1].padStart(2, "0")}`,
        trigger.tz,
      )
    : copy.scheduled;
}
const stateOf = (item) =>
  copy.states[
    item.status === "ready" ? (item.enabled ? "active" : "paused") : item.status
  ] || copy.states.unknown;

/** Routines whose results go to the paired Telegram chat; every action applies at once. */
export default function RoutinesGroup({ assistantId, connected }) {
  const id = useId();
  const [items, setItems] = useState([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [creating, setCreating] = useState(false),
    [open, setOpen] = useState(null),
    [events, setEvents] = useState({});
  const [name, setName] = useState(""),
    [prompt, setPrompt] = useState(""),
    [trigger, setTrigger] = useState("daily"),
    [eventKind, setEventKind] = useState("manual"),
    [time, setTime] = useState("09:00"),
    [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const alive = useRef(true),
    generation = useRef(0),
    identity = useRef(crypto.randomUUID()),
    eventIds = useRef(new Map());
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    const result = await routineApi.list(assistantId);
    if (alive.current && request === generation.current) setItems(result.routines || []);
  }, [assistantId]);
  useEffect(() => {
    alive.current = true;
    refresh().catch((e) => {
      if (alive.current) setError(e.message);
    });
    return () => {
      alive.current = false;
    };
  }, [refresh]);
  async function act(operation) {
    if (busy) return false;
    ++generation.current;
    setBusy(true);
    setError("");
    try {
      await operation();
      return true;
    } catch (e) {
      if (alive.current) setError(e.message);
      return false;
    } finally {
      try {
        await refresh();
      } catch (e) {
        if (alive.current) setError(e.message);
      }
      if (alive.current) setBusy(false);
    }
  }
  async function create(event) {
    event.preventDefault();
    const done = await act(async () => {
      const [hours, minutes] = time.split(":").map(Number);
      if (
        trigger === "daily" &&
        (!Number.isInteger(hours) ||
          !Number.isInteger(minutes) ||
          hours > 23 ||
          minutes > 59)
      )
        throw Error(copy.invalidTime);
      await routineApi.create(assistantId, {
        clientRequestId: identity.current,
        name,
        prompt,
        trigger:
          trigger === "event"
            ? { kind: "event", eventKind }
            : { kind: "cron", expr: `${minutes} ${hours} * * *`, tz: timezone },
      });
      if (alive.current) {
        setName("");
        setPrompt("");
        identity.current = crypto.randomUUID();
      }
    });
    if (done && alive.current) setCreating(false);
  }
  async function run(item) {
    const eventId = eventIds.current.get(item.id) || crypto.randomUUID();
    eventIds.current.set(item.id, eventId);
    const receipt = await routineApi.trigger(assistantId, item.id, { eventId });
    if (receipt.status !== "unknown") eventIds.current.delete(item.id);
    if (alive.current) setEvents((old) => ({ ...old, [item.id]: receipt.status }));
  }
  return (
    <section id="agent-routines" aria-labelledby={id}>
      <GroupLabel
        id={id}
        hint={connected ? copy.description : undefined}
        action={{
          label: settingsCopy.addRoutine,
          onClick: () => setCreating((value) => !value),
          disabled: !connected || busy,
        }}
      >
        {copy.title}
      </GroupLabel>
      {!connected && <p className="assistant-note">{copy.description}</p>}
      <ErrorMessage error={error} />
      {creating && connected && (
        <form
          className="list-card agent-fields"
          onSubmit={create}
          onChange={() => {
            identity.current = crypto.randomUUID();
          }}
        >
          <label className="agent-field">
            {copy.name}
            <input
              required
              disabled={busy}
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="agent-field">
            {copy.prompt}
            <textarea
              required
              disabled={busy}
              maxLength={8192}
              rows={3}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
          </label>
          <label className="agent-field">
            {copy.trigger}
            <select
              disabled={busy}
              value={trigger}
              onChange={(e) => setTrigger(e.target.value)}
            >
              <option value="daily">{copy.daily}</option>
              <option value="event">{copy.event}</option>
            </select>
          </label>
          {trigger === "event" ? (
            <label className="agent-field">
              {copy.eventKind}
              <select
                disabled={busy}
                value={eventKind}
                onChange={(e) => setEventKind(e.target.value)}
              >
                <option value="manual">{copy.manual}</option>
                <option value="coding.completed">{copy.codingCompleted}</option>
              </select>
            </label>
          ) : (
            <>
              <label className="agent-field">
                {copy.time}
                <input
                  type="time"
                  required
                  disabled={busy}
                  value={time}
                  onChange={(e) => setTime(e.target.value)}
                />
              </label>
              <label className="agent-field">
                {copy.timezone}
                <input
                  required
                  disabled={busy}
                  maxLength={100}
                  value={timezone}
                  onChange={(e) => setTimezone(e.target.value)}
                />
              </label>
            </>
          )}
          <div className="agent-field assistant-actions">
            <button className="button primary" disabled={busy}>
              {copy.create}
            </button>
            <button
              type="button"
              className="button secondary"
              onClick={() => setCreating(false)}
            >
              {commonCopy.cancel}
            </button>
          </div>
        </form>
      )}
      <ListCard labelledBy={id} disabled={!connected}>
        {!items.length && <p className="agent-row-note">{copy.empty}</p>}
        {items.map((item) => {
          const event = events[item.id] || item.lastEvent?.status;
          return (
            <React.Fragment key={item.id}>
              <div className="list-row two-line">
                <button
                  type="button"
                  className="list-row-main"
                  aria-expanded={open === item.id}
                  onClick={() => setOpen(open === item.id ? null : item.id)}
                >
                  <span className="list-row-text">
                    <span className="list-row-label">
                      {item.name || copy.unknownName}
                    </span>
                    <span className="list-row-sub">
                      <span>{stateOf(item)}</span>
                      <span className="agent-sub-part">
                        {scheduleLabel(item.trigger)}
                      </span>
                      {item.nextRunAtMs && (
                        <span className="agent-sub-part">
                          {copy.nextRun(formatTimestamp(item.nextRunAtMs))}
                        </span>
                      )}
                    </span>
                  </span>
                  <Icon name="down" size={14} className="list-row-chevron" />
                </button>
              </div>
              {event && (
                <p role="status" className="agent-row-note">
                  {copy.events[event] || copy.events.unknown}
                </p>
              )}
              {open === item.id && (
                <div className="agent-detail">
                  <p>{item.prompt}</p>
                  <div className="assistant-actions">
                    {["ready", "unknown"].includes(item.status) && (
                      <button
                        className="button secondary"
                        disabled={busy}
                        onClick={() =>
                          act(() =>
                            routineApi.update(assistantId, item.id, {
                              enabled: !item.enabled,
                              revision: item.revision,
                            }),
                          )
                        }
                      >
                        {item.enabled ? copy.pause : copy.resume}
                      </button>
                    )}
                    {item.trigger?.kind === "event" && (
                      <button
                        className="button secondary"
                        disabled={busy || !item.enabled || event === "unknown"}
                        onClick={() => act(() => run(item))}
                      >
                        {copy.run}
                      </button>
                    )}
                    <button
                      className="button secondary"
                      disabled={busy}
                      onClick={() => act(() => routineApi.remove(assistantId, item.id))}
                    >
                      {copy.remove}
                    </button>
                  </div>
                </div>
              )}
            </React.Fragment>
          );
        })}
      </ListCard>
    </section>
  );
}
```

Append to `web/features/assistants/agent-settings.css`:

```css
.agent-sub-part::before {
  content: " · ";
}
.list-row-main[aria-expanded="true"] .list-row-chevron {
  transform: rotate(180deg);
}
```

- [ ] **Step 5: Use the groups in the Telegram tab**

In `TelegramTab.jsx` replace the imports of `AssistantReminders`/`AssistantRoutines` with `import RemindersGroup from "./RemindersGroup.jsx";` and `import RoutinesGroup from "./RoutinesGroup.jsx";`, and replace

```jsx
              <AssistantReminders assistantId={assistant.id} />
              <AssistantRoutines assistantId={assistant.id} />
```

with

```jsx
              <RemindersGroup assistantId={assistant.id} connected={connected} />
              <RoutinesGroup assistantId={assistant.id} connected={connected} />
```

- [ ] **Step 6: Run the specs**

Run: `npm run build && npx playwright test tests/browser/assistant-settings-tabs.spec.js tests/browser/assistant-settings-save.spec.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
npx prettier --write web/features/assistants/settings web/features/assistants/agent-settings.css tests/browser/assistant-settings-tabs.spec.js
npx eslint web/features/assistants/settings tests/browser/assistant-settings-tabs.spec.js
git add web/features/assistants tests/browser/assistant-settings-tabs.spec.js
git commit -m "feat: list reminders and routines with in-place details in the Telegram tab" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Create mode and removal of the old settings components

"Neuer Agent" opens Profil + Fähigkeiten with the bar "Agent anlegen" (`POST /assistants`); afterwards the old long-form components, the section nav and their styles go.

**Files:**

- Create: `web/features/assistants/settings/AgentCreate.jsx`
- Modify: `web/features/assistants/AgentsPage.jsx` (create branch, imports)
- Delete: `web/features/assistants/{AssistantSettings,SettingsSectionNav,AssistantSaveBar,AssistantCapabilities,AssistantShell,AssistantShellAllowlist,AssistantProactivity,AssistantMemory,AssistantReminders,AssistantRoutines,AssistantWorkflows,TelegramSettings,AssistantMemberSettings}.jsx`, `web/features/assistants/assistant-proactivity.css`, `web/features/mcp-servers/AgentMcpServers.jsx`
- Modify (styles): `web/features/assistants/assistant-settings.css` (rewrite), `web/features/assistants/assistant-shell.css` (drop old section/allowlist rules), `web/features/assistants/assistants.css` and `web/features/mcp-servers/mcp-servers.css` (drop rules whose only users were deleted)
- Test: `tests/browser/assistant-settings-tabs.spec.js`

**Interfaces:**

- Consumes: Task 2 `createServer`, `createStep`; Task 3 `ProfileFields`, `ConfirmationSheet`; Task 4 `MemoryGroup`, `WebGroup`, `ShellGroup`; Task 7 `ProactivityGroup`; Step 0 `useTabDraft`, `useUnsavedChangesGuard`, `SaveBar`, `UnsavedChangesSheet`, `UnderlineTabs`.
- Produces: `AgentCreate({ navigate, onCreated(assistant), onCancel })` — tabs `agent-create-tab-<id>`, bar region "Unsaved changes" with "Create agent" always visible; `onCreated` runs once, after the saved draft rendered clean.

- [ ] **Step 1: Write the failing test**

Append to `tests/browser/assistant-settings-tabs.spec.js`:

```js
test("creating an agent opens its settings without asking", async ({ page }) => {
  const state = await setup(page);
  await page.route("**/api/assistants", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    state.created = route.request().postDataJSON();
    state.assistants.push(home({ id: "fresh", name: "Fresh" }));
    await route.fulfill({ status: 201, json: state.assistants.at(-1) });
  });
  await page.goto(baseURL + "/agents");
  await page.getByRole("button", { name: "New agent" }).click();
  const create = saveBar(page).getByRole("button", { name: "Create agent" });
  await expect(create).toBeVisible();
  await page.getByLabel("Name", { exact: true }).fill("Fresh");
  await agentTab(page, "Capabilities").click();
  await expect(page.getByText("Available after saving the agent")).toHaveCount(5);
  await page.getByRole("switch", { name: "Remember information" }).check();
  await create.click();
  await expect(page).toHaveURL(/\/agents\/fresh\/settings$/);
  await expect(unsavedSheet(page)).toHaveCount(0);
  expect(state.created).toMatchObject({ name: "Fresh", capabilities: { memory: true } });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm run build && npx playwright test tests/browser/assistant-settings-tabs.spec.js -g "creating an agent"`
Expected: FAIL — no button "Create agent" (the old form shows "Save agent").

- [ ] **Step 3: Implement create mode**

`web/features/assistants/settings/AgentCreate.jsx`:

```jsx
import React, { useEffect, useRef, useState } from "react";
import SaveBar from "../../../components/SaveBar.jsx";
import UnderlineTabs from "../../../components/UnderlineTabs.jsx";
import UnsavedChangesSheet from "../../../components/UnsavedChangesSheet.jsx";
import useTabDraft from "../../../lib/settings/useTabDraft.js";
import useUnsavedChangesGuard from "../../../lib/settings/useUnsavedChangesGuard.js";
import { assistantCopy as copy } from "../../../lib/i18n/messages/assistants.js";
import { assistantSettingsCopy as settingsCopy } from "../../../lib/i18n/messages/assistant-settings.js";
import useAssistants from "../useAssistants.js";
import { createServer } from "./agent-settings-fields.js";
import { createStep } from "./agent-settings-steps.js";
import ConfirmationSheet from "./ConfirmationSheet.jsx";
import ProfileFields from "./ProfileFields.jsx";
import ProactivityGroup from "./ProactivityGroup.jsx";
import { MemoryGroup, ShellGroup, WebGroup } from "./CapabilityGroups.jsx";
import "../agent-settings.css";

const tabs = ["profile", "capabilities"];
const idleHeartbeat = { heartbeatEnabled: false };
const ignore = () => {};

/** A new agent: Profile and Capabilities in one draft, created with one POST. */
export default function AgentCreate({ navigate, onCreated, onCancel }) {
  const { models, refresh, runtime } = useAssistants();
  const [tab, setTab] = useState("profile");
  const [created, setCreated] = useState(null);
  const announced = useRef(false);
  const draft = useTabDraft({ server: createServer() });
  const steps = [createStep({ label: settingsCopy.createAgent })];
  const create = async () => {
    const result = await draft.save(steps);
    if (result.status === "saved") {
      await refresh();
      setCreated(result.results.create);
    }
    return result;
  };
  const sheet = useUnsavedChangesGuard({
    draft,
    tab: settingsCopy.tabs[tab],
    save: async () => {
      const result = await draft.save(steps);
      if (result.status === "saved") await refresh();
      return result;
    },
  });
  // Open the new agent only once the saved draft rendered clean: the guard reads
  // `dirty` from the last render and would otherwise ask about a saved draft.
  useEffect(() => {
    if (!created || draft.dirty || announced.current) return;
    announced.current = true;
    onCreated(created);
  }, [created, draft.dirty, onCreated]);
  return (
    <section className="agent-create" aria-label={copy.create}>
      <UnderlineTabs
        label={settingsCopy.tabsLabel}
        idPrefix="agent-create"
        tabs={tabs.map((id) => ({ id, label: settingsCopy.tabs[id] }))}
        selected={tab}
        onSelect={setTab}
      />
      <div
        role="tabpanel"
        id={`agent-create-tabpanel-${tab}`}
        aria-labelledby={`agent-create-tab-${tab}`}
      >
        {tab === "profile" ? (
          <form
            id="agent-profile"
            className="agent-settings-form"
            onSubmit={(event) => {
              event.preventDefault();
              create();
            }}
          >
            <ProfileFields
              draft={draft}
              models={models}
              modelKey="new"
              navigate={navigate}
            />
          </form>
        ) : (
          <>
            <MemoryGroup draft={draft} />
            <WebGroup draft={draft} browser={runtime?.browser} creating />
            <ProactivityGroup values={idleHeartbeat} set={ignore} creating />
            <ShellGroup draft={draft} creating />
          </>
        )}
      </div>
      {/* Creating always offers the bar; Cancel closes the form. */}
      <SaveBar
        draft={{ ...draft, dirty: true, reset: onCancel }}
        onSave={create}
        saveLabel={settingsCopy.createAgent}
      />
      <ConfirmationSheet
        confirmation={draft.confirmation}
        onShellCancel={() => draft.set("shell", "off")}
      />
      <UnsavedChangesSheet {...sheet} />
    </section>
  );
}
```

In `web/features/assistants/AgentsPage.jsx` replace `import AssistantSettings from "./AssistantSettings.jsx";` with `import AgentCreate from "./settings/AgentCreate.jsx";` and replace the `{creating && ( <AssistantSettings … /> )}` block with:

```jsx
{
  creating && (
    <AgentCreate
      navigate={navigate}
      onCreated={(created) => {
        setCreating(false);
        navigate({ view: "agents", assistantId: created.id, agentSettings: true });
      }}
      onCancel={() => setCreating(false)}
    />
  );
}
```

- [ ] **Step 4: Run the test**

Run: `npm run build && npx playwright test tests/browser/assistant-settings-tabs.spec.js -g "creating an agent"`
Expected: PASS.

- [ ] **Step 5: Delete the old components**

```bash
git rm web/features/assistants/AssistantSettings.jsx web/features/assistants/SettingsSectionNav.jsx web/features/assistants/AssistantSaveBar.jsx web/features/assistants/AssistantCapabilities.jsx web/features/assistants/AssistantShell.jsx web/features/assistants/AssistantShellAllowlist.jsx web/features/assistants/AssistantProactivity.jsx web/features/assistants/assistant-proactivity.css web/features/assistants/AssistantMemory.jsx web/features/assistants/AssistantReminders.jsx web/features/assistants/AssistantRoutines.jsx web/features/assistants/AssistantWorkflows.jsx web/features/assistants/TelegramSettings.jsx web/features/assistants/AssistantMemberSettings.jsx web/features/mcp-servers/AgentMcpServers.jsx
grep -rnE "AssistantSettings\b|SettingsSectionNav|AssistantSaveBar|AssistantCapabilities|AssistantShell\b|AssistantShellAllowlist|AssistantProactivity|AssistantMemory\b|AssistantReminders|AssistantRoutines|AssistantWorkflows|TelegramSettings|AssistantMemberSettings|AgentMcpServers|assistant-proactivity.css" web
```

Expected: the grep prints nothing (`AssistantSettingsCopy`-like names do not exist; if `capabilityDefaults` was imported from `AssistantCapabilities.jsx` anywhere, import it from `settings/agent-settings-fields.js` instead).

- [ ] **Step 6: Rewrite the old settings styles**

Replace the whole content of `web/features/assistants/assistant-settings.css` with:

```css
/* Agent settings page frame; the tabs and groups live in agent-settings.css. */
.assistant-team-permission input {
  flex: none;
  width: 18px;
  height: 18px;
  padding: 0;
  margin: 0;
}
.assistant-detail.assistant-settings-page {
  padding: 0;
}
.assistant-settings-scroll {
  padding: 16px 24px 0;
}
@media (max-width: 700px) {
  .assistant-settings-page.assistant-detail {
    display: flex;
    flex-direction: column;
    flex: 1;
    height: auto;
    min-height: 0;
    padding: 0;
    overflow: hidden;
  }
  .assistant-settings-scroll {
    flex: 1;
    min-height: 0;
    padding: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
  }
}
.assistant-state-badge.connectionMissing {
  color: var(--accent);
  border-color: var(--accent-line);
  background: var(--accent-faint);
}
.assistant-capability > span {
  display: grid;
  gap: 2px;
}
.assistant-capability small {
  color: var(--muted, inherit);
  font-size: 12px;
}
@media (min-width: 701px) {
  .assistant-capability {
    align-items: flex-start !important;
  }
}
.assistant-restart-confirmation {
  border: 1px solid var(--line);
  border-radius: 0.75rem;
  padding: 1rem;
  display: grid;
  gap: 0.5rem;
}
.assistant-restart-confirmation p {
  margin: 0;
}
```

In `web/features/assistants/assistant-shell.css` delete the rule blocks `.assistant-shell`, `.assistant-shell-levels`, `.assistant-shell-levels p`, `.assistant-shell-entry small`, `.assistant-shell-allowlist` (all four), `.assistant-shell-entry`, `.assistant-shell-entry > div` and `.assistant-shell-entry button`; keep `.assistant-shell-warning`, `.assistant-shell-entry code`, the header name rules and `.assistant-shell-chip`.

Then remove rules that lost their last user:

```bash
for cls in assistant-personal-panel mcp-agent-options assistant-section-nav assistant-save-bar assistant-anchor assistant-section-title assistant-settings-layout assistant-settings-main assistant-profile-actions; do
  printf "%s: " "$cls"; grep -rln "$cls" web --include='*.jsx' --include='*.js' | tr '\n' ' '; echo
done
```

For every class whose line lists no `.jsx`/`.js` file, delete its rule blocks from `web/features/assistants/assistants.css` and `web/features/mcp-servers/mcp-servers.css` (e.g. `.assistant-personal-panel`, `.assistant-personal-panel form`, `.mcp-agent-options …`, `.assistant-settings-layout`, `.assistant-settings-main`).

- [ ] **Step 7: Run unit tests, the new specs and the build**

Run: `node --test tests/unit/assistant-css.test.js tests/unit/agent-settings-fields.test.js tests/unit/agent-settings-steps.test.js && npm run build && npx playwright test tests/browser/assistant-settings-tabs.spec.js tests/browser/assistant-settings-save.spec.js`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
npx prettier --write web/features/assistants web/features/mcp-servers tests/browser/assistant-settings-tabs.spec.js
npx eslint web/features/assistants web/features/mcp-servers tests/browser/assistant-settings-tabs.spec.js
git add -A web/features/assistants web/features/mcp-servers tests/browser/assistant-settings-tabs.spec.js
git commit -m "feat: create agents with tabs and remove the long agent settings form" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Move the profile, capability and check-in specs to the tabs

Existing specs keep what they assert and change how they find it. Where the spec removed a behaviour (section chips, in-form desktop buttons, Cancel returning to the chat, the old checkbox look), the test is replaced by the equivalent assertion on the new pattern; those replacements are listed in the PR description.

**Files:**

- Modify: `tests/browser/assistant-settings.spec.js`, `tests/browser/assistant-settings-mobile.spec.js`, `tests/browser/assistant-shell.spec.js`, `tests/browser/assistant-web-tools.spec.js`, `tests/browser/assistant-native-capabilities.spec.js`, `tests/browser/assistant-proactivity.spec.js`

**Interfaces:**

- Consumes: `agentTab`, `saveBar`, `unsavedSheet`, `settingsPath` (`tests/helpers/agent-settings-page.js`); `connectedChannel` (`tests/helpers/assistant-settings-browser.js`).

Locator map used throughout (old → new):

| Old                                                                                                        | New                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `/agents/home/settings` for switches, shell, MCP                                                           | `settingsPath("capabilities")`                                                                                                            |
| memory editor on the long page                                                                             | `settingsPath("capabilities", "memory")`                                                                                                  |
| allowlist inside `#agent-shell`                                                                            | `settingsPath("capabilities", "allowlist")`, `page.locator("#agent-allowlist")`                                                           |
| Telegram, check-ins, reminders, routines                                                                   | `settingsPath("telegram")` (region "Telegram", `#agent-proactivity`)                                                                      |
| Telegram activity entries                                                                                  | `settingsPath("telegram", "telegram-activity")`                                                                                           |
| ignored-message counts, new pairing code                                                                   | `settingsPath("telegram", "telegram-connection")`                                                                                         |
| projects/pipelines checkboxes, team policy, action list                                                    | `settingsPath("work")`, `…("work", "projects" \| "pipelines" \| "actions")`                                                               |
| `getByRole("checkbox", { name })` for capability, heartbeat, team toggles                                  | `getByRole("switch", { name })`                                                                                                           |
| `getByRole("alertdialog", { name })` for shell, full shell, restart, stdio confirmations on the agent page | `page.getByRole("dialog", { name })`                                                                                                      |
| `.assistant-save-bar`, `#agent-profile … "Save agent"`                                                     | `saveBar(page).getByRole("button", { name: "Save agent" })`                                                                               |
| "Save MCP servers"                                                                                         | `saveBar(page)` "Save agent"                                                                                                              |
| "Save project access", "Save team settings" (agent page), "Save address", language select auto-save        | `saveBar(page).getByRole("button", { name: "Save", exact: true })` (German: `saveBar(page, "Ungespeicherte Änderungen")` and "Speichern") |
| "Loading…" in the running save bar                                                                         | "Saving …"                                                                                                                                |
| create form "Save agent"                                                                                   | `saveBar(page).getByRole("button", { name: "Create agent" })`; switches on `agentTab(page, "Capabilities")`                               |
| reminder/routine Pause, Resume, Remove, History, Run once                                                  | click the row button (`{ name: /^<item name>/ }`) first                                                                                   |
| "+ create" forms                                                                                           | click `"+ Create reminder"` / `"+ Routine"` first                                                                                         |

- [ ] **Step 1: `assistant-settings.spec.js`**

Add `import { agentTab, settingsPath } from "../helpers/agent-settings-page.js";`. Then:

- "hidden tabs stop polling…": `page.goto(baseURL + settingsPath("telegram"))`.
- "slow polls never overlap": `page.goto(baseURL + settingsPath("work"))`.
- "links to Accounts and Settings…": `page.goto(baseURL + settingsPath("telegram"))`.
- "dates follow the interface language (…)": `page.goto(baseURL + settingsPath("telegram"))`.
- "review-lane Telegram entries…": `page.goto(baseURL + settingsPath("telegram", "telegram-activity"))`.
- Replace the test "mobile settings have section links and inline permission checkboxes" with:

```js
test("mobile settings switch tabs in place and use 38×22 switches", async ({ page }) => {
  await setup(page, { assistant: { capabilities: { memory: true, reminders: true } } });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(baseURL + settingsPath());
  await page.evaluate(() => (window.__marker = "same-document"));
  await expect(page.getByRole("tab")).toHaveText([
    "Profile",
    "Capabilities",
    "Work",
    "Telegram",
  ]);
  await agentTab(page, "Telegram").click();
  await expect(page.getByRole("region", { name: "Telegram" })).toBeInViewport();
  expect(await page.evaluate(() => window.__marker)).toBe("same-document");
  await agentTab(page, "Capabilities").click();
  const box = await page
    .getByRole("switch", { name: "Remember information" })
    .boundingBox();
  expect([Math.round(box.width), Math.round(box.height)]).toEqual([38, 22]);
});
```

- Replace "section links move focus to the section heading" with:

```js
test("arrow keys move between the settings tabs", async ({ page }) => {
  await setup(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(baseURL + settingsPath());
  await agentTab(page, "Profile").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page).toHaveURL(/tab=capabilities$/);
  await expect(agentTab(page, "Capabilities")).toBeFocused();
  await expect(agentTab(page, "Capabilities")).toHaveAttribute("aria-selected", "true");
});
```

All other tests stay unchanged.

- [ ] **Step 2: `assistant-settings-mobile.spec.js`**

Change the helpers at the top to:

```js
import {
  connectedChannel,
  setupAssistantSettings,
} from "../helpers/assistant-settings-browser.js";
import { saveBar, settingsPath } from "../helpers/agent-settings-page.js";

const full = { capabilities: { memory: true, reminders: true } };
const bar = (page) => saveBar(page);
const scroller = (page) => page.locator(".assistant-settings-scroll");
```

Then, inside `test.describe("agent settings on phones", …)`:

- "header and section chips stay put…" → rename to "header and tabs stay put while the settings body scrolls"; set it up with `setupAssistantSettings(page, { assistant: full, channel: connectedChannel() })`, add `await page.setViewportSize({ width: 390, height: 600 });` before the `goto` (one tab is much shorter than the old long page; the lower viewport guarantees the body overflows so `bodyScrolled` can become true) and go to `settingsPath("telegram")` (the longest tab); replace `page.getByRole("navigation", { name: "Settings sections" })` with `page.getByRole("tablist", { name: "Agent settings" })` and both `document.querySelector(".assistant-section-nav")` with `document.querySelector(".agent-settings-tabs")`.
- Replace "the profile form is flat and uses the 2e type scale" with:

```js
test("profile fields keep 16px text and selects as tall as inputs", async ({ page }) => {
  await setupAssistantSettings(page);
  await page.goto(baseURL + settingsPath());
  const style = await page.locator("#agent-profile").evaluate((el) => {
    const textBox = (field) => {
      const c = getComputedStyle(field);
      return field.clientHeight - parseFloat(c.paddingTop) - parseFloat(c.paddingBottom);
    };
    const field = el.querySelector("input");
    const select = el.querySelector("select");
    return {
      selectHeight: select.offsetHeight === field.offsetHeight,
      selectUnclipped: textBox(select) >= textBox(field),
      inputSize: getComputedStyle(field).fontSize,
      selectSize: getComputedStyle(select).fontSize,
    };
  });
  expect(style).toEqual({
    selectHeight: true,
    selectUnclipped: true,
    inputSize: "16px",
    selectSize: "16px",
  });
});
```

- "selects show the 16px handoff chevron…": unchanged.
- Replace "custom checkboxes keep their native semantics" with:

```js
test("switches keep their native semantics", async ({ page }) => {
  await setupAssistantSettings(page);
  await page.goto(baseURL + settingsPath("capabilities"));
  const memory = page.getByRole("switch", { name: "Remember information" });
  await expect(memory).not.toBeChecked();
  const box = await memory.boundingBox();
  expect([Math.round(box.width), Math.round(box.height)]).toEqual([38, 22]);
  await memory.check();
  await expect(memory).toBeChecked();
});
```

- "no horizontal overflow at …px": loop over every tab:

```js
for (const width of [390, 320])
  test(`no horizontal overflow at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 640 });
    await setupAssistantSettings(page, { assistant: full, channel: connectedChannel() });
    for (const tab of [undefined, "capabilities", "work", "telegram"]) {
      await page.goto(baseURL + settingsPath(tab));
      await expect(page.getByRole("tabpanel")).toBeVisible();
      expect(
        await page.evaluate(() => {
          const el = document.querySelector(".assistant-settings-scroll");
          return (
            document.documentElement.scrollWidth <= innerWidth &&
            el.scrollWidth <= el.clientWidth
          );
        }),
        tab ?? "profile",
      ).toBe(true);
    }
  });
```

- Delete the three chip tests ("the chip of the section in view is active", "the last section becomes active…", "clicking a chip activates it…"); `assistant-settings-tabs.spec.js` covers tab selection, deep links and focus.
- "the save bar appears after an edit…", "a failed save shows its error…", "the save bar fits a 320px phone": unchanged apart from `bar`.
- "the save bar mirrors a running save": expect `bar(page).getByRole("button", { name: "Saving …" })` instead of "Loading…".
- Replace "cancel in the save bar returns to the conversation" with:

```js
test("cancel in the save bar restores the saved values", async ({ page }) => {
  const state = await setupAssistantSettings(page);
  await page.goto(baseURL + settingsPath());
  const name = page.getByRole("textbox", { name: "Name" });
  await name.fill("Home 2");
  await bar(page).getByRole("button", { name: "Cancel" }).click();
  await expect(name).toHaveValue("Home");
  await expect(bar(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/agents\/home\/settings$/);
  expect(state.opened).toBe(0);
});
```

- "the save bar never covers the last section": set up with `{ assistant: full, channel: connectedChannel() }`, add `await page.setViewportSize({ width: 390, height: 600 });` before the `goto` (so the tab is still longer than the scroller and the bar is stuck to its bottom edge), go to `settingsPath("telegram")`, make the tab dirty with `await page.getByLabel("AgentPier address for links").fill("https://pier.example");`, and replace `.assistant-save-bar` with `.save-bar` (both `querySelector` calls). The `SaveBar` of the Telegram tab is rendered inside `#agent-telegram`, so "the last button" must exclude the bar's own buttons, otherwise the test compares the bar with itself: replace `page.locator("#agent-telegram button").last()` with `page.locator("#agent-telegram button:not(.save-bar button)").last()` and, inside the `overlap` evaluate, replace `const buttons = document.querySelectorAll("#agent-telegram button");` with `const buttons = [...document.querySelectorAll("#agent-telegram button")].filter((b) => !b.closest(".save-bar"));`.
- "creating an agent shows the save bar at once": expect `bar(page).getByRole("button", { name: "Create agent" })`.
- Replace the trailing desktop test with:

```js
test("desktop settings save from the same bar", async ({ page }) => {
  await setupAssistantSettings(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(baseURL + settingsPath());
  await page.getByRole("textbox", { name: "Name" }).fill("Home 2");
  await expect(saveBar(page).getByRole("button", { name: "Save agent" })).toBeVisible();
  await expect(
    page.locator("#agent-profile").getByRole("button", { name: "Save agent" }),
  ).toHaveCount(0);
});
```

- [ ] **Step 3: `assistant-shell.spec.js`**

Add `import { agentTab, saveBar, settingsPath } from "../helpers/agent-settings-page.js";` and change the helpers:

```js
const save = (page) => saveBar(page).getByRole("button", { name: "Save agent" });
const shell = (page) => page.locator("#agent-shell");
const allowlist = (page) => page.locator("#agent-allowlist");
const header = (page) => page.locator(".assistant-header-name");
```

- Every `page.goto(baseURL + "/agents/home/settings")` in this file becomes `page.goto(baseURL + settingsPath("capabilities"))`, except in "allowed commands are listed and deleted…" and the delete-error test, which go to `settingsPath("capabilities", "allowlist")` and use `allowlist(page)` instead of `shell(page)` for `.assistant-shell-entry`, the delete buttons and the alert.
- "shell is off by default…": replace the allowlist line with

```js
await shell(page)
  .getByRole("link", { name: /^Always allowed commands/ })
  .click();
await expect(allowlist(page).getByText("No always allowed commands.")).toBeVisible();
```

- Replace "the section chips lead to the shell section" with:

```js
test("the Capabilities tab leads to the shell group", async ({ page }) => {
  await setup(page);
  await page.goto(baseURL + "/agents/home/settings");
  await agentTab(page, "Capabilities").click();
  await expect(
    shell(page).getByRole("heading", { name: "Shell access", exact: true }),
  ).toBeVisible();
});
```

- Every `page.getByRole("alertdialog", { name: … })` becomes `page.getByRole("dialog", { name: … })`; `page.getByRole("alertdialog")` with `toHaveCount(0)` becomes `page.getByRole("dialog")`.
- "a new agent with shell is confirmed before it is created": after filling Name, connection and Model ID add `await agentTab(page, "Capabilities").click();` before the radio; replace `page.getByRole("button", { name: "Save agent" })` with `saveBar(page).getByRole("button", { name: "Create agent" })`.

- [ ] **Step 4: `assistant-web-tools.spec.js`**

Add `import { agentTab, saveBar, settingsPath } from "../helpers/agent-settings-page.js";`; change `const save = (page) => saveBar(page).getByRole("button", { name: "Save agent", exact: true });`; every agent `page.goto(baseURL + "/agents/home/settings")` becomes `settingsPath("capabilities")`; in the phone branch replace `page.locator("#agent-profile")` with `page.locator("#agent-settings-tabpanel-capabilities")`; `getByRole("alertdialog", { name: "Restart the agent service?" })` becomes `getByRole("dialog", { name: "Restart the agent service?" })`. In "the create form disables the web switches…":

```js
await page.goto(baseURL + "/agents");
await page.getByRole("button", { name: "New agent" }).click();
await agentTab(page, "Capabilities").click();
for (const name of ["Search the web", "Read web pages", "Use a browser", "Read images"]) {
  await expect(page.getByLabel(name)).toBeDisabled();
  await expect(page.getByLabel(name)).not.toBeChecked();
}
// The four web switches and scheduled check-ins.
await expect(page.getByText("Available after saving the agent")).toHaveCount(5);
await expect(page.getByLabel("Remember information")).toBeEnabled();
await page.getByLabel("Remember information").check();
await agentTab(page, "Profile").click();
await page.getByLabel("Name", { exact: true }).fill("Fresh");
await page.getByLabel("Model connection").selectOption("router");
await page.getByRole("textbox", { name: "Model ID" }).fill("model");
await saveBar(page).getByRole("button", { name: "Create agent" }).click();
```

(the `state.creates` assertions stay).

- [ ] **Step 5: `assistant-native-capabilities.spec.js`**

Add `import { settingsPath } from "../helpers/agent-settings-page.js";` and `import { connectedChannel } from "../helpers/assistant-settings-browser.js";`; in the fixture change the `/api/assistant-channels` body to `{ channels: [connectedChannel()] }` (reminders need a connected chat).

- Memory tests: `page.goto(baseURL + settingsPath("capabilities", "memory"))` (the `memory` section locator keeps working: the subpage is a section with the heading "Memory", and its bar holds "Save notes").
- The reminder half of the first test: before filling, `await page.goto(baseURL + settingsPath("telegram"));` and `await page.getByRole("button", { name: "+ Create reminder" }).click();`. After the create poll, open the row: `await page.getByRole("button", { name: /^Take a break/ }).click();` before "Pause reminder". After `page.reload()`, click the row again before expecting "Resume reminder".
- "…review an unconfirmed reminder": `page.goto(baseURL + settingsPath("telegram"))` (the review notice and button stay visible below the row).

- [ ] **Step 6: `assistant-proactivity.spec.js`**

Add `import { agentTab, saveBar, settingsPath } from "../helpers/agent-settings-page.js";` and `connectedChannel` to the fixture import. `section` stays `#agent-proactivity`; every heartbeat `getByRole("checkbox", …)` becomes `getByRole("switch", …)`; every setup gets `channel: connectedChannel()`.

Replace the first test with:

```js
test("check-ins are off, need memory, explain their cost and save", async ({ page }) => {
  const state = await setup(page, { channel: connectedChannel(), applyUpdates: true });
  await page.goto(baseURL + settingsPath("telegram"));
  const proactivity = section(page);
  await expect(
    proactivity.getByRole("group", { name: "Acting on its own" }),
  ).toBeVisible();
  // Recall across conversations is not offered in this release.
  await expect(page.getByText("Remember across conversations")).toHaveCount(0);
  const heartbeat = proactivity.getByRole("switch", { name: "Check in on its own" });
  await expect(heartbeat).not.toBeChecked();
  await expect(heartbeat).toBeDisabled();
  await expect(proactivity).toContainText(
    "Needs memory: switch on “Remember information” under Capabilities.",
  );
  await agentTab(page, "Capabilities").click();
  await page.getByRole("switch", { name: "Remember information" }).check();
  await saveBar(page).getByRole("button", { name: "Save agent" }).click();
  await expect.poll(() => state.updates.length).toBe(1);
  expect(state.updates[0].capabilities.memory).toBe(true);
  expect(state.updates[0].capabilities).not.toHaveProperty("recall");
  await agentTab(page, "Telegram").click();
  await expect(heartbeat).toBeEnabled();
  await expect(proactivity).toContainText("paired Telegram chat");
  await heartbeat.check();
  await expect(proactivity).toContainText(
    "Check-ins appear in the agent's chat, marked “Check-in:” on Telegram",
  );
  await proactivity.getByLabel("How often").selectOption("2h");
  await proactivity.getByLabel("Active from").selectOption("8");
  await proactivity.getByLabel("Active until").selectOption("20");
  await expect(proactivity).toContainText(
    "Times in Europe/Berlin, within one day. About 6 extra model runs per day, each reading the recent conversation.",
  );
  await expect(proactivity.getByRole("button", { name: /Use my time zone/ })).toHaveCount(
    0,
  );
  await proactivity.getByLabel("How often").selectOption("daily");
  await expect(proactivity).toContainText("About 1 extra model run per day");
  await proactivity.getByLabel("How often").selectOption("1h");
  await expect(proactivity).toContainText("About 12 extra model runs per day");
  await proactivity.screenshot({ path: ".cache/assistant-proactivity-desktop-en.png" });
  await saveBar(page).getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => state.updates.length).toBe(2);
  expect(state.updates[1].heartbeat).toEqual({
    enabled: true,
    interval: "1h",
    start: 8,
    end: 20,
    timeZone: "Europe/Berlin",
  });
});
```

Replace the second test's body after `setup(…, { …, channel: connectedChannel(), applyUpdates: true })` with:

```js
await page.goto(baseURL + settingsPath("capabilities"));
await page.getByRole("switch", { name: /^Remember information/ }).uncheck();
await saveBar(page).getByRole("button", { name: "Save agent" }).click();
await expect.poll(() => state.updates.length).toBe(1);
expect(state.updates[0].heartbeat.enabled).toBe(false);
await agentTab(page, "Telegram").click();
await expect(
  section(page).getByRole("switch", { name: "Check in on its own" }),
).toBeDisabled();
```

Other tests: go to `settingsPath("telegram")`; "a new agent switches check-ins on after saving" clicks `agentTab(page, "Capabilities")` after "New agent"; the refused-save tests click `saveBar(page).getByRole("button", { name: "Save", exact: true })` (German: `saveBar(page, "Ungespeicherte Änderungen").getByRole("button", { name: "Speichern", exact: true })`).

- [ ] **Step 7: Run the six specs**

Run: `npm run build && npx playwright test tests/browser/assistant-settings.spec.js tests/browser/assistant-settings-mobile.spec.js tests/browser/assistant-shell.spec.js tests/browser/assistant-web-tools.spec.js tests/browser/assistant-native-capabilities.spec.js tests/browser/assistant-proactivity.spec.js`
Expected: PASS. A failure that is not a locator or flow change (e.g. a request body differs) is a regression in Tasks 3–9: fix the component, not the assertion.

- [ ] **Step 8: Commit**

```bash
npx prettier --write tests/browser/assistant-settings.spec.js tests/browser/assistant-settings-mobile.spec.js tests/browser/assistant-shell.spec.js tests/browser/assistant-web-tools.spec.js tests/browser/assistant-native-capabilities.spec.js tests/browser/assistant-proactivity.spec.js
git add tests/browser/assistant-settings.spec.js tests/browser/assistant-settings-mobile.spec.js tests/browser/assistant-shell.spec.js tests/browser/assistant-web-tools.spec.js tests/browser/assistant-native-capabilities.spec.js tests/browser/assistant-proactivity.spec.js
git commit -m "test: find agent profile, capability and check-in settings on their tabs" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Move the Telegram, routine, work, team and MCP specs to the tabs

**Files:**

- Modify: `tests/browser/assistant-channels.spec.js`, `tests/browser/assistant-routines.spec.js`, `tests/browser/assistant-workflows.spec.js`, `tests/browser/assistant-teams.spec.js`, `tests/browser/agent-mcp-servers.spec.js`, `tests/browser/mcp-oauth.spec.js`, `tests/browser/assistant-accounts.spec.js`, `tests/browser/assistant-model-picker.spec.js`

**Interfaces:**

- Consumes: the Task 10 locator map and helpers.

- [ ] **Step 1: `assistant-channels.spec.js`**

Add `import { saveBar, settingsPath } from "../helpers/agent-settings-page.js";`.

- "Telegram pairing and unknown delivery recovery…": `page.goto(baseURL + settingsPath("telegram"))`; after the `state.channel = { … inputs: [ … ] }` assignment add `await panel.getByRole("link", { name: /^Telegram activity/ }).click();` before the "Dinner ideas" assertion.
- "the oldest blocked input…" and "mobile recovery keeps uncertain team notifications…": `page.goto(baseURL + settingsPath("telegram", "telegram-activity"))`.
- "an answer without text and a full queue…": `page.goto(baseURL + settingsPath("telegram"))`; keep the queue-full assertion there (a channel diagnostic stays on the main view), then `await panel.getByRole("link", { name: /^Telegram activity/ }).click();` before the "Answer without text" assertion.
- "Telegram links use the browser address…": `page.goto(baseURL + settingsPath("telegram"))`. After the `state.channel = { … }` assignment:

```js
await panel.getByRole("link", { name: /^Connection/ }).click();
await expect(
  panel.getByText("Ignored messages: 2 from other private chats, 1 from groups."),
).toBeVisible();
await page.getByRole("button", { name: "Back to Telegram" }).click();
await panel.getByRole("link", { name: /^Telegram activity/ }).click();
await expect(panel.getByText(/Deepgram balance or quota is exhausted/)).toBeVisible();
await expect(panel.getByText('{"err_msg":"Insufficient credits"}')).toBeVisible();
await page.getByRole("button", { name: "Back to Telegram" }).click();
const address = panel.getByLabel("AgentPier address for links");
await expect(address).toHaveValue(origin);
await address.fill("https://pier.example");
await saveBar(page).getByRole("button", { name: "Save", exact: true }).click();
await expect.poll(() => state.patched?.appUrl).toBe("https://pier.example");
await expect(address).toHaveValue("https://pier.example");
await panel.getByLabel("Language of Telegram notices").selectOption("de");
await saveBar(page).getByRole("button", { name: "Save", exact: true }).click();
await expect.poll(() => state.patched?.language).toBe("de");
expect(state.patched.appUrl).toBeUndefined();
```

- [ ] **Step 2: `assistant-routines.spec.js`**

Add `import { settingsPath } from "../helpers/agent-settings-page.js";` and `import { connectedChannel } from "../helpers/assistant-settings-browser.js";`. In the fixture add, before the `/routines` branches:

```js
    else if (path === "/api/assistant-channels") body = { channels: [connectedChannel()] };
```

In both tests: `page.goto(baseURL + settingsPath("telegram"))`, then `await panel.getByRole("button", { name: "+ Routine" }).click();` before filling the form. In the first test, after the "Daily at 18:30" assertion add `await panel.getByRole("button", { name: /^Meal plan/ }).click();`; in the second, after the create poll add `await panel.getByRole("button", { name: /^Review summary/ }).click();` before "Run once" (the event notice stays visible below the row).

- [ ] **Step 3: `assistant-workflows.spec.js`**

Add `import { saveBar, settingsPath } from "../helpers/agent-settings-page.js";`. In the fixture, next to the `/access` branch, add (name the parsed request `input` so it does not shadow `body`):

```js
    else if (url.pathname.endsWith("/work") && method === "PUT") {
      const input = route.request().postDataJSON();
      if (input.access) policy = { ...input.access, revision: 1 };
      body = {
        access: policy,
        team: { revision: 0, autonomous: false, maxMembers: 4, runTimeoutMinutes: 10 },
      };
    }
```

Replace the first five steps after setup with:

```js
await page.goto(baseURL + settingsPath("work"));
await page.getByRole("link", { name: /^Allowed projects/ }).click();
await page.getByLabel("Demo project", { exact: true }).check();
await page.getByRole("button", { name: "Back to Work" }).click();
await page.getByRole("link", { name: /^Allowed pipelines/ }).click();
await page.getByLabel("Build", { exact: true }).check();
await page.getByRole("button", { name: "Back to Work" }).click();
await page.getByLabel("Allow proposals to update project memory").check();
await saveBar(page).getByRole("button", { name: "Save", exact: true }).click();
await expect.poll(() => policy.projectIds).toEqual(["project"]);
expect(policy.autonomous).toBe(false);
await page.getByRole("link", { name: /^Actions and coding tasks/ }).click();
```

and replace the later `await page.reload();` with `await page.goto(baseURL + settingsPath("work"));`.

- [ ] **Step 4: `assistant-teams.spec.js`**

Add `import { saveBar, settingsPath } from "../helpers/agent-settings-page.js";`. In the fixture, before the `/team-policy` branch, add:

```js
    } else if (p.endsWith("/work") && method === "PUT") {
      const input = route.request().postDataJSON();
      if (input.team) {
        posted.push(input.team);
        if (input.team.revision !== policy.revision)
          return route.fulfill({
            status: 409,
            json: { error: "The data has changed. Please reload." },
          });
        Object.assign(policy, input.team, { revision: policy.revision + 1 });
      }
      body = { access: { revision: 0 }, team: policy };
    } else if (p.endsWith("/access")) {
      body = { revision: 0 };
    } else if (p === "/api/assistant-workspace-catalog") {
      body = { projects: [], pipelines: [] };
```

(The fixture's request method variable is `method` and its path variable is `p`, as used above; the snippet continues the existing `if … else if` chain and the following existing `} else if (p.endsWith("/team-policy") …` closes the last branch.) Then:

- "completed member keeps its chat…": replace the last block with

```js
await page.goto(baseURL + settingsPath("work"));
await page.getByLabel("Allow teams without asking each time").check();
await saveBar(page).getByRole("button", { name: "Save", exact: true }).click();
await expect.poll(() => posted.at(-1)?.autonomous).toBe(true);
```

- Replace "policy drafts cannot borrow a newer revision to restore revoked authority" with (the draft is dirty first, so its base revision is frozen):

```js
test("policy drafts cannot borrow a newer revision to restore revoked authority", async ({
  page,
}) => {
  const { policy, posted } = await setup(page);
  policy.autonomous = true;
  await page.goto(baseURL + settingsPath("work"));
  const autonomous = page.getByLabel("Allow teams without asking each time");
  await expect(autonomous).toBeChecked();
  await page.getByRole("spinbutton", { name: "Maximum team size" }).fill("5");
  policy.autonomous = false;
  policy.revision = 2;
  await refreshFromEvent(page);
  await expect(autonomous).not.toBeChecked();
  await saveBar(page).getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => posted.at(-1)?.revision).toBe(1);
  await expect(
    page.getByText("The data has changed. Please reload.", { exact: true }).first(),
  ).toBeVisible();
  expect(policy.autonomous).toBe(false);
});
```

The host-capacity test on `/settings/assistants` and the member tests on `/agents/member-0/settings` (Profile tab) stay unchanged.

- [ ] **Step 5: `agent-mcp-servers.spec.js` and `mcp-oauth.spec.js`**

In `agent-mcp-servers.spec.js` add `import { saveBar, settingsPath } from "../helpers/agent-settings-page.js";`:

- "a saved change whose live apply is pending…" and "binding a stdio server…": `page.goto(baseURL + settingsPath("capabilities"))`; `panel.getByRole("button", { name: "Save MCP servers" })` becomes `saveBar(page).getByRole("button", { name: "Save agent" })`; `panel.getByRole("alertdialog")` becomes `page.getByRole("dialog", { name: "Give agents a local command?" })`.
- "temporary members list their servers read only": `page.goto(baseURL + settingsPath("capabilities", undefined, "temp-agent"))`.

In `mcp-oauth.spec.js` add the same import; the agent part of "statuses show on the list and the agent…" goes to `settingsPath("capabilities")`, and the save (which needs a change now) becomes:

```js
// Saving the bindings reads the statuses again; a save needs a change.
await agent.getByLabel(/tracker/).uncheck();
await saveBar(page).getByRole("button", { name: "Save agent" }).click();
await expect(agent.getByText("MCP servers saved.")).toBeVisible();
await agent.getByLabel(/tracker/).check();
await saveBar(page).getByRole("button", { name: "Save agent" }).click();
await expect(agent.getByText("MCP servers saved.")).toBeVisible();
await expect(agent.getByText("Connected", { exact: true })).toHaveCount(2);
await expect(agent).not.toContainText("Log in to OAuth servers under Accounts");
```

- [ ] **Step 6: The two create-form specs outside the settings suites**

Both create an agent through "New agent" and click the old in-form "Save agent", which no longer exists in create mode (the bar says "Create agent"). The fields they fill (Name, Model connection, Model ID, model picker) sit on the default Profile tab, so only the save click changes.

- `tests/browser/assistant-accounts.spec.js`: add `import { saveBar } from "../helpers/agent-settings-page.js";`; in "offline account UI links to assistant service and selected ChatGPT account saves" replace `await page.getByRole("button", { name: "Save agent" }).click();` with `await saveBar(page).getByRole("button", { name: "Create agent" }).click();`.
- `tests/browser/assistant-model-picker.spec.js`: add the same import; in "OpenRouter loads a current searchable catalog when creating an agent" replace `await page.getByRole("button", { name: "Save agent", exact: true }).click();` with `await saveBar(page).getByRole("button", { name: "Create agent", exact: true }).click();`.

- [ ] **Step 7: Run the eight specs and the unchanged agent specs**

Run: `npm run build && npx playwright test tests/browser/assistant-channels.spec.js tests/browser/assistant-routines.spec.js tests/browser/assistant-workflows.spec.js tests/browser/assistant-teams.spec.js tests/browser/agent-mcp-servers.spec.js tests/browser/mcp-oauth.spec.js tests/browser/assistant-accounts.spec.js tests/browser/assistant-model-picker.spec.js tests/browser/assistants.spec.js tests/browser/assistant-chat-layout.spec.js tests/browser/assistant-feature.spec.js tests/browser/i18n.spec.js`
Expected: PASS. `assistants.spec.js`, `assistant-chat-layout.spec.js`, `assistant-feature.spec.js` and `i18n.spec.js` need no edits (header, Profile revision line, runtime heading at 1440 px in the aside and at 390 px in the Profile group, and the general Settings page are unchanged); if one fails, fix the page.

- [ ] **Step 8: Commit**

```bash
npx prettier --write tests/browser/assistant-channels.spec.js tests/browser/assistant-routines.spec.js tests/browser/assistant-workflows.spec.js tests/browser/assistant-teams.spec.js tests/browser/agent-mcp-servers.spec.js tests/browser/mcp-oauth.spec.js tests/browser/assistant-accounts.spec.js tests/browser/assistant-model-picker.spec.js
git add tests/browser/assistant-channels.spec.js tests/browser/assistant-routines.spec.js tests/browser/assistant-workflows.spec.js tests/browser/assistant-teams.spec.js tests/browser/agent-mcp-servers.spec.js tests/browser/mcp-oauth.spec.js tests/browser/assistant-accounts.spec.js tests/browser/assistant-model-picker.spec.js
git commit -m "test: find Telegram, work, team and MCP agent settings on their tabs" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Full gate, feature coverage check and screenshots

**Files:**

- Create (git-ignored, not committed): `.superpowers/screenshots/agent/screens.config.mjs`, `.superpowers/screenshots/agent/capture.spec.js`, and the PNGs in `.superpowers/screenshots/agent/`

**Interfaces:**

- Consumes: everything above; `setupAssistantSettings`, `connectedChannel`, `settingsPath`, `unsavedSheet`, `baseURL`.

- [ ] **Step 1: Run the gate**

Run: `npm run check`
Expected: lint, format, structure (no file over 600 lines), build and all node suites pass.

Run: `npx playwright test tests/browser/assistant*.spec.js tests/browser/agent-mcp-servers.spec.js tests/browser/mcp-oauth.spec.js tests/browser/settings-pattern-tabs.spec.js tests/browser/settings-pattern-list.spec.js tests/browser/settings-pattern-draft.spec.js tests/browser/settings-pattern-shell.spec.js tests/browser/navigation.spec.js tests/browser/file-explorer-editor-navigation.spec.js`
Expected: PASS.

Run (WebKit and the tablet project for agent pages; `npx playwright install webkit` if missing): `AGENTPIER_TEST_BROWSER=webkit npx playwright test tests/browser/assistant-settings-tabs.spec.js tests/browser/assistant-settings-save.spec.js tests/browser/assistant-settings.spec.js tests/browser/assistant-settings-mobile.spec.js`
Expected: PASS.

Run the complete browser suite once: `npm run test:e2e`
Expected: PASS.

- [ ] **Step 2: Walk the feature coverage checklist**

Every action of the old page has a place; each line names where it lives now and what proves it. Tick each line after checking it in English on a phone width (390×844) and on desktop (1280×800) with the screenshot fixture below (`npx playwright test -c .superpowers/screenshots/agent/screens.config.mjs --headed` or the PNGs).

| Old action (component)                                                                                                    | New place                                                | Proven by                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Edit name, instructions (`AssistantSettings`)                                                                             | Profil fields                                            | `assistant-settings-save.spec.js` profile save                                            |
| Model connection, catalog search, custom model ID, remote catalog status (`AssistantModelFields`)                         | Profil fields (component unchanged)                      | `assistant-settings.spec.js` model field test                                             |
| `noConnections` hint                                                                                                      | Profil, below fields                                     | visual (no models fixture)                                                                |
| Mark instructions as reviewed                                                                                             | Profil review strip                                      | `assistant-teams.spec.js` "completed member…"                                             |
| Reload latest on remote change                                                                                            | Profil `ConflictNotice` + bar Reload/Overwrite           | `assistant-settings.spec.js` first test, `assistant-settings-save.spec.js` conflict tests |
| Manage connections → Accounts                                                                                             | Profil reference row                                     | visual + `ReferenceRow` harness spec                                                      |
| Revision line + pending note                                                                                              | Profil                                                   | `assistants.spec.js` "Saved revision: 2 · Applied revision: 1"                            |
| Save / Cancel / restart confirmation (model change)                                                                       | Profil bar + `ConfirmationSheet`                         | mobile spec save tests                                                                    |
| Team member provenance, assignment, phase, stop/promote/archive/restore/recover (`AssistantMemberSettings`)               | Profil member group                                      | `assistant-teams.spec.js` member tests                                                    |
| Granted MCP servers read only (`TemporaryMcpServers`)                                                                     | Fähigkeiten for task-bound members                       | `agent-mcp-servers.spec.js` temporary members                                             |
| Memory and reminders switches (`AssistantCapabilities`)                                                                   | Fähigkeiten "Memory & reminders"                         | `assistant-web-tools.spec.js` full object                                                 |
| Web search/fetch/browser/images with availability reasons                                                                 | Fähigkeiten "Web & documents"                            | `assistant-web-tools.spec.js` browser/search tests                                        |
| `webHint`, `capabilityHint`, `memoryHint`                                                                                 | ⓘ on the group labels                                    | `assistant-settings-tabs.spec.js` info disclosure                                         |
| Restart confirmation for web capabilities                                                                                 | `ConfirmationSheet`                                      | `assistant-web-tools.spec.js` restart test                                                |
| Shell level, warning, off hint, pending notice, ineligible reason (`AssistantShell`)                                      | Fähigkeiten "Shell access"                               | `assistant-shell.spec.js`                                                                 |
| Shell and full-shell confirmations, cancel returns to saved level                                                         | `ConfirmationSheet`                                      | `assistant-shell.spec.js`                                                                 |
| Always allowed commands list + delete + error (`AssistantShellAllowlist`)                                                 | Subpage `allowlist`                                      | `assistant-shell.spec.js` allowlist tests                                                 |
| MCP bindings, stdio pill, OAuth status, login hint, empty state + Open Accounts, saved/pending notice (`AgentMcpServers`) | Fähigkeiten "MCP servers"                                | `agent-mcp-servers.spec.js`, `mcp-oauth.spec.js`, save spec                               |
| Stdio binding confirmation                                                                                                | `ConfirmationSheet`                                      | `agent-mcp-servers.spec.js` stdio test                                                    |
| Memory note type, edit, save with hash, clear, reload, read-only agent notes, search (`AssistantMemory`)                  | Subpage `memory` with its own bar                        | `assistant-native-capabilities.spec.js`, tabs spec note switch                            |
| Project and pipeline grants (`AssistantWorkflows`)                                                                        | Arbeit rows → subpages `projects`/`pipelines`            | `assistant-workflows.spec.js`, save spec Work test                                        |
| Three action permissions                                                                                                  | Arbeit toggles                                           | `assistant-workflows.spec.js`                                                             |
| Action list: approve, decline, cancel, review unknown, run/human-gate link, node states, diagnostics, requested-by        | Subpage `actions` (+ pending strip)                      | `assistant-workflows.spec.js`, tabs spec pending strip                                    |
| Team autonomous, max members, timeout (`AssistantTeamSettings` agent mode)                                                | Arbeit "Team"                                            | `assistant-teams.spec.js`, save spec Work test                                            |
| Host team capacity (`AssistantTeamSettings` host mode)                                                                    | unchanged on `/settings/assistants`                      | `assistant-teams.spec.js` host test                                                       |
| Telegram connect with token + bot hint + pairing link (`TelegramSettings`)                                                | Telegram "Connection" (not connected)                    | `assistant-channels.spec.js` pairing tests                                                |
| Pause/resume, disconnect                                                                                                  | Telegram "Connection" rows                               | save spec "channel changed elsewhere" (resume visible)                                    |
| New pairing code, ignored counts, diagnostics, token replacement                                                          | Subpage `telegram-connection` (diagnostics also on main) | tabs spec Telegram subpages, channels spec                                                |
| Language of notices, app URL                                                                                              | Telegram "Connection" (draft, bar)                       | `assistant-channels.spec.js` links test                                                   |
| Speech link → Accounts                                                                                                    | Telegram "Connection"                                    | `assistant-settings.spec.js` links test                                                   |
| Activity: retry, acknowledge, open chat, in-progress, team notification, diagnostic detail                                | Subpage `telegram-activity` (+ status on the row)        | `assistant-channels.spec.js`, `assistant-settings.spec.js` review-lane                    |
| Check-ins: toggle, interval, hours, reply note, time zone, adopt zone, cost (`AssistantProactivity`)                      | Telegram "Acting on its own"                             | `assistant-proactivity.spec.js`                                                           |
| Reminders: create, status, next run, delivery, review, pause/resume, remove, history (`AssistantReminders`)               | Telegram "Reminders" (inline details)                    | `assistant-native-capabilities.spec.js`, tabs spec reminders                              |
| Routines: create (daily/event), schedule, next run, event status, pause/resume, run once, remove (`AssistantRoutines`)    | Telegram "Routines" (inline details)                     | `assistant-routines.spec.js`                                                              |
| Runtime card: service, sync, diagnostic, link (`AgentsPage` aside)                                                        | `RuntimeSummary` aside ≥1100 px, Profil group below      | `assistants.spec.js` runtime heading at 1440/390                                          |
| Back to conversation, drawer button, missing-connection status (`AssistantHeader`)                                        | unchanged header                                         | `assistant-chat-layout.spec.js`                                                           |
| Section chips (`SettingsSectionNav`)                                                                                      | tabs (removed by spec)                                   | tabs spec deep links/keyboard                                                             |
| Mobile save bar (`AssistantSaveBar`)                                                                                      | `SaveBar` on every width                                 | mobile spec bar tests                                                                     |
| New agent (create form)                                                                                                   | `AgentCreate` (Profil + Fähigkeiten, "Create agent")     | tabs spec create test, web-tools create test, shell create test                           |

If a line cannot be ticked, fix the page in a `fix:` commit before continuing.

- [ ] **Step 3: Write the screenshot script**

```bash
mkdir -p .superpowers/screenshots/agent
```

`.superpowers/screenshots/agent/screens.config.mjs`:

```js
import path from "node:path";
import { defineConfig } from "@playwright/test";
import base from "../../../playwright.config.js";

const root = path.resolve(import.meta.dirname, "../../..");
const port = process.env.AGENTPIER_TEST_PORT || 4389;
// Reuses the isolated test server and login of the browser suite; only the test
// directory and output differ.
export default defineConfig({
  ...base,
  testDir: import.meta.dirname,
  testMatch: "capture.spec.js",
  projects: [{ name: "screens" }],
  globalSetup: path.join(root, "tests/helpers/browser-login-setup.js"),
  webServer: { ...base.webServer, cwd: root },
  use: {
    ...base.use,
    storageState: path.join(root, `.cache/browser-auth-${port}.json`),
  },
});
```

`.superpowers/screenshots/agent/capture.spec.js`:

```js
import { test, expect } from "@playwright/test";
import { baseURL } from "../../../tests/helpers/browser.js";
import {
  connectedChannel,
  setupAssistantSettings,
} from "../../../tests/helpers/assistant-settings-browser.js";
import {
  settingsPath,
  unsavedSheet,
} from "../../../tests/helpers/agent-settings-page.js";

const out = import.meta.dirname;
const sizes = {
  mobile: { width: 390, height: 844 },
  desktop: { width: 1280, height: 800 },
};
const tabs = ["profile", "capabilities", "work", "telegram"];
const fixture = (language) => ({
  language,
  assistant: {
    capabilities: { memory: true, reminders: true, webSearch: true },
    mcpServers: ["docs"],
    shell: "approval",
    heartbeat: {
      enabled: true,
      interval: "4h",
      start: 9,
      end: 18,
      timeZone: "Europe/Berlin",
    },
  },
  channel: connectedChannel({
    inputs: [{ id: "a", state: "delivered", text: "Plan dinner" }],
  }),
  reminders: [
    {
      id: "r1",
      name: "Weekly planning",
      status: "ready",
      enabled: true,
      revision: 1,
      schedule: { kind: "cron", expr: "0 8 * * *" },
      nextRunAtMs: Date.UTC(2026, 9, 20, 6),
    },
  ],
  routines: [
    {
      id: "t1",
      name: "Inbox review",
      prompt: "Summarize new mail",
      status: "ready",
      enabled: true,
      revision: 1,
      trigger: { kind: "cron", expr: "30 7 * * *", tz: "Europe/Berlin" },
    },
  ],
  catalog: {
    projects: [
      { id: "p1", name: "agent-pier" },
      { id: "p2", name: "website" },
    ],
    pipelines: [{ id: "b1", name: "Build" }],
  },
  access: { revision: 1, projectIds: ["p1"], pipelineIds: ["b1"], memoryWrite: true },
  mcpServers: [
    { id: "docs", name: "docs", transport: "http" },
    { id: "fs", name: "filesystem", transport: "stdio" },
  ],
  memory: {
    "MEMORY.md": { name: "MEMORY.md", content: "Prefers short answers.", hash: "h" },
  },
});

for (const language of ["en", "de"])
  for (const [size, viewport] of Object.entries(sizes)) {
    for (const tab of tabs)
      test(`${tab} ${size} ${language}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await setupAssistantSettings(page, fixture(language));
        await page.goto(baseURL + settingsPath(tab === "profile" ? undefined : tab));
        await expect(page.getByRole("tab", { selected: true })).toBeVisible();
        await page.waitForTimeout(600);
        await page.screenshot({
          path: `${out}/${tab}-${size}-${language}.png`,
          fullPage: true,
        });
      });
    test(`unsaved sheet ${size} ${language}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await setupAssistantSettings(page, fixture(language));
      await page.goto(baseURL + settingsPath("capabilities"));
      await page.getByRole("switch").first().click();
      await page.getByRole("tab").first().click();
      await expect(
        unsavedSheet(page, language === "de" ? "Änderungen speichern?" : "Save changes?"),
      ).toBeVisible();
      await page.screenshot({ path: `${out}/unsaved-${size}-${language}.png` });
    });
    test(`memory subpage ${size} ${language}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await setupAssistantSettings(page, fixture(language));
      await page.goto(baseURL + settingsPath("capabilities", "memory"));
      await page.waitForTimeout(600);
      await page.screenshot({
        path: `${out}/memory-${size}-${language}.png`,
        fullPage: true,
      });
    });
  }
```

- [ ] **Step 4: Capture**

Run: `npm run build && npx playwright test -c .superpowers/screenshots/agent/screens.config.mjs`
Expected: 24 passed; `ls .superpowers/screenshots/agent/*.png | wc -l` prints 24 (4 tabs + sheet + memory, × 2 sizes × 2 languages). Open a few: German labels on every tab (Profil/Fähigkeiten/Arbeit/Telegram), no hardcoded English in the DE shots, no horizontal overflow at 390 px, runtime column visible in the desktop shots.

`git status --short` must not list anything under `.superpowers/` (it is git-ignored).

- [ ] **Step 5: Final state**

Run: `git status --short && git log --oneline feat/settings-redesign..HEAD`
Expected: clean tree; the commits of Tasks 1–11 plus any `fix:` commits from Step 2. The branch is ready for the automated code review and the `--no-ff` merge into `feat/settings-redesign` described in the spec's "Delivery" section; the PR description lists the deviations below and embeds the screenshots.

---

## Deviations from the spec and the design (for the PR description)

1. **Header**: `AssistantHeader` instead of `SettingsShell` for agent settings — it carries the avatar, shell chip, missing-connection status/notice and the phone drawer button that `SettingsShell` has no slot for (decision "Header stays `AssistantHeader`").
2. **Reminder/routine details expand inline** instead of separate subpages — Step 0's route contract has no `agentPage` for them.
3. **Work save sends only the changed half** of `PUT /assistants/:id/work` (own `workStep` instead of `assistantWorkStep`) so a team-only change is not blocked by the access half's maintenance rule; still one transactional request.
4. **Telegram not connected**: heartbeat and the "+ create" actions are disabled and dimmed with their hints, but existing reminders/routines stay operable (pause, delete, review) so nothing becomes unreachable.
5. **Bar behaviour replaces old behaviour** (README): Cancel resets the draft instead of returning to the chat; desktop uses the same bar instead of in-form buttons; the running label is Step 0's "Saving …". Tests asserting the old behaviour are replaced, not loosened.
6. **Section-chip tests** are replaced by tab tests (component removed by the spec).
7. **Copy**: new `heartbeatNeedsMemory` ("…under Capabilities") replaces "switched on above", which is wrong once memory and check-ins live on different tabs.
8. **Token replacement** on the connection subpage is new UI for the existing same-bot rotation of `PATCH /assistant-channels/:id`.
9. **Shell hints**: the selected level's hint stays visible; the other levels' hints are joined behind one ⓘ with their level names; `offHint` stays visible (not in the README ⓘ list).
10. **Speech link** keeps `/accounts` (existing assertion); Step 2 may deep-link it to the speech item.
11. **mcp-oauth spec**: saving now requires a change, so the status re-read is shown with an unbind/rebind pair.
12. **Runtime summary** renders as an aside ≥ 1100 px and as a Profil group below, toggled by CSS.

## Self-Review

**Spec coverage (Step 1):**

| Spec item                                                                                                                    | Task           |
| ---------------------------------------------------------------------------------------------------------------------------- | -------------- |
| Tabs Profil / Fähigkeiten / Arbeit / Telegram, `SettingsSectionNav` removed                                                  | 3, 9           |
| Mobile back + avatar + name + "Einstellungen"; desktop header + tabs row                                                     | 3 (decision 1) |
| Profil: review strip, conflict in bar, fields, `AssistantModelFields`, reference row, revision line, member group, one PATCH | 3              |
| Fähigkeiten: memory/reminders + notes subpage (own bar, hash, search, clear, reload)                                         | 4, 5           |
| Fähigkeiten: web toggles with availability, search provider reference row                                                    | 4              |
| Fähigkeiten: shell segmented, selected hint, warning ≠ off, pending, ineligible reason, allowlist subpage                    | 4, 5           |
| Fähigkeiten: MCP checkbox rows, stdio pill, OAuth status, login hint, empty state, reference row                             | 4              |
| Fähigkeiten: one PATCH incl. `heartbeat.enabled=false`; shell/full/restart/stdio as sheets                                   | 2, 4           |
| Arbeit: pending strip → actions subpage (complete history)                                                                   | 6              |
| Arbeit: grants rows "a von b" → selection subpages, 3 toggles, Team group, `PUT /work`                                       | 2, 6           |
| Telegram: connection status/pause/disconnect/language/app URL, activity + connection subpages                                | 7              |
| Telegram not connected: token + pairing, other groups disabled with hints                                                    | 7, 8           |
| Telegram: check-ins (interval, hours, reply, time zone, adopt, cost)                                                         | 7              |
| Telegram: reminders and routines with details                                                                                | 8              |
| Telegram save: heartbeat PATCH then channel PATCH, partial report                                                            | 2, 7           |
| Create mode: Profil + Fähigkeiten, "Agent anlegen", available-after-saving hints                                             | 9              |
| Runtime card right column / Profil row                                                                                       | 3              |
| Visibility rules (personal, memory row, reminders, Team, Telegram tab)                                                       | 2, 3, 4, 6, 7  |
| Hints behind ⓘ verbatim; warnings/errors visible                                                                             | 4–8            |
| Drafts, base revisions, 409 Reload/Overwrite, untouched fields adopt                                                         | 3, 7 (tests)   |
| Unsaved sheet on tab switch/back/history/agent switch, `beforeunload`                                                        | 3              |
| i18n DE+EN, no `common.js` keys                                                                                              | 1              |
| Browser specs updated; new regression specs (dirty bar, sheet, multi-step partial, conflict, deep links, ⓘ)                  | 3–11           |
| EN/DE × mobile/desktop screenshots                                                                                           | 12             |

**Placeholder scan:** every code step carries its code; spec migrations give the exact replacement lines or snippets. Two steps ask the executor to adapt to a fixture detail they can see (the method variable name in `assistant-teams.spec.js`, the cleanup grep in Task 9) and say exactly what to do with the result.

**Type consistency:** tab components all take `{ assistant, page, go, navigate }`; `go(tab, page?)` builds `agentRoute`. Step objects (`id`, `label`, `keys`, `resource`, `run`, `revisions`, `confirmation`) match Step 0's `save-chain.js`. Draft fields used by components (`values`, `base`, `set`, `dirty`, `changeCount`, `conflicts`, `saving`, `confirmation`, `save`, `overwrite`, `reset`, `reload`) match Step 0's `useTabDraft`. Key lists (`heartbeatKeys`, `channelKeys`, `accessKeys`, `teamKeys`, `capabilityFormKeys`, `profileKeys`) are defined once in `agent-settings-fields.js` and used by the steps and tests. `SubpageHeader({ title, tab, onBack, hint })`, `McpGroup({ …, reloadKey })` and `ProactivityGroup({ assistant, values, set, connected, creating })` are used with these props everywhere.
