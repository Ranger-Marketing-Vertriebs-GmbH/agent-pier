# Mobile Layout Redesign, Part 4: Agent Settings, Docs, Verification

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Main plan: `docs/superpowers/plans/2026-10-11-mobile-layout-redesign.md` (Global
Constraints and Shared interfaces apply to every task here).
Spec: `docs/superpowers/specs/2026-10-11-mobile-layout-redesign-design.md`
(Decisions 3 and 7, „Step C“, „Documentation“, „Verification“, „Cleanup“).
Visual reference: handoff state **2e** (`Ausarbeitung 1a + 1d.dc.html`, `id="2e"`).

**Precondition:** Parts 1–3 are merged into the branch. The settings page already
renders `AssistantHeader` with `variant="settings"`, `onBack` and `openNavigation`
(Part 3), and the tokens from the spec table exist in `web/styles/base.css` (Part 2).
Line numbers below refer to the tree after Part 3; when they drift, match by the quoted
content.

## Values from handoff 2e (exact)

| Element | Value |
|---|---|
| Chip row | `padding: 8px 12px; gap: 8px; background: var(--surface-input); border-bottom: 1px solid var(--line)` |
| Chip | `padding: 6px 12px; border: 1px solid var(--line); border-radius: 999px; font-size: 13px` |
| Active chip | `background: var(--surface-accent); border-color: var(--accent-line); color: var(--accent-text)` |
| Form body | `padding: 18px 16px; gap: 16px` |
| Section title | `font: 600 17px Manrope, sans-serif` |
| Label | `font-size: 13px; color: var(--text-menu); gap: 8px` |
| Input | `background: var(--surface-input); border: 1px solid var(--line); border-radius: 8px; padding: 12px; font-size: 16px; color: var(--text)` |
| Capability box | `border: 1px solid var(--line); border-radius: 12px; padding: 14px; gap: 12px`, title 13/600 |
| Checkbox | 18×18, radius 4; on: `var(--accent)` fill, check 12 px stroke 2.4 `var(--on-accent)`; off: `1.5px solid var(--text-faint)`; row gap 10, 13 px |
| Save bar | `padding: 10px 12px 14px; gap: 8px; border-top: 1px solid var(--header-line); background: var(--sidebar-bg)` |
| Save bar note | `flex: 1; font-size: 11px; color: var(--muted); line-height: 1.4` |
| Save bar buttons | height 40, radius 7, 12/600; cancel `padding: 0 14px` secondary, save `padding: 0 16px` primary |

## File map

| File | Change |
|---|---|
| `web/features/assistants/synced-form-state.js` | **Create.** Pure `sameValue`, `isDirty` |
| `web/features/assistants/useSyncedForm.js` | Use `sameValue`, return `dirty` |
| `tests/unit/assistant-synced-form-state.test.js` | **Create.** Unit tests for `isDirty` |
| `web/features/assistants/AgentsPage.jsx` | `useSessionViewport` for settings (the `.assistant-settings-scroll` wrapper exists since Part 3) |
| `web/features/sessions/mobile-workspace.css` | ≤700 px containment for `.assistant-settings-page` |
| `web/features/assistants/assistant-settings.css` | Scroller, flat form, checkboxes, chips, save bar |
| `web/features/assistants/assistants.css` | Remove the 650 px `.assistant-form` padding rule (net line removal only) |
| `web/features/assistants/SettingsSectionNav.jsx` | Active chip via IntersectionObserver |
| `web/features/assistants/AssistantSaveBar.jsx` | **Create.** Sticky save bar |
| `web/features/assistants/AssistantSettings.jsx` | Profile title, save bar, form class |
| `web/lib/i18n/de/assistants.js`, `web/lib/i18n/en/assistants.js` | `pendingConfigShort` |
| `tests/helpers/assistant-settings-browser.js` | **Create.** Fixture extracted from the settings spec |
| `tests/browser/assistant-settings.spec.js` | Import the extracted fixture |
| `tests/browser/assistant-settings-mobile.spec.js` | **Create.** Step C coverage |
| `docs/assistant-gateway.md`, `docs/screenshots/agentpier-sidebar-*.png` | Docs refresh |

---

### Task 1: Dirty state for the synced form

**Files:**
- Create: `web/features/assistants/synced-form-state.js`
- Modify: `web/features/assistants/useSyncedForm.js:1-40`
- Test: `tests/unit/assistant-synced-form-state.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `sameValue(a, b): boolean`, `isDirty(values, base): boolean`;
  `useSyncedForm(server)` returns `{ values, set, conflicts, reload, dirty }`.

Design note: `dirty` compares the current values with the **current `server` prop**,
which is a render input. It therefore re-renders when the server converges to the
edited value (the reviewer's concern about a ref-only base). Untouched fields already
adopt newer server values in the existing effect, so a difference to `server` means
exactly „unsaved edit or unresolved conflict“.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/assistant-synced-form-state.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  isDirty,
  sameValue,
} from "../../web/features/assistants/synced-form-state.js";

const base = {
  name: "Home",
  instructions: "Plan meals",
  connectionId: "router",
  modelId: "model",
  capabilities: { memory: false, reminders: false },
};

test("identical values are clean", () => {
  assert.equal(isDirty({ ...base, capabilities: { ...base.capabilities } }, base), false);
});

test("a changed text field is dirty", () => {
  assert.equal(isDirty({ ...base, name: "Home 2" }, base), true);
});

test("a changed nested capability is dirty", () => {
  assert.equal(
    isDirty({ ...base, capabilities: { memory: true, reminders: false } }, base),
    true,
  );
});

test("a key present on only one side is dirty", () => {
  const { modelId, ...withoutModel } = base;
  assert.equal(modelId, "model");
  assert.equal(isDirty(withoutModel, base), true);
  assert.equal(isDirty(base, withoutModel), true);
});

test("sameValue compares by value", () => {
  assert.equal(sameValue({ a: [1, 2] }, { a: [1, 2] }), true);
  assert.equal(sameValue({ a: [1, 2] }, { a: [2, 1] }), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/unit/assistant-synced-form-state.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `synced-form-state.js`.

- [ ] **Step 3: Write minimal implementation**

Create `web/features/assistants/synced-form-state.js`:

```js
// Pure comparisons behind useSyncedForm, kept separate so they can be unit-tested.
export const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// True while the form holds values the server does not have yet.
export function isDirty(values, base) {
  const keys = new Set([...Object.keys(values), ...Object.keys(base)]);
  for (const key of keys) if (!sameValue(values[key], base[key])) return true;
  return false;
}
```

Modify `web/features/assistants/useSyncedForm.js`. Replace lines 1–2:

```js
import { useCallback, useEffect, useRef, useState } from "react";
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
```

with:

```js
import { useCallback, useEffect, useRef, useState } from "react";
import { isDirty, sameValue as same } from "./synced-form-state.js";
```

and replace the last line of the hook body:

```js
  return { values, set, conflicts, reload };
