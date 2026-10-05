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

Native limits take precedence. When no native limit exists, an exact persisted launch provider configuration can supply `limitTokens`, labeled `limitSource: "configured"`; a known model mismatch suppresses this fallback, and the current editable account selection is not evidence of an already running session's model. First-party Claude sessions (no provider object) then use Claude Code's own model table (2.1.289), labeled `limitSource: "assumed-model"` and shown as "assumed": claude-opus-4-6, -4-7, -4-8, claude-opus-5, -5-5, claude-sonnet-4-6, claude-sonnet-5, -5-5, claude-fable-5 (and -5-1) and claude-mythos have 1,000,000 tokens; claude-haiku-4-5, older models and any other `claude-*` id have 200,000. A trailing date suffix (`-20250101`) is ignored. The model is the observed `message.model`, else the session's selected model, with `[1m]` removed. When the observed usage exceeds the assumed window, the assumption is dropped and no percentage is shown. Provider and gateway sessions never use the table. The assumption is re-evaluated on every read, including saved snapshots.

## Source ordering and compaction

A scoped Codex rollout initializes observations. The complete structured thread snapshot then supplies its latest agent states and optional token usage. When timestamps are incomparable, the structured snapshot takes precedence. A rollout event provably newer than the snapshot remains authoritative. A completed collaboration tool call without a receiving agent's status cannot overwrite that agent's known lifecycle state.

Explicit native compaction markers clear the last observed usage until another API/token-count record appears. Already known limits may remain available. `observedAt` is the native event timestamp when provided. An unrelated file mtime or current wall-clock time is not invented as the last request time; structured state without a timestamp remains null.

After a Claude compaction, `context.compaction.conversationTokens` holds `compactMetadata.postTokens`. That count leaves out the system prompt, tools and re-injected attachments and is typically 2–13x smaller than the next real context, so it is shown as "conversation after compaction (excl. system/tools)" without a bar. `usedTokens` stays null until the next assistant usage.

Saved Chat snapshots retain original sources and timestamps, with `observability.stale: true` when native history is unavailable and the saved view is used. A stopped parent session cannot display a child as currently running; unresolved running states become unknown. On mobile the collapsed chat shows only a compact "% remaining" chip when a window is known; for a saved snapshot the chip is dimmed and labeled "Saved state".

## Session totals and cost

