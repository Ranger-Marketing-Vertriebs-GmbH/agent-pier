# Ticket sources

A project's **Tickets** tab lists the open GitHub issues of its repository and the open
work items of a linked Plane project. A ticket starts as a session or a pipeline run;
AgentPier then marks the ticket "In progress" in the tracker and comments that it was
started, and shows the ticket on the session and the run. Several tickets can start as
a [sequence](#ticket-sequences) that AgentPier works through one at a time, watching
each pull request until it is merged, and [label rules](#label-rules) add every ticket
with a label to that sequence on their own.

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
ticket shows **Write-back failed**. Sequences need more; see
[GitHub permissions](#github-permissions).

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
**Label** filter narrows the list; its choices are the labels of the open tickets the
unfiltered list reads. GitHub filters by the label itself, so a filtered list also finds
labelled issues older than the newest 300 open ones. A
**Source** switch (**All**, **GitHub**, **Plane**) appears when both sources are
connected. **Refresh** reads the project's sources and the trackers again. A source that fails shows its reason
in a line above the list (for example a rejected API key) while the other source still
loads. Without any connected source, the tab links to **Connections › GitHub
connections** and **Connections › Ticket sources** and still offers **Refresh**.

Each ticket's ⋯ menu offers **Start session**, **Start pipeline run**, **Open in
GitHub** or **Open in Plane** and, once started, **Open session** or **Open pipeline
run**. A started ticket shows **Started**, or **Write-back failed** with the reason.
**Select tickets** starts a [sequence](#starting-a-sequence) of several tickets.

⌘K/Ctrl+K finds each project's Tickets tab ("Tickets", also by "Issues", "GitHub" and
"Plane") and the action **Start tickets**.

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

After the start, AgentPier marks the ticket. A single start is answered first; the
write-back follows, so a slow tracker never delays the session or run. Its start record
shows the write-back as `pending` until the tracker answers, then `done` or `failed`
through the live topic `tickets.project:<projectId>`. A write-back cut off by a restart
of AgentPier reads as failed (`interrupted`, "AgentPier restarted before the ticket
source was updated") and is not repeated.

- **GitHub**: adds the project's label (default `in progress`) and comments
  `Started in AgentPier (session).` or `Started in AgentPier (pipeline run).`
- **Plane**: moves the work item to the chosen **In progress state**, or Plane's first
  state in the `started` group (an item that already is in a `started` state stays;
  AgentPier compares the state's id, so a state of another group with the same name
  does not count), and comments `Started in AgentPier (session).` or `Started in AgentPier (pipeline run).`

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
links and start records), `tickets.queue:<projectId>` (its
[sequence](#live-updates-and-routes)) and `tickets.rules:<projectId>` (its
[label rules](#routes-and-live-updates)), and the Connections page follows
`tickets.connections`; all are owner-only and change on every write of the ticket service. Adding, editing or
deleting a GitHub token profile, changing the profile a host uses, and cloning a
repository signal every project's topic too. The ticket list itself
is a REST read when the tab opens, when a source changes and on **Refresh**, never on
a timer. See [Architecture](architecture.md#live-channel).

## Data and backups

Plane connections, project links and start records live in `ticket-sources.json` in
the data directory (at most 500 start records; the oldest are dropped). Ticket
sequences live in `ticket-sequences.json`, which backups leave out. Label rules and the
tickets they picked up live in `ticket-rules.json`, which backups carry as a public
member (see [Label rules](#label-rules)). Backups carry
`ticket-sources.json` as a public member and the API keys only sealed with **Include encrypted
credentials**; a restore without them lists each Plane connection by name as needing
its key again. See [Backups](backups.md).

## Limits

- GitHub lists at most 300 open issues (three pages), Plane at most 500 open work items
  (five pages). A GitHub label filter asks GitHub for that label and reads up to 300
  issues with it; a Plane label filter applies within the 500 work items.
- Every tracker request times out after 15 seconds and reads at most 4 MiB.
- AgentPier follows no redirect, so a token never goes to another address. A renamed or
  transferred GitHub repository therefore reads as "cannot be reached" until the
  project's git remote names the new address.
- Plane needs the `work-items` API (`/api/v1/…/work-items/`); older self-hosted Plane
  releases without it answer "not found".
- The GitHub part of the tab does not refresh on its own when the project's git remote
  changes (AgentPier does not watch it); choose **Refresh**.
- All ticket routes are owner-only; restricted users have no Tickets tab.
- Tracker failures answer `502` with the failure's reason, except "not found": a
  ticket the tracker does not know (start, add to the queue) or a Plane project that
  is gone answers `404`, a Plane workspace that the connection's slug does not name
  answers `409`, and a source that is not connected answers `409` too.

## Ticket sequences

A ticket sequence works through several tickets of a project one at a time. For each
ticket AgentPier starts a fresh session or pipeline run, waits for its pull request,
watches the pull request until it is merged, asks for fixes when checks fail or a
review requests changes, and then starts the next ticket. When it cannot go on, it
stops and waits for you.

Sequences need GitHub: the pull requests live there, also for Plane tickets. Without a
token profile for the project's GitHub host, **Start sequence** is refused.

### Starting a sequence

In the Tickets tab, **Select tickets** adds a checkbox to every ticket. **Start as
sequence (N)** opens the dialog for the selected tickets; **Cancel** ends the
selection. ⌘K/Ctrl+K **Start tickets** opens the current project's Tickets tab in
selection mode, or the Projects page when no project is open. The tickets run in the
order of the list, also those a filter hides at the moment. A selected ticket that is
no longer listed after **Refresh** (closed, or moved out of its source) is deselected,
and a line names it.

The dialog **Start N tickets as a sequence** asks:

- **Run as**: **Session** (a CLI, an account or provider connection with its model, and
  a launch mode, as in the session dialog; coding CLIs only, never the shell) or
  **Pipeline run** (a **Pipeline**). Every ticket of the sequence runs the same way.
- **Repair session** (pipeline runs only): the CLI, access and launch mode of the
  session that fixes a pipeline ticket's pull request (see [Fix attempts](#fix-attempts)).
  It is prefilled from the newest coding session in the project folder or below it,
  when its CLI is installed and its account or connection still exists; settings that
  arrive after the dialog opened fill it too, unless you already changed the fields.
- **Allow merge** (off by default): whether AgentPier may merge the pull requests
  itself (see [Merging](#merging)).

As with a single start, a ticket that was started before is refused once; **Start
again** then starts the sequence anyway. A ticket that is already in the sequence and
not done is refused (`ticketQueued`).

AgentPier reads every ticket from its tracker when it is added and again when it
starts. Each start is recorded like a single start: the ticket shows **Started** in the
list and gets the "In progress" [write-back](#write-back-in-progress).

### The queue

Each project has one sequence, kept per project and repository folder. New tickets are
appended at the end, also when a sequence is already running. The **Queue** card above
the ticket list shows each ticket with its state:

| State               | Meaning                                                                       |
| ------------------- | ----------------------------------------------------------------------------- |
| **Waiting**         | Not started yet.                                                              |
| **Running**         | The session or run works on the ticket; AgentPier waits for its pull request. |
| **Waits for merge** | The pull request is open; AgentPier watches it, asks for fixes and may merge. |
| **Needs you**       | AgentPier stopped; the line below says why.                                   |
| **Done**            | Merged, or marked done by you.                                                |

Only the first ticket that is not done is worked on. The next one starts only after
the pull request of the previous one is merged, or after you mark it done or remove
it. A ticket that needs you therefore holds up the rest of its sequence; no ticket is
skipped. The sequence holds up nothing else: single starts from the ⋯ menu, other
sessions and other projects' sequences go on as usual. A pipeline ticket waits in the
project's [run queue](pipelines.md#run-queue) like any other item, so the project's
**Concurrent runs** limit applies to it.

Each row's ⋯ menu offers **Open session** or **Open run**, **Open repair session** while
a pipeline ticket has a [repair session](#fix-attempts), **Open pull request** once
there is one, and the [owner actions](#owner-actions).

A done row names what is left open: a failed ["Done" write-back](#write-back-done)
("Merged, but not marked done: …"), or a pull request that may still be armed because
you marked the ticket done while GitHub could not be read.

### Worktrees and branches

A session ticket gets its own git worktree under the repository's `.worktrees/` folder,
named `ticket-<key>-<id8>` (letters, digits and `-` only). AgentPier fetches `origin`
first and creates the worktree from the remote default branch (`origin/HEAD`, else
`main`, else `master`), never from your checkout: local changes and the branch checked
out in the project folder stay untouched. The new branch is
`ticket/<key>-<title>`, with the title cut to 30 characters and `-2`, `-3`… added when a
local or remote branch of that name exists. A folder that already exists is refused.
When the repository does not ignore `.worktrees/`, AgentPier adds `/.worktrees/` to
the repository's `.git/info/exclude`; it never edits `.gitignore`.

The session's task is the ticket, quoted as untrusted text as for a single start (see
[The task text](#the-task-text)), plus its branch and base: commit there, push the
branch, open a pull request against the base, then watch the checks and reviews and fix
problems. The task tells the session not to merge the pull request or turn on
auto-merge itself: AgentPier merges it when the sequence allows it.
The session is named `<key> · <title>`. Sessions of a sequence run with AgentBus and
AgentPier's tools and without SSH accesses.

A pipeline ticket runs through the project's run queue with the ticket as its task and
the repository's default branch on GitHub as its base; the run creates its own worktree
and pull request as any run does.

When a ticket is done, its session stays open and its worktree and branch stay.
AgentPier never removes ticket worktrees: remove them with `git worktree remove` once
you no longer need them.

### Finding the pull request

- **Session tickets**: AgentPier looks for a pull request whose head is exactly the
  ticket's branch, from this repository (not a fork), opened no earlier than five
  minutes before the ticket started. An older pull request of an earlier attempt or a
  branch that merely looks similar never counts. While there is none, the ticket stays
  **Running**. It waits for you (`noPullRequest`) when its session has stopped, has
  been idle for 30 minutes, or has run for six hours without a pull request (counted
  from the start, or from the **Retry** that resumed it); when its session is gone, it
  waits for you with `sessionEnded`.
- **Pipeline tickets**: the pull request the run reports. A run that completes without
  one, or with one in another repository, waits for you (`noPullRequest`); a failed or
  cancelled run, or a queue item you deleted, waits for you too (`runFailed`).

AgentPier reads GitHub on the server about once a minute and right after anything that
changes the sequence (a start, an owner action, a change of a pipeline run). The
browser never polls.

### Merging

AgentPier merges a sequence's pull requests itself only when the sequence allows it.
It arms each pull request head at most once:

- In a repository with a merge queue, it adds the pull request to the queue once the
  counted checks are green and no review blocks it.
- Otherwise, when GitHub reports the pull request mergeable now (see the direct merge
  below), AgentPier merges it directly, and only the head it checked.
- While GitHub blocks the merge (merge state `BLOCKED` or `BEHIND`, for pending checks
  or a missing review), AgentPier enables auto-merge when the repository allows it,
  the pull request has at least one required check and none of the counted checks
  has failed. GitHub then merges once its rules pass.
- Without a required check, GitHub's auto-merge would ignore the CI, so AgentPier does
  not arm it: it waits until every check is green and the reviews allow it, then merges
  directly. A failing check therefore never merges, even after an approval.

AgentPier never re-arms a head that was disarmed on GitHub, for example by you or by a
merge queue that dropped the pull request. The ticket then waits for you, and so does
the rest of the sequence. If GitHub refuses to arm or merge a head that is otherwise
ready, the ticket also waits for you. A head GitHub refused to arm is still merged
directly once it becomes mergeable.

A parked ticket keeps an armed pull request armed: GitHub may still merge it, for
example after a re-run of its checks turns green. The ticket then stays **Needs you**
until you choose **Retry**, which sees the merge and moves the sequence on.

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

A direct merge needs the counted checks green, no review that requests changes or is
still required, and GitHub's merge state `CLEAN`, `HAS_HOOKS` or `UNSTABLE` (only a
check outside the counted ones is not green). The counted checks are the required
ones; a repository without required checks counts every check. AgentPier uses the
repository's default merge method and merges with the head commit it checked, so a
later push is never merged unchecked. Without **Allow merge**, AgentPier only watches:
you merge, and the sequence moves on.

### Fix attempts

When the counted checks of a pull request fail, or a review requests changes, AgentPier
asks for a fix once per pull request head:

- A session ticket's own session gets a message naming the pull request and the failed
  checks (at most five names), or that a review requested changes. Review texts are
  never passed on.
- A pipeline ticket gets a repair session in its own worktree under `.worktrees/`, on a
  local `ticket-repair/…` branch started from the freshly fetched pull request branch.
  Its task is the ticket, the pull request and the failed checks; it pushes its fix with
  `git push origin HEAD:<pull request branch>` and opens no new pull request. It uses
  the sequence's **Repair session** settings, or else those of the newest coding
  session in the project folder. Later failures go to the same repair session while it
  runs, as messages.

Repair worktrees are named `.worktrees/repair-<key>-<sha7>-<id8>`, with a `-2`, `-3` …
before the item id when one head needs another repair. A later repair reuses the
earlier worktree when it is clean and holds no commits beyond the pull request branch;
otherwise that worktree stays untouched and the repair gets a new folder. AgentPier
never removes repair worktrees or their `ticket-repair/…` branches: remove them with
`git worktree remove` and `git branch -D` once the ticket is done.

A review that requests changes stays in force until the reviewer reviews again, so the
session hears about it once per new head.

### When a ticket needs you

A ticket waits for you (**Needs you**) with one of these reasons:

| Reason                                                                                             | When                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GitHub access is missing or was refused. (`githubRequired`)                                        | The project's GitHub host has no token profile, or GitHub answered 401 or 403 (not a rate limit). A running or waiting-for-merge ticket parks only after 30 minutes of this, like `forgeUnreachable`.                                            |
| The ticket source is no longer connected. (`sourceUnavailable`)                                    | The ticket's GitHub or Plane source was disconnected.                                                                                                                                                                                            |
| The ticket could not be found. (`ticketUnavailable`)                                               | The tracker no longer has the ticket.                                                                                                                                                                                                            |
| The ticket could not be started. (`startFailed`)                                                   | The worktree, the session or the run could not be created (for example no remote default branch, or a folder that exists).                                                                                                                       |
| AgentPier restarted while starting this ticket. (`startInterrupted`)                               | A restart cut a start off before AgentPier knew its session or run, and no session of the ticket runs in its worktree. AgentPier never launches a second one on its own.                                                                         |
| The task did not reach the session. (`taskNotDelivered`)                                           | The session started but did not take its task; AgentPier stops it.                                                                                                                                                                               |
| The session ended without a pull request. (`sessionEnded`)                                         | The ticket's session is gone and no pull request exists.                                                                                                                                                                                         |
| The pipeline run failed. (`runFailed`)                                                             | The run failed or was cancelled, its queue item failed, or the item is gone.                                                                                                                                                                     |
| No pull request: the work ended, stayed quiet for 30 minutes or ran for 6 hours. (`noPullRequest`) | The run completed without a pull request, or with one outside this repository; or the ticket's session stopped, was idle for 30 minutes or ran for six hours without one.                                                                        |
| The pull request was closed without merging. (`prClosed`)                                          | Someone closed the pull request.                                                                                                                                                                                                                 |
| Auto-merge or the merge queue was turned off on GitHub. (`mergeDisarmed`)                          | A head AgentPier armed was disarmed on GitHub (see [Merging](#merging)).                                                                                                                                                                         |
| GitHub refused auto-merge or the merge queue. (`armRefused`)                                       | GitHub refused to arm a head that is otherwise ready.                                                                                                                                                                                            |
| GitHub refused the merge. (`mergeRefused`)                                                         | GitHub refused the direct merge of a ready head.                                                                                                                                                                                                 |
| The pull request stayed red for 30 minutes. (`idle`)                                               | Checks failed or changes were requested, and the session that should fix it was idle, stopped or gone for 30 minutes, counted from the later of the last fix request and the start of the idle phase.                                            |
| Checks failed three times. (`failedRounds`)                                                        | The counted checks of a third head failed.                                                                                                                                                                                                       |
| GitHub could not be reached for 30 minutes. (`forgeUnreachable`)                                   | Reading GitHub, or fetching the pull request branch for a repair, failed for 30 minutes in a row. Shorter outages and rate limits only delay the next read. When the last failure was missing or refused access, the reason is `githubRequired`. |
| No coding session settings for the repair session. (`repairUnconfigured`)                          | A pipeline ticket needs a repair, but the sequence has no **Repair session** settings and the project has no coding session to copy them from.                                                                                                   |
| The repair session could not start. (`repairFailed`)                                               | The repair worktree or session could not be created, or the pull request branch has characters outside `A-Z a-z 0-9 . _ / -`.                                                                                                                    |

### Owner actions

A ticket that waits for you blocks the rest of its sequence until you act on it:

- **Retry** starts the fix counters, the merge memory and the 30-minute clocks again.
  An open (or meanwhile merged) pull request is watched again, also when GitHub cannot
  be read right now. A session ticket whose session still runs without a pull request
  is watched again too, with a new six-hour clock; AgentPier never launches a second
  session for it. Otherwise the ticket starts afresh: a new pipeline run, or a new
  session.
  - After a pull request was closed unmerged, the new session gets a new worktree under
    `.worktrees/` (its folder ends in `-a2`, `-a3`…) on a new branch (`…-2`, `-3`…)
    from the freshly fetched default branch. The folder and branch of the closed
    attempt stay for you to inspect; AgentPier never deletes them.
  - In every other case a session ticket reuses the folder of its last attempt when
    that folder is a clean worktree still on the ticket's branch. When the folder has
    local changes, another branch, or was never recorded as the ticket's worktree,
    Retry is refused: check the folder and remove it first.
- **Mark done** moves the sequence on. It writes nothing to the ticket in GitHub or
  Plane. A parked pull request that AgentPier may merge is disarmed first, as with
  **Remove**, because nobody watches it afterwards; a pull request you merged yourself
  needs nothing. A waiting ticket can be marked done too.
- **Remove** takes a waiting, running, parked or done ticket out of the sequence. A
  running ticket's session or run keeps going, but AgentPier no longer watches or merges
  its pull request. A parked pull request that AgentPier may merge is disarmed first:
  auto-merge is turned off, or the pull request leaves the merge queue.

When GitHub cannot be read for such a pull request (an outage, a token that is gone, a
renamed or deleted repository), Mark done and Remove ask once more: auto-merge or the
merge queue may still be on, and the pull request may still merge. **Go on anyway**
finishes the action without disarming; the done ticket, or a line after Remove, then
asks you to check the pull request on GitHub.

A running ticket cannot be retried or marked done, and a ticket waiting for its merge
cannot be retried, marked done or removed. These actions never overlap with AgentPier's own work on the sequence: each
one waits for a running step and is followed by the next step at once.

### Write-back "Done"

When AgentPier sees the pull request merged, the ticket is **Done** and AgentPier writes
to the tracker:

- **GitHub**: closes the issue as completed if the merge did not close it already,
  removes the project's "in progress" label (a label that is gone is fine) and comments
  `Done: merged in <pull request URL>.`
- **Plane**: moves the work item to the first state of the `completed` group (by
  sequence), unless it is in a completed state already (compared by the state's id),
  and comments
  `Done: merged in <pull request URL>.`

The comment names only the pull request, never an AgentPier address. When the tracker
refuses (for example a token without write access), the ticket stays done, the sequence
moves on and nothing is retried; the queue row shows that the write-back failed. **Mark done** writes nothing to the tracker.

### Notifications

When a ticket starts to wait for you, AgentPier sends a push notification of the kind
**A ticket sequence waits for you** (group **Needs you**, on by default; see
[Notifications](notifications.md)). It says only that a ticket sequence waits, never
which ticket or why, and a tap opens the project's Tickets tab. A newer notice of the
same project replaces the older one and alerts again while **Group by session, agent or
run** is on. The notice goes to the owner's devices only.

### Restarts

The sequence lives in `ticket-sequences.json` in the data directory and survives
restarts. About five seconds after AgentPier starts, it carries on with every
sequence where it stopped:

- A session start that was cut off is adopted when a session of the ticket runs in the
  ticket's worktree; its task is sent again under the same delivery id, so the session
  never gets it twice. Without such a session the ticket waits for you
  (`startInterrupted`); AgentPier never launches a second session on its own.
- A pipeline start reserves its run id first, so the run queue starts it at most once.
- A repair session launched just before a restart is found by its folder and reused.
- Fix messages carry ids derived from the ticket and head, so a repeated message is
  dropped.
- The 30-minute clocks and the fix counters are saved, so a restart neither resets
  nor shortens them.

### GitHub permissions

Sequences use the token profile of the project's GitHub host, as the Tickets tab does.
Besides **Issues: read and write** for the ticket and its write-back, a fine-grained
token needs:

- **Pull requests: read and write**: find and read the pull request, turn auto-merge
  on and off, add it to and remove it from the merge queue;
- **Contents: write**: merge, and push the ticket and repair branches;
- **Checks** and **Commit statuses: read**: the check results;
- **Metadata: read** (always granted).

A classic token needs the `repo` scope. Without merge rights the sequence still works
with **Allow merge** off; with it on, a refused arm or merge makes the ticket wait for
you (`armRefused`, `mergeRefused`).

### Live updates and routes

The Tickets tab follows the sequence on the owner-only live topic
`tickets.queue:<projectId>`, which is signalled on every saved change. The routes are
`GET` and `POST /api/tickets/projects/:projectId/queue`,
`POST …/queue/:itemId/retry`, `POST …/queue/:itemId/done` and
`DELETE …/queue/:itemId`; all are owner-only.

### Sequence limits

- At most 50 tickets per start, 200 tickets that are not done per project, and the 50
  most recent done tickets are kept.
- AgentPier reads each pull request about once a minute, and at most 100 of its checks.
- A ticket waits for you after 3 failed check rounds, 30 minutes red with a quiet
  session, or 30 minutes without GitHub.
- The sequence is runtime state like the pipeline run queue: it is not part of
  [backups](backups.md).
- [Label rules](#label-rules) append to the same queue and count towards its 200
  tickets that are not done.

## Label rules

A label rule adds every open ticket that carries a label to the project's
[sequence](#ticket-sequences), once. AgentPier checks the rules on the server every 10
minutes, so labelling an issue `agent` in GitHub, or a work item in Plane, is enough to
queue it; nothing has to stay open in the browser. Like sequences, rules need GitHub
for the pull requests, also for Plane tickets.

Anyone who can set a rule's label can start work on your host: a session or pipeline
run on their ticket text. That includes outside users, for example through a GitHub
issue template or form that applies labels (`labels:`) or a bot that labels new
tickets, so use a label that only trusted people can set. AgentPier treats the ticket
text as untrusted and a rule adds no privilege, but combining such a label with
**Allow merge** means outside input can end up merged. The rule dialog warns while
**Allow merge** is on.

### Adding a rule

The **Label rules** section of the Tickets tab sits below the queue while a source is
connected. **Add label rule**, in the section or through ⌘K/Ctrl+K (**Add label
rule**, which opens the current project's Tickets tab, or the Projects page when no
project is open), opens a dialog with:

- **Source**: **GitHub** or **Plane**, a choice only while both are connected.
- **Label**: the label's name, up to 50 characters, without commas or control
  characters. The match ignores case and surrounding spaces.
- **Run as**, **Repair session** and **Allow merge** (off by default), as in the
  [sequence dialog](#starting-a-sequence): every ticket the rule picks up runs with
  these settings.
- **Paused**: a paused rule picks up nothing until you resume it.

Each row shows the label and source, what the tickets run as, **Allow merge** when it
is on, how many tickets the rule picked up, and its state: **Active**, **Paused** or
**Error**. A paused rule shows **Paused** even when its last pass failed; the error
text stays in the row until the next successful pass. The row's ⋯ menu offers **Edit**,
**Pause** or **Resume**, and **Delete**. A project has at most 20 rules, and one source
and label (ignoring case) have at most one rule. Saving a rule that is not paused
starts a pass right away.

- **Edit** replaces the whole rule. A new source or label clears the rule's error; the
  tickets it picked up stay picked up.
- **Pause** stops the rule's reads. Tickets it already queued stay in the queue. Pause
  and Resume work while the rule's source is not connected, too.
- **Delete** asks first. The rule's tickets stay in the queue and stay picked up, so a
  new rule with the same label never queues them again.

A queue row that came from a rule says **From label rule "<label>"**, or **From a
deleted label rule**.

### How a rule picks tickets

Each pass reads GitHub once per label of the project's rules that are not paused
(GitHub filters by the label itself) and Plane once for all of them, and keeps the
open tickets that carry a rule's label: GitHub issues (pull
requests left out) and Plane work items outside the `completed` and `cancelled`
groups. Tickets that carried the label before the rule existed count too. New tickets
are appended at the end of the queue, oldest first (by ticket number), and the
sequence starts them in turn like tickets you added yourself. Rules of a project are
checked in the order they were created.

A pass reads at most 300 open GitHub issues and pull requests with the rule's label,
the newest (three pages of 100; pull requests count towards the 300 and are then left
out), and 500 Plane work items of any label, closed ones included, before the closed
ones are dropped (five pages of 100). Labelled tickets beyond that are not seen in that
pass. When a read stops at that cap, the row adds a hint ("Only the newest 300 open
issues and pull requests with this label are checked; …" or "Only 500 work items,
closed ones included, are checked; …"). This is
not an error and sends no notification.

The queue holds at most 200 tickets that are not done. When a rule finds more new
tickets than there is room for, it appends what fits and shows **The queue is full**;
the next pass after room is free picks up the rest.

### Dedupe

A rule picks up a ticket once. AgentPier records each pickup (source, key, rule and
queue item) in `ticket-rules.json` and never appends that ticket from a rule again,
also when the label stays on the ticket after its queue item is done and pruned, after
its start record is dropped, after the rule is deleted, or when a second rule with
another label matches it. A ticket that is already in the queue, was started from the
⋯ menu or is being started right now is not appended either; a queued or started one
is recorded as picked up as well, so it stays skipped once those records are gone.
Removing a picked-up ticket from the queue does not make it eligible again.

The rule is read again just before the append: a rule deleted, paused or moved to
another source or label while its source was read appends nothing. Appends run inside
the queue's lock, so a rule and a manual start of the same ticket never both win.

A manual start of a picked-up ticket follows the [single start](#starting-a-ticket)
rules: while the ticket is in the queue and not done, a start or a sequence with it is
refused (`ticketQueued`); afterwards it counts as started before and needs **Start
again**.

AgentPier keeps the 5,000 most recent pickups per project; beyond that the oldest are
dropped first, and such a ticket could be picked up again if it still carries the
label. A damaged `ticket-rules.json` is kept aside as `ticket-rules.json.corrupt-<time>`
and the rules start empty, pickups included: once you add the rules again, labelled
open tickets whose queue items and start records are gone are queued again.

The **N tickets picked up** count of a rule includes tickets it found already in the
queue or started by hand, which it records as picked up so they stay skipped.

### Errors and notifications

A pass that fails sets the rule to **Error** with its reason: the label does not
exist in the ticket source (asked of the tracker itself, so a capped read never reports
it), the queue is full, the source or GitHub is no longer connected, the project no
longer exists, or the tracker's own failure (credentials rejected, not found, rate
limited, unreachable). The rule's status holds only a failure code and its start,
never a token, URL or ticket text. The next successful pass clears the error.

The first failure of each kind sends a push notification of the kind **A label rule
cannot read its tickets** (group **Problems**, on by default; see
[Notifications](notifications.md)). It names neither the rule nor the ticket, and a tap
opens the project's Tickets tab. A source that stays down for many passes notifies
once, and failures that alternate between kinds notify once per kind; a failure of a
kind not yet sent, or of any kind after a successful pass, notifies again. These notices group per project apart from **A ticket sequence waits
for you**, so neither replaces the other on a device. They go to the owner's devices
only.

### Interval

The first pass runs 30 seconds after AgentPier starts, then every 10 minutes, and once
more right after a rule is added, edited or resumed. A pass still running is joined,
never overlapped, and a shutdown aborts the reads under way. The interval can be set in
the data directory's `config.json`: `"ticketRules": { "intervalMinutes": 10 }`, a whole
number from 1 to 1440. An invalid value keeps 10 minutes; a change applies at the next
server start.

### Data and backups

Rules, their status and their pickups live in `ticket-rules.json` in the data
directory. Backups carry it as a public member: the rules with their run settings
(account and connection ids, no credentials) and the pickups. A restore with a project
mapping moves rules and pickups to the new project id and resets each rule's status, so
the restored host starts with fresh checks. See [Backups](backups.md).

The queue (`ticket-sequences.json`) is not in backups, so a restore keeps only the
pickups of tickets that have a start record in the restored `ticket-sources.json` and
drops the ones that point to a queue item. Those tickets were waiting in the old
host's queue; the first pass on the restored host queues them again if they are still
open and carry the label. A ticket that already ran stays skipped through its start
record, and a finished one is closed in the tracker, which a rule never picks up.

A `ticket-rules.json` written by a newer AgentPier version (after a downgrade, or a
restore of a newer backup), or one that cannot be read, never stops the server. The
rules are then off and read-only: no pass runs, every change is refused
(`TICKET_RULES_LOCKED`, 409), the file stays as it is, and the **Label rules** section
shows the reason without **Add**, **Edit**, **Pause** or **Delete**. The server logs
one line, such as `AgentPier ticket-rules: unsupported version=2, rules disabled`.
Running the newer version again, or making the file readable and restarting, turns the
rules back on with their pickups.

### Routes and live updates

The Tickets tab follows the owner-only live topic `tickets.rules:<projectId>`, which
carries `GET /api/tickets/projects/:projectId/rules` and is signalled on every saved
change of a rule, its status or its pickups. The browser never polls the rules; the
server polls the trackers. The routes are `GET` and `POST
/api/tickets/projects/:projectId/rules`, `PUT …/rules/:ruleId` (a full replace,
`paused` included) and `DELETE …/rules/:ruleId`; all are owner-only. A rule needs its
source connected and a GitHub token profile for the project's host
(`ruleGithubRequired` otherwise); a change of `paused` alone needs neither. See [Architecture](architecture.md#live-channel).
