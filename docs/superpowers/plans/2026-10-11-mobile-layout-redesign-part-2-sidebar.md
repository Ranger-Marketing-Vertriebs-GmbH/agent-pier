# Mobile Layout Redesign — Part 2: Sidebar and Menü

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Main plan: `docs/superpowers/plans/2026-10-11-mobile-layout-redesign.md` (Global
Constraints, shared interfaces, Review Focus apply to every task here).
Spec: `docs/superpowers/specs/2026-10-11-mobile-layout-redesign-design.md` — Decisions
1, 2, 4, 5, 8, 9, 11, „Theme tokens“, „CSS file layout“, „Step A“.
Visual reference: mock states 1a (mobile drawer, menu open) and 2f (desktop). Unzip
`docs/Mobile Layout Verbesserungen.zip` into the scratchpad and open the `.dc.html`
files; this plan already copies every value needed.

Precondition: Part 1 is merged into the branch (`assistant-status.js`,
`useAssistants().activity`, copy `assistantCopy.teamActive.*`).

Focused commands used below:

- Unit: `node --test tests/unit/<file>.test.js`
- Browser (Chromium):
  `AGENTPIER_TEST_PORT=4391 npx playwright test tests/browser/<file>.spec.js --output .cache/pw-part2`
- Full gate: `npm run check`

---

### Task 1: Theme tokens

**Files:**
- Modify: `web/styles/base.css:15-30` (custom properties in `:root`)
- Modify: `web/features/assistants/assistants.css:444-453,459-465`
- Create: `tests/unit/theme-tokens.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: every token of the spec table; later tasks and parts use them by name.

- [ ] **Step 1: Write the failing test**

```js
// tests/unit/theme-tokens.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";

