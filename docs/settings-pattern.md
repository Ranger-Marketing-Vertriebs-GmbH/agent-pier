# Settings pattern

Agent settings, the agents hub, Connections (Zugänge), CLIs and extensions, Settings
and Projects share one pattern: a header with underline tabs, grouped list cards, one
bottom save bar per tab or subpage, hints behind ⓘ, central settings as dashed
reference rows into Connections, and "Used by" lists in Connections. This guide names the building blocks and their contracts.
It is part of the [UI guide](ui-guide.md), which holds the design tokens, the full
component catalogue and the rules for every screen.

## Components (`web/components/`, styles in `web/styles/settings-pattern.css`)

| Component                                                        | Use                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SettingsShell`                                                  | Page frame: mobile header 56px (sidebar `leading="menu"` on top-level pages, `leading="back"` on detail pages and subpages), desktop header 64px with description and actions, `tabs` row, content column max 720px, `bar` slot.                                |
| `UnderlineTabs`                                                  | Tabs; fill the row on phones, scroll with a 48px edge fade (`can-scroll-left/right`) when they do not fit, keep the active tab in view via `scrollLeft`, hover arrows on desktop. Counts render as `<small>`.                                                   |
| `GroupLabel`                                                     | Uppercase group label with optional ⓘ hint and a right text action ("+ …").                                                                                                                                                                                     |
| `ListCard`                                                       | Card of rows (1px gap dividers); `disabled` dims a group that does not apply yet.                                                                                                                                                                               |
| `ListRow`                                                        | Row with `label`/`sub`, right side `value` (use `unknownValue` "—" until known), `status` (`ok`/`warn`/`error`), chevron when it navigates (`onClick`/`href`; give `href` an `onClick` so the click stays in-app), ⋯ `menu`, trash `onDelete`, optional `hint`. |
| `ToggleRow`, `NumberRow`, `SelectRow`, `RadioRow`, `CheckboxRow` | Control rows (switch 38×22 as `<input type="checkbox" role="switch">`, number 64×34, native select, radio, checkbox with optional pill such as "stdio").                                                                                                        |
| `Segmented`                                                      | Segmented choice (shell level, Active/Archive, Sessions/Messages).                                                                                                                                                                                              |
| `InfoHint` (`useInfoHint`, `InfoHintButton`, `InfoHintText`)     | ⓘ disclosure: `aria-expanded` + `aria-controls`, inserts the hint text verbatim below the row or label. Never a tooltip.                                                                                                                                        |
| `ReferenceRow`                                                   | Dashed row "Managed centrally in Connections" (or a count) linking to `{ view: "connections", section, item }`: a link with `href` (`onOpen` keeps it in-app), a button without.                                                                                |
| `SaveBar`                                                        | Visible while the draft is dirty, saving, or reports an error, conflict or partial save. Cancel + primary (specific label where one exists); in a conflict "Reload" + "Overwrite anyway". Optional `note` such as a restart notice.                             |
| `Sheet`                                                          | Bottom sheet on phones, centred dialog (max 420px) on desktop; used for chain confirmations.                                                                                                                                                                    |
| `UnsavedChangesSheet`                                            | "Save changes?" with "Save and switch", "Discard", "Cancel"; body names the tab and the number of changed fields.                                                                                                                                               |

`SaveBar` also takes `saveDisabled` (keeps the primary disabled while the form is not
savable, e.g. a required key re-entry) and `saveFocusKey` (sets `data-focus-key` on the
primary so an inline confirmation can return focus to it). `ListRow` takes `current` to
mark the entry open in a detail pane (`aria-current="page"`); pass a token such as
`"true"` for a selection that is not a page.

On phones the end of a scrolled page clears the iPhone home indicator: the scroller's
bottom padding and the save bar add `var(--safe-area-inset-bottom)` (from
`env(safe-area-inset-bottom)`, overridable in browser tests). While a save bar is shown
it carries that inset, the scroller drops its own, and the last card keeps a gap above
the bar (`tests/browser/settings-bottom-spacing.spec.js`).

Text-entry controls (inputs other than checkbox, radio, range, color and file, selects,
textareas and `contenteditable`) are at least 16px on phones and touch screens, because
iOS Safari zooms into a smaller focused field. One rule in `web/styles/base.css` sets
them to 16px there and overrides feature sizes, so feature styles need no per-form
override; desktop keeps its compact sizes. Never disable zoom in the viewport meta.
`tests/browser/touch-input-size-views.spec.js` and `touch-input-size-forms.spec.js`
walk the views and forms at 390px and fail on any visible smaller control.

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
  // Only for tabs whose record is not pushed into `server` on a foreign change.
  refresh: async () => {
    const fresh = await loadAssistant(assistant.id);
    setAssistant(fresh);
    return {
      server: { name: fresh.name, instructions: fresh.instructions },
      revisions: { assistant: fresh.revision },
    };
  },
});
const steps = [
  assistantPatchStep({
    assistantId: assistant.id,
    label: assistantCopy.sections.profile,
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

- **Values and base.** `server` is the flat field object of the tab (`{}` or nothing
  while it loads). Untouched fields adopt newer server values silently; a field edited
  here and changed elsewhere is listed in `draft.conflicts`.
- **Base revisions.** `revisions` maps each resource the tab writes to its latest
  revision. While the draft is clean the base follows it; from the first edit it is
  frozen and sent with the save, so a foreign change returns 409 and the bar offers
  "Reload" (`draft.reload()`) or "Overwrite anyway" (`draft.overwrite(steps)`, which
  adopts the latest revisions and saves again). Only an exact `<area>.conflict` key
  counts as such a conflict.
- **Refresh.** A tab whose record is not pushed into `server` when it changes elsewhere
  passes `refresh: () => Promise<{ server?, revisions? }>`. The draft calls it when a
  save ends in a conflict, and `reload()`/`overwrite()` await it and use the record and
  revisions it _returns_ (props change only on the next render). Without `refresh`
  they use the latest props.
- **One save at a time.** `save()` while a save runs returns that save's result, so
  "Save and switch" waits for a running bar save instead of failing.
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
  without an error. A step may map its own errors with `confirmation(error)`: the
  dreaming step (`dreamingStep`) maps `ASSISTANT_DREAMING_MEMORY_CONFIRMATION_REQUIRED`
  to `kind: "dreamingMemory"` (flag `confirmMemory`, `data.agents` lists the permanent
  agents whose memory is switched on).
- **Errors.** The chain stops at the first error. `draft.outcome` holds the error, the
  failed step and `partial` (labels of saved steps); the bar shows "Partially saved: …"
  and the tab stays dirty. A confirmation cancelled after an earlier step saved also
  reports "Partially saved: …", without an error.
- **Agent helpers** (`web/features/assistants/assistant-save-steps.js`): `assistantPatchStep` for `PATCH /assistants/:id` (Identity, Capabilities, Skills,
  Automation heartbeat) and `assistantWorkStep` for `PUT /assistants/:id/work` (the
  Access tab saves the `access` half, the Team tab the `team` half; revisions
  `{ access, team }`).

## Unsaved changes and navigation (`web/lib/navigation-guard.js`)

All navigation goes through one coordinator: app routes and browser history
(`useWorkspaceNavigation`), file editor tab closes, settings drafts and Pipelines
editors (`web/features/pipelines/useDraftGuard.jsx`). Guards are
asked in registration order; the first refusal cancels; a newer navigation invalidates
an older one still waiting or queued. One `beforeunload` listener is held while any protector
needs it (`holdUnloadWarning()`).

```js
const sheet = useUnsavedChangesGuard({
  draft,
  tab: tabLabel,
  save: () => draft.save(steps),
  // Stay only on this agent's settings, on this tab (and subpage, if it owns the draft).
  stays: (request) =>
    Boolean(request.next?.agentSettings) &&
    request.next.assistantId === assistant.id &&
    agentSettingsLocation(request.next).tab === tabId,
});
<UnsavedChangesSheet {...sheet} />;
```

Tab switches, back, agent switch and extension profile switch are route changes, so
they reach the guard automatically. A switch that is not a route change calls
`requestNavigation({ reason: "application", next, commit })` itself; **Sign out** asks
the same way (`reason: "logout"`) before it ends the session. Normalisation
(`"normalization"`) and editor tab closes (`"tab-close"`) never prompt.

Closing a sheet or dialog returns focus to the element that opened it. When the sheet
refused a tab switch, focus returns to the tab that stays selected; `UnderlineTabs`
moves focus to a tab only once it is selected.

## Routes

Settings keeps five tabs: **General**, **App and notifications**, **Users**, **Remote
access** and **Operations** ([General tab](screenshots/settings-general-desktop.png)).
General shows a **Features** row (agents on or off, linking to Agents › Runtime) and,
for two releases, a **Moved** group with links to the pages that left Settings.
Operations adds a **Storage** row that opens the system status clean-up.

| Page                | Address                                                                 | Route fields                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Settings            | `/settings?tab=<tab>`, `/settings/<section>`                            | `settingsSection`, `settingsTab` (`general` / `app` / `users` / `remote` / `operations`, derived from the section; `settingsSection: "general"` is the tab root; `tab=workspace` and `tab=access` are old names). `settingsSectionGroups`, `settingsTabOf()` in `web/features/operations/routes.js`.                                                                                                                                                                                                                                                                                   |
| Agents hub          | `/agents?tab=<tab>&section=advanced`                                    | `agentsTab` (`all` / `teams` / `templates` / `runtime`), `agentsSection` (`advanced`, Runtime only); `web/features/assistants/hub-routes.js`. Runtime honours `returnTo`.                                                                                                                                                                                                                                                                                                                                                                                                              |
| Agent settings      | `/agents/:id/settings?tab=<tab>&page=<page>`                            | `agentTab` (`overview` / `identity` / `capabilities` / `access` / `team` / `automation` / `channels`; old names `profile`, `work`, `routines`, `telegram` are mapped), `agentPage` (`memory`, `allowlist`, `skills`, `actions`, `projects`, `pipelines`, `ssh`, `github`, `secrets`, `hook`, `telegram-activity`, `telegram-connection`; a page decides the tab). `agentSettingsTab(route)` names the tab, `agentSettingsLocation(route)` the tab of the current page that shows it. `agentTeam` (`team=<id>`, Team tab only) opens that team in the Teams group (`agentTeamRoute()`). |
| Zugänge             | `/connections?section=<category>&item=<id or new>&step=<step>`          | `section` (`models` / `services` / `mcp-servers` / `ssh` / `secrets` / `github`), `item`, `step` (MCP server wizard and edit steps only, see Wizards); MCP OAuth results keep working. `web/features/connections/routes.js`.                                                                                                                                                                                                                                                                                                                                                           |
| CLIs and extensions | `/coding/clis?tab=<tab>`, `/coding/clis/extensions/:profile?tab=<kind>` | `codingTab` (`install` / `accounts` / `extensions` / `mcp`), `item` (CLI account), `mcpAuthorization`, `mcpCli`, `mcpPage` (`authorization`, `cli`, `page`), `profileId`, `extensionTab` (`skills` / `plugins` / `marketplaces` / `subagents`); `web/features/coding/routes.js`.                                                                                                                                                                                                                                                                                                       |

Moved pages keep their old addresses (`/settings/assistants`, `/settings/ssh`,
`/settings/mcp`, `/accounts`, `/extensions`, `/plugins`, …): `movedRoute()` in
`web/app/route-redirects.js` turns their routes into the new ones, for parsed
addresses and for routes pages still build, with `returnTo` kept. Every area has its
own page: Zugänge (`web/features/connections/ConnectionsPage.jsx`), CLIs and
extensions (`web/features/coding/CodingPage.jsx`) and the agents hub
(`web/features/assistants/hub/AgentsHub.jsx`). `screenRoute()` in
`web/app/route-screens.js` reads an old route as its new place, and draft guards
compare routes through `screenOf()`. The server keeps building old addresses where
they are stored or sent (MCP consent `/settings/mcp?authorization=…`, MCP OAuth results
`/accounts?oauth=…`); the client redirect keeps them working.

The sidebar **Menu** (`web/app/SidebarMenu.jsx`, entries and hints in
`web/app/sidebar-menu-model.js`) lists the areas in the groups Arbeiten/Work and
Einrichten/Set up and marks the current one with `menuArea()`; see the
[UI guide](ui-guide.md#sidebar-menu-and-search).

### Zugänge

Zugänge (`/connections`) lists shared credentials by category: a categories column
with counts and problem counts (`GET /api/connections/problems`), the category's list
and the open entry; on phones categories, list and entry are subpages. Model access
and services keep the Accounts list and detail forms; SSH/SFTP accesses and MCP
servers use the long list (`LongList.jsx`, rules in `long-list.js`): fixed views,
search, filter chips, groups with "Weitere n anzeigen", sorting, selection with bulk
actions and a detail pane; `item=<id>` opens an entry's full view. Every entry shows
"Benutzt von" (`GET /api/connections/usage`, `GET /api/accounts/usage`). Granting and
revoking there writes the agent's own access policy through the endpoints its Access
tab uses (`PUT /api/assistants/:id/work`, MCP servers through `PATCH
/api/assistants/:id`), read right before each write so the revision is current; a
refusal is reported per agent and never retried. Bulk actions call the same per-item
endpoints (SSH tests at most two at once) and list one result per item.

Defaults are left out of addresses; `useWorkspaceNavigation` replaces any address whose
canonical form differs, which is how legacy links redirect.

### Cross-links and the back arrow

A link that leaves the current area (a `ReferenceRow` into Connections, the link to
Agents › Runtime, the Deepgram row on the Channels tab, the Identity tab's "Manage
connections" row, the Access tab's "Open" and set-up links, the CLI extensions' MCP
row) wraps its target with `useCrossLink()` from
`web/app/cross-link.js`. The target gets `returnTo=<origin path>`: the exact page,
tab and subpage the owner came from.

- Connections, CLIs and extensions (Accounts and AgentPier as MCP tabs), Agents ›
  Runtime, Artifacts and settings subpages read it with `useReturnTarget(route, navigate)`
  (`web/app/useReturnTarget.js`). A valid `returnTo` turns the back arrow into "Back to
  <origin>" (`settingsHubCopy.backTo`, e.g. "Back to Chief of Staff") that returns
  there; without one the back arrow keeps the hierarchy (subpage → its tab, Connections
  entry → its category).
- `returnTo` is part of the route (`readRoute`/`routePath`), so it survives a reload
  and history moves. Moves inside Connections keep it; any other navigation builds a
  fresh route and drops it.
- Connections on phones: only the page the link landed on (category list or entry)
  shows the origin's back arrow. Another entry goes back to its category, and a list the
  link did not land on keeps the menu button. On wider screens Connections is one page
  (categories, list and detail side by side) and shows the origin's back arrow for the whole visit.
- Chains keep one earlier origin: a cross-link that starts on a page with its own
  `returnTo` carries it forward (Agent settings → Deepgram → Agents › Runtime →
  back to Deepgram → back to the agent). A third link drops the oldest origin.
- Validation (`readReturnTo()` in `web/app/routes.js`, `appPathParts()` in
  `web/app/return-to.js`): same-origin app paths only, no scheme, no `//host`, no
  backslash or control characters, bounded length; the value is parsed as an app route
  of an allowed origin (agents, settings, connections, coding and the old extensions and
  accounts views) and rebuilt with
  `routePath`, never echoed. Nesting stops after one level.
