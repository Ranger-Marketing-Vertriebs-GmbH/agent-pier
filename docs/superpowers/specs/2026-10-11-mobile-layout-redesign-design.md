# Mobile layout redesign: sidebar menu and agent chat

Date: 2026-10-11

## Problem

On phones the sidebar squeezes navigation, host status, logout, agent chats and sessions
into one 260 px drawer with three nested scroll containers (the drawer itself, the agent
group capped at `34dvh`, and the session list). The agent chat stacks the 62 px app
header, a breadcrumb, a profile header, view tabs, bordered message cards and a composer
with a checkbox row, so a 390×844 phone shows about 300 px of conversation.

## Goal

Implement the design handoff `design_handoff_mobile_sidebar_agent_chat` (local,
untracked `docs/Mobile Layout Verbesserungen.zip`: `README.md` plus the `.dc.html`
references) at near pixel fidelity, including icons:

1. **Sidebar 1a / 2f.** Navigation, host status and logout move into a „Menü“ popover.
   The drawer shows only Agents and Sessions in one shared scroll container with sticky
   group headers. Same structure on desktop.
2. **Agent chat 1d / 2a–2d.** One header bar, no tabs or breadcrumb, flat agent replies,
   a single rounded composer with a „+“ options popover, an approval strip, restyled team
   and approval cards, and a context strip in member chats.
3. **Agent settings 2e.** Header variant with a back button, an active section chip and a
   sticky save bar on mobile.

Sources of truth, in order: this spec (decisions and deviations), the `.dc.html` mocks
(exact inline values, also for desktop 2f), then the handoff README.

## Delivery

One branch (`feat/mobile-layout-redesign`) and one pull request, built in three steps
(A sidebar, B chat, C settings). Each step ends with `npm run check` green and the
affected browser specs passing in Chromium, so the branch is runnable after every step.
Step A starts with the backend activity, then the sidebar. Step B builds on A, step C
on B. Anything step B introduces on the settings page
(header variant, scroll container, navigation escape) is complete within step B.

## Non-goals

- Backend changes are limited to a derived per-agent activity in the assistant list
  response (see Agent activity). No new storage and no schema migration.
- No change to draft persistence, `canSend`, Enter-to-send, delivery acknowledgement,
  team decisions, stop/archive/restore semantics or route shapes (`web/app/routes.js`).
- No visual regression framework. Fidelity is checked by comparing Playwright screenshots
  against the rendered design states during development.
- No redesign of pages other than the shell, the agent chat and the agent settings.
  Other pages keep the 62 px `.mobile-header`.
- No live-update protocol. The client keeps refetching the list on `change` events
  (see Follow-up).

## Decisions and deviations from the handoff

1. **The popover is a plain navigation list, not `role="menu"`.** The landmark
   `<nav aria-label={sidebarCopy.ariaLabel}>` („Hauptnavigation“) wraps the Menü button
   **and** the popover, so the landmark exists while the popover is closed. The popover is
   always mounted and toggled with `hidden`. Items remain `button.nav-item`.
   From `FileActionMenu.jsx` only outside-pointerdown closing and focus restoration are
   reused; no `menu`/`menuitem` roles and no arrow-key roving.
2. **Session rows keep the tool name for assistive technology.** The visible „· Codex“ is
   dropped. `ProviderMark` gets an opt-in `label` prop (renders `role="img"` and
   `aria-label` only when passed); only session rows pass it, other uses are unchanged.
   The sandbox badge stays visible. Subline order: `label · location · sandbox`, where
   location is `repositoryName || basename(cwd)` (shell rows: no location). The full cwd
   stays in the row `title`.
3. **The settings save bar shows only while the profile form is dirty**, or always when
   creating a new agent. It covers only `#agent-profile`; other sections keep their own
   forms and buttons. On ≤700 px the in-form profile buttons hide; desktop is unchanged.
4. **The 1150 px breakpoint sets `--sidebar-width` to 240 px** (desktop default 280 px).
5. **The closed mobile drawer is `inert`**: only when `useMobileLayout()` (≤700 px) is
   true and `mobileNav` is false. Desktop never sets `inert`; resizing re-evaluates.
6. **Breadcrumb and view tabs are removed on all widths**, matching 2f. The agent list
   stays reachable through Menü → Agenten.
7. **„Abbrechen“ in the save bar keeps today's behaviour** (`onCancel`).
8. **The sidebar caption („DEIN RECHNER. DEINE TOOLS.“) is removed everywhere**, matching
   1a and 2f (the README allowed keeping it on desktop; the mock does not show it).
