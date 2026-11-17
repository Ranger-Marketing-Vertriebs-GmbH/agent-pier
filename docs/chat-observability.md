# Chat context and subagent observations

Chat exposes `observability` alongside messages and tasks. It reads structured data already loaded by the native history adapter. It does not type into a terminal, configure statusline hooks, read unrelated conversations, add a second OpenCode export, or launch a model request.

```js
{
  context: {
    usedTokens: null,
    limitTokens: null,
    remainingPercent: null,
    source: null,
    limitSource: null, // "native" | "configured" | "assumed-model"
    observedAt: null,
    modelId: null,
    compaction: null // { conversationTokens, observedAt }
  },
  totals: null, // see "Session totals and cost"
  limits: null, // Codex only, see "Codex rate limits"
  subagents: [], // entries may carry usage, see "Subagent usage"
  shells: [], // see "Background shells, transcripts and stopping"
  stopNotes: [], // { id, text }, see "Telling the main agent about a stop"
  stale: false
}
```

Null means unavailable, not zero. Sources describe the measurement basis; measurements from different CLIs are not interchangeable. Newly typed text, an in-progress response and changes made after the last native record may not be reflected yet.

## Context measurements

| CLI         | `usedTokens`                                                                                                                                                                                | Remaining percentage and source                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Codex       | The latest `last_token_usage.total_tokens`, or structured `tokenUsage.last.totalTokens`. Cumulative session totals are ignored. Cached and reasoning tokens are not added again.            | `native-token-count`; uses Codex's native 12,000-token baseline estimate when a limit is available. |
| Claude Code | The latest parent assistant request's input tokens plus cache creation and cache read tokens. Sidechain usage and nested agent progress usage are excluded. Output tokens are not included. | `last-api-request`; remaining percentage uses this input occupancy and a verified/configured limit. |
| OpenCode    | The latest assistant request's non-cached input plus cache read/write tokens. Export-wide cumulative totals and response output tokens are excluded.                                        | `last-api-request`; remaining percentage uses this input occupancy and a verified/configured limit. |

Codex reports its native model context window when present. Its remaining estimate is `round(100 × max(0, window − 12000 − max(0, used − 12000)) / (window − 12000))`, clamped to 0–100; a window at or below the baseline yields zero. This estimates the user-controllable portion and is not simply `100 − used/window`. The implementation follows the official [Codex TokenUsage protocol](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs).

Claude's latest input/cache formula matches its documented statusline percentage basis. Session-wide counters are not substituted for current request usage. Its transcript does not reliably supply the active context limit for every native model, so an unreported limit stays unknown. See the official [Claude statusline context fields](https://code.claude.com/docs/en/statusline).

OpenCode separates cached tokens from non-cached input for accounting. The processor replaces assistant message usage with the latest completed step's reported usage; AgentPier does not sum steps. The parser ignores summarization responses and placeholder zero usage from an unfinished initial message. See the official [OpenCode usage normalization](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/session.ts) and [processor](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/processor.ts).

Native limits take precedence. When no native limit exists, an exact persisted launch provider configuration can supply `limitTokens`, labeled `limitSource: "configured"`; a known model mismatch suppresses this fallback, and the current editable account selection is not evidence of an already running session's model. First-party Claude sessions (no provider object) then use a rule per model family, labeled `limitSource: "assumed-model"` and shown as "assumed". Claude Code's transcript never reports a window, so for these sessions the rule is the only source. It follows Claude Code's [model configuration](https://code.claude.com/docs/en/model-config) and the model catalog inside Claude Code 2.1.322: every Fable and Mythos model, Opus 4.7 and later, Sonnet 5 and later and Haiku 5.5 have 1,000,000 tokens (so `claude-fable-5-2`, `claude-opus-5-5`, `claude-sonnet-5-5` and `claude-haiku-5-5` do, and the next Fable, Opus or Sonnet release needs no change); older releases of these families have 200,000, among them Opus 4.6 and Sonnet 4.6, which reach 1M only as `[1m]`. Where no source names a window, none is assumed: a family the rule does not know, a Haiku release after 5.5 and an id without a version show the usage without a window and without a percentage, instead of a percentage of a guessed 200,000. A session started with `CLAUDE_CODE_DISABLE_1M_CONTEXT` runs at 200,000 whatever the model; AgentPier does not see that setting and still assumes the model's own window. A trailing date suffix (`-20250101`) is ignored. The model is the observed `message.model`, else the session's selected model. A trailing `[1m]` (the 1M context selection) means 1,000,000 tokens; because transcripts never carry it, a selected `[1m]` model counts when its id without `[1m]` and date suffix matches the observed model. When the observed usage exceeds the assumed window, the assumption is dropped and no percentage is shown. Provider and gateway sessions never use the rule. The assumption is re-evaluated on every read, including saved snapshots.

