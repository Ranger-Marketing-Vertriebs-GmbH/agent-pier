# Ticket sources: start sessions and pipeline runs from tickets

Tickets: AGENTPIER-228 (start a session/run from a GitHub issue or Plane work item) and
AGENTPIER-177 (import Plane items into the run queue by label/state). Brainstormed with the
owner on 2026-11-03.

## Intent

Today the owner tells every session by hand what to fetch from GitHub or through the Plane
MCP. AgentPier itself does not know which ticket a session or run works on. The owner wants
to pick tickets inside AgentPier and hand them to a session or pipeline ("kickoff"), and in
a second step let AgentPier work through a series of tickets on its own: one after another,
each finished when its PR is merged. A label rule should also pick up new tickets
automatically. GitHub and Plane come first; Jira and others should later be just another
source.

## Goals

1. **Tickets tab** on a project (owner decision: a tab, not the start dialog; the start
   dialog is already large). It lists open tickets of the project's connected sources:
   GitHub issues of the project's repo and work items of the connected Plane project.
2. **Start from tickets.** Select one or more tickets, choose per start Session or Pipeline
   (owner decides case by case), and start. Title, description and key become the task.
3. **Sequence.** Several selected tickets form a sequence. Tickets run strictly one after
   another; the next starts only after the previous ticket's PR is merged, by the owner or,
   if the owner allowed it for this sequence, by AgentPier through the repository's merge
   queue / auto-merge.
4. **Fresh session per ticket** (owner decision). Each ticket session works in its own git
   worktree under the repo's ignored `.worktrees/` (owner decision), created from the
   up-to-date default branch, like pipeline runs already get their own workspace. The
   previous ticket's session stays open, marked done; the owner closes it, and its worktree
   is removed with the usual worktree cleanup rules (clean and merged only).
5. **Write-back** (owner decision): on start the ticket goes to "In progress" with a link to
   the session or run; after the merge it goes to "Done" with a link to the PR.
6. **Failure handling** (owner decision): the session/pipeline first tries to fix problems
   itself (failed CI, review findings). If it cannot, the owner gets a notification and the
   sequence waits until the owner acts. No ticket is skipped.
7. **Label rules** (owner request): AgentPier checks regularly for new tickets carrying a
   configured label and starts a session or pipeline for each. A rule fixes Session vs.
   Pipeline (and which pipeline), and whether self-merge is allowed. Each ticket is picked
   up once.
8. **One queue per repo** (owner decision): one sequence/rule queue runs per repo at a time.
9. **⌘K**: the Tickets tab and its actions ("Start tickets", "Add label rule") are reachable
   from the command palette.
10. **Extensible sources:** GitHub and Plane are two implementations of one ticket-source
    interface; Jira etc. later add a source, not a new feature.

## Non-goals

- No Jira, Linear or other source in this project (only the interface that allows them).
- No ticket editing beyond the two state transitions and link comments.
- No parallel tickets within one repo.
- No change to how sessions and pipelines work internally beyond what the sequence needs
  (the worktree for ticket sessions and the repair session are the needed additions).
- Multi-repo projects (AGENTPIER-285) are not built here; see Constraints.

## Anti-goals (would make it a failure even if it works)

- Ticket text treated as trusted instructions. Ticket title/body is untrusted input exactly
  like any typed task (prompt-injection rules, no privilege from ticket content).
- A sequence that silently skips a ticket or silently moves on after a failure.
- A ticket started twice (by rule and by hand, or by two polls).
- Tokens leaking into logs, browser responses or ticket comments.
- Self-merge happening without the owner's explicit permission for that sequence or rule.

## Constraints

- AgentPier rules (AGENTS.md): de+en catalogs and `i18n:confirm`, live updates via a live
  topic (no new timed polling in the web app), ⌘K entries, UI guide components, docs in the
  same PR, files ≤ 600 lines.
- **Project ↔ repo:** today a project is one directory (`ProjectDetail.jsx`, tabs at lines
  100-106; routes in `web/features/projects/routes.js`). The owner's model is "a project may
  contain several repos, one queue per repo"; AGENTPIER-285 builds that later. Until then a
  project has exactly one repo. The design keys everything by repo (project id + repo
  path), so 285 can add a repo selector to the tab without changing the data.
- **Plane connection** (owner decision): the owner connects a project (or, after 285, a
  repo) with one Plane project. All tickets of that Plane project belong to that repo.
- **GitHub** uses the token profile already attached to the project
  (`server/features/repositories/repository-store.js`); no second GitHub token. Issues come
  from REST `/repos/{owner}/{repo}/issues` (drop pull requests from that list).
- Credentials are host-scoped, owner-only to configure, stored like the existing provider
  and GitHub credentials (`writePrivate`, 0600, included in sealed backups like those).
- Pipelines today end when the PR exists ("the factory never merges", `docs/pipelines.md`);
  PR merge state is not observed anywhere yet; there is no Plane/Jira code.

## Decided how (owner decisions are marked; the rest are my calls, see the list at the end)

### Ticket source interface (my call on the shape)

A source is a small server module per tracker with:
`list({ connection, repo, filter }) → tickets`, `get(key) → ticket`,
`markInProgress(ticket, link)`, `markDone(ticket, prLink)`, and `matchesRule(ticket, rule)`.
A ticket is `{ source, key, title, body, url, labels, state, updatedAt }`. Sources live
under `server/features/tickets/sources/<id>.js`, registered in one list.