const web = new URL("../../web/", import.meta.url);
async function cssFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const url = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
    if (entry.isDirectory()) out.push(...(await cssFiles(url)));
    else if (entry.name.endsWith(".css")) out.push(url);
  }
  return out;
}
test("assistant and shell styles only use defined custom properties", async () => {
  const files = await cssFiles(web);
  const defined = new Set();
  for (const file of files)
    for (const [, name] of (await readFile(file, "utf8")).matchAll(/(--[\w-]+)\s*:/g))
      defined.add(name);
  // Runtime-set properties (useSessionViewport) are not declared in CSS.
  for (const name of ["--session-viewport-height", "--session-viewport-top"])
    defined.add(name);
  const checked = files.filter((f) =>
    /features\/assistants\/|app\/layout\.css|app\/sidebar-menu\.css/.test(f.pathname),
  );
  for (const file of checked) {
    const css = await readFile(file, "utf8");
    for (const [, name] of css.matchAll(/var\((--[\w-]+)/g))
      assert.ok(defined.has(name), `${file.pathname}: ${name} is undefined`);
  }
});
test("redesign tokens exist with the handoff values", async () => {
  const css = await readFile(new URL("styles/base.css", web), "utf8");
  const expected = {
    "--text": "#e8e8ec",
    "--sidebar-bg": "#15161a",
    "--header-bg": "#16171b",
    "--header-line": "#28292d",
    "--popover-bg": "#1b1c20",
    "--popover-raised": "#1f2024",
    "--popover-shadow": "0 18px 40px -12px #000",
    "--scrim": "#0b0c0e99",
    "--accent-text": "#ffc99d",
    "--accent-focus": "#f49a5866",
    "--button-secondary-bg": "#202125",
    "--button-secondary-line": "#323337",
    "--button-secondary-text": "#dcdde1",
    "--nav-selected": "#26272b",
    "--pill-bg": "#1c1d21",
    "--pill-text": "#b9babe",
    "--text-row": "#cfd0d4",
    "--text-meta": "#8a8b8f",
    "--text-menu": "#c4c5c9",
    "--text-group": "#97989c",
    "--text-faint": "#6f7075",
    "--text-message": "#e1e2e6",
    "--placeholder": "#6b6c70",
    "--hint": "#7e7f83",
    "--approval-bg": "#1b1a19",
    "--approval-line": "#2e2924",
    "--divider": "#2a2b30",
    "--divider-soft": "#24252a",
    "--switch-off": "#3a3b3f",
    "--switch-knob": "#fff",
    "--on-accent": "#242529",
  };
  for (const [name, value] of Object.entries(expected))
    assert.match(css, new RegExp(`${name}:\\s*${value.replace(/[-#]/g, "\\$&")};`), name);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/unit/theme-tokens.test.js`
Expected: FAIL — `--border is undefined` (assistants.css) and `--text` missing.

- [ ] **Step 3: Add the tokens**

In `web/styles/base.css`, append inside `:root` after `--success-line: #a4cdb333;`:

```css
  --text: #e8e8ec;
  --sidebar-bg: #15161a;
  --header-bg: #16171b;
  --header-line: #28292d;
  --popover-bg: #1b1c20;
  --popover-raised: #1f2024;
  --popover-shadow: 0 18px 40px -12px #000;
  --scrim: #0b0c0e99;
  --accent-text: #ffc99d;
  --accent-focus: #f49a5866;
  --button-secondary-bg: #202125;
  --button-secondary-line: #323337;
  --button-secondary-text: #dcdde1;
  --nav-selected: #26272b;
  --pill-bg: #1c1d21;
  --pill-text: #b9babe;
  --text-row: #cfd0d4;
  --text-meta: #8a8b8f;
  --text-menu: #c4c5c9;
  --text-group: #97989c;
  --text-faint: #6f7075;
  --text-message: #e1e2e6;
  --placeholder: #6b6c70;
  --hint: #7e7f83;
  --approval-bg: #1b1a19;
  --approval-line: #2e2924;
  --divider: #2a2b30;
  --divider-soft: #24252a;
  --switch-off: #3a3b3f;
  --switch-knob: #fff;
  --on-accent: #242529;
```

In `web/features/assistants/assistants.css` replace the undefined variables:
`border-left: 2px solid var(--border);` → `border-left: 2px solid var(--line);`
(`.assistant-sidebar-member`, will move in Task 7) and in the shared
`.assistant-team-card, .assistant-member-summary` rule
`border: 1px solid var(--border);` → `border: 1px solid var(--line);` and
`background: var(--surface);` → `background: var(--panel);`.

- [ ] **Step 4: Run tests**

Run: `node --test tests/unit/theme-tokens.test.js tests/unit/assistant-css.test.js`
Expected: PASS (both).

- [ ] **Step 5: Commit**

```bash
npm run format
git add web/styles/base.css web/features/assistants/assistants.css tests/unit/theme-tokens.test.js
git commit -m "feat: add theme tokens for the mobile redesign

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Sidebar copy

**Files:**
- Modify: `web/lib/i18n/de/app.js:28-44`, `web/lib/i18n/en/app.js:26-42`
- Modify: `web/lib/i18n/de/assistants.js:362`, `web/lib/i18n/en/assistants.js:351`
- Create: `tests/unit/sidebar-copy.test.js`

**Interfaces:**
- Produces: `sidebarCopy.menu`, `sidebarCopy.closeMenu`, `assistantCopy.agentsGroup`.
  Removes `sidebarCopy.sidebarCaption` (decision 8).

- [ ] **Step 1: Write the failing test**

```js
// tests/unit/sidebar-copy.test.js
import test from "node:test";
import assert from "node:assert/strict";
import * as deApp from "../../web/lib/i18n/de/app.js";
import * as enApp from "../../web/lib/i18n/en/app.js";
import * as deAgents from "../../web/lib/i18n/de/assistants.js";
import * as enAgents from "../../web/lib/i18n/en/assistants.js";

test("sidebar menu copy exists in both languages", () => {
  assert.equal(deApp.sidebarCopy.menu, "Menü");
  assert.equal(enApp.sidebarCopy.menu, "Menu");
  assert.equal(deApp.sidebarCopy.closeMenu, "Menü schließen");
  assert.equal(enApp.sidebarCopy.closeMenu, "Close menu");
  assert.equal(deAgents.assistantCopy.agentsGroup, "Agenten");
  assert.equal(enAgents.assistantCopy.agentsGroup, "Agents");
  assert.equal(deApp.sidebarCopy.sidebarCaption, undefined);
  assert.equal(enApp.sidebarCopy.sidebarCaption, undefined);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/unit/sidebar-copy.test.js` → FAIL (`undefined !== 'Menü'`).

- [ ] **Step 3: Implement**

`web/lib/i18n/de/app.js` in `sidebarCopy`: delete `sidebarCaption: "DEIN RECHNER. DEINE TOOLS.",`
and add after `remoteLink: "Remote öffnen",`:

```js
  menu: "Menü",
  closeMenu: "Menü schließen",
```

`web/lib/i18n/en/app.js` in `sidebarCopy`: delete `sidebarCaption: "YOUR COMPUTER. YOUR TOOLS.",`
and add after `remoteLink: "Open remotely",`:

```js
  menu: "Menu",
  closeMenu: "Close menu",
```

`web/lib/i18n/de/assistants.js` after `chats: "Agenten-Chats",` add `agentsGroup: "Agenten",`;
`web/lib/i18n/en/assistants.js` after `chats: "Agent chats",` add `agentsGroup: "Agents",`.

`web/app/Sidebar.jsx:257` still renders `copy.sidebarCaption`; delete that line
(`<div className="sidebar-caption">{copy.sidebarCaption}</div>`) and the
`.sidebar-caption` rule in `web/app/layout.css:385-390`.

- [ ] **Step 4: Run tests**

Run: `node --test tests/unit/sidebar-copy.test.js tests/unit/i18n-catalogs.test.js tests/unit/i18n-terminology.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run format
git add web/lib/i18n web/app/Sidebar.jsx web/app/layout.css tests/unit/sidebar-copy.test.js
git commit -m "feat: add sidebar menu copy and drop the sidebar caption

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Menü popover, navigation helper and the specs that use the old nav

**Files:**
- Create: `web/app/SidebarMenu.jsx`, `web/app/sidebar-menu.css`, `tests/browser/sidebar-menu.spec.js`
- Modify: `web/app/Sidebar.jsx:1-16,43-54,79-170,229-258`
- Modify: `web/styles/index.css:21` (import), `web/app/layout.css:107-111,156-167,361-401`
- Modify: `tests/helpers/navigation.js` (whole file)
- Modify specs: `sidebar.spec.js:70-104`, `sidebar-collapse.spec.js:36`,
  `assistant-feature.spec.js:85-88,99-108,131-135,138-143,196-201,213-214,224-226`,
  `login.spec.js:38-44,62,102`, `chat-session-cache.spec.js:122`,
  `remote-menu.spec.js:29-32,50,62,71`, `i18n.spec.js:111-113`, `tool-installer.spec.js:236`

**Interfaces:**
- Consumes: Task 1 tokens, Task 2 copy.
- Produces: `SidebarMenu({ view, selected, page, select, state, agentsEnabled,
  localAccess, error, loading, mobileNav })` (default export; popover
  `id="sidebar-menu"`, trigger `.sidebar-menu-button`);
  `openMenu(page): Promise<Locator>` and `navigateTo(page, name)` in
  `tests/helpers/navigation.js`.
  **Contract change vs main plan:** `desktop` is dropped (geometry is pure CSS) and
  `error`, `loading` (host status) and `mobileNav` (close when the drawer closes) are
  added.

- [ ] **Step 1: Write the failing browser spec**

```js
// tests/browser/sidebar-menu.spec.js
import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { openMenu } from "../helpers/navigation.js";

const trigger = (page) => page.locator(".sidebar .sidebar-menu-button");
const popover = (page) => page.locator("#sidebar-menu");

test("the menu keeps the landmark, opens, and closes on Escape with focus restored", async ({
  page,
}) => {
  await page.goto(baseURL);
  const nav = page.getByRole("navigation", { name: "Hauptnavigation" });
  await expect(nav).toBeVisible();
  await expect(popover(page)).toBeHidden();
  await trigger(page).click();
  await expect(trigger(page)).toHaveAttribute("aria-expanded", "true");
  await expect(popover(page).getByRole("button", { name: "Übersicht" })).toBeFocused();
  for (const name of ["Artefakte", "Projekte", "Dateien", "Pipelines", "Accounts"])
    await expect(popover(page).getByRole("button", { name, exact: true })).toBeVisible();
  await expect(popover(page).locator(".host-status")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(popover(page)).toBeHidden();
  await expect(trigger(page)).toBeFocused();
});

test("outside taps, the scrim and navigation close the menu", async ({ page }) => {
  await page.goto(baseURL);
  await trigger(page).click();
  await page.locator("main").click({ position: { x: 600, y: 400 } });
  await expect(popover(page)).toBeHidden();
  await trigger(page).click();
  await page.locator(".sidebar-menu-scrim").click({ position: { x: 20, y: 600 } });
  await expect(popover(page)).toBeHidden();
  await trigger(page).click();
  await popover(page).getByRole("button", { name: "Einstellungen", exact: true }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(popover(page)).toBeHidden();
});

test("on phones Escape closes the menu first and the drawer second", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(baseURL);
  const drawer = page.locator(".sidebar");
  await page.getByRole("button", { name: "Navigation öffnen", exact: true }).click();
  await expect(drawer).toHaveClass(/open/);
  await trigger(page).click();
  await page.keyboard.press("Escape");
  await expect(popover(page)).toBeHidden();
  await expect(drawer).toHaveClass(/open/);
  await expect(trigger(page)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(drawer).not.toHaveClass(/open/);
});

test("the popover fits a 240 px sidebar and a 320 px phone", async ({ page }) => {
  for (const size of [
    { width: 1100, height: 800 },
    { width: 320, height: 640 },
  ]) {
    await page.setViewportSize(size);
    await page.goto(baseURL);
    const menu = await openMenu(page);
    const box = await menu.boundingBox();
    const aside = await page.locator(".sidebar").boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(aside.x);
    expect(box.x + box.width).toBeLessThanOrEqual(aside.x + aside.width);
    expect(box.y + box.height).toBeLessThanOrEqual(size.height);
    await page.keyboard.press("Escape");
  }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `AGENTPIER_TEST_PORT=4391 npx playwright test tests/browser/sidebar-menu.spec.js --output .cache/pw-part2`
Expected: FAIL — `.sidebar-menu-button` not found.

- [ ] **Step 3: Create `web/app/SidebarMenu.jsx`**

```jsx
import React, { useEffect, useRef, useState } from "react";
import Icon from "../components/Icon.jsx";
import LogoutButton from "../features/login/LogoutButton.jsx";
import { assistantCopy } from "../lib/i18n/messages/assistants.js";
import { artifactCopy } from "../lib/i18n/messages/artifacts.js";
import { commonCopy } from "../lib/i18n/messages/common.js";
import { filesCopy } from "../lib/i18n/messages/files.js";
import { pipelineCopy } from "../lib/i18n/messages/pipelines.js";
import { sidebarCopy as copy } from "../lib/i18n/messages/app.js";

// The landmark wraps the trigger, so "Hauptnavigation" exists while the list is closed.
export default function SidebarMenu({
  view,
  selected,
  page,
  select,
  state,
  agentsEnabled,
  localAccess,
  error,
  loading,
  mobileNav,
}) {
  const [open, setOpen] = useState(false);
  const root = useRef(null),
    trigger = useRef(null),
    popover = useRef(null);
  const close = (restore = true) => {
    setOpen(false);
    if (restore) queueMicrotask(() => trigger.current?.focus());
  };
  // A new page or a closed drawer leaves no menu behind.
  useEffect(() => {
    setOpen(false);
  }, [view, selected, mobileNav]);
  useEffect(() => {
    if (!open) return undefined;
    popover.current?.querySelector("button:not(:disabled), a")?.focus();
    const outside = (event) => {
      if (!root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  const entry = ({ key, icon, label, active, onClick, ariaLabel, extra }) => (
    <button
      key={key}
      type="button"
      aria-label={ariaLabel}
      className={active ? "nav-item selected" : "nav-item"}
      aria-current={active ? "page" : undefined}
      onClick={() => {
        setOpen(false);
        onClick();
      }}
    >
      <Icon name={icon} size={17} />
      {label}
      {extra}
    </button>
  );
  return (
    <nav
      className="sidebar-menu"
      aria-label={copy.ariaLabel}
      ref={root}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return;
        // The window listener in App closes the drawer; one Escape closes one layer.
        event.preventDefault();
        event.stopPropagation();
        close();
      }}
    >
      <button
        ref={trigger}
        type="button"
        className={`sidebar-menu-button ${open ? "open" : ""}`}
        aria-label={open ? copy.closeMenu : undefined}
        aria-expanded={open}
        aria-controls="sidebar-menu"
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name={open ? "close" : "menu"} size={16} />
        {copy.menu}
      </button>
      <div
        className="sidebar-menu-scrim"
        hidden={!open}
        aria-hidden="true"
        onClick={() => close()}
      />
      <div id="sidebar-menu" className="sidebar-menu-popover" hidden={!open} ref={popover}>
        {entry({
          key: "overview",
          icon: "grid",
          label: commonCopy.overview,
          active: view === "workspace" && !selected,
          onClick: () => select(null),
        })}
        {entry({
          key: "artifacts",
          icon: "grid",
          label: artifactCopy.title,
          active: view === "artifacts",
          onClick: () => page("artifacts"),
        })}
        {agentsEnabled &&
          entry({
            key: "agents",
            icon: "users",
            label: assistantCopy.title,
            active: view === "agents",
            onClick: () => page("agents"),
          })}
        <div className="sidebar-menu-label">{commonCopy.projectsGroup}</div>
        {entry({
          key: "projects",
          icon: "folder",
          label: copy.projectsNavigation,
          active: view === "projects",
          onClick: () => page("projects"),
        })}
        {entry({
          key: "files",
          icon: "history",
          label: filesCopy.tab,
          active: view === "files",
          onClick: () => page("files"),
        })}
        {entry({
          key: "pipelines",
          icon: "refresh",
          label: pipelineCopy.title,
          active: view === "pipelines",
          onClick: () => page("pipelines"),
        })}
        <div className="sidebar-menu-label">{commonCopy.configurationGroup}</div>
        {entry({
          key: "accounts",
          icon: "users",
          label: commonCopy.accounts,
          ariaLabel: commonCopy.accounts,
          active: view === "accounts",
          onClick: () => page("accounts"),
          extra: (
            <span className="count">
              {state.accounts.filter((a) => a.tool !== "shell").length}
            </span>
          ),
        })}
        {entry({
          key: "extensions",
          icon: "grid",
          label: copy.extensionsNavigation,
          active: view === "extensions",
          onClick: () => page("extensions"),
        })}
        {entry({
          key: "settings",
          icon: "settings",
          label: commonCopy.settings,
          active: view === "settings",
          onClick: () => page("settings"),
        })}
        <div className="sidebar-menu-divider" />
        <div className="host-status">
          <span className={`status-dot ${error ? "stopped" : "running"}`} />
          <span>
            {copy.hostStatusLabel}
            <small>
              {error
                ? commonCopy.serviceUnavailable
                : loading
                  ? copy.serviceConnecting
                  : copy.localHostDescription}
            </small>
          </span>
          <Icon name="shield" size={16} />
        </div>
        {state.remoteUrl && localAccess && (
          <a className="remote-link" href={state.remoteUrl} target="_blank" rel="noreferrer">
            <Icon name="link" size={14} />
            {copy.remoteLink}
            <Icon name="arrow" size={14} />
          </a>
        )}
        <div className="sidebar-menu-logout">
          <LogoutButton />
        </div>
      </div>
    </nav>
  );
}
```

- [ ] **Step 4: Mount it in `web/app/Sidebar.jsx`**

Remove the imports that moved (`artifactCopy`, `LogoutButton`, `pipelineCopy`,
`filesCopy`; keep `assistantCopy` only if still used — it is not, remove it) and add
`import SidebarMenu from "./SidebarMenu.jsx";`. Replace the `.sidebar-top` block
(`:44-54`) with:

```jsx
      <div className="sidebar-top">
        <button
          ref={collapseRef}
          className="icon-button sidebar-collapse"
          aria-label={copy.collapseSidebar}
          title={copy.collapseSidebar}
          onClick={collapse}
        >
          <Icon name="back" />
        </button>
        <SidebarMenu
          {...{
            view,
            selected,
            page,
            select,
            state,
            agentsEnabled,
            localAccess,
            error,
            loading,
            mobileNav,
          }}
        />
      </div>
```

Delete the whole `<nav aria-label={copy.ariaLabel}>…</nav>` block (`:79-170`) and the
whole `.sidebar-bottom` block (`:229-258`). Task 4 rearranges the header; this task
only moves the controls.

- [ ] **Step 5: Create `web/app/sidebar-menu.css` and import it**

`web/styles/index.css`: after `@import "../app/layout.css";` add
`@import "../app/sidebar-menu.css";`.

```css
/* Menü: trigger, drawer scrim and the navigation popover (handoff 1a / 2f). */
.sidebar-menu {
  display: flex;
}
.sidebar-menu-button {
  position: relative;
  z-index: 3;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 34px;
  padding: 0 12px;
  border-radius: 8px;
  border: 1px solid var(--button-secondary-line);
  background: var(--button-secondary-bg);
  color: var(--button-secondary-text);
  font-size: 12px;
  font-weight: 600;
}
.sidebar-menu-button.open {
  border-color: var(--accent-line);
  background: var(--surface-accent);
  color: var(--accent-text);
}
.sidebar-menu-scrim {
  position: absolute;
  inset: 0;
  z-index: 2;
  background: var(--scrim);
}
.sidebar-menu-popover {
  position: absolute;
  top: 52px;
  right: 12px;
  z-index: 3;
  width: min(256px, calc(100% - 20px));
  max-height: calc(100% - 62px);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  padding: 6px;
  background: var(--popover-bg);
  border: 1px solid var(--line);
  border-radius: 12px;
  box-shadow: var(--popover-shadow);
}
.sidebar-menu-scrim[hidden],
.sidebar-menu-popover[hidden] {
  display: none;
}
.sidebar-menu-popover .nav-item {
  width: 100%;
  min-height: 38px;
  padding: 0 12px;
  gap: 12px;
  border-radius: 8px;
  font-size: 13px;
  color: var(--text-menu);
}
.sidebar-menu-popover .nav-item.selected {
  background: var(--nav-selected);
  color: var(--accent-text);
}
.sidebar-menu-label {
  padding: 12px 12px 4px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.8px;
  text-transform: uppercase;
  color: var(--text-faint);
}
.sidebar-menu-divider {
  height: 1px;
  margin: 6px;
  background: var(--line);
}
.sidebar-menu-popover .host-status {
  padding: 8px 12px;
}
.sidebar-menu-popover .host-status small {
  margin-top: 4px;
}
.sidebar-menu-popover .remote-link {
  margin: 0;
  min-height: 38px;
  padding: 0 12px;
  font-size: 12px;
}
.sidebar-menu-logout .nav-item {
  color: #9d9ea2;
}
@media (max-width: 700px) {
  .sidebar-menu-button {
    height: 36px;
  }
  .sidebar-menu-popover {
    top: 58px;
    right: 10px;
    max-height: calc(100% - 68px);
  }
  .sidebar-menu-popover .nav-item {
    min-height: 40px;
  }
}
```

`#9d9ea2` is the mock's colour for „Abmelden“; shell CSS (not assistant CSS) may keep
literals.

In `web/app/layout.css` delete the now unused rules: `.sidebar nav` (`:107-111`),
`.projects-group …`/`.configuration-group …` (`:156-167`), `.sidebar-bottom`
(`:361-365`), `.remote-link { … margin-top: 17px … }` keep but remove
`margin-top: 17px;`. Change `.sidebar { overflow-y: auto; }` (`:112-114`) to
`.sidebar { overflow: visible; }` so the popover is never clipped (Task 4 adds the
dedicated scroller).

- [ ] **Step 6: Rewrite `tests/helpers/navigation.js`**

```js
// Navigation lives behind the „Menü“ popover in the sidebar (drawer on phones).
async function openDrawer(page) {
  // Login status is asynchronous; isVisible() alone does not wait for App to mount.
  await page.locator(".sidebar").waitFor({ state: "attached" });
  const drawer = page
    .getByRole("button", { name: /^(Navigation öffnen|Open navigation)$/ })
    .filter({ visible: true });
  if (
    (await drawer.count()) &&
    !(await page.locator(".sidebar").evaluate((node) => node.classList.contains("open")))
  )
    await drawer.first().click();
}
export async function openMenu(page) {
  await openDrawer(page);
  const trigger = page.locator(".sidebar .sidebar-menu-button");
  if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
  const menu = page.locator("#sidebar-menu");
  await menu.waitFor({ state: "visible" });
  return menu;
}
export async function navigateTo(page, name) {
  const menu = await openMenu(page);
  await menu.getByRole("button", { name, exact: true }).click();
}
```

- [ ] **Step 7: Update the specs that used the visible nav**

`tests/browser/sidebar.spec.js:70-104` — replace the whole „sidebar groups shorten the
menu…“ test with:

```js
test("the sessions group stays collapsible and remembers its state", async ({ page }) => {
  await fixture(page);
  await page.goto(base);
  const sessions = page.getByRole("button", { name: "Sitzungen", exact: true });
  await expect(sessions).toHaveAttribute("aria-expanded", "true");
  await sessions.click();
  await expect(page.locator(".sessions-group .session-list")).toBeHidden();
  await page.reload();
  await expect(sessions).toHaveAttribute("aria-expanded", "false");
  await page.goto(base + "/sessions/status-working/terminal");
  await expect(sessions).toHaveAttribute("aria-expanded", "true");
  const menu = await openMenu(page);
  await menu.getByRole("button", { name: "Accounts", exact: true }).click();
  await openMenu(page);
  await expect(menu.getByRole("button", { name: "Accounts", exact: true })).toHaveClass(
    /selected/,
  );
  await expect(menu.getByRole("button", { name: "Accounts", exact: true })).toHaveCSS(
    "color",
    "rgb(255, 201, 157)",
  );
});
```

and add `import { openMenu } from "../helpers/navigation.js";` at the top.

`tests/browser/sidebar-collapse.spec.js:36`:
`await drawer.getByRole("button", { name: "Übersicht" }).click();` →

```js
  await (await openMenu(page)).getByRole("button", { name: "Übersicht" }).click();
```

plus `import { openMenu } from "../helpers/navigation.js";`.

`tests/browser/assistant-feature.spec.js` — add
`import { openMenu } from "../helpers/navigation.js";` and replace `agentsNav`:

```js
const agentsNav = (page) =>
  page.locator("#sidebar-menu").getByRole("button", { name: "Agents", exact: true });
```

Then: before every `expect(agentsNav(page))` call (`:107`, `:140`, `:187`, `:198`,
`:213`, `:225`) insert `await openMenu(page);` (absence checks must open the menu
first so they cannot pass vacuously). At `:103` keep the landmark assertion. At
`:131-134` replace the label query with

```js
  const menu = await openMenu(page);
  const labels = await menu
    .locator(".nav-item")
    .evaluateAll((items) => items.map((item) => item.textContent.trim()));
```

At `:196` (`"Overview"` visible within 1500 ms) insert `await openMenu(page);` before
the assertion and scope it: `page.locator("#sidebar-menu").getByRole("button", { name: "Overview" })`.
In the „toggling agents…“ test call `await openMenu(page);` after clicking
„Expand navigation“.

`tests/browser/login.spec.js` — import `openMenu`; before each Abmelden assertion or
click at `:38`, `:42` (after reload), `:62` and `:102` insert `await openMenu(page);`
and scope to `page.locator("#sidebar-menu").getByRole("button", { name: "Abmelden", exact: true })`.
`:21` (landmark count 0 on the setup page) stays.

`tests/browser/chat-session-cache.spec.js:122`: insert `await openMenu(page);` before
the Abmelden click (import from `../helpers/navigation.js`).

`tests/browser/remote-menu.spec.js` — import `openMenu`; in `workspace()` after the
`goto`, call `await openMenu(page);` before the `.host-status` assertion, so every
link assertion (`:50`, `:62`, `:71`) runs against the open popover.

`tests/browser/i18n.spec.js:111`: insert `await openMenu(page);` before the Accounts
count assertion (import it).

`tests/browser/tool-installer.spec.js:236`: replace the click with
`await navigateTo(page, "Übersicht");` (already imported).

- [ ] **Step 8: Run the browser specs**

Run: `AGENTPIER_TEST_PORT=4391 npx playwright test tests/browser/sidebar-menu.spec.js tests/browser/sidebar.spec.js tests/browser/sidebar-collapse.spec.js tests/browser/assistant-feature.spec.js tests/browser/login.spec.js tests/browser/chat-session-cache.spec.js tests/browser/remote-menu.spec.js tests/browser/i18n.spec.js tests/browser/tool-installer.spec.js tests/browser/navigation.spec.js tests/browser/extensions.spec.js --output .cache/pw-part2`
Expected: PASS, except `sidebar-collapse.spec.js` margin assertions (`252px`), which
Task 4 updates, and the 320 px case of „the popover fits…“ if the drawer is still
260 px wide (Task 4). Note any other failure and fix before continuing.

- [ ] **Step 9: Commit**

```bash
npm run format
git add web/app web/styles/index.css tests/helpers/navigation.js tests/browser
git commit -m "feat: move navigation, host status and logout into the sidebar menu

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Sidebar structure, widths, one scroll area and inert drawer

**Files:**
- Modify: `web/app/Sidebar.jsx` (render tree), `web/app/layout.css:1-60,97-106,112-114,168-182,254-258`
- Modify: `web/styles/mobile.css:2-7`, `web/styles/desktop.css:25-32`
- Modify: `tests/browser/sidebar-collapse.spec.js:12,19`
- Test: `tests/browser/sidebar-menu.spec.js` (append)

**Interfaces:**
- Consumes: `useMobileLayout()` from `web/lib/useMobileLayout.js`; `SidebarMenu`.
- Produces: `.sidebar-head`, `.sidebar-launch`, `.sidebar-scroll` (the only scroll
  container; Task 7's agent group and Task 6's sessions render inside it).

- [ ] **Step 1: Write failing tests (append to `tests/browser/sidebar-menu.spec.js`)**

```js
test("desktop sidebar is 280 px, 240 px below 1150 px, and never inert", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(baseURL);
  const aside = page.locator(".sidebar");
  await expect(page.locator("main")).toHaveCSS("margin-left", "280px");
  expect(await aside.evaluate((node) => node.inert)).toBe(false);
  await page.setViewportSize({ width: 1100, height: 900 });
  await expect(page.locator("main")).toHaveCSS("margin-left", "240px");
});

test("the closed phone drawer is inert and fits 320 px without horizontal scroll", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto(baseURL);
  const aside = page.locator(".sidebar");
  await expect.poll(() => aside.evaluate((node) => node.inert)).toBe(true);
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => !!document.activeElement.closest(".sidebar"))).toBe(
    false,
  );
  await page.getByRole("button", { name: "Navigation öffnen", exact: true }).click();
  await expect.poll(() => aside.evaluate((node) => node.inert)).toBe(false);
  expect((await aside.boundingBox()).width).toBe(264);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
    true,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => (await aside.boundingBox()).width).toBe(316);
});

test("agents and sessions share one scroll container", async ({ page }) => {
  await page.goto(baseURL);
  const scrollers = await page.locator(".sidebar *").evaluateAll((nodes) =>
    nodes
      .filter((node) => !node.closest("#sidebar-menu"))
      .filter((node) => ["auto", "scroll"].includes(getComputedStyle(node).overflowY))
      .map((node) => node.className),
  );
  expect(scrollers).toEqual(["sidebar-scroll"]);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `AGENTPIER_TEST_PORT=4391 npx playwright test tests/browser/sidebar-menu.spec.js --output .cache/pw-part2`
Expected: FAIL — margin `252px`, drawer width 260, extra scrollers (`session-list`).

- [ ] **Step 3: Restructure `web/app/Sidebar.jsx`**

Add `import useMobileLayout from "../lib/useMobileLayout.js";` and inside the
component, before `return`:

```jsx
  // Off-canvas on phones: keep the closed drawer out of the tab order.
  const mobile = useMobileLayout();
```

Replace the returned tree with:

```jsx
    <aside className={`sidebar ${mobileNav ? "open" : ""}`} inert={mobile && !mobileNav}>
      <div className="sidebar-head">
        <button
          ref={collapseRef}
          className="icon-button sidebar-collapse"
          aria-label={copy.collapseSidebar}
          title={copy.collapseSidebar}
          onClick={collapse}
        >
          <Icon name="back" />
        </button>
        <button
          className="brand"
          onClick={() => select(null)}
          aria-label={copy.brandAriaLabel}
        >
          <span className="brand-symbol">
            <Icon name="terminal" size={mobile ? 18 : 22} />
          </span>
          <span>
            {copy.brandLabel}
            <span className="brand-dot">.</span>
          </span>
          <span className="local-badge">{copy.localBadge}</span>
        </button>
        <SidebarMenu
          {...{
            view,
            selected,
            page,
            select,
            state,
            agentsEnabled,
            localAccess,
            error,
            loading,
            mobileNav,
          }}
        />
      </div>
      <div className="sidebar-launch">
        <button
          aria-label={commonCopy.newSession}
          className="button primary new-session"
          onClick={() => launch()}
          disabled={!installed}
        >
          <Icon name="plus" />
          {commonCopy.newSession}
          <span className="shortcut">↗</span>
        </button>
      </div>
      <div className="sidebar-scroll">
        {agentsEnabled && (
          <Suspense fallback={null}>
            <AssistantSidebar navigate={navigate} route={route} />
          </Suspense>
        )}
        <SidebarGroup
          name="sessions"
          label={commonCopy.sessions}
          count={sessions.length.toString().padStart(2, "0")}
          defaultOpen
          activeKey={selected}
        >
          {/* session list unchanged here; Task 6 extracts SessionRow */}
        </SidebarGroup>
      </div>
    </aside>
```

Keep the existing `<div className="session-list">…</div>` body verbatim inside the
`SidebarGroup` (the comment above only marks where it goes; do not commit the
comment).

- [ ] **Step 4: Layout CSS**

`web/app/layout.css`:

- `.app { --sidebar-width: 252px; … }` → `--sidebar-width: 280px;`
- `.sidebar`: `background: #15161a;` → `background: var(--sidebar-bg);`,
  `padding: 12px 19px 18px;` → `padding: 0;`, keep `overflow: visible` from Task 3.
- Replace `.sidebar-top { display: flex; margin-bottom: 4px; }` with:

```css
/* Desktop: collapse and Menü share the first row, the brand sits below (2f). */
.sidebar-head {
  display: grid;
  grid-template-columns: auto 1fr auto;
  grid-template-areas:
    "collapse . menu"
    "brand brand brand";
  align-items: center;
  padding: 12px 14px 0;
}
.sidebar-collapse {
  grid-area: collapse;
  width: 32px;
  height: 32px;
}
.sidebar-menu {
  grid-area: menu;
}
.sidebar-head .brand {
  grid-area: brand;
  padding: 10px 10px 24px;
}
.sidebar-launch {
  padding: 0 14px 12px;
}
.sidebar-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 8px 16px;
}
```

- `.brand { … padding: 0 10px 33px; }` → remove the `padding` declaration (now on
  `.sidebar-head .brand`).
- `.sessions-group { margin-top: 16px; flex: 1; display: flex; flex-direction: column; }`
  → `.sessions-group { margin-top: 8px; }`; delete `.sessions-group.collapsed { flex: 1; }`
  and `.sessions-group > .sidebar-group-content:not([hidden]) { … }`.
- `.session-list { min-height: 0; overflow-y: auto; flex: 1; }` → delete the rule.
- Delete the stand-alone `.sidebar { overflow: visible; }` duplicate if Task 3 left one
  separate from the main `.sidebar` rule (merge into the main rule).

`web/styles/desktop.css:25-32` → replace with:

```css
@media (max-width: 1150px) {
  .app {
    --sidebar-width: 240px;
  }
```

(delete the `.sidebar { padding-left: 14px; padding-right: 14px; }` block, keep the
rest of the media query).

`web/styles/mobile.css:2-7` → replace the `.sidebar` block with:

```css
  .sidebar {
    width: min(316px, calc(100vw - 56px));
    transform: translateX(-100%);
    transition: transform 0.2s;
  }
  .sidebar-head {
    grid-template-columns: 1fr auto;
    grid-template-areas: "brand menu";
    gap: 10px;
    padding: 14px 14px 14px 18px;
  }
  .sidebar-head .brand {
    gap: 10px;
    padding: 0;
    font-size: 22px;
    letter-spacing: -1.2px;
  }
  .sidebar-head .brand-symbol {
    width: 28px;
    height: 28px;
    border-radius: 8px;
  }
  .sidebar-head .local-badge,
  .sidebar-launch .shortcut {
    display: none;
  }
  .sidebar-launch {
    padding: 0 14px 10px;
  }
  .sidebar-launch .new-session {
    height: 40px;
  }
  .sidebar-scroll {
    padding: 0 6px 16px;
  }
```

- [ ] **Step 5: Update the collapse spec**

`tests/browser/sidebar-collapse.spec.js:12` and `:19`: `"252px"` → `"280px"` (viewport
1500 px).

- [ ] **Step 6: Run tests**

Run: `AGENTPIER_TEST_PORT=4391 npx playwright test tests/browser/sidebar-menu.spec.js tests/browser/sidebar-collapse.spec.js tests/browser/sidebar.spec.js tests/browser/terminal-viewport.spec.js tests/browser/i18n.spec.js tests/browser/pipeline-session-list.spec.js tests/browser/file-explorer-jobs.spec.js tests/browser/artifacts.spec.js --output .cache/pw-part2`
Expected: PASS. If `terminal-viewport.spec.js:261` (sidebar in viewport with keyboard)
fails, check that `.sidebar` keeps `top/height` from `mobile-workspace.css:23`.

- [ ] **Step 7: Commit**

```bash
npm run format
git add web/app web/styles tests/browser/sidebar-menu.spec.js tests/browser/sidebar-collapse.spec.js
git commit -m "feat: give the sidebar one scroll area and the redesigned widths

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Sticky group headers and a separate accessible group name

**Files:**
- Modify: `web/app/SidebarGroup.jsx:2-9,36-48`, `web/app/layout.css:119-155`
- Test: `tests/browser/sidebar-menu.spec.js` (append)

**Interfaces:**
- Produces: `SidebarGroup({ …, ariaLabel })` — `ariaLabel` overrides the toggle's
  accessible name; defaults to `label`.

- [ ] **Step 1: Failing test (append)**

```js
test("group headers stay pinned while the list scrolls", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 500 });
  await page.route("**/api/state", async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    json.sessions = Array.from({ length: 30 }, (_, i) => ({
      id: `s${i}`,
      name: `Sitzung ${i}`,
      tool: "codex",
      cwd: `/work/p${i}`,
      status: "running",
      activity: { state: "idle", label: "Bereit" },
    }));
    await route.fulfill({ response, json });
  });
  await page.goto(baseURL);
  const header = page.locator(".sessions-group > .sidebar-group-toggle");
  await page.locator(".sidebar-scroll").evaluate((node) => node.scrollBy(0, 400));
  const scroller = await page.locator(".sidebar-scroll").boundingBox();
  await expect.poll(async () => (await header.boundingBox()).y).toBe(scroller.y);
  await expect(header).toHaveCSS("position", "sticky");
});
```

- [ ] **Step 2: Run** → FAIL (`position: static`).

- [ ] **Step 3: Implement**

`web/app/SidebarGroup.jsx`: add `ariaLabel,` to the destructured props after `label,`
and change `aria-label={label}` to `aria-label={ariaLabel || label}`.

`web/app/layout.css` `.sidebar-group-toggle` rule → set
`min-height: 36px; height: 36px;` (was `min-height: 38px`), add

```css
.sidebar-scroll .sidebar-group-toggle {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--sidebar-bg);
}
```

and change `color: #97989c;` in `.sidebar-group-toggle` and `.sidebar-group-count` to
`color: var(--text-group);`.

