# Settings pattern

Agent settings, Accounts, Settings, Extensions and Projects share one pattern:
a header with underline tabs, grouped list cards, one bottom save bar per tab or
subpage, hints behind ⓘ, central settings as dashed reference rows into Accounts, and
"Used by" lists in Accounts. This guide names the building blocks and their contracts.

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
| `ReferenceRow`                                                   | Dashed row "Managed centrally in Accounts" (or a count) linking to `{ view: "accounts", section, item }`: a link with `href` (`onOpen` keeps it in-app), a button without.                                                                                      |
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
  without an error. A step may map its own errors with `confirmation(error)`.
- **Errors.** The chain stops at the first error. `draft.outcome` holds the error, the
  failed step and `partial` (labels of saved steps); the bar shows "Partially saved: …"
  and the tab stays dirty. A confirmation cancelled after an earlier step saved also
  reports "Partially saved: …", without an error.
- **Agent helpers** (`web/features/assistants/assistant-save-steps.js`):
  `assistantPatchStep` for `PATCH /assistants/:id` (Profile, Skills, Telegram
  heartbeat) and `assistantWorkStep` for `PUT /assistants/:id/work` (Work; revisions
  `{ access, team }`).

## Unsaved changes and navigation (`web/lib/navigation-guard.js`)

All navigation goes through one coordinator: app routes and browser history
(`useWorkspaceNavigation`), file editor tab closes, and settings drafts. Guards are
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

| Page           | Address                                                  | Route fields                                                                                                                                                                                                                                                                                                                    |
| -------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Settings       | `/settings?tab=access`, `/settings/<section>`            | `settingsSection`, `settingsTab` (`workspace` / `access` / `operations`; derived from the section; `settingsSection: "general"` is the tab root). `settingsSectionGroups`, `settingsTabOf()` in `web/features/operations/routes.js`.                                                                                            |
| Agent settings | `/agents/:id/settings?tab=<tab>&page=<page>`             | `agentTab` (`profile` / `capabilities` / `work` / `telegram`), `agentPage` (`memory`, `allowlist`, `actions`, `projects`, `pipelines`, `telegram-activity`, `telegram-connection`); read with `agentSettingsLocation(route)`. `agentTeam` (`team=<id>`, Work tab only) opens that team in the Teams group (`agentTeamRoute()`). |
| Accounts       | `/accounts?section=<group>&item=<id or new>&step=<step>` | `section` (`models` / `services` / `mcp-servers` / `cli`), `item`, `step` (MCP server wizard and edit steps only, see Wizards); MCP OAuth results keep working.                                                                                                                                                                 |
| Extensions     | `/extensions/:profile?tab=<tab>`                         | `extensionTab`; default `defaultExtensionTab` in `web/features/extensions/routes.js`.                                                                                                                                                                                                                                           |

Defaults are left out of addresses; `useWorkspaceNavigation` replaces any address whose
canonical form differs, which is how legacy links redirect.

### Cross-links and the back arrow

A link that leaves the current area (a `ReferenceRow` into Accounts, "Agent service
settings", the Deepgram row on the Telegram tab, the Access tab's Accounts row, the
CLI extensions' MCP row) wraps its target with `useCrossLink()` from
`web/app/cross-link.js`. The target gets `returnTo=<origin path>`: the exact page,
tab and subpage the owner came from.

- Accounts and settings subpages read it with `useReturnTarget(route, navigate)`
  (`web/app/useReturnTarget.js`). A valid `returnTo` turns the back arrow into "Back to
  <origin>" (`settingsHubCopy.backTo`, e.g. "Back to Chief of Staff") that returns
  there; without one the back arrow keeps the hierarchy (subpage → its tab, Accounts
  entry → its group).
- `returnTo` is part of the route (`readRoute`/`routePath`), so it survives a reload
  and history moves. Moves inside Accounts keep it; any other navigation builds a
  fresh route and drops it.
- Accounts on phones: only the page the link landed on (hub or entry) shows the
  origin's back arrow. Another entry goes back to its group, and a hub the link did not
  land on keeps the menu button. On wider screens Accounts is one page (hub and detail
  side by side) and shows the origin's back arrow for the whole visit.
- Chains keep one earlier origin: a cross-link that starts on a page with its own
  `returnTo` carries it forward (Agent settings → Deepgram → Agent service settings →
  back to Deepgram → back to the agent). A third link drops the oldest origin.
- Validation (`readReturnTo()` in `web/app/routes.js`, `appPathParts()` in
  `web/app/return-to.js`): same-origin app paths only, no scheme, no `//host`, no
  backslash or control characters, bounded length; the value is parsed as an app route
  of an allowed origin (agents, settings, extensions, accounts) and rebuilt with
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
`step` (`web/features/accounts/routes.js`) so browser history moves between steps; a
reload drops the draft and returns to the first step with a notice. Each step has one
`h1` that takes focus, a form whose Enter submits the primary action, and a sticky bar.
`useWizardGuard` asks before a navigation leaves an unsaved draft. Saved records are
edited step by step: each edit step owns its draft (`useAccountDraft` keeps it only for
the same `item` and `step`) and saves with the usual save bar.

## Server summaries

- `PUT /api/assistants/:id/work` — `{ access?: { revision, projectIds, pipelineIds, memoryWrite, autonomous, publish }, team?: { revision, autonomous, maxMembers, runTimeoutMinutes } }`
  → `{ access, team, removedProjectIds }`; one transaction, both revisions are preconditions.
  Granted projects that no longer exist are dropped and listed in `removedProjectIds`;
  `PUT /api/assistants/:id/access` returns the saved policy with the same field.
- `GET /api/settings/summary` — `{ access: { mcp, remote, ssh, github }, operations: { diagnostics, backups, updates } }`;
  local state only, every part `null` when unknown. `remote` is
  `{ tailscale, network, restartRequired }` (a saved network change not yet running).
- `GET /api/accounts/usage` — per provider connection, ChatGPT account, MCP server, web
  search, speech and native CLI account: `{ agents: [{ id, name, kind, via }], sessions, pipelineProfiles, clis: [{ tool, route }] }`.
  Agent data only while the agents feature runs. A source that cannot be read is `null`
  (`agents`, `sessions` or `pipelineProfiles`).

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