- **Plane:** REST API with the connection's base URL + API token. "In progress" and
  "Done" map to the Plane project's first state in the `started` and `completed` state
  groups (configurable per connection if a project has several).
- **GitHub:** "In progress" = adds a label (default `in progress`, configurable) and a
  comment with the link; "Done" = the PR body contains `Closes #N`, so GitHub closes the
  issue on merge; AgentPier only verifies and comments.

### Tickets tab (owner decision: tab on the project, plus ⌘K)

Layout as shown to the owner (variant A):

- Repo line (one repo until 285) with its connected sources.
- List of open tickets with checkboxes, source marker, key and title; filter by label.
- Start bar: Session or Pipeline (+ which pipeline / which account and launch mode),
  for pipelines the repair session settings (CLI, account, launch mode),
  "Allow merge" toggle, button "Start" (one ticket) or "Start as sequence".
- Queue: the running and waiting tickets of the repo with state (running, waits for merge,
  needs you, done) and links to session/run/PR.
- Label rules: list, add, edit, pause.
- Connection setup for Plane lives in Settings (owner-only), linked from the tab when the
  project has no Plane connection.

### Sequence engine (my call on the mechanics)

- Stored per repo: ordered ticket list, start options, self-merge flag, current position,
  per-ticket state (`waiting`, `running`, `awaiting-merge`, `needs-owner`, `done`), links.
- Per ticket: start session/run with the ticket as task and an instruction to put the key in
  the branch name and `Closes`/key reference in the PR description; mark "In progress".
- Watch the ticket's PR (found via branch or link reported by the run/session) until it is
  merged or closed. Polling the forge server-side (e.g. every minute, `gh pr view`) is fine
  here; the browser follows a live topic.
- Self-merge: if allowed, enable auto-merge (`gh pr merge --auto`; with a merge queue this
  enqueues). If the repo allows neither auto-merge nor a merge queue, AgentPier waits until
  all required checks are green and merges itself (my call). Never merge past required
  checks or unresolved requested changes.
- Finding the PR (my call): the branch name contains the ticket key; AgentPier finds the
  PR through the forge by head branch. Sessions are told the branch naming in their first
  prompt.
- "Problems" means failed required checks or a review that requests changes (my call).
- Session tickets (my call): the first prompt tells the session to watch its PR and fix
  failed checks and requested changes itself. AgentPier also types a short notice into the
  live session when checks fail. If the PR is still red after the session has gone idle for
  30 minutes, or after three failed check rounds → `needs-owner`.
- Pipeline tickets (owner decision): pipelines stay as they are. When the PR of a pipeline
  ticket has failed checks or requested changes, AgentPier starts a **repair session** on
  that PR's branch (in its own worktree) with the failure as task. The owner configures the
  repair session per sequence and per label rule: CLI, account and launch mode (default:
  the repo's last used coding session settings). Same idle/round limits as above.
- Still failing, PR closed unmerged, or a run failed → state `needs-owner`, owner
  notification (web push via `notification-service.js`, same pattern as
  `github-token-monitor.js`), sequence waits. The owner can retry, mark done, or remove the
  ticket from the sequence.
- On merge: mark "Done", start the next ticket (fresh session).

Queue semantics (my call): a sequence store per repo feeds work one ticket at a time.
Manual sessions and runs the owner starts by hand are not blocked. Label rules append their
tickets to the same per-repo order; while a ticket is `needs-owner`, the whole repo queue
(including rule tickets) waits.

Pipelines: reuse the existing run queue (`server/features/pipelines/run-queue.js`); a
sequence adds one item at a time with `externalRef` = ticket key, and holds the next one
until the merge. The run queue itself is not changed beyond what the gate needs.

### Label rules (my call on defaults)

- Per repo: source, label, Session/Pipeline (+options, repair session settings for
  pipelines), self-merge flag, paused flag.
- Poll every 10 minutes (configurable), server-side, with the `github-token-monitor.js`
  pattern (interval with `unref`, no overlap, abort on stop).
- New matching tickets are appended to the repo's queue in ticket order. Dedupe by
  `source + key` across rules and manual starts, persisted, so a ticket is never started
  twice even if the label stays.

## Delivery (my call)

Three PRs:

1. Sources (GitHub, Plane), Plane connection, Tickets tab with list and single start,
   write-back "In progress", ticket link shown on the session/run.
2. Sequences: queue per repo, PR watch, self-merge, fix attempts, notifications,
   write-back "Done", ⌘K actions.
3. Label rules with polling and dedupe.

## Left to the builder

Storage format and file locations, exact API shapes, component structure within the UI
guide, poll intervals within reason, test layout. Ask the owner only if something here
turns out not to work.

## Calls I made (for the owner to check)

- Source interface shape and GitHub's "In progress" as label + comment.
- Plane state mapping by state group.
- Sequence watches the PR server-side by polling the forge; PR found by the key in the
  branch name.
- "Problems" = failed required checks or requested changes; `needs-owner` after 30 minutes
  idle with a red PR or three failed check rounds.
- Self-merge without auto-merge/merge queue: wait for green required checks, then merge.
- Ticket sequences don't block manual work; rules share the repo's queue order.
- Repair session defaults to the repo's last used coding session settings.
- Notifications via web push (existing service).
- Label rules poll every 10 minutes; dedupe by source + key.
- Delivery in three PRs in the order above.