9. **The collapsible Projekte and Konfiguration groups are replaced by static group
   labels** in the popover. Their persisted open state (`agentpier.sidebar.projects`,
   `agentpier.sidebar.configuration`) and the active-group colour are dropped; stale
   localStorage keys are harmless and not migrated.
10. **The agent chat uses one mobile breakpoint, ≤700 px**, for header, transcript,
    composer and settings layout (today parts use 650 px). 651–700 px therefore gets the
    mobile layout, consistent with the hidden `.mobile-header`.
11. **Esc closes one layer at a time.** The popover handles Esc on its own container and
    trigger and calls `stopPropagation()`, so the window listener in `App.jsx` that
    closes the drawer does not fire. First Esc closes the popover (focus to Menü button),
    second Esc closes the drawer.

## Theme tokens

`tests/unit/assistant-css.test.js` bans hex colours and `var(--x) NN` alpha suffixes in
`web/features/assistants/*.css`. Every design colour that is not yet a token becomes one
in `web/styles/base.css`. New and rewritten rules (in assistant CSS and in the touched
shell rules) use tokens; untouched rules in `layout.css` keep their literals.

| Token | Value | Use |
|---|---|---|
| `--text` | `#e8e8ec` | default text, Stoppen pill, popover rows |
| `--sidebar-bg` | `#15161a` | drawer, sticky group headers, context strip, save bar |
| `--header-bg` | `#16171b` | mobile chat top bar, mobile header |
| `--header-line` | `#28292d` | bar borders |
| `--popover-bg` | `#1b1c20` | Menü popover |
| `--popover-raised` | `#1f2024` | composer options popover |
| `--popover-shadow` | `0 18px 40px -12px #000` | both popovers (full shadow value) |
| `--scrim` | `#0b0c0e99` | drawer scrim while Menü is open |
| `--accent-text` | `#ffc99d` | working/waiting labels, active items |
| `--accent-focus` | `#f49a5866` | composer focus border |
| `--button-secondary-bg` | `#202125` | secondary buttons, Menü button |
| `--button-secondary-line` | `#323337` | secondary borders, round composer buttons |
| `--button-secondary-text` | `#dcdde1` | secondary button text |
| `--nav-selected` | `#26272b` | active popover item |
| `--pill-bg` / `--pill-text` | `#1c1d21` / `#b9babe` | team pill |
| `--text-row` / `--text-meta` | `#cfd0d4` / `#8a8b8f` | row names / sublines |
| `--text-menu` | `#c4c5c9` | popover items, header icons, form labels |
| `--text-group` / `--text-faint` | `#97989c` / `#6f7075` | group headers / group labels, chevrons, checkbox border |
| `--text-message` | `#e1e2e6` | agent reply text |
| `--placeholder` / `--hint` | `#6b6c70` / `#7e7f83` | composer placeholder / keyboard hint |
| `--approval-bg` / `--approval-line` | `#1b1a19` / `#2e2924` | approval strip |
| `--divider` / `--divider-soft` | `#2a2b30` / `#24252a` | card member list / running team rows |
| `--switch-off` / `--switch-knob` | `#3a3b3f` / `#fff` | switch track off / knob |
| `--on-accent` | `#242529` | icon on the accent send button |

The undefined `var(--border)` and `var(--surface)` in `assistants.css` are replaced with
real tokens while restyling.

## CSS file layout

`web/features/assistants/assistants.css` is at the 600-line limit; rules move out:

- `assistant-sidebar.css` (new): agent rows, team pill, expanded team block.
- `assistant-chat.css` (exists): header bar, approval strip, transcript, composer,
  options popover.
- `assistant-teams.css` (new): team cards, approval cards, member context strip.
- `assistant-settings.css` (exists): scroll container, section chips, flat form, save bar.
- `web/app/layout.css`, `web/styles/mobile.css`, `web/styles/desktop.css`: shell,
  drawer, popover, session rows.

Assistant selectors stay in assistant CSS files loaded by `AssistantsRoot.jsx`
(`assistant-feature.spec.js` requires no assistant CSS while agents are disabled). Every
file stays below 600 lines; new browser coverage goes into new spec files where existing
specs would exceed 600 lines (`assistant-teams.spec.js` is at 474).

## Agent activity (backend)

Today the client cannot tell whether an agent is working: conversations carry no
request state. The server derives it from data it already stores.

