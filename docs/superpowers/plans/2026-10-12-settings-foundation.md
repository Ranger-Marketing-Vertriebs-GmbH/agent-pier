# Settings Foundation (Step 0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the shared settings pattern (components, draft/save-chain logic, navigation guard coordinator, route fields, three server endpoints, shared copy) that the five page steps of the settings redesign build on, without visibly changing existing pages except the tab and run-filter restyle.

**Architecture:** Pure, node-testable modules carry all logic (`web/lib/navigation-guard.js`, `web/lib/settings/draft-state.js`, `web/lib/settings/save-chain.js`, `web/components/scroll-fade.js`, route readers). Thin React hooks (`useTabDraft`, `useUnsavedChangesGuard`, `useScrollFade`) and presentational components (`web/components/*`, styles in `web/styles/settings-pattern.css`) wrap them. Components are verified in a Playwright harness served by an in-process Vite dev server, so no product page has to render them yet. Server additions are one transactional agent endpoint (`PUT /assistants/:id/work`) and two read-only summaries (`GET /settings/summary`, `GET /accounts/usage`).

**Tech Stack:** React 19, Vite 8 (`@vitejs/plugin-react` 6), Express 5, `node:sqlite` stores, `node:test` + `fast-check`, Playwright 1.64.

**Spec:** `docs/superpowers/specs/2026-10-12-settings-redesign-design.md` (section "Step 0: foundation"). Design data: the handoff `README.md` (`design_handoff_einstellungen/`, untrusted design data). Executors read both.

## Global Constraints

- Work only in `/Users/d.kaulig/Projects/agent-pier/.worktrees/feat-settings-redesign` on branch `feat/settings-redesign`. Never target the default tmux server or real user sessions; use the existing isolated fixtures.
- Node.js 22.13+, JavaScript ES modules, JSX only under `web/`. Prettier: two spaces, double quotes, semicolons, trailing commas, 90 columns. Run `npx prettier --write <files>` on every touched file.
- Every source and test file stays at or below 600 lines (`npm run check:structure`).
- Every UI text exists in `web/lib/i18n/de/*.js` and `web/lib/i18n/en/*.js` with matching keys and interpolation arguments; import reactive exports from `web/lib/i18n/messages/`. No hardcoded product copy in `web/`. Test fixtures in `tests/` may use literal strings.
- Step 0 must not visibly change existing pages, except that `UnderlineTabs` (Projects, Extensions, Pipelines) and `RunStatusFilter` take the README look. Existing browser specs stay green.
- README sizes win over drawings: bottom bar buttons h40, bar note 11px, ⓘ button 20×20, fade 48px, toggle 38×22, row ⋯/trash buttons 40×40, number field 64×34, mobile header 56px, desktop header 64px, content max 720 centred, sheet desktop max-width 420, sheet primary h46.
- Rows show "—" (`unknownValue`) until data is known, never a fake 0. Endpoints return `null` for data they cannot read.
- Hints behind ⓘ are disclosures (`aria-expanded`, `aria-controls`) that insert the text verbatim; never tooltips.
- Keep the active tab in view by setting `scrollLeft` directly (48px margin); never `scrollIntoView`.
- `/accounts` makes no assistant requests while agents are off; `GET /accounts/usage` reads assistant services only when `services.assistantFeature.enabled` and `services.assistants` are both set.
- Commit messages in English with `feat:`, `fix:`, `chore:`, `test:` or `docs:` prefixes, ending with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Useful commands (verified in `package.json`): single node test `node --test tests/unit/<file>.test.js`; strategy suites `npm run test:unit`, `npm run test:integration`, `npm run test:blackbox`, `npm run test:property`; browser `npm run build && npx playwright test tests/browser/<file>.spec.js`; full gate `npm run check`.

## Review Focus

1. A foreign change arrives while a tab is dirty: untouched fields must adopt the new server value silently, the save must report "changed elsewhere" (409), and "Overwrite anyway" must succeed with the newer revision without reverting the adopted field. Pinned in Task 4 (pure follow/merge), Task 5 (conflict status) and Task 9 (browser flow).
2. A multi-step save fails in step 2: step 1 must not be re-sent on retry (it would 409 against its own new revision), the bar must say "Partially saved: …" and the tab stays dirty. Pinned in Task 5 and Task 9.
3. Two independent protectors (file editor + settings draft) hold the `beforeunload` warning: releasing one must keep the warning while the other still holds it; a released hold must not release twice. Pinned in Task 3.
4. Contradictory or junk deep-link parameters (`/settings/diagnostics?tab=access`, `/agents/a/settings?tab=work&page=memory`, `/accounts?item=x` without section, items with `/`) must normalise deterministically and round-trip, so `useWorkspaceNavigation` never loops on normalisation. Pinned in Task 6 (unit + property).
5. `PUT /assistants/:id/work` with a valid access half and an invalid team half must write nothing (one transaction), and a stale revision on either half must leave both rows unchanged. Pinned in Task 11.

---

## File Structure

New pure logic (node-testable):

- `web/lib/navigation-guard.js` — ordered guard list, serialized navigation requests, reference-counted `beforeunload` hold, `needsDecision()`.
- `web/lib/settings/draft-state.js` — `sameValue`, `changedKeys`, `isDirty`, `followServer`, `markSaved`, `followRevisions`.
- `web/lib/settings/save-chain.js` — `runSaveChain`, `confirmationRequest`, `isConflict`, `completedLabels`.
- `web/components/scroll-fade.js` — `scrollEdges`, `revealScrollLeft`.
- `web/components/link-click.js` — `isPlainClick`.
- `web/features/assistants/settings-routes.js` — agent settings `agentTab`/`agentPage`.
- `web/features/accounts/routes.js` — accounts `section`/`item`.
- `web/features/extensions/routes.js` — extension tabs and the single default tab constant.
- `web/features/assistants/assistant-save-steps.js` — save-chain steps for `PATCH /assistants/:id` (strict base revision) and `PUT /assistants/:id/work`.

New hooks and components:

- `web/lib/settings/useTabDraft.js`, `web/lib/settings/useUnsavedChangesGuard.js`, `web/components/useScrollFade.js`.
- `web/components/InfoHint.jsx`, `GroupLabel.jsx`, `ListCard.jsx`, `ListRow.jsx` (row + control rows), `Segmented.jsx`, `ReferenceRow.jsx`, `SaveBar.jsx`, `Sheet.jsx`, `UnsavedChangesSheet.jsx`, `SettingsShell.jsx`.
- `web/styles/settings-pattern.css` (imported from `web/styles/index.css`).

Changed client files:

- `web/components/UnderlineTabs.jsx`, `underline-tabs.css`, `Icon.jsx`, `LanguageSelect.jsx`.
- `web/features/pipelines/RunStatusFilter.jsx`, `run-table.css`; `web/features/projects/projects.css`; `web/features/extensions/extensions-hub.css`, `ExtensionsPage.jsx`, `ExtensionWorkspace.jsx`.
- `web/app/routes.js`, `web/app/useWorkspaceNavigation.js`; `web/features/operations/routes.js`; `web/features/settings/SettingsPage.jsx`.
- `web/features/files/useFileNavigationGuard.js`, `FileEditorWorkspace.jsx`; delete `web/features/files/file-navigation-guard.js`.
- `web/features/assistants/useSyncedForm.js` (thin wrapper), `synced-form-state.js` (re-export), `assistant-api.js`.
- i18n: `web/lib/i18n/{de,en}/common.js`; split `web/lib/i18n/{de,en}/assistants.js` into `assistants.js` + `assistant-channel.js` + `assistant-team.js` (plus `messages/` exports).

Server:

- `server/features/assistants/assistant-access.js` (split `save` into `prepare` + `write`), `team-store.js` (split `savePolicy` into `writePolicy`), new `assistant-work.js`; new route `server/http/routes/assistant-work.js`, mounted in `server/http/routes/assistants.js`.
- `server/features/operations/releases.js` (`lastCheck()`), new `server/features/settings/settings-summary.js`, new route `server/http/routes/settings-summary.js`, mounted in `server/app.js`.
- New `server/features/accounts/account-usage.js`; `server/http/routes/accounts.js` gets `GET /accounts/usage`.

Tests and harness:

- Unit: `tests/unit/navigation-guard.test.js` (replaces `file-navigation-guard.test.js`), `settings-draft-state.test.js`, `settings-save-chain.test.js`, `settings-routes.test.js`, `scroll-fade.test.js`, `common-copy.test.js`, `assistant-catalog-split.test.js`, `assistant-save-steps.test.js`, `settings-summary.test.js`, `account-usage.test.js`.
- Property: `tests/property/settings-draft.test.js`; extend `tests/property/routes.test.js`.
- Blackbox: `tests/blackbox/assistant-work-routes.test.js`, `tests/blackbox/settings-summary-routes.test.js`, `tests/blackbox/account-usage-routes.test.js`.
- Browser harness: `tests/helpers/settings-pattern-harness.js`, `tests/browser/harness/settings-pattern/{index.html,main.js,tabs-fixture.js,list-fixture.js,draft-fixture.js,shell-fixture.js}`; specs `tests/browser/settings-pattern-{tabs,list,draft,shell}.spec.js`.
- Docs: new `docs/settings-pattern.md`; a pointer in `docs/architecture.md` and `web/README.md`.

### Decisions that refine the spec

- **Extensions default tab stays `"mcp"` in step 0.** Flipping it to `"skills"` now would visibly change the Extensions page and break `extensions.spec.js` while the MCP tab still exists. Step 0 centralises the default in `web/features/extensions/routes.js` (`defaultExtensionTab`) and replaces the five hardcoded `"mcp"` uses with it; step 4 flips the constant, maps `?tab=mcp` to `skills` in `readExtensionTab` and removes the tab. Old links then redirect through the existing normalisation in `useWorkspaceNavigation` (it replaces any address whose `routePath` differs).
- **Route fields are optional for agents and accounts.** `readRoute` adds `agentTab`/`agentPage` and `section`/`item` only when the address carries a non-default valid value, so existing deep-equal tests and every `navigate({ view: "agents", assistantId, agentSettings: true })` call keep working. Consumers read them through `agentSettingsLocation(route)`; accounts consumers default `section` to none. `settingsTab` is always present (the settings route already always carries all its fields).
- **`settingsSection: "general"` doubles as the tab root.** `/settings?tab=access` is `{ settingsSection: "general", settingsTab: "access" }`; a real section always derives its tab and drops a contradicting `?tab=`.
- **The shared catalog is the existing `commonCopy`** (`web/lib/i18n/{de,en}/common.js`); no new `common` file. Page steps must not add keys to `common.js` (merge conflicts); page copy goes to page catalogs.
- **Confirmations are an `ask()` callback, not a resumable state machine.** `runSaveChain` awaits `ask(request)`; `useTabDraft` exposes the pending request as `draft.confirmation` with `confirm()`/`cancel()`. This keeps the chain one async function and makes "resume with flags" trivial.
- **Completed steps are skipped on retry by key ownership.** Each step declares `keys`; a finished step marks its keys saved in the draft base, so a retry after a partial failure skips it automatically.
- **Toggles are native `<input type="checkbox" role="switch">`.** Keyboard, labels, forms and Playwright `check()` keep working; `aria-checked` is implied by `checked`.
- **"AgentPier MCP connected CLIs"** has no server-side per-CLI state; the summary reports `{ available, activeGrants }` (active OAuth grants). The settings page step words the row accordingly.
- **Component browser tests run against a harness**, served by an in-process Vite dev server from `tests/browser/harness/settings-pattern/`, because no product page renders the new components in step 0.

---

### Task 1: Split the agent copy catalog

`web/lib/i18n/de/assistants.js` (535 lines) and `en/assistants.js` (521) are too close to the 600-line limit for the agent page step. Move the `channel` block (de 271–383, en 265–372) and the `team` block (de 145–204, en 141–199) into their own catalogs; `assistantCopy.channel` and `assistantCopy.team` keep working unchanged for every consumer.

**Files:**

- Create: `web/lib/i18n/de/assistant-channel.js`, `web/lib/i18n/en/assistant-channel.js`, `web/lib/i18n/messages/assistant-channel.js`
- Create: `web/lib/i18n/de/assistant-team.js`, `web/lib/i18n/en/assistant-team.js`, `web/lib/i18n/messages/assistant-team.js`
- Modify: `web/lib/i18n/de/assistants.js`, `web/lib/i18n/en/assistants.js`
- Test: `tests/unit/assistant-catalog-split.test.js`

**Interfaces:**

- Consumes: `localizedCopy(german, english)` from `web/lib/i18n/index.js`.
- Produces: `assistantChannelCopy` and `assistantTeamCopy` (de, en, reactive in `messages/`). `assistantCopy.channel === <same content as> assistantChannelCopy`, `assistantCopy.team` likewise. The agent page step adds new agent keys to these smaller files or to `assistants.js` (now ~365 lines).

- [ ] **Step 1: Write the failing test**

Create `tests/unit/assistant-catalog-split.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setLanguage } from "../../web/lib/i18n/index.js";
import { assistantCopy } from "../../web/lib/i18n/messages/assistants.js";
import { assistantChannelCopy } from "../../web/lib/i18n/messages/assistant-channel.js";
import { assistantTeamCopy } from "../../web/lib/i18n/messages/assistant-team.js";

const lines = (file) =>
  fs
    .readFileSync(new URL(`../../web/lib/i18n/${file}`, import.meta.url), "utf8")
    .trimEnd()
    .split("\n").length;

// The agent catalog is split so the settings redesign has room for new keys.
test("agent channel and team copy live in their own catalogs", (t) => {
  t.after(() => setLanguage("de", { persist: false }));
  for (const language of ["de", "en"]) {
    setLanguage(language, { persist: false });
    assert.equal(assistantCopy.channel.language, assistantChannelCopy.language, language);
    assert.equal(
      assistantCopy.team.modelChanged,
      assistantTeamCopy.modelChanged,
      language,
    );
  }
  for (const file of ["de/assistants.js", "en/assistants.js"])
    assert.ok(lines(file) < 420, `${file} has ${lines(file)} lines`);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/unit/assistant-catalog-split.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `messages/assistant-channel.js`.

- [ ] **Step 3: Extract the blocks with a one-off script**

Write `/private/tmp/claude-501/-Users-d-kaulig-Projects-agent-pier/0d5c98d6-b0d4-4541-a7b3-6544cc3005e1/scratchpad/split-assistant-copy.mjs` (scratchpad, not committed):

```js
import fs from "node:fs";
import path from "node:path";
const root = path.resolve(process.argv[2], "web/lib/i18n");
const blocks = [
  ["channel", "assistant-channel.js", "assistantChannelCopy"],
  ["team", "assistant-team.js", "assistantTeamCopy"],
];
for (const language of ["de", "en"]) {
  const file = path.join(root, language, "assistants.js");
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const imports = [];
  for (const [key, target, name] of blocks) {
    const start = lines.indexOf(`  ${key}: {`);
    const end = lines.findIndex((line, index) => index > start && line === "  },");
    if (start < 0 || end < 0) throw new Error(`${language}: ${key} block not found`);
    const body = lines
      .slice(start + 1, end)
      .map((line) => (line.startsWith("  ") ? line.slice(2) : line));
    fs.writeFileSync(
      path.join(root, language, target),
      `export const ${name} = {\n${body.join("\n")}\n};\n`,
    );
    lines.splice(start, end - start + 1, `  ${key}: ${name},`);
    imports.push(`import { ${name} } from "./${target}";`);
  }
  fs.writeFileSync(file, `${imports.join("\n")}\n${lines.join("\n")}`);
}
for (const [, target, name] of blocks)
  fs.writeFileSync(
    path.join(root, "messages", target),
    `import * as de from "../de/${target}";\nimport * as en from "../en/${target}";\nimport { localizedCopy } from "../index.js";\nexport const ${name} = localizedCopy(de.${name}, en.${name});\n`,
  );
```

Run:

```bash
node /private/tmp/claude-501/-Users-d-kaulig-Projects-agent-pier/0d5c98d6-b0d4-4541-a7b3-6544cc3005e1/scratchpad/split-assistant-copy.mjs /Users/d.kaulig/Projects/agent-pier/.worktrees/feat-settings-redesign
npx prettier --write web/lib/i18n/de/assistants.js web/lib/i18n/en/assistants.js web/lib/i18n/de/assistant-channel.js web/lib/i18n/en/assistant-channel.js web/lib/i18n/de/assistant-team.js web/lib/i18n/en/assistant-team.js web/lib/i18n/messages/assistant-channel.js web/lib/i18n/messages/assistant-team.js
git diff --stat
```

Expected: `assistants.js` shrinks by ~170 lines in each language; the moved text is byte-identical apart from indentation (check `git diff -w` shows only moves).

- [ ] **Step 4: Run the tests**

Run: `node --test tests/unit/assistant-catalog-split.test.js tests/unit/i18n-catalogs.test.js tests/unit/i18n-terminology.test.js tests/unit/assistant-chat-copy.test.js`
Expected: PASS (parity test now also covers the two new catalog files).

- [ ] **Step 5: Lint and commit**

```bash
npx eslint web/lib/i18n tests/unit/assistant-catalog-split.test.js
git add web/lib/i18n tests/unit/assistant-catalog-split.test.js
git commit -m "chore: split agent channel and team copy into their own catalogs" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: Shared settings copy and the language label

**Files:**

- Modify: `web/lib/i18n/de/common.js`, `web/lib/i18n/en/common.js`
- Modify: `web/components/LanguageSelect.jsx:10`
- Test: `tests/unit/common-copy.test.js`

**Interfaces:**

- Produces (`commonCopy` from `web/lib/i18n/messages/common.js`, used by all later tasks and page steps):
  - strings: `language`, `centralInAccounts`, `usedBy`, `unsavedTitle`, `saveAndSwitch`, `discard`, `showHint`, `changedElsewhere`, `overwrite`, `unsavedChanges`, `moreActions`, `confirm`
  - functions: `agentsCount(count)`, `ofCount(part, total)`, `unsavedBody(tab, count)`, `partiallySaved(steps)`
  - existing keys reused: `save`, `saving`, `cancel`, `reloadLatest`, `accounts`, `back`, `delete`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/common-copy.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setLanguage } from "../../web/lib/i18n/index.js";
import { commonCopy } from "../../web/lib/i18n/messages/common.js";

test("shared settings copy counts and names the tab in both languages", (t) => {
  t.after(() => setLanguage("de", { persist: false }));
  setLanguage("de", { persist: false });
  assert.equal(commonCopy.agentsCount(1), "1 Agent");
  assert.equal(commonCopy.agentsCount(3), "3 Agenten");
  assert.equal(commonCopy.ofCount(2, 5), "2 von 5");
  assert.equal(
    commonCopy.unsavedBody("Profil", 1),
    "Im Tab Profil ist 1 Änderung noch nicht gespeichert.",
  );
  assert.equal(
    commonCopy.unsavedBody("Profil", 3),
    "Im Tab Profil sind 3 Änderungen noch nicht gespeichert.",
  );
  assert.equal(commonCopy.partiallySaved("Profil"), "Teilweise gespeichert: Profil.");
  setLanguage("en", { persist: false });
  assert.equal(commonCopy.agentsCount(1), "1 agent");
  assert.equal(commonCopy.agentsCount(2), "2 agents");
  assert.equal(
    commonCopy.unsavedBody("Profile", 1),
    "1 change in Profile is not saved yet.",
  );
  assert.equal(
    commonCopy.unsavedBody("Profile", 2),
    "2 changes in Profile are not saved yet.",
  );
  assert.equal(commonCopy.language, "Language");
});

