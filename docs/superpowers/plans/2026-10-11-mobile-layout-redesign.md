# Mobile Layout Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the „Mobile Layout Verbesserungen“ handoff (sidebar Menü 1a/2f, agent
chat 1d/2a–2d, agent settings 2e) at near pixel fidelity, plus a server-derived
per-agent activity, without breaking existing behaviour.

**Architecture:** The server derives a per-agent `activity` map from the request ledger,
the action store, teams and members and adds it to `GET /api/assistants`. The web shell
moves navigation into an always-mounted popover inside the „Hauptnavigation“ landmark and
turns the drawer into one scroll area. The agent chat collapses into one header bar,
flat transcript and a single composer; settings get a dedicated mobile scroll container,
active section chips and a dirty-only save bar.

**Tech Stack:** Node.js 22 ES modules, Express, `node:sqlite` (`DatabaseSync` via
`server/lib/private-database.js`), React 19 + Vite, plain CSS, `node:test`, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-11-mobile-layout-redesign-design.md`
(read it first; it records every decision and deviation). Visual reference: the
untracked handoff `docs/Mobile Layout Verbesserungen.zip` → unzip outside the repo and
open the `.dc.html` files next to `support.js`.

## Plan parts (execute in order)

| Part | File                                                   | Scope                                                                                                 |
| ---- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| 1    | `2026-10-11-mobile-layout-redesign-part-1-activity.md` | Backend activity, client data, status helpers                                                         |
| 2    | `2026-10-11-mobile-layout-redesign-part-2-sidebar.md`  | Tokens, Menü popover, drawer, agent and session rows, test helper                                     |
| 3    | `2026-10-11-mobile-layout-redesign-part-3-chat.md`     | Header, approval strip, transcript, composer, teams, member context                                   |
| 4    | `2026-10-11-mobile-layout-redesign-part-4-settings.md` | Settings scroll container, section chips, dirty state, save bar, docs, final verification and cleanup |

Each part ends with `npm run check` green and its affected browser specs passing in
Chromium. One branch, one PR, opened only after part 4.

## Global Constraints

- Work only in `.worktrees/mobile-layout-redesign` on `feat/mobile-layout-redesign`.
- Never `git add` `docs/Mobile Layout Verbesserungen.zip`.
- Every source, CSS and test file ≤ 600 lines (`npm run check:structure`).
  `web/features/assistants/assistants.css` is already at 600: only remove lines from it.
- `web/features/assistants/*.css`: no hex colours, no `var(--x) NN` alpha suffix
  (`tests/unit/assistant-css.test.js`). Use the tokens from spec „Theme tokens“.
- Every UI string in both `web/lib/i18n/de/*` and `web/lib/i18n/en/*` with identical keys
  and arguments; import reactive copy from `web/lib/i18n/messages/`; German strings must
  pass `tests/unit/i18n-terminology.test.js`.
- Prettier: two spaces, double quotes, semicolons, trailing commas, 90 columns. Run
  `npm run format` before each commit.
- Commit messages in English with `feat:` / `fix:` / `chore:` / `docs:` / `test:`
  prefixes, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Browser tests never target real sessions or the default tmux server; use the existing
  fixtures (`scripts/test-server.mjs`, `tests/helpers/`). Concurrent runs need distinct
  `AGENTPIER_TEST_PORT` and `--output`.
- Mobile breakpoint for all new layout rules: `max-width: 700px`
  (`web/lib/useMobileLayout.js`).
- Reduced motion: every new animation is disabled under `prefers-reduced-motion: reduce`.

## Shared interfaces (contract between parts)

Part 1 produces, later parts consume:

- `RequestLedger#latestByConversation(): Array<{ conversationId: string,
requestId: string, requestState: string, attemptId: string | null,
attemptState: string | null, reviewedAt: string | null }>`
- `AssistantActionStore#awaitingCounts(now = Date.now()): Record<assistantId,
{ own: number, team: number }>`
- `assistantActivity({ assistants, conversations, latest, awaiting, teams, members })`
  in `server/features/assistants/assistant-activity.js` →
  `Record<assistantId, ActivityEntry>` where
  `ActivityEntry = { state: "idle"|"working"|"waiting"|"attention",
reason: "attempt"|"member"|"queued"|"approval"|"team"|null, label: string | null,
pendingApprovals: number, team: "awaiting"|"active"|null }`.
  `label` is a dotted copy path inside `assistantCopy`, e.g. `"status.accepted"`,
  `"team.states.queued"`, `"teamActive.awaiting"`.
- `GET /api/assistants` → adds top-level `activity: Record<assistantId, ActivityEntry>`.
- `useAssistants().activity` (default `{}`).
- `web/features/assistants/assistant-status.js`:
  - `IDLE_ACTIVITY` (frozen `ActivityEntry` with `state: "idle"`)
  - `activityFor(activity, assistantId): ActivityEntry`
  - `activityDot(entry): "working" | "waiting" | "unknown" | null`
  - `copyAt(copy, path): string | undefined` (resolves dotted paths)
  - `headerStatus({ assistant, models, runtime, attempt, entry, member, copy }):
{ tone: "missing"|"muted"|"attention"|"working"|"waiting"|"ready", label: string }`
  - `sidebarSubline({ assistant, entry, member, model, copy }):
{ text: string, tone: "accent" | "meta" }` — `model` is the agent's own
    `assistant.model` (`{ connectionId, modelId }`), not a connection record. Order:
    team state (`teamActive.*`), then the activity label, then for members only the
    phase (callers add role or assignment), else `model.modelId`.
  - `headerStatus` returns only the state label (idle member chats: the member phase);
    `AssistantHeader` appends „ · {modelId}“ or, in member chats, „ · {role}“.
- Copy keys added in part 1: `assistantCopy.teamActive.working`,
  `assistantCopy.teamActive.awaiting`.

Part 2 produces:

- Tokens in `web/styles/base.css` (full table from the spec, added at once).
- `web/app/SidebarMenu.jsx` default export
  `SidebarMenu({ view, selected, page, select, state, agentsEnabled, localAccess, error,
loading, mobileNav })` (no `desktop`: geometry is pure CSS; `error`/`loading` feed the
  host status, `mobileNav` closes it with the drawer). Trigger `.sidebar-menu-button`,
  popover `#sidebar-menu`, scrim `.sidebar-menu-scrim`, styles in
  `web/app/sidebar-menu.css`. Escape is stopped in React (`stopPropagation()`), so
  `App.jsx` is not modified by part 2.
- Sidebar structure: `.sidebar-head`, `.sidebar-launch`, `.sidebar-scroll` (the only
  scroll container); closed phone drawer `inert`.
- `web/app/SessionRow.jsx` default export `SessionRow({ session, selected, onSelect,
names })`.
- `ProviderMark({ tool, small, size, label })`: `label` (opt-in accessible name) and
  `size="row"`.
- `SidebarGroup` new prop `ariaLabel`.
- Agent rows: `div.assistant-sidebar-row` › `button.session-item.assistant-sidebar-item`
  - `button.assistant-team-pill`; styles in `web/features/assistants/assistant-sidebar.css`.
- `tests/helpers/navigation.js` `openMenu(page): Promise<Locator>` and updated
  `navigateTo(page, name)`.
- Copy keys: `sidebarCopy.menu`, `sidebarCopy.closeMenu`, `assistantCopy.agentsGroup`;
  `sidebarCopy.sidebarCaption` is removed.

Part 3 produces:

- `AssistantHeader({ assistant, variant: "conversation" | "settings", navigate,
onBack, openNavigation, navigationOpen, attempt, member })` (no `onChat`). Status
  line class `.assistant-header-status` with tone modifiers (not `.assistant-status`,
  which `AssistantRuntimeSettings.jsx` already uses); settings subline
  `.assistant-header-sub`.
- `AgentsPage({ route, navigate, openNavigation, navigationOpen })` and
  `AssistantChat({ …, openNavigation, navigationOpen })`; `App.jsx` passes a memoised
  `openNavigation` (remembers the opener, refocuses it after Escape closes the drawer)
  and `navigationOpen={mobileNav}`.
- Settings page: `section.assistant-settings-page > header + div.assistant-settings-scroll`
  (wrapper and its desktop padding come from part 3; part 4 makes it the phone
  scroller). Back falls back to `{ view: "agents" }` when the connection is missing.
- `.assistant-detail .sr-only` (scoped visually-hidden rule in `assistant-chat.css`).
  No earlier part uses `.sr-only`.
- `.assistant-state-badge` remains only for the agent list card
  (`connectionMissing`); its `.ready`/`.running` rules and the settings badge test go.
  `.assistant-team-permission` stays (settings checkboxes).
- `Icon` new prop `fill` (boolean; fills the path with `currentColor`).
- `useAssistantActions(assistantId, enabled = true) → { actions, error, decide, reload }`;
  `scrollToChild(container, element, offset = 12)`; `AssistantComposer`,
  `ComposerOptions`, `AssistantApprovalStrip({ count, output })`,
  `AssistantMemberContext({ member, navigate })`; styles in `assistant-teams.css`.
- Test helpers `tests/helpers/assistant-chat-fixture.js`: `chatFixture(page, options)`,
  `chatAssistant(overrides)`, `emit(page, event)`.
- Copy keys: `assistantCopy.team.allowedChip`, `stopShort`, `showApprovals`,
  `memberCount(n)`, `options`, `optionsClose`, `backToChat`.

Part 4 produces:

- `sameValue(a, b)` and `isDirty(values, base): boolean` in
  `web/features/assistants/synced-form-state.js`; `useSyncedForm()` returns
  `dirty = isDirty(values, server)`, where the base is the current `server` prop (a
  render input), not hook state or a ref.
- `AssistantSaveBar({ form, busy, creating, onCancel })`.
- Test helper `tests/helpers/assistant-settings-browser.js`: `home(extra)`,
  `setupAssistantSettings(page, options)`, `emitChange(page)`.
- Copy key: `assistantCopy.pendingConfigShort`.

## Review Focus

1. **320 px phones** (iPhone SE, small Android): drawer, popover, chat header and
   composer must fit without horizontal scroll and without clipped controls → Part 2
   Task „Sidebar layout CSS“ and Part 3 Task „Header“ each add a 320×640 overflow test.
2. **English copy is longer** („Team awaiting approval“, „Back to conversation“): rows,
   header status and chips truncate with ellipsis instead of wrapping or overflowing →
   Part 2 agent row test and Part 3 header test run once with `locale: "en-US"`.
3. **Agents feature disabled**: drawer shows only Sitzungen, the popover has no
   „Agenten“ entry, and no assistant CSS loads → Part 2 Task „SidebarMenu“ test with
   agents disabled (reuse `assistant-feature.spec.js` setup).
4. **Keyboard-only use**: Tab never reaches the closed drawer on mobile, focus returns to
   the Menü button on Esc and to the header menu button after the drawer closes via Esc
   → Part 2 popover test and Part 3 header test.
5. **Older or partial list responses** (no `activity` key, or an entry missing for a new
   agent during refresh): UI renders idle without throwing → Part 1 client task test
   with a mocked `/api/assistants` lacking `activity`.

---

Execute part 1 first: `2026-10-11-mobile-layout-redesign-part-1-activity.md`.