- **`RequestLedger.latestByConversation()`** (`request-ledger.js`): one SQL statement
  returning, per conversation, the latest request joined to its latest attempt and
  `attempt_reviews`. Uses the existing `UNIQUE(conversation_id, client_key)` and
  `attempts_request` indexes; no per-conversation `attemptFor` loop.
- **`AssistantActionStore.awaitingCounts(now)`** (`assistant-action-store.js`): awaiting
  approval actions per `assistant_id`, split into own actions (`teamId` unset) and team
  coding requests (`teamId` set, stored on the parent), excluding `expiresAt <= now`.
- **`assistant-activity.js` (new, pure):**
  `assistantActivity({assistants, conversations, latest, awaiting, teams, members})`
  returns `{ [assistantId]: { state, reason, label, pendingApprovals, team } }`:
  - `state`: `attention` > `waiting` > `working` > `idle` (first match wins):
    - `attention`: latest attempt `uncertain` or `interrupted` and not reviewed
      (`reason: "attempt"`), or the agent is a member in `uncertain` /
      `provisioning_uncertain` (`reason: "member"`).
    - `waiting`: `pendingApprovals > 0` (`reason: "approval"`).
    - `working`: latest attempt `pending` / `accepted` / `running` and not reviewed
      (`reason: "attempt"`); member phase `provisioning`, `admitting`, `running`,
      `stopping` (`reason: "member"`) or `queued` (`reason: "queued"`); an own team in
      an active phase (`reason: "team"`).
    - otherwise `idle`. A `failed` last attempt does not produce a lasting state.
  - `pendingApprovals` = own awaiting actions + team coding awaiting actions + own teams
    in `awaiting_approval`.
  - `team`: `awaiting` if any non-archived own team awaits approval, else `active` if any
    is in an active phase (`approved`, `queued`, `provisioning`,
    `provisioning_uncertain`, `ready`, `admitting`, `running`, `stopping`), else `null`.
    Team labels keep using `team.status || team.phase`.
  - `label`: the copy key the client renders (`status.running`, `team.states.<phase>`,
    `teamActive.awaiting`, …), so server and client agree on wording without the server
    holding translations.
  - Archived assistants are skipped.
- **`AssistantService.list()`** adds the top-level `activity` map. It is not merged into
  assistant records, so settings forms can never write it back.
- **Fix:** `markOutstandingUnknown()` on runtime `failed` also calls `changed()`, so the
  client learns that attempts became uncertain.
- `assistant-service.js` (404 lines) only wires the call; the logic lives in the new
  module.

### Client use

- `AssistantsRoot.jsx` copies `activity` into the state; `useAssistants.js` defaults it
  to `{}`. A missing entry means `idle`, so existing browser mocks of `/api/assistants`
  keep working.
- **`web/features/assistants/assistant-status.js` (new)** turns activity plus local
  context into what the UI shows. Sidebar dot: `working` → `.activity-dot.working`,
  `waiting` → `.waiting`, `attention` → `.unknown` (dashed); `idle` → no dot. Sidebar
  subline: team state (`teamActive.*`) when `team` is set, the member phase for member
  rows, otherwise the model ID.
- **Header status precedence** (first match wins):

| # | Condition | Label | Style |
|---|---|---|---|
| 1 | `connectionMissing` | `status.connectionMissing` | accent label, no dot |
| 2 | `runtime.availability !== "ready"` | `status[availability]` | `failed`/`stale`: attention; others: muted dot |
| 3 | active attempt in the loaded history (live, faster than the list) | `status[attempt.state]` | working; `uncertain`/`interrupted`: attention |
| 4 | `activity.state !== "idle"` | `activity.label` | per state (working / waiting / attention) |
| 5 | otherwise | `status.ready` (idle member chat: `team.states[member.phase]`) | ready (success dot, success-muted label) |

  Conversation variants append „ · {modelId}“; member chats append „ · {role}“.
- The approval strip count is `activity.pendingApprovals`; scroll targets are the
  pending cards in the DOM (`data-pending`), so sidebar and chat agree.

### Tests (activity)

- Unit: `assistantActivity` precedence and every reason, archived and member cases,
  `failed` stays idle; `awaitingCounts` split and expiry.
- Integration: `latestByConversation` against a real ledger (multiple requests and
  attempts, reviews); `list().activity` is `working` while a request is accepted and
  `idle` after completion; runtime failure emits `change` and yields `attention`.
- Browser: sidebar dot and subline follow mocked activity; header status precedence.

## Step A: sidebar and Menü (1a, 2f)