test("the language selector takes its label from the catalog", () => {
  const source = fs.readFileSync(
    new URL("../../web/components/LanguageSelect.jsx", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /"Sprache"|"Language"/);
  assert.match(source, /commonCopy\.language/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/unit/common-copy.test.js`
Expected: FAIL with `TypeError: commonCopy.agentsCount is not a function`.

- [ ] **Step 3: Add the keys**

In `web/lib/i18n/de/common.js`, insert before `installTitle: (name) => ...`:

```js
  language: "Sprache",
  centralInAccounts: "Zentral unter Accounts",
  usedBy: "Genutzt von",
  unsavedTitle: "Änderungen speichern?",
  saveAndSwitch: "Speichern und wechseln",
  discard: "Verwerfen",
  showHint: "Hinweis anzeigen",
  changedElsewhere: "Inzwischen an anderer Stelle geändert.",
  overwrite: "Trotzdem überschreiben",
  unsavedChanges: "Ungespeicherte Änderungen",
  moreActions: "Weitere Aktionen",
  confirm: "Bestätigen",
  agentsCount: (count) => (count === 1 ? "1 Agent" : `${count} Agenten`),
  ofCount: (part, total) => `${part} von ${total}`,
  unsavedBody: (tab, count) =>
    count === 1
      ? `Im Tab ${tab} ist 1 Änderung noch nicht gespeichert.`
      : `Im Tab ${tab} sind ${count} Änderungen noch nicht gespeichert.`,
  partiallySaved: (steps) => `Teilweise gespeichert: ${steps}.`,
```

In `web/lib/i18n/en/common.js`, insert at the same position:

```js
  language: "Language",
  centralInAccounts: "Managed centrally in Accounts",
  usedBy: "Used by",
  unsavedTitle: "Save changes?",
  saveAndSwitch: "Save and switch",
  discard: "Discard",
  showHint: "Show hint",
  changedElsewhere: "Changed elsewhere in the meantime.",
  overwrite: "Overwrite anyway",
  unsavedChanges: "Unsaved changes",
  moreActions: "More actions",
  confirm: "Confirm",
  agentsCount: (count) => (count === 1 ? "1 agent" : `${count} agents`),
  ofCount: (part, total) => `${part} of ${total}`,
  unsavedBody: (tab, count) =>
    count === 1
      ? `1 change in ${tab} is not saved yet.`
      : `${count} changes in ${tab} are not saved yet.`,
  partiallySaved: (steps) => `Partially saved: ${steps}.`,
```

- [ ] **Step 4: Use the catalog label in `LanguageSelect`**

In `web/components/LanguageSelect.jsx` add the import and replace line 10:

```jsx
import { commonCopy } from "../lib/i18n/messages/common.js";
```

```jsx
<label htmlFor={id}>{commonCopy.language}</label>
```

The component already re-renders on language change through `useLanguage()`; the endonyms "Deutsch"/"English" stay literal (they are language names, not copy).

- [ ] **Step 5: Run the tests**

Run: `node --test tests/unit/common-copy.test.js tests/unit/i18n-catalogs.test.js tests/unit/i18n-terminology.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
npx prettier --write web/lib/i18n/de/common.js web/lib/i18n/en/common.js web/components/LanguageSelect.jsx tests/unit/common-copy.test.js
npx eslint web/components/LanguageSelect.jsx web/lib/i18n tests/unit/common-copy.test.js
git add web/lib/i18n web/components/LanguageSelect.jsx tests/unit/common-copy.test.js
git commit -m "feat: add shared settings copy and translate the language label" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: Navigation guard coordinator

Replace the single-slot `web/features/files/file-navigation-guard.js` with an ordered guard list in `web/lib/navigation-guard.js`. The file editor and every settings draft register independently; one reference-counted `beforeunload` listener serves all of them.

**Files:**

- Create: `web/lib/navigation-guard.js`
- Delete: `web/features/files/file-navigation-guard.js`
- Modify: `web/features/files/useFileNavigationGuard.js:4-7,45-53`, `web/features/files/FileEditorWorkspace.jsx:6`, `web/app/useWorkspaceNavigation.js:7`
- Test: move `tests/unit/file-navigation-guard.test.js` to `tests/unit/navigation-guard.test.js` and extend it

**Interfaces:**

- Produces (`web/lib/navigation-guard.js`):
  - `createNavigationCoordinator({ target = globalThis.window } = {})` → `{ register(guard), request(request), holdUnload(), unloadHeld() }`
    - `guard(request) => boolean | Promise<boolean>`; guards run in registration order; the first `false` cancels; `register` returns an `unregister()` that removes exactly that registration.
    - `request({ next?, reason, tabId?, commit? }) => Promise<boolean>`; requests are serialized; a newer request invalidates an older one still waiting on a guard (the older resolves `false`, its `commit` never runs). `reason` values in use: `"application"`, `"normalization"`, `"history"`, `"history-unindexed"`, `"tab-close"`.
    - `holdUnload() => release()`; the first hold adds one `beforeunload` listener on `target`, the last release removes it; calling one `release` twice is a no-op.
  - Singletons: `registerNavigationGuard(guard)`, `requestNavigation(request)`, `holdUnloadWarning()`.
  - `passiveNavigationReasons` (`Set(["normalization", "tab-close"])`) and `needsDecision(request, { dirty, stays = () => false }) => boolean` — true only when the draft is dirty, the reason is not passive and `stays(request)` is false. Settings drafts use it (Task 9).

- [ ] **Step 1: Move the test and write the new failing cases**

```bash
git mv tests/unit/file-navigation-guard.test.js tests/unit/navigation-guard.test.js
```

In `tests/unit/navigation-guard.test.js` replace the import line with:

```js
import {
  createNavigationCoordinator,
  needsDecision,
} from "../../web/lib/navigation-guard.js";
```

and replace every `createFileNavigationCoordinator()` with `createNavigationCoordinator()`. Append:

```js
test("every registered guard is asked in order and the first refusal cancels", async () => {
  const coordinator = createNavigationCoordinator();
  const asked = [];
  coordinator.register(async () => {
    asked.push("files");
    return true;
  });
  const unregisterSettings = coordinator.register(() => {
    asked.push("settings");
    return false;
  });
  let commits = 0;
  const request = { reason: "application", commit: () => commits++ };
  assert.equal(await coordinator.request(request), false);
  assert.deepEqual(asked, ["files", "settings"]);
  assert.equal(commits, 0);
  unregisterSettings();
  assert.equal(await coordinator.request(request), true);
  assert.equal(commits, 1);
});

test("the unload warning stays while any protector holds it", () => {
  const target = new EventTarget();
  const coordinator = createNavigationCoordinator({ target });
  const unload = () => {
    const event = new Event("beforeunload", { cancelable: true });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  };
  assert.equal(unload(), false);
  const releaseEditor = coordinator.holdUnload();
  const releaseDraft = coordinator.holdUnload();
  assert.equal(unload(), true);
  releaseEditor();
  releaseEditor();
  assert.equal(coordinator.unloadHeld(), true);
  assert.equal(unload(), true);
  releaseDraft();
  assert.equal(coordinator.unloadHeld(), false);
  assert.equal(unload(), false);
});

test("settings drafts ignore passive navigation and their own destinations", () => {
  const stays = (request) => request.next?.tab === "profile";
  const app = { reason: "application", next: { tab: "work" } };
  assert.equal(needsDecision(app, { dirty: true, stays }), true);
  assert.equal(needsDecision(app, { dirty: false, stays }), false);
  assert.equal(
    needsDecision({ ...app, reason: "normalization" }, { dirty: true }),
    false,
  );
  assert.equal(needsDecision({ reason: "tab-close" }, { dirty: true }), false);
  assert.equal(
    needsDecision(
      { reason: "application", next: { tab: "profile" } },
      { dirty: true, stays },
    ),
    false,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/unit/navigation-guard.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `web/lib/navigation-guard.js`.

- [ ] **Step 3: Implement the coordinator**

Create `web/lib/navigation-guard.js`:

```js
// One coordinator for every navigation that could discard unsaved work: app routes,
// browser history, editor tab closes. Guards are asked in registration order; a
// newer request invalidates an older one that still waits for a decision.
export const passiveNavigationReasons = new Set(["normalization", "tab-close"]);

/** True when a dirty draft must ask before `request` leaves it. */
export function needsDecision(request, { dirty, stays = () => false }) {
  return (
    Boolean(dirty) && !passiveNavigationReasons.has(request?.reason) && !stays(request)
  );
}

export function createNavigationCoordinator({ target = globalThis.window } = {}) {
  const guards = [];
  let generation = 0;
  let queue = Promise.resolve();
  let holds = 0;
  const warn = (event) => {
    event.preventDefault();
    event.returnValue = "";
  };
  return {
    register(guard) {
      const entry = { guard };
      guards.push(entry);
      return () => {
        const index = guards.indexOf(entry);
        if (index >= 0) guards.splice(index, 1);
      };
    },
    request(request) {
      const owner = ++generation;
      const run = async () => {
        for (const { guard } of [...guards]) {
          if (owner !== generation) return false;
          if (!(await guard(request))) return false;
        }
        if (owner !== generation) return false;
        await request.commit?.();
        return true;
      };
      const result = queue.then(run, run);
      queue = result.catch(() => {});
      return result;
    },
    holdUnload() {
      let held = true;
      if (holds++ === 0) target?.addEventListener("beforeunload", warn);
      return () => {
        if (!held) return;
        held = false;
        if (--holds === 0) target?.removeEventListener("beforeunload", warn);
      };
    },
    unloadHeld: () => holds > 0,
  };
}

const coordinator = createNavigationCoordinator();
export const registerNavigationGuard = (guard) => coordinator.register(guard);
export const requestNavigation = (request) => coordinator.request(request);
export const holdUnloadWarning = () => coordinator.holdUnload();
```

- [ ] **Step 4: Move the callers**

```bash
git rm web/features/files/file-navigation-guard.js
```

`web/features/files/useFileNavigationGuard.js` — replace the import block at lines 4–7 with:

```js
import {
  holdUnloadWarning,
  registerNavigationGuard as registerFileNavigationGuard,
  requestNavigation as requestFileNavigation,
} from "../../lib/navigation-guard.js";
```

and replace the `beforeunload` effect (lines 45–53) with:

```js
// One shared listener warns before unload while any protector holds it.
useEffect(() => (hasRetainedTabs ? holdUnloadWarning() : undefined), [hasRetainedTabs]);
```

`web/features/files/FileEditorWorkspace.jsx:6`:

```js
import { requestNavigation as requestFileNavigation } from "../../lib/navigation-guard.js";
```

`web/app/useWorkspaceNavigation.js:7`:

```js
import { requestNavigation as requestFileNavigation } from "../lib/navigation-guard.js";
```

- [ ] **Step 5: Run the unit tests and the editor navigation browser spec**

Run: `node --test tests/unit/navigation-guard.test.js`
Expected: PASS (4 original + 3 new tests).

Run: `npm run build && npx playwright test tests/browser/file-explorer-editor-navigation.spec.js tests/browser/navigation.spec.js`
Expected: PASS, including "beforeunload registration follows protected editor state" (exactly one add, one remove).

- [ ] **Step 6: Commit**

```bash
npx prettier --write web/lib/navigation-guard.js web/features/files/useFileNavigationGuard.js web/features/files/FileEditorWorkspace.jsx web/app/useWorkspaceNavigation.js tests/unit/navigation-guard.test.js
npx eslint web/lib/navigation-guard.js web/features/files web/app tests/unit/navigation-guard.test.js
git add -A web/lib/navigation-guard.js web/features/files web/app/useWorkspaceNavigation.js tests/unit
git commit -m "feat: coordinate navigation guards for editors and settings drafts" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4: Draft state rules

Extract the comparison and server-follow rules of `useSyncedForm` into pure functions that the new `useTabDraft` (Task 9) and the old wrapper share.

**Files:**

- Create: `web/lib/settings/draft-state.js`
- Modify: `web/features/assistants/synced-form-state.js` (re-export)
- Test: `tests/unit/settings-draft-state.test.js`, `tests/property/settings-draft.test.js`

**Interfaces:**

- Produces (`web/lib/settings/draft-state.js`):
  - `sameValue(a, b) => boolean` (JSON equality, as before)
  - `changedKeys(values, base) => string[]` (keys on either side whose values differ)
  - `isDirty(values, base) => boolean`
  - `followServer({ values, base }, server) => { values, base, conflicts: string[] }` — untouched keys adopt the server value, edited keys stay; a key edited locally and changed on the server is a conflict. Returns the same `values`/`base` objects when nothing changed.
  - `markSaved(base, values, keys) => base` — the saved snapshot of `keys` becomes the new base.
  - `followRevisions(current, latest) => revisions` — per resource the larger safe integer wins (revisions only grow), unknown values take `latest`.
- `web/features/assistants/synced-form-state.js` keeps exporting `sameValue` and `isDirty` (existing test `tests/unit/assistant-synced-form-state.test.js` stays unchanged).

- [ ] **Step 1: Write the failing unit test**

Create `tests/unit/settings-draft-state.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  changedKeys,
  followRevisions,
  followServer,
  markSaved,
} from "../../web/lib/settings/draft-state.js";

const base = { name: "Home", memory: false, team: 4 };

test("changed keys compare by value on both sides", () => {
  assert.deepEqual(changedKeys({ ...base }, base), []);
  assert.deepEqual(changedKeys({ ...base, name: "Office" }, base), ["name"]);
  const { team: _team, ...withoutTeam } = base;
  assert.deepEqual(changedKeys(withoutTeam, base), ["team"]);
});

test("untouched fields adopt server values and edited fields stay", () => {
  const draft = { values: { ...base, name: "Office" }, base };
  const next = followServer(draft, { ...base, memory: true });
  assert.deepEqual(next.values, { name: "Office", memory: true, team: 4 });
  assert.deepEqual(next.base, { name: "Home", memory: true, team: 4 });
  assert.deepEqual(next.conflicts, []);
});

test("a field edited here and changed on the server is a conflict", () => {
  const draft = { values: { ...base, name: "Office" }, base };
  const next = followServer(draft, { ...base, name: "Studio" });
  assert.equal(next.values.name, "Office");
  assert.deepEqual(next.conflicts, ["name"]);
});

test("a server value equal to the edit settles the field", () => {
  const draft = { values: { ...base, name: "Office" }, base };
  const next = followServer(draft, { ...base, name: "Office" });
  assert.deepEqual(changedKeys(next.values, next.base), []);
});

test("an unchanged server keeps the same objects", () => {
  const draft = { values: { ...base }, base };
  const next = followServer(draft, { ...base });
  assert.equal(next.values, draft.values);
  assert.equal(next.base, draft.base);
});

test("saved keys move into the base and revisions only grow", () => {
  const values = { ...base, name: "Office", team: 6 };
  assert.deepEqual(markSaved(base, values, ["name"]), { ...base, name: "Office" });
  assert.deepEqual(
    followRevisions({ agent: 5, team: 2 }, { agent: 4, team: 3, access: 1 }),
    {
      agent: 5,
      team: 3,
      access: 1,
    },
  );
});
```

- [ ] **Step 2: Write the failing property test**

Create `tests/property/settings-draft.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { check } from "../helpers/property.js";
import { followServer, sameValue } from "../../web/lib/settings/draft-state.js";

const keys = ["a", "b", "c", "d"];
const record = fc.record(
  Object.fromEntries(keys.map((key) => [key, fc.integer({ min: 0, max: 2 })])),
);

test("following the server never loses an edit and never keeps a stale untouched value", () => {
  check(
    fc.property(record, record, record, (base, values, server) => {
      const next = followServer({ values, base }, server);
      for (const key of keys) {
        const edited = !sameValue(values[key], base[key]);
        if (!edited) assert.equal(next.values[key], server[key], `untouched ${key}`);
        else assert.equal(next.values[key], values[key], `edited ${key}`);
        const conflict =
          edited &&
          !sameValue(values[key], server[key]) &&
          !sameValue(server[key], base[key]);
        assert.equal(next.conflicts.includes(key), conflict, `conflict ${key}`);
      }
    }),
  );
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test tests/unit/settings-draft-state.test.js tests/property/settings-draft.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `web/lib/settings/draft-state.js`.

- [ ] **Step 4: Implement**

Create `web/lib/settings/draft-state.js`:

```js
// Pure rules behind settings drafts (useTabDraft, useSyncedForm). A draft holds the
// edited `values` and the `base` they were edited from; the base follows the server
// for fields the owner did not touch.
export const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function changedKeys(values, base) {
  const keys = new Set([...Object.keys(values), ...Object.keys(base)]);
  return [...keys].filter((key) => !sameValue(values[key], base[key]));
}

export const isDirty = (values, base) => changedKeys(values, base).length > 0;

/**
 * Applies a newer server record: untouched fields adopt it, edited fields stay, and an
 * edited field the server changed as well is reported as a conflict.
 */
export function followServer({ values, base }, server) {
  const nextValues = { ...values };
  const nextBase = { ...base };
  const conflicts = [];
  for (const key of Object.keys(server)) {
    if (sameValue(nextValues[key], server[key])) nextBase[key] = server[key];
    else if (sameValue(server[key], nextBase[key])) continue;
    else if (sameValue(nextValues[key], nextBase[key])) {
      nextValues[key] = server[key];
      nextBase[key] = server[key];
    } else conflicts.push(key);
  }
  return {
    values: sameValue(nextValues, values) ? values : nextValues,
    base: sameValue(nextBase, base) ? base : nextBase,
    conflicts,
  };
}

/** The saved snapshot of `keys` becomes their new base. */
export function markSaved(base, values, keys) {
  const next = { ...base };
  for (const key of keys) next[key] = values[key];
  return next;
}

/** Revisions only grow: a response can be newer than the props that follow it. */
export function followRevisions(current, latest) {
  const next = { ...current };
  for (const [resource, revision] of Object.entries(latest || {}))
    next[resource] =
      Number.isSafeInteger(revision) && Number.isSafeInteger(next[resource])
        ? Math.max(revision, next[resource])
        : revision;
  return next;
}
```

Replace the whole of `web/features/assistants/synced-form-state.js` with:

```js
// The comparisons moved to the shared settings draft rules; kept for existing imports.
export { isDirty, sameValue } from "../../lib/settings/draft-state.js";
```

- [ ] **Step 5: Run the tests**

Run: `node --test tests/unit/settings-draft-state.test.js tests/property/settings-draft.test.js tests/unit/assistant-synced-form-state.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
npx prettier --write web/lib/settings/draft-state.js web/features/assistants/synced-form-state.js tests/unit/settings-draft-state.test.js tests/property/settings-draft.test.js
npx eslint web/lib/settings web/features/assistants/synced-form-state.js tests/unit/settings-draft-state.test.js tests/property/settings-draft.test.js
git add web/lib/settings web/features/assistants/synced-form-state.js tests/unit/settings-draft-state.test.js tests/property/settings-draft.test.js
git commit -m "feat: share the draft rules of synced settings forms" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 5: Save chain

One save button may call several endpoints. `runSaveChain` runs steps in order, skips steps whose fields are unchanged, asks for confirmations and repeats the step with the confirmation flags, stops at the first error and reports what was saved.

**Files:**

- Create: `web/lib/settings/save-chain.js`
- Test: `tests/unit/settings-save-chain.test.js`

**Interfaces:**

- Consumes: `changedKeys`, `sameValue` (Task 4).
- Produces (`web/lib/settings/save-chain.js`):
  - **Step** object: `{ id: string, label: string, keys?: string[], resource?: string, run(ctx) => Promise<result>, revisions?(result) => { [resource]: number }, confirmation?(error) => ConfirmationRequest | null, isConflict?(error) => boolean }`
    - `keys`: the draft fields this step saves. When none of them changed the step is skipped; when it succeeds they count as saved. Omit `keys` for a step that must always run.
    - `resource`: the revision slot this step reads (`ctx.revision`) and, by default, updates from `result.revision`. `revisions(result)` overrides for steps that touch several resources (e.g. `{ access, team }`).
  - **ctx** passed to `run`: `{ values, base, changed: string[], revision: number | undefined, revisions: object, confirmations: object, results: { [stepId]: result } }`. `confirmations` holds the flags confirmed for this step only (e.g. `{ confirmRestart: true }`); steps spread it into the request body.
  - **ConfirmationRequest**: `{ kind: "shell" | "fullShell" | "stdio" | "restart" | string, flags: object, data?: object }`. Default mapping `confirmationRequest(error)`:
    - `ASSISTANT_SHELL_CONFIRMATION_REQUIRED` → `{ kind: required[0] === "confirmFull" ? "fullShell" : "shell", flags: { [required[0]]: true }, data: { required } }`
    - `MCP_STDIO_CONFIRMATION_REQUIRED` → `{ kind: "stdio", flags: { confirmStdio: true } }`
    - `ASSISTANT_RESTART_REQUIRED` → `{ kind: "restart", flags: { confirmRestart: true }, data: { affected } }`
  - `runSaveChain({ steps, values, base, revisions = {}, ask = async () => false }) => Promise<ChainResult>`; `ask({ ...request, stepId })` resolves `true` (repeat the step with the flags) or `false` (stop, status `"cancelled"`). The same flags requested again after confirming are treated as an error.
  - **ChainResult**: `{ status: "saved" | "cancelled" | "conflict" | "error", completed: string[], savedKeys: string[], results, revisions, failedStep?: string, error?: Error }`.
  - `isConflict(error)`: `status === 409` and `messageKey` ends with `conflict` (e.g. `assistants.conflict`).
  - `completedLabels(steps, result) => string[]` — labels of completed steps, for "Partially saved: …".

- [ ] **Step 1: Write the failing test**

Create `tests/unit/settings-save-chain.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  completedLabels,
  confirmationRequest,
  isConflict,
  runSaveChain,
} from "../../web/lib/settings/save-chain.js";

const base = { name: "Home", memory: false, team: 4 };
const conflict = () =>
  Object.assign(new Error("changed"), { status: 409, messageKey: "assistants.conflict" });

function steps(log, { failTeam = false } = {}) {
  return [
    {
      id: "agent",
      label: "Profil",
      keys: ["name", "memory"],
      resource: "agent",
      run: async ({ values, revision }) => {
        log.push(["agent", values.name, revision]);
        return { revision: revision + 1 };
      },
    },
    {
      id: "team",
      label: "Team",
      keys: ["team"],
      resource: "team",
      run: async ({ values, revision, results }) => {
        log.push(["team", values.team, revision, results.agent?.revision]);
        if (failTeam) throw new Error("Team failed");
        return { revision: revision + 1 };
      },
    },
  ];
}

test("steps run in order, pass revisions on and skip unchanged fields", async () => {
  const log = [];
  const result = await runSaveChain({
    steps: steps(log),
    values: { ...base, name: "Office" },
    base,
    revisions: { agent: 3, team: 7 },
  });
  assert.equal(result.status, "saved");
  assert.deepEqual(log, [["agent", "Office", 3]]);
  assert.deepEqual(result.completed, ["agent"]);
  assert.deepEqual(result.savedKeys, ["name", "memory"]);
  assert.deepEqual(result.revisions, { agent: 4, team: 7 });
});

test("the chain stops at the first error and reports the partial save", async () => {
  const log = [];
  const all = steps(log, { failTeam: true });
  const result = await runSaveChain({
    steps: all,
    values: { ...base, name: "Office", team: 6 },
    base,
    revisions: { agent: 3, team: 7 },
  });
  assert.equal(result.status, "error");
  assert.equal(result.failedStep, "team");
  assert.equal(result.error.message, "Team failed");
  assert.deepEqual(result.savedKeys, ["name", "memory"]);
  assert.deepEqual(completedLabels(all, result), ["Profil"]);
  assert.deepEqual(log[1], ["team", 6, 7, 4]);
});

test("a retry after a partial save skips the step that already finished", async () => {
  const log = [];
  const values = { ...base, name: "Office", team: 6 };
  const first = await runSaveChain({
    steps: steps(log, { failTeam: true }),
    values,
    base,
    revisions: { agent: 3, team: 7 },
  });
  const savedBase = { ...base, name: "Office" };
  const second = await runSaveChain({
    steps: steps(log),
    values,
    base: savedBase,
    revisions: first.revisions,
  });
  assert.equal(second.status, "saved");
  assert.deepEqual(
    log.map(([id]) => id),
    ["agent", "team", "team"],
  );
  assert.deepEqual(second.revisions, { agent: 4, team: 8 });
});

test("a confirmation repeats the same step with the confirmed flag", async () => {
  const bodies = [];
  const step = {
    id: "agent",
    label: "Fähigkeiten",
    keys: ["memory"],
    resource: "agent",
    run: async ({ confirmations, revision }) => {
      bodies.push({ ...confirmations, revision });
      if (!confirmations.confirmRestart)
        throw Object.assign(new Error("restart"), {
          status: 409,
          code: "ASSISTANT_RESTART_REQUIRED",
          affected: { agents: [{ id: "a", name: "A" }] },
        });
      return { revision: revision + 1 };
    },
  };
  const asked = [];
  const result = await runSaveChain({
    steps: [step],
    values: { ...base, memory: true },
    base,
    revisions: { agent: 1 },
    ask: async (request) => {
      asked.push(request);
      return true;
    },
  });
  assert.equal(result.status, "saved");
  assert.deepEqual(bodies, [{ revision: 1 }, { confirmRestart: true, revision: 1 }]);
  assert.equal(asked[0].kind, "restart");
  assert.equal(asked[0].stepId, "agent");
  assert.deepEqual(asked[0].data.affected.agents, [{ id: "a", name: "A" }]);
});

test("a declined confirmation cancels and a repeated request is an error", async () => {
  const restart = () =>
    Object.assign(new Error("restart"), { code: "ASSISTANT_RESTART_REQUIRED" });
  const step = {
    id: "agent",
    label: "A",
    keys: ["memory"],
    run: async () => {
      throw restart();
    },
  };
  const input = { steps: [step], values: { ...base, memory: true }, base };
  assert.equal(
    (await runSaveChain({ ...input, ask: async () => false })).status,
    "cancelled",
  );
  const repeated = await runSaveChain({ ...input, ask: async () => true });
  assert.equal(repeated.status, "error");
  assert.equal(repeated.error.code, "ASSISTANT_RESTART_REQUIRED");
});

test("a stale revision is reported as a conflict", async () => {
  const step = {
    id: "agent",
    label: "A",
    keys: ["name"],
    run: async () => {
      throw conflict();
    },
  };
  const result = await runSaveChain({
    steps: [step],
    values: { ...base, name: "Office" },
    base,
  });
  assert.equal(result.status, "conflict");
  assert.equal(result.failedStep, "agent");
  assert.equal(isConflict(conflict()), true);
  assert.equal(isConflict(Object.assign(new Error(), { status: 409 })), false);
});

test("shell and stdio confirmations map to their flags", () => {
  assert.deepEqual(
    confirmationRequest({
      code: "ASSISTANT_SHELL_CONFIRMATION_REQUIRED",
      required: ["confirmFull"],
    }),
    {
      kind: "fullShell",
      flags: { confirmFull: true },
      data: { required: ["confirmFull"] },
    },
  );
  assert.deepEqual(confirmationRequest({ code: "MCP_STDIO_CONFIRMATION_REQUIRED" }), {
    kind: "stdio",
    flags: { confirmStdio: true },
  });
  assert.equal(confirmationRequest(new Error("other")), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/unit/settings-save-chain.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `web/lib/settings/save-chain.js`.

- [ ] **Step 3: Implement**

Create `web/lib/settings/save-chain.js`:

```js
import { changedKeys, sameValue } from "./draft-state.js";

// The confirmations the server asks for before a change, by stable error code.
const confirmations = {
  ASSISTANT_SHELL_CONFIRMATION_REQUIRED: (error) => {
    const flag = error.required?.[0];
    return flag
      ? {
          kind: flag === "confirmFull" ? "fullShell" : "shell",
          flags: { [flag]: true },
          data: { required: error.required },
        }
      : null;
  },
  MCP_STDIO_CONFIRMATION_REQUIRED: () => ({
    kind: "stdio",
    flags: { confirmStdio: true },
  }),
  ASSISTANT_RESTART_REQUIRED: (error) => ({
    kind: "restart",
    flags: { confirmRestart: true },
    data: { affected: error.affected || {} },
  }),
};

export const confirmationRequest = (error) => confirmations[error?.code]?.(error) ?? null;

/** A refused base revision: the record changed elsewhere since the draft started. */
export const isConflict = (error) =>
  error?.status === 409 &&
  typeof error.messageKey === "string" &&
  /conflict$/i.test(error.messageKey);

const stepRevisions = (step, result) =>
  step.revisions
    ? step.revisions(result) || {}
    : step.resource && Number.isSafeInteger(result?.revision)
      ? { [step.resource]: result.revision }
      : {};

/**
 * Saves a tab with one action. Steps run in order; a step whose `keys` are unchanged
 * is skipped, so a retry after a partial save does not repeat finished steps. The
 * chain stops at the first error and keeps the revisions earlier steps returned.
 */
export async function runSaveChain({
  steps,
  values,
  base,
  revisions = {},
  ask = async () => false,
}) {
  const saved = { ...revisions };
  const results = {};
  const completed = [];
  const savedKeys = [];
  const finish = (status, extra = {}) => ({
    status,
    completed,
    savedKeys,
    results,
    revisions: saved,
    ...extra,
  });
  for (const step of steps) {
    const keys = step.keys ?? null;
    if (keys && keys.every((key) => sameValue(values[key], base[key]))) continue;
    let flags = {};
    for (;;) {
      try {
        const result = await step.run({
          values,
          base,
          changed: changedKeys(values, base),
          revision: saved[step.resource],
          revisions: { ...saved },
          confirmations: flags,
          results: { ...results },
        });
        results[step.id] = result;
        Object.assign(saved, stepRevisions(step, result));
        completed.push(step.id);
        if (keys) savedKeys.push(...keys);
        break;
      } catch (error) {
        const request = (step.confirmation ?? confirmationRequest)(error);
        const repeated =
          request &&
          Object.entries(request.flags).every(([key, value]) => flags[key] === value);
        if (request && !repeated) {
          if (!(await ask({ ...request, stepId: step.id })))
            return finish("cancelled", { failedStep: step.id });
          flags = { ...flags, ...request.flags };
          continue;
        }
        return finish((step.isConflict ?? isConflict)(error) ? "conflict" : "error", {
          failedStep: step.id,
          error,
        });
      }
    }
  }
  return finish("saved");
}

/** Labels of the steps a stopped chain already saved ("Partially saved: …"). */
export const completedLabels = (steps, result) =>
  result.completed
    .map((id) => steps.find((step) => step.id === id)?.label)
    .filter(Boolean);
```

- [ ] **Step 4: Run the test**

Run: `node --test tests/unit/settings-save-chain.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
npx prettier --write web/lib/settings/save-chain.js tests/unit/settings-save-chain.test.js
npx eslint web/lib/settings tests/unit/settings-save-chain.test.js
git add web/lib/settings/save-chain.js tests/unit/settings-save-chain.test.js
git commit -m "feat: save a settings tab through an ordered chain of steps" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 6: Route fields for the redesigned pages

Add route parsing for settings tabs, agent settings tabs/subpages and Accounts subpages, and give the Extensions default tab one definition. Pages consume these fields in steps 1–5; here they must parse, round-trip and normalise.

**Files:**

- Create: `web/features/assistants/settings-routes.js`, `web/features/accounts/routes.js`, `web/features/extensions/routes.js`
- Modify: `web/app/routes.js:10-15,50-75,122-129,148-172`, `web/features/operations/routes.js`, `web/features/settings/SettingsPage.jsx:16-22`, `web/app/useWorkspaceNavigation.js:298`, `web/features/extensions/ExtensionsPage.jsx:21`, `web/features/extensions/ExtensionWorkspace.jsx:78`
- Test: `tests/unit/settings-routes.test.js`, extend `tests/property/routes.test.js`

**Interfaces (URL shapes and route fields):**

- Settings — `web/features/operations/routes.js`:
  - `settingsTabs = ["workspace", "access", "operations"]`
  - `settingsSectionGroups = { workspace: ["general", "notifications", "assistants"], access: ["mcp", "remote", "ssh", "github"], operations: ["diagnostics", "backups", "updates", "audit"] }`
  - `settingsTabOf(section) => tab`
  - Route: `{ view: "settings", settingsSection, settingsTab, ...existing fields }`. `settingsTab` is always present. `/settings` → `workspace`; `/settings?tab=access` → `{ settingsSection: "general", settingsTab: "access" }` (tab root); `/settings/<section>` → tab derived from the section, a contradicting `?tab=` is dropped. `settingsRoutePath` writes `?tab=` only for `settingsSection: "general"` with a non-workspace tab. Paths are unchanged, so `tests/unit/settings-sections.test.js` and the server document paths keep working.
- Agent settings — `web/features/assistants/settings-routes.js`:
  - `agentTabs = ["profile", "capabilities", "work", "telegram"]`
  - `agentPages = { memory: "capabilities", allowlist: "capabilities", actions: "work", projects: "work", pipelines: "work", "telegram-activity": "telegram", "telegram-connection": "telegram" }`
  - `agentSettingsLocation(route) => { tab, page }` (defaults `profile`, `""`; a valid page decides the tab)
  - `readAgentSettingsQuery(search) => { agentTab?, agentPage? }` (defaults left out), `agentSettingsQuery(route) => "" | "?tab=…&page=…"`
  - URL: `/agents/:id/settings?tab=<tab>&page=<page>`. Route: `{ view: "agents", assistantId, agentSettings: true, agentTab?, agentPage? }`.
- Accounts — `web/features/accounts/routes.js`:
  - `accountSections = ["models", "services", "mcp-servers", "cli"]`, `accountItemPattern = /^(?:new|[A-Za-z0-9][A-Za-z0-9_.:-]{0,127})$/`
  - `readAccountsQuery(search) => { section?, item? }`, `accountsQuery(route) => "" | "?section=…&item=…"`
  - URL: `/accounts?section=<group>&item=<id|new>`. Route: `{ view: "accounts", section?, item?, mcpOAuth? }`. `item` without a valid `section` is dropped; `section=mcp-servers` alone keeps working; OAuth result params keep being read and are dropped from the normalised address. ChatGPT account ids (`openclaw:<64 hex>`) are valid items.
  - Item ids used by the Accounts step: provider connection id, ChatGPT account id, `speech`, `web-search`, MCP server id, native CLI account id, or `new`.
- Extensions — `web/features/extensions/routes.js`:
  - `extensionTabs = ["mcp", "skills", "plugins", "marketplaces", "agents"]`, `defaultExtensionTab = "mcp"`, `readExtensionTab(search)`. Step 4 changes `defaultExtensionTab` to `"skills"`, drops `"mcp"` from `extensionTabs` and maps a legacy `?tab=mcp` to `"skills"` inside `readExtensionTab`.

- [ ] **Step 1: Write the failing unit test**

Create `tests/unit/settings-routes.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { readRoute, routePath } from "../../web/app/routes.js";
import {
  settingsSectionGroups,
  settingsTabOf,
  settingsTabs,
} from "../../web/features/operations/routes.js";
import { agentSettingsLocation } from "../../web/features/assistants/settings-routes.js";
import {
  defaultExtensionTab,
  extensionTabs,
} from "../../web/features/extensions/routes.js";

const read = (address) => readRoute(new URL(address, "http://localhost"));
const agent = { view: "agents", assistantId: "home", agentSettings: true };

test("settings tabs follow the section and keep tab roots addressable", () => {
  assert.equal(read("/settings").settingsTab, "workspace");
  assert.equal(read("/settings?tab=access").settingsTab, "access");
  assert.equal(read("/settings?tab=access").settingsSection, "general");
  assert.equal(routePath(read("/settings?tab=access")), "/settings?tab=access");
  assert.equal(routePath(read("/settings?tab=workspace")), "/settings");
  assert.equal(read("/settings?tab=bogus").settingsTab, "workspace");
  assert.equal(read("/settings/diagnostics").settingsTab, "operations");
  const contradicted = read("/settings/diagnostics?tab=access");
  assert.equal(contradicted.settingsTab, "operations");
  assert.equal(routePath(contradicted), "/settings/diagnostics");
  for (const tab of settingsTabs)
    for (const section of settingsSectionGroups[tab])
      assert.equal(settingsTabOf(section), tab, section);
});

test("agent settings tabs and subpages have their own addresses", () => {
  assert.deepEqual(read("/agents/home/settings"), agent);
  assert.deepEqual(read("/agents/home/settings?tab=work"), {
    ...agent,
    agentTab: "work",
  });
  assert.equal(
    routePath(read("/agents/home/settings?tab=work")),
    "/agents/home/settings?tab=work",
  );
  const memory = { ...agent, agentTab: "capabilities", agentPage: "memory" };
  assert.deepEqual(read("/agents/home/settings?page=memory"), memory);
  assert.deepEqual(read("/agents/home/settings?tab=work&page=memory"), memory);
  assert.equal(routePath(memory), "/agents/home/settings?tab=capabilities&page=memory");
  assert.deepEqual(read("/agents/home/settings?tab=profile"), agent);
  assert.deepEqual(read("/agents/home/settings?tab=nope&page=nope"), agent);
  assert.deepEqual(agentSettingsLocation(agent), { tab: "profile", page: "" });
  assert.deepEqual(
    agentSettingsLocation({ ...agent, agentPage: "telegram-connection" }),
    {
      tab: "telegram",
      page: "telegram-connection",
    },
  );
});

test("accounts subpages keep section and item and old links keep working", () => {
  const item = { view: "accounts", section: "models", item: "conn-1" };
  assert.deepEqual(read("/accounts?section=models&item=conn-1"), item);
  assert.equal(routePath(item), "/accounts?section=models&item=conn-1");
  assert.deepEqual(read("/accounts?section=cli&item=new"), {
    view: "accounts",
    section: "cli",
    item: "new",
  });
  const chatgpt = `openclaw:${"a".repeat(64)}`;
  const linked = read(`/accounts?section=models&item=${encodeURIComponent(chatgpt)}`);
  assert.equal(linked.item, chatgpt);
  assert.deepEqual(read(routePath(linked)), linked);
  assert.deepEqual(read("/accounts?item=conn-1"), { view: "accounts" });
  assert.deepEqual(read("/accounts?section=cli&item=..%2Fx"), {
    view: "accounts",
    section: "cli",
  });
  const oauth = read("/accounts?section=mcp-servers&oauth=connected&server=s1");
  assert.deepEqual(oauth, {
    view: "accounts",
    section: "mcp-servers",
    mcpOAuth: { result: "connected", serverId: "s1" },
  });
  assert.equal(routePath(oauth), "/accounts?section=mcp-servers");
});

test("the extensions default tab has one definition", () => {
  assert.ok(extensionTabs.includes(defaultExtensionTab));
  assert.equal(read("/extensions/p1").extensionTab, defaultExtensionTab);
  assert.equal(read("/extensions/p1?tab=bogus").extensionTab, defaultExtensionTab);
  assert.equal(
    routePath({ view: "extensions", profileId: "p1", extensionTab: defaultExtensionTab }),
    "/extensions/p1",
  );
});
```

- [ ] **Step 2: Add the failing property test**

Append to `tests/property/routes.test.js` (add the two imports at the top):

```js
import { agentPages, agentTabs } from "../../web/features/assistants/settings-routes.js";
import { accountSections } from "../../web/features/accounts/routes.js";
import { settingsTabs } from "../../web/features/operations/routes.js";
```

```js
test("generated settings, agent and accounts addresses round-trip and normalise once", () => {
  check(
    fc.property(
      publicId,
      fc.constantFrom(...agentTabs, "junk", ""),
      fc.constantFrom(...Object.keys(agentPages), "junk", ""),
      fc.constantFrom(...accountSections, "junk", ""),
      fc.constantFrom(...settingsTabs, "junk"),
      (id, tab, page, section, settingsTab) => {
        const agentRoute = parse(`/agents/${id}/settings?tab=${tab}&page=${page}`);
        assert.deepEqual(parse(routePath(agentRoute)), agentRoute);
        if (agentRoute.agentPage)
          assert.equal(agentRoute.agentTab, agentPages[agentRoute.agentPage]);
        const accounts = parse(`/accounts?section=${section}&item=${id}`);
        assert.deepEqual(parse(routePath(accounts)), accounts);
        assert.equal(accounts.item === undefined, !accountSections.includes(section));
        const settings = parse(`/settings?tab=${settingsTab}`);
        assert.deepEqual(parse(routePath(settings)), settings);
      },
    ),
  );
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test tests/unit/settings-routes.test.js tests/property/routes.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `web/features/assistants/settings-routes.js`.

- [ ] **Step 4: Implement the route modules**

Create `web/features/assistants/settings-routes.js`:

```js
// Agent settings tabs and their subpages: /agents/:id/settings?tab=…&page=…
export const agentTabs = ["profile", "capabilities", "work", "telegram"];
// Each subpage belongs to one tab; a valid page decides the tab.
export const agentPages = {
  memory: "capabilities",
  allowlist: "capabilities",
  actions: "work",
  projects: "work",
  pipelines: "work",
  "telegram-activity": "telegram",
  "telegram-connection": "telegram",
};
const pageOf = (value) => (Object.hasOwn(agentPages, value ?? "") ? value : "");

/** `{ tab, page }` of an agent settings route; missing fields mean the defaults. */
export function agentSettingsLocation(route) {
  const page = pageOf(route.agentPage);
  const tab = page
    ? agentPages[page]
    : agentTabs.includes(route.agentTab)
      ? route.agentTab
      : "profile";
  return { tab, page };
}

/** Route fields from the query; defaults are left out so plain links stay equal. */
export function readAgentSettingsQuery(search) {
  const query = new URLSearchParams(search);
  const { tab, page } = agentSettingsLocation({
    agentTab: query.get("tab"),
    agentPage: query.get("page"),
  });
  return {
    ...(tab !== "profile" ? { agentTab: tab } : {}),
    ...(page ? { agentPage: page } : {}),
  };
}

export function agentSettingsQuery(route) {
  const { tab, page } = agentSettingsLocation(route);
  const query = new URLSearchParams();
  if (tab !== "profile") query.set("tab", tab);
  if (page) query.set("page", page);
  return query.size ? `?${query}` : "";
}
```

Create `web/features/accounts/routes.js`:

```js
// Accounts subpages: /accounts?section=<group>&item=<id|new>
export const accountSections = ["models", "services", "mcp-servers", "cli"];
// Provider connection, ChatGPT (openclaw:<hash>), MCP server and CLI account ids.
export const accountItemPattern = /^(?:new|[A-Za-z0-9][A-Za-z0-9_.:-]{0,127})$/;

export function readAccountsQuery(search) {
  const query = new URLSearchParams(search);
  const section = query.get("section");
  if (!accountSections.includes(section)) return {};
  const item = query.get("item") || "";
  return { section, ...(accountItemPattern.test(item) ? { item } : {}) };
}

export function accountsQuery(route) {
  if (!accountSections.includes(route.section)) return "";
  const query = new URLSearchParams({ section: route.section });
  if (route.item && accountItemPattern.test(route.item)) query.set("item", route.item);
  return `?${query}`;
}
```

Create `web/features/extensions/routes.js`:

```js
// The tabs of a CLI profile's extensions; the default has one definition so the
// settings redesign can move it (step 4) without hunting literals.
export const extensionTabs = ["mcp", "skills", "plugins", "marketplaces", "agents"];
export const defaultExtensionTab = "mcp";

export function readExtensionTab(search) {
  const tab = new URLSearchParams(search).get("tab");
  return extensionTabs.includes(tab) ? tab : defaultExtensionTab;
}
```

- [ ] **Step 5: Wire them into the app routes**

`web/app/routes.js`:

Replace lines 10–15 (`idPattern`, `extensionTabs`, `readExtensionTab`) with:

```js
import {
  agentSettingsQuery,
  readAgentSettingsQuery,
} from "../features/assistants/settings-routes.js";
import { accountsQuery, readAccountsQuery } from "../features/accounts/routes.js";
import { defaultExtensionTab, readExtensionTab } from "../features/extensions/routes.js";
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
```

(Move these imports up with the other imports at the top of the file.)

In the agent branch replace `: { agentSettings: true }),` with:

```js
          : { agentSettings: true, ...readAgentSettingsQuery(location.search) }),
```

Replace the `/accounts` branch (lines 66–75) with:

```js
if (pathname === "/accounts")
  return {
    view: "accounts",
    // A subpage (`section`, optional `item`); `section=mcp-servers` alone opens the
    // central MCP list, as linked from the CLI extensions page.
    ...readAccountsQuery(location.search),
    // An MCP OAuth login's result; the address drops it (see routePath).
    ...readMcpOAuthResult(location.search),
  };
```

In `routePath`, replace the settings link of agents:

```js
        : route.assistantId
          ? `/agents/${encodeURIComponent(route.assistantId)}/settings${agentSettingsQuery(route)}`
          : "/agents";
```

replace the accounts branch:

```js
if (route.view === "accounts") return `/accounts${accountsQuery(route)}`;
```

and in the extensions branch replace `route.extensionTab !== "mcp"` with `route.extensionTab !== defaultExtensionTab`.

`web/features/operations/routes.js` — add after the `sections` set:

```js
export const settingsTabs = ["workspace", "access", "operations"];
// The settings sections each tab lists; "general" is also the root of every tab.
export const settingsSectionGroups = {
  workspace: ["general", "notifications", "assistants"],
  access: ["mcp", "remote", "ssh", "github"],
  operations: ["diagnostics", "backups", "updates", "audit"],
};
export const settingsTabOf = (section) =>
  settingsTabs.find((tab) => settingsSectionGroups[tab].includes(section)) || "workspace";
```

In `readSettingsRoute`, add to the returned object (after `settingsSection: match[1] || "general",`):

```js
    settingsTab: match[1]
      ? settingsTabOf(match[1])
      : settingsTabs.includes(query.get("tab"))
        ? query.get("tab")
        : "workspace",
```

In `settingsRoutePath`, insert directly after `query = new URLSearchParams();` (inside the `const` declaration, so as a new statement after it):

```js
if (
  section === "general" &&
  settingsTabs.includes(route.settingsTab) &&
  route.settingsTab !== "workspace"
)
  query.set("tab", route.settingsTab);
```

`web/features/settings/SettingsPage.jsx` — delete the local `sectionGroups` constant (lines 16–22 including its comment) and import the shared one:

```js
import { settingsSectionGroups as sectionGroups } from "../operations/routes.js";
```

`web/app/useWorkspaceNavigation.js:298` — import `defaultExtensionTab` from `../features/extensions/routes.js` and use `{ extensionTab: defaultExtensionTab, profileId: resolveProfileId() }`.

`web/features/extensions/ExtensionsPage.jsx:21` — import `defaultExtensionTab` from `./routes.js` and use `extensionTab = defaultExtensionTab,`.

`web/features/extensions/ExtensionWorkspace.jsx:78` — import `defaultExtensionTab` from `./routes.js` and use `pending || tabs.some((item) => item.id === requestedTab) ? requestedTab : defaultExtensionTab;`.

- [ ] **Step 6: Run the route tests**

Run: `node --test tests/unit/settings-routes.test.js tests/unit/routes.test.js tests/unit/assistant-routes.test.js tests/unit/settings-sections.test.js tests/unit/mcp-settings-routes.test.js tests/property/routes.test.js`
Expected: PASS. `grep -rn '"mcp"' web/app web/features/extensions` now only lists the tab definition in `ExtensionWorkspace.jsx` (`{ id: "mcp", … }`, `tab === "mcp"`) and `web/features/extensions/routes.js`.

- [ ] **Step 7: Run the browser specs that navigate these pages**

Run: `npm run build && npx playwright test tests/browser/extensions.spec.js tests/browser/navigation.spec.js tests/browser/mcp-settings.spec.js tests/browser/assistant-settings.spec.js`
Expected: PASS (no visible change).

- [ ] **Step 8: Commit**

```bash
npx prettier --write web/app web/features/assistants/settings-routes.js web/features/accounts/routes.js web/features/extensions web/features/operations/routes.js web/features/settings/SettingsPage.jsx tests/unit/settings-routes.test.js tests/property/routes.test.js
npx eslint web/app web/features tests/unit/settings-routes.test.js tests/property/routes.test.js
git add web tests/unit/settings-routes.test.js tests/property/routes.test.js
git commit -m "feat: address settings tabs, agent subpages and accounts items" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 7: Scrollable underline tabs, run filter fade and the component harness

Restyle `UnderlineTabs` per README (counts as `<small>`, 48px edge fade, active tab kept in view via `scrollLeft`, desktop hover arrows), give `RunStatusFilter` the same fade, and set up the browser harness the remaining component tasks reuse.

**Files:**

- Create: `web/components/scroll-fade.js`, `web/components/useScrollFade.js`
- Modify: `web/components/UnderlineTabs.jsx`, `web/components/underline-tabs.css`, `web/components/Icon.jsx`
- Modify: `web/features/pipelines/RunStatusFilter.jsx`, `web/features/pipelines/run-table.css:19-25`
- Modify: `web/features/projects/projects.css:505-519`, `web/features/extensions/extensions-hub.css:346-358`
- Create: `tests/helpers/settings-pattern-harness.js`, `tests/browser/harness/settings-pattern/index.html`, `tests/browser/harness/settings-pattern/main.js`, `tests/browser/harness/settings-pattern/tabs-fixture.js`
- Test: `tests/unit/scroll-fade.test.js`, `tests/browser/settings-pattern-tabs.spec.js`

**Interfaces:**

- Produces:
  - `scrollEdges({ scrollLeft, clientWidth, scrollWidth }) => { left: boolean, right: boolean }` (`left` when `scrollLeft > 1`, `right` when `scrollLeft + clientWidth < scrollWidth - 1`).
  - `revealScrollLeft({ itemLeft, itemWidth, scrollLeft, clientWidth, scrollWidth, margin = 48 }) => number | null` — the `scrollLeft` that shows the item with `margin` on both sides, clamped to the scroll range; `null` when already visible.
  - `useScrollFade(ref, { activeSelector?, revealKey?, margin = 48 }) => { edges: { left, right }, scrollBy(direction: -1 | 1) }`.
  - `UnderlineTabs({ label, tabs: [{ id, label, count? }], selected, onSelect(id), disabled = false, idPrefix = "underline" })`. Tab ids stay `${idPrefix}-tab-${id}`, panels `${idPrefix}-tabpanel-${id}` (existing callers keep the default prefix). Markup: `.underline-tabs-frame` (gets `can-scroll-left/right`) > `.underline-tabs[role=tablist]` (also gets the classes; carries the mask) + two `aria-hidden` arrow buttons `.underline-tabs-arrow.left/.right` (`tabIndex=-1`, desktop hover only). Counts render as `<small>`.
  - `Icon` names added: `more` (⋯), `external` (arrow up-right), `down` (chevron down).
  - Harness: `startSettingsHarness() => Promise<{ url, close() }>` from `tests/helpers/settings-pattern-harness.js`; fixtures are chosen with `?fixture=<name>&lang=de|en`; `main.js` holds the `fixtures` map that later tasks extend.

- [ ] **Step 1: Write the failing unit test**

Create `tests/unit/scroll-fade.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { revealScrollLeft, scrollEdges } from "../../web/components/scroll-fade.js";

test("edges report which side still has hidden content", () => {
  assert.deepEqual(scrollEdges({ scrollLeft: 0, clientWidth: 300, scrollWidth: 300 }), {
    left: false,
    right: false,
  });
  assert.deepEqual(scrollEdges({ scrollLeft: 0, clientWidth: 300, scrollWidth: 500 }), {
    left: false,
    right: true,
  });
  assert.deepEqual(scrollEdges({ scrollLeft: 200, clientWidth: 300, scrollWidth: 500 }), {
    left: true,
    right: false,
  });
  assert.deepEqual(
    scrollEdges({ scrollLeft: 0.5, clientWidth: 300, scrollWidth: 300.5 }),
    {
      left: false,
      right: false,
    },
  );
});

test("the active item is revealed with a 48px margin and clamped", () => {
  const row = { clientWidth: 300, scrollWidth: 800 };
  assert.equal(
    revealScrollLeft({ ...row, itemLeft: 100, itemWidth: 80, scrollLeft: 0 }),
    null,
  );
  assert.equal(
    revealScrollLeft({ ...row, itemLeft: 400, itemWidth: 80, scrollLeft: 0 }),
    400 + 80 + 48 - 300,
  );
  assert.equal(
    revealScrollLeft({ ...row, itemLeft: 100, itemWidth: 80, scrollLeft: 300 }),
    52,
  );
  assert.equal(
    revealScrollLeft({ ...row, itemLeft: 20, itemWidth: 80, scrollLeft: 300 }),
    0,
  );
  assert.equal(
    revealScrollLeft({ ...row, itemLeft: 720, itemWidth: 80, scrollLeft: 0 }),
    500,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/unit/scroll-fade.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement the pure functions and the hook**

Create `web/components/scroll-fade.js`:

```js
// Horizontal rows (tabs, filter chips) fade the edge that still hides content and
// keep the active item in view by setting scrollLeft (never scrollIntoView, which
// would also scroll the page).
export const scrollEdges = ({ scrollLeft, clientWidth, scrollWidth }) => ({
  left: scrollLeft > 1,
  right: scrollLeft + clientWidth < scrollWidth - 1,
});

export function revealScrollLeft({
  itemLeft,
  itemWidth,
  scrollLeft,
  clientWidth,
  scrollWidth,
  margin = 48,
}) {
  let next = null;
  if (itemLeft - margin < scrollLeft) next = itemLeft - margin;
  else if (itemLeft + itemWidth + margin > scrollLeft + clientWidth)
    next = itemLeft + itemWidth + margin - clientWidth;
  if (next === null) return null;
  next = Math.min(Math.max(0, scrollWidth - clientWidth), Math.max(0, next));
  return Math.abs(next - scrollLeft) < 1 ? null : next;
}
```

Create `web/components/useScrollFade.js`:

```js
import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { revealScrollLeft, scrollEdges } from "./scroll-fade.js";

// Tracks which edges of a horizontal row hide content and reveals the active item.
export default function useScrollFade(
  ref,
  { activeSelector, revealKey, margin = 48 } = {},
) {
  const [edges, setEdges] = useState({ left: false, right: false });
  const measure = useCallback(() => {
    const element = ref.current;
    if (!element) return;
    const next = scrollEdges(element);
    setEdges((previous) =>
      previous.left === next.left && previous.right === next.right ? previous : next,
    );
  }, [ref]);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    const observer =
      typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(element);
    return () => {
      element.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, [ref, measure]);
  // Labels and counts change the row's width without resizing it.
  useLayoutEffect(measure);
  useLayoutEffect(() => {
    const element = ref.current;
    const active = activeSelector && element?.querySelector(activeSelector);
    if (!active) return;
    const left = revealScrollLeft({
      itemLeft: active.offsetLeft,
      itemWidth: active.offsetWidth,
      scrollLeft: element.scrollLeft,
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      margin,
    });
    if (left !== null) element.scrollLeft = left;
    measure();
  }, [ref, activeSelector, revealKey, margin, measure]);
  const scrollBy = useCallback(
    (direction) => {
      const element = ref.current;
      if (element)
        element.scrollLeft += direction * Math.max(80, element.clientWidth * 0.75);
    },
    [ref],
  );
  return { edges, scrollBy };
}
```

- [ ] **Step 4: Run the unit test**

Run: `node --test tests/unit/scroll-fade.test.js`
Expected: PASS.

- [ ] **Step 5: Add the icons**

In `web/components/Icon.jsx` add to `paths` (after `chevron`):

```js
    down: "m6 9 6 6 6-6",
    more: "M5 12h.01M12 12h.01M19 12h.01",
    external: "M7 17 17 7M8 7h9v9",
```

- [ ] **Step 6: Restyle `UnderlineTabs`**

Replace `web/components/UnderlineTabs.jsx` with:

```jsx
import React, { useRef } from "react";
import Icon from "./Icon.jsx";
import useScrollFade from "./useScrollFade.js";

const edgeClasses = (edges) =>
  [edges.left ? "can-scroll-left" : "", edges.right ? "can-scroll-right" : ""]
    .filter(Boolean)
    .join(" ");

// Tabs fill the row on phones and scroll with an edge fade when they do not fit; the
// active tab stays in view with a 48px margin.
export default function UnderlineTabs({
  label,
  tabs,
  selected,
  onSelect,
  disabled = false,
  idPrefix = "underline",
}) {
  const list = useRef(null);
  const { edges, scrollBy } = useScrollFade(list, {
    activeSelector: '[aria-selected="true"]',
    revealKey: `${selected}:${tabs.length}`,
  });
  const move = (event, index) => {
    const count = tabs.length;
    let next = null;
    if (event.key === "Home") next = 0;
    else if (event.key === "End") next = count - 1;
    else if (event.key === "ArrowRight") next = (index + 1) % count;
    else if (event.key === "ArrowLeft") next = (index - 1 + count) % count;
    if (next === null) return;
    event.preventDefault();
    onSelect(tabs[next].id);
    event.currentTarget.parentElement.children[next].focus();
  };
  const fade = edgeClasses(edges);
  return (
    <div className={["underline-tabs-frame", fade].filter(Boolean).join(" ")}>
      <button
        type="button"
        className="underline-tabs-arrow left"
        tabIndex={-1}
        aria-hidden="true"
        onClick={() => scrollBy(-1)}
      >
        <Icon name="back" size={14} />
      </button>
      <div
        ref={list}
        className={["underline-tabs", fade].filter(Boolean).join(" ")}
        role="tablist"
        aria-label={label}
      >
        {tabs.map((tab, index) => (
          <button
            key={tab.id}
            id={`${idPrefix}-tab-${tab.id}`}
            role="tab"
            aria-selected={selected === tab.id}
            aria-controls={`${idPrefix}-tabpanel-${tab.id}`}
            tabIndex={selected === tab.id ? 0 : -1}
            disabled={disabled}
            onClick={() => onSelect(tab.id)}
            onKeyDown={(event) => move(event, index)}
          >
            {tab.label}
            {tab.count !== undefined && <small>{tab.count}</small>}
          </button>
        ))}
      </div>
      <button
        type="button"
        className="underline-tabs-arrow right"
        tabIndex={-1}
        aria-hidden="true"
        onClick={() => scrollBy(1)}
      >
        <Icon name="arrow" size={14} />
      </button>
    </div>
  );
}
```

Replace `web/components/underline-tabs.css` with:

```css
/* Underline tabs (settings handoff 3a): counts as <small>, edge fade while the row
   scrolls, hover arrows on desktop. */
.underline-tabs-frame {
  position: relative;
  min-width: 0;
}
.underline-tabs {
  position: relative;
  display: flex;
  gap: 28px;
  height: 40px;
  border-bottom: 1px solid #28292d;
  overflow-x: auto;
  scrollbar-width: none;
}
.underline-tabs::-webkit-scrollbar {
  display: none;
}
.underline-tabs button {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 0;
  font-size: 13px;
  color: #a2a3a7;
  white-space: nowrap;
}
.underline-tabs [aria-selected="true"] {
  font-weight: 600;
  color: #ffc99d;
  box-shadow: inset 0 -2px 0 #f49a58;
}
.underline-tabs small {
  font-size: 11px;
  color: #6f7075;
  font-variant-numeric: tabular-nums;
}
.underline-tabs [aria-selected="true"] small {
  color: #d9b597;
}
.underline-tabs.can-scroll-right {
  -webkit-mask-image: linear-gradient(90deg, #000 calc(100% - 48px), transparent);
  mask-image: linear-gradient(90deg, #000 calc(100% - 48px), transparent);
}
.underline-tabs.can-scroll-left {
  -webkit-mask-image: linear-gradient(90deg, transparent, #000 48px);
  mask-image: linear-gradient(90deg, transparent, #000 48px);
}
.underline-tabs.can-scroll-left.can-scroll-right {
  -webkit-mask-image: linear-gradient(
    90deg,
    transparent,
    #000 48px,
    #000 calc(100% - 48px),
    transparent
  );
  mask-image: linear-gradient(
    90deg,
    transparent,
    #000 48px,
    #000 calc(100% - 48px),
    transparent
  );
}
.underline-tabs-arrow {
  position: absolute;
  top: 50%;
  z-index: 1;
  display: none;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 1px solid #303137;
  border-radius: 50%;
  background: #1b1c20;
  color: #e8e8ec;
  transform: translateY(-50%);
}
.underline-tabs-arrow.left {
  left: 0;
}
.underline-tabs-arrow.right {
  right: 0;
}
@media (hover: hover) and (min-width: 701px) {
  .underline-tabs-frame.can-scroll-left:hover .underline-tabs-arrow.left,
  .underline-tabs-frame.can-scroll-right:hover .underline-tabs-arrow.right {
    display: flex;
  }
}
@media (max-width: 700px) {
  .underline-tabs {
    gap: 0;
    height: 44px;
  }
  .underline-tabs button {
    flex: 1 0 auto;
    padding: 0 16px;
  }
}
```

Projects and Extensions inherit the look: in `web/features/projects/projects.css` replace the mobile block at lines 507–519 (`.project-card .underline-tabs { gap: 4px; … }`, `… button { padding: 11px 8px; font-size: 13px; }`, `… span { … }`) with:

```css
.project-card .underline-tabs {
  margin: 14px -23px 0;
  padding: 0 23px;
}
```

and in `web/features/extensions/extensions-hub.css` replace lines 346–358 (`.extension-hub-card .underline-tabs { gap: 6px; … }`, `… button {…}`, `… span {…}`) with:

```css
.extension-hub-card .underline-tabs {
  margin: 18px -23px 0;
  padding: 0 23px;
}
```

- [ ] **Step 7: Give the run filter the same fade**

Replace `web/features/pipelines/RunStatusFilter.jsx` with:

```jsx
import React, { useRef } from "react";
import useScrollFade from "../../components/useScrollFade.js";
import { pipelineCopy as copy } from "../../lib/i18n/messages/pipelines.js";
import { statusFilters } from "./run-presentation.js";
import "./run-table.css";

export default function RunStatusFilter({ counts, selected, onSelect }) {
  const row = useRef(null);
  const { edges } = useScrollFade(row, {
    activeSelector: '[aria-pressed="true"]',
    revealKey: selected,
  });
  const all = counts
    ? Object.values(counts).reduce((sum, value) => sum + value, 0)
    : null;
  return (
    <div
      ref={row}
      className={[
        "run-status-filters",
        edges.left ? "can-scroll-left" : "",
        edges.right ? "can-scroll-right" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      role="group"
      aria-label={copy.status}
    >
      {statusFilters(counts, selected).map((status) => {
        const count = status ? counts?.[status] : all;
        return (
          <button
            key={status || "all"}
            type="button"
            className={status ? `run-status-${status}` : ""}
            aria-pressed={selected === status}
            onClick={() => onSelect(status)}
          >
            {status && <span className="run-status-dot" />}
            {status ? copy.statuses[status] : copy.allStatuses}
            {count !== null && count !== undefined && (
              <span className="run-status-count">{` ${count}`}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
```

In `web/features/pipelines/run-table.css`, add `position: relative;` to `.run-status-filters` and append:

```css
.run-status-filters.can-scroll-right {
  -webkit-mask-image: linear-gradient(90deg, #000 calc(100% - 48px), transparent);
  mask-image: linear-gradient(90deg, #000 calc(100% - 48px), transparent);
}
.run-status-filters.can-scroll-left {
  -webkit-mask-image: linear-gradient(90deg, transparent, #000 48px);
  mask-image: linear-gradient(90deg, transparent, #000 48px);
}
.run-status-filters.can-scroll-left.can-scroll-right {
  -webkit-mask-image: linear-gradient(
    90deg,
    transparent,
    #000 48px,
    #000 calc(100% - 48px),
    transparent
  );
  mask-image: linear-gradient(
    90deg,
    transparent,
    #000 48px,
    #000 calc(100% - 48px),
    transparent
  );
}
```

- [ ] **Step 8: Create the harness**

`tests/helpers/settings-pattern-harness.js`:

```js
import path from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

const root = path.resolve(import.meta.dirname, "..", "..");

/**
 * Serves the shared settings components from source in an isolated page, so their
 * behaviour is tested before any product page renders them. No app server, no data.
 */
export async function startSettingsHarness() {
  const server = await createServer({
    configFile: false,
    root: path.join(root, "tests/browser/harness/settings-pattern"),
    cacheDir: path.join(root, ".cache/vite-settings-harness"),
    plugins: [react()],
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, fs: { allow: [root] } },
  });
  await server.listen();
  return { url: server.resolvedUrls.local[0], close: () => server.close() };
}
```

`tests/browser/harness/settings-pattern/index.html`:

```html
<!doctype html>
<html lang="de">
  <head>
    <meta charset="UTF-8" />
    <meta
      name="viewport"
      content="width=device-width, initial-scale=1, viewport-fit=cover"
    />
    <title>Settings pattern harness</title>
    <style>
      .harness {
        display: grid;
        gap: 24px;
        padding: 16px;
      }
      .harness-narrow {
        width: 100%;
        max-width: 400px;
      }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./main.js"></script>
  </body>
</html>
```

`tests/browser/harness/settings-pattern/main.js`:

```js
/* global document, location */
import { createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { setLanguage } from "../../../../web/lib/i18n/index.js";
import "../../../../web/styles/base.css";
import "../../../../web/app/layout.css";
import "../../../../web/components/forms.css";
import "../../../../web/components/segment.css";
import "../../../../web/components/underline-tabs.css";
import TabsFixture from "./tabs-fixture.js";

// Later tasks add their fixtures here.
const fixtures = { tabs: TabsFixture };
const query = new URLSearchParams(location.search);
setLanguage(query.get("lang") === "en" ? "en" : "de", { persist: false });
const Fixture = fixtures[query.get("fixture")];
createRoot(document.getElementById("root")).render(
  Fixture ? h(Fixture) : h("p", null, "Unknown fixture"),
);
```

`tests/browser/harness/settings-pattern/tabs-fixture.js`:

```js
import { createElement as h, useState } from "react";
import UnderlineTabs from "../../../../web/components/UnderlineTabs.jsx";
import RunStatusFilter from "../../../../web/features/pipelines/RunStatusFilter.jsx";

const entries = [
  ["profile", "Profil"],
  ["capabilities", "Fähigkeiten", 3],
  ["work", "Arbeit"],
  ["telegram", "Telegram"],
  ["reminders", "Erinnerungen", 12],
  ["notifications", "Benachrichtigungen"],
];
const counts = {
  "awaiting-human": 1,
  running: 2,
  failed: 3,
  completed: 12,
  cancelled: 4,
};

export default function TabsFixture() {
  const [selected, setSelected] = useState("profile");
  const [status, setStatus] = useState("");
  const tabs = entries.map(([id, label, count]) => ({
    id,
    label,
    ...(count === undefined ? {} : { count }),
  }));
  return h(
    "main",
    { className: "harness" },
    h(
      "section",
      { className: "harness-narrow" },
      h(UnderlineTabs, {
        label: "Harness tabs",
        tabs,
        selected,
        onSelect: setSelected,
        idPrefix: "harness",
      }),
    ),
    h("p", { "data-testid": "selected" }, selected),
    h(
      "section",
      { className: "harness-narrow" },
      h(RunStatusFilter, { counts, selected: status, onSelect: setStatus }),
    ),
  );
}
```

- [ ] **Step 9: Write the browser spec**

Create `tests/browser/settings-pattern-tabs.spec.js`:

```js
import { test, expect } from "@playwright/test";
import { startSettingsHarness } from "../helpers/settings-pattern-harness.js";

test.describe.configure({ timeout: 90000 });
let harness;
test.beforeAll(async () => {
  harness = await startSettingsHarness();
});
test.afterAll(async () => {
  await harness?.close();
});
const open = (page, lang = "de") => page.goto(`${harness.url}?fixture=tabs&lang=${lang}`);

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("overflowing tabs fade at the edge and keep the active tab in view", async ({
    page,
  }) => {
    await open(page);
    const list = page.getByRole("tablist", { name: "Harness tabs" });
    await expect(list).toHaveClass(/can-scroll-right/);
    await expect(list).not.toHaveClass(/can-scroll-left/);
    await page.getByRole("tab", { name: "Profil" }).focus();
    await page.keyboard.press("End");
    const last = page.getByRole("tab", { name: "Benachrichtigungen" });
    await expect(last).toHaveAttribute("aria-selected", "true");
    await expect(last).toBeFocused();
    await expect(page.getByTestId("selected")).toHaveText("notifications");
    await expect(list).toHaveClass(/can-scroll-left/);
    await expect(list).not.toHaveClass(/can-scroll-right/);
    const row = await list.boundingBox();
    const tab = await last.boundingBox();
    expect(tab.x + tab.width).toBeLessThanOrEqual(row.x + row.width + 1);
    await page.keyboard.press("Home");
    await expect(page.getByRole("tab", { name: "Profil" })).toBeFocused();
    await expect(list).not.toHaveClass(/can-scroll-left/);
    await page.keyboard.press("ArrowLeft");
    await expect(last).toHaveAttribute("aria-selected", "true");
  });

  test("tab counts are small text inside the tab name", async ({ page }) => {
    await open(page);
    const tab = page.getByRole("tab", { name: /^Fähigkeiten/ });
    await expect(tab.locator("small")).toHaveText("3");
    expect(await tab.evaluate((el) => getComputedStyle(el).height)).toBe("44px");
  });

  test("run filter chips fade while more chips are hidden", async ({ page }) => {
    await open(page);
    const chips = page.getByRole("group", { name: "Status" });
    await expect(chips).toHaveClass(/can-scroll-right/);
    await chips.evaluate((el) => {
      el.scrollLeft = el.scrollWidth;
    });
    await expect(chips).toHaveClass(/can-scroll-left/);
    await expect(chips).not.toHaveClass(/can-scroll-right/);
  });
});

test.describe("desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("hover arrows scroll an overflowing row and stay out of the tab order", async ({
    page,
  }) => {
    await open(page, "en");
    const list = page.getByRole("tablist", { name: "Harness tabs" });
    await expect(list).toHaveClass(/can-scroll-right/);
    const frame = page.locator(".underline-tabs-frame").first();
    const right = frame.locator(".underline-tabs-arrow.right");
    await expect(right).toBeHidden();
    await frame.hover();
    await expect(right).toBeVisible();
    await expect(right).toHaveAttribute("tabindex", "-1");
    await right.click();
    await expect.poll(() => list.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
    await expect(list).toHaveClass(/can-scroll-left/);
  });
});
```

The aria label of the chip group is `pipelineCopy.status`; confirm it reads "Status" in German (`grep -n "status:" web/lib/i18n/de/pipelines.js`) and adjust the name if it differs.

- [ ] **Step 10: Run the browser specs**

Run: `npm run build && npx playwright test tests/browser/settings-pattern-tabs.spec.js tests/browser/projects.spec.js tests/browser/projects-hub-loading.spec.js tests/browser/extensions.spec.js tests/browser/pipelines-runs.spec.js tests/browser/pipelines-definitions.spec.js tests/browser/agentbus.spec.js tests/browser/memory.spec.js`
Expected: PASS. If an existing spec asserted the old `<span>` count chip or border-bottom underline, change only how the element is found, never the behavioural assertion.

- [ ] **Step 11: Commit**

```bash
npx prettier --write web/components web/features/pipelines/RunStatusFilter.jsx web/features/pipelines/run-table.css web/features/projects/projects.css web/features/extensions/extensions-hub.css tests/helpers/settings-pattern-harness.js tests/browser/harness tests/browser/settings-pattern-tabs.spec.js tests/unit/scroll-fade.test.js
npx eslint web/components web/features/pipelines tests/helpers/settings-pattern-harness.js tests/browser/harness tests/browser/settings-pattern-tabs.spec.js tests/unit/scroll-fade.test.js
git add web/components web/features/pipelines web/features/projects/projects.css web/features/extensions/extensions-hub.css tests/helpers/settings-pattern-harness.js tests/browser/harness tests/browser/settings-pattern-tabs.spec.js tests/unit/scroll-fade.test.js
git commit -m "feat: scroll underline tabs and run filters with an edge fade" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 8: List pattern components

Group labels, list cards, rows with their right-side variants and controls, ⓘ disclosures, the segmented control and the dashed Accounts reference row.

**Files:**

- Create: `web/components/link-click.js`, `web/components/InfoHint.jsx`, `web/components/GroupLabel.jsx`, `web/components/ListCard.jsx`, `web/components/ListRow.jsx`, `web/components/Segmented.jsx`, `web/components/ReferenceRow.jsx`
- Create: `web/styles/settings-pattern.css`; Modify: `web/styles/index.css` (import after `../components/segment.css`)
- Create: `tests/browser/harness/settings-pattern/list-fixture.js`; Modify: `tests/browser/harness/settings-pattern/main.js`
- Test: `tests/browser/settings-pattern-list.spec.js`

**Interfaces (component props):**

- `isPlainClick(event) => boolean` — primary button without modifier keys (links then navigate in-app; modified clicks open normally).
- `useInfoHint() => { id, open, toggle() }`; `InfoHintButton({ hint, label = commonCopy.showHint })` renders the 20×20 "i" button with `aria-expanded`/`aria-controls`; `InfoHintText({ hint, children })` renders `<p id hidden={!open}>` with the hint text verbatim.
- `GroupLabel({ children, as = "h2", id?, hint?, hintLabel?, action?: { label, onClick, disabled? } })` — uppercase label, optional ⓘ, optional right text action (e.g. "+ Erinnerung erstellen").
- `ListCard({ label?, labelledBy?, disabled = false, className?, children })` — `role="group"`; `disabled` dims to opacity .5 and sets `aria-disabled`.
- `ListRow({ label, sub?, icon?, value?, status?: { tone: "ok" | "warn" | "error", text }, onClick?, href?, chevron?, menu?: { label?, onClick(event), expanded? }, onDelete?, deleteLabel?, hint?, hintLabel?, disabled?, className?, children? })`
  - With `onClick` (or `href`) the main area is a button (or link) and shows a chevron unless `chevron={false}`; `children` are extra controls on the right. `menu` adds the 40×40 ⋯ button (`aria-haspopup="menu"`, label defaults to `commonCopy.moreActions`); `onDelete` adds the 40×40 trash button (label defaults to `commonCopy.delete`).
  - `value` shows muted text; pass `value={known ?? unknownValue}` so unknown data shows "—".
- `unknownValue = "—"` (exported from `ListRow.jsx`).
- Control rows (named exports of `ListRow.jsx`), all with `label`, `sub?`, `disabled?`, `hint?`, `hintLabel?`:
  - `ToggleRow({ checked, onChange(boolean) })` — `<input type="checkbox" role="switch">`, 38×22.
  - `NumberRow({ value, onChange(number | ""), min?, max?, step? })` — 64×34, right-aligned.
  - `SelectRow({ value, options: [{ value, label }], onChange(value) })` — native select showing the value and a chevron down.
  - `RadioRow({ name, value, checked, onChange(value) })` — 18px circle, selected row tinted.
  - `CheckboxRow({ checked, onChange(boolean), pill? })` — e.g. MCP server rows with a "stdio" pill.
- `Segmented(props)` — `Segment` with the README look (`className="segmented"`), same props as `Segment` (`label, options, value, onChange, disabled`).
- `ReferenceRow({ title, sub?, count?, href?, onOpen(), linkLabel = commonCopy.accounts })` — dashed link row; `sub` defaults to `commonCopy.centralInAccounts` (pass `null` to hide); `count` is appended to the title ("· 2 für Claude Code"). Pages pass `href={routePath({ view: "accounts", section, item })}` and `onOpen={() => navigate({ view: "accounts", section, item })}`.

- [ ] **Step 1: Write the browser spec (fails: fixture missing)**

Create `tests/browser/settings-pattern-list.spec.js`:

```js
import { test, expect } from "@playwright/test";
import { startSettingsHarness } from "../helpers/settings-pattern-harness.js";

test.describe.configure({ timeout: 90000 });
let harness;
test.beforeAll(async () => {
  harness = await startSettingsHarness();
});
test.afterAll(async () => {
  await harness?.close();
});
const open = (page, lang = "de") => page.goto(`${harness.url}?fixture=list&lang=${lang}`);
const log = (page) => page.getByTestId("log");

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

test("an info hint is a disclosure that inserts the text verbatim", async ({ page }) => {
  await open(page);
  const button = page
    .locator(".toggle-row")
    .getByRole("button", { name: "Hinweis anzeigen" });
  await expect(button).toHaveAttribute("aria-expanded", "false");
  const panel = page.locator(`#${await button.getAttribute("aria-controls")}`);
  await expect(panel).toBeHidden();
  await button.click();
  await expect(button).toHaveAttribute("aria-expanded", "true");
  await expect(panel).toHaveText("Speichert Notizen zwischen Unterhaltungen.");
  await button.click();
  await expect(panel).toBeHidden();
  const box = await button.boundingBox();
  expect([Math.round(box.width), Math.round(box.height)]).toEqual([20, 20]);
});

test("toggles are switches that work with the keyboard", async ({ page }) => {
  await open(page);
  const toggle = page.getByRole("switch", { name: "Gedächtnis" });
  await expect(toggle).not.toBeChecked();
  await toggle.focus();
  await page.keyboard.press("Space");
  await expect(toggle).toBeChecked();
  await expect(log(page)).toContainText("memory:true");
  const box = await toggle.boundingBox();
  expect([Math.round(box.width), Math.round(box.height)]).toEqual([38, 22]);
  await page.getByText("Gedächtnis", { exact: true }).click();
  await expect(toggle).not.toBeChecked();
});

test("rows show values, statuses, navigation, menus and delete actions", async ({
  page,
}) => {
  await open(page);
  await expect(page.getByText("—", { exact: true })).toBeVisible();
  await expect(page.locator(".list-row-status.ok")).toHaveText("Verbunden");
  await expect(page.locator(".list-row-status.warn")).toHaveText("1.29.0 verfügbar");
  await page.getByRole("button", { name: /Gespeicherte Notizen/ }).click();
  await expect(log(page)).toContainText("open:notes");
  const menu = page.getByRole("button", { name: "Weitere Aktionen" });
  await expect(menu).toHaveAttribute("aria-haspopup", "menu");
  const menuBox = await menu.boundingBox();
  expect([Math.round(menuBox.width), Math.round(menuBox.height)]).toEqual([40, 40]);
  await menu.click();
  await expect(log(page)).toContainText("menu:plugin");
  await page.getByRole("button", { name: "ls entfernen" }).click();
  await expect(log(page)).toContainText("delete:ls");
});

test("number, select, radio, checkbox and segmented controls report changes", async ({
  page,
}) => {
  await open(page);
  const number = page.getByRole("spinbutton", { name: "Max. Mitglieder" });
  const box = await number.boundingBox();
  expect([Math.round(box.width), Math.round(box.height)]).toEqual([64, 34]);
  await number.fill("6");
  await expect(log(page)).toContainText("members:6");
  await page.getByRole("combobox", { name: "Sprache der Hinweise" }).selectOption("en");
  await expect(log(page)).toContainText("language:en");
  await page.getByRole("radio", { name: "Mit Freigabe" }).check();
  await expect(log(page)).toContainText("shell:approval");
  await page.getByRole("checkbox", { name: /GitHub/ }).check();
  await expect(log(page)).toContainText("server:true");
  await expect(page.getByText("stdio", { exact: true })).toBeVisible();
  await page.getByRole("radiogroup", { name: "Ansicht" }).getByText("Archiv").click();
  await expect(log(page)).toContainText("segment:archive");
});

test("group actions and the Accounts reference row navigate in-app", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "+ Erinnerung erstellen" }).click();
  await expect(log(page)).toContainText("action:reminder");
  const reference = page.getByRole("link", { name: /Suchanbieter/ });
  await expect(reference).toHaveAttribute(
    "href",
    "/accounts?section=services&item=web-search",
  );
  await expect(reference).toContainText("Zentral unter Accounts");
  await reference.click();
  await expect(log(page)).toContainText("accounts:services/web-search");
  expect(new URL(page.url()).searchParams.get("fixture")).toBe("list");
});

test("shared copy follows the language", async ({ page }) => {
  await open(page, "en");
  await expect(page.getByRole("button", { name: "Show hint" }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: /Suchanbieter/ })).toContainText(
    "Managed centrally in Accounts",
  );
  await expect(page.getByRole("button", { name: "More actions" })).toBeVisible();
});
```

- [ ] **Step 2: Implement the components**

`web/components/link-click.js`:

```js
/** A plain primary click: in-app navigation; modified clicks keep browser behaviour. */
export const isPlainClick = (event) =>
  event.button === 0 &&
  !event.metaKey &&
  !event.ctrlKey &&
  !event.shiftKey &&
  !event.altKey;
```

`web/components/InfoHint.jsx`:

```jsx
import React, { useCallback, useId, useState } from "react";
import { commonCopy } from "../lib/i18n/messages/common.js";

// ⓘ hints are disclosures, never tooltips: the button reveals the hint text verbatim
// below its row or group label.
export function useInfoHint() {
  const id = `${useId()}-hint`;
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((value) => !value), []);
  return { id, open, toggle };
}

export function InfoHintButton({ hint, label }) {
  return (
    <button
      type="button"
      className="info-hint-button"
      aria-expanded={hint.open}
      aria-controls={hint.id}
      aria-label={label ?? commonCopy.showHint}
      onClick={hint.toggle}
    >
      i
    </button>
  );
}

export function InfoHintText({ hint, children }) {
  return (
    <p id={hint.id} className="info-hint-text" hidden={!hint.open}>
      {children}
    </p>
  );
}
```

`web/components/GroupLabel.jsx`:

```jsx
import React from "react";
import { InfoHintButton, InfoHintText, useInfoHint } from "./InfoHint.jsx";

export default function GroupLabel({
  children,
  as: Heading = "h2",
  id,
  hint,
  hintLabel,
  action,
}) {
  const info = useInfoHint();
  return (
    <div className="group-label">
      <div className="group-label-row">
        <Heading id={id}>{children}</Heading>
        {hint && <InfoHintButton hint={info} label={hintLabel} />}
        {action && (
          <button
            type="button"
            className="group-label-action"
            onClick={action.onClick}
            disabled={action.disabled}
          >
            {action.label}
          </button>
        )}
      </div>
      {hint && <InfoHintText hint={info}>{hint}</InfoHintText>}
    </div>
  );
}
```

`web/components/ListCard.jsx`:

```jsx
import React from "react";

// Rows sit on a darker card; the 1px gap between them draws the dividers.
export default function ListCard({
  label,
  labelledBy,
  disabled = false,
  className = "",
  children,
}) {
  return (
    <div
      role="group"
      aria-label={label}
      aria-labelledby={labelledBy}
      aria-disabled={disabled || undefined}
      className={["list-card", disabled ? "is-disabled" : "", className]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
    </div>
  );
}
```

`web/components/ListRow.jsx`:

```jsx
import React, { useId } from "react";
import Icon from "./Icon.jsx";
import { InfoHintButton, InfoHintText, useInfoHint } from "./InfoHint.jsx";
import { isPlainClick } from "./link-click.js";
import { commonCopy } from "../lib/i18n/messages/common.js";

// Shown until a value is known; rows never show a made-up 0.
export const unknownValue = "—";

function RowText({ label, sub, labelId, subId }) {
  return (
    <span className="list-row-text">
      <span className="list-row-label" id={labelId}>
        {label}
      </span>
      {sub && (
        <span className="list-row-sub" id={subId}>
          {sub}
        </span>
      )}
    </span>
  );
}

function Trailing({ value, status }) {
  if (status)
    return (
      <span className={`list-row-status ${status.tone}`}>
        {status.tone !== "warn" && <span className="dot" aria-hidden="true" />}
        {status.text}
      </span>
    );
  if (value === undefined || value === null || value === false) return null;
  return <span className="list-row-value">{value}</span>;
}

const rowClass = (sub, ...extra) =>
  ["list-row", sub ? "two-line" : "", ...extra].filter(Boolean).join(" ");

export default function ListRow({
  label,
  sub,
  icon,
  value,
  status,
  onClick,
  href,
  chevron,
  menu,
  onDelete,
  deleteLabel,
  hint,
  hintLabel,
  disabled = false,
  className = "",
  children,
}) {
  const info = useInfoHint();
  const navigates = Boolean(onClick || href);
  const body = (
    <>
      {icon && (
        <span className="list-row-icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <RowText label={label} sub={sub} />
      <Trailing value={value} status={status} />
      {(chevron ?? navigates) && (
        <Icon name="chevron" size={14} className="list-row-chevron" />
      )}
    </>
  );
  const main = href ? (
    <a
      className="list-row-main"
      href={href}
      aria-disabled={disabled || undefined}
      onClick={(event) => {
        if (!onClick || !isPlainClick(event)) return;
        event.preventDefault();
        if (!disabled) onClick();
      }}
    >
      {body}
    </a>
  ) : onClick ? (
    <button type="button" className="list-row-main" onClick={onClick} disabled={disabled}>
      {body}
    </button>
  ) : (
    <div className="list-row-main">{body}</div>
  );
  return (
    <>
      <div className={rowClass(sub, className)}>
        {main}
        {hint && <InfoHintButton hint={info} label={hintLabel} />}
        {children}
        {menu && (
          <button
            type="button"
            className="list-row-icon-button"
            aria-label={menu.label ?? commonCopy.moreActions}
            aria-haspopup="menu"
            aria-expanded={menu.expanded}
            disabled={disabled}
            onClick={menu.onClick}
          >
            <Icon name="more" />
          </button>
        )}
        {onDelete && (
          <button
            type="button"
            className="list-row-icon-button"
            aria-label={deleteLabel ?? commonCopy.delete}
            disabled={disabled}
            onClick={onDelete}
          >
            <Icon name="trash" />
          </button>
        )}
      </div>
      {hint && <InfoHintText hint={info}>{hint}</InfoHintText>}
    </>
  );
}

function ControlRow({ kind, label, sub, hint, hintLabel, control, selected = false }) {
  const info = useInfoHint();
  const id = useId();
  return (
    <>
      <div className={rowClass(sub, `${kind}-row`, selected ? "selected" : "")}>
        <label className="list-row-main" htmlFor={id}>
          <RowText label={label} sub={sub} labelId={`${id}-label`} subId={`${id}-sub`} />
        </label>
        {hint && <InfoHintButton hint={info} label={hintLabel} />}
        {control({
          id,
          "aria-labelledby": `${id}-label`,
          "aria-describedby": sub ? `${id}-sub` : undefined,
        })}
      </div>
      {hint && <InfoHintText hint={info}>{hint}</InfoHintText>}
    </>
  );
}

export function ToggleRow({ checked, onChange, disabled, ...row }) {
  return (
    <ControlRow
      kind="toggle"
      {...row}
      control={(props) => (
        <input
          {...props}
          type="checkbox"
          role="switch"
          className="switch"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
      )}
    />
  );
}

export function NumberRow({ value, onChange, min, max, step, disabled, ...row }) {
  return (
    <ControlRow
      kind="number"
      {...row}
      control={(props) => (
        <input
          {...props}
          type="number"
          inputMode="numeric"
          className="list-row-number"
          value={value}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          onChange={(event) =>
            onChange(event.target.value === "" ? "" : Number(event.target.value))
          }
        />
      )}
    />
  );
}

export function SelectRow({ value, options, onChange, disabled, ...row }) {
  return (
    <ControlRow
      kind="select"
      {...row}
      control={(props) => (
        <span className="list-row-select">
          <select
            {...props}
            value={value}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
          >
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <Icon name="down" size={14} />
        </span>
      )}
    />
  );
}

export function RadioRow({ name, value, checked, onChange, disabled, ...row }) {
  return (
    <ControlRow
      kind="radio"
      selected={checked}
      {...row}
      control={(props) => (
        <input
          {...props}
          type="radio"
          name={name}
          value={value}
          checked={checked}
          disabled={disabled}
          onChange={() => onChange(value)}
        />
      )}
    />
  );
}

export function CheckboxRow({ checked, onChange, pill, disabled, ...row }) {
  return (
    <ControlRow
      kind="checkbox"
      {...row}
      control={(props) => (
        <>
          {pill && <span className="list-row-pill">{pill}</span>}
          <input
            {...props}
            type="checkbox"
            checked={checked}
            disabled={disabled}
            onChange={(event) => onChange(event.target.checked)}
          />
        </>
      )}
    />
  );
}
```

`web/components/Segmented.jsx`:

```jsx
import React from "react";
import Segment from "./Segment.jsx";

// The settings pattern's segmented control: Segment's radios with the handoff look.
export default function Segmented({ className = "", ...props }) {
  return (
    <Segment {...props} className={["segmented", className].filter(Boolean).join(" ")} />
  );
}
```

`web/components/ReferenceRow.jsx`:

```jsx
import React from "react";
import Icon from "./Icon.jsx";
import { isPlainClick } from "./link-click.js";
import { commonCopy } from "../lib/i18n/messages/common.js";

// A setting managed centrally: a dashed row that opens its Accounts subpage.
export default function ReferenceRow({ title, sub, count, href, onOpen, linkLabel }) {
  const subtitle = sub === undefined ? commonCopy.centralInAccounts : sub;
  return (
    <a
      className="reference-row"
      href={href}
      onClick={(event) => {
        if (!isPlainClick(event)) return;
        event.preventDefault();
        onOpen();
      }}
    >
      <span className="list-row-text">
        <span className="list-row-label">
          {title}
          {count && <span className="reference-row-count">{` · ${count}`}</span>}
        </span>
        {subtitle && <span className="list-row-sub">{subtitle}</span>}
      </span>
      <span className="reference-row-link">
        {linkLabel ?? commonCopy.accounts}
        <Icon name="external" size={13} />
      </span>
    </a>
  );
}
```

- [ ] **Step 3: Add the styles**

Create `web/styles/settings-pattern.css`:

```css
/* Settings pattern (docs/settings-pattern.md, handoff "Einstellungen"): group labels,
   list cards, rows, ⓘ hints, segmented control and Accounts reference rows. */
.group-label {
  display: grid;
  gap: 6px;
  margin: 20px 0 8px;
}
.group-label-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 20px;
  padding: 0 4px;
}
.group-label :is(h2, h3, h4) {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #92949d;
}
.group-label-action {
  margin-left: auto;
  padding: 0;
  font-size: 13px;
  color: #ffc99d;
}
.list-card {
  display: flex;
  flex-direction: column;
  gap: 1px;
  overflow: hidden;
  border: 1px solid #28292d;
  border-radius: 12px;
  background: #232428;
}
.list-card.is-disabled {
  opacity: 0.5;
}
.list-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 48px;
  padding: 0 12px 0 14px;
  background: #16171b;
  color: #e8e8ec;
}
.list-row.two-line {
  min-height: 56px;
}
.list-row-main {
  display: flex;
  flex: 1;
  align-items: center;
  align-self: stretch;
  gap: 12px;
  min-width: 0;
  padding: 0;
  font: inherit;
  font-size: inherit;
  font-weight: inherit;
  color: inherit;
  text-align: left;
  text-decoration: none;
}
label.list-row-main {
  flex-direction: row;
  cursor: pointer;
}
.list-row-text {
  display: grid;
  gap: 2px;
  min-width: 0;
  padding: 12px 0;
}
.list-row-label {
  font-size: 15px;
  line-height: 1.4;
  overflow-wrap: anywhere;
}
.list-row-sub {
  font-size: 12px;
  color: #92949d;
}
.list-row-icon {
  display: inline-flex;
  flex: none;
}
.list-row-value {
  margin-left: auto;
  font-size: 13px;
  color: #92949d;
  white-space: nowrap;
}
.list-row-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  font-size: 13px;
  white-space: nowrap;
}
.list-row-status .dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}
.list-row-status.ok {
  color: #9fd3a8;
}
.list-row-status.ok .dot {
  background: #5fbf75;
}
.list-row-status.error {
  color: #e7a3a3;
}
.list-row-status.error .dot {
  background: #d66a6a;
}
.list-row-status.warn,
.list-row-pill {
  padding: 3px 9px;
  border: 1px solid #f49a5833;
  border-radius: 999px;
  background: #30261c;
  font-size: 12px;
  color: #ffc99d;
}
.list-row-chevron {
  flex: none;
  color: #6f7075;
}
.list-row-icon-button {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: 10px;
  color: #92949d;
}
.list-row-icon-button:hover:not(:disabled) {
  background: #232428;
  color: #e8e8ec;
}
.list-row-icon-button svg {
  stroke-width: 2.4;
}
.list-row input.switch {
  appearance: none;
  position: relative;
  flex: none;
  width: 38px;
  height: 22px;
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: 11px;
  background: #2c2d32;
  cursor: pointer;
}
.list-row input.switch::after {
  content: "";
  position: absolute;
  top: 3px;
  left: 3px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #92949d;
  transition:
    transform 0.16s,
    background 0.16s;
}
.list-row input.switch:checked {
  background: #f49a58;
}
.list-row input.switch:checked::after {
  background: #242529;
  transform: translateX(16px);
}
.list-row input.list-row-number {
  flex: none;
  width: 64px;
  height: 34px;
  padding: 0 8px;
  font-size: 13px;
  text-align: right;
}
.list-row-select {
  position: relative;
  display: inline-flex;
  align-items: center;
  margin-left: auto;
  color: #92949d;
}
.list-row-select select {
  appearance: none;
  width: auto;
  height: 34px;
  padding: 0 20px 0 8px;
  border: 0;
  background: transparent;
  font-size: 13px;
  color: #92949d;
  text-align: right;
}
.list-row-select svg {
  position: absolute;
  right: 0;
  pointer-events: none;
}
.list-row input[type="radio"],
.list-row input[type="checkbox"]:not(.switch) {
  appearance: none;
  flex: none;
  width: 18px;
  height: 18px;
  margin: 0;
  padding: 0;
  border: 1px solid #3a3b40;
  border-radius: 50%;
  background: transparent;
  cursor: pointer;
}
.list-row input[type="checkbox"]:not(.switch) {
  border-radius: 5px;
}
.list-row input[type="radio"]:checked {
  border: 5px solid #f49a58;
}
.list-row input[type="checkbox"]:not(.switch):checked {
  border-color: #f49a58;
  background: #f49a58;
  box-shadow: inset 0 0 0 3px #16171b;
}
.list-row.radio-row.selected {
  background: #1d1a17;
}
.info-hint-button {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 1px solid #3a3b40;
  border-radius: 50%;
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
  color: #92949d;
}
.info-hint-button[aria-expanded="true"] {
  border-color: #f49a5866;
  color: #ffc99d;
}
.info-hint-text {
  padding: 0 4px;
  font-size: 13px;
  line-height: 1.5;
  color: #a2a3a7;
}
.list-card > .info-hint-text {
  padding: 10px 14px 12px;
  background: #16171b;
}
.reference-row {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 52px;
  margin-top: 8px;
  padding: 0 14px;
  border: 1px dashed #3a3b40;
  border-radius: 12px;
  color: #e8e8ec;
  text-decoration: none;
}
.reference-row-count {
  color: #92949d;
}
.reference-row-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
  font-size: 13px;
  color: #ffc99d;
  white-space: nowrap;
}
.segment.segmented {
  gap: 3px;
  padding: 3px;
  border-color: #28292d;
  border-radius: 10px;
  background: #16171b;
}
.segment.segmented label {
  border-radius: 7px;
  font-size: 13px;
  color: #a2a3a7;
}
.segment.segmented label.selected {
  background: #f49a58;
  color: #242529;
}
```

In `web/styles/index.css` add after `@import "../components/segment.css";`:

```css
@import "settings-pattern.css";
```

- [ ] **Step 4: Add the list fixture**

Create `tests/browser/harness/settings-pattern/list-fixture.js`:

```js
import { createElement as h, useState } from "react";
import GroupLabel from "../../../../web/components/GroupLabel.jsx";
import ListCard from "../../../../web/components/ListCard.jsx";
import ListRow, {
  CheckboxRow,
  NumberRow,
  RadioRow,
  SelectRow,
  ToggleRow,
  unknownValue,
} from "../../../../web/components/ListRow.jsx";
import ReferenceRow from "../../../../web/components/ReferenceRow.jsx";
import Segmented from "../../../../web/components/Segmented.jsx";

export default function ListFixture() {
  const [events, setEvents] = useState([]);
  const [memory, setMemory] = useState(false);
  const [members, setMembers] = useState(4);
  const [language, setLanguage] = useState("de");
  const [shell, setShell] = useState("off");
  const [server, setServer] = useState(false);
  const [segment, setSegment] = useState("active");
  const record = (entry) => setEvents((list) => [...list, entry]);
  return h(
    "main",
    { className: "harness" },
    h(
      "section",
      null,
      h(
        GroupLabel,
        {
          hint: "Erinnerungen laufen auch ohne geöffnete App.",
          action: {
            label: "+ Erinnerung erstellen",
            onClick: () => record("action:reminder"),
          },
        },
        "Gedächtnis & Erinnerungen",
      ),
      h(
        ListCard,
        { label: "Gedächtnis & Erinnerungen" },
        h(ToggleRow, {
          label: "Gedächtnis",
          hint: "Speichert Notizen zwischen Unterhaltungen.",
          checked: memory,
          onChange: (value) => {
            setMemory(value);
            record(`memory:${value}`);
          },
        }),
        h(ListRow, {
          label: "Gespeicherte Notizen",
          value: "12",
          onClick: () => record("open:notes"),
        }),
        h(ListRow, { label: "Letzte Diagnose", value: unknownValue }),
        h(ListRow, {
          label: "Telegram",
          sub: "Bot @home",
          status: { tone: "ok", text: "Verbunden" },
        }),
        h(ListRow, {
          label: "Updates",
          status: { tone: "warn", text: "1.29.0 verfügbar" },
        }),
        h(ListRow, {
          label: "Plugin",
          sub: "Version 2.1",
          menu: { onClick: () => record("menu:plugin") },
        }),
        h(ListRow, {
          label: "ls",
          onDelete: () => record("delete:ls"),
          deleteLabel: "ls entfernen",
        }),
        h(NumberRow, {
          label: "Max. Mitglieder",
          value: members,
          min: 1,
          max: 8,
          onChange: (value) => {
            setMembers(value);
            record(`members:${value}`);
          },
        }),
        h(SelectRow, {
          label: "Sprache der Hinweise",
          value: language,
          options: [
            { value: "de", label: "Deutsch" },
            { value: "en", label: "Englisch" },
          ],
          onChange: (value) => {
            setLanguage(value);
            record(`language:${value}`);
          },
        }),
      ),
      h(
        ListCard,
        { label: "Shell" },
        ...["off", "approval", "full"].map((value) =>
          h(RadioRow, {
            key: value,
            name: "shell",
            value,
            label: { off: "Aus", approval: "Mit Freigabe", full: "Voll" }[value],
            checked: shell === value,
            onChange: (next) => {
              setShell(next);
              record(`shell:${next}`);
            },
          }),
        ),
      ),
      h(
        ListCard,
        { label: "MCP-Server" },
        h(CheckboxRow, {
          label: "GitHub",
          sub: "https://api.github.com/mcp",
          pill: "stdio",
          checked: server,
          onChange: (value) => {
            setServer(value);
            record(`server:${value}`);
          },
        }),
      ),
      h(ReferenceRow, {
        title: "Suchanbieter",
        href: "/accounts?section=services&item=web-search",
        onOpen: () => record("accounts:services/web-search"),
      }),
      h(Segmented, {
        label: "Ansicht",
        options: [
          { value: "active", label: "Aktiv" },
          { value: "archive", label: "Archiv" },
        ],
        value: segment,
        onChange: (value) => {
          setSegment(value);
          record(`segment:${value}`);
        },
      }),
    ),
    h("output", { "data-testid": "log" }, events.join(" ")),
  );
}
```

In `tests/browser/harness/settings-pattern/main.js` add `import "../../../../web/styles/settings-pattern.css";` after the underline-tabs import, `import ListFixture from "./list-fixture.js";`, and extend the map: `const fixtures = { tabs: TabsFixture, list: ListFixture };`.

- [ ] **Step 5: Run the browser spec**

Run: `npx playwright test tests/browser/settings-pattern-list.spec.js` (after `npm run build` once in this session; the harness itself needs no build)
Expected: PASS (6 tests).

- [ ] **Step 6: Verify no existing page changed**

Run: `npm run build && npx playwright test tests/browser/assistant-settings.spec.js tests/browser/projects.spec.js tests/browser/extensions.spec.js`
Expected: PASS (the new stylesheet only targets new class names; `.segment.segmented` only applies with the new class).

- [ ] **Step 7: Commit**

```bash
npx prettier --write web/components web/styles tests/browser/harness tests/browser/settings-pattern-list.spec.js
npx eslint web/components tests/browser/harness tests/browser/settings-pattern-list.spec.js
git add web/components web/styles tests/browser/harness tests/browser/settings-pattern-list.spec.js
git commit -m "feat: add list cards, rows, hints and reference rows for settings pages" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 9: Tab drafts, the save bar and the unsaved-changes sheet

`useTabDraft` generalises `useSyncedForm`: values, base revisions, dirty state, change count, conflicts, reset, and `save(steps)` through the chain of Task 5. `useUnsavedChangesGuard` registers the draft with the navigation coordinator of Task 3 and drives `UnsavedChangesSheet`. `SaveBar` shows the draft's state.

**Files:**

- Create: `web/lib/settings/useTabDraft.js`, `web/lib/settings/useUnsavedChangesGuard.js`
- Create: `web/components/SaveBar.jsx`, `web/components/Sheet.jsx`, `web/components/UnsavedChangesSheet.jsx`
- Modify: `web/features/assistants/useSyncedForm.js` (thin wrapper), `web/styles/settings-pattern.css` (append)
- Create: `tests/browser/harness/settings-pattern/draft-fixture.js`; Modify: `tests/browser/harness/settings-pattern/main.js`
- Test: `tests/browser/settings-pattern-draft.spec.js`

**Interfaces:**

- Consumes: `followServer`, `changedKeys`, `markSaved`, `followRevisions`, `sameValue` (Task 4); `runSaveChain`, `completedLabels` (Task 5); `registerNavigationGuard`, `holdUnloadWarning`, `needsDecision` (Task 3); `commonCopy` keys (Task 2).
- Produces:
  - `useTabDraft({ server, revisions = {}, countChanges? }) => draft` where `server` is the flat field object the tab edits and `revisions` maps resource → latest server revision (e.g. `{ assistant: assistant.revision }`, `{ access, team }`). `draft` is:
    - `values`, `base`, `set(key, value)`, `update(patch)`
    - `dirty: boolean`, `changedKeys: string[]`, `changeCount: number` (`countChanges(values, base)` when given, else `changedKeys.length`)
    - `conflicts: string[]` (fields edited here and changed on the server)
    - `saving: boolean`, `outcome: null | { status: "error" | "conflict", error, failedStep, completed, partial: string[] }`
    - `confirmation: null | { kind, flags, data, stepId, confirm(), cancel() }` — render a `Sheet` for it while not null
    - `save(steps) => Promise<ChainResult>` (returns `{ status: "busy" }` while a save runs); on `"saved"` the whole snapshot becomes the base; on a stop only the finished steps' keys do, so the tab stays dirty.
    - `overwrite(steps)` — adopt the latest server revisions, then `save(steps)` ("Overwrite anyway")
    - `reset()` / `reload()` — values and base back to the server, outcome cleared ("Cancel", "Reload", "Discard")
    - `revisions() => object` — the base revisions the next save sends. While the draft is clean they follow `revisions` (never going backwards); while dirty they stay frozen, so a foreign change surfaces as a 409.
  - `useUnsavedChangesGuard({ draft, tab, save, stays? }) => sheetProps` — `save` is `() => draft.save(steps)` (a full save accepts the navigation); `stays(request)` returns true for navigations that keep this draft on screen (e.g. same agent, same tab). Holds the `beforeunload` warning while `draft.dirty`. `sheetProps = { open, tab, count, busy, onSave, onDiscard, onCancel }` (hidden while a chain confirmation is open).
  - `UnsavedChangesSheet({ open, tab, count, busy, onSave, onDiscard, onCancel })` — "Änderungen speichern?" with "Speichern und wechseln" (primary h46), "Verwerfen", "Abbrechen"; Escape cancels.
  - `Sheet({ open, title, onCancel, className?, children })` — modal `<dialog class="sheet">`: bottom sheet below 701px, centred dialog max-width 420 above. Page steps use it for chain confirmations (`draft.confirmation`), body content in `.sheet-body`, buttons in `.sheet-actions`.
  - `SaveBar({ draft, onSave, onOverwrite, saveLabel?, cancelLabel?, note? })` — `role="region"` named `commonCopy.unsavedChanges`; rendered only while `draft.dirty`, `draft.saving` or `draft.outcome`. Left: error/conflict/partial text (`role="alert"`) or the optional `note` (e.g. "Startet 2 Agenten kurz neu."). Right: Cancel (`draft.reset`) + primary (`saveLabel ?? commonCopy.save`); in a conflict: "Neu laden" (`draft.reload`) + "Trotzdem überschreiben" (`onOverwrite`). Content limited to 720px; safe-area padding.
  - `useSyncedForm(server)` keeps its return shape `{ values, set, conflicts, reload, dirty }` and now delegates to `useTabDraft`.

- [ ] **Step 1: Write the browser spec (fails: fixture missing)**

Create `tests/browser/settings-pattern-draft.spec.js`:

```js
import { test, expect } from "@playwright/test";
import { startSettingsHarness } from "../helpers/settings-pattern-harness.js";

test.describe.configure({ timeout: 90000 });
let harness;
test.beforeAll(async () => {
  harness = await startSettingsHarness();
});
test.afterAll(async () => {
  await harness?.close();
});
const open = (page, lang = "de") =>
  page.goto(`${harness.url}?fixture=draft&lang=${lang}`);
const bar = (page, name = "Ungespeicherte Änderungen") =>
  page.getByRole("region", { name });
const server = async (page) => JSON.parse(await page.getByTestId("server").textContent());
const harnessState = (page) => page.evaluate(() => window.harness);

test("the bar appears only while dirty and cancel restores the server value", async ({
  page,
}) => {
  await open(page);
  await expect(bar(page)).toHaveCount(0);
  await page.getByLabel("Name").fill("Office");
  await expect(bar(page)).toBeVisible();
  await expect(bar(page)).toContainText("Startet 2 Agenten kurz neu.");
  const save = bar(page).getByRole("button", { name: "Speichern" });
  expect(Math.round((await save.boundingBox()).height)).toBe(40);
  await bar(page).getByRole("button", { name: "Abbrechen" }).click();
  await expect(bar(page)).toHaveCount(0);
  await expect(page.getByLabel("Name")).toHaveValue("Home");
});

test("a failed second step reports the partial save and a retry skips the first", async ({
  page,
}) => {
  await open(page);
  await page.evaluate(() => {
    window.harness.failTeam = true;
  });
  await page.getByLabel("Name").fill("Office");
  await page.getByRole("spinbutton", { name: "Mitglieder" }).fill("6");
  await bar(page).getByRole("button", { name: "Speichern" }).click();
  await expect(bar(page).getByRole("alert")).toContainText(
    "Teilweise gespeichert: Profil.",
  );
  await expect(bar(page).getByRole("alert")).toContainText(
    "Team konnte nicht gespeichert werden.",
  );
  expect((await server(page)).name).toBe("Office");
  expect((await server(page)).maxMembers).toBe(4);
  await page.evaluate(() => {
    window.harness.failTeam = false;
  });
  await bar(page).getByRole("button", { name: "Speichern" }).click();
  await expect(bar(page)).toHaveCount(0);
  expect((await server(page)).maxMembers).toBe(6);
  expect((await harnessState(page)).calls).toEqual({ agent: 1, team: 2 });
});

test("a confirmation opens a sheet and the step repeats with the flag", async ({
  page,
}) => {
  await open(page);
  await page.evaluate(() => {
    window.harness.restart = true;
  });
  await page.getByRole("switch", { name: "Gedächtnis" }).check();
  await bar(page).getByRole("button", { name: "Speichern" }).click();
  const sheet = page.getByRole("dialog", { name: "Neustart bestätigen" });
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: "Abbrechen" }).click();
  await expect(sheet).toHaveCount(0);
  await expect(bar(page).getByRole("alert")).toHaveCount(0);
  await bar(page).getByRole("button", { name: "Speichern" }).click();
  await page
    .getByRole("dialog", { name: "Neustart bestätigen" })
    .getByRole("button", { name: "Neu starten" })
    .click();
  await expect(bar(page)).toHaveCount(0);
  expect((await server(page)).memory).toBe(true);
});

test("a foreign change is adopted where untouched and overwriting keeps it", async ({
  page,
}) => {
  await open(page);
  await page.getByLabel("Name").fill("Office");
  await page.evaluate(() => window.harness.foreignChange());
  await expect(page.getByRole("switch", { name: "Gedächtnis" })).toBeChecked();
  await bar(page).getByRole("button", { name: "Speichern" }).click();
  await expect(bar(page).getByRole("alert")).toContainText(
    "Inzwischen an anderer Stelle geändert.",
  );
  await bar(page).getByRole("button", { name: "Trotzdem überschreiben" }).click();
  await expect(bar(page)).toHaveCount(0);
  expect(await server(page)).toMatchObject({ name: "Office", memory: true, revision: 3 });
});

test("reload after a conflict drops the edit", async ({ page }) => {
  await open(page);
  await page.getByLabel("Name").fill("Office");
  await page.evaluate(() => window.harness.foreignChange());
  await bar(page).getByRole("button", { name: "Speichern" }).click();
  await bar(page).getByRole("button", { name: "Neu laden" }).click();
  await expect(bar(page)).toHaveCount(0);
  await expect(page.getByLabel("Name")).toHaveValue("Home");
});

test("switching tabs with unsaved changes asks first", async ({ page }) => {
  await open(page);
  await page.getByLabel("Name").fill("Office");
  await page.getByRole("tab", { name: "Team" }).click();
  const sheet = page.getByRole("dialog", { name: "Änderungen speichern?" });
  await expect(sheet).toContainText(
    "Im Tab Profil ist 1 Änderung noch nicht gespeichert.",
  );
  await sheet.getByRole("button", { name: "Abbrechen" }).click();
  await expect(page.getByTestId("tab")).toHaveText("profile");
  await page.getByRole("tab", { name: "Team" }).click();
  await sheet.getByRole("button", { name: "Verwerfen" }).click();
  await expect(page.getByTestId("tab")).toHaveText("team");
  await expect(page.getByLabel("Name")).toHaveValue("Home");
  await page.getByRole("tab", { name: "Profil" }).click();
  await expect(page.getByTestId("tab")).toHaveText("profile");
  await page.getByLabel("Name").fill("Office");
  await page.getByRole("tab", { name: "Team" }).click();
  await sheet.getByRole("button", { name: "Speichern und wechseln" }).click();
  await expect(page.getByTestId("tab")).toHaveText("team");
  expect((await server(page)).name).toBe("Office");
});

test("the unload warning is held only while the draft is dirty", async ({ page }) => {
  await page.addInitScript(() => {
    window.__unload = { added: 0, removed: 0 };
    const add = window.addEventListener.bind(window);
    const remove = window.removeEventListener.bind(window);
    window.addEventListener = (type, listener, options) => {
      if (type === "beforeunload") window.__unload.added++;
      return add(type, listener, options);
    };
    window.removeEventListener = (type, listener, options) => {
      if (type === "beforeunload") window.__unload.removed++;
      return remove(type, listener, options);
    };
  });
  await open(page);
  // The dev server's client may listen itself; only the draft's changes count.
  const before = await page.evaluate(() => ({ ...window.__unload }));
  await page.getByLabel("Name").fill("Office");
  await page.getByLabel("Name").fill("Office 2");
  await expect
    .poll(() => page.evaluate(() => window.__unload.added))
    .toBe(before.added + 1);
  await bar(page).getByRole("button", { name: "Abbrechen" }).click();
  await expect
    .poll(() => page.evaluate(() => window.__unload.removed))
    .toBe(before.removed + 1);
});

test("English copy and the phone bottom sheet", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, "en");
  await page.getByLabel("Name").fill("Office");
  await expect(
    bar(page, "Unsaved changes").getByRole("button", { name: "Save" }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Team" }).click();
  const sheet = page.getByRole("dialog", { name: "Save changes?" });
  await expect(sheet).toContainText("1 change in Profil is not saved yet.");
  const box = await sheet.boundingBox();
  expect(Math.round(box.y + box.height)).toBe(844);
  await expect(sheet.getByRole("button", { name: "Save and switch" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(page.getByTestId("tab")).toHaveText("profile");
});

test("the desktop sheet is a centred dialog of at most 420px", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await open(page);
  await page.getByLabel("Name").fill("Office");
  await page.getByRole("tab", { name: "Team" }).click();
  const box = await page
    .getByRole("dialog", { name: "Änderungen speichern?" })
    .boundingBox();
  expect(box.width).toBeLessThanOrEqual(420);
  expect(Math.abs(box.x + box.width / 2 - 640)).toBeLessThanOrEqual(2);
});
```

- [ ] **Step 2: Implement the hooks**

`web/lib/settings/useTabDraft.js`:

```js
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  changedKeys,
  followRevisions,
  followServer,
  markSaved,
  sameValue,
} from "./draft-state.js";
import { completedLabels, runSaveChain } from "./save-chain.js";

/**
 * One tab's draft of server fields. Untouched fields follow the server; the base
 * revisions freeze at the first edit so a foreign change surfaces as a conflict.
 * See docs/settings-pattern.md for the save-chain protocol.
 */
export default function useTabDraft({ server, revisions = {}, countChanges } = {}) {
  const [state, setState] = useState(() => ({ values: server, base: server }));
  const [conflicts, setConflicts] = useState([]);
  const [saving, setSaving] = useState(false);
  const [outcome, setOutcome] = useState(null);
  const [confirmation, setConfirmation] = useState(null);
  const current = useRef(state);
  current.current = state;
  const latest = useRef({ server, revisions });
  latest.current = { server, revisions };
  const baseRevisions = useRef(revisions);
  const busy = useRef(false);
  const signature = JSON.stringify(server);
  useEffect(() => {
    const next = followServer(current.current, server);
    if (next.values !== current.current.values || next.base !== current.current.base) {
      current.current = { values: next.values, base: next.base };
      setState(current.current);
    }
    setConflicts((previous) =>
      sameValue(previous, next.conflicts) ? previous : next.conflicts,
    );
    // `signature` captures every change of `server`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
  const changed = useMemo(() => changedKeys(state.values, state.base), [state]);
  const dirty = changed.length > 0;
  const revisionSignature = JSON.stringify(revisions);
  useEffect(() => {
    if (!dirty)
      baseRevisions.current = followRevisions(
        baseRevisions.current,
        latest.current.revisions,
      );
  }, [dirty, revisionSignature]);
  const set = useCallback(
    (key, value) =>
      setState((previous) => ({
        ...previous,
        values: { ...previous.values, [key]: value },
      })),
    [],
  );
  const update = useCallback(
    (patch) =>
      setState((previous) => ({ ...previous, values: { ...previous.values, ...patch } })),
    [],
  );
  const reset = useCallback(() => {
    const { server: latestServer, revisions: latestRevisions } = latest.current;
    current.current = { values: latestServer, base: latestServer };
    setState(current.current);
    setConflicts([]);
    setOutcome(null);
    baseRevisions.current = followRevisions(baseRevisions.current, latestRevisions);
  }, []);
  const save = useCallback(async (steps) => {
    if (busy.current) return { status: "busy" };
    busy.current = true;
    setSaving(true);
    setOutcome(null);
    const { values, base } = current.current;
    try {
      const result = await runSaveChain({
        steps,
        values,
        base,
        revisions: baseRevisions.current,
        ask: (request) =>
          new Promise((resolve) =>
            setConfirmation({
              ...request,
              confirm: () => {
                setConfirmation(null);
                resolve(true);
              },
              cancel: () => {
                setConfirmation(null);
                resolve(false);
              },
            }),
          ),
      });
      baseRevisions.current = result.revisions;
      setState((previous) => ({
        values: previous.values,
        base:
          result.status === "saved"
            ? values
            : markSaved(previous.base, values, result.savedKeys),
      }));
      if (result.status === "saved") setConflicts([]);
      setOutcome(
        result.status === "error" || result.status === "conflict"
          ? { ...result, partial: completedLabels(steps, result) }
          : null,
      );
      return result;
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }, []);
  const overwrite = useCallback(
    (steps) => {
      baseRevisions.current = followRevisions(
        baseRevisions.current,
        latest.current.revisions,
      );
      return save(steps);
    },
    [save],
  );
  const revisionsOf = useCallback(() => ({ ...baseRevisions.current }), []);
  return {
    values: state.values,
    base: state.base,
    set,
    update,
    dirty,
    changedKeys: changed,
    changeCount: countChanges ? countChanges(state.values, state.base) : changed.length,
    conflicts,
    saving,
    outcome,
    confirmation,
    save,
    overwrite,
    reset,
    reload: reset,
    revisions: revisionsOf,
  };
}
```

`web/lib/settings/useUnsavedChangesGuard.js`:

```js
import { useCallback, useEffect, useRef, useState } from "react";
import {
  holdUnloadWarning,
  needsDecision,
  registerNavigationGuard,
} from "../navigation-guard.js";

/**
 * Asks before any navigation leaves a dirty draft (tab switch, back, agent or profile
 * switch, app navigation) and warns before unload. Returns UnsavedChangesSheet props.
 */
export default function useUnsavedChangesGuard({ draft, tab, save, stays }) {
  const [pending, setPending] = useState(null);
  const [busy, setBusy] = useState(false);
  const live = useRef(null);
  live.current = { dirty: draft.dirty, reset: draft.reset, save, stays };
  const waiting = useRef(null);
  waiting.current = pending;
  useEffect(() => {
    // An unmounted draft refuses the navigation it was still asking about.
    let asking = null;
    const unregister = registerNavigationGuard((request) =>
      needsDecision(request, { dirty: live.current.dirty, stays: live.current.stays })
        ? new Promise((resolve) => {
            asking = resolve;
            setPending({ resolve });
          })
        : true,
    );
    return () => {
      unregister();
      asking?.(false);
    };
  }, []);
  useEffect(() => (draft.dirty ? holdUnloadWarning() : undefined), [draft.dirty]);
  const finish = useCallback((accepted) => {
    const decision = waiting.current;
    waiting.current = null;
    setPending(null);
    decision?.resolve(accepted);
  }, []);
  const onSave = useCallback(async () => {
    setBusy(true);
    try {
      finish((await live.current.save())?.status === "saved");
    } catch {
      finish(false);
    } finally {
      setBusy(false);
    }
  }, [finish]);
  const onDiscard = useCallback(() => {
    live.current.reset();
    finish(true);
  }, [finish]);
  const onCancel = useCallback(() => finish(false), [finish]);
  return {
    open: Boolean(pending) && !draft.confirmation,
    tab,
    count: draft.changeCount,
    busy,
    onSave,
    onDiscard,
    onCancel,
  };
}
```

Note: `onSave` must not call `finish` before the chain ends; `finish` runs after the awaited save, so the sheet hides only while a chain confirmation is open (`!draft.confirmation`) and reappears busy until the result.

Replace `web/features/assistants/useSyncedForm.js` with:

```js
import useTabDraft from "../../lib/settings/useTabDraft.js";

// Form values that follow the saved server record without discarding edits; kept
// for callers that save on their own (see useTabDraft for the tab save chain).
export default function useSyncedForm(server) {
  const draft = useTabDraft({ server });
  return {
    values: draft.values,
    set: draft.set,
    conflicts: draft.conflicts,
    reload: draft.reload,
    dirty: draft.dirty,
  };
}
```

- [ ] **Step 3: Implement the components**

`web/components/Sheet.jsx`:

```jsx
import React, { useEffect, useId, useRef } from "react";

function SheetDialog({ title, onCancel, className = "", children }) {
  const ref = useRef(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={["sheet", className].filter(Boolean).join(" ")}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <h2 id={titleId} className="sheet-title">
        {title}
      </h2>
      {children}
    </dialog>
  );
}

// A bottom sheet on phones and a centred dialog (max 420px) on desktop.
export default function Sheet({ open, ...props }) {
  return open ? <SheetDialog {...props} /> : null;
}
```

`web/components/UnsavedChangesSheet.jsx`:

```jsx
import React from "react";
import Sheet from "./Sheet.jsx";
import { commonCopy } from "../lib/i18n/messages/common.js";

export default function UnsavedChangesSheet({
  open,
  tab,
  count,
  busy,
  onSave,
  onDiscard,
  onCancel,
}) {
  return (
    <Sheet
      open={open}
      title={commonCopy.unsavedTitle}
      onCancel={onCancel}
      className="unsaved-changes-sheet"
    >
      <p className="sheet-body">{commonCopy.unsavedBody(tab, count)}</p>
      <div className="sheet-actions">
        <button type="button" className="button primary" disabled={busy} onClick={onSave}>
          {busy ? commonCopy.saving : commonCopy.saveAndSwitch}
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={onDiscard}
        >
          {commonCopy.discard}
        </button>
        <button type="button" className="button text" disabled={busy} onClick={onCancel}>
          {commonCopy.cancel}
        </button>
      </div>
    </Sheet>
  );
}
```

`web/components/SaveBar.jsx`:

```jsx
import React from "react";
import { commonCopy } from "../lib/i18n/messages/common.js";

// One bar per tab or subpage: visible while it has unsaved changes or reports the
// last save's error, conflict or partial result.
export default function SaveBar({
  draft,
  onSave,
  onOverwrite,
  saveLabel,
  cancelLabel,
  note,
}) {
  const { outcome } = draft;
  if (!draft.dirty && !draft.saving && !outcome) return null;
  const conflict = outcome?.status === "conflict" || draft.conflicts.length > 0;
  const message = [
    outcome?.partial?.length ? commonCopy.partiallySaved(outcome.partial.join(", ")) : "",
    conflict
      ? commonCopy.changedElsewhere
      : outcome?.status === "error"
        ? outcome.error?.message
        : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="save-bar" role="region" aria-label={commonCopy.unsavedChanges}>
      <div className="save-bar-inner">
        {message ? (
          <p className={`save-bar-note ${conflict ? "warning" : "error"}`} role="alert">
            {message}
          </p>
        ) : (
          <p className="save-bar-note">{note}</p>
        )}
        <div className="save-bar-actions">
          {conflict ? (
            <>
              <button
                type="button"
                className="button secondary"
                disabled={draft.saving}
                onClick={draft.reload}
              >
                {commonCopy.reloadLatest}
              </button>
              <button
                type="button"
                className="button primary"
                disabled={draft.saving}
                onClick={onOverwrite}
              >
                {commonCopy.overwrite}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="button secondary"
                disabled={draft.saving}
                onClick={draft.reset}
              >
                {cancelLabel ?? commonCopy.cancel}
              </button>
              <button
                type="button"
                className="button primary"
                disabled={draft.saving || !draft.dirty}
                onClick={onSave}
              >
                {draft.saving ? commonCopy.saving : (saveLabel ?? commonCopy.save)}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
```

Append to `web/styles/settings-pattern.css`:

```css
.save-bar {
  position: sticky;
  bottom: 0;
  z-index: 5;
  padding: 10px 12px calc(14px + env(safe-area-inset-bottom));
  border-top: 1px solid #28292d;
  background: #15161a;
}
.save-bar-inner {
  display: flex;
  align-items: center;
  gap: 12px;
  max-width: 720px;
  margin: 0 auto;
}
.save-bar-note {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  line-height: 1.4;
  color: #92949d;
}
.save-bar-note.error {
  color: #e7a3a3;
}
.save-bar-note.warning {
  color: #ffc99d;
}
.save-bar-actions {
  display: flex;
  flex: none;
  gap: 8px;
}
.save-bar-actions .button {
  height: 40px;
}
dialog.sheet {
  width: min(420px, calc(100vw - 32px));
  padding: 20px 16px calc(16px + env(safe-area-inset-bottom));
  border-color: #303137;
  background: #1b1c20;
}
dialog.sheet::backdrop {
  background: #08090db3;
}
.sheet-title {
  margin-bottom: 8px;
  font-size: 17px;
  font-weight: 600;
}
.sheet-body {
  margin-bottom: 16px;
  font-size: 14px;
  line-height: 1.5;
  color: #a2a3a7;
}
.sheet-actions {
  display: grid;
  gap: 8px;
}
.sheet-actions .button.primary {
  height: 46px;
}
.sheet-actions .button.text {
  border: 0;
  background: none;
  color: #ffc99d;
}
@media (max-width: 700px) {
  dialog.sheet {
    width: 100%;
    max-width: 100%;
    border: 0;
    border-top: 1px solid #303137;
    border-radius: 18px 18px 0 0;
  }
}
```

- [ ] **Step 4: Add the draft fixture**

Create `tests/browser/harness/settings-pattern/draft-fixture.js`:

```js
/* global window */
import { createElement as h, useEffect, useRef, useState } from "react";
import useTabDraft from "../../../../web/lib/settings/useTabDraft.js";
import useUnsavedChangesGuard from "../../../../web/lib/settings/useUnsavedChangesGuard.js";
import { requestNavigation } from "../../../../web/lib/navigation-guard.js";
import ListCard from "../../../../web/components/ListCard.jsx";
import { NumberRow, ToggleRow } from "../../../../web/components/ListRow.jsx";
import SaveBar from "../../../../web/components/SaveBar.jsx";
import Sheet from "../../../../web/components/Sheet.jsx";
import UnderlineTabs from "../../../../web/components/UnderlineTabs.jsx";
import UnsavedChangesSheet from "../../../../web/components/UnsavedChangesSheet.jsx";

const conflict = () =>
  Object.assign(new Error("Die Daten wurden inzwischen geändert."), {
    status: 409,
    messageKey: "assistants.conflict",
  });

// Test controls exist before the first render; the spec flips them per case.
window.harness = {
  failTeam: false,
  restart: false,
  calls: { agent: 0, team: 0 },
  foreignChange: () => {},
};

export default function DraftFixture() {
  const [server, setServer] = useState({
    revision: 1,
    name: "Home",
    memory: false,
    maxMembers: 4,
  });
  const live = useRef(server);
  const [tab, setTab] = useState("profile");
  useEffect(() => {
    // A change made elsewhere: another field and a newer revision.
    window.harness.foreignChange = () => {
      live.current = {
        ...live.current,
        memory: !live.current.memory,
        revision: live.current.revision + 1,
      };
      setServer(live.current);
    };
  }, []);
  const commit = (next) => {
    live.current = next;
    setServer(next);
  };
  const draft = useTabDraft({
    server: { name: server.name, memory: server.memory, maxMembers: server.maxMembers },
    revisions: { agent: server.revision },
  });
  const steps = [
    {
      id: "agent",
      label: "Profil",
      keys: ["name", "memory"],
      resource: "agent",
      run: async ({ values, revision, confirmations }) => {
        window.harness.calls.agent++;
        if (revision !== live.current.revision) throw conflict();
        if (window.harness.restart && !confirmations.confirmRestart)
          throw Object.assign(new Error("Neustart nötig"), {
            status: 409,
            code: "ASSISTANT_RESTART_REQUIRED",
            affected: { agents: [] },
          });
        const next = {
          ...live.current,
          name: values.name,
          memory: values.memory,
          revision: live.current.revision + 1,
        };
        commit(next);
        return next;
      },
    },
    {
      id: "team",
      label: "Team",
      keys: ["maxMembers"],
      run: async ({ values }) => {
        window.harness.calls.team++;
        if (window.harness.failTeam)
          throw new Error("Team konnte nicht gespeichert werden.");
        commit({ ...live.current, maxMembers: values.maxMembers });
        return {};
      },
    },
  ];
  const save = () => draft.save(steps);
  const sheet = useUnsavedChangesGuard({
    draft,
    tab: tab === "profile" ? "Profil" : "Team",
    save,
    stays: (request) => request.next?.tab === tab,
  });
  const select = (next) =>
    requestNavigation({
      reason: "application",
      next: { tab: next },
      commit: () => setTab(next),
    });
  return h(
    "main",
    { className: "harness" },
    h(UnderlineTabs, {
      label: "Draft tabs",
      tabs: [
        { id: "profile", label: "Profil" },
        { id: "team", label: "Team" },
      ],
      selected: tab,
      onSelect: select,
      idPrefix: "draft",
    }),
    h("p", { "data-testid": "tab" }, tab),
    h("p", { "data-testid": "server" }, JSON.stringify(server)),
    h(
      "label",
      null,
      "Name",
      h("input", {
        value: draft.values.name,
        onChange: (e) => draft.set("name", e.target.value),
      }),
    ),
    h(
      ListCard,
      { label: "Entwurf" },
      h(ToggleRow, {
        label: "Gedächtnis",
        checked: draft.values.memory,
        onChange: (value) => draft.set("memory", value),
      }),
      h(NumberRow, {
        label: "Mitglieder",
        value: draft.values.maxMembers,
        min: 1,
        max: 8,
        onChange: (value) => draft.set("maxMembers", value),
      }),
    ),
    h(SaveBar, {
      draft,
      onSave: save,
      onOverwrite: () => draft.overwrite(steps),
      note: "Startet 2 Agenten kurz neu.",
    }),
    h(UnsavedChangesSheet, sheet),
    h(
      Sheet,
      {
        open: Boolean(draft.confirmation),
        title: "Neustart bestätigen",
        onCancel: () => draft.confirmation?.cancel(),
      },
      h("p", { className: "sheet-body" }, draft.confirmation?.kind),
      h(
        "div",
        { className: "sheet-actions" },
        h(
          "button",
          {
            type: "button",
            className: "button primary",
            onClick: () => draft.confirmation.confirm(),
          },
          "Neu starten",
        ),
        h(
          "button",
          {
            type: "button",
            className: "button secondary",
            onClick: () => draft.confirmation.cancel(),
          },
          "Abbrechen",
        ),
      ),
    ),
  );
}
```

In `main.js` import `DraftFixture from "./draft-fixture.js"` and add `draft: DraftFixture` to `fixtures`.

- [ ] **Step 5: Run the draft spec**

Run: `npx playwright test tests/browser/settings-pattern-draft.spec.js`
Expected: PASS (9 tests). The "foreign change" test proves Review Focus 1, the partial-save test Review Focus 2.

- [ ] **Step 6: Verify the wrapped `useSyncedForm` keeps agent settings behaviour**

Run: `npm run build && npx playwright test tests/browser/assistant-settings.spec.js tests/browser/assistant-settings-mobile.spec.js tests/browser/assistant-shell.spec.js tests/browser/assistant-proactivity.spec.js && node --test tests/unit/assistant-synced-form-state.test.js`
Expected: PASS (including the existing "remote changed" conflict notice).

- [ ] **Step 7: Commit**

```bash
npx prettier --write web/lib/settings web/components web/features/assistants/useSyncedForm.js web/styles/settings-pattern.css tests/browser/harness tests/browser/settings-pattern-draft.spec.js
npx eslint web/lib/settings web/components web/features/assistants/useSyncedForm.js tests/browser/harness tests/browser/settings-pattern-draft.spec.js
git add web/lib/settings web/components web/features/assistants/useSyncedForm.js web/styles/settings-pattern.css tests/browser/harness tests/browser/settings-pattern-draft.spec.js
git commit -m "feat: save settings tabs as drafts with a save bar and unsaved-changes sheet" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 10: Settings shell

The page frame every redesigned page uses: mobile header (56px, sidebar or back icon, title 15/600, 11px subtitle or slot, optional right action), desktop header (64px, Manrope 700 17px title + 12px description, actions), tabs row, content column max 720 centred, bottom-bar slot.

**Files:**

- Create: `web/components/SettingsShell.jsx`
- Modify: `web/styles/settings-pattern.css` (append)
- Create: `tests/browser/harness/settings-pattern/shell-fixture.js`; Modify: `tests/browser/harness/settings-pattern/main.js`
- Test: `tests/browser/settings-pattern-shell.spec.js`

**Interfaces:**

- Produces: `SettingsShell({ title, subtitle?, description?, leading?: "menu" | "back" | null, onLeading?, leadingLabel?, navigationOpen?, actions?, tabs?, bar?, className?, children })`
  - `leading="menu"` (top-level pages: Accounts, Einstellungen, Erweiterungen, Projekte list) shows the sidebar button on phones only (label `mobileHeaderCopy.iconButtonAriaLabel`, `aria-expanded={navigationOpen}`); `leading="back"` (agent settings, detail pages, subpages) shows the back button on every width (label defaults to `commonCopy.back`; agent settings passes `assistantCopy.backToChat`). Pages pass App's `openNavigation`/`navigationOpen` (as `AssistantHeader` receives them today) for `onLeading`.
  - `subtitle` is text or a node (Extensions passes the profile-switcher button); shown on phones, and on desktop only when there is no `description`.
  - `tabs` is usually `<UnderlineTabs … />`; with tabs the header has no bottom border.
  - `bar` is usually `<SaveBar … />` (or the Projects "Sitzung starten" bar), sticky at the bottom.
  - The title is the page's `<h1>`; groups inside use `GroupLabel` (`h2`).

- [ ] **Step 1: Write the browser spec (fails: fixture missing)**

Create `tests/browser/settings-pattern-shell.spec.js`:

```js
import { test, expect } from "@playwright/test";
import { startSettingsHarness } from "../helpers/settings-pattern-harness.js";

test.describe.configure({ timeout: 90000 });
let harness;
test.beforeAll(async () => {
  harness = await startSettingsHarness();
});
test.afterAll(async () => {
  await harness?.close();
});
const open = (page, query = "") =>
  page.goto(`${harness.url}?fixture=shell${query ? `&${query}` : ""}`);

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("a top-level page shows the sidebar button, title and subtitle", async ({
    page,
  }) => {
    await open(page);
    const heading = page.locator(".settings-shell-heading");
    expect(Math.round((await heading.boundingBox()).height)).toBe(56);
    const menu = page.getByRole("button", { name: "Navigation öffnen" });
    await expect(menu).toHaveAttribute("aria-expanded", "false");
    await menu.click();
    await expect(page.getByTestId("log")).toHaveText("menu");
    await expect(
      page.getByRole("heading", { level: 1, name: "Einstellungen" }),
    ).toBeVisible();
    await expect(page.getByText("Lokal gespeichert")).toBeVisible();
    await expect(page.getByText("Arbeitsbereich, Zugriff und Betrieb")).toBeHidden();
    await expect(page.locator(".settings-shell-header")).toHaveCSS(
      "border-bottom-width",
      "0px",
    );
  });

  test("a subpage shows the back button and the header border without tabs", async ({
    page,
  }) => {
    await open(page, "leading=back&tabs=0");
    await page.getByRole("button", { name: "Zurück" }).click();
    await expect(page.getByTestId("log")).toHaveText("back");
    await expect(page.locator(".settings-shell-header")).toHaveCSS(
      "border-bottom-width",
      "1px",
    );
  });
});

test.describe("desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("the desktop header carries the description and the content is 720px wide", async ({
    page,
  }) => {
    await open(page);
    expect(
      Math.round((await page.locator(".settings-shell-heading").boundingBox()).height),
    ).toBe(64);
    await expect(page.getByRole("button", { name: "Navigation öffnen" })).toBeHidden();
    await expect(page.getByText("Arbeitsbereich, Zugriff und Betrieb")).toBeVisible();
    await expect(page.getByText("Lokal gespeichert")).toBeHidden();
    await expect(page.getByRole("heading", { level: 1 })).toHaveCSS("font-size", "17px");
    const content = await page.locator(".settings-shell-content").boundingBox();
    expect(Math.round(content.width)).toBe(720);
    expect(Math.abs(content.x + content.width / 2 - 640)).toBeLessThanOrEqual(2);
    await expect(page.getByRole("button", { name: "Aktion" })).toBeVisible();
  });
});
```

- [ ] **Step 2: Implement**

`web/components/SettingsShell.jsx`:

```jsx
import React from "react";
import Icon from "./Icon.jsx";
import { commonCopy } from "../lib/i18n/messages/common.js";
import { mobileHeaderCopy } from "../lib/i18n/messages/app.js";