`totals` holds `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `reasoningTokens`, `totalTokens`, `outputIsLowerBound`, `cost: { usd, scope } | null`, `source`, `observedAt` and `subagents`. Totals come only from whole-history sources: the Claude history index, a full read (including a complete small transcript that fits into the first page, which is served from its live observation), the Codex thread record, or the OpenCode session row. A page that sees only part of the history reports `totals: null`, and Chat keeps the last known totals of the same conversation. Main totals never include subagent usage; `totals.subagents` reports it separately. A null field means unknown, not zero.

| CLI         | Source                                                                                                                                                                                        | `totalTokens`                                         | Cost                                                                                                                           |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Claude Code | Assistant `message.usage` in the main transcript, last record per `message.id`                                                                                                                | input + cache write + cache read + output             | `cost-state.totalCostUSD`, only while no assistant record follows the latest `cost-state` (`scope: "cli-exit-incl-subagents"`) |
| Codex       | Latest `token_usage_record.payload.thread_token_usage` (`source: "codex-thread"`); `token_count.info.total_token_usage` only as a fallback labeled "this process" (`source: "codex-process"`) | `total_tokens` as reported                            | none                                                                                                                           |
| OpenCode    | `session` row: `tokens_input`, `tokens_output`, `tokens_reasoning`, `tokens_cache_read`, `tokens_cache_write`, `cost`                                                                         | input + output + reasoning + cache read + cache write | `cost` (`scope: "session"`)                                                                                                    |

Claude writes duplicates of one `message.id` next to each other and their `output_tokens` only grows, so the last record per id counts. About half of current responses never receive their final usage (`stop_reason: null` with a placeholder `output_tokens`), so Claude output is a lower bound (`outputIsLowerBound: true`, shown with "≥"). Thinking is part of output and is not reported separately (`reasoningTokens: null`). Malformed usage is skipped, never counted as zero. `usage.iterations[]`, `speed`, `fallback_credit` and `server_tool_use` are ignored. Claude writes `cost-state` only when the CLI exits, and it includes subagents and side queries such as titles and web search, hence its label "Cost as of last CLI exit (incl. subagents)".

A Codex rollout can contain records of other threads. The bounded rollout projection keeps only `token_usage_record` entries whose `thread_id` matches the rollout's own (first) `session_meta` id; forked rollouts repeat their parent's `session_meta` later (records without a thread id are kept), and the observer accepts only the session's thread id. Codex input includes the cached part and reasoning is a subset of output; both are shown as reported. Codex always reports cache writes as 0, so `cacheWriteTokens` stays null. OpenCode's session row equals the sum of its messages; when the row cannot be read, `totals` is null instead of failing the history read.

## Codex rate limits

`limits.buckets` keeps the latest `token_count.rate_limits` snapshot per `limit_id` (for example "codex", "codex_bengalfox" for GPT-5.3-Codex-Spark, "premium"), at most 16 buckets. The rollout projection stores only whitelisted, bounded fields: `limit_id` and `limit_name` (120 characters each), `plan_type`, the primary and secondary windows and the credits. Each window carries `windowMinutes`, `usedPercent` (clamped to 0–100) and `resetsAt` (epoch milliseconds) and is labeled by its length ("5 h", "7 days"). Windows whose reset time has passed are hidden, and a bucket without a current window or usable credits is dropped. Credits are shown only when the account has credits or unlimited credits; the balance stays the reported decimal string (at most 40 characters).

## Subagent usage

Subagent entries may carry `usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, totalTokens, outputIsLowerBound, toolUses, durationMs, costUsd }`.

- **Claude Code:** tokens come only from `<session>/subagents/agent-<agentId>.jsonl` (last record per `message.id`, output a lower bound) and link through the file's agent id or `agent-<agentId>.meta.json`'s `toolUseId`. Agents with `parentAgentId` (spawn depth 2) are added to their top-level ancestor and never listed. Agents under `subagents/workflows/wf_*/` have no Agent call: they count in `totals.subagents` as workflow agents but get no row. Duration and tool uses come from the task notification's `<duration_ms>` and `<tool_uses>`; its `<subagent_tokens>` is the last request's size, not consumption, and is never used.
  A bounded per-session cache (16 sessions) reads these files in the background and never delays the chat read; until the first scan of a session finishes, no subagent usage is reported. It only parses complete lines that contain `"usage"`, continues each file from its last complete line, and on each refresh stat-checks every known agent file (including workflow agents, at most 1,024 per directory) and reopens only new files and files whose size or mtime changed, whatever the observer reports about the agent. Meta files are cached once parsed; an empty or unparseable (half-written) meta is read again when its size or mtime changes, and a missing or transiently unreadable meta is retried at the next refresh. An unreadable file keeps its previous state instead of failing the scan. The `subagents` directory must resolve inside the profile root; symlinked agent files and a `workflows` directory that resolves elsewhere are skipped, and meta files are opened without following symlinks. Agent files beyond 1,024 (per `subagents` directory, and in total under `workflows`) are counted as unavailable. A changed result notifies Chat clients, which then re-read the chat; notifications are paced to at most one per 1,500 ms per session, and the last change within an interval is announced when it ends.
- **Codex:** children come from `$CODEX_HOME/state_5.sqlite` (`thread_spawn_edges` joined with `threads.rollout_path`, opened read-only or immutable with a 200 ms busy timeout). Discovery walks the spawn tree recursively, stops at cycles back to the session or along the current path, and keeps each thread's shallowest row. Grandchildren are added to the direct child that spawned them. Descendants deeper than 4 levels, children beyond the first 512, and children whose rollout is missing, not a regular file, outside the session's profile root, or whose backward tail scan stops (8 MiB tail or 4 MiB line cap) before finding a record are counted as unavailable. Each child's usage is its rollout's last `token_usage_record` for its own thread id, read backwards and cached by size and modification time. Linking is by thread id only. When the database is absent, changes during the read or lacks the expected columns, no child usage is reported.
- **OpenCode:** child sessions are the `session` rows with `parent_id` equal to the session (at most 512), linked to task rows through the child session id; their usage and cost come from those rows. Children without usable totals and children beyond the limit are counted as unavailable.

`totals.subagents` (`count`, token fields, `outputIsLowerBound`, `costUsd`, `workflowAgents`, `unavailable`) covers all known subagents, not only the listed ones. Rows and the task panel show "12.4K tokens · 1m 32s"; "≥" appears when a Claude output lower bound makes up at least half of the shown total.

## Subagent identities and lifecycle

Each row contains `id`, `name`, `task`, `status`, `source` and `updatedAt`. Descriptions are bounded to 1,000 characters, names to 120, and the list to 100 identities. At that cap the oldest finished agent is evicted; only when all 100 are still running is the snapshot marked stale. It does not include full subagent result bodies, internal reasoning or arbitrary progress message content.

- **Codex:** native collaboration receiver thread IDs and subagent activity events identify agents. Their reported agent state determines status. Finishing a spawn, send or wait tool operation does not itself finish an agent. [Official structured thread schema](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/v2/ThreadItem.ts).
- **Claude Code:** Agent/Task calls correlate native progress and `toolUseResult.agentId`. Structured background task events are accepted only for agent tasks or a known Agent tool use. A shared `tool_use_id` links task IDs to the canonical agent ID when both are available, avoiding duplicate rows. Without that link, no identity equivalence is guessed. [Official SDK task event schema](https://code.claude.com/docs/en/agent-sdk/typescript).
  Current CLIs launch subagents in the background: the Agent result (`isAsync: true`, `status: "async_launched"`) makes the agent `running`. Completion arrives as generated user records, which stay hidden from the chat. A record with `origin.kind: "task-notification"` completes it when its `<tool-use-id>` names a known Agent call; only the envelope's `<task-id>`, `<tool-use-id>`, `<status>` and `<summary>` tags are read. Notifications for background commands or workflows are ignored. `completed` maps to completed, `failed` to failed, and other states such as `killed` to unknown. A peer record with `origin.handback: true` from a known agent ID completes it as well. A successful `TaskStop` result for the agent (`toolUseResult.task_type: "local_agent"`) makes it unknown. Within one launch the latest event wins, except that an inconclusive state (killed, stopped) never replaces a reported completion or failure; chat rows and the observer apply the same rule. A new launch with the same agent ID starts over as running and ignores earlier events. Prose that only quotes these tags is never lifecycle evidence. While the parent session is not running, an unresolved `running` state becomes unknown.
- **OpenCode:** task-tool metadata supplies the child session ID. A completed foreground task can establish completion. A completed background dispatch remains unknown because its later completion may only appear as synthetic prose, which this adapter deliberately does not interpret as lifecycle evidence. [Official task implementation](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/tool/task.ts).

In the chat, Claude Agent/Task rows carry `subagent: { description, type, status, agentId }` and are rendered as standalone rows labeled "Subagent: <description> (<type>)" outside the collapsed tool groups. For background agents, the row text is the last hand-back report (bounded to 256 KiB and then subject to the tool output cap below), else the notification summary, else the launch prompt. Indexed history pages store hidden completion and `TaskStop` records with the Agent call's group so that every page showing the call also reads them. Rows from older pages are frozen snapshots, so while the session is live a row takes the observed state of its agent ID; an agent the observer does not know is shown as unknown instead of working. The UI never shows a subagent as working from saved, restored or stale data. Rows and the task panel use the same status labels. The task panel lists working agents first, then finished agents, newest completion first. A finished agent stays listed for 10 seconds from the first frame in which the client saw it finished, then fades out (no fade under reduced motion) and leaves the list until its state changes again. An agent first seen already finished is listed only when its `updatedAt` is at most 60 seconds old, which tolerates clock skew between host and browser; older finished agents are not listed. Without live data the panel lists only completed and failed agents. Its heading reads "Subagents (n · m active)" when it lists finished and working agents.

Statuses are `running`, `completed`, `failed` or `unknown`, based on the latest supported native report. They do not constitute process supervision. Unsupported schema versions, absent identifiers, dispatch-only results and ambiguous stopped/interrupted states remain unknown. Ordinary assistant prose, quoted JSON/XML, task-list items and arbitrary tool results never create subagent identities.

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
```

Fixtures in `tests/fixtures/observability` are synthetic examples of native structured schemas; they contain no user transcripts. Tests cover cache accounting, native Codex totals/baseline, source precedence, compaction resets, same-tool identity correlation, background dispatch uncertainty, malformed/prose false positives, configured-limit mismatch, timestamp preservation and stale saved snapshots. Generated histories prove that earlier turns and cache fields cannot inflate the latest observation. The CLI/status matrix covers all supported status mappings. Existing history normalization and Chat binding tests remain unchanged in behavior.
