# Inbox

The **Inbox** (German **Eingang**, "Waiting on you") collects every decision that
waits for you, wherever it came from, so you do not have to visit each chat, run and
agent to find it. It sits in the sidebar directly under the brand with a live count; on
a phone the header shows an inbox icon with the same count. The sidebar **Menu** does not
repeat it. **Agents › All agents** shows how many agent approvals wait, with a link to
the **Agents** tab here. The start page shows the first items under **Needs you**, and
each card opens its item here (see [start page](system-status.md#start-page)).

## What it lists

| Tab           | Items                                                                                                                                                                                                                                                                                                |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Questions** | Questions a coding CLI asks in a running session (Codex, Claude Code, OpenCode)                                                                                                                                                                                                                      |
| **Approvals** | Permission requests of a coding CLI in a running session, such as a tool call, a workspace trust, Codex hooks or a Claude startup or auto mode dialog                                                                                                                                                |
| **Gates**     | Pipeline runs that wait for a human decision at their current stage                                                                                                                                                                                                                                  |
| **Agents**    | Agent requests that wait for approval (shell and SSH commands, coding tasks, memory entries, team member permissions, emails to send, hook and SSH access proposals), team proposals, the [memory review after a model switch](agents.md#memory) and [unresolved agent work](#unresolved-agent-work) |

**All** shows everything; every tab shows its count. Items about to expire (within 15
minutes, such as an agent's shell command) come first, soonest first; everything else
follows with the longest waiting first.

## Answering

Select an item to open it in the detail pane. The pane shows the same card you would
see in place: the native question or approval from the session's chat, the gate
decision from the run (with the run's spec when it has one, see
[pipelines](pipelines.md#spec-and-acceptance-criteria), the risky paths of a risk gate or why its check could not run,
see [pipelines](pipelines.md#risk-gate), the tokens a run reported against its budget with
**Raise budget and continue**, see [pipelines](pipelines.md#token-budget), and a stage's question for you; for a
[parallel review group](pipelines.md#parallel-review-groups) the members that wait for a
decision and the group's own restart or override, while decisions on a single member are
made in the run view), the agent's
approval card, the
team proposal or the memory review card. Answering there
has the same effect as answering in place, because the card uses the same endpoint and
the same checks. **Open in context** opens the session chat, the run or the agent's
chat instead. The list has no quick actions; a decision is always made on the full
card.

Answered or expired items leave the list without a reload. Every item has a stable
address, `/inbox/<type>/<id>`, where the type is `question`, `approval`, `gate`,
`action`, `team`, `memory-review` or `unresolved`. An address of an item that no longer waits shows **Already done**
with the decision and its time when the audit log recorded it within the last 24 hours,
and **No longer waiting** otherwise (for example after the CLI dialog was answered in
the terminal long ago, or an approval expired). A native request that ended without an
answer from AgentPier says why: answered in the terminal, the CLI moved on to a later
step, the CLI stopped asking, the session ended, or it expired and the CLI asks in its
own terminal dialog now.

## Memory review after a model switch

When an agent's model changes and its chats start fresh, the new model reviews the
agent's memory. If it finds entries that only record what an earlier model refused or
limited itself, the **Agents** tab shows one card **Memory after a model switch** for the
switch (type `memory-review`). It lists the entries with their file, each set to
**Archive** or **Keep**; **Apply** carries out your choices (the card then reads
**Applied**). Only you see and decide it; see [Memory](agents.md#memory).

## Unresolved agent work

Agent work that has not moved for more than 24 hours shows on the **Agents** tab as
**Unresolved work**, so you find it before it blocks an OpenClaw update
([runtime updates](assistant-runtime-updates.md#blocker-items)):

- **Telegram input still open**: an input in an agent's Telegram channel that was
  neither delivered nor reviewed, such as one stuck in "Outcome reviewed in chat".
  It links to the agent's **Channels › Telegram activity**, where **Acknowledge
  without resending** closes it without sending anything.
- **Chat turn with unknown outcome**: an uncertain or interrupted turn nobody
  reviewed. It links to the chat.
- **Agent action without progress**: an action approved, executing, running or of
  unknown outcome that has not changed for a day. It links to the agent's chat.

The day is counted from the input's or turn's arrival and from the action's last
change. The card says what to do and **Open in context** opens the place; the inbox
itself changes nothing. The item leaves as soon as it is resolved there, like every
other item, and its address then shows **No longer waiting**. A user's own chats and
Telegram channel stay with that user and never appear in the owner's inbox.

These items send no push notification. They are reminders of work that already
waits elsewhere, not new decisions, and several can appear at once after a day; a
push for each would be noise. No existing event fits either: **Agent approval** means
a new request to decide, and **Problems** are host or session failures
([notifications](notifications.md#what-notifies-you)). They do count in the inbox
badge and the installed app's badge.

## Claude Code approvals and plans

A Claude Code tool approval offers **Allow once**, **Deny** and, when Claude proposes
a "don't ask again" rule for the call, **Always allow**. The card lists the rules
before you decide, for example `Bash(npm test:*)`. Always allow saves them as allow
rules in the user settings of the session's Claude account (`settings.json` in its
own `CLAUDE_CONFIG_DIR`), so they apply to that account in every project and never to
another account. Rules are never written to a project's `.claude/` folder, which
every account opening the folder would share. Remove a rule with `/permissions` in
the terminal or in that `settings.json`.

When a subagent asks, the card names it (a session started with `--agent` asks as
the main agent and shows no such line), for example **From the general-purpose
agent**. A subagent's approval waits in chat as long as the main agent's, and
approving or denying it in the terminal removes the card.

When Claude leaves plan mode (`ExitPlanMode`), the card shows the proposed plan as
Markdown with **Approve and auto-accept edits**, **Approve and review each edit** and
**Keep planning**. Approving switches the session to the chosen permission mode for the
rest of the session; Keep planning stops Claude in plan mode so you can send feedback
in chat. Switching the permission mode outside such a plan approval stays in the
terminal (Shift+Tab).

## Remembered and default approvals

Every CLI tool approval (Claude Code, Codex and OpenCode) also offers **Always allow
<what> in this session** and **Always allow <what> in this project**. For a shell
command, <what> names its programs, with the subcommand for programs such as `git`,
`npm` or `docker` (`rm`, `git push`); for any other tool it is the tool
(`WebFetch`, `Edit`, Codex file changes). AgentPier keeps the approval itself, per
CLI, and answers the next matching request with the CLI's "allow once" without a card:
a shell command matches when every program in it is remembered or on the default list
below. A session approval lasts until the session is removed (stopping or reloading it
keeps it); a project approval applies to every session in a folder of the project,
worktrees included. The project's **Approvals** tab lists both and removes them, after
which the CLI asks again. Only you can remember an approval; an agent answering for you
allows the single call. Plans, questions, startup screens and Codex's requests for more
sandbox permissions are never remembered.

Some requests need no card at all. The list lives in one constant,
`DEFAULT_ALLOWED` in `server/features/requests/cli-approval-defaults.js`:

- the Claude Code tools `EnterWorktree` and `ExitWorktree`;
- in a Claude Code session started with AgentBus, the two AgentBus tools that only
  read: `peers_list` and `inbox_read`, under the full names Claude Code gives the
  tools of AgentPier's plugin
  (`mcp__plugin_agentpier-agentbus_agentpier_agentbus__peers_list` and
  `…__inbox_read`). The name is compared whole, so `peer_send` still asks, and so
  does a tool of the same short name from another MCP server
  (`mcp__other__inbox_read`) or in a session without AgentBus. The name is what
  Claude Code reports, not proof of where a tool comes from: a plugin and server
  configured under the same two names would be answered the same way. Codex
  approves MCP tools in its own terminal, and OpenCode's AgentBus tools are not on
  the list;
- read-only git in a repository of the project: `git status`, `log`, `diff`, `show`,
  `rev-parse`, `fetch` and `git branch` when it only lists branches, optionally after
  `-C <dir>`. Each subcommand has a list of the options that only choose what is
  read or how it is printed (`git-read-options.js`: `--oneline`, `--stat`, `-p`,
  `--since=…`, `--format=…`, `--cached`, `--porcelain`, `--prune`, `--tags` and many
  more). An option outside that list asks, and so does an abbreviation (`--onel`),
  because git accepts any unique abbreviation of options that write files or run
  programs (`--output`, `--upload-pack`, `--ext-diff`). A format with a signature
  placeholder (`%G?`) asks like `--show-signature`. `git fetch` only updates
  remote-tracking refs: it names a remote and, if any, plain branches
  (`git fetch origin main`, `git fetch --all --prune`). A path or URL, a refspec
  (`main:main`, `+…`, `refs/…`), `--force`, `--prune-tags`, `--refmap` and the
  shallow and filter options ask, and so does a remote whose name is also a folder
  where the command runs;
- `grep`, `cat`, `head`, `tail`, `ls`, `wc`, `rg` with its search and output options
  (`rg-read-options.js`; `--pre`, `--hostname-bin`, `-z`, `-f` and unknown options
  ask), and `sed` without
  `-i` whose script only prints, deletes lines or substitutes without the `w` and `e`
  flags;
- `npm test`, `npm run test*`, `npm run lint` and `npm run check` in the project,
  with no npm option before `--` other than `--silent`, `--quiet` or `--if-present`
  (`--prefix`, `--workspace` or `--script-shell` ask; what follows `--` goes to the
  script);
- `cd <dir>` into a folder of the project.

`git`, `npm` and `cd` are answered this way only inside the session's project,
because git obeys the configuration of the repository it stands in and `npm test`
runs what that folder's `package.json` says. The project is the session's folder,
the Git work tree around it and the repository's other work trees: the main one with
its `.worktrees/` and every linked one. AgentPier follows `cd` through a chain and git's
`-C`, starting from the folder the CLI reports for its shell, and resolves symbolic
links: `cd web && npm test` and `git -C .worktrees/feature status` run,
`cd ../other && npm test`, `git -C /other/repo diff` and a plain `cd /tmp` ask. The
programs that only read files are not bound to the project (`cat /etc/hosts` runs).
For git the folder must also belong to one of the project's own repositories: a
nested repository, a submodule or a bare repository inside the project has its own
configuration and asks. `cd -`, `cd +1` and chains of more than 20 parts ask.

The shell expands some words after AgentPier read them, so a word with an unquoted
`*`, `?`, `[…]`, `{a,b}` or a leading `~` is judged by what it can become:

- braces are expanded first, and every check reads the words that result
  (`cat src/{a,b}.js` runs, `cat ~/.s{s,}h/config` asks, and a brace form that
  yields an option is judged as that option); a sequence such as `{1..3}` counts
  as `*`;
- `~` alone or before `/` is your home folder and is checked like any path;
  `~name`, `~+` and `~-` ask;
- a pattern with a `..` part asks;
- `ls` and `wc` show names and sizes only, so any other pattern runs with them
  (`ls src/*`, `ls -d */`, `wc -l src/*/*.js`); a secret named as written still asks
  (`ls ~/.ssh`);
- for the programs that print what files hold (`cat`, `head`, `tail`, `grep`, `rg`,
  `sed`, and git with a path), a pattern asks when a part of it (between `/`) holds
  a wildcard and starts with a dot (`.s?h`, `.e*`), or when its last part could
  match a key or credentials file: a key by its ending (`*.pem`, `*.key`, …),
  `id_rsa` and its relatives, a file named `credentials`, `secrets`, `token`,
  `passwords` and the like, alone or as a data file (`secrets.yml`, `token.json`),
  or any name around a secret word of which the pattern writes out at least three
  characters (`my-s?cret.txt`, `*oken`). So `cat src/*.js`,
  `grep -n foo src/*/*.js`, `cat packages/*/package.json` and `cat package*.json`
  run, while `cat *`, `cat docs/*`, `cat README*`, `cat *.json` and `cat id_*` ask,
  because each of them could also match such a file;
- `git`, `rg`, `sed` and `npm` read options among their arguments, so a pattern
  that starts with a wildcard asks before `--` (`rg foo *.js`; a file could be named
  like an option), while `git diff -- *.js` runs;
- quoted characters are literals: `grep 'a*b' file` and `rg "foo{1,2}"` run;
- a parenthesis anywhere in a word asks (zsh glob qualifiers can run code);
- a command line with more than 32 pattern words, 128 pattern characters or 512
  words made by braces is not judged and asks;
- a word with a line break, tab or other control character inside quotes is not
  answered from this list, but a remembered approval covers it (a commit message
  of several lines with `git commit` remembered).

A command needs no card only when every part of a `;`, `&&`, `||` or `|` chain is on
this list or covered by a remembered approval (`cd sub && git status` runs, `cd sub &&
rm x` asks unless `rm` is remembered), and it has no command substitution, variables, redirection into or out of a file, background
job, subshell or leading `NAME=value`. Discarding output (`2>&1`, `>/dev/null`) is
fine. A command that names a secret or credentials file (`.env`, `.envrc`, `.ssh/`,
keys, `credentials`, tokens, passwords, shell history, `.docker/config.json`,
`.config/gh/hosts.yml`, `.config/sops`), also as the path of `git show HEAD:<path>`,
always asks, as do `rm`, `ssh`, `scp`, `sftp`,
`git push` and other writing git commands and package installs; you can remember
these once you approved them. A remembered program or tool never covers a secret: with
`cat` remembered, `cat README.md` runs but `cat .env` shows a card, and remembering
from that card covers exactly `cat .env` (or, for a tool such as `Read`, exactly that
path), not `cat secrets/other.key`. The same holds for a brace form that names a
secret (`cat ~/.s{s,}h/config`), a pattern for a dot name (`cat .e*`) and a pattern
that writes out part of a key or credentials name (`cat id_*`, `rm cred*`,
`cat certs/*.k*`): each is remembered exactly as written. Ordinary patterns stay
covered by the remembered program, also those the default list asks for because
they merely could match such a file: with `rm` remembered, `rm -rf dist/*`,
`rm keys/*` and `rm *.json` run.

The audit records how a request was allowed: `allow` once, `allow-session` and
`allow-project` for remembered approvals (and for the CLI's own session approval),
`allow-always` for Claude's account rules and `allow-default` for the list above;
requests AgentPier answered itself carry `auto: true` and create no card or
notification.

## Questions an agent escalates

A coding session that an agent started (**Started by agent <name>**) shows its open
questions and approvals in the inbox like any other session. When the agent hands one to
you with a note, the item is marked **Escalated by <agent>** and shows the note; the
agent's chat shows the same prompt as the card **Question from a coding session**, and
the inbox hides that card's action so nothing appears twice. Whoever answers first wins:
you in AgentPier or Telegram, or the agent. Until the agent escalates a prompt, its push
notification is held for up to 15 minutes ([notifications](notifications.md#what-notifies-you)),
but the item is listed at once ([coding sessions](assistant-workflows.md#coding-sessions)).

## Questions from rebuilds

A [Craft Anything rebuild](craft.md) that waits for you lists its question as
**Question from a rebuild** or its approval as **Approval for a rebuild**. Answering
here and on the rebuild's page is the same: the first answer wins. A paused rebuild
lists none; **Continue** asks them again. In auto mode the
questions are decided by Craft Anything and approvals are allowed by AgentPier, so they
do not appear, except an approval AgentPier failed to allow three times in a row.

## Waiting sessions

A session in the sidebar shows **Waiting** while one of its native requests is open,
the same requests the inbox lists; the CLI's own activity reports and the terminal
screen decide only when none is open (see [architecture](architecture.md)).

## How it works

- `GET /api/inbox` returns `{ instance, revision, counts, items }`. Each item has
  `type`, `id`, `tab`, `kind`, `source` (`{ kind, id, name }` of the session, run or
  agent), `title`, `createdAt`, `expiresAt` and `link` (the in-context page). Items
  carry no command lines; the cards load them from their own endpoints, and a
  waiting run's card and an agent's request card follow the run's and the agent's
  live topics (`pipeline.run:<id>`, `agent.actions:<id>`), so a decision made
  elsewhere shows at once.
- The live channel's `inbox` topic (owner only) pushes the same value as
  `GET /api/inbox` whenever the waiting set changes; the start page's **Needs you** and
  the inbox page take their list from it and send no request of their own while the
  channel works. Restricted users cannot subscribe to it. A hidden tab keeps the
  subscription, so the counts are current when it is shown again. Without the live
  channel the page polls `GET /api/inbox` every 5 s while its tab is visible (see
  [live channel](architecture.md#live-channel)).
- There is no inbox event stream: `GET /api/inbox/events` was removed and answers 404.
  The `inbox` topic is the only push. The workspace state (the live `state` topic and
  `GET /api/state`) carries the counts and revision for the sidebar count; while the
  channel works, the inbox page waits for the topic's list when that revision is ahead
  and sends no extra request. Without the channel it reads `GET /api/inbox` again.
- `GET /api/inbox/<type>/<id>` resolves a stable address to `pending` (with the
  item), `done` (from the audit log, for 24 hours) or `gone`.
- The inbox only reads. It is part of the owner's login like every other page; it
  never answers on its own and adds no new way to decide.

The server side lives in `server/features/inbox/` (sources, items, history) and
`server/http/routes/inbox.js`; the page lives in `web/features/inbox/`. A push
notification about a waiting item opens the place where it waits with its card (the
session chat, the agent chat or the pipeline run, as **Open in context** does), and
only an item without such a place opens its inbox address; the installed app's badge
shows the inbox count; see [notifications](notifications.md). When your
notifications reach no device, or the last delivery failed on all of them, the inbox
shows a warning above the list ([keeping devices
registered](notifications.md#keeping-devices-registered)).