### Components

- **`web/app/SidebarMenu.jsx` (new).**
  - Menü button: `aria-expanded`, `aria-controls`; open state shows the close icon,
    `--surface-accent`, `--accent-line`, `--accent-text`, above the scrim.
  - Popover contents in order: Übersicht, Artefakte, Agenten (only with
    `agentsEnabled`); group label PROJEKTE: Projekte, Dateien, Pipelines; group label
    KONFIGURATION: Accounts (existing `.count` chip), Erweiterungen, Einstellungen;
    divider; host status (existing `.host-status` markup) and remote link (only when
    `state.remoteUrl && localAccess`); `LogoutButton`. Selected-item logic moves over
    unchanged from `Sidebar.jsx`.
  - Closing: Esc (decision 11, focus returns to the button), scrim tap, outside
    pointerdown, choosing an item, route change, drawer close. Opening focuses the first
    item.
  - Geometry: mobile `top: 58px; right: 10px`, desktop `top: 52px; right: 12px`;
    `width: min(256px, calc(100% - 20px))`; `max-height: calc(100% - <top> - 10px)` with
    `overflow-y: auto`; items min-height 40 (mobile) / 38 (desktop). The sidebar must not
    clip it (`overflow: visible` on `.sidebar`; scrolling lives in `.sidebar-scroll`).
  - Scrim `--scrim` covers the drawer/sidebar only.
- **`web/app/Sidebar.jsx`.** New order: header row(s) → „Neue Sitzung“ →
  `.sidebar-scroll` (flex 1, the only scroll container; mobile padding `0 6 16`, desktop
  `0 8 16`) holding `AssistantSidebar` and the Sitzungen group. The old `nav`,
  `.sidebar-bottom` and caption go. Desktop: first row (padding `12 14 0`) with the
  collapse button left and Menü right (height 34), brand row with LOCAL badge as today,
  „Neue Sitzung“ wrapper `0 14 12`, height 43 with ↗. Mobile: one header row
  (`14 14 14 18`, brand 28 px symbol / 22 px wordmark, no LOCAL badge, Menü height 36),
  „Neue Sitzung“ wrapper `0 14 10`, height 40, no ↗. The old `.sidebar` paddings
  (`12px 19px 18px`, `padding-top: 27px` on mobile, 14 px at ≤1150 px) give way to these
  per-row paddings.
- **`web/app/SessionRow.jsx` (new).** Extracted from `Sidebar.jsx`: `ProviderMark` at
  30 px with `label` (decision 2) and the activity dot (ring `--sidebar-bg`); glyph sizes
  per mock (codex 17, claude 20, opencode 24, shell 16) through a new size variant, not
  by changing `small`. Name 13/500, subline per decision 2. Selection, `title`,
  pipeline-session filtering and the empty state stay as today.
- **`web/app/SidebarGroup.jsx`.** Sticky header (`top: 0; z-index: 1`, `--sidebar-bg`,
  height 36); Sitzungen header `margin-top: 8px`. Open state persistence, `activeKey`
  behaviour, count and chevron unchanged. New optional `ariaLabel` prop.
- **`web/features/assistants/AssistantSidebar.jsx`.**
  - Group label „Agenten“ (`assistantCopy.agentsGroup`); toggle `ariaLabel` stays
    `assistantCopy.chats` („Agenten-Chats“), so it does not collide with the popover item
    „Agenten“.
  - DOM per root: `div.assistant-sidebar-row` containing the row `button.session-item.
    assistant-sidebar-item` and, as a sibling (never nested), the team pill button.
  - Row: 30 px avatar (radius 9) with the status dot, name, subline per Agent activity (client use).
  - Pill: `aria-expanded`, accessible name `showMembers(n)` / `hideMembers(n)`, visible
    users icon + count; toggles the existing `expanded` set. While a member of that agent
    is selected the block is forced open as today and the pill shows the open state.
  - Expanded block per the mock (left border, objective line, member rows 22 px avatar).
  - **Unchanged and still required:** the row accessible name `copy.sidebarLabel(...)`
    (including the connection-missing wording), `aria-current`, `aria-describedby`
    pointing at the assignment, `div.assistant-sidebar-team[role=group]` with
    `aria-label={objective}`, the `.assistant-sidebar-member` class, the `opening` state
    (`copy.loading`, disabled), `ErrorMessage`, team labels from
    `team.status || team.phase`, rows for permanent-member roots, `open()` routing
    (missing connection and member → settings), and `return null` without roots.