## Source ordering and compaction

A scoped Codex rollout initializes observations. The complete structured thread snapshot then supplies its latest agent states and optional token usage. When timestamps are incomparable, the structured snapshot takes precedence. A rollout event provably newer than the snapshot remains authoritative. A completed collaboration tool call without a receiving agent's status cannot overwrite that agent's known lifecycle state.

Explicit native compaction markers clear the last observed usage until another API/token-count record appears. Already known limits may remain available. `observedAt` is the native event timestamp when provided. An unrelated file mtime or current wall-clock time is not invented as the last request time; structured state without a timestamp remains null.

After a Claude compaction, `context.compaction.conversationTokens` holds `compactMetadata.postTokens`. That count leaves out the system prompt, tools and re-injected attachments and is typically 2–13x smaller than the next real context, so it is shown as "conversation after compaction (excl. system/tools)" without a bar. `usedTokens` stays null until the next assistant usage.

Saved Chat snapshots retain original sources and timestamps, with `observability.stale: true` when native history is unavailable and the saved view is used. A stopped parent session cannot display a child as currently running; unresolved running states become unknown. On mobile the collapsed chat shows only a compact "% remaining" chip when a window is known, readable by screen readers because it is the only visible context value (it is not displayed whenever the full context row is); for a saved snapshot the chip is dimmed and labeled "Saved state".

## Session totals and cost