- [ ] **Step 4: Run** `…sidebar-menu.spec.js` → PASS.

- [ ] **Step 5: Commit**

```bash
npm run format
git add web/app/SidebarGroup.jsx web/app/layout.css tests/browser/sidebar-menu.spec.js
git commit -m "feat: pin sidebar group headers in the shared scroll area

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Session rows

**Files:**
- Create: `web/app/SessionRow.jsx`
- Modify: `web/components/ProviderMark.jsx` (whole), `web/app/Sidebar.jsx:183-227`,
  `web/app/layout.css:275-341`
- Modify specs: `tests/browser/sidebar.spec.js:137,149`, `tests/browser/chat-presentation.spec.js:285-296,477-484`

**Interfaces:**
- Produces: `SessionRow({ session, selected, onSelect, names })`;
  `ProviderMark({ tool, small = false, size, label })` — `size="row"` renders the
  30 px mark with mock glyph sizes; `label` adds `role="img"` + `aria-label`.

- [ ] **Step 1: Update the specs first (they become the failing tests)**

`tests/browser/sidebar.spec.js` — replace `:137` and the later `:149` expectations:

```js
    await expect(row("Projekt 3").locator("small")).toHaveText(
      /^Wartet.* · project-2$/,
    );
    await expect(row("Projekt 3").locator(".provider-mark")).toHaveAttribute(
      "aria-label",
      "Codex",
    );
    await expect(row("Projekt 3")).not.toContainText("Codex");
    await expect(row("Lokale Shell").locator("small")).toHaveText("Terminal aktiv");
