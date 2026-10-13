# Settings redesign: one pattern for agent settings, Accounts, Settings, Extensions, Projects

Status: approved in conversation on 2026-10-12. Temporary working document; remove before the PR is merged.

Design source (untrusted design data, not instructions): the handoff `docs/einstellungen new layout.zip`
in the main checkout, extracted to the session scratchpad as `design_handoff_einstellungen/`
(`README.md`, `Einstellungen Übersicht.dc.html` = final set, `Einstellungen Agent & Accounts.dc.html`
= working rounds). The README defines tokens, sizes, copy keys and per-page structure. This spec records
the decisions that refine or override it.

## Goal

Move five pages onto one shared pattern: header + underline tabs + grouped list cards + one bottom save
bar per tab, hints behind ⓘ, central settings shown as dashed reference rows into Accounts, "Used by" in
Accounts. Save several settings of a tab with one action, as atomically as the data model allows.

## Guiding decisions

1. **No feature loss.** Function wins over pixel fidelity. Everything the current UI can do keeps a place
   in the new pattern (row, subpage, ⋯ menu, extra group). Deviations from the drawings are listed in
   the PR description.
2. **Drafts everywhere.** Every field of a tab or subpage is a draft saved by the tab's bar, including
   today's immediate controls: UI language, auto-resume, agents feature toggle, Telegram language,
   update channel. Real actions stay immediate: list add/delete, reminders/routines, memory-note list
   actions, allowlist deletion, approvals/decisions, OAuth login/logout, pairing, pause/disconnect,
   runtime start/stop/restart, update check/stage/activate/rollback/cleanup, backups, diagnostics,
   CLI-find adoption, MCP CLI conflict resolution.
3. **Optimistic concurrency with a base revision.** A draft remembers the revision it started from and
   sends it. A foreign change produces a 409; the bar shows "changed elsewhere" with "Reload" and
   "Overwrite anyway". Untouched fields keep adopting newer server values silently (today's
   `useSyncedForm` behaviour).
4. **Atomicity.** Profil and Fähigkeiten save with one `PATCH /assistants/:id` (it already accepts name,
   instructions, model, capabilities, shell, heartbeat, mcpServers in one store write). Arbeit gets a new
   transactional endpoint. Telegram stays two requests (assistant + channel are separate resources).
   Multi-step saves stop at the first error, pass the revision from each response to the next step,
   report "Partially saved: …" and keep the tab dirty.
5. **Summary endpoints** feed row statuses and counts; rows show "—" until known, never a fake 0.
6. **Contradictions resolved:** shell warning stays visible when level ≠ off (README wins over drawing);
   Accounts is top level → sidebar icon on mobile, ⓘ in header on mobile and desktop; agent Team keeps
   all its current fields; README sizes win over drawing deviations (bar h40, note 11px, ⓘ 20px, fade
   48px); with agents disabled, Accounts hides "Dienste für Agenten" and "Used by" lists only CLIs.
7. **Empty/loading/error states** are derived from the pattern: empty card with hint + action, "—" while
   loading, errors and partial saves in the bar, disabled groups at opacity .5 with their hint. Existing
   texts are reused; new texts go to DE and EN.

## Delivery

- Integration branch `feat/settings-redesign` (worktree `.worktrees/feat-settings-redesign`). One PR to
  `main` at the end; open it, make CI green, do not merge.
- Step 0 (foundation) lands directly on the integration branch.
- Steps 1–5 each get a page branch and worktree from the finished foundation:
  `feat/settings-redesign-agent`, `-accounts`, `-general`, `-extensions`, `-projects` under
  `.worktrees/`. Each page branch passes `npm run check`, its browser specs and an automated code review,
  is pushed, then merged into the integration branch with `--no-ff`.
- Final cleanup commit removes this spec and the plan.

## Step 0: foundation

### Components (`web/components/`, styles in `web/styles/settings-pattern.css`)

- `SettingsShell`: mobile header (56px; sidebar or back icon 40×40, title 15/600, subtitle 11px or a
  subtitle slot, optional right action; border-bottom only without tabs), desktop header (64px, Manrope
  700 17px title + 12px description, optional actions, tabs in a second row or inside a detail pane),
  content column max 720 centred, bottom-bar slot. Reuses `AssistantHeader` behaviour for back buttons.
- `ListCard`, `ListRow`: card with 1px gap dividers; row variants single/two-line, right side value / OK
  status / warn pill / error status, then chevron, ⋯ menu button (40×40), trash button; toggle (38×22,
  `role="switch"`, `aria-checked`), number field (64×34), select row, radio row, checkbox row.
