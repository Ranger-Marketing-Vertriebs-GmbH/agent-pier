# Ticket sources

A project's **Tickets** tab lists the open GitHub issues of its repository and the open
work items of a linked Plane project. One ticket at a time starts as a session or a
pipeline run; AgentPier then marks the ticket "In progress" in the tracker, with a link
back to the session or run, and shows the ticket on the session and the run.

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
  `Started in AgentPier: [session](<link>)` or `[pipeline run](<link>)`.
- **Plane**: moves the work item to the chosen **In progress state**, or Plane's first
  state in the `started` group (an item that already is in a `started` state stays),
  and comments `Started in AgentPier: session` or `pipeline run` with the link.

The comments are in English because they live in the tracker. The link uses the
origin of the configured remote URL, else the address the browser used, and points to
`/sessions/<id>` or `/pipelines/runs/<id>`. When the tracker refuses the write-back
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

## Planned

Not available yet: starting several tickets as a sequence, rules that pick tickets by
label, and following the resulting pull request back to the ticket. Queue import by
label is future work too; until then a queue item takes the ticket key as **External
reference** ([Pipelines](pipelines.md#run-queue)).