- Agent settings remember their scroll position (`useReturnScroll`); returning through
  the back arrow restores it.
- The Artifacts page also honours `returnTo`, but only from a session: the session's
  artifact panel links (an artifact's detail, "Manage in Artifacts") carry the session,
  and the list's back arrow reads "Back to <session>". A phone detail subpage still
  goes back to the list first.

## Wizards

A multi-step flow (the MCP server wizard, `web/features/mcp-servers/wizard/`) keeps its
draft in a React reducer only, never in storage. The address carries an allowlisted
`step` (`web/features/connections/routes.js`) so browser history moves between steps; a
reload drops the draft and returns to the first step with a notice. Each step has one
`h1` that takes focus, a form whose Enter submits the primary action, and a sticky bar.
`useWizardGuard` asks before a navigation leaves an unsaved draft. Saved records are
edited step by step: each edit step owns its draft (`useAccountDraft` keeps it only for
the same `item` and `step`) and saves with the usual save bar.

The new agent wizard (`/agents?new=1`, `web/features/assistants/wizard/`) has six steps
in one draft (`wizard-draft.js`, profiles in `wizard-profiles.js`). Its address does not
carry the step; leaving the page with a draft asks first, and side sheets (model access,
setting up what step 3 or 4 needs) keep the draft. **Create agent** runs the existing
endpoints in order (`wizard-creation.js`): `POST /api/assistants` (or the user-agent
endpoint), capabilities, the `access` half of `PUT /assistants/:id/work`, MCP bindings, the
`team` half (duplicates), Telegram, heartbeat, routine, each with its revision. A failed later step keeps the agent and lists every
step as done or failed with "Try again"; no step is resent silently. `duplicate=<id>`
prefills it from another agent by the copy rules in `wizard-draft.js`.

## Server summaries

- `PUT /api/assistants/:id/work` — `{ access?: { revision, projectIds, pipelineIds, memoryWrite, autonomous, publish }, team?: { revision, autonomous, maxMembers, runTimeoutMinutes } }`
  → `{ access, team, removedProjectIds }`; one transaction, both revisions are preconditions.
  Granted projects that no longer exist are dropped and listed in `removedProjectIds`;
  `PUT /api/assistants/:id/access` returns the saved policy with the same field.
- `GET /api/settings/summary` — `{ access: { mcp, remote, ssh, github, secrets }, operations: { diagnostics, backups, updates } }` (the `access` key keeps its old name; the settings tabs and the menu's update hint read it);
  local state only, every part `null` when unknown. `secrets` is `{ count }`. `remote` is
  `{ tailscale, network, restartRequired }` (a saved network change not yet running).
- `GET /api/connections/usage` — per SSH/SFTP host, secret and GitHub token profile:
  agents (`via` grant, lead or hook, with mode), hooks, projects (GitHub), running
  sessions and the host's last audited use (`lastUseCovers` names what it counts);
  per MCP server its last change from the audit (`mcp[id].changedAt`).
- `GET /api/connections/problems` — per Zugänge category `{ total, problems,
warnings, unknown }` from stored state only; a category that cannot be read is null.
- `GET /api/accounts/usage` — per provider connection, ChatGPT account, MCP server, web
  search, speech and native CLI account: `{ agents: [{ id, name, kind, via }], sessions, pipelineProfiles, clis: [{ tool, route }] }`.
  Agent data only while the agents feature runs. A source that cannot be read is `null`
  (`agents`, `sessions` or `pipelineProfiles`).

Rows show "—" until a summary arrives, never a fake 0.

## Copy

Shared texts live in `commonCopy` (`web/lib/i18n/{de,en}/common.js`): `centralInAccounts`
("Managed centrally in Connections"),
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
