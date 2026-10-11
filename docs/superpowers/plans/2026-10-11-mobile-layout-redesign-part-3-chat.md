# Mobile Layout Redesign — Part 3: Agent Chat

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Main plan: `docs/superpowers/plans/2026-10-11-mobile-layout-redesign.md` (Global
Constraints, shared interfaces, Review Focus — all apply here).
Spec: `docs/superpowers/specs/2026-10-11-mobile-layout-redesign-design.md`, section
„Step B: agent chat“ and decisions 6, 7, 10, 11.
Visual reference: handoff states 1d, 2a, 2c, 2d and the chat half of 2f (unzip
`docs/Mobile Layout Verbesserungen.zip` outside the repo; open the `.dc.html` files next
to `support.js`).

**Precondition:** parts 1 and 2 are merged into the branch. This part consumes:

- `useAssistants().activity`, `activityFor`, `headerStatus` from
  `web/features/assistants/assistant-status.js` (part 1).
- All tokens from `web/styles/base.css` (part 2), e.g. `--header-bg`, `--header-line`,
  `--accent-text`, `--accent-focus`, `--popover-raised`, `--popover-shadow`,
  `--button-secondary-bg|line|text`, `--text`, `--text-row`, `--text-meta`,
  `--text-menu`, `--text-faint`, `--text-message`, `--placeholder`, `--hint`,
  `--approval-bg|line`, `--divider`, `--divider-soft`, `--switch-off`, `--switch-knob`,
  `--on-accent`, `--sidebar-bg`.
- `navigateTo(page, name)` and `openMenu(page)` from `tests/helpers/navigation.js`
  (part 2).

**Build before every browser run.** Playwright serves the production build:
`npm run build && npx playwright test <spec> -g "<title>"`.

## File map

| File                                                                                       | Change                                                                                                   |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `web/components/Icon.jsx`                                                                  | `fill` prop                                                                                              |
| `web/lib/i18n/{de,en}/assistants.js`                                                       | 7 new keys                                                                                               |
| `web/app/App.jsx`                                                                          | `openNavigation` with focus return on Esc, `navigationOpen`                                              |
| `web/features/assistants/AgentsPage.jsx`                                                   | pass `openNavigation` and `navigationOpen`, settings header, back fallback, `.assistant-settings-scroll` |
| `web/features/assistants/AssistantHeader.jsx`                                              | rewrite: one bar, two variants                                                                           |
| `web/features/assistants/AssistantChat.jsx`                                                | header props, transcript order, composer, strip, member context                                          |
| `web/features/assistants/AssistantMessage.jsx`                                             | sr-only user name, `streaming`                                                                           |
| `web/features/assistants/AssistantComposer.jsx`                                            | new                                                                                                      |
| `web/features/assistants/ComposerOptions.jsx`                                              | new                                                                                                      |
| `web/features/assistants/useAssistantActions.js`                                           | new (from `AssistantActionApprovals`)                                                                    |
| `web/features/assistants/AssistantActionApprovals.jsx`                                     | presentational card list                                                                                 |
| `web/features/assistants/AssistantApprovalStrip.jsx`                                       | new                                                                                                      |
| `web/features/assistants/transcript-scroll.js`                                             | new `scrollToChild`                                                                                      |
| `web/features/assistants/AssistantMemberContext.jsx`                                       | new                                                                                                      |
| `web/features/assistants/AssistantTeams.jsx`                                               | rewrite (cards, whole-row members, no member summary)                                                    |
| `web/features/assistants/TeamCodingRequests.jsx`                                           | card markup                                                                                              |
| `web/features/assistants/AssistantsRoot.jsx`                                               | import `assistant-teams.css`                                                                             |
| `web/features/assistants/assistant-chat.css`                                               | rewrite                                                                                                  |
| `web/features/assistants/assistant-teams.css`                                              | new                                                                                                      |
| `web/features/assistants/assistant-settings.css`                                           | settings page padding wrapper                                                                            |
| `web/features/assistants/assistants.css`                                                   | only deletions                                                                                           |
| `tests/helpers/assistant-chat-fixture.js`                                                  | new fixture                                                                                              |
| `tests/browser/assistant-chat-layout.spec.js`                                              | new (header, transcript, composer)                                                                       |
| `tests/browser/assistant-chat-teams.spec.js`                                               | new (strip, member context, team cards)                                                                  |
| `tests/unit/assistant-chat-copy.test.js`, `tests/unit/assistant-transcript-scroll.test.js` | new                                                                                                      |
| existing specs                                                                             | `assistants`, `assistant-chat`, `assistant-teams`, `assistant-settings`                                  |

**Deviation from the spec, recorded here:** the header status class is
`.assistant-header-status`, not `.assistant-status`, because
`.assistant-status.ready` is already used by `AssistantRuntimeSettings.jsx:47`.

---

### Task 1: Icon fill and chat copy

**Files:**

- Modify: `web/components/Icon.jsx:2,38`
- Modify: `web/lib/i18n/de/assistants.js` (team block ~:134, top level ~:418)
- Modify: `web/lib/i18n/en/assistants.js` (team block ~:130, top level ~:406)
- Test: `tests/unit/assistant-chat-copy.test.js`

**Interfaces:**

- Consumes: nothing.
- Produces: `<Icon fill />` (boolean, fills with `currentColor`);
  `assistantCopy.team.allowedChip`, `stopShort`, `showApprovals`, `memberCount(n)`,
  `options`, `optionsClose`, `backToChat`.

- [ ] **Step 1: Write the failing test**

`tests/unit/assistant-chat-copy.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import * as de from "../../web/lib/i18n/de/assistants.js";
import * as en from "../../web/lib/i18n/en/assistants.js";

const strings = ["stopShort", "showApprovals", "options", "optionsClose", "backToChat"];
test("agent chat redesign copy exists in both languages", () => {
  for (const copy of [de.assistantCopy, en.assistantCopy]) {
    for (const key of strings) assert.equal(typeof copy[key], "string", key);
    assert.equal(typeof copy.team.allowedChip, "string");
  }
  assert.equal(de.assistantCopy.memberCount(1), "1 Mitglied");
  assert.equal(de.assistantCopy.memberCount(3), "3 Mitglieder");
  assert.equal(en.assistantCopy.memberCount(1), "1 member");
  assert.equal(en.assistantCopy.memberCount(3), "3 members");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/unit/assistant-chat-copy.test.js`
Expected: FAIL, `stopShort` is `undefined`.

- [ ] **Step 3: Add the copy**

`web/lib/i18n/de/assistants.js`, in `team: {` directly after
`stopMember: "Mitglied stoppen",`:

```js
    allowedChip: "Team erlaubt",
```

and at top level directly after `stop: "Antwort stoppen",`:

```js
  stopShort: "Stoppen",
  showApprovals: "Anzeigen",
  memberCount: (count) => (count === 1 ? "1 Mitglied" : `${count} Mitglieder`),
  options: "Optionen",
  optionsClose: "Optionen schließen",
  backToChat: "Zurück zur Unterhaltung",
```

`web/lib/i18n/en/assistants.js`, in `team: {` after `stopMember: "Stop member",`:

```js
    allowedChip: "Team allowed",
```

and after `stop: "Stop response",`:

```js
  stopShort: "Stop",
  showApprovals: "Show",
  memberCount: (count) => (count === 1 ? "1 member" : `${count} members`),
  options: "Options",
  optionsClose: "Close options",
  backToChat: "Back to conversation",
```

- [ ] **Step 4: Add the Icon `fill` prop**

`web/components/Icon.jsx` line 2 becomes:

```jsx
export default function Icon({ name, size = 18, fill = false, ...props }) {
```

and the `fill="none"` attribute on `<svg>` becomes:

```jsx
      fill={fill ? "currentColor" : "none"}
```

- [ ] **Step 5: Run the tests**

Run: `node --test tests/unit/assistant-chat-copy.test.js tests/unit/i18n-terminology.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
npm run format
git add web/components/Icon.jsx web/lib/i18n/de/assistants.js web/lib/i18n/en/assistants.js tests/unit/assistant-chat-copy.test.js
git commit -m "feat: add copy and filled icons for the agent chat redesign

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: One header bar for chat and settings

**Files:**

- Create: `tests/helpers/assistant-chat-fixture.js`
- Create: `tests/browser/assistant-chat-layout.spec.js`
- Rewrite: `web/features/assistants/AssistantHeader.jsx`
- Modify: `web/features/assistants/AgentsPage.jsx:11,30-72,111-113`
- Modify: `web/features/assistants/AssistantChat.jsx:25-30,163-178`
- Modify: `web/app/App.jsx` (Esc effect :56-63, `AgentsPage` :181, `SessionWorkspace` :263)
- Modify: `web/features/assistants/assistant-chat.css`,
  `web/features/assistants/assistant-settings.css`,
  `web/features/assistants/assistants.css` (deletions)
- Modify tests: `tests/browser/assistants.spec.js`, `tests/browser/assistant-teams.spec.js`,
  `tests/browser/assistant-chat.spec.js`, `tests/browser/assistant-settings.spec.js`

**Interfaces:**

- Consumes: `headerStatus`, `activityFor` (part 1); `navigateTo` (part 2).
- Produces: `AssistantHeader({ assistant, variant, navigate, onBack, openNavigation,
navigationOpen, attempt, member })` (no `onChat`: the conversation variant navigates
  to settings itself and the settings variant uses `onBack`); `AgentsPage({ route,
navigate, openNavigation, navigationOpen })`; `AssistantChat({ …, openNavigation,
navigationOpen })`; `navigationOpen` is App's `mobileNav` and drives the menu
  button's `aria-expanded`; `chatFixture(page, options)`,
  `chatAssistant(overrides)`, `emit(page, event)` test helpers; settings content
  wrapper `.assistant-settings-scroll` (part 4 turns it into the scroll container).

- [ ] **Step 1: Write the fixture helper**

`tests/helpers/assistant-chat-fixture.js`:

```js
import { fulfillEnabledAssistantFeature } from "./assistant-browser-fixture.js";
import { fixture } from "../browser/providers-fixture.js";

export function chatAssistant(overrides = {}) {
  return {
    id: "home",
    name: "Home assistant",
    instructions: "Plan meals",
    model: { connectionId: "router", modelId: "openai/gpt-4.1-mini" },
    revision: 1,
    effectiveRevision: 1,
    ...overrides,
  };
}

// One agent chat with every list field the redesign reads. Options replace the
// defaults; the returned state records posted messages and POST paths.
export async function chatFixture(page, options = {}) {
  const state = {
    language: "en",
    assistants: [chatAssistant()],
    conversations: [{ id: "dinner", assistantId: "home" }],
    models: [{ id: "router", name: "OpenRouter", available: true }],
    members: [],
    teams: [],
    activity: {},
    actions: [],
    runtime: { availability: "ready", sync: "current" },
    history: {
      messages: [
        { id: "question", role: "user", text: "Help me plan three dinners." },
        { id: "answer", role: "assistant", text: "We can plan dinner together." },
      ],
      requests: [],
      stale: false,
    },
    posted: [],
    calls: [],
    ...options,
  };
  await fixture(page);
  await page.addInitScript((language) => {
    localStorage.setItem("agentpier-language", language);
    const Native = window.EventSource;
    window.EventSource = class {
      constructor(url) {
        if (url !== "/api/assistant-events") return new Native(url);
        window.assistantTestStream = this;
        setTimeout(() => this.onopen?.(), 0);
      }
      close() {}
    };
  }, state.language);
  await page.route(/\/api\/assistant/, async (route) => {
    if (await fulfillEnabledAssistantFeature(route)) return;
    const p = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (
      [
        "/api/assistant-channels",
        "/api/assistant-speech",
        "/api/assistant-runtime/updates",
      ].includes(p)
    )
      return route.fallback();
    if (method === "POST") state.calls.push(p);
    let body = {};
    if (p === "/api/assistants")
      body = {
        assistants: state.assistants,
        conversations: state.conversations,
        models: state.models,
        members: state.members,
        teams: state.teams,
        activity: state.activity,
      };
    else if (p === "/api/assistant-runtime") body = state.runtime;
    else if (p.endsWith("/messages")) {
      if (method === "POST") state.posted.push(route.request().postDataJSON());
      body =
        method === "POST"
          ? {
              request: { id: "sent" },
              attempt: { id: "sent-attempt", state: "accepted" },
            }
          : state.history;
    } else if (p.endsWith("/actions")) body = { actions: state.actions };
    else if (p.endsWith("/conversations")) {
      const id = p.split("/")[3];
      body = state.conversations.find((c) => c.assistantId === id) || { id: "dinner" };
    } else if (p.startsWith("/api/assistants/"))
      body = state.assistants.find((a) => p === `/api/assistants/${a.id}`) || {};
    await route.fulfill({ json: body });
  });
  return state;
}

