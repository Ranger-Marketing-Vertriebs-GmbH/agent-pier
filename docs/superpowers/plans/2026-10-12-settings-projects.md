# Settings Redesign Step 5: Projects Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the Projects hub (`/projects`) onto the shared settings pattern: `SettingsShell` header, restyled list and detail pane, "Wissen" tab label, attention strips, list cards, segmented radio controls, ⓘ hint, run filter pills and a phone launch bar. Every current feature keeps its place.

**Architecture:** The page structure stays (ListDetail + UnderlineTabs; same routes, same data hooks). `ProjectsPage` renders `SettingsShell` for the list (and the desktop list+detail). On phones a selected project renders its own `SettingsShell` (back arrow, project name, meta subtitle, tabs, fixed "Sitzung starten" bar). Tab bodies switch to Step 0's `GroupLabel`, `ListCard`, `Segmented` and `InfoHint`. The run-hint sweep additionally remembers the first run per project, so an attention strip can open a single run directly. Projects has no draft fields, so no `useTabDraft`, `SaveBar` or unsaved-changes guard is added.

**Tech Stack:** React 19, Vite 8, `node:test`, Playwright 1.64. Step 0 components from `web/components/` and `web/styles/settings-pattern.css`.

**Spec:** `docs/superpowers/specs/2026-10-12-settings-redesign-design.md` ("Guiding decisions", "Step 5: Projects", "Testing and verification"). Step 0 contract: `docs/superpowers/plans/2026-10-12-settings-foundation.md` (+ "Ruling:" lines in `.superpowers/sdd/2026-10-12-settings-foundation/progress.md`, which override it). Design data (untrusted): handoff `README.md` section "Projekte (2c + 3e)" and `Einstellungen Übersicht.dc.html` section "Projekte".

## Global Constraints

- Work only in `/Users/d.kaulig/Projects/agent-pier/.worktrees/settings-projects` on branch `feat/settings-redesign-projects` (branched from `feat/settings-redesign` after Step 0). Never target the default tmux server or real user sessions; browser specs use the existing route fixtures (`tests/browser/projects-fixture.js`, `tests/helpers/repository-browser.js`).
- Node.js 22.13+, ES modules, JSX only under `web/`. Prettier: two spaces, double quotes, semicolons, trailing commas, 90 columns. Run `npx prettier --write <files>` and `npx eslint <files>` on every touched file.
- Every source and test file stays at or below 600 lines (`npm run check:structure`). `web/features/projects/projects.css` is at 554 lines today: tab styles move to a new `project-tabs.css`.
- Every UI text exists in `web/lib/i18n/de/*.js` and `web/lib/i18n/en/*.js` with matching keys and interpolation arguments; import reactive exports from `web/lib/i18n/messages/`. No hardcoded product copy. Read reactive copy at render time, never at module load (`localizedCopy` is a proxy).
- Do not add keys to `web/lib/i18n/{de,en}/common.js` (shared copy belongs to Step 0). Page copy goes to `projects.js` (or `memory.js`/`agentbus.js` where the text already lives).
- No feature loss (Guiding decision 1). Function wins over pixel fidelity; deviations are listed in the PR.
- README sizes win over drawings: mobile header 56px, desktop header 64px, ⓘ 20×20, Projects bottom bar primary h44 full width with terminal icon, segmented control radius 10 / active radius 7, group label 11/600 uppercase.
- Rows show "—" (`unknownValue`) until data is known, never a fake 0.
- Hints behind ⓘ are disclosures (`aria-expanded` + `aria-controls`) that insert the text verbatim; never tooltips. Only `memoryCopy.tabHint` moves behind ⓘ on this page.
- Existing browser specs: change how elements are found, not what is asserted (exceptions are listed per step and in "Deviations").
- Commit messages in English, prefixes `feat:`, `fix:`, `test:`, `chore:`, ending with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Commands: single node test `node --test tests/unit/<file>.test.js`; browser `npm run build && npx playwright test tests/browser/<file>.spec.js`; full gate `npm run check`.

## Review Focus

1. A capped run sweep (more failed or waiting runs than the five swept pages) reports one run for a project: the strip must open the filtered run list, not a run that may not be the only one. Pinned in Task 2 (`attentionTarget` unit test).
2. A project known only as a repository or AgentBus folder (no `memoryId`) must render Übersicht without an attention strip and keep the register flows on Wissen and Läufe. Pinned in Task 4 (browser) and existing `projects.spec.js`/`memory.spec.js` register tests.
3. Resizing across the 700px breakpoint while a project tab with filters is open must keep project, tab and query (the phone detail is a different component tree). Pinned in Task 3 (`projects-shell.spec.js`).
4. With the app's global mobile header hidden on Projects, the drawer must still open from the page header on the phone list, and the "+" menu must close on Escape/outside click and return focus. Pinned in Task 3.
5. A language switch must re-render counts, subtitles, segment labels and strips in the new language (no module-level copy capture). Pinned by the English describes in Tasks 3, 5 and 6 and the `projects-copy` unit test in Task 1.

---

## File Structure

Created:

- `web/features/projects/ProjectAddMenu.jsx` — phone header "+" menu (Repository klonen / Ordner hinzufügen), menu semantics and keyboard.
- `web/features/projects/ProjectListItem.jsx` — list row content (folder tile, name, remote or "Nur lokal", attention hints); moved out of `ProjectsPage.jsx`.
- `web/features/projects/ProjectAttention.jsx` — attention strips on Übersicht.
- `web/features/projects/ProjectKnowledgeEntry.jsx` — one knowledge entry row (toggle, body, edit/history/archive); moved out of `ProjectKnowledge.jsx`.
- `web/features/projects/project-tabs.css` — styles of the four tab bodies.
- Tests: `tests/unit/projects-copy.test.js`, `tests/unit/project-attention.test.js`, `tests/browser/projects-shell.spec.js`, `tests/browser/projects-tabs.spec.js`.

Modified:

- `web/features/projects/ProjectsPage.jsx` (SettingsShell, add menu, phone detail branch), `ProjectDetail.jsx` (phone shell + launch bar, desktop card), `ProjectOverview.jsx` (strips, facts card, session rows), `ProjectKnowledge.jsx` (search, segmented, ⓘ, group label action, list card), `ProjectAgentBus.jsx` (segmented radios, group label), `ProjectRuns.jsx` (shared run route), `useProjectHub.js` (first run per project), `project-presentation.js` (attention helpers), `routes.js` (`pipelineRunRoute`), `projects.css`.
- `web/features/agentbus/agentbus.css` (project AgentBus rows), `web/features/pipelines/run-table.css` (filter pills).
- `web/app/App.jsx` (pass `openNavigation`/`navigationOpen` to ProjectsPage).
- `web/lib/i18n/{de,en}/projects.js`.
- Tests: `tests/unit/project-hub.test.js`, `tests/browser/projects.spec.js`, `memory.spec.js`, `projects-hub-loading.spec.js`, `agentbus.spec.js`, `navigation.spec.js`, `tests/helpers/repository-browser.js`.

### Step 0 interfaces this plan consumes (exact names)

- `SettingsShell({ title, subtitle?, description?, leading?: "menu" | "back" | null, onLeading?, leadingLabel?, navigationOpen?, actions?, tabs?, bar?, className?, children })` from `web/components/SettingsShell.jsx`; title is the `<h1>`; classes `.settings-shell`, `.settings-shell-header`, `.settings-shell-actions`, `.settings-shell-body`, `.settings-shell-content` (max 720).
- `UnderlineTabs({ label, tabs, selected, onSelect, disabled, idPrefix = "underline" })`, ids `underline-tab-<id>` / `underline-tabpanel-<id>`, scroll classes `can-scroll-left/right` on the `[role=tablist]`.
- `GroupLabel({ children, as = "h2", id?, hint?, hintLabel?, action?: { label, onClick, disabled? } })` (action label may be a node).
- `ListCard({ label?, labelledBy?, disabled?, className?, children })` → `role="group"`, class `.list-card`.
- `unknownValue` (named export of `web/components/ListRow.jsx`); row classes `.list-row`, `.list-row-main`, `.list-row-text`, `.list-row-label`, `.list-row-sub`, `.list-row-chevron`.
- `Segmented({ label, options: [{ value, label }], value, onChange, disabled? })` → `role="radiogroup"` of native radios inside `<label>`s.
- `useInfoHint() => { id, open, toggle }`, `InfoHintButton({ hint, label = commonCopy.showHint })`, `InfoHintText({ hint, children })` from `web/components/InfoHint.jsx`.
- `RunStatusFilter` already carries the 48px edge fade (`can-scroll-left/right`, Ruling F8); the pill restyle belongs to this step.
- `commonCopy.showHint` ("Hinweis anzeigen" / "Show hint"), `commonCopy.unsavedChanges` ("Ungespeicherte Änderungen"), `commonCopy.unsavedTitle` ("Änderungen speichern?").

---

### Task 1: Projects copy (Wissen tab, add menu, project count)

**Files:**

- Modify: `web/lib/i18n/de/projects.js`, `web/lib/i18n/en/projects.js`
- Modify: `tests/browser/projects.spec.js:35,247`, `tests/browser/memory.spec.js:118,224,230,407`
- Test: `tests/unit/projects-copy.test.js`

**Interfaces:**

- Consumes: `setLanguage(next, { persist: false })` from `web/lib/i18n/index.js`.
- Produces (`projectsHubCopy`): `tabKnowledge` = "Wissen" / "Knowledge"; `addMenu` = "Projekt hinzufügen" / "Add project"; `projectsCount(count)` = "1 Projekt" / "n Projekte", "1 project" / "n projects".

- [ ] **Step 0: Confirm Step 0 is in the branch**

Run: `ls web/components/SettingsShell.jsx web/components/GroupLabel.jsx web/components/ListCard.jsx web/components/Segmented.jsx web/components/InfoHint.jsx web/styles/settings-pattern.css && grep -n "export" web/components/InfoHint.jsx web/components/ListRow.jsx web/components/GroupLabel.jsx | head -20`
Expected: all files exist; `useInfoHint`, `InfoHintButton`, `InfoHintText`, `unknownValue` are exported. If a name differs, use the actual name everywhere in this plan and note it in the PR.

- [ ] **Step 1: Write the failing unit test**

Create `tests/unit/projects-copy.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { setLanguage } from "../../web/lib/i18n/index.js";
import { projectsHubCopy } from "../../web/lib/i18n/messages/projects.js";

test("the projects hub names its tabs, add menu and counts in both languages", (t) => {
  t.after(() => setLanguage("de", { persist: false }));
  setLanguage("de", { persist: false });
  assert.equal(projectsHubCopy.tabKnowledge, "Wissen");
  assert.equal(projectsHubCopy.addMenu, "Projekt hinzufügen");
  assert.equal(projectsHubCopy.projectsCount(1), "1 Projekt");
  assert.equal(projectsHubCopy.projectsCount(4), "4 Projekte");
  setLanguage("en", { persist: false });
  assert.equal(projectsHubCopy.tabKnowledge, "Knowledge");
  assert.equal(projectsHubCopy.addMenu, "Add project");
  assert.equal(projectsHubCopy.projectsCount(1), "1 project");
  assert.equal(projectsHubCopy.projectsCount(0), "0 projects");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/unit/projects-copy.test.js`
Expected: FAIL (`"Projektwissen" !== "Wissen"`).

- [ ] **Step 3: Change the catalogs**

In `web/lib/i18n/de/projects.js` inside `projectsHubCopy`: replace `tabKnowledge: "Projektwissen",` with `tabKnowledge: "Wissen",` and add after `addFolder: "Ordner hinzufügen",`:

```js
  addMenu: "Projekt hinzufügen",
  projectsCount: (count) => (count === 1 ? "1 Projekt" : `${count} Projekte`),
```

In `web/lib/i18n/en/projects.js` inside `projectsHubCopy`: replace `tabKnowledge: "Project knowledge",` with `tabKnowledge: "Knowledge",` and add after `addFolder: "Add folder",`:

```js
  addMenu: "Add project",
  projectsCount: (count) => (count === 1 ? "1 project" : `${count} projects`),
```

The other "Projektwissen" texts (`operations.js` activity category, `assistant-workflows.js`) stay unchanged; the spec only renames the tab.

- [ ] **Step 4: Update the specs that find the tab by its old label**

`tests/browser/projects.spec.js:35`: `["Projektwissen", "4"],` → `["Wissen", "4"],`
`tests/browser/projects.spec.js:247`: `{ name: /^Project knowledge/ }` → `{ name: /^Knowledge/ }`
`tests/browser/memory.spec.js` lines 118, 224, 230, 407: `{ name: /^Projektwissen/` → `{ name: /^Wissen/` (keep `selected: true` on line 118).

- [ ] **Step 5: Run unit tests and the catalog checks**

Run: `node --test tests/unit/projects-copy.test.js tests/unit/i18n-catalogs.test.js tests/unit/i18n-terminology.test.js tests/unit/routes.test.js`
Expected: PASS.

- [ ] **Step 6: Run the affected browser specs**