// Header + tabs + content column + bottom bar for settings-like pages.
export default function SettingsShell({
  title,
  subtitle,
  description,
  leading = null,
  onLeading,
  leadingLabel,
  navigationOpen = false,
  actions,
  tabs,
  bar,
  className = "",
  children,
}) {
  const menu = leading === "menu";
  return (
    <div className={["settings-shell", className].filter(Boolean).join(" ")}>
      <header
        className={["settings-shell-header", tabs ? "has-tabs" : ""]
          .filter(Boolean)
          .join(" ")}
      >
        <div className="settings-shell-heading">
          {leading && (
            <button
              type="button"
              className={`settings-shell-leading ${leading}`}
              aria-label={
                leadingLabel ??
                (menu ? mobileHeaderCopy.iconButtonAriaLabel : commonCopy.back)
              }
              aria-expanded={menu ? navigationOpen : undefined}
              onClick={onLeading}
            >
              <Icon name={menu ? "menu" : "back"} />
            </button>
          )}
          <div
            className={["settings-shell-title", description ? "has-description" : ""]
              .filter(Boolean)
              .join(" ")}
          >
            <h1>{title}</h1>
            {subtitle && <div className="settings-shell-subtitle">{subtitle}</div>}
            {description && <p className="settings-shell-description">{description}</p>}
          </div>
          {actions && <div className="settings-shell-actions">{actions}</div>}
        </div>
        {tabs && <div className="settings-shell-tabs">{tabs}</div>}
      </header>
      <div className="settings-shell-body">
        <div className="settings-shell-content">{children}</div>
      </div>
      {bar}
    </div>
  );
}
```

Append to `web/styles/settings-pattern.css`:

```css
.settings-shell {
  display: flex;
  flex-direction: column;
  min-height: 100%;
  background: #101114;
}
.settings-shell-header {
  background: #16171b;
}
.settings-shell-header:not(.has-tabs) {
  border-bottom: 1px solid #28292d;
}
.settings-shell-heading {
  display: flex;
  align-items: center;
  gap: 12px;
  height: 64px;
  padding: 0 24px;
}
.settings-shell-leading {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: 10px;
  color: #e8e8ec;
}
.settings-shell-leading.menu {
  display: none;
}
.settings-shell-title {
  flex: 1;
  min-width: 0;
}
.settings-shell-title h1 {
  overflow: hidden;
  font:
    700 17px/1.3 Manrope,
    "DM Sans",
    sans-serif;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.settings-shell-description,
.settings-shell-subtitle {
  margin-top: 2px;
  font-size: 12px;
  color: #92949d;
}
.settings-shell-title.has-description .settings-shell-subtitle {
  display: none;
}
.settings-shell-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.settings-shell-tabs {
  padding: 0 24px;
}
.settings-shell-body {
  flex: 1;
  padding: 16px 16px 24px;
}
.settings-shell-content {
  width: 100%;
  max-width: 720px;
  margin: 0 auto;
}
@media (max-width: 700px) {
  .settings-shell-heading {
    gap: 8px;
    height: 56px;
    padding: 0 8px;
  }
  .settings-shell-leading.menu {
    display: inline-flex;
  }
  .settings-shell-title h1 {
    font:
      600 15px/1.3 "DM Sans",
      sans-serif;
  }
  .settings-shell-description {
    display: none;
  }
  .settings-shell-title.has-description .settings-shell-subtitle {
    display: block;
  }
  .settings-shell-subtitle {
    margin-top: 0;
    font-size: 11px;
  }
  .settings-shell-tabs {
    padding: 0;
  }
  .settings-shell-body {
    padding: 12px 12px 20px;
  }
}
```

- [ ] **Step 3: Add the shell fixture**

Create `tests/browser/harness/settings-pattern/shell-fixture.js`:

```js
/* global location */
import { createElement as h, useState } from "react";
import SettingsShell from "../../../../web/components/SettingsShell.jsx";
import UnderlineTabs from "../../../../web/components/UnderlineTabs.jsx";

export default function ShellFixture() {
  const query = new URLSearchParams(location.search);
  const [log, setLog] = useState("");
  const [tab, setTab] = useState("workspace");
  return h(
    SettingsShell,
    {
      title: "Einstellungen",
      subtitle: "Lokal gespeichert",
      description: "Arbeitsbereich, Zugriff und Betrieb",
      leading: query.get("leading") || "menu",
      onLeading: () => setLog(query.get("leading") || "menu"),
      actions: h("button", { type: "button", className: "button secondary" }, "Aktion"),
      tabs:
        query.get("tabs") === "0"
          ? null
          : h(UnderlineTabs, {
              label: "Einstellungen",
              tabs: [
                { id: "workspace", label: "Arbeitsbereich" },
                { id: "access", label: "Zugriff" },
                { id: "operations", label: "Betrieb" },
              ],
              selected: tab,
              onSelect: setTab,
              idPrefix: "shell",
            }),
    },
    h("p", null, "Inhalt"),
    h("output", { "data-testid": "log" }, log),
  );
}
```

In `main.js` import `ShellFixture from "./shell-fixture.js"` and add `shell: ShellFixture` to `fixtures`.

- [ ] **Step 4: Run the spec**

Run: `npx playwright test tests/browser/settings-pattern-shell.spec.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
npx prettier --write web/components/SettingsShell.jsx web/styles/settings-pattern.css tests/browser/harness tests/browser/settings-pattern-shell.spec.js
npx eslint web/components/SettingsShell.jsx tests/browser/harness tests/browser/settings-pattern-shell.spec.js
git add web/components/SettingsShell.jsx web/styles/settings-pattern.css tests/browser/harness tests/browser/settings-pattern-shell.spec.js
git commit -m "feat: add the settings page shell" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 11: Save an agent's work settings in one transaction

`PUT /assistants/:id/work` saves workflow access grants and the agent's team policy in one `assistants.store.db` transaction with both revisions as preconditions, keeping the validation and admission rules of `PUT /assistants/:id/access` (eligibility, maintenance, `admit`) and the host-capacity check of `PUT /assistants/:id/team-policy`. The old routes stay. On the client, save-chain steps send the draft's base revision for `PATCH /assistants/:id` and both revisions for the new endpoint.

**Files:**

- Modify: `server/features/assistants/assistant-access.js:64-112` (split `save` into `prepare` + `write`)
- Modify: `server/features/assistants/team-store.js:119-139` (split `savePolicy` into `writePolicy`)
- Create: `server/features/assistants/assistant-work.js`, `server/http/routes/assistant-work.js`
- Modify: `server/http/routes/assistants.js` (import and `router.use(assistantWorkRoutes(services))` next to `assistantTeamRoutes`)
- Modify: `web/features/assistants/assistant-api.js` (add `saveWork`)
- Create: `web/features/assistants/assistant-save-steps.js`
- Test: `tests/blackbox/assistant-work-routes.test.js`, `tests/unit/assistant-save-steps.test.js`

**Interfaces:**

- HTTP: `PUT /api/assistants/:id/work`
  - Request: `{ access?: { revision: number, projectIds: string[], pipelineIds: string[], memoryWrite: boolean, autonomous: boolean, publish: boolean }, team?: { revision: number, autonomous?: boolean, maxMembers?: number, runTimeoutMinutes?: number } }` — at least one part; unknown keys → 400.
  - Response 200: `{ access: <same shape as GET /assistants/:id/access>, team: { revision, autonomous, maxMembers, runTimeoutMinutes } }` (the unchanged part is returned as stored).
  - Errors: 400 `assistants.invalid` (shape/validation), 403 (agent not eligible for access: archived or task-bound member), 409 `assistants.conflict` (either revision stale, or `maxMembers` above host capacity), 409 `assistants.active` (maintenance; team part for a team member), 503 `assistants.unavailable` (workflows/teams not running). Nothing is written unless both parts succeed.
- Server: `AssistantAccess.prepare(id, input, revision) => next`, `AssistantAccess.write(id, next) => next`; `TeamStore.writePolicy(id, input, revision) => policy` (no own transaction); `saveWork({ assistants, access, teams }, id, body) => { access, team }`.
- Client: `assistantApi.saveWork(id, body)`.
- Client steps (`web/features/assistants/assistant-save-steps.js`):
  - `assistantPatchStep({ assistantId, label, keys, body(values) => patch, update = assistantApi.update }) => Step` — `id: "assistant"`, `resource: "assistant"`; sends `{ ...body(values), revision: ctx.revision, ...ctx.confirmations }` (never the latest prop revision); the shell/stdio/restart confirmations of the PATCH come back through the default `confirmationRequest`.
  - `assistantWorkStep({ assistantId, label, keys, access?(values) => accessFields, team?(values) => teamFields, save = assistantApi.saveWork }) => Step` — `id: "work"`; sends `{ access: { revision: ctx.revisions.access, ...access(values) }, team: { revision: ctx.revisions.team, ...team(values) } }` (each part only when its builder is given); `revisions(result) => { access: result.access.revision, team: result.team.revision }`. Draft revisions for the Work tab: `{ access: policy.revision, team: teamPolicy.revision }`.

- [ ] **Step 1: Write the failing blackbox test**

Create `tests/blackbox/assistant-work-routes.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { applicationFixture, enabledAssistants } from "../helpers/application.js";

const access = (revision, changes = {}) => ({
  revision,
  projectIds: [],
  pipelineIds: [],
  memoryWrite: true,
  autonomous: false,
  publish: false,
  ...changes,
});
const team = (revision, changes = {}) => ({
  revision,
  autonomous: true,
  maxMembers: 3,
  runTimeoutMinutes: 15,
  ...changes,
});

test("an agent's work settings save together or not at all", async (t) => {
  const f = await applicationFixture(t, enabledAssistants);
  const a = f.application.assistants;
  const agent = a.store.createAssistant({
    name: "Home",
    instructions: "",
    model: { connectionId: "c", modelId: "m" },
    capabilities: { memory: false, reminders: false },
  });
  const put = (body) =>
    f.request(`/api/assistants/${agent.id}/work`, { method: "PUT", body });
  const stored = async () => ({
    access: await (await f.request(`/api/assistants/${agent.id}/access`)).json(),
    team: a.teams.store.policy(agent.id),
  });

  const saved = await put({ access: access(0), team: team(1) });
  assert.equal(saved.status, 200);
  const body = await saved.json();
  assert.equal(body.access.revision, 1);
  assert.equal(body.access.memoryWrite, true);
  assert.deepEqual(body.team, {
    revision: 2,
    autonomous: true,
    maxMembers: 3,
    runTimeoutMinutes: 15,
  });

  // A stale revision on either part leaves both rows as they are.
  assert.equal(
    (await put({ access: access(0), team: team(2, { maxMembers: 5 }) })).status,
    409,
  );
  assert.equal(
    (await put({ access: access(1, { memoryWrite: false }), team: team(1) })).status,
    409,
  );
  let now = await stored();
  assert.equal(now.access.revision, 1);
  assert.equal(now.access.memoryWrite, true);
  assert.equal(now.team.revision, 2);
  assert.equal(now.team.maxMembers, 3);

  // A valid access part is not written when the team part is invalid.
  assert.equal(
    (
      await put({
        access: access(1, { memoryWrite: false }),
        team: team(2, { maxMembers: 99 }),
      })
    ).status,
    400,
  );
  now = await stored();
  assert.equal(now.access.memoryWrite, true);
  assert.equal(now.access.revision, 1);

  // The host capacity still bounds the team size.
  a.teams.store.saveSettings({ hostMaxConcurrent: 4 }, 1);
  assert.equal((await put({ team: team(2, { maxMembers: 5 }) })).status, 409);

  // One part alone is fine; the other is returned as stored.
  const teamOnly = await put({ team: team(2, { maxMembers: 4 }) });
  assert.equal(teamOnly.status, 200);
  const teamBody = await teamOnly.json();
  assert.equal(teamBody.team.revision, 3);
  assert.equal(teamBody.access.revision, 1);

  assert.equal((await put({})).status, 400);
  assert.equal((await put({ access: access(1), extra: true })).status, 400);
  assert.equal((await put({ access: { ...access(1), revision: "1" } })).status, 400);
  assert.equal(
    (
      await f.request(`/api/assistants/${agent.id}/work`, {
        method: "PUT",
        body: { team: team(3) },
        origin: "https://foreign.invalid",
      })
    ).status,
    403,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test tests/blackbox/assistant-work-routes.test.js`
Expected: FAIL — the first `put` answers 404 (no route).

- [ ] **Step 3: Split access save and team policy save**

In `server/features/assistants/assistant-access.js` replace `save(id, input, revision) { … }` with:

```js
  /** Validates a policy change against `revision`; returns the record, writes nothing. */
  prepare(id, input, revision) {
    this.eligible(id);
    if (this.s.assistants.maintenance) throw assistantProblem("active", 409);
    exact(input, ["projectIds", "pipelineIds", "memoryWrite", "autonomous", "publish"]);
    const old = this.get(id);
    if (old.revision !== revision) throw assistantProblem("conflict", 409);
    for (const key of ["projectIds", "pipelineIds"]) {
      if (
        !Array.isArray(input[key]) ||
        input[key].length > 100 ||
        new Set(input[key]).size !== input[key].length
      )
        throw assistantProblem("invalid");
      for (const value of input[key]) textValue(value, 100);
    }
    for (const key of ["memoryWrite", "autonomous", "publish"])
      if (typeof input[key] !== "boolean") throw assistantProblem("invalid");
    for (const project of input.projectIds) this.s.memory.project(project);
    const definitions = {},
      accountIds = new Set(),
      connectionIds = new Set();
    for (const pipelineId of input.pipelineIds) {
      const def = this.definition(pipelineId);
      definitions[pipelineId] = def.hash;
      for (const p of def.profiles) {
        textValue(p.config.accountId, 100);
        accountIds.add(p.config.accountId);
        if (p.config.providerConnectionId)
          connectionIds.add(p.config.providerConnectionId);
      }
    }
    return {
      ...input,
      revision: revision + 1,
      accountIds: [...accountIds],
      connectionIds: [...connectionIds],
      definitions,
    };
  }
  write(id, next) {
    this.db
      .prepare(
        "INSERT INTO assistant_access VALUES(?,?) ON CONFLICT(assistant_id) DO UPDATE SET body=excluded.body",
      )
      .run(id, JSON.stringify(next));
    return next;
  }
  save(id, input, revision) {
    const next = this.write(id, this.prepare(id, input, revision));
    this.s.assistants.changed();
    return next;
  }
```

(The body of `prepare` is the existing validation of `save`, unchanged.)

In `server/features/assistants/team-store.js` replace `savePolicy(id, input, revision) { return this.transaction(() => { … }); }` with:

```js
  /** savePolicy without its own transaction, for a caller that already holds one. */
  writePolicy(id, input, revision) {
    const a = this.store.getAssistant(id);
    if (a.teamMemberId) throw assistantProblem("active", 409);
    const current = this.policy(id);
    if (current.revision !== revision) throw assistantProblem("conflict", 409);
    const values = normalizeTeamPolicy(input, current);
    if (values.maxMembers > this.settings().hostMaxConcurrent)
      throw assistantProblem("conflict", 409);
    const old = this.find(`policy:${id}`);
    if (old) this.write(old, values);
    else
      this.insert({
        ...values,
        id: `policy:${id}`,
        kind: "policy",
        parentAssistantId: id,
        revision: 2,
      });
    return this.policy(id);
  }
  savePolicy(id, input, revision) {
    return this.transaction(() => this.writePolicy(id, input, revision));
  }
```

- [ ] **Step 4: Add the work service and route**

Create `server/features/assistants/assistant-work.js`:

```js
import { assistantProblem } from "./assistant-validation.js";
import { exact } from "./assistant-access.js";

function part(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw assistantProblem("invalid");
  const { revision, ...input } = value;
  if (!Number.isSafeInteger(revision)) throw assistantProblem("invalid");
  return { revision, input };
}

/**
 * Saves an agent's workflow access and team policy as one change: both revisions are
 * preconditions and both rows are written in one transaction of the agent database,
 * so a refused part leaves the other unchanged.
 */
export function saveWork({ assistants, access, teams }, id, body) {
  exact(body, ["access", "team"]);
  if (!body.access && !body.team) throw assistantProblem("invalid");
  if (assistants.maintenance) throw assistantProblem("active", 409);
  const accessPart = body.access ? part(body.access) : null;
  const teamPart = body.team ? part(body.team) : null;
  const result = teams.transaction(() => {
    const next = accessPart
      ? access.prepare(id, accessPart.input, accessPart.revision)
      : null;
    const team = teamPart
      ? teams.writePolicy(id, teamPart.input, teamPart.revision)
      : teams.policy(id);
    if (next) access.write(id, next);
    return { access: next || access.get(id), team };
  });
  assistants.changed();
  return result;
}
```

Create `server/http/routes/assistant-work.js`:

```js
import { Router } from "express";
import { assistantProblem } from "../../features/assistants/assistant-validation.js";
import { saveWork } from "../../features/assistants/assistant-work.js";

// The agent settings "Work" tab: workflow access and team policy in one save.
export function assistantWorkRoutes({ assistants }) {
  const router = Router();
  router.put("/assistants/:id/work", (req, res) =>
    assistants.admit(() => {
      if (!assistants.workflows || !assistants.teams)
        throw assistantProblem("unavailable", 503);
      res.json(
        saveWork(
          {
            assistants,
            access: assistants.workflows.access,
            teams: assistants.teams.store,
          },
          req.params.id,
          req.body,
        ),
      );
    }),
  );
  return router;
}
```

In `server/http/routes/assistants.js` add `import { assistantWorkRoutes } from "./assistant-work.js";` and, after `router.use(assistantTeamRoutes(services));`, `router.use(assistantWorkRoutes(services));`.

- [ ] **Step 5: Run the server tests**

Run: `node --test tests/blackbox/assistant-work-routes.test.js tests/blackbox/assistant-team-routes.test.js tests/blackbox/assistant-workflow-routes.test.js tests/integration/assistant-workflows.test.js`
Expected: PASS. If the 403 origin case answers differently, check `tests/blackbox/assistant-team-routes.test.js` (it expects 403 for a foreign origin on a POST) and align only the expectation, not the route.

- [ ] **Step 6: Write the failing client step test**

Create `tests/unit/assistant-save-steps.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  assistantPatchStep,
  assistantWorkStep,
} from "../../web/features/assistants/assistant-save-steps.js";
import { runSaveChain } from "../../web/lib/settings/save-chain.js";

test("the agent patch step sends the draft's base revision and confirmation flags", async () => {
  const sent = [];
  const step = assistantPatchStep({
    assistantId: "a1",
    label: "Fähigkeiten",
    keys: ["shell"],
    body: (values) => ({ shell: values.shell }),
    update: async (id, input) => {
      sent.push([id, input]);
      if (!input.confirmShell)
        throw Object.assign(new Error("confirm"), {
          status: 409,
          code: "ASSISTANT_SHELL_CONFIRMATION_REQUIRED",
          required: ["confirmShell"],
        });
      return { revision: input.revision + 1 };
    },
  });
  const result = await runSaveChain({
    steps: [step],
    values: { shell: "approval" },
    base: { shell: "off" },
    revisions: { assistant: 4 },
    ask: async () => true,
  });
  assert.equal(result.status, "saved");
  assert.deepEqual(sent, [
    ["a1", { shell: "approval", revision: 4 }],
    ["a1", { shell: "approval", revision: 4, confirmShell: true }],
  ]);
  assert.equal(result.revisions.assistant, 5);
});

test("the work step sends both revisions and adopts both from the response", async () => {
  const sent = [];
  const step = assistantWorkStep({
    assistantId: "a1",
    label: "Arbeit",
    keys: ["projectIds", "maxMembers"],
    access: (values) => ({
      projectIds: values.projectIds,
      pipelineIds: [],
      memoryWrite: false,
      autonomous: false,
      publish: false,
    }),
    team: (values) => ({ maxMembers: values.maxMembers }),
    save: async (id, body) => {
      sent.push([id, body]);
      return {
        access: { revision: body.access.revision + 1 },
        team: { revision: body.team.revision + 1 },
      };
    },
  });
  const result = await runSaveChain({
    steps: [step],
    values: { projectIds: ["p"], maxMembers: 5 },
    base: { projectIds: [], maxMembers: 4 },
    revisions: { access: 2, team: 7 },
  });
  assert.equal(result.status, "saved");
  assert.equal(sent[0][1].access.revision, 2);
  assert.equal(sent[0][1].team.revision, 7);
  assert.deepEqual(result.revisions, { access: 3, team: 8 });
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `node --test tests/unit/assistant-save-steps.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 8: Implement the client side**

In `web/features/assistants/assistant-api.js`, after `teamSettings: …`, add:

```js
  saveWork: (id, input) =>
    api(`/assistants/${encodeURIComponent(id)}/work`, "PUT", input),
```

Create `web/features/assistants/assistant-save-steps.js`:

```js
import { assistantApi } from "./assistant-api.js";

/**
 * Save-chain steps for agent settings (docs/settings-pattern.md). Each sends the
 * revision the draft started from, never the latest one from props, so a change made
 * elsewhere is reported as a conflict instead of being overwritten.
 */
export function assistantPatchStep({
  assistantId,
  label,
  keys,
  body,
  update = assistantApi.update,
}) {
  return {
    id: "assistant",
    label,
    keys,
    resource: "assistant",
    run: ({ values, revision, confirmations }) =>
      update(assistantId, { ...body(values), revision, ...confirmations }),
  };
}

export function assistantWorkStep({
  assistantId,
  label,
  keys,
  access,
  team,
  save = assistantApi.saveWork,
}) {
  return {
    id: "work",
    label,
    keys,
    run: ({ values, revisions }) =>
      save(assistantId, {
        ...(access ? { access: { revision: revisions.access, ...access(values) } } : {}),
        ...(team ? { team: { revision: revisions.team, ...team(values) } } : {}),
      }),
    revisions: (result) => ({
      access: result.access.revision,
      team: result.team.revision,
    }),
  };
}
```

- [ ] **Step 9: Run the tests**

Run: `node --test tests/unit/assistant-save-steps.test.js tests/blackbox/assistant-work-routes.test.js`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
npx prettier --write server/features/assistants/assistant-access.js server/features/assistants/team-store.js server/features/assistants/assistant-work.js server/http/routes/assistant-work.js server/http/routes/assistants.js web/features/assistants/assistant-api.js web/features/assistants/assistant-save-steps.js tests/blackbox/assistant-work-routes.test.js tests/unit/assistant-save-steps.test.js
npx eslint server/features/assistants server/http/routes web/features/assistants tests/blackbox/assistant-work-routes.test.js tests/unit/assistant-save-steps.test.js
git add server web/features/assistants tests/blackbox/assistant-work-routes.test.js tests/unit/assistant-save-steps.test.js
git commit -m "feat: save an agent's work access and team policy in one transaction" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 12: Settings summary endpoint

`GET /settings/summary` feeds the row statuses of the Zugriff and Betrieb tabs. It only reads local state (no doctor run, no release check over the network); each part is `null` when its source is missing or fails.

**Files:**

- Modify: `server/features/operations/releases.js` (add `lastCheck()` after `status()`)
- Create: `server/features/settings/settings-summary.js`, `server/http/routes/settings-summary.js`
- Modify: `server/app.js` (import; `mount(settingsSummaryRoutes(services));` after `mount(remoteRoutes(services));`)
- Test: `tests/unit/settings-summary.test.js`, `tests/blackbox/settings-summary-routes.test.js`

**Interfaces:**

- HTTP: `GET /api/settings/summary` (login required, `Cache-Control: no-store`) →

```json
{
  "access": {
    "mcp": { "available": true, "activeGrants": 2 },
    "remote": { "tailscale": false, "network": true },
    "ssh": { "count": 3 },
    "github": { "count": 1 }
  },
  "operations": {
    "diagnostics": {
      "generatedAt": "2026-10-12T08:00:00.000Z",
      "failed": 0,
      "warnings": 2
    },
    "backups": { "count": 4, "lastAt": "2026-10-11T22:00:00.000Z" },
    "updates": { "current": "1.28.1", "checked": true, "available": "1.29.0" }
  }
}
```

Every leaf object may be `null` (source missing, unreadable, or — for `diagnostics` — never run). `backups.lastAt` is `null` with `count: 0`. `updates.available` is `null` when the last check found nothing newer or no check ran (`checked: false`); it comes from the cached last check (`candidate.json`), never from the network. `activeGrants` counts MCP OAuth grants that are neither revoked nor expired. `github.count` counts all repository credentials (the "GitHub-Zugänge" page lists every host).

- Server: `settingsSummary(services, now = Date.now())`, `Releases.lastCheck() => candidate | null`.

- [ ] **Step 1: Write the failing unit test**

Create `tests/unit/settings-summary.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { settingsSummary } from "../../server/features/settings/settings-summary.js";

const now = Date.parse("2026-10-12T12:00:00Z");
const grants = [
  { revokedAt: null, expiresAt: "2026-11-01T00:00:00Z" },
  { revokedAt: "2026-10-01T00:00:00Z", expiresAt: null },
  { revokedAt: null, expiresAt: "2026-10-01T00:00:00Z" },
  { revokedAt: null, expiresAt: null },
];
const services = {
  mcpAccess: {
    status: () => ({ available: true }),
    listGrants: ({ offset, limit }) => ({
      grants: grants.slice(offset, offset + Math.min(limit, 3)),
      total: grants.length,
    }),
  },
  effectiveConfig: () => ({
    remoteUrl: "https://host.ts.net",
    network: { enabled: false },
  }),
  sshAccesses: { list: () => [{ id: "a" }, { id: "b" }] },
  repositories: { listCredentials: () => [{ id: "g" }] },
  operations: {
    report: () => ({
      generatedAt: "2026-10-12T08:00:00Z",
      checks: [
        { status: "ok" },
        { status: "fail" },
        { status: "warn" },
        { status: "skip" },
      ],
    }),
    backup: {
      list: () => [{ createdAt: "2026-10-11T22:00:00Z" }, { createdAt: "2026-10-01" }],
    },
    releases: {
      status: () => ({ current: "1.28.1" }),
      lastCheck: () => ({ version: "1.29.0", upToDate: false }),
    },
  },
};

test("the summary reports every row from local state", () => {
  assert.deepEqual(settingsSummary(services, now), {
    access: {
      mcp: { available: true, activeGrants: 2 },
      remote: { tailscale: true, network: false },
      ssh: { count: 2 },
      github: { count: 1 },
    },
    operations: {
      diagnostics: { generatedAt: "2026-10-12T08:00:00Z", failed: 1, warnings: 1 },
      backups: { count: 2, lastAt: "2026-10-11T22:00:00Z" },
      updates: { current: "1.28.1", checked: true, available: "1.29.0" },
    },
  });
});

test("missing or failing sources are null, never a made-up zero", () => {
  const summary = settingsSummary(
    {
      ...services,
      mcpAccess: undefined,
      sshAccesses: {
        list: () => {
          throw new Error("unreadable");
        },
      },
      operations: {
        ...services.operations,
        report: () => null,
        backup: { list: () => [] },
        releases: {
          status: () => ({ current: "1.29.0" }),
          lastCheck: () => ({ version: "1.29.0" }),
        },
      },
    },
    now,
  );
  assert.equal(summary.access.mcp, null);
  assert.equal(summary.access.ssh, null);
  assert.equal(summary.operations.diagnostics, null);
  assert.deepEqual(summary.operations.backups, { count: 0, lastAt: null });
  assert.deepEqual(summary.operations.updates, {
    current: "1.29.0",
    checked: true,
    available: null,
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/unit/settings-summary.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement**

In `server/features/operations/releases.js`, add after `status() { … }`:

```js
  /** The last update check's result, cached by check(); null before the first one. */
  lastCheck() {
    return readJson(path.join(this.directory, "candidate.json"), null);
  }
```

Create `server/features/settings/settings-summary.js`:

```js
import { compareReleaseVersions } from "../operations/version.js";

// Row statuses for the settings tabs. Only local state is read: no diagnostics run
// and no network update check. A part that cannot be read is null, never a zero.
const attempt = (read) => {
  try {
    return read() ?? null;
  } catch {
    return null;
  }
};

function activeGrants(mcpAccess, now) {
  let offset = 0;
  let active = 0;
  for (;;) {
    const page = mcpAccess.listGrants({ offset, limit: 100 });
    for (const grant of page.grants)
      if (
        !grant.revokedAt &&
        (!grant.expiresAt || new Date(grant.expiresAt).getTime() > now)
      )
        active++;
    offset += page.grants.length;
    if (!page.grants.length || offset >= page.total) return active;
  }
}

function updates(releases) {
  const { current } = releases.status();
  const last = releases.lastCheck();
  return {
    current: current ?? null,
    checked: Boolean(last),
    available:
      last?.version && current && compareReleaseVersions(last.version, current) > 0
        ? last.version
        : null,
  };
}

export function settingsSummary(services, now = Date.now()) {
  const { mcpAccess, effectiveConfig, sshAccesses, repositories, operations } = services;
  return {
    access: {
      mcp: attempt(
        () =>
          mcpAccess && {
            available: Boolean(mcpAccess.status().available),
            activeGrants: activeGrants(mcpAccess, now),
          },
      ),
      remote: attempt(() => {
        const config = effectiveConfig?.();
        return (
          config && {
            tailscale: Boolean(config.remoteUrl),
            network: Boolean(config.network?.enabled),
          }
        );
      }),
      ssh: attempt(() => sshAccesses && { count: sshAccesses.list().length }),
      github: attempt(
        () => repositories && { count: repositories.listCredentials().length },
      ),
    },
    operations: {
      diagnostics: attempt(() => {
        const report = operations?.report();
        return (
          report && {
            generatedAt: report.generatedAt,
            failed: report.checks.filter((check) => check.status === "fail").length,
            warnings: report.checks.filter((check) => check.status === "warn").length,
          }
        );
      }),
      backups: attempt(() => {
        const list = operations?.backup.list();
        return list && { count: list.length, lastAt: list[0]?.createdAt ?? null };
      }),
      updates: attempt(() => operations?.releases && updates(operations.releases)),
    },
  };
}
```

Create `server/http/routes/settings-summary.js`:

```js
import { Router } from "express";
import { settingsSummary } from "../../features/settings/settings-summary.js";

export function settingsSummaryRoutes(services) {
  const router = Router();
  router.get("/settings/summary", (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(settingsSummary(services));
  });
  return router;
}
```

In `server/app.js` add `import { settingsSummaryRoutes } from "./http/routes/settings-summary.js";` with the other route imports and `mount(settingsSummaryRoutes(services));` after `mount(remoteRoutes(services));`.

- [ ] **Step 4: Run the unit test**

Run: `node --test tests/unit/settings-summary.test.js`
Expected: PASS.

- [ ] **Step 5: Write the blackbox test**

Create `tests/blackbox/settings-summary-routes.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { applicationFixture } from "../helpers/application.js";

test("the settings summary reads local state and needs a login", async (t) => {
  const f = await applicationFixture(t);
  assert.equal((await fetch(`${f.url}/api/settings/summary`)).status, 401);
  const first = await f.request("/api/settings/summary");
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("cache-control"), "no-store");
  const summary = await first.json();
  assert.deepEqual(summary.access.ssh, { count: 0 });
  assert.deepEqual(summary.access.github, { count: 0 });
  assert.deepEqual(summary.access.remote, { tailscale: false, network: false });
  assert.equal(typeof summary.access.mcp.activeGrants, "number");
  assert.equal(summary.operations.diagnostics, null);
  assert.deepEqual(summary.operations.backups, { count: 0, lastAt: null });
  assert.equal(summary.operations.updates.checked, false);
  assert.equal(summary.operations.updates.available, null);
  assert.equal(typeof summary.operations.updates.current, "string");

  // A cached update check with a newer version shows as available.
  const releases = f.application.operations.releases;
  fs.writeFileSync(
    path.join(releases.directory, "candidate.json"),
    JSON.stringify({ version: "999.0.0", upToDate: false }),
  );
  const checked = await (await f.request("/api/settings/summary")).json();
  assert.deepEqual(checked.operations.updates, {
    current: summary.operations.updates.current,
    checked: true,
    available: "999.0.0",
  });
});
```

- [ ] **Step 6: Run it**

Run: `npm run build && node --test tests/blackbox/settings-summary-routes.test.js`
Expected: PASS. (If `remote` reports `network: true` in the fixture because of a fixture default, assert `typeof … === "boolean"` instead; the unit test pins the mapping.)

- [ ] **Step 7: Commit**

```bash
npx prettier --write server/features/operations/releases.js server/features/settings/settings-summary.js server/http/routes/settings-summary.js server/app.js tests/unit/settings-summary.test.js tests/blackbox/settings-summary-routes.test.js
npx eslint server tests/unit/settings-summary.test.js tests/blackbox/settings-summary-routes.test.js
git add server tests/unit/settings-summary.test.js tests/blackbox/settings-summary-routes.test.js
git commit -m "feat: summarize access and operations status for the settings tabs" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 13: Accounts usage endpoint