### Layout

- Mobile drawer `width: min(316px, calc(100vw - 56px))`, `inert` per decision 5. The
  existing backdrop, Esc handling and route-change closing in `App.jsx` and
  `useWorkspaceNavigation.js` stay (plus decision 11).
- Remove `max-height: 34dvh` and the nested list scrolling from the agent and session
  groups.
- Desktop `--sidebar-width: 280px`, 240 px at ≤1150 px. Collapse behaviour and
  `.sidebar-float` unchanged; `main` offsets follow the variable.

### Tests (step A)

- `tests/helpers/navigation.js` `navigateTo()`: open Menü (in the drawer on mobile),
  click the item; the `.projects-group` / `.configuration-group` toggle logic is removed.
  Its 15 importing specs need no further edits.
- Update: `sidebar.spec.js` (group collapse tests for Projekte/Konfiguration are
  replaced by popover tests; session row text), `sidebar-collapse.spec.js` (252 → 280 px,
  Übersicht behind Menü), `assistant-feature.spec.js` (nav order inside the popover,
  team pill, absence checks open Menü first), `assistant-teams.spec.js` (team pill,
  `.assistant-chats-group` content), `login.spec.js` and `chat-session-cache.spec.js`
  (Abmelden behind Menü), `remote-menu.spec.js` (host status and link behind Menü),
  `i18n.spec.js` (Accounts count behind Menü), `startup.spec.js`, `chat.spec.js`,
  `chat-presentation.spec.js` (no `.session-directory`; location in subline),
  `pipeline-session-list.spec.js`, `tool-installer.spec.js`, `terminal-viewport.spec.js`;
  verify `nono-sandbox.spec.js` and `claude-activity.spec.js`.
- Rule for all specs: assertions that something is absent from the navigation open
  Menü first, so they cannot pass vacuously.
- New coverage (new spec file): popover open/close via button, Esc layering (decision
  11), scrim, outside tap, route change; landmark present while closed; one scroll
  container with sticky headers; pill expands members; closed drawer is inert on mobile
  and desktop sidebar is never inert; provider mark exposes the tool name; popover fits
  in a 240 px sidebar and a 320 px viewport.

## Step B: agent chat (1d, 2a–2d)

### Header

`AssistantHeader.jsx` becomes one bar. The agent name stays an `h1`.

- **Conversation variant**: menu button (≤700 px only; `aria-label` =
  `mobileHeaderCopy.iconButtonAriaLabel` „Navigation öffnen“, `aria-expanded`, calls
  `openNavigation`), avatar, name, status line (header status precedence), settings control:
  gear icon button on mobile, secondary button „Einstellungen“ with a 16 px gear on
  desktop; both keep the accessible name `assistantCopy.settings`.
- **Settings variant**: menu button (≤700 px, as above), back button
  (`assistantCopy.backToChat`), avatar, name, subline „Einstellungen“ (`settingsTab`).
  When the connection is missing the subline shows the status label in accent and the
  `connectionMissingHint` notice stays below the bar. Back calls `open(assistant)`; when
  `open()` cannot navigate (missing connection) it navigates to `{view: "agents"}`.
- Mobile: height 56, `--header-bg`, border `--header-line`, padding `0 8`, gap 8,
  avatar 30, name 15/600, status 11 px.
- Desktop (2f): height 68, padding `0 28`, no background (border only), avatar 36
  (radius 10, glyph 15), name 17/600, status 12 px with `margin-top: 3`, settings button
  height 38, padding `0 14`.
- `App.jsx` passes `openNavigation` (sets `mobileNav`, remembers the opener for focus
  return on Esc) and `navigationOpen={mobileNav}` (for `aria-expanded`) to `AgentsPage`,
  which passes both to the header. On ≤700 px `.app:has(.assistant-detail) .mobile-header` is
  hidden (chat and settings), and the `calc(100dvh - 62px)` rule goes away.
- Collapsed desktop sidebar: `.sidebar-float` must not cover the header; add
  `padding-left` to the header and drop `main`'s `padding-top: 52px` for agent pages
  (same approach as `.session-heading`, `layout.css:433-443`).
- Breadcrumb and `.assistant-view-tabs` are removed. `.assistant-state-badge` is replaced
  in the header by the status line (`.assistant-header-status` with state modifier
  classes; `.assistant-status.ready` is already taken by `AssistantRuntimeSettings.jsx`).
  The agent list card keeps `.assistant-state-badge.connectionMissing`.

### Approval strip