`totals` holds `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `reasoningTokens`, `totalTokens`, `outputIsLowerBound`, `cost: { usd, scope } | null`, `source`, `observedAt` and `subagents`. Totals come only from whole-history sources: the Claude history index, a full read (including a complete small transcript that fits into the first page, which is served from its live observation), the Codex thread record, or the OpenCode session row. A page that sees only part of the history reports `totals: null`, and Chat keeps the last known totals of the same conversation. Main totals never include subagent usage; `totals.subagents` reports it separately. A null field means unknown, not zero.

| CLI         | Source                                                                                                                                                                                        | `totalTokens`                                         | Cost                                                                                                                           |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Claude Code | Assistant `message.usage` in the main transcript, last record per `message.id`                                                                                                                | input + cache write + cache read + output             | `cost-state.totalCostUSD`, only while no assistant record follows the latest `cost-state` (`scope: "cli-exit-incl-subagents"`) |
| Codex       | Latest `token_usage_record.payload.thread_token_usage` (`source: "codex-thread"`); `token_count.info.total_token_usage` only as a fallback labeled "this process" (`source: "codex-process"`) | `total_tokens` as reported                            | none                                                                                                                           |
| OpenCode    | `session` row: `tokens_input`, `tokens_output`, `tokens_reasoning`, `tokens_cache_read`, `tokens_cache_write`, `cost`                                                                         | input + output + reasoning + cache read + cache write | `cost` (`scope: "session"`)                                                                                                    |

Claude writes duplicates of one `message.id` next to each other and their `output_tokens` only grows, so the last record per id counts. About half of current responses never receive their final usage (`stop_reason: null` with a placeholder `output_tokens`), so Claude output is a lower bound (`outputIsLowerBound: true`, shown with "≥"). Thinking is part of output and is not reported separately (`reasoningTokens: null`). Malformed usage is skipped, never counted as zero. `usage.iterations[]`, `speed`, `fallback_credit` and `server_tool_use` are ignored. Claude writes `cost-state` only when the CLI exits, and it includes subagents and side queries such as titles and web search, hence its label "Cost as of last CLI exit (incl. subagents)". The cost is omitted when `cost-state` sets `hasUnknownModelCost: true` (an estimate for models Claude has no price for) and for provider sessions, whose gateway models Claude prices with its own table.

A Codex rollout can contain records of other threads. The bounded rollout projection keeps only `token_usage_record` entries whose `thread_id` matches the rollout's own (first) `session_meta` id; forked rollouts repeat their parent's `session_meta` later (records without a thread id are kept), and the observer accepts only the session's thread id. Codex input includes the cached part and reasoning is a subset of output; both are shown as reported, with reasoning as an indented "of which reasoning" row under Output. OpenCode reports reasoning separately, so it gets a row of its own. Codex always reports cache writes as 0, so `cacheWriteTokens` stays null. OpenCode's session row equals the sum of its messages; when the row cannot be read, `totals` is null instead of failing the history read.

## Codex rate limits

`limits.buckets` keeps the latest `token_count.rate_limits` snapshot per `limit_id` (for example "codex", "codex_bengalfox" for GPT-5.3-Codex-Spark, "premium"), at most 16 buckets. The rollout projection stores only whitelisted, bounded fields: `limit_id` and `limit_name` (120 characters each), `plan_type`, the primary and secondary windows and the credits. Each window carries `windowMinutes`, `usedPercent` (clamped to 0–100) and `resetsAt` (epoch milliseconds) and is labeled by its length ("5 h", "7 days"). Windows whose reset time has passed are hidden, and a bucket without a current window or usable credits is dropped. The browser applies the same rule when it renders, and an open usage panel re-renders every 30 seconds and at the next reset, so an expired window disappears without new data. Credits are shown only when the account has credits or unlimited credits; the balance stays the reported decimal string (at most 40 characters).

## Subagent usage

Subagent entries may carry `usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, totalTokens, outputIsLowerBound, toolUses, durationMs, costUsd }`.

- **Claude Code:** tokens come only from `<session>/subagents/agent-<agentId>.jsonl` (last record per `message.id`, output a lower bound) and link through the file's agent id or `agent-<agentId>.meta.json`'s `toolUseId`. Agents with `parentAgentId` (spawn depth 2) are added to their top-level ancestor and never listed. Agents under `subagents/workflows/wf_*/` have no Agent call: they count in `totals.subagents` as workflow agents but get no row. Duration and tool uses come from the task notification's `<duration_ms>` and `<tool_uses>`; its `<subagent_tokens>` is the last request's size, not consumption, and is never used.
  A bounded per-session cache (16 sessions) reads these files in the background and never delays the chat read; until the first scan of a session finishes, no subagent usage is reported. It only parses complete lines that contain `"usage"`, continues each file from its last complete line, and on each refresh stat-checks every known agent file (including workflow agents, at most 1,024 per directory) and reopens only new files and files whose size or mtime changed, whatever the observer reports about the agent. Meta files are cached once parsed; an empty or unparseable (half-written) meta is read again when its size or mtime changes, and a missing or transiently unreadable meta is retried at the next refresh. An unreadable file keeps its previous state instead of failing the scan. The `subagents` directory must resolve inside the profile root; symlinked agent files and a `workflows` directory that resolves elsewhere are skipped, and meta files are opened without following symlinks. Agent files beyond 1,024 (per `subagents` directory, and in total under `workflows`) are counted as unavailable. A changed result notifies Chat clients, which then re-read the chat; notifications are paced to at most one per 1,500 ms per session, and the last change within an interval is announced when it ends.
- **Codex:** children come from `$CODEX_HOME/state_5.sqlite` (`thread_spawn_edges` joined with `threads.rollout_path`, opened read-only or immutable with a 200 ms busy timeout). Discovery walks the spawn tree recursively, stops at cycles back to the session or along the current path, and keeps each thread's shallowest row. Grandchildren are added to the direct child that spawned them. Descendants deeper than 4 levels, children beyond the first 512, and children whose rollout is missing, not a regular file, outside the session's profile root, or whose backward tail scan stops (8 MiB tail or 4 MiB line cap) before finding a record are counted as unavailable. Each child's usage is its rollout's last `token_usage_record` for its own thread id, read backwards and cached by size and modification time. Linking is by thread id only. When the database is absent, changes during the read or lacks the expected columns, no child usage is reported.
- **OpenCode:** child sessions are the `session` rows with `parent_id` equal to the session (at most 512), linked to task rows through the child session id; their usage and cost come from those rows. Children without usable totals and children beyond the limit are counted as unavailable.

`totals.subagents` (`count`, token fields, `outputIsLowerBound`, `costUsd`, `workflowAgents`, `unavailable`) covers all known subagents, not only the listed ones. Rows and the background tasks sheet show "12.4K tokens · 1m 32s"; "≥" appears when a Claude output lower bound makes up at least half of the shown total.

## Subagent identities and lifecycle

Each row contains `id`, `name`, `task`, `status`, `source` and `updatedAt`. Descriptions are bounded to 1,000 characters, names to 120, and the list to 100 identities. At that cap the oldest finished agent is evicted; only when all 100 are still running is the snapshot marked stale. It does not include full subagent result bodies, internal reasoning or arbitrary progress message content.

- **Codex:** native collaboration receiver thread IDs and subagent activity events identify agents. Their reported agent state determines status; `interrupted` (and the activity kinds `killed` and `stopped`) read as stopped. Finishing a spawn, send or wait tool operation does not itself finish an agent. [Official structured thread schema](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/v2/ThreadItem.ts).
- **Claude Code:** Agent/Task calls correlate native progress and `toolUseResult.agentId`. Structured background task events are accepted only for agent tasks or a known Agent tool use. A shared `tool_use_id` links task IDs to the canonical agent ID when both are available, avoiding duplicate rows. Without that link, no identity equivalence is guessed. [Official SDK task event schema](https://code.claude.com/docs/en/agent-sdk/typescript).
  Current CLIs launch subagents in the background: the Agent result (`isAsync: true`, `status: "async_launched"`) makes the agent `running`. Completion arrives as generated user records, which stay hidden from the chat. A record with `origin.kind: "task-notification"` completes it when its `<tool-use-id>` names a known Agent call, or, when it has no `<tool-use-id>`, when its `<task-id>` names an agent launched by a known Agent call; only the envelope's `<task-id>`, `<tool-use-id>`, `<status>`, `<summary>` and `<note>` tags are read, the note only before `<result>`. Since Claude Code 2.1.326 an agent that stops while a background shell of its own still runs notifies `completed` with the note "This agent stopped with background work of its own still running."; that interim notification keeps it `running`. When the shell ends, the agent resumes and notifies again under the same task ID without a `<tool-use-id>`, which settles it. Shells a subagent starts stay in its sidechain and never become main-loop shells. This detection depends on that fixed Claude Code sentence: if a later version rewords it, a waiting agent reads as completed too early (never as running when it is not). Notifications for workflows are ignored; notifications for background commands feed the shells (below). `completed` maps to completed, `failed` to failed, `killed` and `stopped` to stopped, and other states to unknown. A peer record with `origin.handback: true` from a known agent ID completes it as well. A successful `TaskStop` result for the agent (`toolUseResult.task_type: "local_agent"`) makes it stopped. Within one launch the latest event wins, except that an inconclusive state (killed, stopped) never replaces a reported completion or failure; chat rows and the observer apply the same rule. A new launch with the same agent ID starts over as running and ignores earlier events. Prose that only quotes these tags is never lifecycle evidence. While the parent session is not running, an unresolved `running` state becomes unknown.
- **OpenCode:** task-tool metadata supplies the child session ID. A completed foreground task can establish completion, and a task part in `error` with `error: "Task cancelled"` (the parent's view of an aborted child) reads as stopped. A completed background dispatch remains unknown because its later completion may only appear as synthetic prose, which this adapter deliberately does not interpret as lifecycle evidence. [Official task implementation](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/tool/task.ts).

In the chat, consecutive tool rows between two messages fold into one collapsed activity group (`web/components/ActivityGroup.jsx`, the same head as an agent chat's SSH group): "Agent activity · 6 calls · Bash 3 · Read 2 · Edit 1" names the three most used tools, and its chip reads "Running" while the live session's last group has a running call, "N failed" for failed calls, or "Done" once every call completed. Opened, it shows the tool rows unchanged.

In the chat, Claude Agent/Task rows carry `subagent: { description, type, status, agentId }` and are rendered as standalone rows labeled "Subagent: <description> (<type>)" outside the collapsed tool groups. For background agents, the row text is the last hand-back report (bounded to 256 KiB and then subject to the tool output cap below), else the notification summary, else the launch prompt. Indexed history pages store hidden completion and `TaskStop` records with the Agent call's group so that every page showing the call also reads them. Rows from older pages are frozen snapshots, so while the session is live a row takes the observed state of its agent ID; an agent the observer does not know is shown as unknown instead of working. The UI never shows a subagent as working from saved, restored or stale data. Rows and the background tasks sheet use the same status labels.

A line above the composer says what is going on: "2 running tasks" while subagents or background shells run (both are counted), else "Tasks 3/7" while the CLI's to-do list is unfinished, else a muted "Background tasks" when only finished work is left; with nothing to show there is no line. It opens the **Background tasks** sheet (`web/features/chat/BackgroundTasksSheet.jsx`, a bottom sheet on phones), grouped into Running, Completed and To-dos. Each card names its kind, "Agent" or "Shell"; a shell card's title is its description or else its command, with the command in monospace beneath. A card offers **Show transcript** (agents) or **Show output** (Claude Code shells), which switch the sheet to a detail view with **Back to the list**, and while the task runs and the server allows it, the icon button **Stop task**. Finished and stopped tasks stay listed under Completed, newest first; that group starts folded above five entries. Saved, stale or stopped data never lists a working task (`web/features/chat/background-tasks.js`). The header's "Subagents (n)" button opens the same sheet.

Statuses are `running`, `completed`, `failed`, `stopped` ("Stopped") or `unknown`, based on the latest supported native report and on the stops AgentPier performed itself. They do not constitute process supervision. Unsupported schema versions, absent identifiers, dispatch-only results and ambiguous states remain unknown. Ordinary assistant prose, quoted JSON/XML, task-list items and arbitrary tool results never create subagent identities.

## Background shells, transcripts and stopping

`shells[]` lists background commands: `{ id, command, description?, status, exitCode?, startedAt?, updatedAt, ownerAgentId?, canStop, hasOutput }`, at most 100 entries (the oldest finished one is evicted first), command text cut to 1,000 characters. Subagent entries carry `canStop` and `hasTranscript`. The server sets all three flags; the browser only renders them. `canStop` is true only when the task is `running`, the session is running and not stale, and the session's command channel (see [architecture](architecture.md#background-task-control)) is connected.

| CLI         | Transcript                                                            | Shells                                                  | Output     | Stop                                         |
| ----------- | --------------------------------------------------------------------- | ------------------------------------------------------- | ---------- | -------------------------------------------- |
| Claude Code | `subagents/agent-<id>.jsonl`, current while the agent runs            | main loop only, from the transcript                     | tail, once | agents and shells (2.1.325 or newer, mod on) |
| Codex       | the child thread; while it runs only finished steps (`partial: true`) | every background terminal the proxy sees, while it runs | none       | agents and shells                            |
| OpenCode    | the child session, current while it runs                              | none                                                    | none       | agents (foreground task tool only)           |

- **Claude Code shells.** A `Bash` call with `run_in_background: true` in the main loop starts a shell, joined by its tool-use id to the result's `backgroundTaskId`. It ends with a `task-notification` for that id or a `TaskStop` result with `task_type: "local_bash"`. The notification summary reads `Background command "<description>" completed (exit code 0)` or `… failed with exit code 3` (Claude Code 2.1.326); `exitCode` is taken from `exit code <n>` and stays unset when the summary has none. Shells a subagent starts live in its sidechain and are not listed.
- **Claude Code output.** `GET /api/sessions/:id/tasks/:taskId/output` returns the last 256 KiB of the shell's output file (`{ text, truncated, gone }`), only from `<temp>/claude-<uid>/<project>/<session id>/tasks/<task id>.output` of this very session, opened without following links. A reboot clears that temp folder; then `gone: true`. The sheet loads it once, again when the entry's status changes and on **Refresh**; nothing watches the file.
- **Codex shells.** Every `commandExecution` with `source: "unifiedExecStartup"` that the app-server proxy sees, keyed `<threadId>:<processId>`, with `ownerAgentId` when the thread is a child. Exit code -1 reads as stopped, 0 as completed, others as failed. The list is the proxy's live state: it is not persisted, it disappears when the session ends, and after a proxy restart terminals it has not seen are not listed.
- **OpenCode.** No shells. Background subagents need `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS`, which AgentPier does not set, so only subagents of the foreground task tool are listed and stoppable.
- **Transcripts.** `GET /api/sessions/:id/tasks/:taskId/transcript` returns `{ messages, partial, truncated }` in the chat's own message shape: the newest 50 messages, tool rows capped like the chat's (16,384 characters, no "Load full output"), no paging. A Codex child that is still running may answer only its finished steps, often none; `partial: true` then says so.
- **Scope.** All three routes accept only task ids the session's current observability lists, and never read a path that is not derived from the session's own records. Reading needs read access to the session's chat; stopping needs the right to send it input.

### Stopping a task

`POST /api/sessions/:id/tasks/:taskId/stop` answers `{ stopped: true }` or an error with a stable code: `TASK_STOP_UNSUPPORTED`, `TASK_STOP_NOT_RUNNING` (also for a task that ended by itself just before the stop reached the CLI), `TASK_STOP_CHANNEL_DOWN`, `TASK_STOP_REFUSED` (with the CLI's reason, at most 500 characters) and `TASK_STOP_TIMEOUT` after 10 s. Two stops of the same task share one attempt. If the CLI confirms the stop after the timeout, AgentPier still records it and adds the note: the task did stop, although the sheet showed the timeout.

AgentPier keeps the stops it performed in `<dataDir>/task-stops/<sessionId>.json` (`server/features/chat/task-stop-store.js`, at most 100 per session). Without it a Claude Code shell, which leaves no record of a stop, would look running again after a reload or a server restart. The file lives in AgentPier's private data and not beside the CLI's native records, because a sandboxed CLI can write there and could forge or erase stops. Deleting the session removes it. A stored stop never overrides a `completed` or `failed` report.

What each CLI does after a stop:

- **Claude Code.** The mod calls `TaskStop`. For an agent, Claude Code would announce the stop with a `killed` notification that wakes the model for a turn; the mod drops that one notification, and the terminal shows "Prompt dropped by a hook: Stopped in AgentPier". A stopped shell leaves no record. The model learns of either only from the stop note.
- **Codex.** A stopped agent gets `turn/interrupt` on its thread, then each of its running background terminals is terminated. The main agent is not told and keeps waiting for the child until its own wait times out. A stopped shell is terminated; the model is not told.
- **OpenCode.** The child session is aborted. The parent's task part ends as "Task cancelled" and the parent's turn goes on, so the model sees the cancellation itself.

### Telling the main agent about a stop

Each successful stop adds a note to `observability.stopNotes` (`{ id, text }`, at most 20 per session, kept in server memory, so a server restart drops pending notes). The line is English because it addresses the model:

```text
[AgentPier: the user stopped background task "<name, description or command>" (<id>).]
```

The chat composer appends the pending lines to the owner's next message, after a blank line, and names their ids in `stopNoteIds`; the owner sees the lines as part of the sent message. The server forgets a note only when the delivery that carried it is accepted by the CLI, or handed off for a CLI whose acceptance is confirmed by text alone (OpenCode), so a rejected or failed delivery keeps it for the next message. Slash commands and `!` lines never carry a note, and neither do messages from the terminal, Telegram or agents. See [native chat delivery](native-chat-delivery.md#stop-notes).

## Tool output size

Images in tool output (png, jpeg, gif, webp) are taken out of the tool text, which
keeps an `[image N]` placeholder. Tool rows carry `images: [{ id, path }]`. The image
bytes are served on demand through `GET /api/sessions/:id/chat/images/:imageId` and
shown as thumbnails when the tool row is expanded. After a server restart, images of
live-window rows are re-derived.

Tool text longer than 16,384 UTF-16 units is capped: the row carries a 12,288-unit
head in `text`, a 4,096-unit `textTail`, and `truncated: { length, bytes }`. The UI
shows the head, an "omitted" marker, the tail and a "Load full output" action.

The full text is served by `GET /api/sessions/:id/chat/messages/:messageId/text` from
bounded in-memory stores (32 MiB in total, 4 MiB per entry, least recently used
eviction), with re-derivation from the live window. History rows need a chat reload
after a server restart.

Store limits count UTF-16 storage: text is limited to 32 MiB in total and 4 MiB per
entry, images (stored as base64) to 128 MiB in total and 32 MiB per entry, which is
roughly 48 MiB and 12 MiB of decoded image data. Outputs and images above the per-entry
limit are only available while they are in the live window.

## Verification

```sh
node --test tests/unit/observability.test.js \
  tests/unit/token-usage.test.js \
  tests/unit/observability-finalize.test.js \
  tests/unit/claude-token-totals.test.js \
  tests/unit/codex-token-totals.test.js \
  tests/unit/token-presentation.test.js \
  tests/integration/claude-token-history.test.js \
  tests/integration/claude-subagent-usage.test.js \
  tests/integration/codex-child-usage.test.js \
  tests/integration/opencode-token-totals.test.js \
  tests/unit/claude-subagents.test.js \
  tests/unit/claude-subagent-lifecycle.test.js \
  tests/unit/subagent-presentation.test.js \
  tests/integration/claude-subagent-history.test.js \
  tests/integration/observability-history.test.js \
  tests/property/observability-usage.test.js \
  tests/matrix/observability-status.test.js

