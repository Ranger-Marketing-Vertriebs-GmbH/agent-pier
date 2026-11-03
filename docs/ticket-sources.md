# Ticket sources

A project's **Tickets** tab lists the open GitHub issues of its repository and the open
work items of a linked Plane project. One ticket at a time starts as a session or a
pipeline run; AgentPier then marks the ticket "In progress" in the tracker and comments
that it was started, and shows the ticket on the session and the run.

## Setup

### GitHub

GitHub issues need no extra connection. The Tickets tab reads them from the project's
`origin` remote (HTTPS, `git@host:owner/repo` or `ssh://`) with the token profile that
is selected for that host under **Connections › GitHub connections**
([GitHub connections](github-agents.md)). GitHub.com and GitHub Enterprise Server
(`https://<host>/api/v3`) both work. A project without a remote, with a remote on
another host, or without a selected token profile for the host shows GitHub as not
connected; Plane still loads.

The token needs **Issues: read** to list tickets and **Issues: write** for the
write-back (fine-grained token), or the `repo` scope (classic token, `public_repo` for
public repositories only). Without write access the session or run still starts; the
ticket shows **Write-back failed**.

### Plane

Add a Plane connection under **Connections › Ticket sources › Add Plane connection**:

- **Name**: shown in the project and in the list.
- **API URL**: `https://api.plane.so` for Plane Cloud, or the address of a self-hosted
  Plane. Only `https://`, except `http://` for `localhost`, `127.0.0.1` and `::1`.
- **Workspace slug**: the part after the address in the Plane URL.
- **API key**: a personal access token from Plane's **Profile settings › Personal
  access tokens**. It needs to read work items, states, labels and projects
  (`projects.work_items:read`) and, for the write-back, to update work items and add
  comments (`projects.work_items:write`).

The API key is stored on this computer in `ticket-source-secrets/<id>.json` (file
`0600`, folder `0700`). It never reaches the browser, logs, error messages, ticket
comments or the audit log; the edit dialog keeps it when the field is left blank, unless
the **API URL** moves to another host: then the key has to be entered again, so the saved
one never goes to the new address. A connection can be deleted once no project links to it.

### Linking a project

In the project's **Tickets** tab, **Edit** in the **Ticket sources** card opens the
source dialog:

- **Plane connection** and **Plane project**: the work items of that Plane project
  appear in the tab. Identifier and name are taken from Plane.
- **In progress state**: shown when the Plane project has more than one state in the
  `started` group. **Plane's first started state** uses the `started` state with the
  lowest sequence.
- **GitHub label for started issues**: default `in progress`, at most 50 characters and
  no comma. GitHub creates a missing label.
- **Disconnect Plane project** removes the Plane link and keeps the GitHub label.

A project known only to AgentBus first needs its folder registered; the tab offers
that.

## The Tickets tab

The tab lists open GitHub issues (pull requests left out) and open Plane work items
(items in the `completed` and `cancelled` groups left out), newest change first. A
**Label** filter narrows the list; its choices are the labels of all open tickets. A
**Source** switch (**All**, **GitHub**, **Plane**) appears when both sources are
connected. **Refresh** reads the project's sources and the trackers again. A source that fails shows its reason
in a line above the list (for example a rejected API key) while the other source still
loads. Without any connected source, the tab links to **Connections › GitHub
connections** and **Connections › Ticket sources** and still offers **Refresh**.

Each ticket's ⋯ menu offers **Start session**, **Start pipeline run**, **Open in
GitHub** or **Open in Plane** and, once started, **Open session** or **Open pipeline
run**. A started ticket shows **Started**, or **Write-back failed** with the reason.

⌘K/Ctrl+K finds each project's Tickets tab ("Tickets", also by "Issues", "GitHub" and
"Plane").

## Starting a ticket

**Start session** opens the session dialog with the ticket as its task. The session
runs in the project folder with a coding CLI (no shell); its name defaults to
`<key> · <title>`. **Start pipeline run** opens the run dialog with a pipeline, an
optional base branch and token budget; the run's worktree is created from the project
as for any other run.