```

and at `:149` (after `sessions[0].activity = …waiting`):
`await expect(row("Projekt 1").locator("small")).toHaveText(/^Wartet.* · project-0$/);`

`tests/browser/chat-presentation.spec.js:285-296` — replace the test with:

```js
test("session rows show the folder name and keep the full path as title", async ({
  page,
}) => {
  await fixture(page);
  const row = page.locator(".session-item");
  await expect(row.locator("small")).toContainText(" · website");
  await expect(row).toHaveAttribute("title", "/fixture/projects/website");
  await expect(page.locator(".session-directory")).toHaveCount(0);
  await page.getByRole("button", { name: "Sitzungen", exact: true }).click();
  await expect(row).toBeHidden();
});
```

`:477-484` → replace the two `.session-directory` assertions with:

```js
  await expect(row.locator("small")).toContainText(" · website");
  await expect(row).toHaveAttribute("title", "/fixture/projects/website");
  await expect(row.locator(".provider-mark.codex")).toHaveAttribute("aria-label", "Codex");
```

- [ ] **Step 2: Run** `AGENTPIER_TEST_PORT=4391 npx playwright test tests/browser/sidebar.spec.js tests/browser/chat-presentation.spec.js --output .cache/pw-part2`
Expected: FAIL (`· Codex` still visible, no aria-label).

- [ ] **Step 3: `web/components/ProviderMark.jsx`**

```jsx
import React from "react";
import Icon from "./Icon.jsx";
const glyphs = {
  default: { codex: 24, claude: 30, terminal: 24 },
  small: { codex: 18, claude: 22, terminal: 16 },
  // Sidebar rows (handoff 1a): same 30 px mark, slightly smaller glyphs.
  row: { codex: 17, claude: 20, terminal: 16 },
};
// OpenAI glyph: Simple Icons 13.0.0 (CC0), icons/openai.svg.
export default function ProviderMark({ tool, small = false, size, label }) {
  const variant = size === "row" ? "row" : small ? "small" : "default";
  const px = glyphs[variant];
  return (
    <span
      className={`provider-mark ${tool} ${variant !== "default" ? "small" : ""} ${variant === "row" ? "row" : ""}`}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : "true"}
    >
      {tool === "codex" ? (
        <svg width={px.codex} height={px.codex} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          {/* keep the existing <path d="M22.2819 …"/> verbatim */}
        </svg>
      ) : tool === "claude" ? (
        <svg
          width={px.claude}
          height={px.claude}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="square"
          aria-hidden="true"
        >
          <path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M5.6 18.4 18.4 5.6" />
        </svg>
      ) : tool === "opencode" ? (
        <span className="opencode-glyph">⌑</span>
      ) : (
        <Icon name="terminal" size={px.terminal} />
      )}
    </span>
  );
}
```

Copy the codex `<path d="M22.2819…"/>` element unchanged from the current file
(line 15); do not leave the JSX comment.

- [ ] **Step 4: `web/app/SessionRow.jsx`**

```jsx
import React from "react";
import ProviderMark from "../components/ProviderMark.jsx";
import { sessionActivity, sandboxBadge } from "./SidebarGroup.jsx";

