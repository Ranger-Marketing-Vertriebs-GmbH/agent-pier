# Token tracking per session

## Problem

AgentPier tracks only the current context size of a session's main conversation (`observability.context`). It has:
- no per-session totals,
- no per-subagent usage,
- no cost,
- no structured provider limits.

Two further gaps:
- After a Claude compaction it shows "Context usage unavailable".
- First-party Claude sessions have no `provider` object, so no context window is known at all, even though current Claude models run with 1M context.

This spec was checked against the code and against real local data: 17 Claude transcripts and 603 subagent files, 648 Codex rollouts (codex-cli 0.159.2), and one OpenCode database (v1.18.33). The findings below are facts, not assumptions.

## Goals

Per session, shown in the chat, for Claude Code, Codex and OpenCode:
1. **Current context:** used tokens against the window, with a percentage. The window is reported or configured, or assumed from a model table and labelled as assumed.
2. **Session totals:** input, output, cache read, cache write, reasoning (where it is a separate count) and cost, each only where the CLI provides it reliably, and with honest labels.
3. **Per-subagent usage:** tokens and duration on subagent rows and in the subagent list. The main totals state separately how much came from subagents; it is never silently added.
4. **Codex rate limits:** taken from the structured `rate_limits`.

Non-goals:
- Cross-session or cross-account dashboards.
- New persistence beyond chat snapshots.
- Price-table cost estimates.
- Replacing the Claude limit warnings that are scraped from the terminal pane.

## 1. Data model (`observability`, all new fields optional)

```
context: existing { usedTokens, limitTokens, remainingPercent, source, limitSource, observedAt, modelId }
         limitSource gains "assumed-model"; a separate field
         compaction: { conversationTokens, observedAt } | null   // post-compaction size, see §2
totals: {
  inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, totalTokens,
  outputIsLowerBound: boolean,          // Claude only
  cost: { usd: number, scope: "session" | "cli-exit-incl-subagents" } | null,
  source, observedAt,
  subagents: { count, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
               reasoningTokens, totalTokens, outputIsLowerBound, costUsd } | null
} | null
subagents[]: existing entries + usage: { inputTokens, outputTokens, cacheReadTokens,
             cacheWriteTokens, reasoningTokens, totalTokens, outputIsLowerBound,
             toolUses, durationMs, costUsd } | null
limits: { source: "codex-rate-limits", buckets: [{ limitId, limitName, plan,
          windows: [{ windowMinutes, usedPercent, resetsAt }],
          credits: { hasCredits, unlimited, balance: string } | null }], observedAt } | null
```

**Value rules**
- Token counts are safe non-negative integers or `null`. The value 0 never means "unknown".
- `usedPercent` is a finite number between 0 and 100.
- `resetsAt` is in epoch milliseconds.
- `costUsd` / `cost.usd` is a finite non-negative number.
- The credit `balance` is kept as a decimal string, exactly as reported.

**What `totalTokens` means per CLI** (verified)
- **Claude:** input + cache write + cache read + output. Thinking is part of output and is never added on top.
- **Codex:** input (including the cached part) + output, exactly as reported. Reasoning is a subset of output and is never added on top.
- **OpenCode:** input + output + reasoning + cache read + cache write. Reasoning is separate there, so it is included.

## 2. Per-CLI derivation (server)

### Claude Code

**Main totals.** Source: assistant `message.usage` records in the main transcript. Main transcripts contain no sidechain records.
- **Dedupe.** Duplicates of a `message.id` are always adjacent, and `output_tokens` only grows across them. Keep the **last** record per id: replace on the same id, so no unbounded set is needed.
- **Input, cache write, cache read.** Reliable. They are written at the start of the message.
- **Output is unreliable.** About half of current responses never receive final usage in the transcript (`stop_reason: null`, placeholder `output_tokens`). Output is therefore summed as a lower bound with `outputIsLowerBound: true`, and the UI shows "≥". Thinking is not shown: `reasoningTokens` is `null` for Claude.
- **Ignored fields.** `usage.iterations[]`, `speed`, `fallback_credit` and `server_tool_use` are ignored.
- **Totals source.** Totals are computed only from the full history: `ClaudeHistoryMetadata` / `ClaudeHistoryIndex`, or a full `read()`. The provisional tail page (`claude-history-page.js`, about 50 messages) reports `totals: null` and keeps the last known totals; it never reports partial sums.