`GET /accounts/usage` answers "Genutzt von" for every entry on the Accounts page. It reads the agent store only when the agents feature is enabled and running, so `/accounts` stays free of assistant requests and assistant services when agents are off.

**Files:**

- Create: `server/features/accounts/account-usage.js`
- Modify: `server/http/routes/accounts.js` (register `GET /accounts/usage` as the first route)
- Test: `tests/unit/account-usage.test.js`, `tests/blackbox/account-usage-routes.test.js`

**Interfaces:**

- HTTP: `GET /api/accounts/usage` (login required, `Cache-Control: no-store`) →

```json
{
  "agentsEnabled": true,
  "connections": { "<providerConnectionId>": "Usage" },
  "chatgpt": { "openclaw:<hash>": "Usage" },
  "mcpServers": { "<serverId>": "Usage" },
  "webSearch": "Usage | null",
  "speech": "Usage | null",
  "cliAccounts": { "<accountId>": "Usage" }
}
```

where `Usage = { agents: [{ id, name, kind: "agent" | "teamMember", via: "model" | "pipelines" | "binding" | "capability" | "channel" }], sessions: number, pipelineProfiles: [{ id, name }], clis: [{ tool: "codex" | "claude" | "opencode", route: { mode, source } | null }] }`.

- `connections` has an entry for every provider connection (also unused ones); `clis` lists the connection's compatible CLIs (`tools`) with the endpoint route from `toolRoutes` (null for non-endpoint providers). Agents use it `via: "model"` (their model) or `via: "pipelines"` (workflow grants whose pipelines run on it); sessions count stored sessions with `access.providerConnectionId`.
- `chatgpt` has an entry for every ChatGPT account referenced by an agent's model (`openclaw:` ids). The Accounts page joins it with `/assistant-model-accounts`.
- `mcpServers` has an entry for every central server; `clis` are the CLIs it is bound to (`route: null`); agents are bound `via: "binding"`.
- `webSearch`: agents with the web search capability (`via: "capability"`); `speech`: agents with a Telegram channel (`via: "channel"`, voice messages are transcribed there). Both `null` when agents are off.
- `cliAccounts` has an entry for every native CLI account (`accounts.list()`, including `local-*`); sessions count `access.sourceAccountId ?? accountId`; pipeline profiles by `config.accountId`; agents `via: "pipelines"`.
- Archived agents are left out; temporary team members appear with `kind: "teamMember"`.
- With agents off: `agentsEnabled: false`, every `agents` list empty, `chatgpt: {}`, `webSearch: null`, `speech: null`; no assistant service is touched.
- Server: `usageSources(services) => Promise<Sources>`, `summarizeUsage(sources) => Usage map` (pure), `accountUsage(services) => Promise<response>`.