const folder = (cwd = "") => cwd.split("/").filter(Boolean).at(-1) || cwd;

// The provider mark names the tool, so the subline only carries state and location.
export default function SessionRow({ session, selected, onSelect, names }) {
  const activity = sessionActivity(session);
  const shell = session.tool === "shell";
  const location = shell ? "" : session.repositoryName || folder(session.cwd);
  return (
    <button
      className={`session-item ${selected ? "selected" : ""}`}
      onClick={() => onSelect(session)}
      title={session.cwd}
    >
      <span className="session-provider">
        <ProviderMark
          tool={session.tool}
          size="row"
          label={shell ? undefined : names[session.tool]}
        />
        <span className={`activity-dot ${activity.state}`} aria-hidden="true" />
      </span>
      <span>
        <strong>{session.name}</strong>
        <small>
          <span className={`activity-label ${activity.state}`}>{activity.label}</span>
          {location && ` · ${location}`}
          {session.sandbox && ` · ${sandboxBadge(session)}`}
        </small>
      </span>
    </button>
  );
}
```

`web/app/Sidebar.jsx` — replace the `sessions.map((s) => { … })` body with

```jsx
            sessions.map((s) => (
              <SessionRow
                key={s.id}
                session={s}
                selected={selected === s.id && view === "workspace"}
                onSelect={select}
                names={names}
              />
            ))