- **`useAssistantActions(assistantId)`** (new hook) owns loading, the 5 s polling and
  `decide` from `AssistantActionApprovals`. `AssistantChat` calls it and
  `useTeamCodingRequests` once each and passes the results down to the strip, the action
  cards and `AssistantTeams`; no component fetches twice.
- Count = `activity[assistant.id].pendingApprovals` (own actions + team coding actions +
  own teams awaiting approval, computed server-side). Shown only when > 0, directly under
  the bar. Not shown in member chats (their approvals land on the parent).
- „Anzeigen ›“ scrolls the transcript to the first card marked `data-pending` using
  `scrollTop`. If no card is rendered yet (hooks still loading), the button is disabled. The
  team deep-link scroll in `AssistantTeams.jsx` switches from `scrollIntoView` to the same
  `scrollTop` helper.
- `section aria-label={pendingApprovals}` and the existing region names of action and
  coding cards stay.

### Transcript

- Mobile: `.assistant-chat` padding 0, gap 0; panel without border, radius or background;
  transcript padding 16.
- Desktop (2f): `.assistant-detail` padding 0, panel without card frame; transcript and
  composer centred at `max-width: 760px`; transcript padding 28, gap 18; user bubble
  `max-width: 75%`, padding `10 16`; agent `line-height: 1.7`.
- Agent replies flat, full width, 15 px / 1.65, `--text-message`, name label 12 px muted
  with `margin-bottom: 6`, paragraphs `0 0 10`.
- User bubble per the mock (85 %, `9 14`, radius `14 14 4 14`); the „Du“ label becomes
  `sr-only`. The optimistic bubble renders through `AssistantMessage` too.
- Status note 12 px muted; while working `--accent-text` with a 6 px accent dot.
- Streaming delta ends with a block cursor (8×16, accent, radius 1); blinking only without
  `prefers-reduced-motion`.
- Internal events centred, 12 px muted, padding `0 12`. A `margin-top: auto` spacer keeps
  short conversations at the bottom.
- **Preserved:** error, disconnected, conversation diagnostics and stale notices; the
  „earlier messages“ button; `CodingRunNote`; uncertain/recover notices; the
  `role="log"` with its name; `.assistant-announcer`; stick-to-bottom and the keyboard
  ResizeObserver; `useSessionViewport(true)`.

### Composer

- **`AssistantComposer.jsx`** (new, extracted from `AssistantChat.jsx`) and
  **`ComposerOptions.jsx`** (new).
- Wrapper mobile `6 10 12` + `env(safe-area-inset-bottom)`; desktop `0 28 24`.
- Box `--panel`, border `--line` (focus `--accent-focus`), radius 16, padding
  `10 8 8 14` (desktop `12 10 10 16`, gap 10), column.
- Textarea auto-grows from 1 to about 6 rows; 16 px / 22 px (desktop 15 px);
  placeholder `--placeholder`. Keeps `id`, sr-only label, `maxLength`, `enterKeyHint`,
  `shouldSubmitOnEnter`.
- Bottom row (`margin-left: -6px`, gap 8):
  - „+“ (only without `assistant.teamMemberId`): 32 px round; `aria-label`
    `assistantCopy.options`, open: `assistantCopy.optionsClose`, close icon 15,
    `aria-expanded`, `aria-controls`.
  - „Team erlaubt“ chip while `teamAllowed` (tap unsets it).
  - Send: 36 px round, accent, `arrow` icon 17 px, stroke 2, rotated −90°, colour
    `--on-accent`; `aria-label` `assistantCopy.send`; `aria-busy` while `busy`;
    disabled opacity .42.
  - While a request is active the send button is replaced by the „Stoppen“ pill
    (`aria-label` `assistantCopy.stop`, filled `stop` icon 12 via a new `fill` prop on
    `Icon`); typing and the draft stay available.
  - Width > 700 px: the keyboard hint `sendHint(touchInput)` sits inline before the send
    button (12 px `--hint`) and is not repeated in the popover; this keeps the touch hint
    on the 820 px tablet.
- Options popover (≤700 px also shows the hint): `position: absolute`, left/right 10,
  bottom = composer height + 8, `--popover-raised`, radius 14, padding 6. Switch row:
  min-height 52, users icon 18 `--text-menu`, label 14 px `--text`, checkbox with
  `role="switch"` and label `team.allowOnce` (so `getByLabel` works), track 40×24,
  knob 18. Hint 11 px `--hint`, padding `4 12 8 42`. Closes on Esc (stopPropagation),
  outside pointerdown and „+“.