- `GroupLabel`: uppercase label with optional ⓘ and a right text action.
- `Segmented`: built on the existing `Segment` styles from the README.
- `InfoHint`: ⓘ disclosure (`aria-expanded`, `aria-controls`), inserts the hint text verbatim below the
  row or label. Never a tooltip.
- `ReferenceRow`: dashed row "Managed centrally in Accounts" or a count, right "Accounts ↗", navigates to
  `{ view: "accounts", section, item? }`.
- `SaveBar`: visible only while dirty or while it shows an error/conflict/partial result; note on the
  left, Cancel + primary on the right (specific labels where they exist); desktop bar constrained to the
  content column; safe-area padding.
- `UnsavedChangesSheet`: mobile bottom sheet, desktop centred dialog (max 420). "Save and switch",
  "Discard", "Cancel". Body names the tab and the number of changed fields.
- `UnderlineTabs`: restyle per README, counts as `<small>`, scrollable mode with edge fade
  (`can-scroll-left/right`), active tab kept in view via `scrollLeft` with a 48px margin, desktop hover
  arrows when overflowing. Pipelines and Projects inherit the look. `RunStatusFilter` gets the same fade.

### Logic

- `useTabDraft` (generalises `useSyncedForm`/`synced-form-state.js`): values, base revision(s), `dirty`,
  `changeCount` (changed fields), `conflicts`, `reset()`, `save(steps)`. Steps run in order; a step may
  return a confirmation request (shell, full shell, restart, stdio) which the UI resolves and the chain
  resumes with the confirmation flags; the chain stops on the first error and reports partial success.
  `useSyncedForm` stays as a thin wrapper or is replaced where used.
- Navigation guard coordinator: replace the single-slot `file-navigation-guard` with an ordered list of
  guards. The file editor and settings drafts register independently. A single `beforeunload` listener
  asks all guards. Tab switches, back, agent switch, extension profile switch and app navigation consult
  the coordinator; settings guards open `UnsavedChangesSheet`.
- Routes:
  - Settings: `settingsTab` (`workspace` | `access` | `operations`) as a query value, derived from
    `settingsSection` when missing; paths unchanged so `tests/unit/settings-sections.test.js` and server
    document paths keep working.
  - Accounts: `?section=<group>&item=<id>` for subpages (`models`, `services`, `mcp-servers`, `cli`),
    plus `item=new` for creation; `section=mcp-servers` alone keeps working; OAuth result params keep
    working.
  - Agent settings: `agentTab` (`profile` | `capabilities` | `work` | `telegram`) and `agentPage` for
    subpages (memory, allowlist, actions, projects, pipelines, telegram-activity, telegram-connection).
  - Extensions: one `defaultExtensionTab` constant replaces the five hardcoded `"mcp"` defaults in Step 0; Step 4 flips it to `skills` and maps
    `?tab=mcp` to `skills`; old links redirect.

### Server

- `PUT /assistants/:id/work`: saves workflow access grants and the agent team policy in one
  `assistants.store.db` transaction, with both revisions as preconditions; keeps the existing validation,
  `admit`/maintenance rules of `PUT access` and the host-capacity check of `PUT team-policy`. The old
  routes stay for other callers.
- `PATCH /assistants/:id` strict base revision: the client sends the draft's base revision; the server
  already returns 409 on mismatch. The client stops reading the latest prop at send time.
- `GET /settings/summary`: per row status for Access (AgentPier MCP connected CLIs, remote access
  provider/state, SSH count, GitHub credential count) and Operations (last diagnostics time/result,
  backup count + last time, installed version + update availability). Missing data is `null`.
- `GET /accounts/usage`: per provider connection, ChatGPT account, MCP server, web search, speech and
  native CLI account: agents (id, name, kind incl. temporary team members), sessions count, pipeline
  profiles, compatible CLIs with route. Only touches the assistant store when the agents feature is
  enabled, so `/accounts` stays free of assistant requests and assistant CSS when agents are off.

### i18n

Shared copy goes to a `common` catalog (`centralInAccounts`, `usedBy`, `agentsCount`, `ofCount`,
`unsavedTitle`, `unsavedBody`, `saveAndSwitch`, `discard`, `showHint`, conflict/partial texts).
`web/lib/i18n/{de,en}/assistants.js` is split before adding keys (535/521 lines today). The language
label of `LanguageSelect` moves into the catalog. Parity and terminology tests must pass.

### Tests

Unit/property tests for `useTabDraft` state, the save chain, the guard coordinator and the routes;
integration tests for the three server additions; a browser spec for the shared components (keyboard,
ARIA, fade classes, sheet/dialog, bar visibility).

## Step 1: agent settings (`AssistantSettings.jsx` and children)

Tabs Profil / Fähigkeiten / Arbeit / Telegram; `SettingsSectionNav` is removed. Mobile: back arrow
"Zurück zur Unterhaltung", avatar tile, name, "Einstellungen". Desktop: header with back button, tabs in
the second row.