```

with:

```js
  return { values, set, conflicts, reload, dirty: isDirty(values, server) };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/unit/assistant-synced-form-state.test.js && npm run lint`
Expected: 5 tests pass, lint exits 0.

- [ ] **Step 5: Commit**

```bash
npm run format
git add web/features/assistants/synced-form-state.js web/features/assistants/useSyncedForm.js tests/unit/assistant-synced-form-state.test.js
git commit -m "feat: report unsaved agent profile edits

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Shared settings browser fixture

Pure test refactor so the new mobile spec does not duplicate the 100-line route stub
and `assistant-settings.spec.js` (405 lines) shrinks instead of growing.

**Files:**
- Create: `tests/helpers/assistant-settings-browser.js`
- Modify: `tests/browser/assistant-settings.spec.js:1-124`

**Interfaces:**
- Consumes: `fulfillEnabledAssistantFeature` (`tests/helpers/assistant-browser-fixture.js`),
  `fixture` (`tests/browser/providers-fixture.js`).
- Produces: `home(extra)`, `setupAssistantSettings(page, options) → state`,
  `emitChange(page)`. New options: `applyUpdates` (PATCH merges into the record and bumps
  `revision`), `saveDelay` (ms before the PATCH answers). New state field:
  `opened` (count of `POST /api/assistants/home/conversations`).

- [ ] **Step 1: Create the helper by moving code**

Create `tests/helpers/assistant-settings-browser.js`. Move lines 1–124 of
`tests/browser/assistant-settings.spec.js` into it with these exact changes:

1. Imports become:
   ```js
   import { fulfillEnabledAssistantFeature } from "./assistant-browser-fixture.js";
   import { fixture } from "../browser/providers-fixture.js";
   ```
   (`test`, `expect` and `baseURL` are not needed in the helper.)
2. `const home = …` becomes `export const home = …`.
3. `async function setup(page, options = {})` becomes
   `export async function setupAssistantSettings(page, options = {})`.
4. Add `opened: 0,` to the `state` object after `updates: [],`.
5. Replace the PATCH branch:
   ```js
    if (path === "/api/assistants/home" && method === "PATCH") {
      state.updates.push(route.request().postDataJSON());
      return route.fulfill({ json: state.assistants[0] });
    }
   ```
   with:
   ```js
    if (path === "/api/assistants/home" && method === "PATCH") {
      const body = route.request().postDataJSON();
      state.updates.push(body);
      if (options.saveDelay) await new Promise((r) => setTimeout(r, options.saveDelay));
      if (options.applyUpdates) {
        const { revision: _revision, confirmInstructions: _confirm, ...fields } = body;
        state.assistants[0] = {
          ...state.assistants[0],
          ...fields,
          revision: state.assistants[0].revision + 1,
        };
      }
      return route.fulfill({ json: state.assistants[0] });
    }
    if (path === "/api/assistants/home/conversations" && method === "POST") {
      state.opened += 1;
      return route.fulfill({ json: { id: "c1", assistantId: "home" } });
    }
   ```
6. `const change = (page) =>` becomes `export const emitChange = (page) =>`.

Leave `visibility` (lines 125–133) in the spec; it is only used there.

- [ ] **Step 2: Point the existing spec at the helper**

In `tests/browser/assistant-settings.spec.js`, delete the moved lines and put at the top:

```js
import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import {
  emitChange as change,
  home,
  setupAssistantSettings as setup,
} from "../helpers/assistant-settings-browser.js";
```

`home` is imported only if the spec still references it (`grep -n "home(" tests/browser/assistant-settings.spec.js`);
otherwise drop it from the import so lint stays clean.

- [ ] **Step 3: Run the spec unchanged in behaviour**

Run: `npm run build && npx playwright test tests/browser/assistant-settings.spec.js`
Expected: same pass count as before the move (all pass; Part 3 already updated the
badge test).

- [ ] **Step 4: Commit**

```bash
npm run format && npm run lint
git add tests/helpers/assistant-settings-browser.js tests/browser/assistant-settings.spec.js
git commit -m "test: share the agent settings browser fixture

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Settings scroll container and flat mobile form

**Files:**
- Modify: `web/features/assistants/AgentsPage.jsx` (imports; one hook call before the
  early returns)
- Modify: `web/features/sessions/mobile-workspace.css` (append a block after line 52)
- Modify: `web/features/assistants/assistant-settings.css`
- Modify: `web/features/assistants/assistants.css` (the `@media (max-width: 650px)` block
  that contains `.assistant-form { padding: 18px; }`)
- Modify: `web/features/assistants/AssistantSettings.jsx:83-84`
- Test: `tests/browser/assistant-settings-mobile.spec.js` (create)

**Interfaces:**
- Consumes: `useSessionViewport(active)` (`web/features/sessions/useSessionViewport.js`),
  `AssistantHeader` settings variant (Part 3), tokens `--text`, `--text-menu`,
  `--text-faint`, `--on-accent`, `--header-line`, `--sidebar-bg` (Part 2).
- Produces: DOM `section.assistant-detail.assistant-settings-page >
  [header] + div.assistant-settings-scroll > ErrorMessage + .assistant-settings-layout`;
  `h2.assistant-section-title` inside `#agent-profile`.

- [ ] **Step 1: Write the failing browser tests**

Create `tests/browser/assistant-settings-mobile.spec.js`:

```js
import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { setupAssistantSettings } from "../helpers/assistant-settings-browser.js";

const full = { capabilities: { memory: true, reminders: true } };
const scroller = (page) => page.locator(".assistant-settings-scroll");

test.describe("agent settings on phones", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("header and section chips stay put while the settings body scrolls", async ({
    page,
  }) => {
    await setupAssistantSettings(page, { assistant: full });
    await page.goto(baseURL + "/agents/home/settings");
    const nav = page.getByRole("navigation", { name: "Settings sections" });
    await expect(nav).toBeVisible();
    await expect(page.locator(".mobile-header")).toBeHidden();
    const before = await page.evaluate(() => ({
      header: document.querySelector(".assistant-settings-page > header")
        .getBoundingClientRect().top,
      nav: document.querySelector(".assistant-section-nav").getBoundingClientRect().top,
    }));
    await scroller(page).evaluate((el) => (el.scrollTop = el.scrollHeight));
    await expect
      .poll(() =>
        page.evaluate(() => ({
          header: document.querySelector(".assistant-settings-page > header")
            .getBoundingClientRect().top,
          nav: document.querySelector(".assistant-section-nav").getBoundingClientRect()
            .top,
          documentScroll: window.scrollY,
        })),
      )
      .toEqual({ ...before, documentScroll: 0 });
  });

  test("the profile form is flat and uses the 2e type scale", async ({ page }) => {
    await setupAssistantSettings(page);
    await page.goto(baseURL + "/agents/home/settings");
    const form = page.locator("#agent-profile");
    await expect(page.getByRole("heading", { name: "Profile" })).toBeVisible();
    const style = await form.evaluate((el) => {
      const css = getComputedStyle(el);
      const input = getComputedStyle(el.querySelector("input"));
      const title = getComputedStyle(el.querySelector(".assistant-section-title"));
      return {
        border: css.borderTopWidth,
        padding: css.padding,
        inputSize: input.fontSize,
        titleSize: title.fontSize,
        titleWeight: title.fontWeight,
      };
    });
    expect(style).toEqual({
      border: "0px",
      padding: "18px 16px",
      inputSize: "16px",
      titleSize: "17px",
      titleWeight: "600",
    });
  });

  test("custom checkboxes keep their native semantics", async ({ page }) => {
    await setupAssistantSettings(page);
    await page.goto(baseURL + "/agents/home/settings");
    const memory = page.getByRole("checkbox", { name: "Remember information" });
    await expect(memory).not.toBeChecked();
    const box = await memory.boundingBox();
    expect(Math.round(box.width)).toBe(18);
    await memory.check();
    await expect(memory).toBeChecked();
    expect(
      await memory.evaluate((el) => getComputedStyle(el).backgroundColor),
    ).toBe("rgb(244, 154, 88)");
  });

  for (const width of [390, 320])
    test(`no horizontal overflow at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 640 });
      await setupAssistantSettings(page, { assistant: full });
      await page.goto(baseURL + "/agents/home/settings");
      await expect(page.locator("#agent-profile")).toBeVisible();
      expect(
        await page.evaluate(() => {
          const el = document.querySelector(".assistant-settings-scroll");
          return (
            document.documentElement.scrollWidth <= innerWidth &&
            el.scrollWidth <= el.clientWidth
          );
        }),
      ).toBe(true);
    });
});
```

Before running, confirm the English checkbox label:
`grep -n "enableMemory" web/lib/i18n/en/assistants.js` and use that exact string in
the checkbox test (expected „Remember information“; adjust if the catalog differs).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build && npx playwright test tests/browser/assistant-settings-mobile.spec.js`
Expected: FAIL — the document scrolls instead of `.assistant-settings-scroll` (Part 3's
wrapper is not a scroll container yet), heading „Profile“ missing, form padding is not
`18px 16px`, checkbox width 13/16 px instead of 18.

- [ ] **Step 3: Size the settings page to the visual viewport**

Part 3 already wraps the settings body in `div.assistant-settings-scroll` (header
props `variant="settings"`, `onBack={() => back(assistant)}`, `openNavigation`,
`navigationOpen`) and gives it desktop padding. Do not add a second wrapper and do not
touch the header props; this step only adds the viewport hook.

In `web/features/assistants/AgentsPage.jsx` add the import after the
`AssistantChat` import:

```js
import useSessionViewport from "../sessions/useSessionViewport.js";
```

Directly after
`const conversationId = route.conversationId || team?.parentConversationId;` and before
`if (conversationId && assistant)` add (hooks must run before the early returns):

```js
  // Settings on phones scroll inside their own container under the fixed header, so
  // the visual viewport (keyboard) must size the app like the chat does.
  useSessionViewport(Boolean(route.agentSettings && assistant && !conversationId));
```

`AssistantChat` keeps its own `useSessionViewport(true)`; the `!conversationId` guard
mirrors the chat branch, so the two hooks never run at the same time (both clear the
same CSS variables on cleanup). With `false` the hook does nothing.

- [ ] **Step 4: Add the profile section title**

In `web/features/assistants/AssistantSettings.jsx`, directly after
`<form className="assistant-form" id="agent-profile" onSubmit={save}>` add:

```jsx
        {assistant && <h2 className="assistant-section-title">{copy.sections.profile}</h2>}
```

It is the focus target of the „Profile“ chip (SettingsSectionNav focuses the first
heading) and is hidden above 700 px, so desktop stays unchanged.

- [ ] **Step 5: Containment for the settings page**

Append to `web/features/sessions/mobile-workspace.css` (after the closing `}` of the
first `@media (max-width: 700px), (any-pointer: coarse)` block, before the
`@media (min-width: 701px) and (any-pointer: coarse)` block):

```css
@media (max-width: 700px) {
  /* Agent settings scroll inside .assistant-settings-scroll below the fixed header. */
  html:has(.assistant-settings-page),
  body:has(.assistant-settings-page) {
    overflow: hidden;
    overscroll-behavior: none;
  }
  .app:has(.assistant-settings-page) {
    position: fixed;
    top: var(--session-viewport-top, 0px);
    left: 0;
    width: 100%;
    height: var(--session-viewport-height, 100dvh);
    min-height: 0;
    overflow: hidden;
  }
  .app:has(.assistant-settings-page) main {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .app:has(.assistant-settings-page) .sidebar {
    top: var(--session-viewport-top, 0px);
    bottom: auto;
    height: var(--session-viewport-height, 100dvh);
  }
}
```

The block is deliberately ≤700 px only: on the 820 px touch tablet the settings page keeps
its current scrolling.

- [ ] **Step 6: Flat form CSS**

In `web/features/assistants/assistants.css`, inside the `@media (max-width: 650px)` block
that follows `.assistant-status.ready { color: var(--success); }`, delete:

```css
  .assistant-form {
    padding: 18px;
  }
```

Replace the whole content of `web/features/assistants/assistant-settings.css` with the
block below. It keeps Part 3's page and scroller rules (`.assistant-detail.assistant-settings-page`,
`.assistant-settings-scroll` padding, layout margin), keeps the old ≤650 px chip row
until Task 4 replaces it (the existing „mobile settings have section links“ test needs it),
and keeps `.assistant-state-badge.connectionMissing`, which the agent list card in
`AgentsPage.jsx` still uses:

```css
.assistant-anchor {
  scroll-margin-top: 72px;
}
.assistant-section-nav,
.assistant-section-title,
.assistant-save-bar {
  display: none;
}
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
  padding: 28px;
}
.assistant-settings-scroll > .assistant-settings-layout {
  margin-top: 0;
}
@media (max-width: 650px) {
  .assistant-section-nav {
    position: sticky;
    top: 0;
    z-index: 2;
    display: flex;
    gap: 8px;
    overflow-x: auto;
    padding: 8px 0;
    background: var(--surface-input);
    border-bottom: 1px solid var(--line);
  }
  .assistant-section-nav a {
    flex: none;
    padding: 6px 12px;
    border: 1px solid var(--line);
    border-radius: 999px;
    color: inherit;
    text-decoration: none;
    white-space: nowrap;
  }
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
  .assistant-settings-page .assistant-settings-layout {
    margin-top: 0;
    gap: 0;
  }
  .assistant-settings-page :is(.assistant-anchor, #agent-profile) {
    scroll-margin-top: 56px;
  }
  .assistant-settings-page .assistant-form {
    gap: 16px;
    padding: 18px 16px;
    border: 0;
    border-radius: 0;
    background: none;
  }
  .assistant-settings-page :is(.assistant-anchor, .assistant-runtime-card) {
    border-top: 1px solid var(--line);
  }
  .assistant-settings-page .assistant-runtime-card {
    margin: 0;
    border-width: 1px 0 0;
    border-radius: 0;
    background: none;
    padding: 18px 16px;
  }
  .assistant-section-title,
  .assistant-settings-page .assistant-form h2 {
    display: block;
    margin: 0;
    font: 600 17px Manrope, sans-serif;
  }
  .assistant-settings-page .assistant-form label {
    gap: 8px;
    font-size: 13px;
    color: var(--text-menu);
  }
  .assistant-settings-page .assistant-form :is(input, textarea, select) {
    font-size: 16px;
    color: var(--text);
  }
  .assistant-settings-page .assistant-capability-options {
    gap: 12px;
    padding: 14px;
    border-radius: 12px;
  }
  .assistant-settings-page .assistant-capability-options legend {
    float: left;
    width: 100%;
    padding: 0;
    font-size: 13px;
    font-weight: 600;
  }
  .assistant-settings-page .assistant-capability-options label {
    align-items: center;
    gap: 10px;
    color: var(--text);
  }
  .assistant-settings-page input[type="checkbox"]:not([role="switch"]) {
    appearance: none;
    display: grid;
    place-content: center;
    flex: none;
    width: 18px;
    height: 18px;
    margin: 0;
    padding: 0;
    border: 1.5px solid var(--text-faint);
    border-radius: 4px;
    background: none;
  }
  .assistant-settings-page input[type="checkbox"]:not([role="switch"]):checked {
    border-color: var(--accent);
    background: var(--accent);
  }
  .assistant-settings-page input[type="checkbox"]:not([role="switch"]):checked::before {
    content: "";
    width: 8px;
    height: 4px;
    margin-top: -2px;
    border: solid var(--on-accent);
    border-width: 0 0 2.4px 2.4px;
    transform: rotate(-45deg);
  }
  .assistant-settings-page input[type="checkbox"]:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
}
.assistant-state-badge.connectionMissing {
  color: var(--accent);
  border-color: var(--accent-line);
  background: var(--accent-faint);
}
```

(The chip and save bar rules are added in Tasks 4 and 5.)

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm run build && npx playwright test tests/browser/assistant-settings-mobile.spec.js tests/browser/assistant-settings.spec.js`
Expected: all pass. If the checkbox colour assertion fails on WebKit only because of
colour-space rounding, compare with `toMatch(/^rgb\(244, 154, 88\)$/)` — do not loosen it
further.

- [ ] **Step 8: Check structure and assistant colour rule**

Run: `npm run check:structure && node --test tests/unit/assistant-css.test.js`
Expected: both pass (no hex in assistant CSS; every file ≤ 600 lines).

- [ ] **Step 9: Commit**

```bash
npm run format && npm run lint
git add web/features/assistants/AgentsPage.jsx web/features/assistants/AssistantSettings.jsx web/features/sessions/mobile-workspace.css web/features/assistants/assistant-settings.css web/features/assistants/assistants.css tests/browser/assistant-settings-mobile.spec.js
git commit -m "feat: give mobile agent settings their own flat scroll area

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Active section chip

**Files:**
- Modify: `web/features/assistants/SettingsSectionNav.jsx:1-40`
- Modify: `web/features/assistants/assistant-settings.css` (inside the ≤700 block)
- Test: `tests/browser/assistant-settings-mobile.spec.js`

**Interfaces:**
- Consumes: DOM from Task 3 (`.assistant-settings-scroll` as observer root).
- Produces: `a[aria-current="location"]` on exactly one chip.

- [ ] **Step 1: Write the failing tests**

Append inside the `test.describe("agent settings on phones", …)` block of
`tests/browser/assistant-settings-mobile.spec.js`:

```js
  test("the chip of the section in view is active", async ({ page }) => {
    await setupAssistantSettings(page, { assistant: full });
    await page.goto(baseURL + "/agents/home/settings");
    const nav = page.getByRole("navigation", { name: "Settings sections" });
    const current = nav.locator('a[aria-current="location"]');
    await expect(current).toHaveText("Profile");
    await page
      .locator("#agent-memory")
      .evaluate((el) => el.scrollIntoView({ block: "start" }));
    await expect(current).toHaveText("Memory");
    await expect(current).toHaveCount(1);
    const style = await current.evaluate((el) => {
      const css = getComputedStyle(el);
      return { color: css.color, background: css.backgroundColor };
    });
    expect(style).toEqual({
      color: "rgb(255, 201, 157)",
      background: "rgb(48, 38, 28)",
    });
  });

  test("clicking a chip activates it at once and keeps it in the chip row", async ({
    page,
  }) => {
    await setupAssistantSettings(page, { assistant: full });
    await page.goto(baseURL + "/agents/home/settings");
    const nav = page.getByRole("navigation", { name: "Settings sections" });
    const telegram = nav.getByRole("link", { name: "Telegram" });
    await telegram.click();
    await expect(telegram).toHaveAttribute("aria-current", "location");
    await expect(page.getByRole("heading", { name: "Telegram" })).toBeFocused();
    const inRow = await telegram.evaluate((el) => {
      const row = el.parentElement.getBoundingClientRect();
      const chip = el.getBoundingClientRect();
      return chip.left >= row.left && chip.right <= row.right;
    });
    expect(inRow).toBe(true);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build && npx playwright test tests/browser/assistant-settings-mobile.spec.js -g "chip"`
Expected: FAIL — no element with `aria-current="location"`.

- [ ] **Step 3: Implement the observer**

Replace `web/features/assistants/SettingsSectionNav.jsx` with:

```jsx
import React, { useEffect, useRef, useState } from "react";
import { assistantCopy as copy } from "../../lib/i18n/messages/assistants.js";
// While a chip click scrolls smoothly, intermediate sections must not steal the state.
const clickHold = 900;
// Jump links for the long settings page; only shown on narrow screens. The chip of the
// topmost section in view is marked as the current location.
export default function SettingsSectionNav({ assistant, personal }) {
  const sections = [
    ["profile", "agent-profile"],
    ...(personal ? [["access", "agent-access"]] : []),
    ...(personal && assistant.capabilities?.memory ? [["memory", "agent-memory"]] : []),
    ...(personal && assistant.capabilities?.reminders
      ? [
          ["reminders", "agent-reminders"],
          ["routines", "agent-routines"],
        ]
      : []),
    ...(!assistant.teamMemberId ? [["team", "agent-team"]] : []),
    ...(!assistant.teamMemberId || personal ? [["telegram", "agent-telegram"]] : []),
  ];
  const ids = sections.map(([, id]) => id).join(" ");
  const [active, setActive] = useState("agent-profile");
  const nav = useRef(null);
  const held = useRef(0);
  useEffect(() => {
    const scroll = nav.current?.closest(".assistant-settings-scroll");
    const root = scroll && getComputedStyle(scroll).overflowY !== "visible" ? scroll : null;
    const targets = ids
      .split(" ")
      .map((id) => document.getElementById(id))
      .filter(Boolean);
    if (!targets.length || typeof IntersectionObserver !== "function") return;
    const visible = new Set();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries)
          if (entry.isIntersecting) visible.add(entry.target.id);
          else visible.delete(entry.target.id);
        if (Date.now() < held.current) return;
        const first = targets.find((target) => visible.has(target.id));
        if (first) setActive(first.id);
      },
      // The band below the sticky chip row decides which section is current.
      { root, rootMargin: "-56px 0px -55% 0px" },
    );
    targets.forEach((target) => observer.observe(target));
    return () => observer.disconnect();
  }, [ids]);
  useEffect(() => {
    const row = nav.current;
    const chip = row?.querySelector(`a[href="#${active}"]`);
    if (!chip) return;
    if (
      chip.offsetLeft < row.scrollLeft ||
      chip.offsetLeft + chip.offsetWidth > row.scrollLeft + row.clientWidth
    )
      row.scrollLeft = Math.max(0, chip.offsetLeft - 12);
  }, [active]);
  return (
    <nav ref={nav} className="assistant-section-nav" aria-label={copy.settingsSections}>
      {sections.map(([key, id]) => (
        <a
          key={id}
          href={`#${id}`}
          aria-current={active === id ? "location" : undefined}
          onClick={(event) => {
            event.preventDefault();
            const target = document.getElementById(id);
            if (!target) return;
            held.current = Date.now() + clickHold;
            setActive(id);
            const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
            target.scrollIntoView({ block: "start", behavior: calm ? "auto" : "smooth" });
            const heading = target.querySelector("h1, h2, h3") || target;
            heading.tabIndex = -1;
            heading.focus({ preventScroll: true });
          }}
        >
          {copy.sections[key]}
        </a>
      ))}
    </nav>
  );
}
```

`offsetLeft` is relative to the nav because the nav is `position: sticky` (a positioned
offset parent).

- [ ] **Step 4: Chip styles**

In `web/features/assistants/assistant-settings.css`, inside the `@media (max-width: 700px)`
block, add after the `.assistant-settings-scroll` rule:

```css
  .assistant-section-nav {
    position: sticky;
    top: 0;
    z-index: 2;
    display: flex;
    gap: 8px;
    overflow-x: auto;
    padding: 8px 12px;
    background: var(--surface-input);
    border-bottom: 1px solid var(--line);
    scrollbar-width: none;
  }
  .assistant-section-nav a {
    flex: none;
    padding: 6px 12px;
    border: 1px solid var(--line);
    border-radius: 999px;
    color: inherit;
    font-size: 13px;
    text-decoration: none;
    white-space: nowrap;
  }
  .assistant-section-nav a[aria-current="location"] {
    border-color: var(--accent-line);
    background: var(--surface-accent);
    color: var(--accent-text);
  }
```

Delete the old `@media (max-width: 650px)` block for `.assistant-section-nav` that Task 3
carried over (it is superseded; the section nav now appears at ≤700 px, decision 10).

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run build && npx playwright test tests/browser/assistant-settings-mobile.spec.js tests/browser/assistant-settings.spec.js`
Expected: all pass, including the existing „section links move focus to the section
heading“ and „mobile settings have section links…“ tests.

- [ ] **Step 6: Commit**