- [ ] **Step 1: Write the failing unit test**

Create `tests/unit/account-usage.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { summarizeUsage } from "../../server/features/accounts/account-usage.js";

const home = {
  id: "home",
  name: "Home",
  model: { connectionId: "router", modelId: "m" },
  capabilities: { webSearch: true },
};
const chat = {
  id: "chat",
  name: "Chat",
  model: { connectionId: `openclaw:${"a".repeat(64)}`, modelId: "gpt" },
  capabilities: {},
};
const member = {
  id: "member",
  name: "Reviewer",
  teamMemberId: "t1",
  lifetime: "task",
  model: { connectionId: "router", modelId: "m" },
  capabilities: { webSearch: true },
};
const sources = {
  agentsEnabled: true,
  connections: [
    {
      id: "router",
      tools: ["claude", "codex"],
      toolRoutes: { claude: { mode: "adapter", source: "x" }, codex: null },
    },
    { id: "unused", tools: ["opencode"] },
  ],
  accounts: [{ id: "local-codex" }, { id: "work" }],
  sessions: [
    {
      accountId: "internal-1",
      access: { providerConnectionId: "router", sourceAccountId: "work" },
    },
    { accountId: "work" },
    { accountId: "local-codex" },
  ],
  profiles: [
    {
      id: "p1",
      name: "Coder",
      config: { accountId: "work", providerConnectionId: "router" },
    },
  ],
  servers: [
    { id: "github", clis: ["codex"] },
    { id: "idle", clis: [] },
  ],
  agents: [home, chat, member],
  access: { home: { connectionIds: ["router"], accountIds: ["work"] } },
  agentServers: { home: ["github"], chat: ["github", "deleted"] },
  channels: [{ assistantId: "chat" }],
};

test("usage names agents, sessions, profiles and CLI routes per entry", () => {
  const usage = summarizeUsage(sources);
  assert.deepEqual(usage.connections.router, {
    agents: [
      { id: "home", name: "Home", kind: "agent", via: "model" },
      { id: "home", name: "Home", kind: "agent", via: "pipelines" },
      { id: "member", name: "Reviewer", kind: "teamMember", via: "model" },
    ],
    sessions: 1,
    pipelineProfiles: [{ id: "p1", name: "Coder" }],
    clis: [
      { tool: "claude", route: { mode: "adapter", source: "x" } },
      { tool: "codex", route: null },
    ],
  });
  assert.deepEqual(usage.connections.unused, {
    agents: [],
    sessions: 0,
    pipelineProfiles: [],
    clis: [{ tool: "opencode", route: null }],
  });
  assert.deepEqual(usage.chatgpt[chat.model.connectionId].agents, [
    { id: "chat", name: "Chat", kind: "agent", via: "model" },
  ]);
  assert.equal(usage.cliAccounts.work.sessions, 2);
  assert.equal(usage.cliAccounts["local-codex"].sessions, 1);
  assert.deepEqual(usage.cliAccounts.work.pipelineProfiles, [
    { id: "p1", name: "Coder" },
  ]);
  assert.deepEqual(usage.cliAccounts.work.agents, [
    { id: "home", name: "Home", kind: "agent", via: "pipelines" },
  ]);
  assert.deepEqual(
    usage.mcpServers.github.agents.map((a) => a.id),
    ["home", "chat"],
  );
  assert.deepEqual(usage.mcpServers.github.clis, [{ tool: "codex", route: null }]);
  assert.deepEqual(usage.mcpServers.idle.agents, []);
  assert.deepEqual(
    usage.webSearch.agents.map((a) => a.id),
    ["home"],
  );
  assert.deepEqual(usage.speech.agents, [
    { id: "chat", name: "Chat", kind: "agent", via: "channel" },
  ]);
});

test("without agents the usage lists only sessions, profiles and CLIs", () => {
  const usage = summarizeUsage({
    ...sources,
    agentsEnabled: false,
    agents: [],
    access: {},
    agentServers: {},
    channels: [],
  });
  assert.equal(usage.agentsEnabled, false);
  assert.equal(usage.webSearch, null);
  assert.equal(usage.speech, null);
  assert.deepEqual(usage.chatgpt, {});
  assert.deepEqual(usage.connections.router.agents, []);
  assert.equal(usage.connections.router.sessions, 1);
});
```

