# System status

The start page shows a compact **System status** row with three bars: **Disk**, **CPU**
and **RAM**. Select the row to open the details. The dialog names the computer (cores,
RAM and, when known, the platform), shows **Live · every 5 s**, and has three tabs:

- **Load** (the dialog opens here): cards for CPU with the load average, RAM and disk; a
  **History** chart of CPU, RAM and AgentPier's CPU over the last hour or the last 15
  minutes; and **AgentPier's share** of the computer's CPU and of its used RAM. **Break
  down by process** switches to **Processes**.
- **Processes** (with the number of processes): AgentPier's total CPU, RAM and process
  count, and a table of the [processes that belong to AgentPier](#agentpiers-share).
- **Storage** (with how much can be freed, once known, and a warning dot when the disk
  is low): the drive, the [data directory](#data-directory) by area and
  [Free up space](#free-up-space).

The same dialog opens on **Storage** from **Storage** in **Settings › Operations** (the
row shows the free space). **Agents › Runtime › Storage** offers the cleanup of the
agents' installed dependencies.

On a phone the dialog is a bottom sheet: the three tabs fill the row, the content is one
column, the chart is 150 px high and each process is a card.

### History chart

The chart shows one line per series: **CPU** and **RAM** of the computer and
**AgentPier CPU** (dashed), from 0 to 100 %. Each legend button turns its line on or
off. **15 min** and **1 h** pick the time range; 15 minutes is a slice of the same
history. Hatched stretches are times with nothing measured, because no view was open
(points more than 90 seconds apart). Move the pointer over the chart, or focus it and
use the arrow keys (Home and End jump, Escape hides it), for a crosshair with the time
and the values. Screen readers get a summary of the current values and a table of the
last points. Until three points exist, a hint explains that the history fills over the
first hour.

## What the figures mean

| Figure       | Source                                                                                                                                           |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Disk         | `statfs` of the volume that holds the data directory. **Free** is the space an unprivileged process may still write; the rest counts as used.    |
| CPU          | Busy share of all cores between two samples (`os.cpus()` times). The details add the 1, 5 and 15 minute load average.                            |
| RAM on macOS | Used memory as Activity Monitor counts it, from `vm_stat`: app memory (anonymous pages without purgeable ones), wired memory and the compressor. |
| RAM on Linux | Total minus `MemAvailable` (Node's `os.freemem()`).                                                                                              |

On macOS, `os.freemem()` counts only free pages and would show a busy Mac as almost
full, because macOS keeps file cache and inactive pages until they are needed. AgentPier
therefore reads `vm_stat` and counts file cache and free pages as available.

## AgentPier's share

**Processes** lists the processes that belong to AgentPier, each with its whole process
tree, in two groups with a subtotal each: **AgentPier core** and **Sessions · n
running**:

- **AgentPier server:** the server process and its children, such as the protocol
  adapters and MCP servers.
- **Agent gateway:** the managed agent runtime, when agents are enabled.
- **One row per running session:** the coding CLI (Claude Code, Codex, OpenCode) or shell
  started in the session's tmux pane, found through the pane's process ID. Its sub line
  names the tool and the name of the session's folder. **Open** closes the dialog and
  selects the session.

Every row shows its number of processes and bars for CPU and RAM, scaled to the largest
row. **Sort** orders each group by CPU (the default), RAM or name. All agents run inside
the agent gateway; stopped sessions use nothing.

One `ps` call per sample reads every process. CPU is the share of the whole computer
(all cores together) since the previous sample, from the change in each process's CPU
time; on Linux the CPU time comes from `/proc/<pid>/stat` for 10 ms resolution. Memory
is the resident set size (RSS); shared pages count once per process, so the sum can
exceed what the processes really occupy together.

## Data directory

**Storage** shows the drive that holds the data directory (free of total, and a bar of
AgentPier's data, other data and free space) and the data directory by area. The eight
largest areas show first; **n more** shows the rest. Once the
[cleanup summary](#free-up-space) is known, an area's bar marks in the accent colour the
part that a cleanup can free: update backups in **Backups**, old transcripts in **CLI
profiles** and installed dependencies in **Agent workspaces**.

The data directory is measured in the background, never while a request waits, and the
result is kept for ten minutes; until then the card says so, and while it is measured
again it shows the previous sizes with **Updating sizes …**. The walk never follows symbolic links, stays on the data
directory's file system, counts a hard-linked file once and stops after a million
entries or two minutes; a partial result says so. Sizes are allocated disk blocks, like
`du`.

| Area                        | Folders in the data directory                                     |
| --------------------------- | ----------------------------------------------------------------- |
| CLI profiles                | `profiles`                                                        |
| CLI installations           | `clis`                                                            |
| Toolchains and MCP packages | `toolchains`, `mcp-packages`                                      |
| Agent runtimes              | `assistants/runtimes`                                             |
| Backups                     | `operations/backups`, `operations/restores`, `assistants/backups` |
| Chat attachments            | `chat-attachments`                                                |
| Agent attachments           | `assistants/workspaces/<agent>/attachments`                       |
| Agent shares                | `assistants/shares`                                               |
| Agent workspaces            | the rest of `assistants/workspaces`                               |
| Logs                        | `server.log`, `server-error.log`, `assistants/logs`               |
| Other                       | everything else                                                   |

The response names only these areas, never a path.

## Free up space

Beside the areas (below them on a phone), **Free up space** offers three cleanups with
"Up to … can be deleted". Each card shows what its group can free, how many entries it
holds and what deleting costs. These sizes come from a summary that the server measures
in the background like the data directory, keeps for ten minutes and measures again
after every deletion; until it is known, the cards say **Measured on open**. The
summary counts the update backups except the one an unresolved recovery needs,
transcripts older than 90 days (the age the list preselects), and every installed dependency folder (an agent at
work included). The list behind **Clean up …** is measured only when you open it, never
with the five-second refresh, and nothing is deleted without its selection and
confirmation. Every
deletion asks first in a confirmation that names what goes away and how much space it
frees; only the owner can run it, one cleanup at a time, and the **Activity log**
records it as `storage.deleted` with the area, the number of entries removed or skipped
and the bytes freed, never a path, a name or any content. A refused or failed cleanup
is recorded as well, with its area and the refusal's code. The result names how much
was freed and how many entries stayed because they changed meanwhile or were in use.

| Cleanup                          | What it lists                                                                                | What may go                                                                                                                                            |
| -------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Update backups**               | Each agent runtime update backup with its date, size and update (`2026.10.3 → 2026.10.7`)    | One backup and its key. Refused while an update, a rollback or a recovery runs or may still need a backup; the backup of an unresolved recovery stays. |
| **Transcripts in CLI profiles**  | Per Claude Code and Codex profile: transcripts last changed more than 30, 90 or 180 days ago | Those transcripts, except every session AgentPier still knows.                                                                                         |
| **Installed agent dependencies** | Per agent: the `node_modules` folders in its workspace and their size                        | Every `node_modules` folder of that workspace while the agent is idle.                                                                                 |

**Update backups.** Deleting one removes the backup and its key the way
[retention](assistant-runtime-updates.md) does. The way back to the agent runtime from
before that update goes away: AgentPier can no longer restore the agents' state and
runtime from before it.

**Transcripts.** AgentPier looks in each managed profile's own CLI folder and in those
of its provider choices (`profiles/<id>/<tool>` and
`profiles/<id>/providers/<provider>/<tool>`):

- Claude Code: `projects/<folder>/<session id>.jsonl`, together with the session's
  folder beside it (subagent transcripts and tool results). The prompt history
  (`history.jsonl`), the project's `memory/` folder, `file-history/`, `todos/`,
  `session-env/` and every other file stay.
- Codex: `sessions/YYYY/MM/DD/rollout-*.jsonl` and `archived_sessions/rollout-*.jsonl`.
  Codex also indexes its threads in its own SQLite databases (`state_*.sqlite`,
  `thread_history_*.sqlite`), whose layout changes with Codex releases; AgentPier never
  writes them, so Codex may still list a deleted thread without its history.
- OpenCode keeps its sessions in its own database and is not offered.
- Local profiles use the CLI's folder in your home folder and are not offered either.

A transcript goes only when it and its session folder were last changed before the
chosen age and no stored AgentPier session, chat binding, native-session record, pipeline run or
AgentBus record names its id. Sessions in the **Sessions** list, running or stopped,
therefore keep theirs and can be resumed; a running session's transcript is also
always newer than the cutoff. The records are read again for each profile and every
few seconds during a deletion. If one of those records cannot be read, nothing is
deleted. Each file is checked again just before it goes. A deleted session can no
longer be resumed, and its history is gone.

**Installed dependencies.** Every folder named `node_modules` in the agent's
workspace (`assistants/workspaces/<agent>`) goes; a link named `node_modules` and
everything outside the workspace stay, and `.git` and `.agentpier` (the agent's secrets)
are never searched. The deletion is refused while the agent has a
turn in flight, a team task, a long-chat summary or an approved action running, and
while any process of your user has its working folder inside the workspace (a
background command, a dev server). Each entry is looked at and removed in its parent
folder as opened, never through a link (`project-open.js`), so a folder swapped for a
link cannot redirect the deletion. Each folder is first renamed in its parent to
`.node_modules-deleting-<random>` in one step, so the agent never finds a half-deleted
`node_modules`, and is then deleted; the checks above run again before each folder,
and a folder found busy stays. A deletion a restart interrupted is finished when
AgentPier starts. Agents that serve restricted [users](users.md) are not listed and
their workspaces are refused like their chats; with agents turned off no workspace is
offered, because whose it is cannot be told. The agent installs its dependencies again when a
project needs them.

Host backups (`operations/backups`) are deleted under **Settings › Operations ›
Backups** instead ([backups](backups.md)).

After a cleanup the data directory and the summary are measured again the next time
the details are open.

## Refresh and cost

The start page and the details ask for new figures every five seconds while the page is
visible. The server then samples every five seconds and returns to its background pace
30 seconds after the last request. In the background it takes one sample a minute (CPU
and memory of the computer and of AgentPier's processes: one `ps` call, plus `vm_stat`
on macOS and one tmux listing), so the sparkline covers the whole last hour even when
nobody looked. The data directory and the cleanup summary are walked only while the
details are open. A disk check runs every ten minutes for the warning below, and every
sample stops at shutdown. Points more than 90 seconds apart, such as after a restart,
break the line and are hatched.

## Low disk space

When less than 10 % of the data directory's volume is free, the start page and the
**Storage** tab show a warning and AgentPier sends one **Disk space is low** push notification to the devices
that [receive notifications](notifications.md). The warning clears when at least 12 % is
free again; a disk that hovers around the threshold does not notify again, and neither
does a restart during the same low-space episode.

## Sessions on the old tmux server

AgentPier was formerly called "tuiui". A tmux server that a release from before the
rename started keeps running across updates, and AgentPier keeps using it while one of
its sessions runs there, so no session is lost. Until then, the start page above the
**System status** row and the **Sessions** list in the sidebar show a notice such as
**2 sessions still run on the old tmux server** with the text "Stop these sessions when
convenient; AgentPier then starts new sessions on the new server." and the names of
those sessions. Stop them whenever it suits you (**Stop session**); new sessions join
the old server until the last one there has stopped. The next session then starts on
the new server, and the notice disappears. AgentPier never ends a running session; it
ends the old server once only finished AgentPier sessions remain on it (no live process
in any of their windows or panes), after recording
their exits and last screens. A session on it that AgentPier did not start keeps the old
server running. A session whose CLI has ended but that still has an extra window or
pane with a live process, for example one the agent opened from its shell, shows as
stopped in the list but still counts in the notice; **Stop session** ends it. See
[architecture](architecture.md) for the details.

## API

`GET /api/system-status` returns the bars, the warning and the sessions on the old tmux
server (`legacyTmux.sessions`, id and name only), and
`GET /api/system-status/details` adds the host platform (`host.platform`, such as
`darwin` or `linux`, or `null`), processes (sessions with their id, name, tool and folder
name), history and data areas. Both require the workspace login like every other `/api`
route.

The cleanups live under `/api/system-status/cleanup` and are owner-only:
`GET update-backups` and `DELETE update-backups/<id>`, `GET transcripts` and
`POST transcripts/<profile>` with `{ "olderThanDays": 30 | 90 | 180 }`, and
`GET dependencies` and `DELETE dependencies/<agent>`. A deletion answers with the
number of entries removed and skipped and the bytes freed. `GET summary` answers at
once with `{ state: "pending" }` or `{ state: "ready" | "refreshing", computedAt,
groups }`, where `groups` holds `updateBackups` (`bytes`, `count`, `blocked`,
`atLeast`, `oldestAt`), `transcripts` (`bytes`, `count`, `olderThanDays`, `profiles`)
and `dependencies` (`bytes`, `count` of folders, `agents`, `atLeast`); `atLeast` marks a
measurement that stopped at its bound.