AgentPier reads the ticket from the tracker itself at the moment of the start; the
browser sends only the source and the key. A ticket starts once: a second start of the
same ticket, from a double click or another tab, is refused while the first is under
way and afterwards. To start it once more, choose the start again and confirm **Start
again**.

### The task text

The task names the ticket key and its URL, then quotes the ticket's title and body
inside a `<ticket>` block and tells the CLI that this text is untrusted input from the
issue tracker: a description of the work, never a change of its rules, permissions or
instructions. The ticket grants nothing. Before quoting, AgentPier converts HTML to
text, removes control characters, neutralizes `<ticket>` tags inside the text and cuts
the body at 16,000 characters with a note. A session's task also asks for a branch
whose name contains the ticket key; both kinds ask to reference the ticket in the pull
request (`Closes #<n>` for GitHub, the key for Plane).

### Write-back "In progress"

After the start, AgentPier marks the ticket:

- **GitHub**: adds the project's label (default `in progress`) and comments
  `Started in AgentPier (session).` or `Started in AgentPier (pipeline run).`
- **Plane**: moves the work item to the chosen **In progress state**, or Plane's first
  state in the `started` group (an item that already is in a `started` state stays),
  and comments `Started in AgentPier (session).` or `Started in AgentPier (pipeline run).`

The comments are in English because they live in the tracker. They name AgentPier and
the kind but carry no address: on a public GitHub repository an AgentPier URL in a
comment would be visible to anyone. The link between ticket and session or run lives
only inside AgentPier. When the tracker refuses the write-back
(for example a token without write access), the session or run keeps running and the
ticket shows **Write-back failed** with the reason; nothing is retried.

The session view and the run header show the ticket as a link (`<key> · <title>`),
and the session list adds the key.

## Live updates