Note: `member` is a task-bound member, so `personalCapabilities` reports no web search for it (only eligible profiles count).

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/unit/account-usage.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement**

Create `server/features/accounts/account-usage.js`:

```js
import { personalCapabilities } from "../assistants/native-capabilities.js";
import { temporaryMember } from "../assistants/team-presentation.js";

// "Used by" for the Accounts page. Agent data is read only while the agents feature
// runs, so the page stays free of agent services when agents are off.
const usage = () => ({ agents: [], sessions: 0, pipelineProfiles: [], clis: [] });
const entry = (map, id) =>
  typeof id === "string" && Object.hasOwn(map, id) ? map[id] : null;
const safe = (read, fallback) => {
  try {
    return read() ?? fallback;
  } catch {
    return fallback;
  }
};

function addAgent(target, profile, via) {
  if (!target || target.agents.some((a) => a.id === profile.id && a.via === via)) return;
  target.agents.push({
    id: profile.id,
    name: profile.name,
    kind: temporaryMember(profile) ? "teamMember" : "agent",
    via,
  });
}

export async function usageSources(services) {
  const assistants =
    services.assistantFeature?.enabled && services.assistants
      ? services.assistants
      : null;
  const agents = assistants
    ? assistants.store.listAssistants().filter((profile) => !profile.archivedAt)
    : [];
  const central = services.mcpServers;
  const bindings = services.assistantMcpServers || central;
  return {
    agentsEnabled: Boolean(assistants),
    connections: safe(() => services.providerConnections.list(), []),
    accounts: safe(() => services.accounts.list(), []),
    sessions: (await services.sessions?.list().catch(() => [])) ?? [],
    profiles: safe(() => services.pipelineDefinitions.listProfiles(), []),
    servers: safe(
      () =>
        central
          .list()
          .map((server) => ({ id: server.id, clis: central.targetsOf(server.id).clis })),
      [],
    ),
    agents,
    access: Object.fromEntries(
      agents.map((a) => [a.id, safe(() => assistants.workflows?.access.get(a.id), null)]),
    ),
    agentServers: Object.fromEntries(
      agents.map((a) => [a.id, safe(() => bindings.bindings("agent", a.id), [])]),
    ),
    channels: assistants ? safe(() => services.assistantChannels?.store.list(), []) : [],
  };
}

export function summarizeUsage(sources) {
  const connections = Object.fromEntries(
    sources.connections.map((c) => [
      c.id,
      {
        ...usage(),
        clis: (c.tools || []).map((tool) => ({
          tool,
          route: c.toolRoutes?.[tool] ?? null,
        })),
      },
    ]),
  );
  const cliAccounts = Object.fromEntries(sources.accounts.map((a) => [a.id, usage()]));
  const mcpServers = Object.fromEntries(
    sources.servers.map((s) => [
      s.id,
      { ...usage(), clis: s.clis.map((tool) => ({ tool, route: null })) },
    ]),
  );
  const chatgpt = {};
  for (const session of sources.sessions) {
    const connection = entry(connections, session.access?.providerConnectionId);
    if (connection) connection.sessions++;
    const account = entry(
      cliAccounts,
      session.access?.sourceAccountId ?? session.accountId,
    );
    if (account) account.sessions++;
  }
  for (const profile of sources.profiles) {
    const ref = { id: profile.id, name: profile.name };
    entry(connections, profile.config?.providerConnectionId)?.pipelineProfiles.push(ref);
    entry(cliAccounts, profile.config?.accountId)?.pipelineProfiles.push(ref);
  }
  const webSearch = sources.agentsEnabled ? usage() : null;
  const speech = sources.agentsEnabled ? usage() : null;
  const byId = new Map(sources.agents.map((agent) => [agent.id, agent]));
  for (const agent of sources.agents) {
    const model = agent.model?.connectionId;
    if (typeof model === "string" && model.startsWith("openclaw:"))
      addAgent((chatgpt[model] ||= usage()), agent, "model");
    else addAgent(entry(connections, model), agent, "model");
    const access = sources.access[agent.id];
    for (const id of access?.connectionIds || [])
      addAgent(entry(connections, id), agent, "pipelines");
    for (const id of access?.accountIds || [])
      addAgent(entry(cliAccounts, id), agent, "pipelines");
    for (const id of sources.agentServers[agent.id] || [])
      addAgent(entry(mcpServers, id), agent, "binding");
    if (personalCapabilities(agent).webSearch) addAgent(webSearch, agent, "capability");
  }
  for (const channel of sources.channels) {
    const agent = byId.get(channel.assistantId);
    if (agent) addAgent(speech, agent, "channel");
  }
  return {
    agentsEnabled: sources.agentsEnabled,
    connections,
    chatgpt,
    mcpServers,
    webSearch,
    speech,
    cliAccounts,
  };
}

export const accountUsage = async (services) =>
  summarizeUsage(await usageSources(services));
```