# background tasks: shells, transcripts, stopping, stop notes
node --test tests/unit/task-observability.test.js \
  tests/unit/claude-subagent-waiting.test.js \
  tests/unit/task-transcripts.test.js \
  tests/unit/task-control.test.js \
  tests/unit/task-stop-store.test.js \
  tests/unit/stop-notes.test.js \
  tests/unit/claude-bridge-mod-commands.test.js \
  tests/unit/codex-tasks.test.js \
  tests/unit/opencode-plugin-commands.test.js \
  tests/integration/task-read-routes.test.js \
  tests/integration/task-stop-route.test.js \
  tests/integration/chat-delivery-stop-notes.test.js \
  tests/integration/claude-mod-commands.test.js \
  tests/integration/codex-proxy-commands.test.js \
  tests/integration/native-commands.test.js
npx playwright test tests/browser/task-control.spec.js
```

Fixtures in `tests/fixtures/observability` are synthetic examples of native structured schemas; they contain no user transcripts. Tests cover cache accounting, native Codex totals/baseline, source precedence, compaction resets, same-tool identity correlation, background dispatch uncertainty, malformed/prose false positives, configured-limit mismatch, timestamp preservation and stale saved snapshots. Generated histories prove that earlier turns and cache fields cannot inflate the latest observation. The CLI/status matrix covers all supported status mappings. Existing history normalization and Chat binding tests remain unchanged in behavior. The background task fixtures (`claude-shells.json`, `claude-subagent-waiting.json`, `opencode-aborted.json`, `tests/fixtures/requests/codex-task-frames.jsonl`) are reduced from records of isolated spike sessions, with ids and paths replaced; `codex-interrupted.json` is written by hand.