```bash
npm run format && npm run lint
git add web/features/assistants/SettingsSectionNav.jsx web/features/assistants/assistant-settings.css tests/browser/assistant-settings-mobile.spec.js
git commit -m "feat: highlight the settings section in view

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Sticky save bar

**Files:**
- Create: `web/features/assistants/AssistantSaveBar.jsx`
- Modify: `web/features/assistants/AssistantSettings.jsx` (imports; end of the fragment;
  `.assistant-actions` div of the profile form)
- Modify: `web/features/assistants/assistant-settings.css`
- Modify: `web/lib/i18n/de/assistants.js` (after `pendingConfig`, line ~415),
  `web/lib/i18n/en/assistants.js` (after `pendingConfig`, line ~403)
- Test: `tests/browser/assistant-settings-mobile.spec.js`

**Interfaces:**
- Consumes: `useSyncedForm().dirty` (Task 1), `AssistantSettings` `busy`, `onCancel`.
- Produces: `AssistantSaveBar({ form, busy, creating, onCancel })` rendering
  `div.assistant-save-bar` (hidden above 700 px); copy `assistantCopy.pendingConfigShort`.

- [ ] **Step 1: Write the failing tests**

Append inside the `test.describe("agent settings on phones", …)` block:

```js
  const bar = (page) => page.locator(".assistant-save-bar");

  test("the save bar appears after an edit and saves the profile", async ({ page }) => {
    const state = await setupAssistantSettings(page, { applyUpdates: true });
    await page.goto(baseURL + "/agents/home/settings");
    await expect(page.locator("#agent-profile")).toBeVisible();
    await expect(bar(page)).toHaveCount(0);
    await page.getByRole("textbox", { name: "Name" }).fill("Home 2");
    await expect(bar(page)).toBeVisible();
    await expect(bar(page)).toContainText("Applies before the next message.");
    await expect(page.getByRole("button", { name: "Save agent" })).toHaveCount(1);
    await bar(page).getByRole("button", { name: "Save agent" }).click();
    await expect.poll(() => state.updates.at(-1)?.name).toBe("Home 2");
    await expect(bar(page)).toHaveCount(0);
  });

  test("the save bar mirrors a running save", async ({ page }) => {
    await setupAssistantSettings(page, { applyUpdates: true, saveDelay: 800 });
    await page.goto(baseURL + "/agents/home/settings");
    await page.getByRole("textbox", { name: "Name" }).fill("Home 2");
    await bar(page).getByRole("button", { name: "Save agent" }).click();
    const busy = bar(page).getByRole("button", { name: "Loading…" });
    await expect(busy).toBeDisabled();
    await expect(bar(page)).toHaveCount(0);
  });

  test("cancel in the save bar returns to the conversation", async ({ page }) => {
    const state = await setupAssistantSettings(page);
    await page.goto(baseURL + "/agents/home/settings");
    await page.getByRole("textbox", { name: "Name" }).fill("Home 2");
    await bar(page).getByRole("button", { name: "Cancel" }).click();
    await expect(page).toHaveURL(/\/agents\/home\/chats\/c1$/);
    expect(state.opened).toBe(1);
  });

  test("the save bar never covers the last section", async ({ page }) => {
    await setupAssistantSettings(page, { assistant: full });
    await page.goto(baseURL + "/agents/home/settings");
    await page.getByRole("textbox", { name: "Name" }).fill("Home 2");
    await scroller(page).evaluate((el) => (el.scrollTop = el.scrollHeight));
    const last = page.locator("#agent-telegram button").last();
    await expect(last).toBeVisible();
    const overlap = await page.evaluate(() => {
      const buttons = document.querySelectorAll("#agent-telegram button");
      const b = buttons[buttons.length - 1].getBoundingClientRect();
      const s = document.querySelector(".assistant-save-bar").getBoundingClientRect();
      return b.bottom > s.top && b.top < s.bottom;
    });
    expect(overlap).toBe(false);
  });

  test("creating an agent shows the save bar at once", async ({ page }) => {
    await setupAssistantSettings(page);
    await page.goto(baseURL + "/agents");
    await page.getByRole("button", { name: "New agent" }).click();
    await expect(bar(page)).toBeVisible();
    await expect(bar(page).getByRole("button", { name: "Save agent" })).toBeVisible();
  });