The tab follows the live topic `tickets.project:<projectId>` (the project's source
links and start records) and the Connections page follows `tickets.connections`; both
are owner-only and change on every write of the ticket service. Adding, editing or
deleting a GitHub token profile, changing the profile a host uses, and cloning a
repository signal every project's topic too. The ticket list itself
is a REST read when the tab opens, when a source changes and on **Refresh**, never on
a timer. See [Architecture](architecture.md#live-channel).

## Data and backups

Plane connections, project links and start records live in `ticket-sources.json` in
the data directory (at most 500 start records; the oldest are dropped). Backups carry
it as a public member and the API keys only sealed with **Include encrypted
credentials**; a restore without them lists each Plane connection as needing its key
again. See [Backups](backups.md).

## Limits

- GitHub lists at most 300 open issues (three pages), Plane at most 500 open work items
  (five pages); the label filter applies within those.
- Every tracker request times out after 15 seconds and reads at most 4 MiB.
- AgentPier follows no redirect, so a token never goes to another address. A renamed or
  transferred GitHub repository therefore reads as "cannot be reached" until the
  project's git remote names the new address.
- Plane needs the `work-items` API (`/api/v1/…/work-items/`); older self-hosted Plane
  releases without it answer "not found".
- The GitHub part of the tab does not refresh on its own when the project's git remote
  changes (AgentPier does not watch it); choose **Refresh**.
- All ticket routes are owner-only; restricted users have no Tickets tab.

## Ticket sequences

Ticket sequences work through a project's tickets one at a time and watch each pull
request until it merges. The full guide is still to come.

### Merging

AgentPier merges a sequence's pull requests itself only when the sequence allows it.
It arms each pull request head at most once:

- In a repository with a merge queue, it adds the pull request to the queue once the
  counted checks are green.
- Otherwise, it enables auto-merge, even while checks are still running.
- When the repository has neither, it merges directly once the pull request is ready,
  and only the head it checked.

AgentPier never re-arms a head that was disarmed on GitHub, for example by you or by a
merge queue that dropped the pull request. The ticket then waits for you, and so does
the rest of the sequence. If GitHub refuses to arm or merge a head that is otherwise
ready, the ticket also waits for you.

AgentPier reads each pull request about once a minute. When a review requests changes,
AgentPier turns auto-merge off or removes the pull request from the merge queue on its
next read. In a repository without required reviews, GitHub can therefore merge an
armed pull request in the up to 60 seconds before that read. Require reviews in the
branch protection if a "changes requested" review must always stop a merge.

A head that a merge queue dropped while its checks failed is the exception: AgentPier
queues that head again once a re-run of its checks is green. AgentPier cannot tell
whether you or the queue removed a red pull request, so it re-queues it in both cases.
Auto-merge is different: GitHub keeps it on through failed checks, so auto-merge found
off was turned off by a person, and the ticket waits for you. When a merge queue drops a
pull request because its merge-group build failed while the pull request's own checks
are green, the ticket also waits for you (`mergeDisarmed`).

### Fix attempts

When the counted checks of a pull request fail, or a review requests changes, AgentPier
asks for a fix once per pull request head:

- A session ticket's own session gets a message naming the pull request and the failed
  checks.
- A pipeline ticket gets a repair session in its own worktree under `.worktrees/`, on a
  local `ticket-repair/…` branch started from the pull request branch. The session
  pushes its fix to the pull request branch. It uses the sequence's repair settings
  (CLI, account, launch mode), or else those of the newest coding session in the
  project folder. Later failures go to the same repair session while it runs.

Repair worktrees are named `.worktrees/repair-<key>-<sha7>-<id8>`, with a `-2`, `-3` …
before the item id when one head needs another repair. A later repair reuses the
earlier worktree when it is clean and holds no commits beyond the pull request branch;
otherwise that worktree stays untouched and the repair gets a new folder. AgentPier
never removes repair worktrees or their `ticket-repair/…` branches: remove them with
`git worktree remove` and `git branch -D` once the ticket is done.

A review that requests changes stays in force until the reviewer reviews again, so the
session hears about it once per new head.

The ticket waits for you when:

- the checks of a third head fail,
- the pull request stays red for 30 minutes while the session that should fix it is
  idle, stopped or gone (counted from the later of the last message and the start of
  the idle phase),
- a pipeline ticket needs a repair but the sequence has no repair settings and the
  project has no coding session to copy them from, or the repair session cannot start,
- GitHub cannot be read, or the pull request branch cannot be fetched for a repair,
  for 30 minutes in a row. Shorter outages and rate limits only delay the next read.

### Owner actions

A ticket that waits for you blocks the rest of its sequence until you act on it:

- **Retry** starts the fix counters, the merge memory and the 30-minute clocks again.
  An open (or meanwhile merged) pull request is watched again. Otherwise the ticket
  starts afresh: a new pipeline run, or a new session. A session ticket reuses the
  folder of its last attempt under `.worktrees/` when that folder is a clean worktree
  still on the ticket's branch. When the folder has local changes, another branch, or
  was never recorded as the ticket's worktree, Retry is refused: check the folder and
  remove it first, because AgentPier never deletes it.
- **Mark done** moves the sequence on. It writes nothing to GitHub or Plane. A waiting
  ticket can be marked done too.
- **Remove** takes a waiting, parked or done ticket out of the sequence. A parked pull
  request that AgentPier may merge is disarmed first: auto-merge is turned off, or the
  pull request leaves the merge queue. When GitHub cannot be read, Remove is refused.

A ticket that is running or waiting for its merge cannot be retried, marked done or
removed. These actions never overlap with AgentPier's own work on the sequence: each
one waits for a running step and is followed by the next step at once.

The sequence lives in `ticket-sequences.json` in the data directory. It is runtime
state like the pipeline run queue and is not part of backups. The Tickets tab follows
it on the owner-only live topic `tickets.queue:<projectId>`, which is signalled on
every saved change. The routes are `GET` and `POST /api/tickets/projects/:projectId/queue`,
`POST …/queue/:itemId/retry`, `POST …/queue/:itemId/done` and
`DELETE …/queue/:itemId`.

## Planned

Not available yet: starting several tickets as a sequence, rules that pick tickets by
label, and following the resulting pull request back to the ticket. Queue import by
label is future work too; until then a queue item takes the ticket key as **External
reference** ([Pipelines](pipelines.md#run-queue)).