Run: `npm run build && npx playwright test tests/browser/projects.spec.js tests/browser/memory.spec.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
npx prettier --write web/lib/i18n/de/projects.js web/lib/i18n/en/projects.js tests/unit/projects-copy.test.js tests/browser/projects.spec.js tests/browser/memory.spec.js
git add web/lib/i18n/de/projects.js web/lib/i18n/en/projects.js tests/unit/projects-copy.test.js tests/browser/projects.spec.js tests/browser/memory.spec.js
git commit -m "feat: shorten the projects knowledge tab label and add hub header copy" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Attention data (first run per project, strip targets)

**Files:**

- Modify: `web/features/projects/useProjectHub.js:118-152` (`groupRunCounts`, `sweepRunCounts`) and `useAttention` state
- Modify: `web/features/projects/routes.js` (add `pipelineRunRoute`), `web/features/projects/project-presentation.js`, `web/features/projects/ProjectRuns.jsx:19-26`
- Test: `tests/unit/project-hub.test.js`, `tests/unit/project-attention.test.js`

**Interfaces:**

- Produces:
  - `groupFirstRuns(runs) => { [projectId]: runId }` (first listed run per project; runs without `projectId` ignored), exported from `useProjectHub.js`.
  - `sweepRunCounts(read) => Promise<{ counts, first, capped }>`.
  - `useProjectHub().attention = { decisions, failed, first: { decisions, failed }, capped: { decisions, failed } }`.
  - `pipelineRunRoute(runId)` from `routes.js` → `{ view: "pipelines", pipelineTab: "runs", pipelineItem: runId, pipelinePage: 1, pipelineStatus: "", projectId: "" }`.
  - From `project-presentation.js`: `hintCount(count, capped)` (`"100+"` when capped), `projectAttention(attention, memoryId) => { decisions: Part, failed: Part }` with `Part = { count: number, run: string, capped: boolean }`, `attentionTarget(projectId, status, part)` → `pipelineRunRoute(part.run)` when `part.count === 1 && !part.capped && part.run`, else `projectsRoute({ projectId, projectTab: "runs", pipelineStatus: status })`.

- [ ] **Step 1: Write the failing tests**

In `tests/unit/project-hub.test.js` add `groupFirstRuns` to the import list from `../../web/features/projects/useProjectHub.js`, change the two `deepEqual`s at the end of "the run sweep reads further pages at once and marks a capped status" to:

```js
assert.deepEqual(result, {
  counts: { m1: 30, m2: 70 },
  first: { m1: "0", m2: "30" },
  capped: true,
});
```

```js
assert.deepEqual(small, { counts: { m1: 1 }, first: { m1: "1" }, capped: false });
```

and append:

```js
test("the first listed run of each project is remembered", () => {
  assert.deepEqual(
    groupFirstRuns([
      { id: "a", projectId: "m1" },
      { id: "b", projectId: "m1" },
      { id: "c", projectId: "m2" },
      { id: "d" },
    ]),
    { m1: "a", m2: "c" },
  );
  assert.deepEqual(groupFirstRuns(undefined), {});
});
```

Create `tests/unit/project-attention.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  attentionTarget,
  hintCount,
  projectAttention,
} from "../../web/features/projects/project-presentation.js";

const attention = {
  decisions: { m1: 1, m2: 3 },
  failed: { m2: 2 },
  first: { decisions: { m1: "run-a", m2: "run-b" }, failed: { m2: "run-f" } },
  capped: { decisions: false, failed: true },
};

test("a project's attention parts carry count, first run and the capped flag", () => {
  assert.deepEqual(projectAttention(attention, "m1"), {
    decisions: { count: 1, run: "run-a", capped: false },
    failed: { count: 0, run: "", capped: true },
  });
  assert.deepEqual(projectAttention(attention, ""), {
    decisions: { count: 0, run: "", capped: false },
    failed: { count: 0, run: "", capped: true },
  });
  assert.deepEqual(
    projectAttention({ decisions: {}, failed: {}, capped: {} }, "m1").decisions,
    { count: 0, run: "", capped: false },
  );
});

test("one known run opens that run; several or a capped count open the filtered list", () => {
  assert.deepEqual(
    attentionTarget("p1", "awaiting-human", { count: 1, run: "run-a", capped: false }),
    {
      view: "pipelines",
      pipelineTab: "runs",
      pipelineItem: "run-a",
      pipelinePage: 1,
      pipelineStatus: "",
      projectId: "",
    },
  );
  for (const part of [
    { count: 3, run: "run-b", capped: false },
    { count: 1, run: "run-f", capped: true },
    { count: 1, run: "", capped: false },
  ]) {
    const target = attentionTarget("p1", "failed", part);
    assert.equal(target.view, "projects");
    assert.equal(target.projectId, "p1");
    assert.equal(target.projectTab, "runs");
    assert.equal(target.pipelineStatus, "failed");
  }
});