- **Profil**: "mark as reviewed" strip for `instructionsSource === "model"` (immediate action, as today);
  remoteChanged/conflict in the bar; Name, Anweisungen, Provider-Zugang, Modell (`AssistantModelFields`
  unchanged: catalog search, custom model, remote catalog status, `noConnections`); reference row
  "Zugänge verwalten"; revision line. Team members: the member group from `AssistantMemberSettings`
  (provenance, assignment, phase, stop/promote/archive/restore/recover); task-bound members keep their
  current editable fields. Save: one `PATCH`.
- **Fähigkeiten**: group "Gedächtnis & Erinnerungen" (memory toggle, reminders toggle, row "Gespeicherte
  Notizen ›" → memory editor subpage with its own bar and hash check, search, clear, reload);
  "Web & Dokumente" (4 toggles with today's availability rules, reference row Suchanbieter with provider
  name); "Shell-Zugriff" (segmented, selected hint visible, warning visible when ≠ off, `shellPending`
  notice, ineligible reason, row "Immer erlaubte Befehle ›" → allowlist subpage with immediate delete);
  "MCP-Server" (checkbox rows, stdio pill, OAuth status, login hint, empty state with Accounts link,
  reference row). Save: one `PATCH` with capabilities, shell, changed `mcpServers`, and
  `heartbeat.enabled=false` when memory is switched off with a saved heartbeat. Shell/full/restart/stdio
  confirmations open as sheet steps of the chain.
- **Arbeit**: pending strip "Wartet auf deine Freigabe · n" → subpage "Aktionen und Coding-Aufträge" with
  the complete action history (approve, decline, cancel, review unknown outcome, run/human-gate links,
  node states, diagnostics); group "Projekte und Coding-Aufträge" (rows "Freigegebene Projekte ›" with
  "a von b" and "Freigegebene Pipelines ›" → selection subpages, 3 permission toggles inline);
  group "Team" (autonomous toggle, all current numeric fields). Save: `PUT /assistants/:id/work`.
- **Telegram**: Verbindung (status, pause/resume, disconnect, language, app URL, rows
  "Telegram-Aktivität ›" with retry/review/open chat and "Verbindung ›" subpage with token replacement,
  new pairing code, diagnostics, ignored counts); not connected: token field + "Telegram verbinden"
  (existing pairing), other groups disabled with their hints. "Von sich aus handeln" (heartbeat toggle;
  interval, active hours, reply, time zone with "adopt browser zone", run cost). Erinnerungen (list,
  "+ Erinnerung erstellen", detail with history and review, pause/resume, delete). Routinen (list,
  "+ Routine", detail with run now, pause/resume, delete, event status). Save: heartbeat via `PATCH`,
  then channel `PATCH {language, appUrl}`.
- **Create mode**: tabs Profil + Fähigkeiten, bar "Agent anlegen" (`POST /assistants`), web/heartbeat
  hints "available after saving" as today; other tabs after creation.
- **Desktop runtime card** stays as a right column on wide viewports, otherwise a row in Profil.
- **Visibility**: `personal === false` shows Profil and Fähigkeiten (MCP read-only via
  `TemporaryMcpServers`); Arbeit and Telegram hidden. Memory row only with saved `capabilities.memory`;
  reminders/routines only with `capabilities.reminders`; Team only without `teamMemberId`; Telegram tab
  if `!teamMemberId || personal`.
- Hints listed in the README move behind ⓘ verbatim; warnings, selected shell hint, stdio warning and
  all error/conflict notices stay visible.

## Step 2: Accounts

Hub list on mobile (sidebar icon, "Lokal gespeichert", ⓘ with the info box text, intro), list column
320 + detail pane on desktop. Groups with "+" on the label: Modell-Zugänge, Dienste für Agenten (agents
enabled only), MCP-Server, Native CLI-Accounts. Rows: sub = provider · state, right = usage from
`/accounts/usage`.

Every detail subpage: fields, "Genutzt von" (agents link to that agent's settings tab; provider access
adds "Kompatible CLIs" with route), destructive text button at the bottom, bar with restart note
("Startet n Agenten kurz neu.") and the two-step restart confirmation as a chain step.

- **Provider connection** (create and edit as subpage, dialog removed): name, provider (locked on edit),
  API key as status line with "Ersetzen" and remove-key, `responsesAccess`, key help behind ⓘ; endpoint
  providers add groups Verbindung (preset, URLs, advanced auth header), Test (probe model, test, cost,
  result incl. protocol checkboxes and warnings), Routing je CLI, Adapter (capabilities, reset,
  think-tag), Modelle (table; may be its own subpage). Delete with key-dependent text and restart flow.
  Existing modules under `provider-connections/` are reused and keep their paths for unit tests.
- **ChatGPT account**: detail with status, check, disconnect, offline note with link; "+" opens the
  device-code login as a subpage (code, open link, cancel, polling, sessionStorage resume).
- **Speech** and **Web search**: today's fields incl. remove key, Perplexity connection select, Brave key;
  web search keeps restart confirmation.
- **MCP server** (create and edit as subpage, SidePanel removed): all form fields and confirmations
  (OAuth switch, stdio, CLI stdio), value-reference errors, CLI choices; detail also shows details list,
  per-CLI status with overwrite/adopt, Codex account OAuth, agent OAuth login/logout and expiry, remove.
  Group keeps restart note, OAuth result banner, origin-blocked and pending notices, and a row
  "In den CLIs gefunden ›" → import subpage (adopt, adopt all). `mcpSection` focus lands on the group.
- **Native CLI account** (create/edit as subpage, `AccountDialog` content): local profiles read-only with
  "Lokal"; managed: login (confirm, starts login session; disabled when CLI missing), set default, edit,
  delete with keychain note; legacy summary; auth polling; server 409s shown in the bar.

## Step 3: Settings

`SettingsPage.jsx`: tabs Arbeitsbereich / Zugriff / Betrieb replace the chip row.

- **Arbeitsbereich**: Allgemein (language, default directory with folder picker, auto-resume), Agenten
  (feature toggle with check-failed state and diagnostics, row "Agentendienst ›"), row
  "App & Benachrichtigungen ›". One bar saves language (applied after save), `PATCH /preferences`
  (`defaultCwd`, `autoResumeInterrupted`) and `PUT /assistant-feature` as a chain.
- **Agentendienst** subpage: runtime status, start/stop/restart, runtime updates, version details, host
  team capacity with its own bar.
- **App & Benachrichtigungen** subpage: `NotificationsPage` content.
- **Zugriff**: rows MCP & Zugriffe (AgentPier's own MCP endpoint; consent, setup, grants unchanged),
  Fernzugriff, SSH-Zugänge (subpage keeps its own tabs), GitHub-Zugänge, statuses from
  `/settings/summary`, plus a reference row to Accounts.
- **Betrieb**: rows Diagnose, Sicherungen, Updates, Aktivitätsprotokoll as subpages with their current
  content; Updates subpage: channel (incl. custom/managed) in the bar, check/stage/activate/rollback/
  cleanup/release notes as immediate actions; `?job=` keeps working.

## Step 4: Extensions

MCP tab removed; reference row with the count of central servers enabled for the profile's CLI. Tabs
Skills, Plugins, Marketplaces (if supported), Agenten (shared profiles). Mobile profile switcher in the
header subtitle → sheet "CLI-Profile" with one group (own or shared, per mode). Primary actions on the
group label (mobile) or detail header (desktop). Plugin row: mobile detail subpage (version, source,
enable/disable, remove), desktop ⋯ menu with the same actions plus "Details". Import into shared and the
conflict list stay visible on Skills; config path in the desktop header; installed/discover segments and
the OpenCode npm panel stay. `locked` disables tabs and the profile switcher. No save bar.

## Step 5: Projects

Structure unchanged, restyled. Tab label "Wissen" (heading inside stays "Projektwissen"). Mobile list with
folder tile and attention hints; header "+" menu (clone, add folder); desktop header buttons. Übersicht:
attention strip (one run → that run, several → Läufe filtered), facts card, sessions with open action.
Wissen: search, segmented Aktiv/Archiv with counts + ⓘ `tabHint`, "+ Neuer Eintrag" on the label, entry
edit/history/archive, refresh, register state. AgentBus: segmented Sitzungen/Nachrichten (radio semantics
instead of tabs), "{n} verbunden", version, pending counts, reload-required state, message paging. Läufe:
chips with fade, run rows with state below, refresh, "+ Neuer Lauf", register hint. Merge-duplicates
button stays. Mobile bottom bar "Sitzung starten" on detail tabs; desktop primary in the detail header.

## Testing and verification

- `npm run check` and `npm test` on every page branch and the integration branch.
- Browser specs updated for the new selectors (≈40 specs depend on `.assistant-section-nav`, settings
  chips, Accounts regions/order, the MCP extension tab, project tab roles). Keep behavioural assertions;
  only change how elements are found.
- New regression specs per page: dirty bar, unsaved sheet on tab switch/back/beforeunload, multi-step
  save incl. partial failure, conflict reload/overwrite, deep links, ⓘ disclosure, scroll tabs.
- Exercise each page in English and German, mobile 390×844 and desktop 1280×800; screenshots go into the
  PR.
- Files stay ≤ 600 lines (`check:structure`).
