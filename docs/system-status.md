# System status

The start page shows a compact **System status** row with three bars: **Disk**, **CPU**
and **RAM**. Select the row to open the details: the computer's figures, a sparkline of
the last hour, AgentPier's own share of CPU and memory, and the size of its data
directory by area.

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

The details list the processes that belong to AgentPier, each with its whole process
tree:

- **AgentPier server:** the server process and its children, such as the protocol
  adapters and MCP servers.
- **Agent gateway:** the managed agent runtime, when agents are enabled.
- **One row per running session:** the coding CLI (Claude Code, Codex, OpenCode) or shell
  started in the session's tmux pane, found through the pane's process ID.

One `ps` call per sample reads every process. CPU is the share of the whole computer
(all cores together) since the previous sample, from the change in each process's CPU
time; on Linux the CPU time comes from `/proc/<pid>/stat` for 10 ms resolution. Memory
is the resident set size (RSS); shared pages count once per process, so the sum can
exceed what the processes really occupy together.

## Data directory

The data directory is measured in the background, never while a request waits, and the
result is kept for ten minutes. The walk never follows symbolic links, stays on the data
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

## Refresh and cost

The start page and the details ask for new figures every five seconds while the page is
visible. The server then samples every five seconds and returns to its background pace
30 seconds after the last request. In the background it takes one sample a minute (CPU
and memory of the computer and of AgentPier's processes: one `ps` call, plus `vm_stat`
on macOS and one tmux listing), so the sparkline covers the whole last hour even when
nobody looked. The data directory is walked only while the details are open. A disk
check runs every ten minutes for the warning below, and every sample stops at shutdown.
Points more than 90 seconds apart, such as after a restart, break the line.

## Low disk space

When less than 10 % of the data directory's volume is free, the start page shows a
warning and AgentPier sends one **Disk space is low** push notification to the devices
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
ends the old server once only finished AgentPier sessions remain on it, after recording
their exits and last screens. A session on it that AgentPier did not start keeps the old
server running. See [architecture](architecture.md) for the details.

## API

`GET /api/system-status` returns the bars, the warning and the sessions on the old tmux
server (`legacyTmux.sessions`, id and name only), and
`GET /api/system-status/details` adds processes, history and data areas. Both require
the workspace login like every other `/api` route.
