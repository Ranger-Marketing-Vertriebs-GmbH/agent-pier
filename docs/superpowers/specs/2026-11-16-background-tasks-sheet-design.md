# Background tasks sheet (PR 1 of 2)

Working document; delete before the pull request opens.

## Intent

The chat shows the CLI's to-dos and subagents in a side panel on desktop and a
drawer on phones, opened by an "Aufgaben 3/7" button at the top of the chat. The
owner wants the quieter pattern of the Claude mobile app instead: one line above
the composer ("4 laufende Aufgaben") that opens a sheet of cards grouped into
running and completed. It applies to Claude Code, Codex and OpenCode alike.

## Goals

- A status line directly above the composer that says how much is running.
- A sheet titled "Hintergrundaufgaben" / "Background tasks" with three collapsible
  groups: Running, Completed (with count), To-dos (with done/total).
- One card per subagent: name, task text, kind label "Agent", then elapsed or
  updated time while running, or the status label once finished; token usage as
  today.
- Finished subagents stay listed under Completed instead of disappearing after
  10 seconds.
- The side panel, the phone drawer and the top "Aufgaben" toggle are removed.

## Non-goals (PR 2)

- Stop buttons, "show transcript", background shells as entries. PR 2 adds them
  per CLI through each CLI's own interface, and shows a control only where that
  CLI supports it. PR 2 starts with a spike against real CLIs in a separate
  AgentPier instance.
- No server or live-channel changes in PR 1: `observability.subagents` and
  `tasks` already carry everything shown.

## Anti-goals

- A line that is always there and says "0 tasks". It shows only when it has
  something to say.
- A working agent shown from saved or stale data. The existing `live` rules of
  `presentSubagents` and `subagentRowStatus` stay.

## Approaches

1. **Reuse `Modal` (picked).** `Modal` is already a bottom sheet with a grab
   handle on phones and a centred dialog on desktop. Cards use `ListCard` /
   `ListRow`. No new primitive, so the UI guide and gallery need no new entry.
2. A new non-modal popover anchored to the line. Keeps split panes interactive
   while open, but is a bespoke overlay the UI guide forbids without a new
   primitive, and it does not match the requested sheet.
3. Keep `TaskPanel` and restyle it. Does not remove the side panel, which is
   the point of the request.

The owner picked the sheet style and the two-PR split; using `Modal` is the
builder's call that follows from the UI guide.

## Design

**Status line** (`ChatView.jsx`, between transcript and composer): a text button.

- n running subagents: "n laufende Aufgaben" / "n running tasks" (singular form
  for 1).
- none running, to-dos present and not all done: "Aufgaben 3/7" / "Tasks 3/7".
- none running, but finished subagents or completed to-dos exist: a muted
  "Hintergrundaufgaben" / "Background tasks", so history stays reachable.
- nothing at all: no line.

The subagent button in `ChatObservability` ("Subagents (n)") opens the same
sheet and stays, since it sits in the header bar.

**Sheet**: `Modal` with the title above; groups are collapsible sections, Running
and To-dos open by default, Completed closed when it has more than five entries.
Empty groups are not rendered. The to-do group keeps today's progress bar,
symbols and status labels.

**Presence**: `presentSubagents` no longer removes finished agents after the
linger; it returns `running` and `finished` (newest completion first). The
linger, fade and `SUBAGENT_FIRST_SEEN_TOLERANCE_MS` logic and the `fading` flag
go away, with their tests rewritten. Rules for non-live data stay.

**State**: `useChatController` loses `compactTasks` and the open-by-default
desktop behaviour; the sheet is closed by default everywhere. Focus returns to
the opener as today.

**Split panes**: the sheet is modal, unlike today's in-pane drawer. Accepted,
because it is opened briefly; say so in the pull request.

## Also in the change

- i18n: German and English keys, removed keys for show/hide tasks, run
  `npm run i18n:confirm`.
- Search index: check `web/app/search-entries.js` for a task-panel entry and
  rename it, keeping the old name as an alias.
- Tests: update `tests/browser/chat.spec.js`, `chat-presentation.spec.js`,
  `chat-subagents.spec.js` and the unit tests of `subagent-presentation.js`;
  add coverage for the line's four states and the grouped sheet.
- Docs: `web/README.md`, `docs/architecture.md` and any guide or screenshot that
  describes the task panel.
- CSS: remove `.chat-tasks` / `.task-drawer` rules; no new hex colours, sizes
  under 11px or breakpoints.

## Left to the builder

File split (a new `BackgroundTasksSheet.jsx` is expected, `TaskPanel.jsx` goes),
exact class names, and whether elapsed time ticks or shows the last update time.