**Cost** (user decision). `cost-state` is written only when the CLI exits, and it includes subagents and side queries such as title and web search. Show its `totalCostUSD` only when no assistant record follows the latest `cost-state` record, as `cost: { usd, scope: "cli-exit-incl-subagents" }`. In every other case `cost` is `null`.

**Window** (user decision: model table, as Claude Code itself uses). For first-party sessions only, meaning sessions without a `provider` object:
- **Model id:** the observed `message.model`, falling back to `session.nativeModelId`, with `[1m]` stripped.
- **Table** (from Claude Code 2.1.289):
  - native 1M models → 1,000,000: claude-opus-4-6, -4-7, -4-8, claude-opus-5, -5-5, claude-sonnet-4-6, claude-sonnet-5, -5-5, claude-fable-5 (incl. -5-1), claude-mythos;
  - claude-haiku-4-5 and older → 200,000;
  - any other `claude-*` → 200,000.
- `limitSource: "assumed-model"`.
- If `usedTokens` exceeds the assumed window, the assumption is dropped: `limitTokens: null`, no percentage.
- A configured or reported window always wins.
- Provider or gateway sessions never use the table.
- `finalizeObservability` re-evaluates the assumption on every finalize, including for saved snapshots, so a saved assumed value can be corrected.

**Compaction.** `compactMetadata.postTokens` leaves out system prompt, tools and re-injected attachments, and is 2–13x smaller than the real next context. It is stored as `context.compaction.conversationTokens` and shown labelled "conversation after compaction (excl. system/tools)", without a bar. `usedTokens` stays `null` until the next assistant usage.

**Subagent usage.**
- **Source.** Only `<session>/subagents/agent-<agentId>.jsonl`. Sum assistant `message.usage` with the same last-per-id rule; output is a lower bound.
- **Linking.** Link via `agentId` and `.meta.json.toolUseId` (`toolUseId` is present in 601 of 604 files).
- **Depth-2 agents.** Agents with `parentAgentId` (spawnDepth 2) are rolled into their ancestor's usage. They are never listed as top-level agents.
- **Forks.** They don't overlap with main by `message.id`, so there is no double counting.
- **Workflow agents.** Agents under `subagents/workflows/wf_*/` have no Agent call. Their usage counts in `totals.subagents` as "workflow agents", but they get no row.
- **Duration and tool uses.** From the task-notification `<duration_ms>` and `<tool_uses>`. The notification's `<subagent_tokens>` is the last request's size, not consumption, so it is never used for tokens. Tokens stay `null` when there is no file.
- **Reading layer.** A per-session usage cache next to `ClaudeHistoryPages` (bounded LRU):
  - prefilter lines that contain `"usage"`, and parse complete lines only, because files are live-appended;
  - apply `inside(root)` to `<dir>/<id>/subagents`;
  - re-stat only the files of running agents plus the directory mtime;
  - cache by size and mtime.

  The cold scan runs in the background and never delays the live read. Results are merged into observability when finalizing.

### Codex

**Main totals.** Source: the latest `token_usage_record.payload.thread_token_usage`. It is per thread and never decreases. `token_count.total_token_usage` is per process and resets on resume, so it is only a fallback, labelled "this process".
- Mapping: input, cache read = cached input, cache write, output, reasoning (a subset of output) and total are taken as reported.
- `cost` is `null`.

**Limits.** From `token_count.rate_limits`.
- Keep the latest snapshot **per `limit_id`**. Bucket examples: "codex", which is weekly only; "codex_bengalfox" (GPT-5.3-Codex-Spark), which has 5-hour and weekly windows; "premium".
- Label windows by `window_minutes`, for example "5 h" and "7 days".
- Hide windows whose `resetsAt` is already in the past.
- Show credits only when present.

**Rollout metadata.** Extend the cached projection in `codex-rollout-metadata.js` with `token_usage_record`, `total_token_usage` and `rate_limits`. It tails incrementally; the largest rollout is 985 MB, so it must never re-scan.

**Subagents.**
- **Discovery.** Use `$CODEX_HOME/state_5.sqlite`: `thread_spawn_edges(parent_thread_id, child_thread_id)` joined with `threads.rollout_path`. Open it read-only/immutable, like the OpenCode reader.
- **Child usage.** Its last `token_usage_record` via a backward tail read, cached by size and mtime.
- **Linking.** By thread id only.
- **Totals.** `totals.subagents` covers all children, not only the agents in the observer list.
- **Exclusion.** Children whose rollout lies outside the session's profile root (moved accounts) are excluded and counted as "unavailable".