export const emit = (page, event) =>
  page.evaluate((event) => {
    window.assistantTestStream.onmessage({ data: JSON.stringify(event) });
  }, event);
```

- [ ] **Step 2: Write the failing header tests**

`tests/browser/assistant-chat-layout.spec.js`:

```js
import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { chatAssistant, chatFixture, emit } from "../helpers/assistant-chat-fixture.js";

const chat = baseURL + "/agents/home/chats/dinner";
const overflow = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth - innerWidth);

test.describe("agent chat header", () => {
  test("phone shows one 56px bar instead of the app header", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await chatFixture(page);
    await page.goto(chat);
    const header = page.locator(".assistant-header");
    await expect(header.getByRole("heading", { level: 1 })).toHaveText("Home assistant");
    await expect(page.locator(".mobile-header")).toBeHidden();
    await expect(page.locator(".assistant-breadcrumb, .assistant-view-tabs")).toHaveCount(
      0,
    );
    const status = header.locator(".assistant-header-status");
    await expect(status).toHaveClass(/\bready\b/);
    await expect(status).toContainText("Ready");
    await expect(status).toContainText("· openai/gpt-4.1-mini");
    await expect(status.locator(".assistant-header-dot")).toHaveCSS(
      "background-color",
      "rgb(125, 214, 165)",
    );
    expect(Math.round((await header.boundingBox()).height)).toBe(56);
    await header.getByRole("button", { name: "Agent settings", exact: true }).click();
    await expect(page).toHaveURL(/\/agents\/home\/settings$/);
    await expect(page.locator(".assistant-header-sub")).toHaveText("Settings");
    await page.getByRole("button", { name: "Back to conversation", exact: true }).click();
    await expect(page).toHaveURL(/\/agents\/home\/chats\/dinner$/);
  });

  test("header menu opens the drawer and Escape returns focus to it", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await chatFixture(page);
    await page.goto(chat);
    const menu = page
      .locator(".assistant-header")
      .getByRole("button", { name: "Open navigation", exact: true });
    await expect(menu).toHaveAttribute("aria-expanded", "false");
    await menu.click();
    await expect(page.locator(".sidebar")).toHaveClass(/\bopen\b/);
    await expect(menu).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Escape");
    await expect(page.locator(".sidebar")).not.toHaveClass(/\bopen\b/);
    await expect(menu).toBeFocused();
  });

  test("settings without a connection still reach the drawer and the agent list", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await chatFixture(page, {
      models: [{ id: "other", name: "Other", available: true }],
    });
    await page.goto(baseURL + "/agents/home/settings");
    await expect(page.locator(".assistant-header-status")).toHaveText(
      "Provider connection missing",
    );
    await expect(page.locator(".assistant-notice").first()).toContainText(
      "provider connection was deleted",
    );
    await page
      .locator(".assistant-header")
      .getByRole("button", { name: "Open navigation", exact: true })
      .click();
    await expect(page.locator(".sidebar")).toHaveClass(/\bopen\b/);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Back to conversation", exact: true }).click();
    await expect(page).toHaveURL(/\/agents$/);
  });

  test("a collapsed desktop sidebar does not cover the header", async ({ page }) => {
    await chatFixture(page);
    await page.goto(chat);
    await page.getByRole("button", { name: "Collapse navigation", exact: true }).click();
    const [float, avatar, header] = await Promise.all([
      page.locator(".sidebar-float").boundingBox(),
      page.locator(".assistant-header .assistant-avatar").boundingBox(),
      page.locator(".assistant-header").boundingBox(),
    ]);
    expect(avatar.x).toBeGreaterThanOrEqual(float.x + float.width);
    expect(header.y).toBe(0);
    expect(Math.round(header.height)).toBe(68);
  });

  for (const language of ["de", "en"])
    test(`320px phone keeps long header copy inside the bar (${language})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 320, height: 640 });
      await chatFixture(page, {
        language,
        assistants: [
          chatAssistant({
            name: "Chief of Staff with a long agent name",
            model: {
              connectionId: "router",
              modelId: "anthropic/claude-sonnet-4.5-long",
            },
          }),
        ],
        activity: {
          home: {
            state: "waiting",
            reason: "approval",
            label: "teamActive.awaiting",
            pendingApprovals: 1,
            team: "awaiting",
          },
        },
      });
      await page.goto(chat);
      const status = page.locator(".assistant-header-status");
      await expect(status).toContainText(
        language === "en" ? "Team awaiting approval" : "Team wartet auf Freigabe",
      );
      const [label, gear] = await Promise.all([
        status.boundingBox(),
        page.locator(".assistant-header-settings").boundingBox(),
      ]);
      expect(label.x + label.width).toBeLessThanOrEqual(gear.x + 1);
      expect(gear.x + gear.width).toBeLessThanOrEqual(320);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
    });
});

export { emit };
```

(The `emit` re-export keeps the import used until Task 3 adds streaming tests; remove
the last line in Task 3.)

- [ ] **Step 3: Run them to verify they fail**

Run: `npm run build && npx playwright test tests/browser/assistant-chat-layout.spec.js`
Expected: FAIL — `.assistant-header` not found.

- [ ] **Step 4: Rewrite `AssistantHeader.jsx`**

```jsx
import React from "react";
import Icon from "../../components/Icon.jsx";
import { assistantCopy as copy } from "../../lib/i18n/messages/assistants.js";
import { mobileHeaderCopy } from "../../lib/i18n/messages/app.js";
import useAssistants from "./useAssistants.js";
import { avatarGlyph } from "./avatar-glyph.js";
import { activityFor, headerStatus } from "./assistant-status.js";

// One bar for the agent chat and its settings (handoff 1d, 2e, 2f). Below 701px it
// replaces the app's mobile header, so it carries the navigation button itself.
export default function AssistantHeader({
  assistant,
  variant,
  navigate,
  onBack,
  openNavigation,
  navigationOpen = false,
  attempt,
  member,
}) {
  const { runtime, models, activity = {} } = useAssistants();
  const status = headerStatus({
    assistant,
    models,
    runtime,
    attempt,
    entry: activityFor(activity, assistant.id),
    member,
    copy,
  });
  const missing = status.tone === "missing";
  const settings = variant === "settings";
  const detail = member ? member.role : assistant.model.modelId;
  return (
    <>
      <header className={`assistant-header ${variant}`}>
        {openNavigation && (
          <button
            type="button"
            className="assistant-header-icon assistant-header-menu"
            aria-label={mobileHeaderCopy.iconButtonAriaLabel}
            aria-expanded={navigationOpen}
            onClick={openNavigation}
          >
            <Icon name="menu" />
          </button>
        )}
        {settings && (
          <button
            type="button"
            className="assistant-header-icon"
            aria-label={copy.backToChat}
            onClick={onBack}
          >
            <Icon name="back" />
          </button>
        )}
        <span className="assistant-avatar" aria-hidden="true">
          {avatarGlyph(assistant.name)}
        </span>
        <div className="assistant-header-title">
          <h1>{assistant.name}</h1>
          {settings && !missing ? (
            <p className="assistant-header-sub">{copy.settingsTab}</p>
          ) : (
            <p className={`assistant-header-status ${status.tone}`}>
              <span className="assistant-header-dot" aria-hidden="true" />
              <span className="assistant-header-label">{status.label}</span>
              {!settings && detail && (
                <span className="assistant-header-detail">· {detail}</span>
              )}
            </p>
          )}
        </div>
        {!settings && (
          <button
            type="button"
            className="assistant-header-settings"
            aria-label={copy.settings}
            onClick={() =>
              navigate({ view: "agents", assistantId: assistant.id, agentSettings: true })
            }
          >
            <Icon name="settings" />
            <span>{copy.settingsTab}</span>
          </button>
        )}
      </header>
      {missing && (
        <p role="status" className="assistant-notice">
          {copy.connectionMissingHint}
        </p>
      )}
    </>
  );
}
```

- [ ] **Step 5: Wire `AgentsPage.jsx`**

Line 11:

```jsx
export default function AgentsPage({ route, navigate, openNavigation, navigationOpen }) {
```

After `open(a)` (after line 47) add:

```jsx
// Without its connection the chat cannot open; the agent list is the way out.
function back(a) {
  if (connectionMissing(a, models)) navigate({ view: "agents" });
  else open(a);
}
```

In the `AssistantChat` element add `openNavigation={openNavigation}` and
`navigationOpen={navigationOpen}`.

Replace the settings branch header and wrap its content (lines 63-72 and the closing
`</div>` before `</section>` at 111-112):

```jsx
if (route.agentSettings && assistant)
  return (
    <section className="assistant-detail assistant-settings-page">
      <AssistantHeader
        assistant={assistant}
        variant="settings"
        navigate={navigate}
        onBack={() => back(assistant)}
        openNavigation={openNavigation}
        navigationOpen={navigationOpen}
      />
      <div className="assistant-settings-scroll">
        <ErrorMessage error={error || loadError} />
        <div className="assistant-settings-layout">
          {/* unchanged: settings main and runtime aside */}
        </div>
      </div>
    </section>
  );
```

(Move the existing `assistant-settings-main` div and `aside` unchanged into the inner
`assistant-settings-layout`; the only new element is `.assistant-settings-scroll`.)

- [ ] **Step 6: Wire `AssistantChat.jsx`**

Signature (lines 25-30):

```jsx
export default function AssistantChat({
  assistant,
  conversationId,
  focusTeamId,
  navigate,
  openNavigation,
  navigationOpen,
}) {
```

Replace the header element (lines 165-178) with:

```jsx
<AssistantHeader
  assistant={assistant}
  variant="conversation"
  navigate={navigate}
  openNavigation={openNavigation}
  navigationOpen={navigationOpen}
  attempt={active ? latest.attempt : null}
  member={member}
/>
```

- [ ] **Step 7: Wire `App.jsx` with focus return**

Add `useCallback` to the React import. After `restoreFocus = useRef(false);` add
`navOpener = useRef(null)` to the same `const` list, then after the `toggleSidebar`
declaration:

```jsx
// In-page menu buttons (agent chat, session chat) get the focus back on Escape.
const openNavigation = useCallback(() => {
  navOpener.current = document.activeElement;
  setMobileNav(true);
}, []);
```

Replace the Escape handler body (lines 58-60):

```jsx
const closeOnEscape = (event) => {
  if (event.key !== "Escape") return;
  setMobileNav(false);
  const opener = navOpener.current;
  navOpener.current = null;
  if (opener?.isConnected) queueMicrotask(() => opener.focus());
};
```

Pass it on:

```jsx
<AgentsPage
  route={route}
  navigate={navigate}
  openNavigation={openNavigation}
  navigationOpen={mobileNav}
/>
```

and `openNavigation={openNavigation}` on `SessionWorkspace` (replacing the inline arrow).
Part 2 does not modify `App.jsx`: its Menü popover stops Escape inside React
(`stopPropagation()` on the `nav`), so the event never reaches this window listener while
the popover is open. The anchors above therefore match the original file; the first
Escape closes the popover, the second reaches this handler.

- [ ] **Step 8: Header CSS**

In `web/features/assistants/assistants.css` delete these rule blocks (by selector; line
numbers moved in part 2): `.assistant-chat`, `.assistant-profile-header`,
`.assistant-chat-header`, `.assistant-chat-header h1`, `.assistant-chat-header > button`,
`.assistant-breadcrumb`, `.assistant-breadcrumb button`, `.assistant-profile-title`,
`.assistant-profile-title p`, `.assistant-title-line`,
`.assistant-profile-header .assistant-avatar`,
`.assistant-state-badge.ready, .assistant-state-badge.running`, `.assistant-view-tabs`,
`.assistant-view-tabs button`, `.assistant-view-tabs button[aria-current="page"]`, the
whole `@media (max-width: 700px) { .assistant-chat { height: calc(100dvh - 62px) } }`
block, and inside `@media (max-width: 650px)` the rules for `.assistant-chat`,
`.assistant-chat-header`, `.assistant-chat-header h1`, `.assistant-chat-header > button`,
`.assistant-profile-title`, `.assistant-profile-header .assistant-avatar`. Keep
`.assistant-state-badge` (the agent list card still uses `connectionMissing`).

Prepend to `web/features/assistants/assistant-chat.css` (above the existing rules):

```css
/* Agent chat (handoff 1d, 2a–2d, 2f): one header bar, flat transcript, one composer. */
.assistant-detail .sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
.assistant-detail.assistant-chat {
  display: flex;
  flex-direction: column;
  height: 100dvh;
  min-height: 0;
  padding: 0;
  gap: 0;
  overflow: hidden;
}
.assistant-header {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 12px;
  min-width: 0;
  height: 68px;
  padding: 0 28px;
  border-bottom: 1px solid var(--header-line);
}
.assistant-header .assistant-avatar {
  flex: 0 0 36px;
  width: 36px;
  height: 36px;
  border-radius: 10px;
  font-size: 15px;
}
.assistant-header-title {
  flex: 1;
  min-width: 0;
}
.assistant-header h1 {
  margin: 0;
  overflow: hidden;
  font-family: inherit;
  font-size: 17px;
  font-weight: 600;
  letter-spacing: 0;
  line-height: 1.3;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.assistant-header-status,
.assistant-header-sub {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 3px 0 0;
  overflow: hidden;
  color: var(--muted);
  font-size: 12px;
  white-space: nowrap;
}
.assistant-header-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-meta);
}
.assistant-header-label {
  flex: none;
}
.assistant-header-detail {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.assistant-header-status.ready .assistant-header-dot {
  background: var(--success);
}
.assistant-header-status.ready .assistant-header-label {
  color: var(--success-muted);
}
.assistant-header-status:is(.working, .waiting, .attention) .assistant-header-label {
  color: var(--accent-text);
}
.assistant-header-status.working .assistant-header-dot {
  background: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.assistant-header-status.waiting .assistant-header-dot {
  width: 8px;
  height: 8px;
  border: 2px solid var(--accent-text);
  background: transparent;
}
.assistant-header-status.attention .assistant-header-dot {
  border: 1px dashed var(--accent-text);
  background: transparent;
}
.assistant-header-status.missing .assistant-header-dot {
  display: none;
}
.assistant-header-status.missing .assistant-header-label {
  color: var(--accent);
}
.assistant-header-icon {
  display: grid;
  flex: none;
  place-items: center;
  width: 40px;
  height: 40px;
  border-radius: 8px;
  color: var(--text-menu);
}
.assistant-header-icon:hover {
  background: var(--button-secondary-bg);
  color: var(--accent-text);
}
.assistant-header-menu {
  display: none;
}
.assistant-header-settings {
  display: flex;
  flex: none;
  align-items: center;
  gap: 8px;
  height: 38px;
  padding: 0 14px;
  border: 1px solid var(--button-secondary-line);
  border-radius: 7px;
  background: var(--button-secondary-bg);
  color: var(--button-secondary-text);
  font-size: 12px;
  font-weight: 600;
}
.assistant-header-settings svg {
  width: 16px;
  height: 16px;
}
@media (min-width: 701px) {
  /* The floating expand/new-session buttons sit where the header starts. */
  .app.sidebar-collapsed main:has(.assistant-detail) {
    padding-top: 0;
  }
  .app.sidebar-collapsed .assistant-header {
    padding-left: 82px;
  }
}
@media (max-width: 700px) {
  .app:has(.assistant-detail) .mobile-header {
    display: none;
  }
  .assistant-header {
    gap: 8px;
    height: 56px;
    padding: 0 8px;
    background: var(--header-bg);
  }
  .assistant-header .assistant-avatar {
    flex-basis: 30px;
    width: 30px;
    height: 30px;
    border-radius: 9px;
    font-size: 13px;
  }
  .assistant-header h1 {
    font-size: 15px;
  }
  .assistant-header-status,
  .assistant-header-sub {
    margin-top: 2px;
    font-size: 11px;
  }
  .assistant-header-menu {
    display: grid;
  }
  .assistant-header-settings {
    justify-content: center;
    width: 40px;
    height: 40px;
    padding: 0;
    border: 0;
    background: none;
    color: var(--text-menu);
  }
  .assistant-header-settings svg {
    width: 18px;
    height: 18px;
  }
  .assistant-header-settings span {
    display: none;
  }
}
```

In the existing bottom block `@media (max-width: 700px), (any-pointer: coarse)` of
`assistant-chat.css`, change the selector `.assistant-chat` (`flex: 1; height: auto;`) to
`.assistant-detail.assistant-chat`. Otherwise the new `height: 100dvh` above outranks it
and the composer slips under the on-screen keyboard (iPad keyboard test in
`assistant-chat.spec.js`).

Append to `web/features/assistants/assistant-settings.css`:

```css
.assistant-detail.assistant-settings-page {
  padding: 0;
}
.assistant-settings-scroll {
  padding: 28px;
}
.assistant-settings-scroll > .assistant-settings-layout {
  margin-top: 0;
}
@media (max-width: 700px) {
  .assistant-settings-scroll {
    padding: 16px 12px;
  }
}
```

- [ ] **Step 9: Update the existing specs that used tabs, breadcrumb and the badge**

`tests/browser/assistants.spec.js`:

- Add `import { navigateTo } from "../helpers/navigation.js";`.
- Lines 79, 178, 183: `"Open chat"` → `"Back to conversation"`.
- Loop at 234-277: delete `const nav = …` and its `aria-current` assertions (237-240,
  249-251); replace the Settings click (247) with
  `await page.locator(".assistant-header").getByRole("button", { name: "Agent settings", exact: true }).click();`
  and the Conversation click (262) with
  `await page.getByRole("button", { name: "Back to conversation", exact: true }).click();`.
- Lines 303-311 (settings source):

```js
await page.getByRole("button", { name: "Back to conversation", exact: true }).click();
await requested;
await navigateTo(page, "Agents");
```

- Line 353: `.assistant-state-badge` → `.assistant-header-status`.

`tests/browser/assistant-teams.spec.js` lines 181 and 236: `"Open chat"` →
`"Back to conversation"`.

`tests/browser/assistant-chat.spec.js`: in `setup`, add to the `/api/assistants` body

```js
        activity: member
          ? {
              home: {
                state: "working",
                reason: "member",
                label: "team.states.running",
                pendingApprovals: 0,
                team: null,
              },
            }
          : {},
```

and in „header shows the member state while it works“ replace
`const badge = page.locator(".assistant-state-badge");` and
`await expect(badge).toHaveText("Working");` (originally lines 201-202) with

```js
const status = page.locator(".assistant-header-status");
await expect(status).toContainText("Working");
```

`tests/browser/assistant-settings.spec.js` lines 335-346: replace the badge test with

```js
test("settings header names the view instead of a status badge", async ({ page }) => {
  await setup(page);
  await page.goto(baseURL + "/agents/home/settings");
  await expect(page.locator(".assistant-header-sub")).toHaveText("Settings");
  await expect(page.locator(".assistant-header-status")).toHaveCount(0);
});
```

- [ ] **Step 10: Run the new and updated specs**

Run: `npm run build && npx playwright test tests/browser/assistant-chat-layout.spec.js tests/browser/assistants.spec.js tests/browser/assistant-teams.spec.js tests/browser/assistant-chat.spec.js tests/browser/assistant-settings.spec.js`
Expected: PASS. (The composer still has the old layout; Task 4 replaces it.)

- [ ] **Step 11: Commit**

```bash
npm run format && npm run lint && npm run check:structure
git add web tests
git commit -m "feat: replace the agent chat header, tabs and breadcrumb with one bar

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Flat transcript

**Files:**

- Modify: `web/features/assistants/AssistantMessage.jsx`
- Modify: `web/features/assistants/AssistantChat.jsx:206-209,249-261`
- Modify: `web/features/assistants/assistant-chat.css`, `assistants.css` (deletions)
- Test: `tests/browser/assistant-chat-layout.spec.js`

**Interfaces:**

- Consumes: `chatFixture`, `emit` (Task 2).
- Produces: `AssistantMessage({ role, name, text, streaming })`; transcript order
  `log → teams → own approvals` (Task 5 relies on cards being inside
  `.assistant-transcript`).

- [ ] **Step 1: Write the failing tests**

Remove the `export { emit };` line and append to
`tests/browser/assistant-chat-layout.spec.js`:

```js
const working = {
  messages: [{ id: "q", role: "user", text: "Plan my week" }],
  requests: [
    {
      id: "r",
      text: "Plan my week",
      state: "accepted",
      attempt: { id: "a1", state: "accepted" },
    },
  ],
  stale: false,
};

test.describe("agent chat transcript", () => {
  test("replies are flat and the user bubble hides its name visually", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await chatFixture(page);
    await page.goto(chat);
    const reply = page.locator(".assistant-message.assistant").first();
    await expect(reply).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(reply).toHaveCSS("border-top-width", "0px");
    await expect(reply).toHaveCSS("font-size", "15px");
    const user = page.locator(".assistant-message.user").first();
    await expect(user.locator("strong")).toHaveText("You");
    expect(
      await user.locator("strong").evaluate((e) => e.getBoundingClientRect().width),
    ).toBeLessThanOrEqual(1);
    await expect(user).toHaveCSS("border-bottom-right-radius", "4px");
    const [u, a] = [await user.boundingBox(), await reply.boundingBox()];
    expect(a.width).toBeGreaterThan(350);
    expect(u.x + u.width).toBeGreaterThan(370);
  });

  test("streaming shows a block cursor and an accent working note", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await chatFixture(page, { history: working });
    await page.goto(chat);
    await emit(page, {
      type: "delta",
      conversationId: "dinner",
      text: "Here is a draft",
    });
    const streaming = page.locator(".assistant-message.streaming");
    await expect(streaming).toContainText("Here is a draft");
    expect(
      await streaming
        .locator(".message-content > :last-child")
        .evaluate((e) => getComputedStyle(e, "::after").width),
    ).toBe("8px");
    const note = page.locator(".assistant-run-state.working");
    await expect(note).toContainText("Accepted");
    await expect(note).toHaveCSS("color", "rgb(255, 201, 157)");
    const gap = await page
      .locator(".assistant-transcript")
      .evaluate(
        (e) =>
          e.getBoundingClientRect().bottom -
          e.querySelector(".assistant-run-state").getBoundingClientRect().bottom,
      );
    expect(gap).toBeLessThan(40);
  });

  test("an optimistic request renders as a user bubble", async ({ page }) => {
    await chatFixture(page, {
      history: { ...working, messages: [] },
    });
    await page.goto(chat);
    const bubble = page
      .locator(".assistant-message.user")
      .filter({ hasText: "Plan my week" });
    await expect(bubble).toHaveCount(1);
    await expect(bubble.locator("strong")).toHaveClass(/sr-only/);
  });

  test("desktop centres the transcript at 760px", async ({ page }) => {
    await chatFixture(page);
    await page.goto(chat);
    const reply = await page
      .locator(".assistant-message.assistant")
      .first()
      .boundingBox();
    expect(Math.round(reply.width)).toBe(760);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm run build && npx playwright test tests/browser/assistant-chat-layout.spec.js -g "transcript"`
Expected: FAIL — reply has a background; `.assistant-message.streaming` missing.

- [ ] **Step 3: Update `AssistantMessage.jsx`**

```jsx
import React, { memo } from "react";
import ChatMarkdown from "../../components/ChatMarkdown.jsx";

// Memoized so a streamed delta re-parses only the streaming message, not the history.
// The owner's own name stays for screen readers only; the bubble already says who.
export default memo(function AssistantMessage({ role, name, text, streaming = false }) {
  return (
    <article className={`assistant-message ${role}${streaming ? " streaming" : ""}`}>
      <strong className={role === "user" ? "sr-only" : undefined}>{name}</strong>
      <div className="message-content">
        <ChatMarkdown>{text}</ChatMarkdown>
      </div>
    </article>
  );
});
```

- [ ] **Step 4: Update `AssistantChat.jsx` transcript**

Move the two children at lines 206-209 (`<Teams …/>` and the
`{!assistant.teamMemberId && <AssistantActionApprovals …/>}` line) from before the
`<div role="log" …>` to directly after its closing `</div>` (still inside
`.assistant-transcript`), so cards follow the newest messages as in 2c.

Replace the optimistic `<article className="assistant-message user">…</article>`
(lines 249-252) with:

```jsx
<AssistantMessage role="user" name={copy.you} text={latest.text} />
```

Replace the delta and status note (lines 254-261) with:

```jsx
{
  delta && (
    <AssistantMessage
      role="assistant"
      name={assistant.name}
      text={delta}
      streaming={Boolean(active)}
    />
  );
}
{
  latest?.attempt && (
    <p
      role="status"
      className={`assistant-note assistant-run-state${active && !uncertain ? " working" : ""}`}
    >
      {active && !uncertain && <span className="assistant-run-dot" aria-hidden="true" />}
      {copy.status[latest.attempt.state]}
    </p>
  );
}
```

- [ ] **Step 5: Transcript CSS**

In `assistants.css` delete: `.assistant-chat-panel`, `.assistant-transcript`,
`.assistant-message`, `.assistant-message strong`, `.assistant-message p`,
`.assistant-message.user`, `.assistant-message.user strong`, `.assistant-message pre`,
`.assistant-message img`, and inside `@media (max-width: 650px)` the
`.assistant-transcript` and `.assistant-message` rules.

In `assistant-chat.css` delete the two `.assistant-message .message-content > …`
rules and add (after the header rules, before the `@media (min-width: 701px)` block):

```css
.assistant-chat-panel {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}
.assistant-transcript {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 18px;
  min-height: 0;
  overflow-y: auto;
  padding: 28px max(28px, calc((100% - 760px) / 2));
}
/* Short conversations sit at the bottom, next to the composer. */
.assistant-transcript::before {
  content: "";
  margin-top: auto;
}
.assistant-transcript > [role="log"] {
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.assistant-message {
  max-width: 100%;
  margin: 0;
  color: var(--text-message);
  font-size: 15px;
  line-height: 1.7;
  overflow-wrap: anywhere;
}
.assistant-message > strong {
  display: block;
  margin-bottom: 6px;
  color: var(--muted);
  font-size: 12px;
}
.assistant-message .message-content > * {
  margin: 0 0 10px;
}
.assistant-message .message-content > :last-child {
  margin-bottom: 0;
}
.assistant-message .message-content strong {
  color: var(--text);
  font-weight: 600;
}
.assistant-message p {
  white-space: pre-wrap;
}
.assistant-message pre {
  overflow-x: auto;
}
.assistant-message img {
  max-width: 100%;
}
.assistant-message.user {
  width: fit-content;
  max-width: 75%;
  margin-left: auto;
  padding: 10px 16px;
  border: 1px solid var(--accent-line);
  border-radius: 14px 14px 4px 14px;
  background: var(--surface-accent);
  color: var(--text);
  font-size: 14px;
  line-height: 1.6;
}
.assistant-message.streaming .message-content > :last-child::after {
  content: "";
  display: inline-block;
  width: 8px;
  height: 16px;
  margin-left: 3px;
  border-radius: 1px;
  background: var(--accent);
  vertical-align: -2px;
  animation: assistant-cursor 1s steps(1) infinite;
}
@keyframes assistant-cursor {
  50% {
    opacity: 0;
  }
}
.assistant-transcript .assistant-run-state {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  color: var(--muted);
  font-size: 12px;
}
.assistant-transcript .assistant-run-state.working {
  color: var(--accent-text);
}
.assistant-run-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.assistant-transcript .assistant-event {
  margin: 0;
  padding: 0 12px;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.5;
  text-align: center;
}
@media (prefers-reduced-motion: reduce) {
  .assistant-message.streaming .message-content > :last-child::after {
    animation: none;
  }
}
```

and inside the existing `@media (max-width: 700px)` block of the header rules add:

```css
.assistant-transcript {
  gap: 16px;
  padding: 16px;
}
.assistant-message {
  line-height: 1.65;
}
.assistant-message.user {
  max-width: 85%;
  padding: 9px 14px;
}
```

- [ ] **Step 6: Run the specs**

Run: `npm run build && npx playwright test tests/browser/assistant-chat-layout.spec.js tests/browser/assistant-chat.spec.js tests/browser/assistants.spec.js tests/browser/assistant-teams.spec.js`
Expected: PASS (`assistants.spec.js` still asserts user x > agent x).

- [ ] **Step 7: Commit**

```bash
npm run format && npm run lint
git add web tests
git commit -m "feat: render agent replies flat with a streaming cursor

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Single composer with options popover

**Files:**

- Create: `web/features/assistants/AssistantComposer.jsx`,
  `web/features/assistants/ComposerOptions.jsx`
- Modify: `web/features/assistants/AssistantChat.jsx` (imports :15-17, form :300-357)
- Modify: `assistant-chat.css`, `assistants.css` (deletions)
- Modify tests: `tests/browser/assistant-chat.spec.js:154-157`,
  `tests/browser/assistant-teams.spec.js:200`
- Test: `tests/browser/assistant-chat-layout.spec.js`

**Interfaces:**

- Consumes: `Icon fill`, copy keys (Task 1); `useMobileLayout()`
  (`web/lib/useMobileLayout.js`).
- Produces: `AssistantComposer({ assistant, conversationId, drafts, text, setText,
teamAllowed, setTeamAllowed, canSend, busy, active, touchInput, onSubmit, onStop,
output, stick, scroll })`; `ComposerOptions({ id, open, teamAllowed, onTeamAllowed,
hint, trigger, onClose })`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/browser/assistant-chat-layout.spec.js`:

```js
test.describe("agent chat composer", () => {
  test("options hold the team switch and the hint; the chip shows the choice", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const state = await chatFixture(page);
    await page.goto(chat);
    const options = page.getByRole("button", { name: "Options", exact: true });
    await expect(options).toHaveAttribute("aria-expanded", "false");
    await options.click();
    const toggle = page.getByRole("switch", { name: "Allow a team for this message" });
    await expect(toggle).toBeFocused();
    await expect(page.locator(".assistant-options-hint")).toBeVisible();
    await toggle.check();
    await expect(
      page.getByRole("button", { name: "Close options", exact: true }),
    ).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Escape");
    await expect(page.locator(".assistant-options")).toBeHidden();
    await expect(options).toBeFocused();
    const chip = page.getByRole("button", { name: "Team allowed", exact: true });
    await expect(chip).toBeVisible();
    await options.click();
    await page.locator(".assistant-transcript").click({ position: { x: 20, y: 20 } });
    await expect(page.locator(".assistant-options")).toBeHidden();
    await page.getByLabel("Message", { exact: true }).fill("Review the project");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(() => state.posted[0]?.teamAllowed).toBe(true);
    await expect(chip).toHaveCount(0);
  });

  test("a working request swaps send for Stop and keeps the draft", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const state = await chatFixture(page, { history: working });
    await page.goto(chat);
    const stop = page.getByRole("button", { name: "Stop response", exact: true });
    await expect(stop).toHaveText("Stop");
    await expect(stop.locator("svg")).toHaveAttribute("fill", "currentColor");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toHaveCount(0);
    const input = page.getByLabel("Message", { exact: true });
    await input.fill("Next idea while it works");
    await stop.click();
    await expect.poll(() => state.calls).toContain("/api/assistant-attempts/a1/cancel");
    await expect(input).toHaveValue("Next idea while it works");
  });

  test("the message field grows up to six lines", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await chatFixture(page);
    await page.goto(chat);
    const input = page.getByLabel("Message", { exact: true });
    const lines = (n) => Array.from({ length: n }, (_, i) => `line ${i}`).join("\n");
    const one = (await input.boundingBox()).height;
    await input.fill(lines(3));
    expect((await input.boundingBox()).height).toBeGreaterThan(one + 30);
    await input.fill(lines(12));
    expect((await input.boundingBox()).height).toBeLessThanOrEqual(133);
  });

  test("desktop shows the hint inline and centres the composer", async ({ page }) => {
    await chatFixture(page);
    await page.goto(chat);
    await expect(page.locator(".assistant-composer-hint")).toHaveText(
      "Enter: send · Shift + Enter: new line",
    );
    const box = await page.locator(".assistant-composer-box").boundingBox();
    expect(Math.round(box.width)).toBe(760);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm run build && npx playwright test tests/browser/assistant-chat-layout.spec.js -g "composer"`
Expected: FAIL — no „Options“ button.

- [ ] **Step 3: Create `ComposerOptions.jsx`**

```jsx
import React, { useEffect, useRef } from "react";
import Icon from "../../components/Icon.jsx";
import { assistantCopy as copy } from "../../lib/i18n/messages/assistants.js";

// The one-message team permission and, on phones, the keyboard hint, behind the
// composer's "+" button (handoff 1d). Always mounted so aria-controls resolves.
export default function ComposerOptions({
  id,
  open,
  teamAllowed,
  onTeamAllowed,
  hint,
  trigger,
  onClose,
}) {
  const root = useRef(null);
  useEffect(() => {
    if (open) root.current?.querySelector("input")?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return undefined;
    const outside = (event) => {
      if (root.current?.contains(event.target) || trigger.current?.contains(event.target))
        return;
      onClose(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open, onClose, trigger]);
  return (
    <div
      id={id}
      ref={root}
      className="assistant-options"
      hidden={!open}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        // The app closes the mobile drawer on Escape; this layer closes first.
        event.stopPropagation();
        onClose(true);
      }}
    >
      <label className="assistant-options-row">
        <Icon name="users" />
        <span className="assistant-options-label">{copy.team.allowOnce}</span>
        <input
          type="checkbox"
          role="switch"
          checked={teamAllowed}
          aria-checked={teamAllowed}
          onChange={(event) => onTeamAllowed(event.target.checked)}
        />
        <span className="assistant-switch" aria-hidden="true" />
      </label>
      {hint && <p className="assistant-options-hint">{hint}</p>}
    </div>
  );
}
```

- [ ] **Step 4: Create `AssistantComposer.jsx`**

```jsx
import React, { useCallback, useLayoutEffect, useRef, useState } from "react";
import Icon from "../../components/Icon.jsx";
import ChatScrollToBottom from "../chat/ChatScrollToBottom.jsx";
import { enterKeyHint, sendHint, shouldSubmitOnEnter } from "../chat/enter-submit.js";
import useMobileLayout from "../../lib/useMobileLayout.js";
import { assistantCopy as copy } from "../../lib/i18n/messages/assistants.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import ComposerOptions from "./ComposerOptions.jsx";

const maxHeight = 6 * 22;
const optionsId = "assistant-composer-options";

// One rounded box (handoff 1d/2a/2d): the field grows to six lines; team permission
// and the keyboard hint sit behind "+" on phones; Stop replaces Send while working.
export default function AssistantComposer({
  assistant,
  conversationId,
  drafts,
  text,
  setText,
  teamAllowed,
  setTeamAllowed,
  canSend,
  busy,
  active,
  touchInput,
  onSubmit,
  onStop,
  output,
  stick,
  scroll,
}) {
  const mobile = useMobileLayout();
  const [optionsOpen, setOptionsOpen] = useState(false);
  const field = useRef(null),
    optionsButton = useRef(null);
  const member = Boolean(assistant.teamMemberId);
  const hint = sendHint(touchInput);
  useLayoutEffect(() => {
    const element = field.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, maxHeight)}px`;
  }, [text]);
  const closeOptions = useCallback((restoreFocus) => {
    setOptionsOpen(false);
    if (restoreFocus) optionsButton.current?.focus();
  }, []);
  const allowTeam = (value) => {
    setTeamAllowed(value);
    drafts.allowTeam(conversationId, value);
  };
  const submit = active ? (
    <button
      type="button"
      className="assistant-stop"
      aria-label={copy.stop}
      onClick={onStop}
    >
      <Icon name="stop" size={12} fill />
      {copy.stopShort}
    </button>
  ) : (
    <button
      className="assistant-send"
      aria-label={copy.send}
      aria-busy={busy || undefined}
      disabled={!canSend}
    >
      <Icon name="arrow" size={17} strokeWidth="2" />
    </button>
  );
  return (
    <form className={`assistant-composer${member ? " member" : ""}`} onSubmit={onSubmit}>
      <ChatScrollToBottom active output={output} stick={stick} scroll={scroll} />
      {!member && (
        <ComposerOptions
          id={optionsId}
          open={optionsOpen}
          teamAllowed={teamAllowed}
          onTeamAllowed={allowTeam}
          hint={mobile ? hint : ""}
          trigger={optionsButton}
          onClose={closeOptions}
        />
      )}
      <div className="assistant-composer-box">
        <label className="sr-only" htmlFor="assistant-message">
          {copy.message}
        </label>
        <textarea
          ref={field}
          id="assistant-message"
          value={text}
          maxLength={65536}
          rows={1}
          enterKeyHint={enterKeyHint(touchInput)}
          placeholder={
            member
              ? commonCopy.messagePlaceholder(assistant.name)
              : copy.messagePlaceholder
          }
          onKeyDown={(event) => {
            if (!shouldSubmitOnEnter(event, touchInput)) return;
            event.preventDefault();
            if (!event.repeat) event.currentTarget.form.requestSubmit();
          }}
          onChange={(event) => {
            setText(event.target.value);
            drafts.set(conversationId, event.target.value);
          }}
        />
        {member ? (
          submit
        ) : (
          <div className="assistant-composer-row">
            <button
              ref={optionsButton}
              type="button"
              className={`assistant-options-toggle${optionsOpen ? " open" : ""}`}
              aria-label={optionsOpen ? copy.optionsClose : copy.options}
              aria-expanded={optionsOpen}
              aria-controls={optionsId}
              onClick={() => setOptionsOpen((open) => !open)}
              onKeyDown={(event) => {
                if (event.key !== "Escape" || !optionsOpen) return;
                event.stopPropagation();
                setOptionsOpen(false);
              }}
            >
              <Icon name={optionsOpen ? "close" : "plus"} size={optionsOpen ? 15 : 16} />
            </button>
            {teamAllowed && (
              <button
                type="button"
                className="assistant-team-chip"
                onClick={() => allowTeam(false)}
              >
                <Icon name="users" size={13} />
                {copy.team.allowedChip}
              </button>
            )}
            {!mobile && <span className="assistant-composer-hint">{hint}</span>}
            {submit}
          </div>
        )}
      </div>
    </form>
  );
}
```

- [ ] **Step 5: Use it in `AssistantChat.jsx`**

Remove the imports of `enterKeyHint, sendHint, shouldSubmitOnEnter` and
`ChatScrollToBottom` and add `import AssistantComposer from "./AssistantComposer.jsx";`.
Add before `return (`:

```jsx
async function stop() {
  try {
    await assistantApi.cancel(latest.attempt.id);
    await refresh();
  } catch (e) {
    setError(e.message);
  }
}
```

Replace the whole `<form className="assistant-composer" …>…</form>` (lines 300-357) with:

```jsx
<AssistantComposer
  assistant={assistant}
  conversationId={conversationId}
  drafts={drafts}
  text={text}
  setText={setText}
  teamAllowed={teamAllowed}
  setTeamAllowed={setTeamAllowed}
  canSend={canSend}
  busy={busy}
  active={Boolean(active)}
  touchInput={touchInput}
  onSubmit={send}
  onStop={stop}
  output={output}
  stick={stick}
  scroll={scroll}
/>
```

- [ ] **Step 6: Composer CSS**

In `assistants.css` delete `.assistant-composer`, `.assistant-composer > label`,
`.assistant-composer textarea`, `.assistant-composer .assistant-actions` and the three
composer rules inside `@media (max-width: 650px)`. In `assistant-chat.css` delete the
old `.assistant-composer`, `.assistant-composer textarea`,
`.assistant-composer .assistant-actions` and `.assistant-actions .chat-send-hint`
rules, and in the bottom `@media (max-width: 700px), (any-pointer: coarse)` block the
`.assistant-composer textarea` rule. Add:

```css
.assistant-composer {
  position: relative;
  display: flex;
  flex-shrink: 0;
  justify-content: center;
  padding: 0 28px 24px;
}
.assistant-composer-box {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 100%;
  max-width: 760px;
  padding: 12px 10px 10px 16px;
  border: 1px solid var(--line);
  border-radius: 16px;
  background: var(--panel);
}
.assistant-composer-box:focus-within {
  border-color: var(--accent-focus);
}
.assistant-composer textarea {
  width: 100%;
  min-height: 22px;
  max-height: 132px;
  padding: 0;
  border: 0;
  outline: none;
  background: none;
  color: var(--text);
  font: inherit;
  font-size: 15px;
  line-height: 22px;
  resize: none;
}
.assistant-composer textarea::placeholder {
  color: var(--placeholder);
}
.assistant-composer-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-left: -6px;
}
.assistant-options-toggle {
  display: grid;
  flex: none;
  place-items: center;
  width: 32px;
  height: 32px;
  border: 1px solid var(--button-secondary-line);
  border-radius: 50%;
  color: var(--text-menu);
}
.assistant-options-toggle.open {
  border-color: var(--accent-line);
  background: var(--surface-accent);
  color: var(--accent-text);
}
.assistant-team-chip {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px;
  border: 1px solid var(--accent-line);
  border-radius: 999px;
  background: var(--surface-accent);
  color: var(--accent-text);
  font-size: 12px;
}
.assistant-composer-hint {
  min-width: 0;
  margin-left: auto;
  overflow: hidden;
  color: var(--hint);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.assistant-send,
.assistant-stop {
  flex: none;
  margin-left: auto;
}
.assistant-composer-hint + :is(.assistant-send, .assistant-stop) {
  margin-left: 0;
}
.assistant-send {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: var(--accent);
  color: var(--on-accent);
}
.assistant-send svg {
  transform: rotate(-90deg);
}
.assistant-send:disabled {
  cursor: default;
  opacity: 0.42;
}
.assistant-stop {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 36px;
  padding: 0 14px 0 12px;
  border: 1px solid var(--button-secondary-line);
  border-radius: 18px;
  background: var(--button-secondary-bg);
  color: var(--text);
  font-size: 13px;
  font-weight: 600;
}
.assistant-composer.member .assistant-composer-box {
  flex-direction: row;
  align-items: center;
  gap: 8px;
  padding: 10px 8px 8px 14px;
}
.assistant-options {
  position: absolute;
  right: max(28px, calc((100% - 760px) / 2));
  bottom: calc(100% + 8px);
  left: max(28px, calc((100% - 760px) / 2));
  z-index: 3;
  padding: 6px;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: var(--popover-raised);
  box-shadow: var(--popover-shadow);
}
.assistant-options-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 52px;
  padding: 0 12px;
  border-radius: 10px;
  color: var(--text);
  font-size: 14px;
  cursor: pointer;
}
.assistant-options-row > svg {
  flex: none;
  color: var(--text-menu);
}
.assistant-options-label {
  flex: 1;
}
/* The real checkbox covers the whole row so any tap toggles it. */
.assistant-options-row input {
  position: absolute;
  inset: 0;
  z-index: 1;
  width: 100%;
  height: 100%;
  margin: 0;
  opacity: 0;
  cursor: pointer;
}
.assistant-switch {
  position: relative;
  flex: none;
  width: 40px;
  height: 24px;
  border-radius: 12px;
  background: var(--switch-off);
  transition: background 0.15s;
}
.assistant-switch::after {
  content: "";
  position: absolute;
  top: 3px;
  left: 3px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--switch-knob);
  transition: left 0.15s;
}
.assistant-options-row input:checked + .assistant-switch {
  background: var(--accent);
}
.assistant-options-row input:checked + .assistant-switch::after {
  left: 19px;
}
.assistant-options-row input:focus-visible + .assistant-switch {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.assistant-options-hint {
  margin: 0;
  padding: 4px 12px 8px 42px;
  color: var(--hint);
  font-size: 11px;
  line-height: 1.5;
}
@media (prefers-reduced-motion: reduce) {
  .assistant-switch,
  .assistant-switch::after {
    transition: none;
  }
}
```

and inside the `@media (max-width: 700px)` block add:

```css
.assistant-composer {
  padding: 6px 10px calc(12px + env(safe-area-inset-bottom));
}
.assistant-composer-box {
  gap: 8px;
  padding: 10px 8px 8px 14px;
}
.assistant-composer textarea {
  font-size: 16px;
}
.assistant-composer-row {
  gap: 8px;
}
.assistant-options {
  right: 10px;
  bottom: calc(100% + 2px);
  left: 10px;
}
```

- [ ] **Step 7: Update the two existing specs**

`tests/browser/assistant-chat.spec.js` in the `touch` branch, directly before
`await expect(page.getByText("Use the button to send")).toBeVisible();` (originally
line 157; Task 2 shifted it):

```js
if (size.width <= 700)
  await page.getByRole("button", { name: "Options", exact: true }).click();
```

`tests/browser/assistant-teams.spec.js` line 200 becomes:

```js
await page.getByRole("button", { name: "Options", exact: true }).click();
await page.getByLabel("Allow a team for this message").check();
```

- [ ] **Step 8: Run the specs**

Run: `npm run build && npx playwright test tests/browser/assistant-chat-layout.spec.js tests/browser/assistant-chat.spec.js tests/browser/assistant-teams.spec.js tests/browser/assistants.spec.js tests/browser/assistant-workflows.spec.js`
Expected: PASS, including „Jump to latest“ and the iPad keyboard test.

- [ ] **Step 9: Commit**

```bash
npm run format && npm run lint && npm run check:structure
git add web tests
git commit -m "feat: move the agent composer options behind a plus button

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Approval strip and action cards

**Files:**

- Create: `web/features/assistants/transcript-scroll.js`,
  `web/features/assistants/useAssistantActions.js`,
  `web/features/assistants/AssistantApprovalStrip.jsx`,
  `web/features/assistants/assistant-teams.css`
- Rewrite: `web/features/assistants/AssistantActionApprovals.jsx`
- Modify: `AssistantChat.jsx`, `AssistantTeams.jsx:13-20,56-67`, `AssistantsRoot.jsx:3`
- Test: `tests/unit/assistant-transcript-scroll.test.js`,
  `tests/browser/assistant-chat-teams.spec.js`

**Interfaces:**

- Consumes: `activityFor` (part 1), `chatFixture` (Task 2).
- Produces: `scrollToChild(container, element, offset = 12): boolean`;
  `useAssistantActions(assistantId, enabled = true) → { actions, error, decide, reload }`;
  `AssistantActionApprovals({ actions, error, decide })`;
  `AssistantApprovalStrip({ count, output })`; `[data-pending]` on pending cards;
  `.assistant-approval-card`, `.assistant-approval-head`, `.assistant-card-actions`
  classes reused by Task 7.

- [ ] **Step 1: Write the failing unit test**

`tests/unit/assistant-transcript-scroll.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { scrollToChild } from "../../web/features/assistants/transcript-scroll.js";

const at = (top) => ({ getBoundingClientRect: () => ({ top }) });
test("scrolls the transcript so the child sits just below its top edge", () => {
  const container = { scrollTop: 100, ...at(50) };
  assert.equal(scrollToChild(container, at(450)), true);
  assert.equal(container.scrollTop, 488);
});
test("never scrolls above the start and ignores missing nodes", () => {
  const container = { scrollTop: 0, ...at(50) };
  scrollToChild(container, at(40));
  assert.equal(container.scrollTop, 0);
  assert.equal(scrollToChild(null, at(1)), false);
  assert.equal(scrollToChild(container, null), false);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/unit/assistant-transcript-scroll.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `transcript-scroll.js`**

```js
// Scrolls a transcript to one of its descendants with scrollTop only. scrollIntoView
// would also scroll the fixed page on iOS while the keyboard is open.
export function scrollToChild(container, element, offset = 12) {
  if (!container || !element) return false;
  const top =
    element.getBoundingClientRect().top -
    container.getBoundingClientRect().top +
    container.scrollTop -
    offset;
  container.scrollTop = Math.max(0, top);
  return true;
}
```

Run: `node --test tests/unit/assistant-transcript-scroll.test.js` — Expected: PASS.

- [ ] **Step 4: Write the failing browser tests**

`tests/browser/assistant-chat-teams.spec.js`:

```js
import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { chatAssistant, chatFixture } from "../helpers/assistant-chat-fixture.js";

const chat = baseURL + "/agents/home/chats/dinner";
const long = {
  messages: Array.from({ length: 30 }, (_, n) => ({
    id: `m${n}`,
    role: n % 2 ? "user" : "assistant",
    text: `Message ${n} with enough words to wrap across a couple of lines on a phone.`,
  })),
  requests: [],
  stale: false,
};
const action = (id) => ({
  id,
  revision: 1,
  state: "awaiting_approval",
  projectName: "Website",
  pipelineName: "Build",
  payload: {
    action: "coding_start",
    title: `Fix ${id}`,
    task: "Repair the contact form",
  },
});
const waiting = (pendingApprovals) => ({
  home: {
    state: "waiting",
    reason: "approval",
    label: "teamActive.awaiting",
    pendingApprovals,
    team: null,
  },
});

test.describe("approval strip", () => {
  test("counts server approvals and jumps to the first pending card", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await chatFixture(page, {
      history: long,
      activity: waiting(2),
      actions: [action("own-1"), action("own-2")],
    });
    await page.goto(chat);
    const strip = page.getByRole("button", { name: /Waiting for your approval · 2/ });
    await expect(strip).toBeEnabled();
    await expect(strip).toHaveCSS("height", "40px");
    const card = page.locator(".assistant-approval-card").first();
    await expect(card).toHaveCSS("border-top-color", "rgba(244, 154, 88, 0.2)");
    await page.locator(".assistant-transcript").evaluate((e) => (e.scrollTop = 0));
    await expect(card).not.toBeInViewport();
    await strip.click();
    await expect(card).toBeInViewport();
    expect(await page.evaluate(() => document.scrollingElement.scrollTop)).toBe(0);
    await expect(
      page
        .getByRole("region", { name: "Waiting for your approval" })
        .getByRole("button", { name: "Approve action", exact: true })
        .first(),
    ).toBeVisible();
  });

  test("is absent without approvals and in member chats", async ({ page }) => {
    await chatFixture(page, {
      assistants: [
        chatAssistant(),
        chatAssistant({
          id: "member-0",
          name: "Research lead",
          teamMemberId: "member-0",
        }),
      ],
      conversations: [
        { id: "dinner", assistantId: "home" },
        { id: "member-chat", assistantId: "member-0" },
      ],
      activity: { "member-0": waiting(1).home },
    });
    await page.goto(chat);
    await expect(page.locator(".assistant-approval-strip")).toHaveCount(0);
    await page.goto(baseURL + "/agents/member-0/chats/member-chat");
    await expect(page.locator(".assistant-header")).toBeVisible();
    await expect(page.locator(".assistant-approval-strip")).toHaveCount(0);
  });
});
```

Run: `npm run build && npx playwright test tests/browser/assistant-chat-teams.spec.js`
Expected: FAIL — no strip button.

- [ ] **Step 5: Create `useAssistantActions.js`**

```js
import { useCallback, useEffect, useState } from "react";
import api from "../../lib/api.js";
import usePolling from "./usePolling.js";
import { useAssistantEvent } from "./useAssistants.js";

// The agent's own coding tasks and memory changes waiting for the owner. Loaded on
// change events and polled while one waits, because approvals expire. Team members'
// requests belong to their team card (useTeamCodingRequests).
export default function useAssistantActions(assistantId, enabled = true) {
  const [actions, setActions] = useState([]),
    [error, setError] = useState("");
  const lastEvent = useAssistantEvent();
  const load = useCallback(
    async (signal) => {
      try {
        const r = await api(`/assistants/${encodeURIComponent(assistantId)}/actions`);
        if (!signal?.aborted)
          setActions(
            (r.actions || []).filter((a) => a.state === "awaiting_approval" && !a.teamId),
          );
      } catch {
        // Settings report load failures; the chat keeps the last list.
      }
    },
    [assistantId],
  );
  useEffect(() => {
    if (enabled && (!lastEvent || ["change", "connected"].includes(lastEvent.type)))
      load();
  }, [enabled, lastEvent, load]);
  usePolling(load, 5000, {
    enabled: enabled && actions.length > 0,
    immediate: false,
    restartKey: load,
  });
  const decide = useCallback(
    async (a, decision) => {
      setError("");
      try {
        await api(`/assistant-actions/${encodeURIComponent(a.id)}/decision`, "POST", {
          revision: a.revision,
          decision,
        });
        await load();
      } catch (e) {
        setError(e.message);
      }
    },
    [load],
  );
  return { actions, error, decide, reload: load };
}
```

- [ ] **Step 6: Rewrite `AssistantActionApprovals.jsx`**

```jsx
import React, { useState } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { assistantWorkflowCopy as copy } from "../../lib/i18n/messages/assistant-workflows.js";

// The agent's own pending actions as cards in the transcript (handoff 2c). The chat
// loads them once (useAssistantActions) and also counts them in the approval strip.
export default function AssistantActionApprovals({ actions, error, decide }) {
  const [busy, setBusy] = useState(false);
  async function choose(a, decision) {
    setBusy(true);
    try {
      await decide(a, decision);
    } finally {
      setBusy(false);
    }
  }
  if (!actions.length && !error) return null;
  return (
    <section className="assistant-action-approvals" aria-label={copy.pendingApprovals}>
      <h3 className="sr-only">{copy.pendingApprovals}</h3>
      <ErrorMessage error={error} />
      {actions.map((a) => (
        <article className="assistant-approval-card" data-pending="" key={a.id}>
          <div className="assistant-approval-head">
            <strong>
              {a.payload.action === "coding_start" ? copy.coding : copy.memory}
            </strong>
            <small>{copy.states.awaiting_approval}</small>
          </div>
          {(a.projectName || a.pipelineName) && (
            <p>
              {a.projectName}
              {a.pipelineName ? ` · ${a.pipelineName}` : ""}
            </p>
          )}
          {a.payload.title && (
            <strong className="assistant-approval-title">{a.payload.title}</strong>
          )}
          <p className="assistant-approval-task">{a.payload.task || a.payload.content}</p>
          {a.payload.baseBranch && (
            <p>
              {copy.branch}: {a.payload.baseBranch}
            </p>
          )}
          <div className="assistant-card-actions">
            {["approve", "decline"].map((decision) => (
              <button
                key={decision}
                type="button"
                disabled={busy}
                className={`button ${decision === "approve" ? "primary" : "secondary"}`}
                onClick={() => choose(a, decision)}
              >
                {copy[decision]}
              </button>
            ))}
          </div>
        </article>
      ))}
    </section>
  );
}
```

- [ ] **Step 7: Create `AssistantApprovalStrip.jsx`**

```jsx
import React, { useLayoutEffect, useState } from "react";
import Icon from "../../components/Icon.jsx";
import { assistantCopy as copy } from "../../lib/i18n/messages/assistants.js";
import { assistantWorkflowCopy } from "../../lib/i18n/messages/assistant-workflows.js";
import { scrollToChild } from "./transcript-scroll.js";

// Under the header while anything waits for the owner (handoff 2c). The count comes
// from the server's activity; the jump target is the first pending card rendered.
export default function AssistantApprovalStrip({ count, output }) {
  const [target, setTarget] = useState(false);
  useLayoutEffect(() => {
    const element = output.current;
    if (!element) return undefined;
    const update = () => setTarget(Boolean(element.querySelector("[data-pending]")));
    update();
    const changes = new MutationObserver(update);
    changes.observe(element, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-pending"],
    });
    return () => changes.disconnect();
  }, [output]);
  if (!count) return null;
  return (
    <button
      type="button"
      className="assistant-approval-strip"
      disabled={!target}
      onClick={() => {
        const element = output.current;
        scrollToChild(element, element?.querySelector("[data-pending]"));
      }}
    >
      <span className="assistant-approval-ring" aria-hidden="true" />
      <span className="assistant-approval-label">
        {assistantWorkflowCopy.pendingApprovals} · {count}
      </span>
      <span className="assistant-approval-show">
        {copy.showApprovals}
        <Icon name="chevron" size={14} />
      </span>
    </button>
  );
}
```

- [ ] **Step 8: Wire `AssistantChat.jsx` and `AssistantTeams.jsx`**

`AssistantChat.jsx` imports:

```jsx
import AssistantApprovalStrip from "./AssistantApprovalStrip.jsx";
import useAssistantActions from "./useAssistantActions.js";
import { activityFor } from "./assistant-status.js";
```

Destructure `activity = {}` from `useAssistants()`. After `const uncertain = …` add:

```jsx
const ownActions = useAssistantActions(assistant.id, !assistant.teamMemberId);
const entry = activityFor(activity, assistant.id);
```

Directly after `<AssistantHeader … />` add:

```jsx
{
  !assistant.teamMemberId && (
    <AssistantApprovalStrip count={entry.pendingApprovals} output={output} />
  );
}
```

Replace `<AssistantActionApprovals assistantId={assistant.id} />` with
`<AssistantActionApprovals {...ownActions} />` (still guarded by
`!assistant.teamMemberId`).

`AssistantTeams.jsx`: import `{ scrollToChild } from "./transcript-scroll.js"`, replace
the deep-link effect (lines 15-20) with:

```jsx
useEffect(() => {
  if (!focused) return;
  const card = document.getElementById(`assistant-team-${focusTeamId}`);
  scrollToChild(card?.closest(".assistant-transcript"), card);
}, [focusTeamId, focused]);
```

and add to the `<details>` element:

```jsx
            data-pending={
              team.phase === "awaiting_approval" ||
              coding.actions.some(
                (a) => a.teamId === team.id && a.state === "awaiting_approval",
              )
                ? ""
                : undefined
            }
```

`AssistantsRoot.jsx`: add `import "./assistant-teams.css";` after the chat CSS import.

- [ ] **Step 9: Strip and card CSS**

Create `web/features/assistants/assistant-teams.css`:

```css
/* Approval strip, approval cards, team cards and the member context (handoff 2c, 2d). */
.assistant-approval-strip {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 10px;
  width: 100%;
  height: 40px;
  padding: 0 28px;
  border-bottom: 1px solid var(--approval-line);
  background: var(--approval-bg);
  color: var(--accent-text);
  font-size: 13px;
  text-align: left;
}
.assistant-approval-strip:disabled {
  cursor: default;
}
.assistant-approval-ring {
  flex: none;
  width: 8px;
  height: 8px;
  border: 2px solid var(--accent-text);
  border-radius: 50%;
}
.assistant-approval-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.assistant-approval-show {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
}
.assistant-action-approvals,
.assistant-team-coding {
  display: grid;
  gap: 14px;
}
.assistant-approval-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px;
  border: 1px solid var(--accent-line);
  border-radius: 14px;
  background: var(--panel);
}
.assistant-approval-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.assistant-approval-head strong {
  flex: 1;
  font-size: 14px;
  font-weight: 600;
}
.assistant-approval-head small {
  color: var(--accent-text);
  font-size: 12px;
}
.assistant-approval-card p {
  margin: 0;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.assistant-approval-card .assistant-approval-title,
.assistant-approval-card .assistant-approval-task {
  color: var(--text-row);
  font-size: 13px;
}
.assistant-card-actions {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}
.assistant-card-actions .button {
  flex: 1;
  height: 40px;
  font-weight: 600;
}
@media (max-width: 700px) {
  .assistant-approval-strip {
    padding: 0 16px;
  }
}
```

- [ ] **Step 10: Run the tests**

Run: `node --test tests/unit/assistant-transcript-scroll.test.js && npm run build && npx playwright test tests/browser/assistant-chat-teams.spec.js tests/browser/assistant-workflows.spec.js tests/browser/assistant-team-coding.spec.js tests/browser/assistant-teams.spec.js`
Expected: PASS (the Telegram deep-link test still sees the team card open).

- [ ] **Step 11: Commit**

```bash
npm run format && npm run lint && npm run check:structure
git add web tests
git commit -m "feat: show pending agent approvals in a strip with jump to the card

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Member chat context strip

**Files:**

- Create: `web/features/assistants/AssistantMemberContext.jsx`
- Modify: `AssistantChat.jsx` (after the strip), `AssistantTeams.jsx:39-47`,
  `assistants.css` (deletions), `assistant-teams.css`
- Test: `tests/browser/assistant-chat-teams.spec.js`

**Interfaces:**

- Consumes: `useAssistants()` (`teams`, `assistants`, `refresh`),
  `assistantApi.teamAction`, `AssistantComposer` member variant (Task 4).
- Produces: `AssistantMemberContext({ member, navigate })`; `.assistant-member-summary`
  no longer exists.

- [ ] **Step 1: Write the failing tests**

Append to `tests/browser/assistant-chat-teams.spec.js`:

```js
const memberRecord = (overrides = {}) => ({
  id: "member-0",
  kind: "member",
  teamId: "team",
  parentAssistantId: "home",
  assistantId: "member-0",
  name: "Research lead",
  role: "Research",
  assignment: "Compare the three biggest vendors",
  lifetime: "task",
  phase: "running",
  conversationId: "member-chat",
  ...overrides,
});
const runningTeam = (overrides = {}) => ({
  id: "team",
  revision: 1,
  parentAssistantId: "home",
  parentConversationId: "dinner",
  objective: "Prepare the website relaunch",
  phase: "running",
  members: [],
  memberIds: ["member-0"],
  ...overrides,
});
const memberSetup = (overrides = {}) => ({
  assistants: [
    chatAssistant(),
    chatAssistant({
      id: "member-0",
      name: "Research lead",
      teamMemberId: "member-0",
      teamId: "team",
      parentAssistantId: "home",
      lifetime: "task",
    }),
  ],
  conversations: [
    { id: "dinner", assistantId: "home" },
    { id: "member-chat", assistantId: "member-0" },
  ],
  members: [memberRecord()],
  teams: [runningTeam()],
  activity: {
    "member-0": {
      state: "working",
      reason: "member",
      label: "team.states.running",
      pendingApprovals: 0,
      team: null,
    },
  },
  ...overrides,
});

test.describe("member chat", () => {
  test("context strip links back, stops the member and the composer is one row", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const state = await chatFixture(page, memberSetup());
    await page.goto(baseURL + "/agents/member-0/chats/member-chat");
    const strip = page.locator(".assistant-member-context");
    await expect(strip).toContainText("Home assistant · Prepare the website relaunch");
    await expect(strip).toContainText("Compare the three biggest vendors");
    const status = page.locator(".assistant-header-status");
    await expect(status).toContainText("Working");
    await expect(status).toContainText("· Research");
    await expect(page.getByRole("button", { name: "Options", exact: true })).toHaveCount(
      0,
    );
    await expect(page.getByLabel("Message", { exact: true })).toHaveAttribute(
      "placeholder",
      "Message Research lead …",
    );
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
    await strip.getByRole("button", { name: "Stop member", exact: true }).click();
    await expect
      .poll(() => state.calls)
      .toContain("/api/assistant-team-members/member-0/stop");
    await strip.getByRole("button", { name: /Home assistant · Prepare/ }).click();
    await expect(page).toHaveURL(/\/agents\/home\/teams\/team$/);
  });

  test("permanent or orphaned members show only role and assignment", async ({
    page,
  }) => {
    await chatFixture(
      page,
      memberSetup({
        members: [memberRecord({ lifetime: "permanent", phase: "completed" })],
      }),
    );
    await page.goto(baseURL + "/agents/member-0/chats/member-chat");
    const strip = page.locator(".assistant-member-context");
    await expect(strip).toContainText("Research");
    await expect(strip.getByRole("button")).toHaveCount(0);
  });
});
```

Run: `npm run build && npx playwright test tests/browser/assistant-chat-teams.spec.js -g "member chat"`
Expected: FAIL — `.assistant-member-context` not found.

- [ ] **Step 2: Create `AssistantMemberContext.jsx`**

```jsx
import React, { useState } from "react";
import Icon from "../../components/Icon.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { assistantCopy as copy } from "../../lib/i18n/messages/assistants.js";
import useAssistants from "./useAssistants.js";
import { assistantApi } from "./assistant-api.js";

const terminal = ["completed", "failed", "cancelled"];

// Where a team member's chat comes from (handoff 2d): back to the parent's team, the
// assignment, and a stop while the member works. Replaces the old summary card.
export default function AssistantMemberContext({ member, navigate }) {
  const { teams = [], assistants = [], refresh } = useAssistants();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const team = teams.find((t) => t.id === member.teamId);
  const parent = assistants.find((a) => a.id === member.parentAssistantId);
  const linked =
    team?.parentConversationId &&
    parent &&
    !team.archivedAt &&
    !parent.archivedAt &&
    member.lifetime !== "permanent";
  async function stop() {
    setBusy(true);
    setError("");
    try {
      await assistantApi.teamAction("team-members", member.id, "stop");
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const assignment = (
    <span className="assistant-member-assignment">{member.assignment}</span>
  );
  return (
    <>
      <div className="assistant-member-context">
        {linked ? (
          <button
            type="button"
            className="assistant-member-back"
            onClick={() =>
              navigate({ view: "agents", assistantId: parent.id, teamId: team.id })
            }
          >
            <span className="assistant-member-origin">
              <Icon name="back" size={14} />
              <span>
                {parent.name} · {team.objective}
              </span>
            </span>
            {assignment}
          </button>
        ) : (
          <div className="assistant-member-back">
            <span className="assistant-member-origin">
              <span>{member.role}</span>
            </span>
            {assignment}
          </div>
        )}
        {!terminal.includes(member.phase) && (
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={stop}
          >
            {copy.team.stopMember}
          </button>
        )}
      </div>
      <ErrorMessage error={error} />
    </>
  );
}
```

- [ ] **Step 3: Wire it**

`AssistantChat.jsx`: import it and render after the approval strip:

```jsx
{
  member && <AssistantMemberContext member={member} navigate={navigate} />;
}
```

`AssistantTeams.jsx`: replace the member summary return (lines 39-47) with:

```jsx
// A member's chat shows its team context above the transcript instead.
if (member) return null;
```

In `assistants.css` delete `.assistant-member-summary p` and remove
`.assistant-member-summary` from the `.assistant-team-card, .assistant-member-summary`
selector list (Task 7 deletes the rest).

Append to `assistant-teams.css`:

```css
.assistant-member-context {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 10px;
  padding: 10px 28px;
  border-bottom: 1px solid var(--header-line);
  background: var(--sidebar-bg);
}
.assistant-member-back {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
  text-align: left;
}
.assistant-member-origin {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  color: var(--accent-text);
  font-size: 12px;
}
.assistant-member-origin > svg {
  flex: none;
}
.assistant-member-origin > span,
.assistant-member-assignment {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.assistant-member-assignment {
  color: var(--text-row);
  font-size: 13px;
}
.assistant-member-context .button {
  flex: none;
  height: 32px;
  padding: 0 12px;
  font-weight: 600;
}
@media (max-width: 700px) {
  .assistant-member-context {
    padding: 10px 12px 10px 14px;
  }
}
```

- [ ] **Step 4: Run the specs**

Run: `npm run build && npx playwright test tests/browser/assistant-chat-teams.spec.js tests/browser/assistant-teams.spec.js tests/browser/assistant-chat.spec.js`
Expected: PASS („Review topic 1“ in `assistant-teams.spec.js:174` is now the strip's
assignment line).

- [ ] **Step 5: Commit**

```bash
npm run format && npm run lint
git add web tests
git commit -m "feat: show a team member's origin and stop control above its chat

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Team cards with whole-row members

**Files:**

- Rewrite: `web/features/assistants/AssistantTeams.jsx`
- Modify: `web/features/assistants/TeamCodingRequests.jsx`
- Modify: `assistants.css` (deletions), `assistant-teams.css`
- Modify test: `tests/browser/assistant-teams.spec.js:283-286`
- Test: `tests/browser/assistant-chat-teams.spec.js`

**Interfaces:**

- Consumes: `memberCount` (Task 1), `scrollToChild` (Task 5), card classes (Task 5).
- Produces: `.assistant-team-card[.awaiting]`, `.assistant-team-member` buttons.

- [ ] **Step 1: Write the failing tests**

Append to `tests/browser/assistant-chat-teams.spec.js`:

```js
test.describe("team cards", () => {
  test("running members are whole-row links; proposals use full-width buttons", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await chatFixture(page, {
      ...memberSetup(),
      teams: [
        runningTeam(),
        runningTeam({
          id: "proposal",
          objective: "Plan a second launch",
          phase: "awaiting_approval",
          memberIds: [],
          members: [{ name: "Reviewer", role: "Review", assignment: "Check results" }],
        }),
      ],
    });
    await page.goto(chat);
    const proposal = page.locator(".assistant-team-card.awaiting");
    await expect(proposal).toHaveAttribute("open", "");
    await expect(proposal).toContainText("Reviewer · Review");
    const [approve, decline] = await Promise.all([
      proposal.getByRole("button", { name: "Approve team", exact: true }).boundingBox(),
      proposal.getByRole("button", { name: "Decline team", exact: true }).boundingBox(),
    ]);
    expect(Math.abs(approve.width - decline.width)).toBeLessThanOrEqual(1);
    expect(approve.height).toBe(40);
    const running = page
      .locator(".assistant-team-card")
      .filter({ hasText: "Prepare the website relaunch" });
    await expect(running.locator("summary")).toContainText("Working · 1 member");
    await running.locator("summary").click();
    const row = running.getByRole("button", { name: /^Research lead/ });
    await expect(row).toContainText("Compare the three biggest vendors");
    await expect(
      running.getByRole("button", { name: "Stop team", exact: true }),
    ).toBeVisible();
    await row.click();
    await expect(page).toHaveURL(/\/agents\/member-0\/chats\/member-chat$/);
  });
});
```

Run: `npm run build && npx playwright test tests/browser/assistant-chat-teams.spec.js -g "team cards"`
Expected: FAIL — `.assistant-team-card.awaiting` missing.

- [ ] **Step 2: Rewrite `AssistantTeams.jsx`**

```jsx
import React, { useEffect, useState } from "react";
import Icon from "../../components/Icon.jsx";
import { assistantCopy as copy } from "../../lib/i18n/messages/assistants.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import useAssistants from "./useAssistants.js";
import { assistantApi } from "./assistant-api.js";
import { avatarGlyph } from "./avatar-glyph.js";
import TeamCodingRequests from "./TeamCodingRequests.jsx";
import useTeamCodingRequests from "./useTeamCodingRequests.js";
import { scrollToChild } from "./transcript-scroll.js";

const finished = ["completed", "failed", "cancelled", "declined"];
// Member phases shown quietly; every other phase is in progress and uses the accent.
const quiet = new Set(["ready", "completed", "cancelled", "declined"]);

export default function AssistantTeams({ assistant, focusTeamId, navigate }) {
  const { teams = [], members = [], refresh } = useAssistants();
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [archived, setArchived] = useState(false);
  // A deep link to a team task (from a Telegram notice) shows that team.
  const focused = teams.some((t) => t.id === focusTeamId);
  useEffect(() => {
    if (!focused) return;
    const card = document.getElementById(`assistant-team-${focusTeamId}`);
    scrollToChild(card?.closest(".assistant-transcript"), card);
  }, [focusTeamId, focused]);
  const member = members.find((m) => m.assistantId === assistant.id);
  const coding = useTeamCodingRequests(
    assistant.id,
    !member && teams.some((t) => t.parentAssistantId === assistant.id),
    teams,
  );
  async function act(operation) {
    setBusy(true);
    setError("");
    try {
      await operation();
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  // A member's chat shows its team context above the transcript instead.
  if (member) return null;
  const own = teams.filter((t) => t.parentAssistantId === assistant.id);
  if (!own.length) return null;
  // A member's coding request waiting for the owner is decided in its team card.
  const codingPending = (team) =>
    coding.actions.some((a) => a.teamId === team.id && a.state === "awaiting_approval");
  return (
    <section className="assistant-teams" aria-label={copy.team.title}>
      <ErrorMessage error={error || coding.error} />
      {own
        .filter((t) => archived || !t.archivedAt || t.id === focusTeamId)
        .map((team) => {
          const awaiting = team.phase === "awaiting_approval";
          const teamMembers = members.filter((m) => m.teamId === team.id);
          const state = copy.team.states[team.status || team.phase];
          return (
            <details
              key={team.id}
              id={`assistant-team-${team.id}`}
              data-pending={awaiting || codingPending(team) ? "" : undefined}
              open={awaiting || team.id === focusTeamId || codingPending(team)}
              className={`assistant-team-card${awaiting ? " awaiting" : ""}`}
            >
              <summary>
                <span className="assistant-team-icon" aria-hidden="true">
                  <Icon name="users" size={15} />
                </span>
                <span className="assistant-team-title">
                  <strong>{team.objective}</strong>
                  <span>
                    {awaiting || !teamMembers.length
                      ? state
                      : `${state} · ${copy.memberCount(teamMembers.length)}`}
                  </span>
                </span>
                {!awaiting && (
                  <Icon name="chevron" size={16} className="assistant-team-chevron" />
                )}
              </summary>
              {team.ownerRequestQuote && (
                <p className="assistant-team-reason">
                  {copy.team.startedBecause(team.ownerRequestQuote)}
                </p>
              )}
              {awaiting ? (
                <>
                  <p className="assistant-team-hint">{copy.team.approvalHint}</p>
                  <ul className="assistant-team-proposal">
                    {team.members.map((m, n) => (
                      <li key={n}>
                        <span className="assistant-avatar" aria-hidden="true">
                          {avatarGlyph(m.name)}
                        </span>
                        <span>
                          <strong>
                            {m.name} · {m.role}
                          </strong>
                          <small>{m.assignment}</small>
                        </span>
                      </li>
                    ))}
                  </ul>
                  <div className="assistant-card-actions">
                    <button
                      type="button"
                      className="button primary"
                      disabled={busy}
                      onClick={() =>
                        act(() =>
                          assistantApi.decideTeam(team.id, {
                            revision: team.revision,
                            decision: "approve",
                            lifetime: "task",
                          }),
                        )
                      }
                    >
                      {copy.team.approve}
                    </button>
                    <button
                      type="button"
                      className="button secondary"
                      disabled={busy}
                      onClick={() =>
                        act(() =>
                          assistantApi.decideTeam(team.id, {
                            revision: team.revision,
                            decision: "decline",
                          }),
                        )
                      }
                    >
                      {copy.team.decline}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <ul className="assistant-team-members">
                    {teamMembers.map((m) => (
                      <li key={m.id}>
                        <button
                          type="button"
                          className="assistant-team-member"
                          onClick={() =>
                            navigate({
                              view: "agents",
                              assistantId: m.assistantId,
                              ...(m.conversationId
                                ? { conversationId: m.conversationId }
                                : { agentSettings: true }),
                            })
                          }
                        >
                          <span className="assistant-avatar" aria-hidden="true">
                            {avatarGlyph(m.name)}
                          </span>
                          <span className="assistant-team-member-text">
                            <strong>{m.name}</strong>
                            <small>
                              <span className={quiet.has(m.phase) ? undefined : "active"}>
                                {copy.team.states[m.phase]}
                              </span>
                              {m.assignment ? ` · ${m.assignment}` : ""}
                            </small>
                          </span>
                          <Icon name="chevron" size={16} />
                        </button>
                      </li>
                    ))}
                  </ul>
                  <TeamCodingRequests
                    actions={coding.actions.filter((a) => a.teamId === team.id)}
                    busy={busy}
                    onDecide={(a, decision) => act(() => coding.decide(a, decision))}
                  />
                  <div className="assistant-card-actions">
                    {!finished.includes(team.phase) && (
                      <button
                        type="button"
                        className="button secondary"
                        disabled={busy}
                        onClick={() =>
                          act(() => assistantApi.teamAction("teams", team.id, "stop"))
                        }
                      >
                        {copy.team.stopTeam}
                      </button>
                    )}
                    {finished.includes(team.phase) && (
                      <button
                        type="button"
                        className="button secondary"
                        disabled={busy}
                        onClick={() =>
                          act(() =>
                            assistantApi.teamAction(
                              "teams",
                              team.id,
                              team.archivedAt ? "restore" : "archive",
                              team.revision,
                            ),
                          )
                        }
                      >
                        {team.archivedAt ? copy.team.restore : copy.team.archive}
                      </button>
                    )}
                  </div>
                </>
              )}
            </details>
          );
        })}
      {own.some((t) => t.archivedAt) && (
        <label className="assistant-team-archived">
          <input
            type="checkbox"
            checked={archived}
            onChange={(e) => setArchived(e.target.checked)}
          />
          {copy.team.showArchived}
        </label>
      )}
    </section>
  );
}
```

- [ ] **Step 3: Card markup in `TeamCodingRequests.jsx`**

Replace the `<article className="assistant-card assistant-reminder-row" key={a.id}>`
opening and its first two children (the `<strong>` with `requestedBy` and the project
`<p>`) with:

```jsx
        <article
          className="assistant-approval-card"
          data-pending={a.state === "awaiting_approval" ? "" : undefined}
          key={a.id}
        >
          <div className="assistant-approval-head">
            <strong>{copy.requestedBy(a.memberName)}</strong>
            <small>{copy.states[a.state]}</small>
          </div>
          <p>
            {a.projectName}
            {a.pipelineName ? ` · ${a.pipelineName}` : ""}
          </p>
```

delete the later `<p>{copy.states[a.state]}</p>` line, give the task paragraph
`className="assistant-approval-task"` (instead of `assistant-memory-text`), and change
the decision wrapper `className="assistant-actions"` to `"assistant-card-actions"`.

- [ ] **Step 4: Team CSS**

In `assistants.css` delete `.assistant-teams`, `.assistant-team-card` (the remaining
selector from Task 6), `.assistant-team-card summary`, `.assistant-team-card summary span`,
`.assistant-team-reason`, `.assistant-team-members`, `.assistant-team-members li`,
`.assistant-team-members li p`. Keep `.assistant-team-permission` and
`.assistant-team-settings` (settings use them).

Append to `assistant-teams.css`:

```css
.assistant-teams {
  display: grid;
  gap: 14px;
}
.assistant-team-card {
  padding: 6px 6px 10px;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: var(--panel);
}
.assistant-team-card.awaiting {
  padding: 14px;
  border-color: var(--accent-line);
}
.assistant-team-card.awaiting > * + * {
  margin-top: 12px;
}
.assistant-team-card summary {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px;
  cursor: pointer;
  list-style: none;
}
.assistant-team-card summary::-webkit-details-marker {
  display: none;
}
.assistant-team-card.awaiting summary {
  align-items: flex-start;
  padding: 0;
}
.assistant-team-icon {
  display: grid;
  flex: none;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  background: var(--accent-soft);
  color: var(--accent);
}
.assistant-team-title {
  flex: 1;
  min-width: 0;
}
.assistant-team-title strong {
  display: block;
  font-size: 14px;
  font-weight: 600;
  overflow-wrap: anywhere;
}
.assistant-team-title > span {
  display: block;
  margin-top: 3px;
  color: var(--accent-text);
  font-size: 12px;
}
.assistant-team-chevron {
  flex: none;
  color: var(--muted);
  transition: transform 0.15s;
}
.assistant-team-card[open] .assistant-team-chevron {
  transform: rotate(90deg);
}
.assistant-team-reason {
  margin: 0 8px 8px;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.assistant-team-card.awaiting .assistant-team-reason {
  margin: 12px 0 0;
}
.assistant-team-hint {
  margin-bottom: 0;
  color: var(--text-row);
  font-size: 13px;
  line-height: 1.5;
}
.assistant-team-proposal {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-bottom: 0;
  padding: 8px 0 0;
  border-top: 1px solid var(--divider);
  list-style: none;
}
.assistant-team-proposal li {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 6px 0;
}
.assistant-team-proposal .assistant-avatar {
  flex: 0 0 22px;
  width: 22px;
  height: 22px;
  border-radius: 6px;
  font-size: 10px;
}
.assistant-team-proposal strong,
.assistant-team-member strong {
  display: block;
  color: var(--text-row);
  font-size: 13px;
  font-weight: 500;
}
.assistant-team-proposal small,
.assistant-team-member small {
  display: block;
  margin-top: 2px;
  color: var(--text-meta);
  font-size: 12px;
}
.assistant-team-members {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0 2px;
  list-style: none;
}
.assistant-team-member {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 9px 8px;
  border-top: 1px solid var(--divider-soft);
  border-radius: 8px;
  text-align: left;
}
.assistant-team-member:hover {
  background: var(--button-secondary-bg);
}
.assistant-team-member .assistant-avatar {
  flex: 0 0 26px;
  width: 26px;
  height: 26px;
  border-radius: 7px;
  font-size: 11px;
}
.assistant-team-member-text {
  flex: 1;
  min-width: 0;
}
.assistant-team-member small {
  overflow: hidden;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.assistant-team-member small .active {
  color: var(--accent-text);
}
.assistant-team-member > svg {
  flex: none;
  color: var(--text-faint);
}
.assistant-team-card:not(.awaiting) .assistant-team-coding {
  margin: 8px;
}
.assistant-team-card:not(.awaiting) .assistant-card-actions {
  margin: 6px 8px 0;
}
.assistant-team-card:not(.awaiting) .assistant-card-actions .button {
  height: 36px;
}
.assistant-team-card:not(.awaiting) .assistant-card-actions:empty {
  display: none;
}
.assistant-team-archived {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--muted);
  font-size: 12px;
}
.assistant-team-archived input {
  width: auto;
}
@media (min-width: 701px) {
  .assistant-team-card:not([open]) {
    padding: 12px 14px;
  }
  .assistant-team-card:not([open]) summary {
    padding: 0;
  }
  .assistant-team-card:not([open]) .assistant-team-icon {
    width: 30px;
    height: 30px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .assistant-team-chevron {
    transition: none;
  }
}
```

- [ ] **Step 5: Update the member-row locator**

`tests/browser/assistant-teams.spec.js` lines 283-286 (one line lower after Task 4's
insertion; match the `.getByRole("button", { name: "Reviewer 1", exact: true })` call
inside `.assistant-team-members`) become:

```js
await page
  .locator(".assistant-team-members")
  .getByRole("button", { name: /^Reviewer 1\b/ })
  .click({ timeout: 3000 });
```

- [ ] **Step 6: Run the specs**

Run: `npm run build && npx playwright test tests/browser/assistant-chat-teams.spec.js tests/browser/assistant-teams.spec.js tests/browser/assistant-team-coding.spec.js tests/browser/assistant-workflows.spec.js`
Expected: PASS (summary texts „Outcome unknown“, „Partially successful“, „Cancelled“
are still inside `.assistant-team-card summary`).

- [ ] **Step 7: Commit**

```bash
npm run format && npm run lint && npm run check:structure
git add web tests
git commit -m "feat: restyle agent team cards and open member chats from whole rows

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Sweep, fidelity check and full verification

**Files:**

- Temporary (never committed): `tests/browser/zz-pixel-check.spec.js`
- Possibly modify: any spec the sweep finds

**Interfaces:**

- Consumes: everything above.
- Produces: a green branch state for part 4.

- [ ] **Step 1: Sweep for removed selectors and labels**

Run:

```bash
grep -rn "assistant-breadcrumb\|assistant-view-tabs\|Agent views\|Agenten-Ansichten\|assistant-member-summary\|chat-send-hint\|assistant-chat-header\|assistant-profile-header" web tests
grep -rn "assistant-state-badge" web tests
```

Expected: the first command prints nothing. The second prints only
`AgentsPage.jsx` (list card), `assistant-settings.css`, `assistants.css` (base badge).
Fix any other hit by switching to the new selectors from Tasks 2–7. Keep the copy
keys `navigation`, `conversation` and `chat`: `conversation` still names the
transcript log and `chat` the agent list card button.

- [ ] **Step 2: Capture the redesigned states**

Create `tests/browser/zz-pixel-check.spec.js` (do not `git add` it):

```js
import { test } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { chatFixture } from "../helpers/assistant-chat-fixture.js";

const out = process.env.PIXEL_OUT;
const working = {
  messages: [{ id: "q", role: "user", text: "Plane mir die Woche" }],
  requests: [
    {
      id: "r",
      text: "Plane mir die Woche",
      state: "accepted",
      attempt: { id: "a", state: "accepted" },
    },
  ],
  stale: false,
};
for (const [name, width, height] of [
  ["phone", 390, 844],
  ["desktop", 1440, 900],
])
  test(`pixel ${name}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await chatFixture(page, { language: "de" });
    await page.goto(baseURL + "/agents/home/chats/dinner");
    await page.screenshot({ path: `${out}/1d-${name}.png` });
    await page.getByRole("button", { name: "Optionen", exact: true }).click();
    await page.screenshot({ path: `${out}/1d-options-${name}.png` });
  });
test("pixel working", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await chatFixture(page, { language: "de", history: working });
  await page.goto(baseURL + "/agents/home/chats/dinner");
  await page.evaluate(() =>
    window.assistantTestStream.onmessage({
      data: JSON.stringify({
        type: "delta",
        conversationId: "dinner",
        text: "Gern. Hier ist ein erster Vorschlag:",
      }),
    }),
  );
  await page.screenshot({ path: `${out}/2a-phone.png` });
});
```

Run:

```bash
mkdir -p "$SCRATCH/pixel"
npm run build && PIXEL_OUT="$SCRATCH/pixel" npx playwright test tests/browser/zz-pixel-check.spec.js
rm tests/browser/zz-pixel-check.spec.js
```

(`$SCRATCH` = the session scratchpad directory.) For 2c and 2d add two more tests to the
temporary file before running it: copy `action`, `waiting`, `runningTeam` and
`memberSetup` from `assistant-chat-teams.spec.js` (they are not exported), then
screenshot `chatFixture(page, { language: "de", activity: waiting(2), actions:
[action("a1")], teams: [runningTeam({ phase: "awaiting_approval", members: [] })] })` at
`/agents/home/chats/dinner` as `2c-phone.png`, and `chatFixture(page, { language: "de",
...memberSetup() })` at `/agents/member-0/chats/member-chat` as `2d-phone.png`.

- [ ] **Step 3: Compare with the handoff**

Open each capture next to the rendered handoff states (`explore-1d.png`,
`detail-2a.png`, `detail-2c.png`, `detail-2d.png`, `detail-2f.png`). Check bar height,
avatar size and radius, status dot colour, bubble radius and padding, reply font size,
composer radius/padding, button sizes, popover position and switch, strip colours,
card borders. Fix any deviation in the CSS of the owning task, rebuild, recapture.
Expected: no visible difference beyond mock data and the iOS status bar.

- [ ] **Step 4: Full verification**

Run:

```bash
npm run check
npx playwright test tests/browser/assistant*.spec.js tests/browser/sidebar*.spec.js tests/browser/chat.spec.js
AGENTPIER_TEST_BROWSER=webkit AGENTPIER_TEST_PORT=4391 npx playwright test tests/browser/assistant*.spec.js --output test-results-webkit
```

Expected: all PASS; the WebKit run includes the `tablet` project (820×1180 touch) for
every `assistant*.spec.js`.

- [ ] **Step 5: Commit any fixes**

```bash
git status --short   # zz-pixel-check.spec.js must not be listed
npm run format
git add web tests
git commit -m "fix: align the agent chat with the handoff measurements

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

(Skip the commit if Steps 1–4 changed nothing.)