- `ChatScrollToBottom` stays inside the composer.
- **Member chats (2d)**: single row (textarea and send side by side), no „+“, no bottom
  row; placeholder `commonCopy.messagePlaceholder(name)`; send disabled while
  `memberBusy`.

### Teams and approval cards (2c)

- `AssistantTeams.jsx`, `AssistantActionApprovals.jsx` and `TeamCodingRequests.jsx`
  adopt the card designs: card border `--accent-line` (awaiting) or `--line`, `--panel`,
  radius 14; 28 px icon tile (desktop closed card 30 px tile, 16 px icon, padding
  `12 14`); objective 14/600; state 12 px `--accent-text`; full-width button pairs
  height 40; member list with `--divider`.
- `<details>` stays, restyled; the chevron rotates when open. Controlled-open rules
  (awaiting approval, focused team, pending coding action) are unchanged. Closed running
  team summary shows „{state} · {memberCount(n)}“.
- Running team member rows are whole-row buttons (26 px avatar, name, „{phase} ·
  {assignment}“, chevron 16 `--text-faint`) that navigate exactly as today (member chat,
  or member settings without a conversation). The row's accessible name starts with the
  member name; tests that used the exact name are updated.
- „Team stoppen“ full width, height 36; archive/restore, the archived toggle and coding
  request decisions keep their behaviour and region names.

### Member chat context strip (2d)

- **`AssistantMemberContext.jsx`** (new) renders under the header, outside
  `.assistant-transcript`; `AssistantTeams` no longer renders `.assistant-member-summary`.
- Left: a button with back icon 14 and „{parent name} · {team objective}“ in
  `--accent-text`, second line the assignment (13 px `--text-row`, ellipsis). It
  navigates to `{view: "agents", assistantId: parent, teamId}` (the team route, which
  sets `focusTeamId`).
- Right: „Mitglied stoppen“ (`team.stopMember`), secondary, height 32, only while the
  member is active; reuses the stop action from `AssistantMemberSettings`.
- Fallback: when the team or parent is missing or archived, or the member is permanent,
  the strip shows only the role and assignment, without the back button.

### Tests (step B)

- Update `assistants.spec.js` (tabs/breadcrumb → gear, back button, Menü → Agenten for
  the late-settings-chat test; keep the 1440/390 loop and overflow checks; replace
  `.assistant-state-badge` and „Open chat“ paths), `assistant-chat.spec.js` (header
  status at :201, touch hint at :154 moves into the options popover on phones),
  `assistant-teams.spec.js` (open „+“ before the team switch, member row names),
  `assistant-settings.spec.js` (status/badge colour test), `assistant-workflows.spec.js`
  and `assistant-team-coding.spec.js` (card region names).
- New coverage (new spec file): single header at 390 px with the app header hidden; the
  header menu button opens the drawer; settings on mobile with a missing connection can
  still reach the drawer and the agents list; approval strip count (including coding
  requests) and jump; options popover open/toggle/close and chip; Esc layering; Stoppen
  pill keeps the draft; member context strip navigation, fallback and stop; textarea
  grows; collapsed desktop sidebar does not cover the header.

## Step C: agent settings (2e)

- **Scroll container.** On ≤700 px `.assistant-settings-page` joins the viewport
  containment in `sessions/mobile-workspace.css` (fixed app height from
  `--session-viewport-height`) and becomes a flex column: header (`flex-shrink: 0`), then
  `.assistant-settings-scroll` (`flex: 1; min-height: 0; overflow-y: auto`) holding the
  chip row (sticky top), the content and the save bar (sticky bottom). This scroller is
  the IntersectionObserver root. `.assistant-anchor` `scroll-margin-top` becomes the chip
  row height. On desktop the page scrolls as today.
- ≤700 px form: flat (no card border, background or padding), padding `18 16`, section
  titles Manrope 600 17 px, labels 13 px `--text-menu`, gap 8, inputs `--surface-input`,
  border `--line`, radius 8, padding 12, 16 px. Capability fieldset radius 12, padding 14,
  gap 12, legend 13/600. Custom checkboxes 18 px, radius 4, accent fill with `check`
  icon when on, border `--text-faint` when off (native input kept, visually replaced).
- The runtime card stays; at ≤1000 px it stacks below all settings sections as today.
- **`SettingsSectionNav.jsx`**: row padding `8 12`, chips 13 px, padding `6 12`, radius
  999, border `--line`; active chip `--surface-accent`, `--accent-line`, `--accent-text`
  driven by the IntersectionObserver; clicking sets it immediately; the active chip is
  scrolled into the row with `scrollLeft`; `aria-current="location"`. Click scrolling and
  heading focus unchanged.