In `server/http/routes/accounts.js`, add the import and register the route before `router.get("/accounts/:id/auth-status", …)`:

```js
import { accountUsage } from "../../features/accounts/account-usage.js";
```

```js
// Registered first so an `/accounts/:id` read can never shadow it.
router.get("/accounts/usage", async (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json(await accountUsage(services));
});
```

- [ ] **Step 4: Run the unit test**

Run: `node --test tests/unit/account-usage.test.js`
Expected: PASS.

- [ ] **Step 5: Write the blackbox test**

Create `tests/blackbox/account-usage-routes.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { applicationFixture, enabledAssistants } from "../helpers/application.js";

test("accounts usage leaves agent services alone while agents are off", async (t) => {
  const f = await applicationFixture(t);
  assert.equal((await fetch(`${f.url}/api/accounts/usage`)).status, 401);
  const response = await f.request("/api/accounts/usage");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const usage = await response.json();
  assert.equal(usage.agentsEnabled, false);
  assert.equal(usage.webSearch, null);
  assert.equal(usage.speech, null);
  assert.deepEqual(usage.chatgpt, {});
  assert.ok(usage.cliAccounts["local-codex"]);
  assert.equal(usage.cliAccounts["local-codex"].sessions, 0);
  assert.equal(f.application.assistants, null);
});

test("accounts usage names the agents that use an account", async (t) => {
  const f = await applicationFixture(t, enabledAssistants);
  const chatgpt = `openclaw:${"b".repeat(64)}`;
  const agent = f.application.assistants.store.createAssistant({
    name: "Home",
    instructions: "",
    model: { connectionId: chatgpt, modelId: "gpt" },
    capabilities: { memory: false, reminders: false },
  });
  const usage = await (await f.request("/api/accounts/usage")).json();
  assert.equal(usage.agentsEnabled, true);
  assert.deepEqual(usage.chatgpt[chatgpt].agents, [
    { id: agent.id, name: "Home", kind: "agent", via: "model" },
  ]);
  assert.deepEqual(usage.webSearch.agents, []);
});
```