```

Then append at the end of the file, **after** the closing `});` of the describe block:

```js
test("desktop settings keep the in-form buttons and no save bar", async ({ page }) => {
  await setupAssistantSettings(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(baseURL + "/agents/home/settings");
  await page.getByRole("textbox", { name: "Name" }).fill("Home 2");
  await expect(page.locator(".assistant-save-bar")).toBeHidden();
  await expect(
    page.locator("#agent-profile").getByRole("button", { name: "Save agent" }),
  ).toBeVisible();
});
```

Check the English strings first: `grep -n '"Name"\|  name:' web/lib/i18n/en/assistants.js`
and `grep -n "loading:\|  cancel:\|  save:\|  create:" web/lib/i18n/en/assistants.js`
(expected „Name“, „Loading…“, „Cancel“, „Save agent“, „New agent“).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build && npx playwright test tests/browser/assistant-settings-mobile.spec.js -g "save bar|creating|desktop settings"`
Expected: FAIL — `.assistant-save-bar` never appears.

- [ ] **Step 3: Add the copy**

`web/lib/i18n/de/assistants.js`, after the `pendingConfig:` line:

```js
  pendingConfigShort: "Gilt ab der nächsten Nachricht.",
```

`web/lib/i18n/en/assistants.js`, after the `pendingConfig:` line:

```js
  pendingConfigShort: "Applies before the next message.",
```

- [ ] **Step 4: Create the bar**

Create `web/features/assistants/AssistantSaveBar.jsx`:

```jsx
import React from "react";
import { assistantCopy as copy } from "../../lib/i18n/messages/assistants.js";
// Phone-only save controls for the agent profile form. They submit the form by id, so
// the bar can sit at the end of the settings page while the form stays where it is.
export default function AssistantSaveBar({ form, busy, creating, onCancel }) {
  return (
    <div className="assistant-save-bar">
      {!creating && <p>{copy.pendingConfigShort}</p>}
      <button className="button secondary" type="button" onClick={onCancel}>
        {copy.cancel}
      </button>
      <button className="button primary" type="submit" form={form} disabled={busy}>
        {busy ? copy.loading : copy.save}
      </button>
    </div>
  );
}
```

- [ ] **Step 5: Render it from the settings form**

In `web/features/assistants/AssistantSettings.jsx`:

1. Add the import after `import SettingsSectionNav from "./SettingsSectionNav.jsx";`:
   ```js
   import AssistantSaveBar from "./AssistantSaveBar.jsx";
   ```
2. Give the in-form actions a class to hide on phones. Replace
   `<div className="assistant-actions">` inside the profile form with
   `<div className="assistant-actions assistant-profile-actions">`.
3. As the last child of the returned fragment (after the Telegram anchor block, before
   `</>`), add:
   ```jsx
      {(form.dirty || !assistant) && (
        <AssistantSaveBar
          form="agent-profile"
          busy={busy}
          creating={!assistant}
          onCancel={onCancel}
        />
      )}
   ```

The bar is the last in-flow element of the settings column, so at the end of the scroll
range it rests below the Telegram section instead of covering it.

- [ ] **Step 6: Save bar styles**

In `web/features/assistants/assistant-settings.css`, inside the `@media (max-width: 700px)`
block, add:

```css
  .assistant-profile-actions {
    display: none;
  }
  .assistant-save-bar {
    position: sticky;
    bottom: 0;
    z-index: 2;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px calc(14px + env(safe-area-inset-bottom));
    border-top: 1px solid var(--header-line);
    background: var(--sidebar-bg);
  }
  .assistant-save-bar p {
    flex: 1;
    min-width: 0;
    margin: 0;
    color: var(--muted);
    font-size: 11px;
    line-height: 1.4;
  }
  .assistant-save-bar .button {
    height: 40px;
    border-radius: 7px;
    font-size: 12px;
    font-weight: 600;
  }
  .assistant-save-bar .button.secondary {
    margin-left: auto;
    padding: 0 14px;
  }
  .assistant-save-bar .button.primary {
    padding: 0 16px;
  }
```

The top-level `.assistant-save-bar { display: none; }` from Task 3 keeps the bar out of
desktop layouts and out of the accessibility tree there; the in-form buttons stay.

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm run build && npx playwright test tests/browser/assistant-settings-mobile.spec.js tests/browser/assistant-settings.spec.js tests/browser/assistant-model-picker.spec.js tests/browser/assistant-accounts.spec.js`
Expected: all pass (the three existing specs click „Save agent“ on desktop and still find
exactly one).

- [ ] **Step 8: Commit**

```bash
npm run format && npm run lint && npm run check:structure
git add web/features/assistants/AssistantSaveBar.jsx web/features/assistants/AssistantSettings.jsx web/features/assistants/assistant-settings.css web/lib/i18n/de/assistants.js web/lib/i18n/en/assistants.js tests/browser/assistant-settings-mobile.spec.js
git commit -m "feat: add a sticky save bar to mobile agent settings

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Step C check in WebKit and the tablet project

**Files:** none changed unless a failure needs a fix (fix in the owning file, add a
regression test in `tests/browser/assistant-settings-mobile.spec.js`).

- [ ] **Step 1: Run the settings specs in WebKit, including the 820 px tablet project**

Run: `AGENTPIER_TEST_BROWSER=webkit npx playwright test tests/browser/assistant-settings-mobile.spec.js tests/browser/assistant-settings.spec.js`
Expected: all pass in both `desktop` and `tablet` projects. On the tablet project
(820 px, touch) the phone-only tests still pass because they set a 390 px viewport via
`test.use`; the desktop test passes because the bar is hidden above 700 px.

- [ ] **Step 2: Run the full check**

Run: `npm run check`
Expected: lint, format, structure, build and all Node suites pass.

- [ ] **Step 3: Commit only if Step 1 required a fix**

```bash
git add -A web tests
git commit -m "fix: keep mobile agent settings stable in WebKit

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Documentation and screenshots

**Files:**
- Modify: `docs/assistant-gateway.md` (section „Visible teams: operation and recovery“,
  the sentence with „the composer’s one-message checkbox“, around line 497)
- Modify: `docs/screenshots/agentpier-sidebar-desktop.png`,
  `docs/screenshots/agentpier-sidebar-mobile.png`
- Verify: `docs/verification.md:78-79`

- [ ] **Step 1: Update the composer description**

In `docs/assistant-gateway.md` replace:

```
text command or the composer’s one-message checkbox authorizes one proposal for
that request.
```

with:

```
text command or the one-message team switch behind the composer’s „+“ options button
authorizes one proposal for that request; while it is on, a „Team allowed“ chip
next to the button shows it and turns it off again when tapped.
```

Then search the doc for other stale UI wording:
`grep -n "checkbox\|tab\b\|Tabs\|breadcrumb\|Teammitglieder anzeigen\|Show team members" docs/assistant-*.md`
and rewrite each hit that describes the old chat tabs, breadcrumb or member toggle to the
new header gear, back button, Menü → Agenten, and team pill. Leave hits that describe
settings checkboxes untouched.

- [ ] **Step 2: Regenerate the sidebar screenshots**

`tests/browser/sidebar.spec.js` already writes them in the test „activity labels
distinguish working, unknown and Shell“ (desktop 1440×1000 and mobile 390×844) to
`/tmp/agentpier-sidebar-{desktop,mobile}.png`. For the mobile file the drawer must be
open; the test already clicks „Navigation öffnen“ in its `if (mobile)` branch before the
row assertions (Part 2 only changes its subline expectations). Confirm with
`grep -n "agentpier-sidebar" -B25 tests/browser/sidebar.spec.js`; if that click is
missing, add before the `page.screenshot` call:

```js
    if (mobile) {
      await page.getByRole("button", { name: "Navigation öffnen" }).click();
      await expect(page.locator(".sidebar")).toHaveClass(/open/);
    }
```

Run:

```bash
npm run build
npx playwright test tests/browser/sidebar.spec.js -g "activity labels distinguish"
cp /tmp/agentpier-sidebar-desktop.png docs/screenshots/agentpier-sidebar-desktop.png
cp /tmp/agentpier-sidebar-mobile.png docs/screenshots/agentpier-sidebar-mobile.png
```

Expected: 2 tests pass; both PNGs show the new Menü button, the shared Agents/Sessions
list and the new session rows. Open them with the Read tool and compare against
handoff 1a (left phone) and 2f.

- [ ] **Step 3: Verify links**

Run: `grep -n "agentpier-sidebar" docs/verification.md && ls docs/screenshots/agentpier-sidebar-*.png`
Expected: both links resolve to the two files.

- [ ] **Step 4: Commit**

```bash
npx prettier --check docs/assistant-gateway.md
git add docs/assistant-gateway.md docs/screenshots/agentpier-sidebar-desktop.png docs/screenshots/agentpier-sidebar-mobile.png tests/browser/sidebar.spec.js
git commit -m "docs: describe the agent composer options and refresh sidebar screenshots

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Final verification and fidelity pass

**Files:** none planned; any fix goes into the owning file with a regression test and
its own `fix:` commit.

- [ ] **Step 1: Full Node check**

Run: `npm run check`
Expected: exit 0.

- [ ] **Step 2: Full browser suite, Chromium**

Run: `npm run test:e2e`
Expected: all specs pass. Record the pass count.

- [ ] **Step 3: Full browser suite, WebKit (desktop and tablet projects)**

Run: `AGENTPIER_TEST_BROWSER=webkit AGENTPIER_TEST_PORT=4391 npx playwright test --output test-results-webkit`
Expected: all specs pass in both projects.

- [ ] **Step 4: CI repeat set**

Run: `AGENTPIER_TEST_BROWSER=webkit npx playwright test --grep 'two tabs retry|model field.*390x500|model errors remain' --repeat-each=5`
Expected: every repetition passes.

- [ ] **Step 5: Capture the redesigned states**

`$SCRATCH` is this session's scratchpad directory. The shots reuse the browser fixtures
through a temporary Playwright spec that is deleted right after the run:

```bash
mkdir -p "$SCRATCH/shots/after"
cat > tests/browser/zz-redesign-shots.spec.js <<'EOF'
import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { setupAssistantSettings } from "../helpers/assistant-settings-browser.js";
const out = process.env.REDESIGN_SHOTS;
for (const language of ["de", "en"])
  for (const [width, height] of [
    [390, 844],
    [1440, 900],
    [320, 640],
  ])
    test(`shots ${language} ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await setupAssistantSettings(page, {
        language,
        assistant: { capabilities: { memory: true, reminders: true } },
      });
      await page.goto(baseURL + "/agents/home/settings");
      await expect(page.locator("#agent-profile")).toBeVisible();
      await page.screenshot({ path: `${out}/settings-${language}-${width}.png` });
      await page.getByRole("textbox", { name: "Name", exact: true }).fill("Chief of Staff");
      await page.screenshot({ path: `${out}/settings-dirty-${language}-${width}.png` });
      if (width <= 700) {
        await page.getByRole("button", { name: /Navigation öffnen|Open navigation/ }).click();
        await page.screenshot({ path: `${out}/drawer-${language}-${width}.png` });
        await page.getByRole("button", { name: /^(Menü|Menu)$/ }).click();
        await page.screenshot({ path: `${out}/menu-${language}-${width}.png` });
      }
    });
