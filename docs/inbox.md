# Inbox

The **Inbox** (German **Eingang**, "Waiting on you") collects every decision that
waits for you, wherever it came from, so you do not have to visit each chat, run and
agent to find it. It sits in the sidebar directly under **New** with a live count; on a
phone the header shows an inbox icon with the same count.

## What it lists

| Tab           | Items                                                                                                                                    |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **Questions** | Questions a coding CLI asks in a running session (Codex, Claude Code, OpenCode)                                                          |
| **Approvals** | Permission requests of a coding CLI in a running session, such as a tool call, a workspace trust or Codex hooks                          |
| **Gates**     | Pipeline runs that wait for a human decision at their current stage                                                                      |
| **Agents**    | Agent requests that wait for approval (shell and SSH commands, coding tasks, memory entries, team member permissions) and team proposals |

**All** shows everything; every tab shows its count. Items about to expire (within 15
minutes, such as an agent's shell command) come first, soonest first; everything else
follows with the longest waiting first.

## Answering

Select an item to open it in the detail pane. The pane shows the same card you would
see in place: the native question or approval from the session's chat, the gate
decision from the run, the agent's approval card or the team proposal. Answering there
has the same effect as answering in place, because the card uses the same endpoint and
the same checks. **Open in context** opens the session chat, the run or the agent's
chat instead. The list has no quick actions; a decision is always made on the full
card.

Answered or expired items leave the list without a reload. Every item has a stable
address, `/inbox/<type>/<id>`, where the type is `question`, `approval`, `gate`,
`action` or `team`. An address of an item that no longer waits shows **Already done**
with the decision and its time when the audit log recorded it within the last 24 hours,
and **No longer waiting** otherwise (for example after the CLI dialog was answered in
the terminal long ago, or an approval expired).

## Waiting sessions

A session in the sidebar shows **Waiting** while one of its native requests is open,
the same requests the inbox lists; the CLI's own activity reports and the terminal
screen decide only when none is open (see [architecture](architecture.md)).

## How it works

- `GET /api/inbox` returns `{ instance, revision, counts, items }`. Each item has
  `type`, `id`, `tab`, `kind`, `source` (`{ kind, id, name }` of the session, run or
  agent), `title`, `createdAt`, `expiresAt` and `link` (the in-context page). Items
  carry no command lines; the cards load them from their own endpoints.
- `GET /api/inbox/events` is a server-sent event stream. It sends the counts and the
  revision when it connects and whenever the waiting set changes; the page then reads
  `GET /api/inbox` again. The polled `/api/state` carries the same summary for the
  sidebar count.
- `GET /api/inbox/<type>/<id>` resolves a stable address to `pending` (with the
  item), `done` (from the audit log, for 24 hours) or `gone`.
- The inbox only reads. It is part of the owner's login like every other page; it
  never answers on its own and adds no new way to decide.

The server side lives in `server/features/inbox/` (sources, items, history) and
`server/http/routes/inbox.js`; the page lives in `web/features/inbox/`. Push
notifications still open the item in place; see [notifications](notifications.md).
