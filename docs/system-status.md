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
- **Agent Gateway:** the managed agent runtime, when agents are enabled.
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
visible. The server samples only while someone looks and stops 30 seconds after the last
request. The sparkline therefore shows the last hour of the times the status was open;
gaps break the line. Without viewers, only a disk check runs every ten minutes for the
warning below.

## Low disk space

When less than 10 % of the data directory's volume is free, the start page shows a
warning and AgentPier sends one **Disk space is low** push notification to the devices
that [receive notifications](notifications.md). The warning clears when at least 12 % is
free again; a disk that hovers around the threshold does not notify again, and neither
does a restart during the same low-space episode.

## API

`GET /api/system-status` returns the bars and the warning, and
`GET /api/system-status/details` adds processes, history and data areas. Both require
the workspace login like every other `/api` route.