EOF
npm run build
REDESIGN_SHOTS="$SCRATCH/shots/after" npx playwright test tests/browser/zz-redesign-shots.spec.js
rm tests/browser/zz-redesign-shots.spec.js
```

Then capture the chat states (1d, 2a, 2c, 2d) with a second temporary spec built like
Part 3 Task 8 Step 2 (`zz-pixel-check.spec.js`): `chatFixture` from
`tests/helpers/assistant-chat-fixture.js` with `language` set to `de` and `en`, the
`working` history plus an `emit` delta for 2a, the `action(...)` and `waiting(n)` shapes
and a `runningTeam({ phase: "awaiting_approval" })` from
`tests/browser/assistant-chat-teams.spec.js` for 2c, and `memberSetup()` for 2d (copy
those helpers into the temporary spec; they are not exported). Shots: idle
conversation, options popover, working with a streaming delta, pending team approval
plus action approval, running team, member chat. The temporary spec file is deleted
after the run and never committed.

Expected: PNGs for every state in DE and EN at 390, 1440 and 320 px.

- [ ] **Step 6: Side-by-side comparison against the handoff**

For each state open the pair with the Read tool:

| Handoff | After |
|---|---|
| `shots/explore-1a.png` | `drawer-de-390.png`, `menu-de-390.png` |
| `shots/explore-1d.png` | chat idle and options popover, `de-390` |
| `shots/detail-2a.png` | chat working, `de-390` |
| `shots/detail-2c.png` | approval strip and cards, running team, `de-390` |
| `shots/detail-2d.png` | member chat, `de-390` |
| `shots/detail-2e.png` | `settings-dirty-de-390.png` |
| `shots/detail-2f.png` | chat and sidebar, `de-1440` |

Check: bar heights (56/68), paddings, radii, font sizes, icon choice and size, colours,
dot states, truncation. For any visible deviation measure in the browser
(`getComputedStyle`, `getBoundingClientRect`) against the `.dc.html` inline value, fix the
CSS in the owning file, add an assertion for that value to the owning spec, and commit as
`fix: match <element> to the mobile handoff`. In EN and at 320 px check that nothing wraps
into a second line where the mock has one (ellipsis instead) and that no control is
clipped.

- [ ] **Step 7: Keyboard and screen-reader smoke test**

At 390 px in Chromium: Tab from page load never focuses an element inside the closed
drawer; open drawer → Menü → Esc closes the popover only (focus on Menü) → Esc closes the
drawer; on settings, the „Profile“ chip focuses the „Profile“ heading. Record results in
the PR description. Any failure: fix plus regression test.

---

### Task 9: Cleanup and pull request

**Files:**
- Delete: `docs/superpowers/specs/2026-10-11-mobile-layout-redesign-design.md`,
  `docs/superpowers/plans/2026-10-11-mobile-layout-redesign*.md`

- [ ] **Step 1: Make sure the handoff zip is not tracked**

Run: `git ls-files docs | grep -i "Mobile Layout" ; git status --short`
Expected: no output from `git ls-files`; the zip shows only as `??` (untracked). If it is
staged, unstage it with `git restore --staged "docs/Mobile Layout Verbesserungen.zip"`.

- [ ] **Step 2: Cleanup commit**

```bash
git rm docs/superpowers/specs/2026-10-11-mobile-layout-redesign-design.md docs/superpowers/plans/2026-10-11-mobile-layout-redesign*.md
git commit -m "chore: remove mobile layout redesign working documents

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 3: Final check after cleanup**

Run: `npm run check && git status --short`
Expected: check passes; only the untracked zip remains.

- [ ] **Step 4: Push**

```bash
git -c credential.helper='!gh auth git-credential' push -u origin feat/mobile-layout-redesign
```

Expected: branch published, tracking `origin/feat/mobile-layout-redesign`.

- [ ] **Step 5: Upload screenshots for the PR**

Pick DE and EN at 390 px and 1440 px: drawer, Menü, agent chat (idle, working,
approvals), member chat, settings with save bar, desktop 2f. Attach them by dragging into
the PR description on GitHub after creation, or commit nothing and reference them from a
PR comment; never add them to the repository.

- [ ] **Step 6: Open the pull request**

```bash
gh pr create --base main --head feat/mobile-layout-redesign \
  --title "feat: redesign the mobile sidebar and agent chat" \
  --body-file "$SCRATCH/pr-body.md"
```

Write `$SCRATCH/pr-body.md` first, in English, with these sections:

```markdown
## Problem

On phones the sidebar packed navigation, host status, logout, agent chats and sessions
into one 260 px drawer with three nested scroll areas, and the agent chat stacked five
header layers above a bordered transcript, leaving about 300 px for the conversation.

## Change

- **Sidebar (mobile and desktop):** navigation, host status and logout move into a
  „Menü“ popover inside the main navigation landmark; agents and sessions share one
  scroll area with sticky headers; team pill; compact session rows; closed drawer is
  inert.
- **Agent activity:** the server derives a per-agent activity (working, waiting,
  attention) and pending approval count from the request ledger, actions and teams;
  `GET /api/assistants` returns it as `activity`.
- **Agent chat:** one header bar, no tabs or breadcrumb, approval strip, flat replies,
  single composer with „+“ options, team chip and Stop pill, restyled team and approval
  cards, member context strip.
- **Agent settings:** own scroll area on phones, active section chip, flat form, sticky
  save bar while the profile has unsaved edits.

## Validation

- `npm run check`
- Playwright Chromium: <pass count>; WebKit desktop and tablet: <pass count>
- WebKit CI repeat set ×5
- Manual: 390, 320 and 1440 px in German and English; keyboard walk-through (results)
- Pixel comparison against the design handoff states 1a, 1d, 2a–2f

## Screenshots

<DE/EN 390 px and 1440 px images>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

Replace the two `<pass count>` markers with the numbers recorded in Task 8 Steps 2–3
before creating the PR, and insert the images after creation (Step 5). Also link
related Plane issues if the user names one.

- [ ] **Step 7: Report**

Report the PR URL. Do not merge: `main` is protected; merging waits for green CI
(Linux/macOS, Chromium/WebKit) and resolved reviews.