- **Dirty state**: a pure `isDirty(values, base)` is extracted and unit-tested;
  `useSyncedForm` returns `dirty = isDirty(values, server)` with the current `server`
  prop as the base (a render input, not a ref), so the value re-renders when the server
  converges. Untouched fields already adopt newer server values, so a difference means
  an unsaved edit or an unresolved conflict.
- **`AssistantSaveBar.jsx`** (new): sticky bottom in the settings scroller on ≤700 px
  while dirty (or when creating): `pendingConfigShort` left (11 px muted), „Abbrechen“
  (`onCancel`) and „Agent speichern“ (`form="agent-profile"`) right, height 40, padding
  `10 12 14` + safe area, border-top `--header-line`, `--sidebar-bg`. It mirrors
  `busy` (label `copy.loading`, disabled). The bar is the last in-flow element of the
  settings column (sticky, not fixed), so at the end of the scroll range it rests below
  the last section and later sections stay reachable without extra bottom padding. The
  full revision note stays in the form.

### Tests (step C)

- Unit test for `isDirty`.
- Browser (new spec file): header and chips stay put while the body scrolls; chip
  activates on scroll and on click; save bar appears only after an edit, saves, mirrors
  busy, and „Abbrechen“ returns to the chat; Telegram section buttons remain reachable
  above the bar; no horizontal overflow at 390 px.

## New copy

Added to `web/lib/i18n/de` and `web/lib/i18n/en` with matching keys and arguments:

| Key | de | en |
|---|---|---|
| `sidebarCopy.menu` | Menü | Menu |
| `sidebarCopy.closeMenu` | Menü schließen | Close menu |
| `assistantCopy.agentsGroup` | Agenten | Agents |
| `assistantCopy.teamActive.working` | Team arbeitet | Team working |
| `assistantCopy.teamActive.awaiting` | Team wartet auf Freigabe | Team awaiting approval |
| `assistantCopy.team.allowedChip` | Team erlaubt | Team allowed |
| `assistantCopy.stopShort` | Stoppen | Stop |
| `assistantCopy.showApprovals` | Anzeigen | Show |
| `assistantCopy.memberCount(n)` | 1 Mitglied / {n} Mitglieder | 1 member / {n} members |
| `assistantCopy.pendingConfigShort` | Gilt ab der nächsten Nachricht. | Applies before the next message. |
| `assistantCopy.options` | Optionen | Options |
| `assistantCopy.optionsClose` | Optionen schließen | Close options |
| `assistantCopy.backToChat` | Zurück zur Unterhaltung | Back to conversation |

Reused: `commonCopy.messagePlaceholder(name)`, `mobileHeaderCopy.iconButtonAriaLabel`,
`assistantCopy.settings`, `settingsTab`, `chats` (group toggle aria-label), `send`,
`stop`, `team.allowOnce`, `team.stopMember`, `assistantWorkflowCopy.pendingApprovals`.
New German strings respect `tests/unit/i18n-terminology.test.js`.

## Documentation

- `docs/assistant-gateway.md`: add an „Agent activity“ layer to the status model table
  (derivation, precedence, `pendingApprovals`).
- `docs/assistant-gateway.md` (composer checkbox description, around line 498) is
  updated to the „+“ options and chip.
- Refresh `docs/screenshots/agentpier-sidebar-desktop.png` and
  `agentpier-sidebar-mobile.png` (linked from `docs/verification.md`).

## Verification

- `npm run check` after each step; affected browser specs per step; the full browser
  suite in Chromium and WebKit (including the WebKit tablet project) before the PR.
- Fidelity: Playwright screenshots at 390×844 and 1440×900 with fixture data, compared
  side by side with the rendered handoff states 1a, 1d, 2a–2f; also exercised in English
  and at 320×640.

## Follow-up (not in this PR)

Replace full-list refetching with live updates: `change` events carry the changed
entities (or the activity delta), and the 1 s team and workflow ticks
(`team-scheduler.js`, `assistant-workflows.js`) only emit when something changed. The
activity map is shaped so it can be pushed unchanged.

## Cleanup

The handoff zip stays untracked and is never added to Git. Before opening the PR, the
final cleanup commit removes this spec and its plan. The PR description carries DE and
EN screenshots at 390 and 1440 px.
