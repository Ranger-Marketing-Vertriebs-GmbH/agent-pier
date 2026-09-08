# Chat context and subagent observations

Chat exposes `observability` alongside messages and tasks. It reads structured data already loaded by the native history adapter. It does not type into a terminal, configure statusline hooks, read unrelated conversations, add a second OpenCode export, or launch a model request.

```js
{
  context: {
    usedTokens: null,
    limitTokens: null,
    remainingPercent: null,
    source: null,
    limitSource: null,
    observedAt: null,
    modelId: null
  },
  subagents: [],
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

When no native limit exists, an exact persisted launch provider configuration can supply `limitTokens`, labeled `limitSource: "configured"`. A known model mismatch suppresses this fallback. The current editable account selection is not evidence of an already running session's model. Native limits take precedence. No default 200k/1m window or generic model-name guess is substituted.

## Source ordering and compaction

A scoped Codex rollout initializes observations. The complete structured thread snapshot then supplies its latest agent states and optional token usage. When timestamps are incomparable, the structured snapshot takes precedence. A rollout event provably newer than the snapshot remains authoritative. A completed collaboration tool call without a receiving agent's status cannot overwrite that agent's known lifecycle state.

Explicit native compaction markers clear the last observed usage until another API/token-count record appears. Already known limits may remain available. `observedAt` is the native event timestamp when provided. An unrelated file mtime or current wall-clock time is not invented as the last request time; structured state without a timestamp remains null.

Saved Chat snapshots retain original sources and timestamps, with `observability.stale: true` when native history is unavailable and the saved view is used. A stopped parent session cannot display a child as currently running; unresolved running states become unknown.

## Subagent identities and lifecycle

Each row contains `id`, `name`, `task`, `status`, `source` and `updatedAt`. Descriptions are bounded to 1,000 characters, names to 120, and the list to the 100 most recently observed identities. It does not include full subagent result bodies, internal reasoning or arbitrary progress message content.

- **Codex:** native collaboration receiver thread IDs and subagent activity events identify agents. Their reported agent state determines status. Finishing a spawn, send or wait tool operation does not itself finish an agent. [Official structured thread schema](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/v2/ThreadItem.ts).
- **Claude Code:** Agent/Task calls correlate native progress and `toolUseResult.agentId`. Structured background task events are accepted only for agent tasks or a known Agent tool use. A shared `tool_use_id` links task IDs to the canonical agent ID when both are available, avoiding duplicate rows. Without that link, no identity equivalence is guessed. [Official SDK task event schema](https://code.claude.com/docs/en/agent-sdk/typescript).
- **OpenCode:** task-tool metadata supplies the child session ID. A completed foreground task can establish completion. A completed background dispatch remains unknown because its later completion may only appear as synthetic prose, which this adapter deliberately does not interpret as lifecycle evidence. [Official task implementation](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/tool/task.ts).

Statuses are `running`, `completed`, `failed` or `unknown`, based on the latest supported native report. They do not constitute process supervision. Unsupported schema versions, absent identifiers, dispatch-only results and ambiguous stopped/interrupted states remain unknown. Ordinary assistant prose, quoted JSON/XML, task-list items and arbitrary tool results never create subagent identities.

## Verification

```sh
node --test tests/unit/observability.test.js \
  tests/integration/observability-history.test.js \
  tests/property/observability-usage.test.js \
  tests/matrix/observability-status.test.js
```

Fixtures in `tests/fixtures/observability` are synthetic examples of native structured schemas; they contain no user transcripts. Tests cover cache accounting, native Codex totals/baseline, source precedence, compaction resets, same-tool identity correlation, background dispatch uncertainty, malformed/prose false positives, configured-limit mismatch, timestamp preservation and stale saved snapshots. Generated histories prove that earlier turns and cache fields cannot inflate the latest observation. The CLI/status matrix covers all supported status mappings. Existing history normalization and Chat binding tests remain unchanged in behavior.