```

add `import SessionRow from "./SessionRow.jsx";`, remove the now unused
`ProviderMark` import and `sessionActivity`, `sandboxBadge` from the SidebarGroup
import.

- [ ] **Step 5: Row CSS** (`web/app/layout.css`)

Replace the `.session-item` … `.session-item small` block (`:275-341`) with:

```css
.session-item {
  display: flex;
  align-items: center;
  text-align: left;
  gap: 10px;
  padding: 8px 10px;
  width: 100%;
  border-radius: 8px;
  min-width: 0;
}
.session-item:hover {
  background: #202125;
}
.session-item.selected {
  background: #28292d;
}
.session-item > span:last-child {
  flex: 1;
  min-width: 0;
}
.session-provider {
  position: relative;
  flex-shrink: 0;
}
.session-provider .provider-mark.row.opencode {
  font-size: 24px;
}
.session-provider .activity-dot {
  position: absolute;
  right: -2px;
  bottom: -2px;
  width: 8px;
  height: 8px;
  flex-basis: 8px;
  margin: 0;
  box-shadow: 0 0 0 2px var(--sidebar-bg);
}
.session-item strong {
  display: block;
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text-row);
}
.session-item small {
  display: block;
  font-size: 11px;
  color: var(--text-meta);
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
```

(the `.session-directory` rules are deleted with this block).

- [ ] **Step 6: Run**

`AGENTPIER_TEST_PORT=4391 npx playwright test tests/browser/sidebar.spec.js tests/browser/chat-presentation.spec.js tests/browser/nono-sandbox.spec.js tests/browser/claude-activity.spec.js tests/browser/pipeline-session-list.spec.js tests/browser/navigation.spec.js tests/browser/projects.spec.js --output .cache/pw-part2`
Expected: PASS (`nono-sandbox` still finds „Sandbox · default“, `claude-activity`
still „Working“; projects/profile marks keep the `small` look).

- [ ] **Step 7: Commit**

```bash
npm run format
git add web/app web/components/ProviderMark.jsx tests/browser/sidebar.spec.js tests/browser/chat-presentation.spec.js
git commit -m "feat: compact session rows with a named provider mark

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Agent rows, team pill and expanded team block

**Files:**
- Modify: `web/features/assistants/AssistantSidebar.jsx` (render code `:81-197`)
- Create: `web/features/assistants/assistant-sidebar.css`
- Modify: `web/features/assistants/AssistantsRoot.jsx:1-3` (import)
- Modify: `web/features/assistants/assistants.css` — delete `:370-385`
  (`.assistant-sidebar-item…selected strong`), `:444-453` (`.assistant-sidebar-member…`),
  `:519-546` (`.assistant-sidebar-item > span…` through `.assistant-sidebar-item .assistant-sidebar-task`),
  `:550-562` (`.assistant-chats-group…` rules), `:591-600` (`.assistant-sidebar-toggle`).
  Keep `.assistant-member-provenance p` (`:547-549`; `AssistantMemberSettings.jsx` uses it)
  and `.assistant-team-permission` (settings checkboxes).
- Modify specs: `tests/browser/assistant-feature.spec.js:142,226`
- Test: `tests/browser/assistant-sidebar-rows.spec.js` (new)

**Interfaces:**
- Consumes (Part 1): `useAssistants().activity`; from `./assistant-status.js`:
  `activityFor(activity, id)`, `activityDot(entry)`,
  `sidebarSubline({ assistant, entry, member, model, copy })` → `{ text, tone }`.
  `model` is the agent's own `assistant.model` (`{ connectionId, modelId }`), as Part 1
  defines. For member rows `text` is only the state (activity label or phase); this
  task adds the role (root member rows) or the assignment (expanded team block).
- Produces: DOM `div.assistant-sidebar-row` › (`button.session-item.assistant-sidebar-item`,
  `button.assistant-team-pill`); member rows keep `.assistant-sidebar-member`.

- [ ] **Step 1: Failing spec `tests/browser/assistant-sidebar-rows.spec.js`**

```js
import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";

const lead = {
  id: "lead",
  name: "Chief of Staff with a deliberately long agent name",
  model: { connectionId: "router", modelId: "google/gemini-3.8-flash" },
  revision: 1,
};
const scout = {
  ...lead,
  id: "scout",
  name: "Recherche-Lead",
  teamMemberId: "m1",
  parentAssistantId: "lead",
  lifetime: "task",
  teamId: "t1",
};
async function fixture(page, activity) {
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  await page.route(/\/api\/assistant/, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/assistant-feature")
      return route.fulfill({ json: { enabled: true, error: null } });
    if (path === "/api/assistant-events")
      return route.fulfill({ contentType: "text/event-stream", body: 'data: {"type":"connected"}\n\n' });
    if (path === "/api/assistant-runtime")
      return route.fulfill({ json: { availability: "ready", sync: "current" } });
    if (path === "/api/assistants")
      return route.fulfill({
        json: {
          assistants: [lead, scout],
          conversations: [],
          models: [{ id: "router", name: "OpenRouter", available: true }],
          teams: [{ id: "t1", parentAssistantId: "lead", objective: "Prepare the relaunch", phase: "running", members: [], memberIds: ["m1"] }],
          members: [{ id: "m1", teamId: "t1", assistantId: "scout", name: "Recherche-Lead", role: "Research", assignment: "Review competitor pages", phase: "running", lifetime: "task" }],
          policies: {},
          teamSettings: { revision: 0, hostMaxConcurrent: 8 },
          ...(activity ? { activity } : {}),
        },
      });
    return route.fallback();
  });
}

test("agent rows show activity, a team pill and truncate long English copy", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page, {
    lead: { state: "working", reason: "team", label: "teamActive.working", pendingApprovals: 0, team: "active" },
  });
  await page.goto(baseURL);
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  const row = page.locator(".assistant-sidebar-row").first();
  await expect(row.locator(".activity-dot")).toHaveClass(/working/);
  await expect(row.locator(".assistant-sidebar-item small").first()).toHaveText("Team working");
  const name = row.locator("strong").first();
  expect(await name.evaluate((n) => n.scrollWidth > n.clientWidth)).toBe(true);
  await expect(name).toHaveCSS("text-overflow", "ellipsis");
  const pill = row.getByRole("button", { name: /Show team members \(1\)/ });
  await expect(pill).toHaveAttribute("aria-expanded", "false");
  await pill.click();
  await expect(row.getByRole("button", { name: /Hide team members \(1\)/ })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  const group = page.getByRole("group", { name: "Prepare the relaunch" });
  await expect(group.locator(".assistant-sidebar-member")).toHaveCount(1);
  await expect(group.getByRole("button", { name: /^Recherche-Lead, / })).toHaveAccessibleDescription(
    "Review competitor pages",
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("a list response without activity renders idle rows", async ({ page }) => {
  await fixture(page, undefined);
  await page.goto(baseURL);
  const row = page.locator(".assistant-sidebar-row").first();
  await expect(row).toBeVisible();
  await expect(row.locator(".activity-dot")).toHaveCount(0);
  await expect(row.locator(".assistant-sidebar-item small").first()).toHaveText(
    "google/gemini-3.8-flash",
  );
});
```

- [ ] **Step 2: Run** `AGENTPIER_TEST_PORT=4391 npx playwright test tests/browser/assistant-sidebar-rows.spec.js --output .cache/pw-part2`
Expected: FAIL (`.assistant-sidebar-row` not found).

- [ ] **Step 3: Rewrite the render part of `AssistantSidebar.jsx`**

Imports: add `import Icon from "../../components/Icon.jsx";` and
`import { activityFor, activityDot, sidebarSubline } from "./assistant-status.js";`.
Destructure `activity = {}` from `useAssistants()`. Keep `open`, `roots`,
`selectedMember`, `folded`, `toggle`, `visible` unchanged. Replace `item()` and the
returned JSX with:

```jsx
  const quiet = (phase) =>
    ["ready", "completed", "failed", "cancelled", "declined", "partial"].includes(phase);
  function item(assistant) {
    const member = members.find((m) => m.assistantId === assistant.id);
    const nested = assistant.teamMemberId && assistant.lifetime === "task";
    const chat = conversations.find(
      (c) =>
        c.assistantId === assistant.id &&
        !c.archivedAt &&
        (!c.channel || c.channel === "agentpier"),
    );
    const entry = activityFor(activity, assistant.id);
    const dot = activityDot(entry);
    const subline = sidebarSubline({
      assistant,
      entry,
      member,
      model: assistant.model,
      copy,
    });
    const current = route.assistantId === assistant.id && route.view === "agents";
    return (
      <button
        key={assistant.id}
        className={`session-item assistant-sidebar-item ${nested ? "assistant-sidebar-member" : ""} ${current ? "selected" : ""}`}
        aria-label={copy.sidebarLabel(
          assistant.name,
          member ? member.role : assistant.model.modelId,
          member
            ? copy.team.states[member.phase]
            : connectionMissing(assistant, models)
              ? copy.status.connectionMissing
              : copy.status[runtime.availability],
        )}
        aria-describedby={member ? `assistant-task-${assistant.id}` : undefined}
        aria-current={current ? "page" : undefined}
        disabled={!!opening && !chat && !member}
        onClick={() => open(assistant, chat)}
      >
        <span className="assistant-avatar-wrap" aria-hidden="true">
          <span className="assistant-avatar">{avatarGlyph(assistant.name)}</span>
          {dot && <span className={`activity-dot ${dot}`} />}
        </span>
        <span>
          <strong>{assistant.name}</strong>
          {opening === assistant.id ? (
            <small>{copy.loading}</small>
          ) : nested ? (
            <small>
              <span className={quiet(member?.phase) ? "" : "accent"}>{subline.text}</span>
              {member && (
                <>
                  {" · "}
                  <span id={`assistant-task-${assistant.id}`} title={member.assignment}>
                    {member.assignment}
                  </span>
                </>
              )}
            </small>
          ) : (
            <>
              <small className={subline.tone === "accent" ? "accent" : ""}>
                {member ? `${member.role} · ${subline.text}` : subline.text}
              </small>
              {member && (
                <small
                  id={`assistant-task-${assistant.id}`}
                  className="assistant-sidebar-task"
                  title={member.assignment}
                >
                  {member.assignment}
                </small>
              )}
            </>
          )}
        </span>
      </button>
    );
  }
  if (!roots.length) return null;
  return (
    <SidebarGroup
      name="assistant-chats"
      label={copy.agentsGroup}
      ariaLabel={copy.chats}
      count={String(roots.length)}
      defaultOpen
      activeKey={route.assistantId}
    >
      <ErrorMessage error={error} />
      <div className="session-list">
        {roots.map((parent) => {
          const groups = new Map();
          for (const child of visible.filter(
            (a) => a.parentAssistantId === parent.id && a.lifetime === "task",
          )) {
            const member = members.find((m) => m.assistantId === child.id);
            const id = member?.teamId || child.teamId;
            if (!groups.has(id)) groups.set(id, []);
            groups.get(id).push(child);
          }
          const memberCount = [...groups.values()].reduce((n, c) => n + c.length, 0);
          const hidden = folded(parent);
          const current = route.assistantId === parent.id && route.view === "agents";
          return (
            <React.Fragment key={parent.id}>
              <div className={`assistant-sidebar-row ${current ? "selected" : ""}`}>
                {item(parent)}
                {memberCount > 0 && (
                  <button
                    type="button"
                    className="assistant-team-pill"
                    aria-expanded={!hidden}
                    aria-label={
                      hidden ? copy.showMembers(memberCount) : copy.hideMembers(memberCount)
                    }
                    onClick={() => toggle(parent.id)}
                  >
                    <Icon name="users" size={12} />
                    {memberCount}
                  </button>
                )}
              </div>
              {!hidden &&
                [...groups].reverse().map(([id, children]) => {
                  const team = teams.find((t) => t.id === id);
                  const label = team?.objective || copy.team.title;
                  const state = team && (team.status || team.phase);
                  return (
                    <div
                      className="assistant-sidebar-team"
                      role="group"
                      aria-label={label}
                      key={id || "members"}
                    >
                      <div className="assistant-sidebar-assignment">
                        <strong title={label}>{label}</strong>
                        {team && (
                          <small className={quiet(state) ? "" : "accent"}>
                            · {copy.team.states[state]}
                          </small>
                        )}
                      </div>
                      {children.map(item)}
                    </div>
                  );
                })}
            </React.Fragment>
          );
        })}
      </div>
    </SidebarGroup>
  );
```

Note: the pill is no longer hidden while a member is selected; `folded()` already
forces the block open then, so the pill shows `aria-expanded="true"`.

- [ ] **Step 4: `web/features/assistants/assistant-sidebar.css`** (and
`import "./assistant-sidebar.css";` after `import "./assistants.css";` in
`AssistantsRoot.jsx`)

```css
/* Agent rows in the shared sidebar scroll area (handoff 1a / 2f). */
.assistant-sidebar-row {
  display: flex;
  align-items: center;
  gap: 6px;
  border-radius: 8px;
}
.assistant-sidebar-row:hover {
  background: var(--button-secondary-bg);
}
.assistant-sidebar-row.selected {
  background: var(--surface-accent);
}
.assistant-sidebar-item {
  flex: 1;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 8px;
}
.assistant-sidebar-row .assistant-sidebar-item:hover,
.assistant-sidebar-row .assistant-sidebar-item.selected {
  background: transparent;
}
.assistant-sidebar-item.selected strong {
  color: var(--accent);
}
.assistant-sidebar-item > span:last-child {
  min-width: 0;
}
.assistant-avatar-wrap {
  position: relative;
  flex-shrink: 0;
  display: inline-flex;
}
.assistant-sidebar-item .assistant-avatar {
  width: 30px;
  height: 30px;
  flex-basis: 30px;
  border-radius: 9px;
  font-size: 13px;
}
.assistant-avatar-wrap .activity-dot {
  position: absolute;
  right: -2px;
  bottom: -2px;
  width: 8px;
  height: 8px;
  margin: 0;
  box-shadow: 0 0 0 2px var(--sidebar-bg);
}
.assistant-sidebar-item small {
  display: block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.assistant-sidebar-item small.accent,
.assistant-sidebar-item small .accent,
.assistant-sidebar-assignment .accent {
  color: var(--accent-text);
}
.assistant-sidebar-item .assistant-sidebar-task {
  margin-top: 3px;
  color: var(--muted);
}
.assistant-team-pill {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  margin-right: 8px;
  padding: 0 9px;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: var(--pill-bg);
  color: var(--pill-text);
  font-size: 11px;
  font-weight: 500;
}
.assistant-team-pill[aria-expanded="true"] {
  border-color: var(--accent-line);
  color: var(--accent-text);
}
.assistant-sidebar-team {
  min-width: 0;
  margin: 2px 0 8px 25px;
  padding-left: 12px;
  border-left: 1px solid var(--line);
}
.assistant-sidebar-assignment {
  display: flex;
  gap: 6px;
  min-width: 0;
  padding: 6px 6px 4px;
  font-size: 11px;
  color: var(--muted);
}
.assistant-sidebar-assignment strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 400;
}
.assistant-sidebar-assignment small {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--text-meta);
}
.assistant-sidebar-member {
  gap: 9px;
  padding: 6px;
  border-radius: 6px;
}
.assistant-sidebar-member .assistant-avatar {
  width: 22px;
  height: 22px;
  flex-basis: 22px;
  border-radius: 6px;
  font-size: 10px;
}
.assistant-sidebar-member strong {
  font-size: 12px;
}
.assistant-sidebar-member small {
  font-size: 10px;
}
```

Delete the listed sidebar rules from `assistants.css` (they are all replaced above);
`wc -l web/features/assistants/assistants.css` must drop well below 600.

- [ ] **Step 5: Update `assistant-feature.spec.js`**

Both `await expect(page.getByText("Agent chats")).toHaveCount(0);` lines (originally
`:108` and `:142`; Task 3 shifted them, match by content) →
`await expect(page.getByRole("button", { name: "Agent chats" })).toHaveCount(0);`
(the visible text is now „Agents“; the accessible name stays „Agent chats“).

- [ ] **Step 6: Run**

`AGENTPIER_TEST_PORT=4391 npx playwright test tests/browser/assistant-sidebar-rows.spec.js tests/browser/assistant-feature.spec.js tests/browser/assistant-teams.spec.js tests/browser/assistants.spec.js --output .cache/pw-part2`
Expected: PASS for the new spec, `assistant-feature`, and the sidebar parts of
`assistant-teams` (`/Show team members/`, `.assistant-sidebar-member` count 4,
accessible description, „Partially successful“, `.assistant-chats-group >
.sidebar-group-content` above `.sessions-group`). Chat-header assertions in
`assistants.spec.js` are Part 3's; they must still pass here because the chat is not
changed yet. Then `node --test tests/unit/assistant-css.test.js tests/unit/theme-tokens.test.js` → PASS.

- [ ] **Step 7: Commit**

```bash
npm run format
git add web/features/assistants tests/browser/assistant-sidebar-rows.spec.js tests/browser/assistant-feature.spec.js
git commit -m "feat: show agent activity and team pills in the sidebar

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Fidelity check and part gate

**Files:**
- Create (scratchpad, not in repo): `$SCRATCH/part2-shots.mjs`
  where `SCRATCH=/private/tmp/claude-501/-Users-d-kaulig-Projects-agent-pier/3626d7cc-0f3d-4fbe-a2de-02ec5106bcb6/scratchpad`

- [ ] **Step 1: Screenshot script**

```js
// $SCRATCH/part2-shots.mjs — node $SCRATCH/part2-shots.mjs http://127.0.0.1:4391 $SCRATCH/shots-part2
import { chromium } from "/Users/d.kaulig/Projects/agent-pier/.worktrees/mobile-layout-redesign/node_modules/playwright/index.mjs";
const [base, out] = process.argv.slice(2);
const browser = await chromium.launch();
const context = await browser.newContext({ storageState: process.env.AUTH_STATE });
const page = await context.newPage();
for (const [name, size, steps] of [
  ["1a-list", { width: 390, height: 844 }, ["drawer"]],
  ["1a-menu", { width: 390, height: 844 }, ["drawer", "menu"]],
  ["2f", { width: 1440, height: 900 }, []],
  ["2f-menu", { width: 1440, height: 900 }, ["menu"]],
]) {
  await page.setViewportSize(size);
  await page.goto(base);
  await page.locator(".sidebar").waitFor();
  if (steps.includes("drawer"))
    await page.getByRole("button", { name: "Navigation öffnen", exact: true }).click();
  if (steps.includes("menu")) await page.locator(".sidebar .sidebar-menu-button").click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/${name}.png` });
}
await browser.close();
```

- [ ] **Step 2: Capture and compare**

Start the fixture server: `AGENTPIER_TEST_PORT=4391 node scripts/test-server.mjs &`
(login state: `AUTH_STATE=.cache/browser-auth-4391.json`, created by any earlier
Playwright run on that port). Run the script, then open each PNG next to
`$SCRATCH/shots/explore-1a.png` and `$SCRATCH/shots/detail-2f.png` and check:
drawer 316 px, header row 14/14/14/18 padding, brand 22 px with 28 px symbol, Menü
button 36 px (34 desktop), Neue Sitzung 40 px mobile / 43 px desktop with ↗ only on
desktop, sticky „Agenten“/„Sitzungen“ headers 36 px, rows 30 px avatar/mark with 8 px
dots, popover at 58/10 (mobile) and 52/12 (desktop), 256 px wide, item height 40/38,
group labels uppercase 10 px, divider, host status, Abmelden last. Fix deviations in
CSS before continuing; stop the server afterwards.

- [ ] **Step 3: Part gate**

Run: `npm run check`
Expected: lint, format, structure (assistants.css < 600), build and all Node suites
pass.

Run: `AGENTPIER_TEST_PORT=4391 npx playwright test --output .cache/pw-part2`
Expected: all Chromium specs pass except assertions that belong to Parts 3–4 (none
should fail: the chat and settings are untouched in Part 2). Investigate every failure.

- [ ] **Step 4: Commit any fidelity fixes**

```bash
npm run format
git add web tests
git commit -m "fix: align the sidebar with the handoff measurements

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

(skip if nothing changed).