### OpenCode

- **Main totals and cost:** `SELECT cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write FROM session WHERE id=?`. On the real database this equals the message sums exactly. Cost is real USD.
- **Subagents:** `SELECT … FROM session WHERE parent_id=?`, linked to task rows through the child session id.
- **Window:** unchanged (provider `assumedContextTokens` or the catalog).
- **Source:** the existing database access in `opencode-history-page.js`. Never the paged message sums.

### General

- **Totals source.** Totals and subagent usage come from whole-history sources: index or metadata, the database, or the thread record. A page that sees only part of the history reports `null`, and the last known totals are kept.
- **Errors.** Unparseable or missing data gives `null` and never throws.
- **Staleness.** `observability.stale` keeps its meaning. Totals carry their own `observedAt`.

## 3. UI

**Context row**
- Bar with percentage and "used / window".
- Labels:
  - "assumed" when the window comes from the model table;
  - "saved" when the data is stale;
  - for compaction, the conversation size with its label and no bar.
- On mobile the row stays in the expandable area (`mobile-chat.css`). The collapsed state shows only a compact percentage chip when a window is known.

**Details**
- A totals table: input, output (with "≥" for Claude), cache read, cache write, reasoning (only when not `null`), total.
- Cost:
  - OpenCode: "Cost";
  - Claude: "Cost as of last CLI exit (incl. subagents)";
  - Codex: no cost line.
- A subagent line: "Subagents: N · … tokens". For Claude workflow agents: "incl. workflow agents".
- For Codex, a limits section per bucket, with each window's percentage bar and reset time (relative, absolute on hover).

**Subagent rows and list.** For example "12.4K tokens · 1m 32s", or "≥" for a Claude output lower bound when output dominates. Duration comes from the notification.

**Formatting.** `Intl.NumberFormat` compact notation per locale: EN "12.4K", DE "12.400" / "1,2 Mio.". USD with 2 decimals, or 4 when below 0.01. All labels are in `web/lib/i18n/{de,en}`.

**Restored data.** The existing "saved state" label applies. Restored data is never presented as live.

## 4. Testing

- **Unit, per observer, with synthetic fixtures in the verified real shapes.** Never copy content.
  - Claude:
    - last-per-id dedupe with growing output;
    - placeholder records set `outputIsLowerBound`;
    - no reasoning;
    - cost only when `cost-state` is last;
    - model table (native 1M, haiku 200k, unknown 200k);
    - assumption dropped when used exceeds it;
    - provider sessions never assume;
    - compaction conversation size;
    - provisional page totals `null`;
    - subagent file sums with depth-2 rollup and workflow agents;
    - notification gives duration and tool uses, never tokens.
  - Codex:
    - `thread_token_usage` preferred over a reset `total_token_usage`;
    - `rate_limits` per `limit_id`, past windows hidden, balance string;
    - `state_5.sqlite` child discovery and tail-read totals;
    - excluded foreign-profile children.
  - OpenCode: session row totals and cost; child sessions.
  - Null and malformed values never throw and never become 0.
- **Integration:**
  - the full-parse and index paths give equal totals;
  - the provisional page keeps the last totals;
  - the subagent usage cache rereads only changed files and never delays the live read (cold scan in the background).
- **Browser (Chromium and WebKit, DE and EN):**
  - context bar with "assumed";
  - compaction label;
  - totals with "≥" and the cost scopes;
  - Codex limit buckets;
  - subagent row tokens and duration;
  - mobile chip;
  - "saved" state.
- **Real-data validation (recorded in the PR).** Run the observers in a scratch script on:
  - Claude session 57444b1d: input and cache totals against main plus subagent files; output marked as a lower bound;
  - a Codex parent with children: totals against `token_usage_record`, children against `thread_spawn_edges`;
  - the OpenCode database: totals equal the session row.

## 5. Documentation

Update `docs/chat-observability.md`:
- the fields and sources per CLI;
- the last-per-id rule and why Claude output is a lower bound;
- that Claude cost exists only at CLI exit and includes subagents;
- the model-table window policy (replacing the "no default window" rule) and when an assumption is dropped;
- compaction semantics;
- Codex per-thread totals and limit buckets;
- the OpenCode session row source;
- subagent linking, depth-2 rollup and workflow agents.