- [ ] **Step 6: Run it and the agents-off browser spec**

Run: `npm run build && node --test tests/blackbox/account-usage-routes.test.js && npx playwright test tests/browser/assistant-feature.spec.js tests/browser/account-defaults.spec.js`
Expected: PASS. (`f.application.assistants` is `null` while the feature is off: `server/application/assistants.js` sets every assistant service name to null. If the getter returns `undefined` instead, assert `!f.application.assistants`.)

- [ ] **Step 7: Commit**

```bash
npx prettier --write server/features/accounts/account-usage.js server/http/routes/accounts.js tests/unit/account-usage.test.js tests/blackbox/account-usage-routes.test.js
npx eslint server/features/accounts server/http/routes/accounts.js tests/unit/account-usage.test.js tests/blackbox/account-usage-routes.test.js
git add server/features/accounts server/http/routes/accounts.js tests/unit/account-usage.test.js tests/blackbox/account-usage-routes.test.js
git commit -m "feat: report which agents, sessions and profiles use each account" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 14: Settings pattern guide and full verification

A lasting guide for the five page steps and later work (not under `docs/superpowers/`), then the full gate.

**Files:**

- Create: `docs/settings-pattern.md`
- Modify: `docs/architecture.md` (pointer section after "## Boundaries"), `web/README.md` (components bullet)

**Interfaces:**

- Consumes: everything produced by Tasks 1–13 (names must match exactly).

- [ ] **Step 1: Write the guide**

Create `docs/settings-pattern.md`:

````markdown
# Settings pattern

Agent settings, Accounts, Einstellungen, Erweiterungen and Projekte share one pattern:
a header with underline tabs, grouped list cards, one bottom save bar per tab or
subpage, hints behind ⓘ, central settings as dashed reference rows into Accounts, and
"Used by" lists in Accounts. This guide names the building blocks and their contracts.

## Components (`web/components/`, styles in `web/styles/settings-pattern.css`)

| Component                                                        | Use                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SettingsShell`                                                  | Page frame: mobile header 56px (sidebar `leading="menu"` on top-level pages, `leading="back"` on detail pages and subpages), desktop header 64px with description and actions, `tabs` row, content column max 720px, `bar` slot.    |
| `UnderlineTabs`                                                  | Tabs; fill the row on phones, scroll with a 48px edge fade (`can-scroll-left/right`) when they do not fit, keep the active tab in view via `scrollLeft`, hover arrows on desktop. Counts render as `<small>`.                       |
| `GroupLabel`                                                     | Uppercase group label with optional ⓘ hint and a right text action ("+ …").                                                                                                                                                         |
| `ListCard`                                                       | Card of rows (1px gap dividers); `disabled` dims a group that does not apply yet.                                                                                                                                                   |
| `ListRow`                                                        | Row with `label`/`sub`, right side `value` (use `unknownValue` "—" until known), `status` (`ok`/`warn`/`error`), chevron when it navigates (`onClick`/`href`), ⋯ `menu`, trash `onDelete`, optional `hint`.                         |
| `ToggleRow`, `NumberRow`, `SelectRow`, `RadioRow`, `CheckboxRow` | Control rows (switch 38×22 as `<input type="checkbox" role="switch">`, number 64×34, native select, radio, checkbox with optional pill such as "stdio").                                                                            |
| `Segmented`                                                      | Segmented choice (shell level, Aktiv/Archiv, Sitzungen/Nachrichten).                                                                                                                                                                |
| `InfoHint` (`useInfoHint`, `InfoHintButton`, `InfoHintText`)     | ⓘ disclosure: `aria-expanded` + `aria-controls`, inserts the hint text verbatim below the row or label. Never a tooltip.                                                                                                            |
| `ReferenceRow`                                                   | Dashed row "Managed centrally in Accounts" (or a count) linking to `{ view: "accounts", section, item }`.                                                                                                                           |
| `SaveBar`                                                        | Visible while the draft is dirty, saving, or reports an error, conflict or partial save. Cancel + primary (specific label where one exists); in a conflict "Reload" + "Overwrite anyway". Optional `note` such as a restart notice. |
| `Sheet`                                                          | Bottom sheet on phones, centred dialog (max 420px) on desktop; used for chain confirmations.                                                                                                                                        |
| `UnsavedChangesSheet`                                            | "Save changes?" with "Save and switch", "Discard", "Cancel"; body names the tab and the number of changed fields.                                                                                                                   |

Warnings, the selected shell level's hint, the stdio warning and all error and conflict
notices stay visible; other explanations move behind ⓘ verbatim.

## Drafts and the save chain (`web/lib/settings/`)

Every field of a tab or subpage is a draft saved by the tab's bar. Real actions (list
add/delete, approvals, logins, pairing, runtime actions, update and backup actions)
stay immediate and are not part of a draft.

```js
const draft = useTabDraft({
  server: { name: assistant.name, instructions: assistant.instructions },
  revisions: { assistant: assistant.revision },
});
const steps = [
  assistantPatchStep({
    assistantId: assistant.id,
    label: assistantCopy.tabs.profile,
    keys: ["name", "instructions"],
    body: (values) => ({ name: values.name, instructions: values.instructions }),
  }),
];
<SaveBar
  draft={draft}
  onSave={() => draft.save(steps)}
  onOverwrite={() => draft.overwrite(steps)}
/>;
```

- **Values and base.** `server` is the flat field object of the tab. Untouched fields
  adopt newer server values silently; a field edited here and changed elsewhere is
  listed in `draft.conflicts`.
- **Base revisions.** `revisions` maps each resource the tab writes to its latest
  revision. While the draft is clean the base follows it; from the first edit it is
  frozen and sent with the save, so a foreign change returns 409 and the bar offers
  "Reload" (`draft.reload()`) or "Overwrite anyway" (`draft.overwrite(steps)`, which
  adopts the latest revisions and saves again).
- **Steps.** `{ id, label, keys?, resource?, run(ctx), revisions?(result), confirmation?(error), isConflict?(error) }`.
  Steps run in order. A step whose `keys` are unchanged is skipped; when it succeeds its
  keys become saved, so a retry after a partial save does not repeat it. `run` receives
  `{ values, base, changed, revision, revisions, confirmations, results }` and must send
  `revision` (the draft's base, never the latest prop) and spread `confirmations` into
  its request. The response's `revision` (or `revisions(result)`) is passed to later steps.
- **Confirmations.** A step error with `ASSISTANT_SHELL_CONFIRMATION_REQUIRED`,
  `MCP_STDIO_CONFIRMATION_REQUIRED` or `ASSISTANT_RESTART_REQUIRED` becomes
  `draft.confirmation = { kind: "shell" | "fullShell" | "stdio" | "restart", flags, data, confirm(), cancel() }`.
  Render it in a `Sheet`; `confirm()` repeats the same step with the flags
  (`confirmShell`, `confirmFull`, `confirmStdio`, `confirmRestart`), `cancel()` stops
  without an error. A step may map its own errors with `confirmation(error)`.
- **Errors.** The chain stops at the first error. `draft.outcome` holds the error, the
  failed step and `partial` (labels of saved steps); the bar shows "Partially saved: …"
  and the tab stays dirty.
- **Agent helpers** (`web/features/assistants/assistant-save-steps.js`):
  `assistantPatchStep` for `PATCH /assistants/:id` (Profil, Fähigkeiten, Telegram
  heartbeat) and `assistantWorkStep` for `PUT /assistants/:id/work` (Arbeit; revisions
  `{ access, team }`).

## Unsaved changes and navigation (`web/lib/navigation-guard.js`)

All navigation goes through one coordinator: app routes and browser history
(`useWorkspaceNavigation`), file editor tab closes, and settings drafts. Guards are
asked in registration order; the first refusal cancels; a newer navigation invalidates
an older one still waiting. One `beforeunload` listener is held while any protector
needs it (`holdUnloadWarning()`).

```js
const sheet = useUnsavedChangesGuard({
  draft,
  tab: tabLabel,
  save: () => draft.save(steps),
  stays: (request) =>
    request.next?.view === "agents" && agentSettingsLocation(request.next).tab === tab,
});
<UnsavedChangesSheet {...sheet} />;
```

Tab switches, back, agent switch and extension profile switch are route changes, so
they reach the guard automatically. A switch that is not a route change calls
`requestNavigation({ reason: "application", next, commit })` itself. Normalisation
(`"normalization"`) and editor tab closes (`"tab-close"`) never prompt.

## Routes

| Page           | Address                                       | Route fields                                                                                                                                                                                                                         |
| -------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Einstellungen  | `/settings?tab=access`, `/settings/<section>` | `settingsSection`, `settingsTab` (`workspace` / `access` / `operations`; derived from the section; `settingsSection: "general"` is the tab root). `settingsSectionGroups`, `settingsTabOf()` in `web/features/operations/routes.js`. |
| Agent settings | `/agents/:id/settings?tab=<tab>&page=<page>`  | `agentTab` (`profile` / `capabilities` / `work` / `telegram`), `agentPage` (`memory`, `allowlist`, `actions`, `projects`, `pipelines`, `telegram-activity`, `telegram-connection`); read with `agentSettingsLocation(route)`.        |
| Accounts       | `/accounts?section=<group>&item=<id or new>`  | `section` (`models` / `services` / `mcp-servers` / `cli`), `item`; MCP OAuth results keep working.                                                                                                                                   |
| Erweiterungen  | `/extensions/:profile?tab=<tab>`              | `extensionTab`; default `defaultExtensionTab` in `web/features/extensions/routes.js`.                                                                                                                                                |

Defaults are left out of addresses; `useWorkspaceNavigation` replaces any address whose
canonical form differs, which is how legacy links redirect.

## Server summaries

- `PUT /api/assistants/:id/work` — `{ access?: { revision, projectIds, pipelineIds, memoryWrite, autonomous, publish }, team?: { revision, autonomous, maxMembers, runTimeoutMinutes } }`
  → `{ access, team }`; one transaction, both revisions are preconditions.
- `GET /api/settings/summary` — `{ access: { mcp, remote, ssh, github }, operations: { diagnostics, backups, updates } }`;
  local state only, every part `null` when unknown.
- `GET /api/accounts/usage` — per provider connection, ChatGPT account, MCP server, web
  search, speech and native CLI account: `{ agents: [{ id, name, kind, via }], sessions, pipelineProfiles, clis: [{ tool, route }] }`.
  Agent data only while the agents feature runs.

Rows show "—" until a summary arrives, never a fake 0.

## Copy

Shared texts live in `commonCopy` (`web/lib/i18n/{de,en}/common.js`): `centralInAccounts`,
`usedBy`, `agentsCount(n)`, `ofCount(a, b)`, `unsavedTitle`, `unsavedBody(tab, n)`,
`saveAndSwitch`, `discard`, `showHint`, `changedElsewhere`, `overwrite`,
`partiallySaved(steps)`, `unsavedChanges`, `moreActions`, `confirm`, `language`.
Page-specific copy goes to the page's catalog in both languages.

## Testing

Pure logic has node tests (`tests/unit/settings-*.test.js`, `navigation-guard.test.js`,
`scroll-fade.test.js`). Components are exercised in a Playwright harness that serves
them from source through an in-process Vite server
(`tests/helpers/settings-pattern-harness.js`, fixtures in
`tests/browser/harness/settings-pattern/`, specs `tests/browser/settings-pattern-*.spec.js`).
Add a fixture there when a shared component gains behaviour; page behaviour belongs in
the page's own specs.
````

- [ ] **Step 2: Point to it**

In `docs/architecture.md`, add after the "## Boundaries" section:

```markdown
## Settings pages

Agent settings, Accounts, Settings, Extensions and Projects share one page pattern
(shell, tabs, list cards, per-tab drafts with a save chain, unsaved-changes guard). See
[settings-pattern.md](settings-pattern.md).
```

In `web/README.md`, extend the `components` bullet with: "The settings pattern (`SettingsShell`, `ListCard`/`ListRow`, `SaveBar`, `UnsavedChangesSheet`, …) is described in `docs/settings-pattern.md`; its draft logic lives in `lib/settings/` and the navigation guard in `lib/navigation-guard.js`."

- [ ] **Step 3: Run the full gate**

Run: `npm run check`
Expected: lint, format, structure (every file ≤ 600 lines), build and all node suites pass.

Run: `npx playwright test tests/browser/settings-pattern-tabs.spec.js tests/browser/settings-pattern-list.spec.js tests/browser/settings-pattern-draft.spec.js tests/browser/settings-pattern-shell.spec.js tests/browser/file-explorer-editor-navigation.spec.js tests/browser/projects.spec.js tests/browser/extensions.spec.js tests/browser/pipelines-runs.spec.js tests/browser/assistant-settings.spec.js tests/browser/assistant-feature.spec.js tests/browser/navigation.spec.js`
Expected: PASS.

Run the complete browser suite once: `npm run test:e2e`
Expected: PASS. Then repeat the four `settings-pattern-*` specs and `projects.spec.js` in WebKit: `AGENTPIER_TEST_BROWSER=webkit npx playwright test tests/browser/settings-pattern-tabs.spec.js tests/browser/settings-pattern-list.spec.js tests/browser/settings-pattern-draft.spec.js tests/browser/settings-pattern-shell.spec.js tests/browser/projects.spec.js` (install with `npx playwright install webkit` if missing).

- [ ] **Step 4: Commit**

```bash
npx prettier --write docs/settings-pattern.md docs/architecture.md web/README.md
git add docs/settings-pattern.md docs/architecture.md web/README.md
git commit -m "docs: describe the shared settings pattern" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage (Step 0):**

| Spec item                                                                                                                                                            | Task    |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `SettingsShell`                                                                                                                                                      | 10      |
| `ListCard`, `ListRow` variants, toggle/number/select/radio/checkbox rows                                                                                             | 8       |
| `GroupLabel`, `Segmented`, `InfoHint`, `ReferenceRow`                                                                                                                | 8       |
| `SaveBar`, `UnsavedChangesSheet` (+ `Sheet`)                                                                                                                         | 9       |
| `UnderlineTabs` restyle, scroll fade, 48px reveal, hover arrows; `RunStatusFilter` fade                                                                              | 7       |
| `useTabDraft` (values, base revisions, dirty, changeCount, conflicts, reset, save(steps)), confirmations, partial success; `useSyncedForm` wrapper                   | 4, 5, 9 |
| Navigation guard coordinator, single `beforeunload`, settings guards open the sheet                                                                                  | 3, 9    |
| Routes: `settingsTab`, accounts `section`/`item` incl. `item=new`, `agentTab`/`agentPage`, extensions default (centralised; flip deferred to step 4 — see Decisions) | 6       |
| `PUT /assistants/:id/work`                                                                                                                                           | 11      |
| `PATCH /assistants/:id` strict base revision (client helper)                                                                                                         | 11      |
| `GET /settings/summary`                                                                                                                                              | 12      |
| `GET /accounts/usage` (no assistant access when agents are off)                                                                                                      | 13      |
| Common catalog keys, `assistants.js` split, `LanguageSelect` label, parity/terminology tests                                                                         | 1, 2    |
| Unit/property tests for draft state, save chain, guard coordinator, routes; integration tests for the three server additions; browser spec for shared components     | 3–13    |
| Lasting docs                                                                                                                                                         | 14      |

**Placeholder scan:** no TBD/TODO; every code step carries the code. Two steps tell the executor to confirm a fixture detail (`pipelineCopy.status` label, `f.application.assistants` being `null`) with the exact command and the fallback assertion.

**Type consistency:** `useTabDraft` fields (`values`, `set`, `dirty`, `changeCount`, `conflicts`, `saving`, `outcome`, `confirmation`, `save`, `overwrite`, `reset`, `reload`, `revisions`) are used with the same names by `SaveBar`, `useUnsavedChangesGuard`, the draft fixture and the guide. Step fields (`id`, `label`, `keys`, `resource`, `run`, `revisions`, `confirmation`, `isConflict`) match between `save-chain.js`, `assistant-save-steps.js`, tests and the guide. Navigation exports (`registerNavigationGuard`, `requestNavigation`, `holdUnloadWarning`, `needsDecision`) match between Tasks 3, 9 and 14.
