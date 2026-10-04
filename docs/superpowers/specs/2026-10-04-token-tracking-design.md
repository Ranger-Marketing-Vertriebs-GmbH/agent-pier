# Token tracking per session

## Problem

AgentPier tracks only the current context size of a session's main conversation:
- `observability.context.usedTokens`
- `limitTokens`
- `remainingPercent`

It has no per-session totals, no per-subagent usage, no cost, and no structured provider limits.

- **After a Claude compaction** the chat shows "Context usage unavailable", although the `compact_boundary` record carries `compactMetadata.postTokens`.
- **Native Claude models without `[1m]`** have no known context window, so no percentage is shown.
- **Codex rate limits** are only mirrored by scraping warnings from the terminal. The rollout's structured `rate_limits` is ignored.

The CLIs already write most of the data:

| CLI | Session totals | Subagents | Context window | Other |
|---|---|---|---|---|
| Claude Code | `message.usage` per API request (dedupe by `message.id`); a `cost-state` record with `modelUsage` per model and `totalCostUSD` | `<session>/subagents/agent-<id>.jsonl` (sidechain records with `message.usage`, `agentId`) plus `.meta.json` (`toolUseId`, `agentType`); the task-notification `<usage><subagent_tokens/><tool_uses/><duration_ms/></usage>` | launch config `[1m]` / `assumedContextTokens`; otherwise unknown | `compact_boundary.compactMetadata.postTokens` |
| Codex | `event_msg/token_count.info.total_token_usage` (cumulative; input, cached input, cache write, output, reasoning output, total) | child rollout files with `session_meta.payload.source.subagent.thread_spawn.parent_thread_id` | `info.model_context_window` | `rate_limits` (`primary`/`secondary`: `used_percent`, `window_minutes`, `resets_at`; credits; plan) |
| OpenCode | `session` row: `tokens_input`, `tokens_output`, `tokens_reasoning`, `tokens_cache_read`, `tokens_cache_write`, `cost`; per assistant message `info.tokens` and `cost` | child sessions with `parent_id`, linked via task tool part `metadata.sessionId` | provider config or catalog (`assumedContextTokens`) | — |

## Goals

1. Per session, in the chat, for Claude Code, Codex and OpenCode, show:
   - the **current context** as used tokens against the window, with a percentage;
   - **session totals**: input, output, cache read, cache write, and reasoning/thinking, plus cost where the CLI provides it;
   - **per-subagent usage**: tokens, and duration where available, on the subagent rows and in the subagent list, with the main session's totals stating how much of them came from subagents;
   - **Codex rate limits** from the structured `rate_limits`, as percent used per window with reset time.
2. After a Claude compaction, the current context shows the post-compaction size instead of "unavailable".
3. Claude models without a known window assume the documented default window of 200,000 tokens, labelled as assumed (user decision). A reported or configured window always wins.

Non-goals:
- Cross-session or cross-account dashboards and aggregation over time.
- New persistence beyond what chat snapshots already store.
- Cost estimation from price tables. Cost is shown only when the CLI reports it.
- Replacing the Claude limit warnings scraped from the pane. Claude has no structured limits.

## 1. Data model (`observability`)

Extend the existing observability object. All new fields are optional, so older snapshots stay valid.

```
context: { usedTokens, limitTokens, remainingPercent, source, limitSource, observedAt, modelId }
         // existing; limitSource gains "assumed-default"; source gains "compaction"
totals: {
  inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens,
  costUsd | null, source, observedAt,
  subagents: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
               reasoningTokens, totalTokens, costUsd | null } | null
} | null
subagents[]: existing { id, name, task, status, source, updatedAt }
             + usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
                        reasoningTokens, totalTokens, toolUses, durationMs, costUsd } | null
limits: { source: "codex-rate-limits", plan, windows: [{ id, usedPercent, windowMinutes, resetsAt }],
          credits: { hasCredits, unlimited, balance } | null, observedAt } | null
```

- Every number is a safe non-negative integer or `null` (unknown). The value 0 is never used to mean unknown.
- `totals` covers the main conversation. `totals.subagents` is the sum of the subagent usages that are known. The UI shows "incl./plus subagents" explicitly; the two are never silently added together.
- `costUsd` is a number with at most 4 decimals, or `null`.

## 2. Per-CLI derivation (server)

The observers live in `server/features/chat/*-observability.js`. They gain totals, subagent usage and limits. Put new logic in new modules where the 600-line cap requires it.

**Claude Code**
- **Main totals:** sum `message.usage` over non-sidechain assistant records, deduplicated by `message.id`.
  - input = `input_tokens`; cache write = `cache_creation_input_tokens`; cache read = `cache_read_input_tokens`; output = `output_tokens`; reasoning = `output_tokens_details.thinking_tokens` when present.
  - Cost from the latest `cost-state` record only if it is unambiguous for the main conversation. Otherwise `null`. See the open check below.
- **Compaction:** on `system/compact_boundary`, set `context.usedTokens = compactMetadata.postTokens` (when it is a safe integer) with `source: "compaction"`. The next assistant usage supersedes it.
- **Window:**
  1. a configured window from the session provider (`assumedContextTokens`, `[1m]`), as today, wins;
  2. otherwise, for Claude models, assume 200,000 with `limitSource: "assumed-default"`.

  The assumption is never used for non-Claude models routed through Claude Code.