test("capped counts read as lower bounds", () => {
  assert.equal(hintCount(100, true), "100+");
  assert.equal(hintCount(2, false), 2);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/unit/project-hub.test.js tests/unit/project-attention.test.js`
Expected: FAIL (`groupFirstRuns` is not exported; `attentionTarget` is not exported).

- [ ] **Step 3: Implement**

In `web/features/projects/useProjectHub.js`, after `groupRunCounts` add:

```js
// The first listed run of each project, so a single hint can open that run directly.
export function groupFirstRuns(runs) {
  const first = {};
  for (const run of runs || [])
    if (run.projectId && !first[run.projectId]) first[run.projectId] = run.id;
  return first;
}
```

In `sweepRunCounts`, replace the return with:

```js
return {
  counts: groupRunCounts(runs),
  first: groupFirstRuns(runs),
  capped: runs.length < total,
};
```

In `useAttention`, the initial state becomes:

```js
const [attention, setAttention] = useState({
  decisions: {},
  failed: {},
  first: { decisions: {}, failed: {} },
  capped: { decisions: false, failed: false },
});
```

and the `setAttention` call inside `read` becomes:

```js
setAttention({
  decisions: decisions.counts,
  failed: failed.counts,
  first: { decisions: decisions.first, failed: failed.first },
  capped: { decisions: decisions.capped, failed: failed.capped },
});
```

In `web/features/projects/routes.js` append:

```js
// A pipeline run's own page; run rows and attention strips open it.
export function pipelineRunRoute(pipelineItem) {
  return {
    view: "pipelines",
    pipelineTab: "runs",
    pipelineItem,
    pipelinePage: 1,
    pipelineStatus: "",
    projectId: "",
  };
}
```

In `web/features/projects/project-presentation.js` add at the top `import { pipelineRunRoute, projectsRoute } from "./routes.js";` and append:

```js
// Counts from a capped sweep are lower bounds and read as "100+".
export const hintCount = (count, capped) => (capped ? `${count}+` : count);

const attentionPart = (attention, kind, memoryId) => ({
  count: (memoryId && attention[kind]?.[memoryId]) || 0,
  run: (memoryId && attention.first?.[kind]?.[memoryId]) || "",
  capped: Boolean(attention.capped?.[kind]),
});

// Waiting decisions and failed runs of one project, from the hub's run sweep.
export function projectAttention(attention, memoryId) {
  return {
    decisions: attentionPart(attention, "decisions", memoryId),
    failed: attentionPart(attention, "failed", memoryId),
  };
}

// One run that is surely the only one opens directly; otherwise the filtered list.
export function attentionTarget(projectId, status, part) {
  return part.count === 1 && !part.capped && part.run
    ? pipelineRunRoute(part.run)
    : projectsRoute({ projectId, projectTab: "runs", pipelineStatus: status });
}
```

In `web/features/projects/ProjectRuns.jsx`, delete the local `runRoute` function, change the routes import to `import { pipelineRunRoute, projectsRoute, projectsRoutePath } from "./routes.js";` and replace both `runRoute(` calls with `pipelineRunRoute(`.

- [ ] **Step 4: Run the tests**

Run: `node --test tests/unit/project-hub.test.js tests/unit/project-attention.test.js tests/unit/routes.test.js tests/unit/project-duplicates.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write web/features/projects/useProjectHub.js web/features/projects/routes.js web/features/projects/project-presentation.js web/features/projects/ProjectRuns.jsx tests/unit/project-hub.test.js tests/unit/project-attention.test.js
npx eslint web/features/projects tests/unit/project-hub.test.js tests/unit/project-attention.test.js
git add web/features/projects tests/unit/project-hub.test.js tests/unit/project-attention.test.js
git commit -m "feat: remember the first waiting or failed run per project" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Projects shell, add menu, phone detail and launch bar

**Files:**

- Create: `web/features/projects/ProjectAddMenu.jsx`, `web/features/projects/ProjectListItem.jsx`
- Modify: `web/features/projects/ProjectsPage.jsx` (full rewrite below), `web/features/projects/ProjectDetail.jsx` (full rewrite below), `web/features/projects/projects.css`, `web/app/App.jsx:256-269`
- Modify: `web/lib/i18n/{de,en}/projects.js` (remove the now unused `topline`)
- Modify: `tests/browser/projects.spec.js`, `tests/helpers/repository-browser.js:154-159`
- Test: `tests/browser/projects-shell.spec.js`

**Interfaces:**

- Consumes: Step 0 `SettingsShell`, `UnderlineTabs`, `unknownValue`; Task 1 copy; Task 2 `projectAttention`, `hintCount`.
- Produces:
  - `ProjectAddMenu({ label, items: [{ id, label, onSelect() }] })`.
  - `ProjectListItem({ item, attention })` where `attention = projectAttention(...)`.
  - `ProjectsPage` props gain `openNavigation`, `navigationOpen`.
  - `ProjectDetail` props gain `attention`, `notices` (node shown on phones above the tab body), `onBack()`; it passes `projectId`, `attention`, `onNavigate` to `ProjectOverview` (Task 4 consumes them).
  - CSS classes: `.projects-hub` on every Projects shell, `.project-detail-shell` on the phone detail shell, `.project-launch-bar` (phone bar), `.project-add-menu`, `.project-add-trigger`, `.project-add-popover`.

- [ ] **Step 1: Write the browser spec (fails: old layout)**

Create `tests/browser/projects-shell.spec.js`:

```js
import { test, expect } from "@playwright/test";
import { baseURL as base } from "../helpers/browser.js";
import { hubFixture } from "./projects-fixture.js";

const phone = { width: 390, height: 844 };
const noOverflow = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
const header = (page) => page.locator(".settings-shell-header");

test("phones show the projects header with the drawer button and an add menu", async ({
  page,
}) => {
  await page.setViewportSize(phone);
  await hubFixture(page);
  await page.goto(base + "/projects");
  await expect(
    header(page).getByRole("heading", { name: "Projekte", level: 1 }),
  ).toBeVisible();
  await expect(header(page).getByText("2 Projekte · Lokal gespeichert")).toBeVisible();
  await expect(page.locator(".mobile-header")).toBeHidden();
  const drawer = header(page).getByRole("button", { name: "Navigation öffnen" });
  await expect(drawer).toHaveAttribute("aria-expanded", "false");
  await drawer.click();
  await expect(drawer).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveAttribute("aria-expanded", "false");

  const add = header(page).getByRole("button", { name: "Projekt hinzufügen" });
  await expect(add).toHaveAttribute("aria-haspopup", "menu");
  await add.click();
  const menu = page.getByRole("menu", { name: "Projekt hinzufügen" });
  await expect(menu.getByRole("menuitem")).toHaveText([
    "Repository klonen",
    "Ordner hinzufügen",
  ]);
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem").last()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(add).toBeFocused();
  await add.click();
  await header(page).getByRole("heading", { level: 1 }).click();
  await expect(menu).toHaveCount(0);
  await add.click();
  await menu.getByRole("menuitem", { name: "Ordner hinzufügen" }).click();
  await expect(page.getByRole("dialog", { name: "Projekt hinzufügen" })).toBeVisible();
  await page.getByRole("button", { name: "Dialog schließen" }).click();
  expect(await noOverflow(page)).toBe(true);
});

test("a project on a phone has a back header, four fitting tabs and the launch bar", async ({
  page,
}) => {
  await page.setViewportSize(phone);
  await hubFixture(page);
  await page.goto(base + "/projects/m1");
  await expect(
    header(page).getByRole("heading", { name: "agent-pier", level: 1 }),
  ).toBeVisible();
  await expect(header(page).getByText("acme/agent-pier · Token Arbeit")).toBeVisible();
  const tabs = page.getByRole("tablist", { name: "Projektbereiche" });
  await expect(tabs.getByRole("tab")).toHaveText([
    /^Übersicht/,
    /^Wissen\s*4/,
    /^AgentBus\s*1/,
    /^Läufe\s*3/,
  ]);
  await expect(tabs).not.toHaveClass(/can-scroll-right/);
  const launch = page.getByRole("button", { name: "Sitzung in agent-pier starten" });
  for (const tab of ["Übersicht", "Wissen", "AgentBus", "Läufe"]) {
    await tabs.getByRole("tab", { name: new RegExp(`^${tab}`) }).click();
    await expect(launch).toBeVisible();
    const box = await launch.boundingBox();
    expect(Math.round(box.height)).toBe(44);
    expect(box.y + box.height).toBeGreaterThan(800);
    // Projects has no draft fields: its bar is the launch bar, never a save bar.
    await expect(
      page.getByRole("region", { name: "Ungespeicherte Änderungen" }),
    ).toHaveCount(0);
    expect(await noOverflow(page)).toBe(true);
  }
  await header(page).getByRole("button", { name: "Alle Projekte" }).click();
  // `choose("")` keeps the last tab for the next project (unchanged behaviour), so the
  // list address carries it after the loop ended on "Läufe".
  await expect(page).toHaveURL(/\/projects\?tab=runs$/);
  await expect(
    page.getByRole("navigation", { name: "Projekte", exact: true }),
  ).toBeVisible();
});

test("an unknown project on a phone keeps a way back", async ({ page }) => {
  await page.setViewportSize(phone);
  await hubFixture(page);
  await page.goto(base + "/projects/unknown-project");
  await expect(
    page.getByRole("heading", { name: "Projekt nicht gefunden" }),
  ).toBeVisible();
  await header(page).getByRole("button", { name: "Alle Projekte" }).click();
  await expect(page).toHaveURL(/\/projects$/);
});

test("the desktop header carries the add actions and the detail pane its launch button", async ({
  page,
}) => {
  await hubFixture(page);
  await page.goto(base + "/projects");
  await expect(page).toHaveURL(/\/projects\/m1$/);
  await expect(
    header(page).getByRole("heading", { name: "Projekte", level: 1 }),
  ).toBeVisible();
  await expect(
    header(page).getByText("Vom Repository zur nächsten Sitzung.", { exact: false }),
  ).toBeVisible();
  await expect(
    header(page).getByRole("button", { name: "Ordner hinzufügen" }),
  ).toBeVisible();
  await expect(
    header(page).getByRole("button", { name: "Repository klonen", exact: true }),
  ).toBeVisible();
  await expect(
    header(page).getByRole("button", { name: "Projekt hinzufügen" }),
  ).toHaveCount(0);
  await expect(
    header(page).getByRole("button", { name: "Navigation öffnen" }),
  ).toBeHidden();
  const card = page.locator(".project-card");
  await expect(card.getByRole("heading", { name: "agent-pier", level: 2 })).toBeVisible();
  await expect(
    card.getByRole("button", { name: "Sitzung in agent-pier starten" }),
  ).toBeVisible();
  await expect(page.locator(".project-launch-bar")).toHaveCount(0);
});

test("switching between phone and desktop width keeps the project, tab and filter", async ({
  page,
}) => {
  await hubFixture(page);
  await page.goto(base + "/projects/m1?tab=runs&status=running");
  const runs = page.getByRole("tab", { name: /^Läufe/ });
  await expect(runs).toHaveAttribute("aria-selected", "true");
  await page.setViewportSize(phone);
  await expect(page.getByRole("heading", { name: "agent-pier", level: 1 })).toBeVisible();
  await expect(runs).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveURL(/\/projects\/m1\?tab=runs&status=running$/);
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.getByRole("heading", { name: "agent-pier", level: 2 })).toBeVisible();
  await expect(page).toHaveURL(/\/projects\/m1\?tab=runs&status=running$/);
});

test.describe("English projects shell", () => {
  test.use({ locale: "en-GB" });

  test("header, menu, back and launch are translated", async ({ page }) => {
    await page.setViewportSize(phone);
    await hubFixture(page);
    await page.goto(base + "/projects");
    await expect(header(page).getByText("2 projects · Stored locally")).toBeVisible();
    await header(page).getByRole("button", { name: "Add project" }).click();
    await expect(page.getByRole("menuitem")).toHaveText([
      "Clone repository",
      "Add folder",
    ]);
    await page.keyboard.press("Escape");
    await page
      .getByRole("navigation", { name: "Projects", exact: true })
      .getByRole("button", { name: /^agent-pier/ })
      .click();
    await expect(page.getByRole("tab", { name: /^Knowledge/ })).toBeVisible();
    await expect(
      header(page).getByRole("button", { name: "All projects" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Start session in agent-pier" }),
    ).toBeVisible();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run build && npx playwright test tests/browser/projects-shell.spec.js`
Expected: FAIL (no `.settings-shell-header` on `/projects`).

- [ ] **Step 3: Add the add menu and the list item**

Create `web/features/projects/ProjectAddMenu.jsx`:

```jsx
import React, { useEffect, useRef, useState } from "react";
import Icon from "../../components/Icon.jsx";

// The phone header's "+": a small menu with the page's two ways to add a project.
export default function ProjectAddMenu({ label, items }) {
  const [open, setOpen] = useState(false);
  const root = useRef(null);
  const trigger = useRef(null);
  const menu = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    menu.current?.querySelector("[role='menuitem']")?.focus();
    const outside = (event) => {
      if (!root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  const keys = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
      return;
    }
    const controls = [...event.currentTarget.querySelectorAll("[role='menuitem']")];
    const position = controls.indexOf(document.activeElement);
    const next =
      event.key === "ArrowDown"
        ? (position + 1) % controls.length
        : event.key === "ArrowUp"
          ? (position - 1 + controls.length) % controls.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? controls.length - 1
              : null;
    if (next === null) return;
    event.preventDefault();
    controls[next].focus();
  };
  return (
    <div className="project-add-menu" ref={root}>
      <button
        type="button"
        ref={trigger}
        className="project-add-trigger"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="plus" />
      </button>
      {open && (
        <div
          role="menu"
          ref={menu}
          aria-label={label}
          className="project-add-popover"
          onKeyDown={keys}
        >
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
```

Create `web/features/projects/ProjectListItem.jsx` (the former `ProjectItem` of `ProjectsPage.jsx`):

```jsx
import React from "react";
import Icon from "../../components/Icon.jsx";
import { projectsHubCopy as copy } from "../../lib/i18n/messages/projects.js";
import { hintCount, remoteShort } from "./project-presentation.js";

// A project in the hub list: folder tile, name, remote or "local only", attention hints.
export default function ProjectListItem({ item, attention }) {
  const { decisions, failed } = attention;
  return (
    <>
      <span className="project-item-icon" aria-hidden="true">
        <Icon name="folder" size={16} />
      </span>
      <span className="project-item-text">
        <strong>{item.name}</strong>
        <small>{item.remote ? remoteShort(item.remote) : copy.localOnly}</small>
        {decisions.count > 0 && (
          <small className="project-hint decision">
            {copy.decisions(hintCount(decisions.count, decisions.capped))}
          </small>
        )}
        {failed.count > 0 && (
          <small className="project-hint failed">
            {copy.failedRuns(hintCount(failed.count, failed.capped))}
          </small>
        )}
      </span>
      <Icon name="chevron" size={16} className="project-item-chevron" />
    </>
  );
}
```

- [ ] **Step 4: Rewrite `ProjectsPage.jsx`**

Replace `web/features/projects/ProjectsPage.jsx` with (logic for redirects, retry and clone completion is unchanged):

```jsx
import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import Icon from "../../components/Icon.jsx";
import ListDetail from "../../components/ListDetail.jsx";
import { unknownValue } from "../../components/ListRow.jsx";
import SettingsShell from "../../components/SettingsShell.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { projectsHubCopy as copy } from "../../lib/i18n/messages/projects.js";
import { repositoriesPageCopy } from "../../lib/i18n/messages/repositories.js";
import { getCloneOperation, subscribeToClone } from "../repositories/cloneStore.js";
import AddFolderDialog from "./AddFolderDialog.jsx";
import CloneDialog, { useCloneDraft } from "./CloneDialog.jsx";
import ProjectAddMenu from "./ProjectAddMenu.jsx";
import ProjectDetail from "./ProjectDetail.jsx";
import ProjectListItem from "./ProjectListItem.jsx";
import { projectAttention } from "./project-presentation.js";
import { projectsRoute, projectsRoutePath } from "./routes.js";
import useProjectHub, { resolveProjectId } from "./useProjectHub.js";
import useSettledReplace from "../../lib/useSettledReplace.js";
import useMobileLayout from "../../lib/useMobileLayout.js";
import "./projects.css";

export default function ProjectsPage({
  route,
  onNavigate,
  home,
  defaultCwd,
  state,
  select,
  onLaunch,
  openNavigation,
  navigationOpen = false,
}) {
  const hub = useProjectHub();
  const { projects, reload } = hub;
  const operation = useSyncExternalStore(subscribeToClone, getCloneOperation);
  const draft = useCloneDraft({
    operation,
    defaultDirectory: defaultCwd || home || "",
    credentials: hub.credentials,
    loading: hub.loading,
  });
  const [dialog, setDialog] = useState(null);
  const mobile = useMobileLayout();
  const ready = !hub.loading;
  const canonical = resolveProjectId(projects, route.projectId);
  const project = projects.find((item) => item.id === canonical);
  const [retried, setRetried] = useState("");
  // Old links and other pages use repository, knowledge or AgentBus ids; the URL
  // settles on the joined project's id. Desktop opens the first project.
  const target = !ready
    ? null
    : route.projectId
      ? canonical && canonical !== route.projectId
        ? { ...route, projectId: canonical }
        : null
      : !mobile && projects.length
        ? { ...route, projectId: projects[0].id }
        : null;
  useSettledReplace({
    target,
    targetPath: target ? projectsRoutePath(target) : "",
    currentPath: projectsRoutePath(route),
    navigate: onNavigate,
  });
  useEffect(() => {
    if (
      !ready ||
      hub.error ||
      !route.projectId ||
      canonical ||
      retried === route.projectId
    )
      return;
    // A project added elsewhere (a new folder, a new session) is read once more.
    setRetried(route.projectId);
    reload();
  }, [ready, hub.error, route.projectId, canonical, retried, reload]);
  const clonedProjects = useRef(operation.projects);
  useEffect(() => {
    if (operation.projects === clonedProjects.current) return;
    clonedProjects.current = operation.projects;
    draft.setUrl("");
    draft.setFolderName("");
    if (dialog === "clone" && operation.projects[0]) {
      setDialog(null);
      onNavigate(projectsRoute({ projectId: operation.projects[0].id }));
    }
  }, [operation.projects, dialog, draft, onNavigate]);
  const choose = (projectId) =>
    onNavigate(projectsRoute({ projectId, projectTab: route.projectTab }));
  const missing =
    ready && route.projectId && !project && (retried === route.projectId || hub.error);
  const notices = (
    <>
      {operation.notice && (
        <p className="repository-notice" role="status">
          {operation.notice}
        </p>
      )}
      {!dialog && <ErrorMessage error={operation.error} />}
      {hub.error && (
        <div className="repository-load-error project-load-error">
          <p>{copy.partialError}</p>
          <ErrorMessage error={hub.error} />
          <button className="button secondary" onClick={hub.retry}>
            {commonCopy.retry}
          </button>
        </div>
      )}
    </>
  );
  const loadingStatus = (
    <p role="status" className="loading">
      {copy.loading}
    </p>
  );
  const missingCard = (
    <section className="project-card project-missing">
      <h2>{copy.notFound}</h2>
      <p>{copy.notFoundDescription}</p>
      <button type="button" className="button secondary" onClick={() => choose("")}>
        {copy.back}
      </button>
    </section>
  );
  const detail = (item) => (
    <ProjectDetail
      key={item.id}
      project={item}
      credentials={hub.credentials}
      route={route}
      onNavigate={onNavigate}
      sessions={state.sessions}
      select={select}
      onLaunch={onLaunch}
      mobile={mobile}
      reloadHub={reload}
      busProjects={hub.busProjects}
      busVersion={hub.busVersion}
      busNote={hub.busNote}
      busError={hub.errors.agentbus}
      home={home}
      attention={projectAttention(hub.attention, item.memoryId)}
      notices={mobile ? notices : null}
      onBack={() => choose("")}
    />
  );
  const dialogs = (
    <>
      {dialog === "clone" && (
        <CloneDialog
          draft={draft}
          operation={operation}
          credentials={hub.credentials}
          reload={0}
          close={() => setDialog(null)}
        />
      )}
      {dialog === "folder" && (
        <AddFolderDialog
          home={home}
          close={() => setDialog(null)}
          added={(added) => {
            setDialog(null);
            reload();
            onNavigate(projectsRoute({ projectId: added.id }));
          }}
        />
      )}
    </>
  );
  // Phones show a selected project as its own page with a back arrow.
  if (mobile && route.projectId)
    return (
      <>
        {project ? (
          detail(project)
        ) : (
          <SettingsShell
            className="projects-hub project-detail-shell"
            leading="back"
            onLeading={() => choose("")}
            leadingLabel={copy.back}
            title={copy.title}
          >
            {notices}
            {missing ? missingCard : loadingStatus}
          </SettingsShell>
        )}
        {dialogs}
      </>
    );
  const count =
    hub.loading && !projects.length ? unknownValue : copy.projectsCount(projects.length);
  const actions = mobile ? (
    <ProjectAddMenu
      label={copy.addMenu}
      items={[
        {
          id: "clone",
          label: commonCopy.cloneRepository,
          onSelect: () => setDialog("clone"),
        },
        { id: "folder", label: copy.addFolder, onSelect: () => setDialog("folder") },
      ]}
    />
  ) : (
    <>
      <button
        type="button"
        className="button secondary"
        onClick={() => setDialog("folder")}
      >
        {copy.addFolder}
      </button>
      <button type="button" className="button primary" onClick={() => setDialog("clone")}>
        <Icon name="plus" size={16} />
        {commonCopy.cloneRepository}
      </button>
    </>
  );
  return (
    <SettingsShell
      className="projects-hub"
      leading="menu"
      onLeading={openNavigation}
      navigationOpen={navigationOpen}
      title={copy.title}
      subtitle={`${count} · ${copy.subtle}`}
      description={copy.description}
      actions={actions}
    >
      {notices}
      {hub.loading && !projects.length ? (
        loadingStatus
      ) : !projects.length && !route.projectId ? (
        !hub.error && (
          <p className="project-empty">{repositoriesPageCopy.repositoryEmpty}</p>
        )
      ) : (
        <ListDetail
          className="project-list"
          listLabel={copy.listLabel}
          count={projects.length}
          items={projects}
          selectedId={route.projectId ? canonical || route.projectId : ""}
          onSelect={choose}
          renderItem={(item) => (
            <ProjectListItem
              item={item}
              attention={projectAttention(hub.attention, item.memoryId)}
            />
          )}
          detail={project ? detail(project) : missing ? missingCard : loadingStatus}
        />
      )}
      {dialogs}
    </SettingsShell>
  );
}
```

Then delete `topline` from `projectsHubCopy` in `web/lib/i18n/de/projects.js` and `web/lib/i18n/en/projects.js` after checking it is unused: `grep -rn "copy.topline\|projectsHubCopy.topline" web` must print nothing.

- [ ] **Step 5: Rewrite `ProjectDetail.jsx`**

Replace `web/features/projects/ProjectDetail.jsx` with:

```jsx
import React, { useEffect, useState } from "react";
import Icon from "../../components/Icon.jsx";
import SettingsShell from "../../components/SettingsShell.jsx";
import UnderlineTabs from "../../components/UnderlineTabs.jsx";
import api from "../../lib/api.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import {
  projectDialogsCopy as dialogsCopy,
  projectOverviewCopy as overviewCopy,
  projectsHubCopy as copy,
} from "../../lib/i18n/messages/projects.js";
import { repositoriesPageCopy } from "../../lib/i18n/messages/repositories.js";
import MergeDuplicateDialog from "./MergeDuplicateDialog.jsx";
import ProjectAgentBus from "./ProjectAgentBus.jsx";
import ProjectKnowledge from "./ProjectKnowledge.jsx";
import ProjectOverview from "./ProjectOverview.jsx";
import ProjectRuns from "./ProjectRuns.jsx";
import { projectSessions, remoteDisplay, remoteShort } from "./project-presentation.js";
import { projectsRoute } from "./routes.js";

function useRunTotal(memoryId) {
  const [total, setTotal] = useState(undefined);
  useEffect(() => {
    if (!memoryId) {
      setTotal(0);
      return;
    }
    let alive = true;
    setTotal(undefined);
    api(`/pipeline-runs?projectId=${encodeURIComponent(memoryId)}`)
      .then((data) => {
        if (alive) setTotal(data.total || 0);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [memoryId]);
  return total;
}

export default function ProjectDetail({
  project,
  credentials,
  route,
  onNavigate,
  sessions: allSessions,
  select,
  onLaunch,
  mobile,
  reloadHub,
  busProjects,
  busVersion,
  busNote,
  busError,
  home,
  attention,
  notices,
  onBack,
}) {
  const runTotal = useRunTotal(project.memoryId);
  const [merging, setMerging] = useState(false);
  // Older entries of this folder merge one at a time, the most recent first.
  const older = project.olderDuplicates?.[0];
  const sessions = projectSessions(allSessions, project);
  const credential = credentials.find((item) => item.id === project.credentialId);
  const branch = sessions.find((session) => session.branch)?.branch || "";
  const tab = route.projectTab || "overview";
  const meta = [
    project.remote ? remoteShort(project.remote) : copy.localOnly,
    branch,
    credential ? copy.tokenMeta(credential.name) : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const facts = [
    {
      label: overviewCopy.remote,
      value: remoteDisplay(project.remote) || copy.localOnly,
    },
    { label: overviewCopy.branch, value: branch || "—", mono: Boolean(branch) },
    { label: overviewCopy.tokenProfile, value: credential?.name || overviewCopy.noToken },
    { label: overviewCopy.folder, value: project.path, mono: true },
  ];
  const tabs = [
    { id: "overview", label: copy.tabOverview },
    { id: "knowledge", label: copy.tabKnowledge, count: project.entryCount },
    { id: "agentbus", label: copy.tabAgentBus, count: project.sessionCount },
    { id: "runs", label: copy.tabRuns, count: runTotal },
  ];
  const tabRow = (
    <UnderlineTabs
      label={copy.tabsLabel}
      tabs={tabs}
      selected={tab}
      onSelect={(projectTab) =>
        projectTab !== tab &&
        onNavigate(projectsRoute({ projectId: project.id, projectTab }))
      }
    />
  );
  const actions = (
    <>
      {older && (
        <button
          type="button"
          className="button secondary"
          onClick={() => setMerging(true)}
        >
          {dialogsCopy.mergeOlder}
        </button>
      )}
      <button
        type="button"
        className="button primary"
        aria-label={repositoriesPageCopy.buttonAriaLabel(project.name)}
        onClick={() => onLaunch(project.path)}
      >
        <Icon name="terminal" size={16} />
        {commonCopy.startSession}
      </button>
    </>
  );
  const panel = (
    <div
      className="project-tabpanel"
      role="tabpanel"
      id={`underline-tabpanel-${tab}`}
      aria-labelledby={`underline-tab-${tab}`}
    >
      {tab === "overview" && (
        <ProjectOverview
          projectId={project.id}
          facts={facts}
          sessions={sessions}
          select={select}
          attention={attention}
          onNavigate={onNavigate}
        />
      )}
      {tab === "knowledge" && (
        <ProjectKnowledge
          project={project}
          route={route}
          onNavigate={onNavigate}
          reloadHub={reloadHub}
        />
      )}
      {tab === "agentbus" && (
        <ProjectAgentBus
          request={api}
          project={project}
          busProjects={busProjects}
          busVersion={busVersion}
          busNote={busNote}
          busError={busError}
          reloadBus={reloadHub}
          route={route}
          onNavigate={(busTab, messagePage = 1, replace = false) =>
            onNavigate({ ...route, projectTab: "agentbus", busTab, messagePage }, replace)
          }
        />
      )}
      {tab === "runs" && (
        <ProjectRuns
          project={project}
          route={route}
          onNavigate={onNavigate}
          home={home}
          reloadHub={reloadHub}
        />
      )}
    </div>
  );
  const mergeDialog = merging && older && (
    <MergeDuplicateDialog
      project={project}
      older={older}
      close={() => setMerging(false)}
      merged={() => {
        setMerging(false);
        reloadHub();
      }}
    />
  );
  if (mobile)
    return (
      <SettingsShell
        className="projects-hub project-detail-shell"
        leading="back"
        onLeading={onBack}
        leadingLabel={copy.back}
        title={project.name}
        subtitle={meta}
        tabs={tabRow}
        bar={<div className="project-launch-bar">{actions}</div>}
      >
        {notices}
        {panel}
        {mergeDialog}
      </SettingsShell>
    );
  return (
    <section className="project-card" aria-labelledby="project-card-title">
      <header className="project-card-header">
        <div>
          <h2 id="project-card-title">{project.name}</h2>
          <span>{meta}</span>
        </div>
        <div className="project-card-primary">{actions}</div>
      </header>
      {tabRow}
      {panel}
      {mergeDialog}
    </section>
  );
}
```

Until Task 4 lands, `ProjectOverview` ignores the extra props.

- [ ] **Step 6: Pass the drawer props from App**

In `web/app/App.jsx`, in the `<ProjectsPage … />` element add after `onNavigate={navigate}`:

```jsx
openNavigation = { openNavigation };
navigationOpen = { mobileNav };
```

- [ ] **Step 7: Restyle the hub, list and detail frame**

In `web/features/projects/projects.css`:

(a) Replace everything from the top of the file through the `.project-tabpanel::-webkit-scrollbar { … }` block with:

```css
/* Projects hub in the settings pattern (handoff 2c/3e): SettingsShell header, project
   list, detail pane with underline tabs. Tab bodies are styled in project-tabs.css. */
.projects-hub .settings-shell-content {
  max-width: none;
}
.projects-hub .settings-shell-actions .button {
  height: 36px;
  gap: 8px;
  padding: 0 14px;
  font-size: 12px;
  white-space: nowrap;
}
.projects-hub .repository-notice,
.projects-hub .project-load-error {
  margin: 0 0 16px;
}
.project-add-menu {
  position: relative;
}
.project-add-trigger {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: 10px;
  color: #e8e8ec;
}
.project-add-popover {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  z-index: 20;
  display: grid;
  min-width: 200px;
  padding: 6px;
  border: 1px solid #303137;
  border-radius: 12px;
  background: #1b1c20;
  box-shadow: 0 18px 40px -12px #000;
}
.project-add-popover [role="menuitem"] {
  display: flex;
  align-items: center;
  min-height: 44px;
  padding: 0 12px;
  border-radius: 8px;
  font-size: 15px;
  color: #e8e8ec;
  text-align: left;
}
.project-add-popover [role="menuitem"]:hover,
.project-add-popover [role="menuitem"]:focus-visible {
  background: #232428;
}
.project-list .list-detail-caps {
  padding: 0 12px;
}
.project-list .list-detail-items {
  gap: 3px;
}
.project-list .list-detail-items > button {
  display: flex;
  align-items: center;
  gap: 12px;
  color: #e8e8ec;
}
.project-list .list-detail-items > button:hover {
  background: #222327;
}
.project-list .list-detail-items > button.selected {
  background: #26272b;
}
.project-item-icon {
  width: 30px;
  height: 30px;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid #303137;
  border-radius: 8px;
  background: #232428;
  color: #a2a3a7;
}
.project-list .selected .project-item-icon {
  color: #ffc99d;
}
.project-item-text {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.project-item-text strong {
  font-size: 14px;
  font-weight: 500;
  overflow-wrap: anywhere;
}
.project-list .selected .project-item-text strong {
  color: #ffc99d;
}
.project-item-text small {
  font-size: 12px;
  color: #92949d;
  overflow-wrap: anywhere;
}
.project-item-text .project-hint {
  display: flex;
  align-items: center;
  gap: 6px;
}
.project-hint::before {
  content: "";
  width: 6px;
  height: 6px;
  flex-shrink: 0;
  border-radius: 50%;
  background: currentColor;
}
.project-item-text .project-hint.decision {
  color: #ffc99d;
}
.project-item-text .project-hint.failed {
  color: #e7a3a3;
}
.project-item-chevron {
  display: none;
  flex-shrink: 0;
  color: #6f7075;
}
.project-card {
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: #16171b;
  border: 1px solid #28292d;
  border-radius: 12px;
}
.project-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 18px 22px 0;
}
.project-card-header > div:first-child {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.project-card-header h2 {
  font:
    700 18px "Manrope",
    sans-serif;
  overflow-wrap: anywhere;
}
.project-card-header span {
  font-size: 12px;
  color: #92949d;
  overflow-wrap: anywhere;
}
.project-card-primary {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}
.project-card-primary .button {
  height: 36px;
  gap: 8px;
  padding: 0 14px;
  font-size: 12px;
  white-space: nowrap;
}
/* The margin goes on the frame, not the inner tablist: the hover arrows anchor to the
   frame (Step 0 Task 7 review note). */
.project-card .underline-tabs-frame {
  margin: 12px 22px 0;
}
.project-tabpanel {
  min-width: 0;
  padding: 18px 22px 22px;
}
```

(b) Replace the whole `@media (max-width: 700px) { … }` block with:

```css
@media (max-width: 700px) {
  /* The page header replaces the app's own phone header on Projects. */
  .app:has(.projects-hub) .mobile-header {
    display: none;
  }
  .project-list .list-detail-caps {
    display: none;
  }
  .project-list .list-detail-items {
    gap: 1px;
    overflow: hidden;
    border: 1px solid #28292d;
    border-radius: 12px;
    background: #232428;
  }
  .project-list .list-detail-items > button,
  .project-list .list-detail-items > button.selected {
    min-height: 60px;
    padding: 10px 12px 10px 14px;
    border-radius: 0;
    background: #16171b;
  }
  .project-item-text strong {
    font-size: 15px;
  }
  .project-item-chevron {
    display: block;
  }
  .project-detail-shell .settings-shell-body {
    padding-bottom: 96px;
  }
  .project-launch-bar {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 5;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 12px calc(14px + env(safe-area-inset-bottom));
    border-top: 1px solid #28292d;
    background: #15161a;
  }
  .project-launch-bar .button {
    width: 100%;
    height: 44px;
    justify-content: center;
    gap: 8px;
    font-size: 13px;
    font-weight: 600;
  }
  .project-tabpanel {
    padding: 4px 0 0;
  }
  .project-empty {
    padding: 20px;
  }
  .clone-dialog .repository-clone-fields {
    grid-template-columns: minmax(0, 1fr);
  }
  .project-knowledge-toolbar form {
    flex-basis: 100%;
  }
  .project-knowledge-entry {
    padding: 12px 0;
  }
}
```

Keep every other block of the file unchanged (facts, sessions, empty, missing, runs, knowledge, clone fields, load/count errors); Tasks 4–7 move them.

- [ ] **Step 8: Update the existing specs and the clone helper**

In `tests/helpers/repository-browser.js` replace `openCloneDialog` with:

```js
// The clone form lives in the Projects hub's "Repository klonen" dialog; phones reach
// it through the header's "+" menu.
export async function openCloneDialog(page) {
  await page.locator(".settings-shell-actions").waitFor();
  const add = page
    .locator(".settings-shell-actions")
    .getByRole("button", { name: "Projekt hinzufügen", exact: true });
  if (await add.isVisible()) {
    await add.click();
    await page.getByRole("menuitem", { name: "Repository klonen", exact: true }).click();
  } else
    await page.getByRole("button", { name: "Repository klonen", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Repository klonen" });
  await expect(dialog).toBeVisible();
  return dialog;
}
```

In `tests/browser/projects.spec.js`, test "mobile shows the list first, then the detail, and dialogs fit as sheets":

- `expect(Math.round(box.height)).toBe(43);` → `expect(Math.round(box.height)).toBe(44);` (README: Projects bar primary h44; see Deviations).
- Replace `await page.getByRole("button", { name: "Repository klonen", exact: true }).click();` with:

```js
await page.getByRole("button", { name: "Projekt hinzufügen", exact: true }).click();
await page.getByRole("menuitem", { name: "Repository klonen", exact: true }).click();
```

In test "labels, hints and dialogs are translated": replace `await expect(page.getByText("WORKSPACE / PROJECTS")).toBeVisible();` with `await expect(page.getByText("From repository to your next session.", { exact: false })).toBeVisible();` (the topline is gone; the header description carries the page's chrome copy; see Deviations).

- [ ] **Step 9: Run the specs**

Run: `npm run build && npx playwright test tests/browser/projects-shell.spec.js tests/browser/projects.spec.js tests/browser/projects-duplicates.spec.js tests/browser/projects-hub-loading.spec.js tests/browser/repositories.spec.js tests/browser/repository-discovery.spec.js tests/browser/repository-search.spec.js tests/browser/workspace-files.spec.js tests/browser/preferences.spec.js tests/browser/memory.spec.js`
Expected: PASS. If the four phone tabs do not fit at 390px (`can-scroll-right` present), do not shrink fonts below README sizes; reduce `.project-detail-shell .underline-tabs button` padding to `0 12px` and re-run.

- [ ] **Step 10: Commit**

```bash
npx prettier --write web/features/projects web/app/App.jsx web/lib/i18n/de/projects.js web/lib/i18n/en/projects.js tests/browser/projects-shell.spec.js tests/browser/projects.spec.js tests/helpers/repository-browser.js
npx eslint web/features/projects web/app/App.jsx tests/browser/projects-shell.spec.js tests/browser/projects.spec.js tests/helpers/repository-browser.js
git add web/features/projects web/app/App.jsx web/lib/i18n/de/projects.js web/lib/i18n/en/projects.js tests/browser/projects-shell.spec.js tests/browser/projects.spec.js tests/helpers/repository-browser.js
git commit -m "feat: put the projects hub into the settings shell with a phone launch bar" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Übersicht (attention strips, facts card, session rows)

**Files:**

- Create: `web/features/projects/ProjectAttention.jsx`, `web/features/projects/project-tabs.css`
- Modify: `web/features/projects/ProjectOverview.jsx`, `web/features/projects/ProjectsPage.jsx` (import `./project-tabs.css`), `web/features/projects/projects.css` (remove overview blocks), `web/lib/i18n/{de,en}/projects.js` (remove unused `open`)
- Test: `tests/browser/projects-tabs.spec.js`

**Interfaces:**

- Consumes: `attentionTarget`, `hintCount` (Task 2); `GroupLabel` (Step 0); props from Task 3: `ProjectOverview({ projectId, facts, sessions, select, attention, onNavigate })`.
- Produces: `ProjectAttention({ projectId, attention, onNavigate })`; class `.project-attention-strip.decisions|.failed`; `project-tabs.css` imported by `ProjectsPage.jsx` (Tasks 5–7 append to it).

- [ ] **Step 1: Write the browser spec (fails: no strip)**

Create `tests/browser/projects-tabs.spec.js`:

```js
import { test, expect } from "@playwright/test";
import { baseURL as base } from "../helpers/browser.js";
import { hubFixture } from "./projects-fixture.js";

const phone = { width: 390, height: 844 };
const noOverflow = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
const panel = (page) => page.getByRole("tabpanel");

test("attention strips open the single run or the filtered run list", async ({
  page,
}) => {
  await hubFixture(page);
  await page.goto(base + "/projects/m1");
  const decision = panel(page).getByRole("button", {
    name: "1 Entscheidung erforderlich",
    exact: true,
  });
  await expect(decision).toBeVisible();
  await expect(panel(page).getByRole("button", { name: /fehlgeschlagen/ })).toHaveCount(
    0,
  );
  await decision.click();
  await expect(page).toHaveURL(/\/pipelines\/runs\/a$/);

  await page.goto(base + "/projects/m2");
  await panel(page)
    .getByRole("button", { name: "2 Läufe fehlgeschlagen", exact: true })
    .click();
  await expect(page).toHaveURL(/\/projects\/m2\?tab=runs&status=failed$/);
  await expect(
    page
      .getByRole("group", { name: "Status", exact: true })
      .getByRole("button", { name: /^Fehlgeschlagen/ }),
  ).toHaveAttribute("aria-pressed", "true");
});

test("the overview shows facts and sessions as list cards", async ({ page }) => {
  await page.setViewportSize(phone);
  await hubFixture(page);
  await page.goto(base + "/projects/m1");
  await expect(page.getByRole("heading", { name: "Projektdetails" })).toBeVisible();
  await expect(page.getByRole("definition").first()).toHaveText(
    "github.com/acme/agent-pier",
  );
  await expect(page.getByRole("heading", { name: "Sitzungen · 1" })).toBeVisible();
  await page.getByRole("button", { name: "Sitzung Hub fixture session öffnen" }).click();
  await expect(page).toHaveURL(/\/sessions\/s1\//);
});

test("a project without knowledge registration shows no attention strip", async ({
  page,
}) => {
  await hubFixture(page, { unregistered: true });
  await page.goto(base + "/projects/r2");
  await expect(page.getByRole("heading", { name: "loose", level: 2 })).toBeVisible();
  await expect(page.locator(".project-attention")).toHaveCount(0);
  await expect(page.getByRole("definition").first()).toBeVisible();
  expect(await noOverflow(page)).toBe(true);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run build && npx playwright test tests/browser/projects-tabs.spec.js`
Expected: FAIL (no "1 Entscheidung erforderlich" button in the tab panel).

- [ ] **Step 3: Add the strips and restyle the overview**

Create `web/features/projects/ProjectAttention.jsx`:

```jsx
import React from "react";
import Icon from "../../components/Icon.jsx";
import { projectsHubCopy as copy } from "../../lib/i18n/messages/projects.js";
import { attentionTarget, hintCount } from "./project-presentation.js";

// Waiting decisions and failed runs on top of the overview: one known run opens
// directly, several open the project's run list with the matching filter.
export default function ProjectAttention({ projectId, attention, onNavigate }) {
  const items = [
    { kind: "decisions", status: "awaiting-human", text: copy.decisions },
    { kind: "failed", status: "failed", text: copy.failedRuns },
  ].filter((item) => attention?.[item.kind]?.count > 0);
  if (!items.length) return null;
  return (
    <div className="project-attention">
      {items.map(({ kind, status, text }) => {
        const part = attention[kind];
        return (
          <button
            key={kind}
            type="button"
            className={`project-attention-strip ${kind}`}
            onClick={() => onNavigate(attentionTarget(projectId, status, part))}
          >
            <span className="dot" aria-hidden="true" />
            <span className="project-attention-text">
              {text(hintCount(part.count, part.capped))}
            </span>
            <Icon name="chevron" size={14} />
          </button>
        );
      })}
    </div>
  );
}
```

Replace the default export of `web/features/projects/ProjectOverview.jsx` (keep `units` and `relativeTime` unchanged) and its imports with:

```jsx
import React from "react";
import GroupLabel from "../../components/GroupLabel.jsx";
import Icon from "../../components/Icon.jsx";
import ProviderMark from "../../components/ProviderMark.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { projectOverviewCopy as copy } from "../../lib/i18n/messages/projects.js";
import { locale } from "../../lib/i18n/index.js";
import { names } from "../../lib/providers.js";
import ProjectAttention from "./ProjectAttention.jsx";
```

```jsx
export default function ProjectOverview({
  projectId,
  facts,
  sessions,
  select,
  attention,
  onNavigate,
}) {
  return (
    <div className="project-overview">
      <ProjectAttention
        projectId={projectId}
        attention={attention}
        onNavigate={onNavigate}
      />
      <GroupLabel as="h3">{copy.factsLabel}</GroupLabel>
      <dl className="list-card project-facts" aria-label={copy.factsLabel}>
        {facts.map((fact) => (
          <div key={fact.label} className="project-fact">
            <dt>{fact.label}</dt>
            <dd className={fact.mono ? "mono" : ""} title={fact.value}>
              {fact.value}
            </dd>
          </div>
        ))}
      </dl>
      <GroupLabel as="h3">{copy.sessions(sessions.length)}</GroupLabel>
      {sessions.length ? (
        <div className="list-card project-sessions">
          {sessions.map((session) => {
            const running = session.status === "running";
            return (
              <div className="list-row two-line" key={session.id}>
                <button
                  type="button"
                  className="list-row-main"
                  aria-label={copy.openSession(session.name)}
                  onClick={() => select(session)}
                >
                  <ProviderMark tool={session.tool} small />
                  <span className="list-row-text">
                    <span className="list-row-label">{session.name}</span>
                    <span className="list-row-sub">
                      {[
                        names[session.tool] || session.tool,
                        relativeTime(session.createdAt),
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                  <span className={`project-session-status ${running ? "running" : ""}`}>
                    <i aria-hidden="true" />
                    {running ? commonCopy.running : commonCopy.ended}
                  </span>
                  <Icon name="chevron" size={14} className="list-row-chevron" />
                </button>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="project-empty">{copy.noSessions}</p>
      )}
    </div>
  );
}
```

Remove `open` from `projectOverviewCopy` in both `web/lib/i18n/de/projects.js` and `web/lib/i18n/en/projects.js` after `grep -rn "overviewCopy.open\b\|projectOverviewCopy.open\b" web` prints nothing (`openSession` stays).

Create `web/features/projects/project-tabs.css`:

```css
/* Project tab bodies in the settings pattern: overview strips, facts and session rows,
   knowledge rows, AgentBus view, runs on phones. */
.project-overview > .group-label:first-child {
  margin-top: 0;
}
.project-attention {
  display: grid;
  gap: 8px;
}
.project-attention-strip {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 12px 14px;
  border: 1px solid #f49a5833;
  border-radius: 12px;
  background: #2a1f17;
  font-size: 14px;
  color: #ffc99d;
  text-align: left;
}
.project-attention-strip .dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #f49a58;
}
.project-attention-strip.failed {
  border-color: #d66a6a33;
  background: #2a1a1a;
  color: #e7a3a3;
}
.project-attention-strip.failed .dot {
  background: #d66a6a;
}
.project-attention-text {
  flex: 1;
  min-width: 0;
}
.project-facts {
  margin: 0;
}
.project-fact {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 46px;
  padding: 0 14px;
  background: #16171b;
}
.project-fact dt {
  flex: none;
  width: 96px;
  font-size: 13px;
  color: #92949d;
}
.project-fact dd {
  flex: 1;
  min-width: 0;
  margin: 0;
  overflow: hidden;
  font-size: 14px;
  color: #e8e8ec;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.project-fact dd.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 13px;
}
.project-sessions .list-row-main {
  min-height: 52px;
}
.project-sessions .provider-mark.small {
  flex: none;
  width: 30px;
  height: 30px;
  border-radius: 8px;
}
.project-session-status {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  font-size: 12px;
  color: #92949d;
  white-space: nowrap;
}
.project-session-status i {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #6f7075;
}
.project-session-status.running {
  color: #9fd3a8;
}
.project-session-status.running i {
  background: #5fbf75;
}
```

In `ProjectsPage.jsx` add `import "./project-tabs.css";` after `import "./projects.css";`.

In `projects.css` delete these now unused blocks: `.project-facts`, `.project-facts > div`, `.project-facts dt, .project-caps`, `.project-facts dd`, `.project-facts dd.mono`, `.project-caps`, `.project-sessions`, `.project-sessions li`, `.project-sessions .provider-mark.small`, `.project-session-name`, `.project-session-name strong`, `.project-session-name small`, `.project-session-status`, `.project-session-status i`, `.project-session-status.running i`, `.project-sessions .button`. Confirm first: `grep -rn "project-caps\|project-session-name" web` prints only `projects.css`.

- [ ] **Step 4: Run the specs**

Run: `npm run build && npx playwright test tests/browser/projects-tabs.spec.js tests/browser/projects.spec.js tests/browser/projects-shell.spec.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write web/features/projects web/lib/i18n/de/projects.js web/lib/i18n/en/projects.js tests/browser/projects-tabs.spec.js
npx eslint web/features/projects tests/browser/projects-tabs.spec.js
git add web/features/projects web/lib/i18n/de/projects.js web/lib/i18n/en/projects.js tests/browser/projects-tabs.spec.js
git commit -m "feat: show attention strips, a facts card and session rows on the project overview" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Wissen (search, segmented Aktiv/Archiv, ⓘ hint, entry list card)

**Files:**

- Create: `web/features/projects/ProjectKnowledgeEntry.jsx`
- Modify: `web/features/projects/ProjectKnowledge.jsx` (render below), `web/features/projects/project-tabs.css` (append), `web/features/projects/projects.css` (remove knowledge blocks)
- Modify: `tests/browser/memory.spec.js:138,143,296-301`, `tests/browser/projects-hub-loading.spec.js:80-87,109-113`
- Test: `tests/browser/projects-tabs.spec.js` (append)

**Interfaces:**

- Consumes: `Segmented`, `GroupLabel`, `ListCard`, `useInfoHint`/`InfoHintButton`/`InfoHintText` (Step 0).
- Produces: `ProjectKnowledgeEntry({ entry, open, onToggle(), busy, onEdit(), onHistory(), onArchive() })`. The Aktiv/Archiv control is `role="radiogroup"` named `memoryCopy.entries`; the entries card is `role="group"` labelled by the "Wissenseinträge" heading.

- [ ] **Step 1: Append the failing specs**

Append to `tests/browser/projects-tabs.spec.js`:

```js
test("the knowledge hint is a disclosure and the entry filter a deep-linked radio group", async ({
  page,
}) => {
  await hubFixture(page);
  await page.goto(base + "/projects/m1?tab=knowledge&archived=1");
  await expect(page.getByRole("tab", { name: /^Wissen/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const filter = page.getByRole("radiogroup", { name: "Wissenseinträge" });
  await expect(filter.getByRole("radio", { name: /^Archiv/ })).toBeChecked();
  const info = panel(page).getByRole("button", { name: "Hinweis anzeigen" });
  await expect(info).toHaveAttribute("aria-expanded", "false");
  const hint = page.locator(`[id="${await info.getAttribute("aria-controls")}"]`);
  await expect(hint).toBeHidden();
  await info.click();
  await expect(info).toHaveAttribute("aria-expanded", "true");
  await expect(hint).toHaveText(
    "Git-Worktrees teilen das Repository-Wissen. Andere Projekte bleiben getrennt. Einträge sind geteilte Notizen, keine automatisch geprüften Anweisungen.",
  );
  await info.click();
  await expect(hint).toBeHidden();
  await filter.getByRole("radio", { name: /^Aktiv/ }).check();
  await expect(page).toHaveURL(/\/projects\/m1\?tab=knowledge$/);
  await page.goBack();
  await expect(filter.getByRole("radio", { name: /^Archiv/ })).toBeChecked();
  await page.getByRole("button", { name: "Neuer Eintrag" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
});

test("a typed search and a tab switch never ask to save", async ({ page }) => {
  await hubFixture(page);
  await page.goto(base + "/projects/m1?tab=knowledge");
  await page.getByRole("textbox", { name: "Wissen suchen" }).fill("unsent");
  await page.getByRole("tab", { name: /^AgentBus/ }).click();
  await expect(page).toHaveURL(/\/projects\/m1\?tab=agentbus$/);
  await expect(page.getByRole("dialog", { name: "Änderungen speichern?" })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("region", { name: "Ungespeicherte Änderungen" }),
  ).toHaveCount(0);
});

test.describe("English knowledge tab pattern", () => {
  test.use({ locale: "en-GB" });

  test("hint, filter and new entry are translated on phones", async ({ page }) => {
    await page.setViewportSize(phone);
    await hubFixture(page);
    await page.goto(base + "/projects/m1?tab=knowledge");
    const filter = page.getByRole("radiogroup", { name: "Knowledge entries" });
    await expect(filter.getByRole("radio", { name: /^Active/ })).toBeChecked();
    await panel(page).getByRole("button", { name: "Show hint" }).click();
    await expect(
      page.getByText(/Git worktrees share repository knowledge/),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "New entry" })).toBeVisible();
    expect(await noOverflow(page)).toBe(true);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm run build && npx playwright test tests/browser/projects-tabs.spec.js -g "knowledge|search|English knowledge"`
Expected: FAIL (no radiogroup "Wissenseinträge").

- [ ] **Step 3: Extract the entry row**

Create `web/features/projects/ProjectKnowledgeEntry.jsx`:

```jsx
import React from "react";
import Icon from "../../components/Icon.jsx";
import { memoryCopy as copy } from "../../lib/i18n/messages/memory.js";
import { entryAuthor } from "../memory/memory-presentation.js";
import { relativeTime } from "./ProjectOverview.jsx";

// One knowledge entry: clicking the row or its title shows the full text and actions.
export default function ProjectKnowledgeEntry({
  entry,
  open,
  onToggle,
  busy,
  onEdit,
  onHistory,
  onArchive,
}) {
  const bodyId = `project-knowledge-body-${entry.id}`;
  const stopAnd = (run) => (event) => {
    event.stopPropagation();
    run();
  };
  return (
    <article className="project-knowledge-entry" onClick={onToggle}>
      <div className="project-knowledge-entry-head">
        <button
          type="button"
          className="project-knowledge-entry-toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={stopAnd(onToggle)}
        >
          <Icon name="chevron" size={14} className="project-knowledge-entry-chevron" />
          {entry.title}
        </button>
        <span className="project-knowledge-entry-time">
          {relativeTime(entry.updatedAt)}
        </span>
      </div>
      <div id={bodyId} className="project-knowledge-entry-body">
        <p className={open ? "expanded" : ""}>{entry.content}</p>
        <span className="project-knowledge-entry-meta">
          {entryAuthor(entry)} · {copy.version(entry.revision)}
        </span>
      </div>
      {open && (
        <div className="project-knowledge-entry-actions">
          {!entry.archived && (
            <button
              type="button"
              className="button secondary compact"
              aria-label={copy.edit(entry.title)}
              onClick={stopAnd(onEdit)}
            >
              {copy.editEntry}
            </button>
          )}
          <button
            type="button"
            className="button secondary compact"
            aria-label={copy.history(entry.title)}
            onClick={stopAnd(onHistory)}
          >
            {copy.historyTitle}
          </button>
          <button
            type="button"
            className="button secondary compact"
            aria-label={
              entry.archived ? copy.restore(entry.title) : copy.archive(entry.title)
            }
            disabled={busy}
            onClick={stopAnd(onArchive)}
          >
            {entry.archived ? copy.active : copy.archived}
          </button>
        </div>
      )}
    </article>
  );
}
```

- [ ] **Step 4: Rewrite the knowledge tab body**

In `web/features/projects/ProjectKnowledge.jsx`:

- Imports: change the React import to `import { useEffect, useId, useState } from "react";`; remove `Icon`, `relativeTime` and `entryAuthor` imports; add:

```js
import GroupLabel from "../../components/GroupLabel.jsx";
import { InfoHintButton, InfoHintText, useInfoHint } from "../../components/InfoHint.jsx";
import ListCard from "../../components/ListCard.jsx";
import Segmented from "../../components/Segmented.jsx";
import ProjectKnowledgeEntry from "./ProjectKnowledgeEntry.jsx";
```

and keep `memoryPaging, memoryPageCount` from `../memory/memory-presentation.js`.

- After `const counts = useEntryCounts(project.memoryId, countVersion);` add (before the early `if (!project.memoryId)` return, so hook order stays stable):

```js
const hint = useInfoHint();
const entriesHeading = useId();
```

- Replace the final `return ( <div className="project-knowledge"> … </div> );` (the registered branch; the `!project.memoryId` branch stays unchanged) with:

```jsx
return (
  <div className="project-knowledge">
    <form
      className="project-knowledge-search"
      onSubmit={(event) => {
        event.preventDefault();
        navigate({ query: search, memoryPage: 1 });
      }}
    >
      <input
        aria-label={copy.search}
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder={copy.search}
      />
      <button className="button secondary compact">{copy.search}</button>
    </form>
    <div className="project-knowledge-filter">
      <Segmented
        label={copy.entries}
        value={archived ? "archived" : "active"}
        options={[
          { value: "active", label: withCount(copy.active, counts.active) },
          { value: "archived", label: withCount(copy.archived, counts.archived) },
        ]}
        onChange={(value) => navigate({ archived: value === "archived", memoryPage: 1 })}
      />
      <InfoHintButton hint={hint} />
      <button
        type="button"
        className="button secondary compact"
        onClick={state.refresh}
        disabled={state.loading}
      >
        {commonCopy.refresh}
      </button>
    </div>
    <InfoHintText hint={hint}>{copy.tabHint}</InfoHintText>
    {counts.failed && (
      <CountUnavailable
        message={copy.countsUnavailable}
        onRetry={() => setCountVersion((value) => value + 1)}
      />
    )}
    <ErrorMessage error={state.error || action.error} />
    {state.loading && (
      <p role="status" className="loading">
        {commonCopy.pending}
      </p>
    )}
    <GroupLabel
      as="h3"
      id={entriesHeading}
      action={{
        label: (
          <>
            <span aria-hidden="true">+ </span>
            {copy.newEntry}
          </>
        ),
        onClick: () => setEditor({ entry: null }),
      }}
    >
      {copy.entries}
    </GroupLabel>
    {!state.loading && state.data?.items.length === 0 && (
      <p className="project-empty">{copy.empty}</p>
    )}
    {state.data?.items.length > 0 && (
      <ListCard labelledBy={entriesHeading} className="project-knowledge-entries">
        {state.data.items.map((entry) => (
          <ProjectKnowledgeEntry
            key={entry.id}
            entry={entry}
            open={expanded === entry.id}
            onToggle={() =>
              setExpanded((current) => (current === entry.id ? "" : entry.id))
            }
            busy={action.busy}
            onEdit={() => setEditor({ entry })}
            onHistory={() => setHistory(entry)}
            onArchive={() => changeArchive(entry)}
          />
        ))}
      </ListCard>
    )}
    {state.data && (
      <Pagination
        label={copy.entries}
        paging={memoryPaging(state.data, page, (next) => navigate({ memoryPage: next }))}
      />
    )}
    {editor && (
      <MemoryEditor
        projectId={project.memoryId}
        entry={editor.entry}
        close={() => setEditor(null)}
        saved={bump}
      />
    )}
    {history && (
      <MemoryHistory
        projectId={project.memoryId}
        entry={history}
        close={() => setHistory(null)}
      />
    )}
  </div>
);
```

`onToggle` uses the functional state update, so the row and its title button (which both call it) never toggle from a stale value.

- [ ] **Step 5: Move the knowledge styles**

Delete from `projects.css` every block whose selector starts with `.project-knowledge` (top level: `.project-knowledge`, `-toolbar`, `-toolbar form`, `-toolbar form input`, `-toolbar .button`, `-hint`, `-entries`, `-entry`, `-entry-head`, `-entry-toggle`, `-entry-toggle[aria-expanded="true"]`, `-entry-chevron`, `-entry-toggle[aria-expanded="true"] .project-knowledge-entry-chevron`, `-entry-time`, `-entry-body`, `-entry-body p`, `-entry-body p.expanded`, `-entry-meta`, `-entry-actions`, `-entry-actions .button`) and, inside the `@media (max-width: 700px)` block, `.project-knowledge-toolbar form` and `.project-knowledge-entry`.

Append to `project-tabs.css`:

```css
.project-knowledge {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.project-knowledge-search {
  display: flex;
  gap: 8px;
  min-width: 0;
}
.project-knowledge-search input {
  flex: 1;
  min-width: 0;
  height: 44px;
  border-radius: 10px;
}
.project-knowledge-search .button,
.project-knowledge-filter > .button {
  height: 38px;
  white-space: nowrap;
}
.project-knowledge-filter {
  display: flex;
  align-items: center;
  gap: 8px;
}
.project-knowledge-filter .segmented {
  flex: 1;
  min-width: 0;
}
.project-knowledge > .group-label {
  margin: 10px 0 0;
}
.project-knowledge .info-hint-text {
  margin: 0;
}
.project-knowledge-entry {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 12px 12px 14px;
  background: #16171b;
  cursor: pointer;
}
.project-knowledge-entry-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}
.project-knowledge-entry-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 0;
  border: 0;
  background: none;
  font-size: 15px;
  font-weight: 500;
  color: #e8e8ec;
  text-align: left;
  cursor: pointer;
  overflow-wrap: anywhere;
}
.project-knowledge-entry-toggle[aria-expanded="true"] {
  color: #ffc99d;
}
.project-knowledge-entry-chevron {
  flex-shrink: 0;
  color: #6f7075;
  transition: transform 0.15s ease;
}
.project-knowledge-entry-toggle[aria-expanded="true"] .project-knowledge-entry-chevron {
  transform: rotate(90deg);
}
.project-knowledge-entry-time {
  flex-shrink: 0;
  font-size: 12px;
  color: #92949d;
}
.project-knowledge-entry-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.project-knowledge-entry-body p {
  display: -webkit-box;
  margin: 0;
  overflow: hidden;
  font-size: 13px;
  line-height: 1.5;
  color: #a2a3a7;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
.project-knowledge-entry-body p.expanded {
  overflow: visible;
  -webkit-line-clamp: unset;
}
.project-knowledge-entry-meta {
  font-size: 12px;
  color: #92949d;
}
.project-knowledge-entry-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
}
.project-knowledge-entry-actions .button {
  height: 32px;
  padding: 0 10px;
  font-size: 12px;
}
@media (max-width: 700px) {
  .project-knowledge-filter {
    flex-wrap: wrap;
  }
  .project-knowledge-filter .segmented {
    flex-basis: calc(100% - 28px);
  }
}
```

- [ ] **Step 6: Update the existing specs (locators only)**

`tests/browser/memory.spec.js`:

- line 138 `await page.getByRole("button", { name: /^Archiv ·/ }).click();` → `await page.getByRole("radio", { name: /^Archiv ·/ }).check();`
- line 143 `await page.getByRole("button", { name: /^Aktiv ·/ }).click();` → `await page.getByRole("radio", { name: /^Aktiv ·/ }).check();`
- English test: `getByRole("button", { name: /^Active ·/ })` → `getByRole("radio", { name: /^Active ·/ })`, same for `/^Archive ·/`; before `await expect(page.getByText(/Git worktrees share repository knowledge/)).toBeVisible();` insert `await page.getByRole("button", { name: "Show hint" }).click();` (the hint now sits behind ⓘ).

`tests/browser/projects-hub-loading.spec.js`:

- "failed entry counts …": `const segment = page.getByRole("group", { name: "Wissenseinträge" });` → `const segment = page.getByRole("radiogroup", { name: "Wissenseinträge" });` and both `segment.getByRole("button")` → `segment.locator("label")`.
- English: `page.getByRole("group", { name: "Knowledge entries" }).getByRole("button")` → `page.getByRole("radiogroup", { name: "Knowledge entries" }).locator("label")`.

- [ ] **Step 7: Run the specs**

Run: `npm run build && npx playwright test tests/browser/projects-tabs.spec.js tests/browser/memory.spec.js tests/browser/projects-hub-loading.spec.js tests/browser/projects.spec.js`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
npx prettier --write web/features/projects tests/browser/projects-tabs.spec.js tests/browser/memory.spec.js tests/browser/projects-hub-loading.spec.js
npx eslint web/features/projects tests/browser/projects-tabs.spec.js tests/browser/memory.spec.js tests/browser/projects-hub-loading.spec.js
git add web/features/projects tests/browser/projects-tabs.spec.js tests/browser/memory.spec.js tests/browser/projects-hub-loading.spec.js
git commit -m "feat: restyle project knowledge with a segmented filter, hint disclosure and entry card" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: AgentBus (segmented radios, connected label, session rows)

**Files:**

- Modify: `web/features/projects/ProjectAgentBus.jsx` (toolbar and status list), `web/features/agentbus/agentbus.css:1-65`
- Modify: `tests/browser/agentbus.spec.js:66-74,162`, `tests/browser/navigation.spec.js:247-249,277,282`, `tests/browser/projects-hub-loading.spec.js:94-100,117-119`
- Test: `tests/browser/projects-tabs.spec.js` (append)

**Interfaces:**

- Consumes: `Segmented`, `GroupLabel` (Step 0).
- Produces: the Sitzungen/Nachrichten control is `role="radiogroup"` named `projectAgentBusCopy.tabsLabel`; group label `<h3>` = `connectedCount(n)`; line `.project-agentbus-status` = `pendingCount(n) · versionLabel(v)`.

- [ ] **Step 1: Append the failing spec**

Append to `tests/browser/projects-tabs.spec.js`:

```js
const emptyMessages = async (route, url) => {
  if (!url.pathname.endsWith("/messages")) return false;
  await route.fulfill({ json: { messages: [], page: 1, pageSize: 20, total: 0 } });
  return true;
};

test("the AgentBus view switch is a radio group bound to the address", async ({
  page,
}) => {
  await hubFixture(page, { intercept: emptyMessages });
  await page.goto(base + "/projects/m1?tab=agentbus&bus=messages");
  const view = page.getByRole("radiogroup", { name: "AgentBus-Ansicht" });
  await expect(view.getByRole("radio", { name: /^Nachrichten/ })).toBeChecked();
  await view.getByRole("radio", { name: /^Sitzungen/ }).check();
  await expect(page).toHaveURL(/\/projects\/m1\?tab=agentbus$/);
  await expect(page.getByRole("heading", { name: "0 verbunden" })).toBeVisible();
  await expect(page.getByText("0 Nachrichten warten · Version test")).toBeVisible();
  await expect(
    page.getByRole("article").filter({ hasText: "Hub fixture session" }),
  ).toBeVisible();
  await page.goBack();
  await expect(view.getByRole("radio", { name: /^Nachrichten/ })).toBeChecked();
});

test.describe("English AgentBus pattern", () => {
  test.use({ locale: "en-GB" });

  test("the view switch and counts are translated on phones", async ({ page }) => {
    await page.setViewportSize(phone);
    await hubFixture(page, { intercept: emptyMessages });
    await page.goto(base + "/projects/m1?tab=agentbus");
    const view = page.getByRole("radiogroup", { name: "AgentBus view" });
    await expect(view.getByRole("radio", { name: /^Sessions · 1/ })).toBeChecked();
    await expect(page.getByRole("heading", { name: "0 connected" })).toBeVisible();
    expect(await noOverflow(page)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run build && npx playwright test tests/browser/projects-tabs.spec.js -g "AgentBus"`
Expected: FAIL (no radiogroup "AgentBus-Ansicht").

- [ ] **Step 3: Rewrite the AgentBus toolbar and status list**

In `web/features/projects/ProjectAgentBus.jsx` add imports:

```js
import GroupLabel from "../../components/GroupLabel.jsx";
import Segmented from "../../components/Segmented.jsx";
```

Replace the `<div className="project-agentbus-toolbar"> … </div>` block with:

```jsx
<div className="project-agentbus-toolbar">
  <Segmented
    label={copy.tabsLabel}
    value={busTab}
    options={[
      { value: "status", label: projectOverviewCopy.sessions(sessions.length) },
      {
        value: "messages",
        label:
          messagesTotal === null
            ? copy.messagesLabel
            : copy.messagesSegment(messagesTotal),
      },
    ]}
    onChange={changeTab}
  />
  {busProject && (
    <p className="project-agentbus-status">
      {copy.pendingCount(pending)} · {copy.versionLabel(busVersion)}
    </p>
  )}
</div>
```

In the status branch replace the whole `<div className="project-agentbus-list"> … </div>` element (the `busNote` line above it stays) with (the `sessions.map` callback is today's code, unchanged):

```jsx
<GroupLabel as="h3">{copy.connectedCount(connected)}</GroupLabel>;
{
  sessions.length > 0 && (
    <div className="list-card project-agentbus-list">
      {sessions.map((session) => {
        const reloadRequired = session.reasonCode === "AGENTBUS_RELOAD_REQUIRED";
        const tone = reloadRequired ? "decision" : session.registered ? "ok" : "neutral";
        const label = reloadRequired
          ? copy.reloadRequired
          : session.registered
            ? commonCopy.connected
            : session.status === "running"
              ? copy.waitingForSignIn
              : commonCopy.ended;
        return (
          <article className="project-agentbus-session" key={session.id}>
            <div className="project-agentbus-session-details">
              <h3>{session.name}</h3>
              <div className="project-agentbus-session-meta">
                <span>{names[session.tool] || session.tool}</span>
                <StatusChip tone={tone}>{label}</StatusChip>
              </div>
              {reloadRequired ? (
                <p>{copy.reloadRequiredDescription}</p>
              ) : (
                session.reason && <p>{session.reason}</p>
              )}
            </div>
            <span className="agentbus-pending">
              {session.pending || 0}
              {copy.agentbusPending}
            </span>
          </article>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Restyle the project AgentBus rows**

In `web/features/agentbus/agentbus.css` replace the blocks `.project-agentbus-toolbar` through `.agentbus-pending` (lines 1–65; `.agentbus-pending` is only used by `ProjectAgentBus.jsx`, confirm with `grep -rn "agentbus-pending" web`) with:

```css
.project-agentbus-toolbar {
  display: grid;
  gap: 8px;
  margin: 0 0 4px;
}
.project-agentbus-status {
  padding: 0 4px;
  font-size: 12px;
  color: #92949d;
}
.project-agentbus-list {
  margin: 0 0 20px;
}
.project-agentbus-session {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  min-height: 58px;
  padding: 10px 12px 10px 14px;
  background: #16171b;
}
.project-agentbus-session-details {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.project-agentbus-session-details h3 {
  font-size: 15px;
  font-weight: 400;
  overflow-wrap: anywhere;
}
.project-agentbus-session-details p {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: #a2a3a7;
  overflow-wrap: anywhere;
}
.project-agentbus-session-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 12px;
  color: #92949d;
}
.agentbus-pending {
  flex: none;
  font-size: 12px;
  color: #92949d;
  white-space: nowrap;
}
```

- [ ] **Step 5: Update the existing specs (locators only)**

`tests/browser/agentbus.spec.js`:

- lines 66–71: `page.getByRole("tab", { name: "Sitzungen · 2", exact: true })` → `page.getByRole("radio", { name: "Sitzungen · 2", exact: true })`; same for `"Nachrichten · 3"`.
- lines 72–74 (the combined status line is now a heading plus a line; both facts stay asserted):

```js
await expect(page.getByRole("heading", { name: "1 verbunden" })).toBeVisible();
await expect(page.getByText("2 Nachrichten warten · Version 0.1.0")).toBeVisible();
```

- line 162: `await page.getByRole("tab", { name: /^Nachrichten/ }).click();` → `await page.getByRole("radio", { name: /^Nachrichten/ }).check();`

`tests/browser/navigation.spec.js`:

- lines 247–250: `await expect(page.getByRole("tab", { name: /^Nachrichten/ })).toHaveAttribute("aria-selected", "true");` → `await expect(page.getByRole("radio", { name: /^Nachrichten/ })).toBeChecked();`
- line 277: `await page.getByRole("tab", { name: /^Nachrichten/ }).click();` → `await page.getByRole("radio", { name: /^Nachrichten/ }).check();`
- line 282: `await page.getByRole("tab", { name: /^Sitzungen/ }).click();` → `await page.getByRole("radio", { name: /^Sitzungen/ }).check();`

`tests/browser/projects-hub-loading.spec.js`:

- "a failed message count …": `page.getByRole("tablist", { name: "AgentBus-Ansicht" })` → `page.getByRole("radiogroup", { name: "AgentBus-Ansicht" })`; both `segment.getByRole("tab")` → `segment.locator("label")`.
- English: `page.getByRole("tablist", { name: "AgentBus view" }).getByRole("tab")` → `page.getByRole("radiogroup", { name: "AgentBus view" }).locator("label")`.

- [ ] **Step 6: Run the specs**

Run: `npm run build && npx playwright test tests/browser/projects-tabs.spec.js tests/browser/agentbus.spec.js tests/browser/navigation.spec.js tests/browser/projects-hub-loading.spec.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
npx prettier --write web/features/projects/ProjectAgentBus.jsx web/features/agentbus/agentbus.css tests/browser/projects-tabs.spec.js tests/browser/agentbus.spec.js tests/browser/navigation.spec.js tests/browser/projects-hub-loading.spec.js
npx eslint web/features/projects tests/browser/projects-tabs.spec.js tests/browser/agentbus.spec.js tests/browser/navigation.spec.js tests/browser/projects-hub-loading.spec.js
git add web/features/projects/ProjectAgentBus.jsx web/features/agentbus/agentbus.css tests/browser/projects-tabs.spec.js tests/browser/agentbus.spec.js tests/browser/navigation.spec.js tests/browser/projects-hub-loading.spec.js
git commit -m "feat: switch the project AgentBus view with a segmented control and list its sessions as rows" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Läufe (filter pills, run rows on phones)

**Files:**

- Modify: `web/features/pipelines/run-table.css` (filter pill blocks), `web/features/projects/project-tabs.css` (append), `web/features/projects/projects.css` (remove `.project-runs-table .run-toolbar`)
- Test: `tests/browser/projects-tabs.spec.js` (append)

**Interfaces:**

- Consumes: Step 0 fade on `RunStatusFilter` (`can-scroll-left/right` on `.run-status-filters`).
- Produces: pill look for `.run-status-filters button` (also on Pipelines → Läufe); `.project-runs-table` list-card look below 701px.

- [ ] **Step 1: Append the failing spec**

Append to `tests/browser/projects-tabs.spec.js`:

```js
test("run filter chips are pills that fade at the hidden edge on phones", async ({
  page,
}) => {
  await page.setViewportSize(phone);
  await hubFixture(page);
  await page.goto(base + "/projects/m1?tab=runs");
  const filter = page.getByRole("group", { name: "Status", exact: true });
  await expect(filter.getByRole("button")).toHaveCount(4);
  await expect(filter.getByRole("button").first()).toHaveCSS("border-radius", "999px");
  await expect(filter.getByRole("button").first()).toHaveCSS("height", "32px");
  await expect(filter).toHaveClass(/can-scroll-right/);
  await filter.getByRole("button", { name: /^Abgeschlossen/ }).click();
  await expect(page).toHaveURL(/\/projects\/m1\?tab=runs&status=completed$/);
  await expect(filter).toHaveClass(/can-scroll-left/);
  const row = page
    .getByRole("row")
    .filter({ has: page.getByRole("button", { name: /^Lauf öffnen:/ }) })
    .first();
  const title = await row.locator(".run-table-title").boundingBox();
  const status = await row.locator(".run-table-status").boundingBox();
  expect(status.y).toBeGreaterThanOrEqual(title.y + title.height - 1);
  await expect(
    page.getByRole("button", { name: "Lauf starten", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Aktualisieren", exact: true }),
  ).toBeVisible();
  expect(await noOverflow(page)).toBe(true);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run build && npx playwright test tests/browser/projects-tabs.spec.js -g "pills"`
Expected: FAIL (border-radius is `6px`).

- [ ] **Step 3: Restyle the pills**

In `web/features/pipelines/run-table.css` replace the blocks `.run-status-filters button`, `.run-status-filters button:hover`, `.run-status-filters button[aria-pressed="true"]` and `.run-status-count` with:

```css
.run-status-filters button {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 7px;
  height: 32px;
  padding: 0 12px;
  border: 1px solid #303137;
  border-radius: 999px;
  background: transparent;
  font-size: 13px;
  color: #c4c5c9;
  white-space: nowrap;
}
.run-status-filters button:hover {
  background: #202125;
}
.run-status-filters button[aria-pressed="true"] {
  border-color: #f49a5833;
  background: #30261c;
  color: #ffc99d;
}
.run-status-count {
  font-size: 12px;
  color: #92949d;
}
.run-status-filters button[aria-pressed="true"] .run-status-count {
  color: #d9b597;
}
```

In `projects.css` delete `.project-runs-table .run-toolbar { margin-top: 16px; }`. Append to `project-tabs.css`:

```css
.project-runs-table .run-toolbar {
  margin: 0 0 12px;
}
@media (max-width: 700px) {
  .project-runs-table .run-toolbar {
    flex-direction: column;
    align-items: stretch;
  }
  .project-runs-table .run-toolbar-actions {
    justify-content: flex-end;
  }
  .project-runs-table .run-table {
    gap: 1px;
    overflow: hidden;
    border: 1px solid #28292d;
    border-radius: 12px;
    background: #232428;
  }
  .project-runs-table .run-table .run-table-row {
    border: 0;
    border-radius: 0;
    background: #16171b;
  }
  .project-runs-table .run-table .run-table-row.run-table-status-awaiting-human {
    background: #1d1915;
  }
}
```

- [ ] **Step 4: Run the specs (Projects and Pipelines share the filter)**

Run: `npm run build && npx playwright test tests/browser/projects-tabs.spec.js tests/browser/projects.spec.js tests/browser/pipelines-runs.spec.js tests/browser/pipelines-run-polling.spec.js tests/browser/settings-pattern-tabs.spec.js`
Expected: PASS (`pipelines-runs.spec.js` still asserts pill height 32 and the awaiting-row colour `rgb(29, 25, 21)`).

- [ ] **Step 5: Commit**

```bash
npx prettier --write web/features/pipelines/run-table.css web/features/projects/project-tabs.css web/features/projects/projects.css tests/browser/projects-tabs.spec.js
git add web/features/pipelines/run-table.css web/features/projects/project-tabs.css web/features/projects/projects.css tests/browser/projects-tabs.spec.js
git commit -m "feat: show run filters as pills and project runs as a card on phones" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Feature coverage check, full gate and screenshots

**Files:**

- Temporary (not committed): `tests/browser/zz-projects-screenshots.spec.js`
- Output (git-ignored): `/Users/d.kaulig/Projects/agent-pier/.worktrees/settings-projects/.superpowers/screenshots/projects/`

**Interfaces:**

- Consumes: everything from Tasks 1–7; `hubFixture` from `tests/browser/projects-fixture.js`.
- Produces: green gate, screenshots for the PR, the coverage table below copied into the PR description.

- [ ] **Step 1: Walk the coverage checklist**

Every action the current Projects page offers, its new place, and the test that exercises it. Open each in the built app (`npm run build && npm start`, `http://127.0.0.1:4380/projects`, use a disposable data dir: `AGENTPIER_DATA_DIR=$(mktemp -d) npm start` if your setup uses it) in English and German at 390×844 and 1280×800 and tick it; anything missing is a bug in the owning task.

| #   | Current action / state                                         | New place                                                           | Covered by                                                           |
| --- | -------------------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 1   | Open the app drawer (global phone header)                      | SettingsShell sidebar button on the phone list                      | projects-shell "drawer button"                                       |
| 2   | New session "+" in global phone header                         | Sidebar drawer "Neue Sitzung"; on a project the launch bar          | projects-shell (bar), sidebar specs                                  |
| 2a  | AgentPier brand in global phone header (back to the dashboard) | Drawer menu "Übersicht" (header hidden on Projects; see Deviations) | sidebar-menu.spec, manual                                            |
| 3   | Add folder                                                     | Desktop header button; phone "+" menu                               | projects.spec "folder is added", projects-shell                      |
| 4   | Clone repository (+ notice, error, completion opens project)   | Desktop header button; phone "+" menu; notices above content        | repositories.spec, repository-discovery/search, projects.spec mobile |
| 5   | Partial source error + "Erneut versuchen"                      | Notice block above list / phone detail                              | projects.spec "failing source"                                       |
| 6   | Loading / empty list                                           | Shell body                                                          | projects-hub-loading.spec                                            |
| 7   | Choose a project; old ids resolve; desktop opens the first     | ListDetail (desktop), list then own page (phone)                    | projects.spec first test                                             |
| 8   | List attention hints ("100+" when capped)                      | ProjectListItem                                                     | projects.spec, project-attention unit                                |
| 9   | Unknown project + "Alle Projekte"                              | Missing card (desktop), back header (phone)                         | projects.spec, projects-shell "unknown project"                      |
| 10  | Merge older entry                                              | Detail header (desktop), launch bar (phone)                         | projects-duplicates.spec                                             |
| 11  | Start session in project                                       | Detail header (desktop), launch bar h44 (phone)                     | projects.spec mobile, repositories.spec, projects-shell              |
| 12  | Tabs with counts; deep links `?tab=`                           | UnderlineTabs (Wissen label)                                        | projects-shell, navigation.spec                                      |
| 13  | Facts (remote, branch, token, folder)                          | Facts list card                                                     | projects.spec, projects-tabs overview                                |
| 14  | Sessions list, running/ended, open session                     | Session rows                                                        | projects.spec, projects-tabs overview                                |
| 15  | (new) Attention strip                                          | Übersicht top                                                       | projects-tabs strips                                                 |
| 16  | Register folder for knowledge / runs                           | Unchanged empty states                                              | memory.spec, projects.spec                                           |
| 17  | Search knowledge                                               | Search field + "Wissen suchen"                                      | memory.spec obsolete-result test                                     |
| 18  | Aktiv/Archiv with counts, count failure + retry                | Segmented radios + CountUnavailable                                 | projects-hub-loading, projects-tabs                                  |
| 19  | Refresh knowledge                                              | Filter row button                                                   | manual                                                               |
| 20  | Tab hint text                                                  | ⓘ disclosure                                                        | projects-tabs, memory.spec EN                                        |
| 21  | New entry                                                      | "+ Neuer Eintrag" on group label                                    | memory.spec, projects-tabs                                           |
| 22  | Expand entry; edit; history; archive/restore                   | Entry rows in list card                                             | memory.spec                                                          |
| 23  | Knowledge paging + page normalisation                          | Pagination under the card                                           | memory.spec paged tests                                              |
| 24  | Sitzungen/Nachrichten switch, `bus=messages`                   | Segmented radios                                                    | agentbus.spec, navigation.spec, projects-tabs                        |
| 25  | Connected / pending / version                                  | Group label + status line                                           | agentbus.spec, projects-tabs                                         |
| 26  | Message count + failure retry                                  | Segment label + CountUnavailable                                    | projects-hub-loading                                                 |
| 27  | AgentBus error + "Neu laden", AgentBus note                    | Unchanged, above rows                                               | agentbus.spec                                                        |
| 28  | Session state chip, reload required, reason, inbox count       | Session rows                                                        | agentbus.spec (DE + EN)                                              |
| 29  | Message log paging                                             | MessageLog unchanged                                                | navigation.spec                                                      |
| 30  | Run status filter with counts, deep link `status=`             | Pills with fade                                                     | projects.spec runs, projects-tabs pills                              |
| 31  | Refresh runs, "Lauf starten" dialog                            | Run toolbar                                                         | projects.spec runs                                                   |
| 32  | Open run (title button and row click), paging, polling         | RunTable (table on desktop, card on phone)                          | projects.spec runs, pipelines-run-polling                            |
| 33  | Hub polls pause while hidden                                   | Unchanged hooks                                                     | projects.spec poll tests                                             |

- [ ] **Step 2: Run the full gate**

Run: `npm run check`
Expected: lint, format, structure (≤600 lines), build and all node suites pass.

Run: `npx playwright test tests/browser/projects-shell.spec.js tests/browser/projects-tabs.spec.js tests/browser/projects.spec.js tests/browser/projects-hub-loading.spec.js tests/browser/projects-duplicates.spec.js tests/browser/memory.spec.js tests/browser/agentbus.spec.js tests/browser/navigation.spec.js tests/browser/repositories.spec.js tests/browser/repository-discovery.spec.js tests/browser/repository-search.spec.js tests/browser/workspace-files.spec.js tests/browser/preferences.spec.js tests/browser/pipelines-runs.spec.js tests/browser/pipelines-run-polling.spec.js tests/browser/settings-pattern-tabs.spec.js tests/browser/sidebar.spec.js`
Expected: PASS.

Run the whole browser suite once: `npm run test:e2e`
Expected: PASS.

WebKit: `AGENTPIER_TEST_BROWSER=webkit npx playwright test tests/browser/projects-shell.spec.js tests/browser/projects-tabs.spec.js tests/browser/projects.spec.js tests/browser/memory.spec.js tests/browser/agentbus.spec.js` (install with `npx playwright install webkit` if missing)
Expected: PASS.

- [ ] **Step 3: Capture screenshots**

Create the temporary `tests/browser/zz-projects-screenshots.spec.js`:

```js
import path from "node:path";
import { test } from "@playwright/test";
import { baseURL as base } from "../helpers/browser.js";
import { hubFixture } from "./projects-fixture.js";

const out = process.env.SCREENSHOT_DIR;
const sizes = {
  mobile: { width: 390, height: 844 },
  desktop: { width: 1280, height: 800 },
};
const tabs = ["overview", "knowledge", "agentbus", "runs"];

for (const locale of ["de-DE", "en-GB"])
  test.describe(locale, () => {
    test.use({ locale });
    for (const [size, viewport] of Object.entries(sizes))
      test(`projects ${size}`, async ({ page }) => {
        test.setTimeout(120000);
        test.skip(!out, "SCREENSHOT_DIR is not set");
        await page.setViewportSize(viewport);
        await hubFixture(page, {
          intercept: async (route, url) => {
            if (!url.pathname.endsWith("/messages")) return false;
            await route.fulfill({
              json: { messages: [], page: 1, pageSize: 20, total: 0 },
            });
            return true;
          },
        });
        const lang = locale.slice(0, 2);
        const shot = (name) =>
          page.screenshot({ path: path.join(out, `${lang}-${size}-${name}.png`) });
        if (size === "mobile") {
          await page.goto(base + "/projects");
          await page.locator(".project-list").waitFor();
          await shot("list");
          await page.locator(".project-add-trigger").click();
          await shot("add-menu");
          await page.keyboard.press("Escape");
        }
        for (const tab of tabs) {
          await page.goto(
            `${base}/projects/m1${tab === "overview" ? "" : `?tab=${tab}`}`,
          );
          await page.getByRole("tab", { selected: true }).waitFor();
          await page.waitForTimeout(500);
          await shot(tab);
          if (tab === "knowledge") {
            await page.getByRole("tabpanel").locator(".info-hint-button").click();
            await shot("knowledge-hint");
          }
        }
      });
  });
```

Run:

```bash
mkdir -p /Users/d.kaulig/Projects/agent-pier/.worktrees/settings-projects/.superpowers/screenshots/projects
SCREENSHOT_DIR=/Users/d.kaulig/Projects/agent-pier/.worktrees/settings-projects/.superpowers/screenshots/projects npx playwright test tests/browser/zz-projects-screenshots.spec.js
rm tests/browser/zz-projects-screenshots.spec.js
git status --short
```

Expected: 4 tests pass; the folder holds 24 PNGs (`de|en` × mobile: list, add-menu, 4 tabs, knowledge-hint; desktop: 4 tabs, knowledge-hint); `git status` shows no untracked spec. Look at every screenshot: no clipped header, four tabs fit on phones, bar at the bottom, English text in `en-*` files.

- [ ] **Step 4: Commit any fixes found in Steps 1–3**

Only if Steps 1–3 required changes:

```bash
git add -A web tests
git commit -m "fix: <what the check found>" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Then re-run `npm run check` and the browser list from Step 2.

---

## Deviations (for the PR description)

- **Topline removed.** "WORKSPACE / PROJEKTE" disappears; the pattern header shows title + description (desktop) or title + "n Projekte · Lokal gespeichert" (phone). The English spec now asserts the description instead of the topline.
- **Global phone header hidden on Projects.** The page header (sidebar button, "+" menu) replaces it; "Neue Sitzung" and the dashboard ("Übersicht") stay in the drawer and "Sitzung starten" in the project bar. A project detail on phones has a back arrow, not the drawer button (README).
- **Launch button 43 → 44px.** README: Projects bar primary h44. `projects.spec.js` asserts 44.
- **Attention strip also for failed runs.** README draws only decisions; the spec's "attention strip" and the list hints cover both, so failed runs get a red strip with the same one-run/several-runs rule.
- **"Projektwissen" inside the tab.** Only the tab label changes to "Wissen"; other uses of "Projektwissen" (activity log category, agent work copy) keep it. No extra heading is added inside the tab; the design's group label "Wissenseinträge" is used.
- **"+ Neuer Lauf".** The existing label `pipelineCopy.newRun` ("Lauf starten") is kept in the run toolbar (Guiding decision 7: reuse existing texts; existing specs click it).
- **Search keeps its visible submit button.** The icon set has no search glyph; adding one would touch the shared `Icon.jsx` during parallel page steps.
- **Segmented controls are radios.** Aktiv/Archiv and Sitzungen/Nachrichten use Step 0's `Segmented` (radiogroup); spec locators move from `button`/`tab` to `radio`/`label`.
- **AgentBus status line split.** "{n} verbunden" is the group label; "{n} Nachrichten warten · Version {v}" is the line under the switch. `agentbus.spec.js` asserts both parts.
- **Run table stays a table on desktop**, list-card look only on phones (column headers stay asserted).
- **Not applicable on Projects:** dirty bar, unsaved-changes sheet, multi-step save, conflict reload/overwrite. Projects has no draft fields (knowledge entries save in `MemoryEditor` with its own conflict flow). Regression specs assert that no save bar and no unsaved prompt ever appear.

## Self-Review

**Spec coverage (Step 5):**

| Spec item                                                                                                                             | Task                                        |
| ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Structure unchanged, restyled                                                                                                         | 3–7                                         |
| Tab label "Wissen"                                                                                                                    | 1                                           |
| Mobile list with folder tile and attention hints                                                                                      | 3                                           |
| Header "+" menu (clone, add folder); desktop header buttons                                                                           | 3                                           |
| Übersicht: attention strip (one run → run, several → Läufe filtered), facts card, sessions with open                                  | 2, 4                                        |
| Wissen: search, segmented Aktiv/Archiv with counts + ⓘ `tabHint`, "+ Neuer Eintrag" on label, edit/history/archive, refresh, register | 5                                           |
| AgentBus: segmented radios, "{n} verbunden", version, pending, reload-required, paging                                                | 6                                           |
| Läufe: chips with fade, rows with state below, refresh, new run, register hint                                                        | 7 (fade from Step 0)                        |
| Merge-duplicates button stays                                                                                                         | 3                                           |
| Mobile bottom bar "Sitzung starten" on detail tabs; desktop primary in detail header                                                  | 3                                           |
| UnderlineTabs look inherited                                                                                                          | Step 0 + 3                                  |
| Browser specs updated, behaviour assertions kept                                                                                      | 1, 3, 5, 6                                  |
| Regression specs: deep links, ⓘ disclosure, scroll fade, no save prompt                                                               | 3–7                                         |
| EN + DE, 390×844 + 1280×800, screenshots                                                                                              | 8                                           |
| Files ≤ 600 lines, no `common.js` keys                                                                                                | all (projects.css shrinks, new files small) |

**Placeholder scan:** no elisions; Task 6 Step 3 spells out the kept `sessions.map` callback.

**Type consistency:** `projectAttention` returns `{ decisions, failed }` parts `{ count, run, capped }`, used by `ProjectListItem`, `ProjectAttention` and the unit test; `attentionTarget(projectId, status, part)` matches in Task 2, Task 4 and the test; `pipelineRunRoute` replaces `runRoute` in `ProjectRuns`; `ProjectDetail` passes `projectId`, `attention`, `onNavigate` exactly as `ProjectOverview` destructures them; `ProjectsPage` passes `attention`, `notices`, `onBack` exactly as `ProjectDetail` destructures them.

**Review Focus:** each item has a pinned test in its owning task (2: capped unit; 4: unregistered browser; 3: resize, drawer, menu; 1/3/5/6: English).
