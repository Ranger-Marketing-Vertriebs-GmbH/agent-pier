# Task control in the background tasks sheet (PR 2 of 2)

Working document; delete before the pull request opens.

## Intent

PR 1 (#763) gave the chat a "Background tasks" sheet that lists a session's subagents
and to-dos. The owner wants what the Claude mobile app offers on each entry: read a
subagent's transcript, stop a single running task, and see background shell commands
as entries of their own. It must work for Claude Code, Codex and OpenCode, each as far
as that CLI really supports it, never faked.

## Goals

- **Transcript.** Every subagent card has "Show transcript". It opens that subagent's
  own conversation, read-only, in the sheet.
- **Shells.** Background shell commands appear as cards of kind "Shell" in Running and
  Completed, with their command, status and (Claude Code) their output.
- **Stop.** A running card has a stop button where the CLI can stop exactly that task
  without a chat message to the model. The button is absent where it cannot.
- **The main agent learns of a stop** through one line attached to the owner's next
  chat message, never through a turn of its own.

## Non-goals

- OpenCode background subagents. They need
  `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS`, which AgentPier does not set; this
  change does not set it either.
- OpenCode shells: OpenCode 1.19.5 has no background shell commands.
- Stopping the main turn, monitors or workflows.
- Any terminal key emulation (tmux send-keys) to stop a task.
- Sessions on a remote host that AgentPier does not run itself.

## Anti-goals

- A stop button that sometimes stops something else, or everything. Claude Code's own
  key (`ctrl+x ctrl+k`) kills all agents; it is not a fallback.
- A stop that silently fails. A stop that the CLI refuses shows its reason on the card.
- Timed polling from the browser.

## What the live spike established (2026-11-16)

Run against Claude Code 2.1.325, Codex 0.164.0 and OpenCode 1.19.5 in an isolated
instance. Observed, not inferred, unless marked.

**Claude Code**

- A subagent's transcript is `<projectDir>/<sessionId>/subagents/agent-<agentId>.jsonl`
  (+ `.meta.json`); records are shaped like the main transcript with
  `isSidechain: true`, mixed with `api-request*` records to skip. The repo already
  reads these files for token usage (`claude-subagent-usage.js`).
- A background shell is a Bash call with `run_in_background`; its result carries
  `toolUseResult.backgroundTaskId` and names the output file
  (`<tmp>/claude-<uid>/<project-slug>/<sessionId>/tasks/<taskId>.output`, a tmp path
  that a reboot clears). Completion is a `task-notification` record with `task-id`,
  `status` (`completed`, `failed`, `stopped`, `killed`) and a summary that holds the
  exit code as text.
- From AgentPier's mod, `$.tool.call({ tool: "TaskStop", task_id })` stops one shell or
  one agent in 5-18 ms, idle or mid-turn, and returns
  `{ message, task_type: "local_bash" | "local_agent" }`; an unknown or finished id
  returns `{ isError: true, result: "Error: No task found with ID: …" }`.
- A stopped shell leaves no transcript record and the model is not told. A stopped
  agent produces a `killed` notification that wakes the model for a turn; a
  `prompt.submit` hook that returns `{ drop }` for that notification prevents the turn
  (the TUI then shows "Prompt dropped by a hook: <reason>").
- The Stop hook's `background_tasks[]` (`id`, `type`, `status`, `command`, …) uses the
  same ids as the transcript. `$.agent.list()` lists agents only.
- The mod has no inbound command path today; the spike polled a local helper.

**Codex**

- A subagent is a thread of its own. The session's app-server connection receives the
  child's `turn/started` (own `turn.id`) and items without subscribing; the parent gets
  `subAgentActivity` items with `agentThreadId` and `agentPath`.
- `thread/read` / `thread/items/list` from a second app-server process return the
  child's items, but only completed ones; while the child runs that process reports it
  `notLoaded` with no items. Reading disturbs neither thread.
- `turn/interrupt {threadId, turnId}` on the session's connection ends the child's turn
  (`status: "interrupted"`). A command the child was running keeps running. The parent
  is not told and its `wait` runs to its timeout. From a second process the call fails
  (`thread not found`).
- Background terminals: `commandExecution` items with `source: "unifiedExecStartup"`
  stay `inProgress` after their turn. `thread/backgroundTerminals/list` and
  `/terminate {threadId, processId}` work on the session's connection only and need the
  `experimentalApi` capability; terminate returns `{terminated: true}`, then
  `item/completed` with `status: "failed"`, `exitCode: -1`. A child's terminals belong
  to the child's thread id. The model is not told.
- Not tested: whether the connection AgentPier shares with the Codex TUI
  (`codex-proxy.js`) was initialised with `experimentalApi`, and injecting AgentPier's
  own requests into that connection. `codex-proxy.js` originates no request today.

**OpenCode**

- A subagent is a child session (`task` tool part `metadata.sessionId`). Its messages
  are current while it runs, and its `directory` equals the parent's.
- `POST /session/{child}/abort` stops the child only: the child's assistant message
  gets `error.name: "MessageAbortedError"`, the parent's task part becomes
  `status: "error"`, `error: "Task cancelled"`, and the parent turn goes on and
  finishes. Aborting the parent cascades to children.
- AgentPier's TUI plugin has the SDK client (`api.client`) and a native request
  channel to AgentPier, which today only carries answers to requests the plugin
  published.

## Approaches

1. **Everything the spike verified, in one pull request (picked by the owner).**
   Transcript for all three, shells for Claude Code and Codex, stop for all three,
   shown only where supported.
2. Read side first (transcript, shells), stop in a third pull request. Faster, but no
   stop buttons for now.
3. As 1 without stopping Codex subagents, whose parent waits into its timeout.

For telling the main agent about a stop the owner picked **a line on the next
message** over staying silent or reporting at once (which costs a turn each time).

## Design

### Data the browser gets

`observability` (the chat frame) keeps `subagents[]` and gains what the sheet needs:

- every subagent entry: `canStop` (boolean) and `hasTranscript` (boolean);
- a new `shells[]`: `{ id, command, description?, status, exitCode?, startedAt?,
updatedAt, ownerAgentId?, canStop, hasOutput }`, statuses `running`, `completed`,
  `failed`, `stopped`, `unknown`. Bounded like subagents (100 entries, command text
  1,000 characters).

`canStop` is true only when the task is running, the session is live (not stale,
stopped or restored), and that session's command channel (below) is connected. The
server decides it; the browser only renders it.

### Reading

- `GET /api/sessions/:id/tasks/:taskId/transcript` returns the subagent's messages in
  the chat's own message shape, so the sheet renders them with `ChatTranscript`.
  Bounded to the newest messages with the same caps as chat history; no paging in
  this change (state "showing the latest N" when cut).
  - Claude Code: the `subagents/agent-<id>.jsonl` file through the existing Claude
    history parser, accepting sidechain records for this one file.
  - Codex: the child thread through the existing history client (its method allowlist
    gains what the read needs, e.g. `thread/items/list`); the two guards that
    reject child threads are relaxed for an id that the session's own spawn tree
    contains. While the child runs, the answer may hold only finished steps; the
    response says `partial: true` and the sheet says so.
  - OpenCode: the child session through the existing reader, for an id whose
    `parentID` is the session.
- `GET /api/sessions/:id/tasks/:taskId/output` (Claude Code shells) returns the tail
  of the output file (bounded, 256 KiB), or `gone: true` when the tmp file no longer
  exists.
- Both routes accept only ids that the session's current observability lists. The
  authorization equals reading that session's chat.

### Stopping

`POST /api/sessions/:id/tasks/:taskId/stop` answers `{ stopped: true }` or an error
with a stable message key (`unsupported`, `notRunning`, `channelDown`, `refused`
with the CLI's reason, `timeout` after 10 s). The authorization equals sending input
to that session. Each CLI gets a command channel from AgentPier into the running
session, used only for this:

- **Claude Code.** The mod's socket server (`claude-mod-socket.js`) accepts only
  `POST /claude-mod/v1/events` today, with a 5 s timeout, and the mod sends one request
  at a time. It gains a second route, a long-poll `GET /claude-mod/v1/commands` with
  its own longer timeout, which the mod keeps open beside its event posts and which
  AgentPier answers with a command; the mod posts the result as an event. The mod
  runs `$.tool.call` TaskStop. For an agent it also drops the resulting `killed`
  notification in `prompt.submit` (reason: stopped in AgentPier), so no turn starts.
  This is the first thing the mod does that changes what Claude Code does; its header
  comment and `docs/architecture.md` say so, and it happens only for a stop the owner
  asked for. `canStop` needs the mod's hello for this launch and Claude Code 2.1.325
  or newer (the version the spike ran on; the hello reports the CLI version).
- **Codex.** The proxy runs in the launcher process and today only answers requests it
  published itself. The native request channel (`native-channel.js`) gains
  server-originated commands with a result, used by Codex and OpenCode alike. On a
  command the proxy sends a request of its own on the session's connection, with ids
  from a namespace the TUI never uses, and keeps the response from the TUI. It tracks
  each child thread's active turn id from `turn/started` / `turn/completed` and each
  background terminal from `commandExecution` items, and reports both to the server
  over the path its activity reports already use. Stopping an agent sends
  `turn/interrupt`, then terminates that child's background terminals if the
  terminal methods are available. Stopping a shell sends
  `thread/backgroundTerminals/terminate`. Whether the terminal methods work on the
  shared connection is the first thing the build verifies; if they do not, Codex
  shells are listed without a stop button and an agent stop only interrupts.
- **OpenCode.** The TUI plugin already holds a native request channel
  (`opencode-plugin.js`); with server-originated commands on that channel it calls
  the SDK's session abort for the child id and returns the result.

### Telling the main agent

A stop that succeeded is remembered per session and reaches the browser in the chat
frame as `observability.stopNotes[]` (`{ id, text }`). The chat composer appends the
pending lines to the text it submits, so the text the browser sends is the text the
CLI receives and the existing delivery confirmation (text equality, receipt hash,
hook-block match) keeps working unchanged. The line, in English since it addresses
the model:
`[AgentPier: the user stopped background task "<name or command>" (<id>).]`
The submit names the note ids it carried; the server forgets them when it accepts
that delivery, not before, so a rejected delivery keeps them. Slash commands and `!`
shell lines never carry a note and keep it for the next message. Messages from other
senders (terminal, Telegram, agents) do not carry it. The owner sees the appended
line in the chat like the rest of the message.

### The state after a stop

- The status vocabulary gains `stopped` for subagents and shells, shown as "Stopped".
- Where the CLI reports a stop itself it is read from the native record, whoever
  stopped the task: Claude Code `killed` / `stopped` task notifications (today
  mapped to unknown), Codex `interrupted` turns and terminals completed with exit
  code -1 after a terminate, OpenCode `MessageAbortedError` on the child and
  "Task cancelled" on the parent's task part (today read as failed).
- Where it does not (a Claude Code shell leaves no record; a Codex parent is not
  told), the stops AgentPier performed are kept in a small file beside the session's
  native activity file, so the entry stays "Stopped" across a reload and a server
  restart instead of looking running again.
- Finished entries of a session that is no longer live stay listed with their last
  known state, as in PR 1.

### Scope of shells

- Claude Code: shells started by the main loop only. Shells that a subagent started
  live in sidechain files and are not listed in this change.
- Codex: every background terminal the proxy sees on the session's connection, with
  the thread it belongs to (`ownerAgentId` when that is a child). The entry id is the
  thread id plus `processId`, which terminate needs. The list is live state of the
  proxy: after a proxy restart, terminals it has not seen are not listed.
- "Show output" exists for Claude Code only. It loads the tail once, again when the
  entry's status changes, and on a "Refresh" button; nothing watches the file.

### The sheet

- Cards show their kind: "Agent" or "Shell". A shell card's title is its description
  or, without one, its command; the command is shown in monospace beneath.
- "Show transcript" (agents) and "Show output" (Claude Code shells with `hasOutput`)
  switch the sheet to a detail view with a back button and the entry's title; the
  list keeps its scroll position and fold state on return. The detail refreshes when
  the session's chat frame reports a change for that entry; no timer.
- The stop button is an icon button on the card with the label "Stop task". No
  confirmation: the action is cheap and the screenshot's pattern is direct. While
  the request runs it is busy; a refusal shows inline on the card; on success the
  card moves to Completed with status "Stopped".
- The line above the composer counts running shells with running subagents.
- German and English copy; the UI guide's components and tokens.

### Documentation

`docs/chat-observability.md` (tasks, shells, what each CLI supports, the note to the
model), `docs/architecture.md` (the three command channels),
`docs/native-chat-delivery.md` if the appended line touches delivery, README lists if
they name per-CLI abilities.

## Constraints

- No credential, token or file content leaves the session's own scope; the transcript
  and output routes never read a path that is not derived from the session's own
  records.
- Tool output caps of the chat apply to transcripts.
- Server state reaches the browser over the live channel.
- Files stay under 600 lines; tests use isolated fixtures and fake CLIs, never real
  sessions.

## Verification

Unit and integration tests with fixtures recorded from the spike (transcript records,
app-server frames, OpenCode events) for every parser and channel; browser tests for
the sheet. After the build, one manual pass against the isolated spike instance
(port 4427) for each CLI: start a shell and a subagent, read, stop, send a message and
check the appended line.

## Left to the builder

Module split, route file placement, the long-poll timing, the exact id namespace for
proxy requests, and how the stop note is stored (memory is enough; it need not
survive a restart).