- **Subagent usage:**
  - Primary source: `<session>/subagents/agent-<agentId>.jsonl`. Sum its assistant `message.usage`, deduplicated by `message.id`. Link it to the Agent call via `agentId` or `.meta.json.toolUseId`. Duration is the time from the launch record to the hand-back or notification record.
  - Fallback: when the file is unavailable, the task-notification `<usage>` gives `totalTokens`, `toolUses` and `durationMs`, without a split.
  - Cache by file size and mtime so live refreshes don't re-read unchanged files.
- **Open check (must be verified against real data during implementation):** whether `cost-state.modelUsage` includes subagent usage, and whether repeated task notifications for the same agent carry cumulative or incremental numbers. Pick the interpretation that real data supports, and document it in the docs.

**Codex**
- **Main totals:** from the latest `token_count.info.total_token_usage`.
  - input = `input_tokens − cached_input_tokens`, when Codex reports input including the cached part (verify against real data); cache read = `cached_input_tokens`; cache write = `cache_write_input_tokens`; output = `output_tokens`; reasoning = `reasoning_output_tokens`.
  - Cost is `null`.
- **Limits:** the latest `token_count.rate_limits` maps to `limits.windows`: primary and secondary, each with `used_percent`, `window_minutes` and `resets_at`. Credits and the plan type come along too.
- **Subagents:** find child rollouts whose `session_meta` has `source.subagent.thread_spawn.parent_thread_id` equal to the parent thread id. Look in the same sessions directory tree and bound the search, for example to the same day directories and at most N files. A child's usage is its last `total_token_usage`. Match it to the subagent entry by the agent path, nickname or thread id that the existing Codex observer already uses for subagent status. Cache by size and mtime.

**OpenCode**
- **Main totals:** sum the assistant messages' `info.tokens` (input, output, reasoning, cache read, cache write) and `cost` from the export the observer already reads. Alternatively, read the `session` row columns when the history reader has database access. Choose whichever path the existing reader supports, and verify that both agree on a real database.
- **Subagents:** child sessions (`parent_id` equal to the session id). Their totals are linked to the task tool part through `metadata.sessionId`.
- **Window:** as today, the provider `assumedContextTokens` / catalog.

**General rules**
- Observers stay pure and incremental, as they are today, and finalize through `finalizeObservability`.
- Large transcripts:
  - main totals accumulate per record, never as an extra full re-read;
  - subagent files are read only when they change, with bounded reads.
- Anything unparseable leaves the field `null`. It must never throw.

## 3. UI

**Context row (`ChatObservability.jsx`)**
- A compact bar with percentage, "used / window", and labels:
  - "assumed" for `assumed-default`;
  - "after compaction" for `source: "compaction"`;
  - "saved" when stale.

  Keep the existing source labels.
- When the window is unknown and cannot be assumed (non-Claude without a configured window), show used tokens without a bar.

**Details (the existing toggle, which today only toggles a CSS class)**
- A totals table: input, output, cache read, cache write, reasoning, cost (only when known), and a total.
- A second line, "Subagents: … tokens", when `totals.subagents` exists.
- For Codex, a limits section with each window's percent used, a small bar, and the reset time (relative and absolute on hover). Credits are shown when present.

**Subagents**
- Each subagent row and list entry shows total tokens, and the duration when known, for example "12.4k tokens · 1m 32s".

**Formatting**
- Compact numbers: 1,234 / 12.4k / 1.2M, localized for DE and EN.
- USD with 2 decimals, or 4 when below 0.01.
- Every new label is in `web/lib/i18n/{de,en}`.

**Restored and stale data** (session cache): show the values with the existing "saved state" label. Never present them as live.

## 4. Testing

- **Unit, per observer, with synthetic fixtures in the real shapes**
  - Claude:
    - totals dedupe by `message.id`;
    - thinking tokens;
    - compaction `postTokens`;
    - assumed 200k only for Claude models without a configured window;
    - subagent file usage summed and linked via `meta.json`;
    - fallback from the notification `<usage>`;
    - `cost-state` cost handling per the verified interpretation.
  - Codex: totals from `total_token_usage` (cached input handling); `rate_limits` mapping; child rollout discovery and linking; bounded search.
  - OpenCode: message token sums, cost, child sessions.
  - Null and malformed values never throw and never become 0.
- **Integration:** an observer run over the history-page and full-parse paths gives identical totals (pattern: the existing Claude subagent history equality tests); mtime caching avoids re-reading.
- **Browser (Chromium and WebKit, DE and EN):**
  - the context bar with assumed and compaction labels;
  - the details totals and cost visibility;
  - the Codex limits;
  - subagent row token and duration;
  - the restored "saved" label.
- **Validation:** run the observers on real local transcripts in a scratch script (Claude session 57444b1d, a Codex rollout with child rollouts, an OpenCode db). Plausibility-check the totals against the CLI's own `cost-state` / `session` row / `total_token_usage`, and record the result in the PR.

## 5. Documentation

Update `docs/chat-observability.md`:
- the new fields and sources per CLI;
- the dedupe rule;
- the subagent linking;
- the assumed-default window policy, which changes the documented "no default window" rule;
- the compaction size;
- Codex limits;
- what cost means per CLI.
