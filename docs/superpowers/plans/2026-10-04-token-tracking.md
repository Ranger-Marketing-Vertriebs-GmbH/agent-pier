# Token Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show per-session context usage against a known or assumed window, honest session totals, per-subagent usage and Codex rate-limit buckets in the chat, for Claude Code, Codex and OpenCode.

**Architecture:**

- Each CLI observer (`observeClaude`, `observeCodex`, `observeOpenCode` plus the page readers) adds `totals`, `limits`, `context.compaction` and an internal `subagentUsage` field, computed only from whole-history sources (index/metadata, full read, thread record, database row).
- `finalizeObservability` is the single merge point: it applies the configured or assumed-model window, merges `subagentUsage` into `subagents[].usage` and `totals.subagents`, hides past limit windows and removes the internal field. `ChatStore.snapshot` keeps the last known totals when a page reports `totals: null`.
- Claude subagent files are read by a bounded background cache (`ClaudeSubagentUsage`); Codex children come from `state_5.sqlite` plus cached backward tail reads (`CodexChildUsage`); OpenCode reads its `session` rows. The React chat renders a context bar/chip, a totals details block and usage on subagent rows and list entries.

**Tech Stack:** Node.js 22.13+ ES modules, `node:sqlite` (`DatabaseSync`), `node:test` with strict assertions, React (JSX), Vite, Playwright (Chromium and WebKit), Prettier.

**Spec:** `docs/superpowers/specs/2026-10-04-token-tracking-design.md`

## Global Constraints

- New `observability` fields are optional; the shape after `finalizeObservability` is `{ context, totals, limits, subagents, stale }`. `subagentUsage` never leaves `finalizeObservability`.
- `context` keeps `{ usedTokens, limitTokens, remainingPercent, source, limitSource, observedAt, modelId }` and gains `compaction: { conversationTokens, observedAt } | null`; `limitSource` gains `"assumed-model"`.
- `totals: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, totalTokens, outputIsLowerBound, cost: { usd, scope: "session" | "cli-exit-incl-subagents" } | null, source, observedAt, subagents } | null`.
- `totals.subagents: { count, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, totalTokens, outputIsLowerBound, costUsd, workflowAgents, unavailable } | null`. Main totals never include subagent usage.
- `subagents[].usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, totalTokens, outputIsLowerBound, toolUses, durationMs, costUsd } | null`. Claude entries also carry `toolUseId` for linking.
- `limits: { source: "codex-rate-limits", buckets: [{ limitId, limitName, plan, windows: [{ windowMinutes, usedPercent, resetsAt }], credits: { hasCredits, unlimited, balance } | null }], observedAt } | null`.
- Token counts are safe non-negative integers or `null`. 0 never means unknown. `usedPercent` is finite and in 0–100. `resetsAt` is epoch milliseconds. `cost.usd` and `costUsd` are finite and non-negative. The credit `balance` stays a string, exactly as reported.
- `totalTokens`: Claude = input + cache write + cache read + output (thinking is part of output, never added). Codex = `total_tokens` as reported (input includes cached; reasoning is a subset of output). OpenCode = input + output + reasoning + cache read + cache write.
- Model table (Claude Code 2.1.289), only for first-party Claude sessions (`session.tool === "claude"` and no `session.provider`): 1,000,000 for claude-opus-4-6, claude-opus-4-7, claude-opus-4-8, claude-opus-5, claude-opus-5-5, claude-sonnet-4-6, claude-sonnet-5, claude-sonnet-5-5, claude-fable-5, claude-fable-5-1, claude-mythos; 200,000 for claude-haiku-4-5 and older and for any other `claude-*` id. Strip `[1m]`. Model id = observed `message.model`, else `session.nativeModelId`.
- A configured or reported window always wins. When `usedTokens` exceeds the assumed window, the assumption is dropped (`limitTokens: null`, no percentage). `finalizeObservability` re-evaluates the assumption on every call, including saved snapshots.
- Claude cost: `cost-state.totalCostUSD` only when no assistant record follows the latest `cost-state` record, as `{ usd, scope: "cli-exit-incl-subagents" }`; otherwise `null`. Codex cost is always `null`. OpenCode cost is the session row's `cost` with scope `"session"`.
- Claude output is a lower bound (`outputIsLowerBound: true` on every Claude totals and subagent usage value, shown as "≥"); `reasoningTokens` is always `null` for Claude. Dedupe keeps the last record per `message.id`; duplicates are adjacent. `usage.iterations[]`, `speed`, `fallback_credit` and `server_tool_use` are ignored.
- Compaction: `compactMetadata.postTokens` is stored as `context.compaction.conversationTokens` and shown as "conversation after compaction (excl. system/tools)" without a bar; `usedTokens` stays `null` until the next assistant usage.
- Codex totals come from the latest `token_usage_record.payload.thread_token_usage` (source `"codex-thread"`); `token_count.info.total_token_usage` is only a fallback labelled "this process" (source `"codex-process"`). Limits keep the latest snapshot per `limit_id`; windows are labelled by `window_minutes`; windows with `resetsAt` in the past are hidden; credits are shown only when present.
- OpenCode totals and cost come from `SELECT cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write FROM session WHERE id=?`, children from `WHERE parent_id=?`, through the existing database access in `opencode-history-page.js`; never paged message sums.
- Subagent linking: Claude via file `agent-<agentId>.jsonl` and `.meta.json.toolUseId`; agents with `parentAgentId` (spawn depth 2) roll into their top-level ancestor and are never listed; agents under `subagents/workflows/wf_*/` count in `totals.subagents` as workflow agents but get no row; the task notification supplies only `<duration_ms>` and `<tool_uses>`, never tokens (`<subagent_tokens>` is ignored). Codex links by thread id only; children outside the profile root are excluded and counted as `unavailable`. OpenCode links by child session id.
- Totals and subagent usage come only from whole-history sources. A page that sees only part of the history reports `totals: null`; the last known totals are kept. Unparseable or missing data gives `null` and never throws.
- All UI text lives in `web/lib/i18n/de/chat-observability.js` and `web/lib/i18n/en/chat-observability.js` with matching keys and interpolation arguments, consumed through `web/lib/i18n/messages/chat-observability.js`. Numbers use `Intl.NumberFormat` compact notation (EN "12.4K", DE "12.400" / "1,2 Mio."); USD has 2 decimals, or 4 below 0.01.
- Source and test files stay at or below 600 lines (`npm run check:structure`). Prettier: two spaces, double quotes, semicolons, trailing commas, 90 columns (`npm run format`).
- Tests use isolated temporary directories and synthetic records in the verified real shapes. Never read real user sessions in tests, never use the default tmux server, never bind port 4380 (Playwright uses 4389).
- Commits are English, use `feat:`, `fix:` or `chore:`, and end with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- PR #172 (`fix/subagent-list-updates`) changes `claude-history-pages.js`, `claude-history-page.js`, `claude-history-index.js`, `subagent-presentation.js`, `SubagentList.jsx`, `ChatView.jsx`, `observability.css`, `useSubagentPresence.js` and the subagent browser fixtures. Tasks touching those files start with a rebase check.

## Review Focus

1. **A Claude subagent finishes after its file was first read** (live append, last line still partial, then the agent leaves the running set): the final usage records must still be read once, or rows freeze at a too-low count. Pinned in Task 3, test "a live file is read in complete lines and re-read once after its agent stops running".
2. **The index path and the full read disagree** because the index converts `api_error` system records into assistant records: cost must not vanish only on indexed pages. Pinned in Task 2, test "indexed pages and the full parse report the same whole-history totals" (API error after `cost-state`).
3. **A Codex rollout carries foreign usage**: a `token_usage_record` of another thread, the `latest_token_usage_record` copy inside a `compacted` record, or a resumed process whose `total_token_usage` restarted. Thread totals must stay the parent's latest record. Pinned in Task 4, tests "records of another thread and compaction snapshots never replace thread totals" and "Codex totals prefer the per-thread record over a reset process total".
4. **An older OpenCode database without token columns** (or a test fixture schema) must keep paging and report `totals: null`, not throw or show zeros. Pinned in Task 6, test "databases without token columns keep paging and report no totals".
5. **A saved snapshot carries an assumed window that no longer holds** (model switched from a 1M model to haiku, or usage grew past the window): re-finalizing must recompute or drop it, never show a stale 1M window. Pinned in Task 1, test "a saved assumed window is re-evaluated on every finalize".

---

## File Structure

| Path                                                                                       | Action | Responsibility                                                                                        |
| ------------------------------------------------------------------------------------------ | ------ | ----------------------------------------------------------------------------------------------------- |
| `server/features/chat/observability-values.js`                                             | Modify | `remainingPercent`, `compaction: null` in `emptyContext`/`contextValue`                               |
| `server/features/chat/token-usage.js`                                                      | Create | Totals/usage value rules, Claude last-per-id accumulator, Codex/OpenCode totals, subagent usage merge |
| `server/features/chat/context-window.js`                                                   | Create | Model table and configured/assumed window application                                                 |
| `server/features/chat/rate-limits.js`                                                      | Create | Codex `rate_limits` projection and limit normalization                                                |
| `server/features/chat/chat-observability.js`                                               | Modify | `finalizeObservability` merge point                                                                   |
| `server/features/chat/claude-observability.js`                                             | Modify | Claude totals, cost, compaction size, notification duration/tool uses, `toolUseId`                    |
| `server/features/chat/claude-subagents.js`                                                 | Modify | `subagentEvent` returns `durationMs`, `toolUses`                                                      |
| `server/features/chat/claude-history-page.js`                                              | Modify | Provisional totals rule, attach `subagentUsage`                                                       |
| `server/features/chat/chat-store.js`                                                       | Modify | Keep last known totals                                                                                |
| `server/features/chat/claude-subagent-usage.js`                                            | Create | Background, bounded per-session subagent usage cache                                                  |
| `server/features/chat/provider-history.js`                                                 | Modify | Own `claudeUsage` and `codexChildren`; attach usage on full reads                                     |
| `server/features/chat/codex-rollout-metadata.js`                                           | Modify | Project `token_usage_record`, `total_token_usage`, `rate_limits`                                      |
| `server/features/chat/codex-observability.js`                                              | Modify | Codex totals and limits                                                                               |
| `server/features/chat/readonly-sqlite.js`                                                  | Create | Shared safe read-only SQLite location/open helpers                                                    |
| `server/features/chat/codex-child-usage.js`                                                | Create | `state_5.sqlite` child discovery, backward tail read                                                  |
| `server/features/chat/history-page.js`                                                     | Modify | Attach Codex child usage                                                                              |
| `server/features/chat/opencode-history-page.js`                                            | Modify | Use shared SQLite helpers; session row totals and children                                            |
| `web/features/chat/token-presentation.js`                                                  | Create | Token, USD, duration, window and usage formatting                                                     |
| `web/features/chat/ContextBudget.jsx`                                                      | Create | Context row: bar, labels, compaction, mobile chip                                                     |
| `web/features/chat/TokenDetails.jsx`                                                       | Create | Totals table, cost, subagent line, limits                                                             |
| `web/features/chat/ChatObservability.jsx`                                                  | Modify | Compose the two components                                                                            |
| `web/features/chat/ChatMessage.jsx`                                                        | Modify | Usage on subagent rows                                                                                |
| `web/features/chat/SubagentList.jsx`                                                       | Modify | Usage on list entries                                                                                 |
| `web/features/chat/observability.css`, `web/features/chat/mobile-chat.css`                 | Modify | Bar, details, chip                                                                                    |
| `web/lib/i18n/de/chat-observability.js`, `web/lib/i18n/en/chat-observability.js`           | Modify | New copy                                                                                              |
| `docs/chat-observability.md`                                                               | Modify | Fields, sources and policies                                                                          |
| `tests/unit/token-usage.test.js`, `tests/unit/observability-finalize.test.js`              | Create | Task 1                                                                                                |
| `tests/unit/claude-token-totals.test.js`, `tests/integration/claude-token-history.test.js` | Create | Task 2                                                                                                |
| `tests/integration/claude-subagent-usage.test.js`                                          | Create | Task 3                                                                                                |
| `tests/unit/codex-token-totals.test.js`                                                    | Create | Task 4                                                                                                |
| `tests/integration/codex-page-metadata.test.js`                                            | Modify | Task 4                                                                                                |
| `tests/integration/codex-child-usage.test.js`                                              | Create | Task 5                                                                                                |
| `tests/integration/opencode-token-totals.test.js`                                          | Create | Task 6                                                                                                |
| `tests/unit/token-presentation.test.js`, `tests/browser/chat-tokens.spec.js`               | Create | Task 7                                                                                                |

---

### Task 1: Data model, value helpers, model-table window and finalize

**Files:**

- Modify: `server/features/chat/observability-values.js:17-59`
- Create: `server/features/chat/token-usage.js`
- Create: `server/features/chat/context-window.js`
- Create: `server/features/chat/rate-limits.js`
- Modify: `server/features/chat/chat-observability.js:1-47`
- Test: `tests/unit/token-usage.test.js`, `tests/unit/observability-finalize.test.js`

**Interfaces:**

- Consumes: `list`, `object`, `text`, `nativeId`, `tokens`, `timestamp`, `codexRemaining` from `observability-values.js`.
- Produces:
  - `observability-values.js`: `remainingPercent(used, limit) -> number | null`; `emptyContext()` and `contextValue()` now include `compaction: null`.
  - `token-usage.js`: `usd(value) -> number | null`; `addTokens(...values) -> number | null`; `totalsValue(fields) -> Totals | null`; `normalizeTotals(value) -> Totals | null`; `normalizeUsage(value) -> Usage | null`; `usageFromTotals(totals) -> Usage | null`; `sumUsage(entries) -> Usage | null`; `createClaudeUsage() -> { add(message, at), totals(cost = null) -> Totals | null }`; `codexTotals(usage, source, observedAt) -> Totals | null`; `openCodeTotals(row, observedAt = null) -> Totals | null`; `normalizeSubagentUsage(value) -> SubagentUsage | null`; `subagentTotals(usage) -> SubagentTotals | null`; `agentUsage(agent, usage) -> Usage | null`.
  - Internal `SubagentUsage = { agents: { [agentId]: Usage }, toolUses: { [toolUseId]: agentId }, workflow: { count, usage: Usage | null } | null, unavailable: number, observedAt }`.
  - `context-window.js`: `assumedClaudeWindow(modelId) -> 1000000 | 200000 | null`; `applyContextWindow(context, session) -> context`.
  - `rate-limits.js`: `codexRateLimit(raw) -> Bucket | null`; `normalizeLimits(value, now = Date.now()) -> Limits | null`.
  - `finalizeObservability(value, session, { stale = false, now = Date.now() } = {}) -> { context, totals, limits, subagents, stale }`.

- [ ] **Step 1: Write the failing value-helper tests**

Create `tests/unit/token-usage.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  addTokens,
  totalsValue,
  normalizeTotals,
  createClaudeUsage,
  codexTotals,
  openCodeTotals,
  normalizeSubagentUsage,
  subagentTotals,
  agentUsage,
} from "../../server/features/chat/token-usage.js";

const message = (id, output, stop) => ({
  id,
  stop_reason: stop,
  usage: {
    input_tokens: 10,
    cache_creation_input_tokens: 100,
    cache_read_input_tokens: 1000,
    output_tokens: output,
    output_tokens_details: { thinking_tokens: 4 },
    iterations: [],
    speed: "standard",
    fallback_credit: null,
    server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
  },
});

test("token sums are null when any part is unknown and never invent zero", () => {
  assert.equal(addTokens(1, 2, 3), 6);
  assert.equal(addTokens(1, null), null);
  assert.equal(addTokens(1, -1), null);
  assert.equal(addTokens(1, 1.5), null);
  assert.equal(totalsValue({}), null);
  assert.equal(totalsValue({ inputTokens: "12" }), null);
  const totals = totalsValue({ inputTokens: 0, cost: { usd: -1, scope: "session" } });
  assert.equal(totals.inputTokens, 0);
  assert.equal(totals.cost, null);
  assert.equal(totalsValue({ cost: { usd: 1, scope: "guess" } }), null);
});

test("Claude usage keeps the last record per message id and output is a lower bound", () => {
  const usage = createClaudeUsage();
  usage.add(message("msg_a", 1, null), "2026-10-01T10:00:00Z");
  usage.add(message("msg_a", 40, null), "2026-10-01T10:00:01Z");
  usage.add(message("msg_a", 250, "end_turn"), "2026-10-01T10:00:02Z");
  usage.add(message("msg_b", 3, null), "2026-10-01T10:00:03Z");
  const totals = usage.totals();
  assert.deepEqual(
    [
      totals.inputTokens,
      totals.cacheWriteTokens,
      totals.cacheReadTokens,
      totals.outputTokens,
      totals.reasoningTokens,
      totals.totalTokens,
    ],
    [20, 200, 2000, 253, null, 2473],
  );
  assert.equal(totals.outputIsLowerBound, true);
  assert.equal(totals.source, "claude-transcript");
  assert.equal(totals.observedAt, "2026-10-01T10:00:03.000Z");
  const final = createClaudeUsage();
  final.add(message("msg_c", 7, "tool_use"));
  assert.equal(final.totals().outputIsLowerBound, true);
  assert.equal(createClaudeUsage().totals(), null);
});

test("malformed Claude usage is skipped, not counted as zero", () => {
  const usage = createClaudeUsage();
  usage.add({
    id: "x",
    stop_reason: "end_turn",
    usage: { input_tokens: "5", output_tokens: 1 },
  });
  usage.add({
    id: "y",
    stop_reason: "end_turn",
    usage: { input_tokens: 5, cache_read_input_tokens: -2 },
  });
  assert.equal(usage.totals(), null);
  usage.add({
    id: "z",
    stop_reason: "end_turn",
    usage: { input_tokens: 5, output_tokens: 2 },
  });
  assert.equal(usage.totals().totalTokens, 7);
});

test("Codex totals are taken as reported and reasoning stays a subset of output", () => {
  const totals = codexTotals(
    {
      input_tokens: 9000,
      cached_input_tokens: 6000,
      cache_write_input_tokens: 0,
      output_tokens: 700,
      reasoning_output_tokens: 300,
      total_tokens: 9700,
    },
    "codex-thread",
    "2026-10-01T10:00:00Z",
  );
  assert.deepEqual(
    [
      totals.inputTokens,
      totals.cacheReadTokens,
      totals.cacheWriteTokens,
      totals.outputTokens,
      totals.reasoningTokens,
      totals.totalTokens,
      totals.cost,
      totals.source,
      totals.outputIsLowerBound,
    ],
    [9000, 6000, 0, 700, 300, 9700, null, "codex-thread", false],
  );
});

test("OpenCode totals add reasoning and both cache counts and carry real cost", () => {
  const totals = openCodeTotals(
    {
      cost: 0.4321,
      tokens_input: 100,
      tokens_output: 50,
      tokens_reasoning: 25,
      tokens_cache_read: 400,
      tokens_cache_write: 10,
    },
    1759312800000,
  );
  assert.equal(totals.totalTokens, 585);
  assert.deepEqual(totals.cost, { usd: 0.4321, scope: "session" });
  assert.equal(totals.observedAt, "2025-10-01T10:00:00.000Z");
  const partial = openCodeTotals({
    cost: null,
    tokens_input: 1,
    tokens_output: null,
    tokens_reasoning: 0,
    tokens_cache_read: 0,
    tokens_cache_write: 0,
  });
  assert.equal(partial.totalTokens, null);
  assert.equal(partial.outputTokens, null);
  assert.equal(partial.cost, null);
});

test("subagent totals sum linked and workflow agents and keep prototype-like ids apart", () => {
  const file = (total) => ({
    inputTokens: 1,
    outputTokens: total - 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: null,
    totalTokens: total,
    outputIsLowerBound: true,
  });
  const usage = normalizeSubagentUsage({
    agents: { agentreview01: file(100), constructor: file(5) },
    toolUses: { toolu_review: "agentreview01" },
    workflow: { count: 2, usage: file(50) },
    unavailable: 0,
  });
  const totals = subagentTotals(usage);
  assert.equal(totals.count, 4);
  assert.equal(totals.totalTokens, 155);
  assert.equal(totals.reasoningTokens, null);
  assert.equal(totals.workflowAgents, 2);
  assert.equal(totals.outputIsLowerBound, true);
  assert.equal(agentUsage({ id: "toString" }, usage), null);
  assert.equal(
    agentUsage({ id: "unknown", toolUseId: "toolu_review" }, usage).totalTokens,
    100,
  );
  const merged = agentUsage(
    { id: "agentreview01", usage: { toolUses: 12, durationMs: 92000 } },
    usage,
  );
  assert.deepEqual(
    [merged.totalTokens, merged.toolUses, merged.durationMs],
    [100, 12, 92000],
  );
  const unread = agentUsage(
    { id: "agentnone", usage: { toolUses: 3, durationMs: 1000 } },
    usage,
  );
  assert.deepEqual([unread.totalTokens, unread.toolUses], [null, 3]);
  assert.equal(
    subagentTotals(normalizeSubagentUsage({ agents: {}, unavailable: 0 })),
    null,
  );
});

test("finalized totals survive a saved snapshot round trip unchanged", () => {
  const totals = totalsValue({
    inputTokens: 1,
    outputTokens: 2,
    cacheReadTokens: 3,
    cacheWriteTokens: 4,
    reasoningTokens: null,
    totalTokens: 10,
    outputIsLowerBound: true,
    cost: { usd: 0.005, scope: "cli-exit-incl-subagents" },
    source: "claude-transcript",
    observedAt: "2026-10-01T10:00:00Z",
  });
  totals.subagents = subagentTotals(
    normalizeSubagentUsage({
      agents: { agentreview01: { totalTokens: 9, outputTokens: 9 } },
      unavailable: 1,
    }),
  );
  assert.deepEqual(normalizeTotals(JSON.parse(JSON.stringify(totals))), totals);
});
```

- [ ] **Step 2: Write the failing finalize tests**

Create `tests/unit/observability-finalize.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { finalizeObservability } from "../../server/features/chat/chat-observability.js";
import { assumedClaudeWindow } from "../../server/features/chat/context-window.js";
import {
  codexRateLimit,
  normalizeLimits,
} from "../../server/features/chat/rate-limits.js";

const claude = (context, extra = {}) => ({
  context: {
    usedTokens: null,
    limitTokens: null,
    remainingPercent: null,
    source: null,
    limitSource: null,
    observedAt: null,
    modelId: null,
    ...context,
  },
  subagents: [],
  ...extra,
});
const firstParty = { status: "running", tool: "claude" };

test("model table assumes 1M for native 1M Claude models and 200k otherwise", () => {
  for (const id of [
    "claude-opus-4-6",
    "claude-opus-4-7",
    "claude-opus-4-8",
    "claude-opus-5",
    "claude-opus-5-5",
    "claude-sonnet-4-6",
    "claude-sonnet-5",
    "claude-sonnet-5-5",
    "claude-fable-5",
    "claude-fable-5-1",
    "claude-mythos",
    "claude-opus-5-5[1m]",
  ])
    assert.equal(assumedClaudeWindow(id), 1000000, id);
  for (const id of [
    "claude-haiku-4-5",
    "claude-haiku-4-5-20251001",
    "claude-sonnet-4-5-20250929",
    "claude-opus-4-1",
    "claude-future-9",
  ])
    assert.equal(assumedClaudeWindow(id), 200000, id);
  for (const id of [null, "", "opus", "gpt-5", "<synthetic>"])
    assert.equal(assumedClaudeWindow(id), null, String(id));
});

test("first-party Claude sessions get an assumed window that is dropped when exceeded", () => {
  const assumed = finalizeObservability(
    claude({
      usedTokens: 250000,
      source: "last-api-request",
      modelId: "claude-opus-5-5",
    }),
    firstParty,
  ).context;
  assert.deepEqual(
    [assumed.limitTokens, assumed.limitSource, assumed.remainingPercent],
    [1000000, "assumed-model", 75],
  );
  const fallback = finalizeObservability(claude({}), {
    ...firstParty,
    nativeModelId: "claude-sonnet-5[1m]",
  }).context;
  assert.deepEqual([fallback.limitTokens, fallback.remainingPercent], [1000000, null]);
  const dropped = finalizeObservability(
    claude({
      usedTokens: 250000,
      source: "last-api-request",
      modelId: "claude-haiku-4-5",
    }),
    firstParty,
  ).context;
  assert.deepEqual(
    [dropped.limitTokens, dropped.limitSource, dropped.remainingPercent],
    [null, null, null],
  );
});

test("provider sessions, other CLIs and reported windows never use the model table", () => {
  const used = { usedTokens: 10, source: "last-api-request", modelId: "claude-opus-5-5" };
  assert.equal(
    finalizeObservability(claude(used), {
      ...firstParty,
      provider: { contextStatus: "native-catalog" },
    }).context.limitTokens,
    null,
  );
  assert.equal(
    finalizeObservability(claude(used), { status: "running", tool: "opencode" }).context
      .limitTokens,
    null,
  );
  const configured = finalizeObservability(claude({ ...used, modelId: "fixture" }), {
    ...firstParty,
    provider: {
      contextStatus: "configured",
      assumedContextTokens: 64000,
      requestedModelId: "fixture",
    },
  }).context;
  assert.deepEqual(
    [configured.limitTokens, configured.limitSource],
    [64000, "configured"],
  );
  const native = finalizeObservability(
    claude({ ...used, limitTokens: 400000, limitSource: "native" }),
    firstParty,
  ).context;
  assert.deepEqual([native.limitTokens, native.limitSource], [400000, "native"]);
});

test("a saved assumed window is re-evaluated on every finalize", () => {
  const saved = finalizeObservability(
    claude({
      usedTokens: 300000,
      source: "last-api-request",
      modelId: "claude-opus-5-5",
    }),
    firstParty,
  );
  const switched = finalizeObservability(
    { ...saved, context: { ...saved.context, modelId: "claude-haiku-4-5" } },
    firstParty,
    { stale: true },
  );
  assert.deepEqual(
    [
      switched.context.limitTokens,
      switched.context.limitSource,
      switched.context.remainingPercent,
    ],
    [null, null, null],
  );
  assert.equal(switched.stale, true);
  assert.deepEqual(finalizeObservability(saved, firstParty).context, saved.context);
});

test("compaction keeps only the post-compaction conversation size and no percentage", () => {
  const value = finalizeObservability(
    claude({
      modelId: "claude-opus-5-5",
      compaction: { conversationTokens: 41200, observedAt: "2026-10-01T10:00:00Z" },
    }),
    firstParty,
  ).context;
  assert.deepEqual(value.compaction, {
    conversationTokens: 41200,
    observedAt: "2026-10-01T10:00:00.000Z",
  });
  assert.equal(value.usedTokens, null);
  assert.equal(value.remainingPercent, null);
  assert.equal(
    finalizeObservability(claude({ compaction: { conversationTokens: "x" } }), firstParty)
      .context.compaction,
    null,
  );
});

test("Codex rate limits keep buckets per limit id, drop past windows and keep the balance string", () => {
  const now = Date.parse("2026-10-01T10:00:00Z");
  const future = now / 1000 + 3600,
    past = now / 1000 - 60;
  const codex = codexRateLimit({
    limit_id: "codex",
    limit_name: null,
    primary: { used_percent: 42.5, window_minutes: 10080, resets_at: future },
    secondary: null,
    credits: { has_credits: true, unlimited: false, balance: "12.5000" },
    individual_limit: null,
    plan_type: "pro",
  });
  assert.deepEqual(codex, {
    limitId: "codex",
    limitName: null,
    plan: "pro",
    windows: [{ windowMinutes: 10080, usedPercent: 42.5, resetsAt: future * 1000 }],
    credits: { hasCredits: true, unlimited: false, balance: "12.5000" },
  });
  const spark = codexRateLimit({
    limit_id: "codex_bengalfox",
    limit_name: "GPT-5.3-Codex-Spark",
    primary: { used_percent: 130, window_minutes: 300, resets_at: past },
    secondary: { used_percent: 7, window_minutes: 10080, resets_at: future },
    credits: null,
  });
  const premium = codexRateLimit({ limit_id: "premium", primary: null, secondary: null });
  const limits = normalizeLimits(
    { buckets: [codex, spark, premium], observedAt: "2026-10-01T09:59:00Z" },
    now,
  );
  assert.deepEqual(
    limits.buckets.map((bucket) => [
      bucket.limitId,
      bucket.windows.map((w) => w.windowMinutes),
    ]),
    [
      ["codex", [10080]],
      ["codex_bengalfox", [10080]],
    ],
  );
  assert.equal(limits.buckets[0].credits.balance, "12.5000");
  assert.equal(
    codexRateLimit({ limit_id: "x", primary: { used_percent: Number.NaN } }).windows
      .length,
    0,
  );
  assert.equal(
    codexRateLimit({
      limit_id: "x",
      primary: { used_percent: 130, window_minutes: 300, resets_at: future },
    }).windows[0].usedPercent,
    100,
  );
  assert.equal(normalizeLimits({ buckets: [] }, now), null);
  assert.equal(
    finalizeObservability({ limits: { buckets: [spark] } }, firstParty, { now }).limits
      .buckets[0].windows.length,
    1,
  );
});

test("finalize merges subagent usage into rows and totals and drops the internal field", () => {
  const value = finalizeObservability(
    {
      context: {},
      subagents: [
        {
          id: "agentreview01",
          name: "",
          task: "",
          status: "completed",
          usage: { toolUses: 4, durationMs: 61000 },
        },
      ],
      totals: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: null,
        totalTokens: 15,
        outputIsLowerBound: true,
        source: "claude-transcript",
      },
      subagentUsage: {
        agents: {
          agentreview01: {
            inputTokens: 1,
            outputTokens: 2,
            cacheReadTokens: 3,
            cacheWriteTokens: 4,
            reasoningTokens: null,
            totalTokens: 10,
            outputIsLowerBound: true,
          },
        },
        toolUses: {},
        workflow: null,
        unavailable: 0,
      },
    },
    firstParty,
  );
  assert.equal(Object.hasOwn(value, "subagentUsage"), false);
  assert.equal(value.totals.totalTokens, 15);
  assert.equal(value.totals.subagents.totalTokens, 10);
  assert.deepEqual(
    [value.subagents[0].usage.totalTokens, value.subagents[0].usage.durationMs],
    [10, 61000],
  );
  const saved = finalizeObservability(JSON.parse(JSON.stringify(value)), firstParty, {
    stale: true,
  });
  assert.deepEqual(saved.totals, value.totals);
  assert.deepEqual(saved.subagents[0].usage, value.subagents[0].usage);
  assert.deepEqual(finalizeObservability(null, firstParty).totals, null);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test tests/unit/token-usage.test.js tests/unit/observability-finalize.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `token-usage.js`, `context-window.js` and `rate-limits.js`.

- [ ] **Step 4: Extend the shared value helpers**

In `server/features/chat/observability-values.js`, add `compaction: null` as the last key of `emptyContext()` (line 17-25), add `remainingPercent` after `inputTokens` and let `contextValue` use it:

```js
export function remainingPercent(used, limit) {
  if (tokens(used) === null || !(tokens(limit) > 0)) return null;
  return Math.round(Math.max(0, Math.min(100, (1 - used / limit) * 100)) * 10) / 10;
}
```

Replace the returned object of `contextValue` (lines 47-58) with:

```js
return {
  usedTokens: used,
  limitTokens: limit,
  remainingPercent: remainingPercent(used, limit),
  source: used === null ? null : source,
  limitSource: limit ? "native" : null,
  observedAt: timestamp(observedAt),
  modelId: text(modelId, 200) || null,
  compaction: null,
};
```

- [ ] **Step 5: Create `server/features/chat/token-usage.js`**

```js
import {
  list,
  object,
  text,
  nativeId,
  tokens,
  timestamp,
} from "./observability-values.js";

const FIELDS = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "reasoningTokens",
  "totalTokens",
];
const COST_SCOPES = new Set(["session", "cli-exit-incl-subagents"]);
const MAX_AGENTS = 1024;
const own = (map, key) =>
  typeof key === "string" && Object.hasOwn(map, key) ? map[key] : null;

export const usd = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

/** Sum of token counts; null as soon as one part is unknown. */
export function addTokens(...values) {
  let sum = 0;
  for (const value of values) {
    if (tokens(value) === null) return null;
    sum += value;
  }
  return tokens(sum);
}

function normalizeCost(value) {
  const cost = object(value);
  const amount = usd(cost.usd);
  return amount !== null && COST_SCOPES.has(cost.scope)
    ? { usd: amount, scope: cost.scope }
    : null;
}

/** Validated totals; null when neither a token count nor a cost is known. */
export function totalsValue(value) {
  const input = object(value);
  const counts = Object.fromEntries(FIELDS.map((field) => [field, tokens(input[field])]));
  const cost = normalizeCost(input.cost);
  if (FIELDS.every((field) => counts[field] === null) && !cost) return null;
  return {
    ...counts,
    outputIsLowerBound: input.outputIsLowerBound === true,
    cost,
    source: text(input.source, 60) || null,
    observedAt: timestamp(input.observedAt),
    subagents: null,
  };
}

/** Totals restored from a snapshot or produced by an observer, including subagents. */
export function normalizeTotals(value) {
  const totals = totalsValue(value);
  if (!totals) return null;
  const sub = object(value.subagents);
  totals.subagents =
    tokens(sub.count) !== null
      ? {
          count: sub.count,
          ...Object.fromEntries(FIELDS.map((field) => [field, tokens(sub[field])])),
          outputIsLowerBound: sub.outputIsLowerBound === true,
          costUsd: usd(sub.costUsd),
          workflowAgents: tokens(sub.workflowAgents) ?? 0,
          unavailable: tokens(sub.unavailable) ?? 0,
        }
      : null;
  return totals;
}

export function normalizeUsage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const usage = {
    ...Object.fromEntries(FIELDS.map((field) => [field, tokens(value[field])])),
    outputIsLowerBound: value.outputIsLowerBound === true,
    toolUses: tokens(value.toolUses),
    durationMs: tokens(value.durationMs),
    costUsd: usd(value.costUsd),
  };
  const known =
    FIELDS.some((field) => usage[field] !== null) ||
    usage.toolUses !== null ||
    usage.durationMs !== null ||
    usage.costUsd !== null;
  return known ? usage : null;
}

export const usageFromTotals = (totals) =>
  totals ? normalizeUsage({ ...totals, costUsd: totals.cost?.usd ?? null }) : null;

const counted = (usage) => tokens(usage?.totalTokens) !== null;

/** Field-wise sum over entries with token data; a field is null when any entry lacks it. */
export function sumUsage(entries) {
  const parts = list(entries).filter(counted);
  if (!parts.length) return null;
  const costs = parts.map((entry) => usd(entry.costUsd));
  return {
    ...Object.fromEntries(
      FIELDS.map((field) => [field, addTokens(...parts.map((entry) => entry[field]))]),
    ),
    outputIsLowerBound: parts.some((entry) => entry.outputIsLowerBound === true),
    toolUses: null,
    durationMs: null,
    costUsd: costs.every((cost) => cost !== null)
      ? costs.reduce((sum, cost) => sum + cost, 0)
      : null,
  };
}

/**
 * Claude transcript usage. Duplicates of one message.id are adjacent and their
 * output only grows, so the last record per id replaces the previous one.
 */
export function createClaudeUsage() {
  const sums = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  let current = null,
    currentId = null,
    committed = 0,
    observedAt = null;
  const commit = () => {
    if (!current) return;
    for (const key of Object.keys(sums)) sums[key] += current[key];
    committed++;
    current = null;
  };
  return {
    add(message, at) {
      const usage = object(message?.usage);
      const optional = (name) =>
        usage[name] === undefined || usage[name] === null ? 0 : tokens(usage[name]);
      const record = {
        input: tokens(usage.input_tokens),
        cacheWrite: optional("cache_creation_input_tokens"),
        cacheRead: optional("cache_read_input_tokens"),
        output: optional("output_tokens"),
      };
      // Malformed usage is skipped, never counted as zero.
      if (Object.values(record).some((value) => value === null)) return;
      const id = typeof message.id === "string" && message.id ? message.id : null;
      if (!(id && id === currentId)) commit();
      current = record;
      currentId = id;
      observedAt = timestamp(at) ?? observedAt;
    },
    totals(cost = null) {
      if (!committed && !current) return totalsValue({ cost });
      const sum = (key) => sums[key] + (current ? current[key] : 0);
      const input = sum("input"),
        cacheWrite = sum("cacheWrite"),
        cacheRead = sum("cacheRead"),
        output = sum("output");
      return totalsValue({
        inputTokens: input,
        cacheWriteTokens: cacheWrite,
        cacheReadTokens: cacheRead,
        outputTokens: output,
        reasoningTokens: null,
        totalTokens: addTokens(input, cacheWrite, cacheRead, output),
        // Many responses never receive final usage in the transcript
        // (stop_reason null, placeholder output), so output is always a lower bound.
        outputIsLowerBound: true,
        cost,
        source: "claude-transcript",
        observedAt,
      });
    },
  };
}

/** Codex token usage exactly as reported: input includes cached input. */
export function codexTotals(usage, source, observedAt) {
  const value = object(usage);
  return totalsValue({
    inputTokens: value.input_tokens,
    cacheReadTokens: value.cached_input_tokens,
    cacheWriteTokens: value.cache_write_input_tokens,
    outputTokens: value.output_tokens,
    reasoningTokens: value.reasoning_output_tokens,
    totalTokens: value.total_tokens,
    source,
    observedAt,
  });
}

/** OpenCode session row: reasoning and both cache counts are separate, so all add up. */
export function openCodeTotals(row, observedAt = null) {
  const value = object(row);
  const amount = usd(value.cost);
  return totalsValue({
    inputTokens: value.tokens_input,
    outputTokens: value.tokens_output,
    reasoningTokens: value.tokens_reasoning,
    cacheReadTokens: value.tokens_cache_read,
    cacheWriteTokens: value.tokens_cache_write,
    totalTokens: addTokens(
      value.tokens_input,
      value.tokens_output,
      value.tokens_reasoning,
      value.tokens_cache_read,
      value.tokens_cache_write,
    ),
    cost: amount === null ? null : { usd: amount, scope: "session" },
    source: "opencode-session",
    observedAt,
  });
}

export function normalizeSubagentUsage(value) {
  if (!value || typeof value !== "object") return null;
  const agents = {},
    toolUses = {};
  for (const [id, entry] of Object.entries(object(value.agents)).slice(0, MAX_AGENTS)) {
    const usage = normalizeUsage(entry);
    if (nativeId(id) && usage) agents[id] = usage;
  }
  for (const [callId, agentId] of Object.entries(object(value.toolUses)).slice(
    0,
    MAX_AGENTS,
  ))
    if (nativeId(callId) && nativeId(agentId)) toolUses[callId] = agentId;
  const workflow = object(value.workflow);
  return {
    agents,
    toolUses,
    workflow:
      tokens(workflow.count) > 0
        ? { count: workflow.count, usage: normalizeUsage(workflow.usage) }
        : null,
    unavailable: tokens(value.unavailable) ?? 0,
  };
}

/** `totals.subagents`: every known agent, not only the agents the observer lists. */
export function subagentTotals(usage) {
  if (!usage) return null;
  const count = Object.keys(usage.agents).length + (usage.workflow?.count || 0);
  if (!count && !usage.unavailable) return null;
  const sum = sumUsage([
    ...Object.values(usage.agents),
    ...(usage.workflow?.usage ? [usage.workflow.usage] : []),
  ]);
  return {
    count,
    ...Object.fromEntries(FIELDS.map((field) => [field, sum ? sum[field] : null])),
    outputIsLowerBound: Boolean(sum?.outputIsLowerBound),
    costUsd: sum ? sum.costUsd : null,
    workflowAgents: usage.workflow?.count || 0,
    unavailable: usage.unavailable,
  };
}

/** Row usage: file or database tokens linked by id or tool-use id, plus notification values. */
export function agentUsage(agent, usage) {
  const previous = normalizeUsage(agent?.usage);
  const linked = usage
    ? own(usage.agents, agent?.id) ||
      own(usage.agents, own(usage.toolUses, agent?.toolUseId))
    : null;
  if (!linked) return previous;
  return normalizeUsage({
    ...linked,
    toolUses: previous?.toolUses ?? null,
    durationMs: previous?.durationMs ?? null,
  });
}
```

- [ ] **Step 6: Create `server/features/chat/context-window.js`**

```js
import { tokens, remainingPercent, codexRemaining } from "./observability-values.js";

// Claude Code 2.1.289 model table: native 1M models, everything else 200k.
const NATIVE_1M = new Set([
  "claude-opus-4-6",
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-opus-5",
  "claude-opus-5-5",
  "claude-sonnet-4-6",
  "claude-sonnet-5",
  "claude-sonnet-5-5",
  "claude-fable-5",
  "claude-fable-5-1",
]);
const stripped = (value) =>
  typeof value === "string" ? value.replace(/\[1m\]$/i, "").trim() : null;

export function assumedClaudeWindow(modelId) {
  const id = stripped(modelId)?.toLowerCase();
  if (!id?.startsWith("claude-")) return null;
  const base = id.replace(/-\d{8}$/, "");
  if (NATIVE_1M.has(base) || /^claude-mythos(?:-|$)/.test(base)) return 1000000;
  return 200000;
}

/**
 * Reported windows win, then an exact configured provider window, then (first-party
 * Claude only) the model table. A saved assumption is always re-evaluated.
 */
export function applyContextWindow(input, session) {
  const context = { ...input };
  if (context.limitSource === "assumed-model")
    Object.assign(context, {
      limitTokens: null,
      limitSource: null,
      remainingPercent: null,
    });
  const percent = (limit) =>
    context.source === "native-token-count"
      ? codexRemaining(context.usedTokens, limit)
      : remainingPercent(context.usedTokens, limit);
  const provider = session?.provider;
  const selected = [
    provider?.cliModelId,
    provider?.requestedModelId,
    provider?.effectiveModelId,
    provider?.modelId,
  ]
    .filter((value) => typeof value === "string")
    .map(stripped);
  const observed = stripped(context.modelId);
  if (
    context.limitTokens === null &&
    provider?.contextStatus === "configured" &&
    tokens(provider.assumedContextTokens) > 0 &&
    (!observed || selected.includes(observed))
  )
    Object.assign(context, {
      limitTokens: provider.assumedContextTokens,
      limitSource: "configured",
      remainingPercent: percent(provider.assumedContextTokens),
    });
  if (context.limitTokens === null && session?.tool === "claude" && !provider) {
    const window = assumedClaudeWindow(
      /^claude-/i.test(observed || "") ? observed : session.nativeModelId,
    );
    const used = tokens(context.usedTokens);
    if (window && !(used !== null && used > window))
      Object.assign(context, {
        limitTokens: window,
        limitSource: "assumed-model",
        remainingPercent: percent(window),
      });
  }
  return context;
}
```

- [ ] **Step 7: Create `server/features/chat/rate-limits.js`**

```js
import { list, object, text, tokens, timestamp } from "./observability-values.js";

const MAX_BUCKETS = 16;
const percent = (value) =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.min(100, Math.max(0, value))
    : null;

function codexWindow(raw) {
  const value = object(raw);
  const usedPercent = percent(value.used_percent);
  if (usedPercent === null) return null;
  const minutes = tokens(value.window_minutes),
    resets = tokens(value.resets_at);
  return {
    windowMinutes: minutes > 0 ? minutes : null,
    usedPercent,
    resetsAt: resets === null ? null : resets * 1000,
  };
}

function credits(raw, snake) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const balance = raw.balance;
  return {
    hasCredits: (snake ? raw.has_credits : raw.hasCredits) === true,
    unlimited: raw.unlimited === true,
    balance: typeof balance === "string" && balance.length <= 40 ? balance : null,
  };
}

/** One `token_count.rate_limits` snapshot as a bucket; resets_at is epoch seconds. */
export function codexRateLimit(raw) {
  const value = object(raw);
  const limitId = text(value.limit_id, 120);
  if (!limitId) return null;
  return {
    limitId,
    limitName: text(value.limit_name, 120) || null,
    plan: text(value.plan_type, 60) || null,
    windows: [value.primary, value.secondary].map(codexWindow).filter(Boolean),
    credits: credits(value.credits, true),
  };
}

/** Buckets with current windows or usable credits; past windows are hidden. */
export function normalizeLimits(value, now = Date.now()) {
  const buckets = [];
  for (const raw of list(value?.buckets).slice(0, MAX_BUCKETS)) {
    const bucket = object(raw);
    const limitId = text(bucket.limitId, 120);
    const windows = list(bucket.windows).flatMap((entry) => {
      const window = object(entry);
      const usedPercent = percent(window.usedPercent);
      const resetsAt = tokens(window.resetsAt);
      if (usedPercent === null || (resetsAt !== null && resetsAt <= now)) return [];
      const minutes = tokens(window.windowMinutes);
      return [{ windowMinutes: minutes > 0 ? minutes : null, usedPercent, resetsAt }];
    });
    const credit = credits(bucket.credits, false);
    const usable = credit && (credit.hasCredits || credit.unlimited);
    if (!limitId || (!windows.length && !usable)) continue;
    buckets.push({
      limitId,
      limitName: text(bucket.limitName, 120) || null,
      plan: text(bucket.plan, 60) || null,
      windows,
      credits: credit,
    });
  }
  return buckets.length
    ? { source: "codex-rate-limits", buckets, observedAt: timestamp(value?.observedAt) }
    : null;
}
```

- [ ] **Step 8: Rewrite `finalizeObservability`**

Replace `server/features/chat/chat-observability.js` lines 1-47 with:

```js
import { emptyContext, list, tokens, timestamp } from "./observability-values.js";
import { applyContextWindow } from "./context-window.js";
import {
  normalizeTotals,
  normalizeSubagentUsage,
  subagentTotals,
  agentUsage,
} from "./token-usage.js";
import { normalizeLimits } from "./rate-limits.js";
export { observeClaude } from "./claude-observability.js";
export { observeCodex } from "./codex-observability.js";
export { observeOpenCode } from "./opencode-observability.js";

function compaction(value) {
  const conversationTokens = tokens(value?.conversationTokens);
  return conversationTokens === null
    ? null
    : { conversationTokens, observedAt: timestamp(value.observedAt) };
}

/** The single merge point for live pages and saved snapshots. */
export function finalizeObservability(
  value,
  session,
  { stale = false, now = Date.now() } = {},
) {
  const base = { ...emptyContext(), ...value?.context };
  const context = applyContextWindow(
    { ...base, compaction: compaction(base.compaction) },
    session,
  );
  const usage = normalizeSubagentUsage(value?.subagentUsage);
  const totals = normalizeTotals(value?.totals);
  if (totals && usage) totals.subagents = subagentTotals(usage);
  return {
    context,
    totals,
    limits: normalizeLimits(value?.limits, now),
    subagents: list(value?.subagents).map((agent) => ({
      ...agent,
      ...(session?.status !== "running" && agent.status === "running"
        ? { status: "unknown" }
        : {}),
      usage: agentUsage(agent, usage),
    })),
    stale: stale || Boolean(value?.stale),
  };
}
```

- [ ] **Step 9: Run the new and existing observability tests**

Run: `node --test tests/unit/token-usage.test.js tests/unit/observability-finalize.test.js tests/unit/observability.test.js tests/unit/claude-subagents.test.js tests/integration/observability-history.test.js`
Expected: PASS (all tests).

- [ ] **Step 10: Format, lint and commit**

```bash
npm run format && npm run lint
git add server/features/chat/observability-values.js server/features/chat/token-usage.js \
  server/features/chat/context-window.js server/features/chat/rate-limits.js \
  server/features/chat/chat-observability.js tests/unit/token-usage.test.js \
  tests/unit/observability-finalize.test.js
git commit -F - <<'EOF'
feat: add token totals data model and assumed Claude windows

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 2: Claude main totals, cost, compaction size and last known totals

**Before starting:** run `git fetch origin && git log --oneline origin/main -5`. If PR #172 (`fix/subagent-list-updates`) has merged, `git rebase origin/main` first. After the rebase, `readClaudePage` serves `history.claudePages.metadata(...)` (the whole indexed snapshot) before falling back to `observeClaude(ordered)`; that snapshot's totals are whole-history and pass through unchanged. Apply the provisional rule in Step 5 only to the `observeClaude(ordered)` fallback.

**Files:**

- Modify: `server/features/chat/claude-subagents.js:101-111` (`subagentEvent`)
- Modify: `server/features/chat/claude-observability.js:1-13, 42-60, 61-84, 142-154, 188-192`
- Modify: `server/features/chat/claude-history-page.js:103-113`
- Modify: `server/features/chat/chat-store.js:21-36` (constructor), `67-73` (`reset`), `237-261` (`snapshot`)
- Test: `tests/unit/claude-token-totals.test.js`, `tests/integration/claude-token-history.test.js`

**Interfaces:**

- Consumes: `createClaudeUsage`, `usd` from `token-usage.js`; `tokens` from `observability-values.js`; `finalizeObservability` (Task 1).
- Produces:
  - `observeClaude(records)` and `ClaudeHistoryMetadata.snapshot().observability` return `totals` (Claude totals or `null`) and `context.compaction`.
  - Claude agent entries gain `toolUseId` (native Agent call id) and, after a notification, `usage: { toolUses, durationMs }`.
  - `subagentEvent(record)` for notifications returns `durationMs` and `toolUses` (safe integers or `null`).
  - `readClaudePage` (fallback path) reports `totals: null` whenever `end > 0`.
  - `ChatStore#lastTotals(session, nativeId, totals) -> Totals | null`; `ChatStore#lastKnownTotals: Map<sessionId, { nativeId, totals }>`.

- [ ] **Step 1: Write the failing observer tests**

Create `tests/unit/claude-token-totals.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { observeClaude } from "../../server/features/chat/claude-observability.js";
import { subagentEvent } from "../../server/features/chat/claude-subagents.js";

const assistant = (id, output, stop, at) => ({
  type: "assistant",
  timestamp: at,
  message: {
    id,
    model: "claude-opus-5-5",
    role: "assistant",
    stop_reason: stop,
    content: [],
    usage: {
      input_tokens: 4,
      cache_creation_input_tokens: 600,
      cache_read_input_tokens: 20000,
      output_tokens: output,
      output_tokens_details: { thinking_tokens: 9 },
      service_tier: "standard",
      iterations: [],
      speed: "standard",
      fallback_credit: null,
      server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
    },
  },
});
const costState = (usd) => ({
  type: "cost-state",
  sessionId: "native",
  totalCostUSD: usd,
  totalAPIDuration: 1,
  totalDuration: 2,
  modelUsage: {},
  hasUnknownModelCost: false,
});
const notificationText =
  "<task-notification>\n<task-id>agentreview01</task-id>\n<tool-use-id>toolu_review</tool-use-id>\n<status>completed</status>\n<summary>Agent finished</summary>\n<usage><subagent_tokens>91234</subagent_tokens><tool_uses>12</tool_uses><duration_ms>92000</duration_ms></usage>\n</task-notification>";

test("Claude totals dedupe per message id, keep output as a lower bound and never report reasoning", () => {
  const result = observeClaude([
    assistant("msg_1", 1, null, "2026-10-01T10:00:00Z"),
    assistant("msg_1", 300, "end_turn", "2026-10-01T10:00:01Z"),
    assistant("msg_2", 2, null, "2026-10-01T10:00:02Z"),
  ]);
  assert.deepEqual(
    [
      result.totals.inputTokens,
      result.totals.cacheWriteTokens,
      result.totals.cacheReadTokens,
      result.totals.outputTokens,
      result.totals.totalTokens,
    ],
    [8, 1200, 40000, 302, 41510],
  );
  assert.equal(result.totals.reasoningTokens, null);
  assert.equal(result.totals.outputIsLowerBound, true);
  assert.equal(result.totals.cost, null);
  assert.equal(observeClaude([]).totals, null);
});

test("Claude cost is shown only while no assistant record follows the latest cost-state", () => {
  const base = [assistant("msg_1", 10, "end_turn", "2026-10-01T10:00:00Z")];
  assert.deepEqual(observeClaude([...base, costState(1.2345)]).totals.cost, {
    usd: 1.2345,
    scope: "cli-exit-incl-subagents",
  });
  assert.equal(
    observeClaude([
      ...base,
      costState(1.2345),
      assistant("msg_2", 3, null, "2026-10-01T11:00:00Z"),
    ]).totals.cost,
    null,
  );
  assert.equal(
    observeClaude([
      ...base,
      costState(1),
      { type: "user", message: { role: "user", content: "resume" } },
      costState(2),
    ]).totals.cost.usd,
    2,
  );
  assert.equal(observeClaude([...base, costState(-1)]).totals.cost, null);
  assert.equal(observeClaude([...base, costState("3")]).totals.cost, null);
  // The history index turns API errors into assistant records; they are no reply.
  assert.equal(
    observeClaude([
      ...base,
      costState(4),
      {
        type: "assistant",
        isApiErrorMessage: true,
        message: { role: "assistant", content: "Overloaded" },
      },
    ]).totals.cost.usd,
    4,
  );
});

test("compaction stores the post-compaction conversation size until the next usage", () => {
  const compact = {
    type: "system",
    subtype: "compact_boundary",
    timestamp: "2026-10-01T10:05:00Z",
    compactMetadata: {
      trigger: "auto",
      preTokens: 900000,
      postTokens: 41200,
      durationMs: 1,
    },
  };
  const first = assistant("msg_1", 10, "end_turn", "2026-10-01T10:00:00Z");
  const compacted = observeClaude([first, compact]).context;
  assert.equal(compacted.usedTokens, null);
  assert.deepEqual(compacted.compaction, {
    conversationTokens: 41200,
    observedAt: "2026-10-01T10:05:00.000Z",
  });
  const resumed = observeClaude([
    first,
    compact,
    assistant("msg_2", 10, null, "2026-10-01T10:06:00Z"),
  ]).context;
  assert.equal(resumed.compaction, null);
  assert.equal(resumed.usedTokens, 20604);
  assert.equal(
    observeClaude([{ ...compact, compactMetadata: {} }]).context.compaction,
    null,
  );
});

test("task notifications give duration and tool uses, never tokens", () => {
  const notification = {
    type: "user",
    origin: { kind: "task-notification", producer: "session-task" },
    message: { role: "user", content: notificationText },
  };
  const event = subagentEvent(notification);
  assert.deepEqual([event.durationMs, event.toolUses], [92000, 12]);
  const agent = observeClaude([
    {
      type: "assistant",
      message: {
        id: "msg_call",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_review",
            name: "Agent",
            input: { description: "Review parser", subagent_type: "general-purpose" },
          },
        ],
      },
    },
    {
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_review", content: "Launched." },
        ],
      },
      toolUseResult: {
        isAsync: true,
        status: "async_launched",
        agentId: "agentreview01",
      },
    },
    notification,
  ]).subagents.find((entry) => entry.id === "agentreview01");
  assert.deepEqual(agent.usage, { toolUses: 12, durationMs: 92000 });
  assert.equal(agent.toolUseId, "toolu_review");
  assert.equal(JSON.stringify(agent).includes("91234"), false);
});
```

- [ ] **Step 2: Write the failing history integration tests**

Create `tests/integration/claude-token-history.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { claudeHistoryFixture } from "../helpers/claude-history.js";
import { ChatStore } from "../../server/features/chat/chat-store.js";

function transcript(f, pairs) {
  const records = [];
  for (let i = 0; i < pairs; i++) {
    records.push(f.user(`u${i}`, `Question ${i}`));
    records.push(
      f.assistant(`a${i}`, [], {
        message: {
          id: `msg_${i}`,
          role: "assistant",
          model: "claude-opus-5-5",
          stop_reason: i % 2 ? "end_turn" : null,
          content: [{ type: "text", text: `Answer ${i}` }],
          usage: {
            input_tokens: 3,
            cache_creation_input_tokens: 50,
            cache_read_input_tokens: 1000,
            output_tokens: 7,
          },
        },
      }),
    );
  }
  return records;
}

test("indexed pages and the full parse report the same whole-history totals", async (t) => {
  const f = await claudeHistoryFixture(t);
  await f.write([
    ...transcript(f, 120),
    { type: "cost-state", totalCostUSD: 2.5, modelUsage: {}, hasUnknownModelCost: false },
    { type: "system", subtype: "api_error", error: { message: "Overloaded" } },
  ]);
  const provisional = await f.history.readPage(f.session, "native");
  assert.equal(provisional.observability.totals, null);
  await f.indexed();
  const indexed = await f.history.readPage(f.session, "native");
  const full = await f.history.read(f.session, "native");
  assert.deepEqual(indexed.observability.totals, full.observability.totals);
  assert.equal(full.observability.totals.inputTokens, 360);
  assert.equal(full.observability.totals.cacheReadTokens, 120000);
  assert.equal(full.observability.totals.outputTokens, 840);
  assert.equal(full.observability.totals.outputIsLowerBound, true);
  assert.deepEqual(full.observability.totals.cost, {
    usd: 2.5,
    scope: "cli-exit-incl-subagents",
  });
});

test("a provisional page that reached the start of a short transcript reports its totals", async (t) => {
  const f = await claudeHistoryFixture(t);
  await f.write(transcript(f, 3));
  const page = await f.history.readPage(f.session, "native");
  assert.equal(page.observability.totals.totalTokens, 3 * 1060);
});

test("Chat keeps the last known totals while a page reports none", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "token-chat-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const session = {
    id: "fixture",
    accountId: "one",
    tool: "claude",
    cwd: dataDir,
    status: "running",
  };
  const totals = {
    inputTokens: 1,
    outputTokens: 2,
    cacheReadTokens: 3,
    cacheWriteTokens: 4,
    reasoningTokens: null,
    totalTokens: 10,
    outputIsLowerBound: true,
    cost: null,
    source: "claude-transcript",
    observedAt: "2026-10-01T10:00:00Z",
  };
  let next = totals;
  const history = {
    readPage: async () => ({
      messages: [],
      tasks: [],
      observability: { context: {}, subagents: [], totals: next },
      next: null,
    }),
  };
  const sessions = { get: async () => session };
  const chat = new ChatStore({ dataDir, sessions, history });
  chat.initialize(session, "native", "automatic");
  assert.equal((await chat.read(session.id)).observability.totals.totalTokens, 10);
  next = null;
  chat.cache.clear();
  assert.equal((await chat.read(session.id)).observability.totals.totalTokens, 10);
  const restarted = new ChatStore({ dataDir, sessions, history });
  assert.equal((await restarted.read(session.id)).observability.totals.totalTokens, 10);
  restarted.initialize(session, "other", "manual");
  assert.equal((await restarted.read(session.id)).observability.totals, null);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test tests/unit/claude-token-totals.test.js tests/integration/claude-token-history.test.js`
Expected: FAIL (`result.totals` is `undefined`, `event.durationMs` is `undefined`, `compaction` missing).

- [ ] **Step 4: Report duration and tool uses from task notifications**

In `server/features/chat/claude-subagents.js`, add below `tag` (line 47):

```js
// Only counts the notification reports itself; <subagent_tokens> is the last
// request's size, not consumption, and is never read.
const count = (source, name) => {
  const value = tag(source, name);
  return /^\d{1,15}$/.test(value) ? Number(value) : null;
};
```

and extend the notification branch of `subagentEvent` (lines 104-111):

```js
if (key?.kind === "notification") {
  const envelope = notificationEnvelope(record);
  return {
    ...key,
    status: notificationStatus(tag(envelope, "status")),
    summary: tag(envelope, "summary").slice(0, 1000),
    durationMs: count(envelope, "duration_ms"),
    toolUses: count(envelope, "tool_uses"),
  };
}
```

- [ ] **Step 5: Add totals, cost, compaction and linking to the Claude observer**

In `server/features/chat/claude-observability.js`:

1. Imports (lines 1-13): add `tokens` to the `observability-values.js` import and add `import { createClaudeUsage, usd } from "./token-usage.js";`.
2. After `let context = emptyContext();` (line 20) add:

```js
const sessionUsage = createClaudeUsage();
// cost-state is written when the CLI exits; any later reply makes it outdated.
let cost = null;
```

3. In `nativeAgent` (lines 42-60) add the call id to the agent values:

```js
agent(agentId, {
  ...values,
  toolUseId: nativeId(callId),
  status:
    values.source === "claude-async-launch"
      ? values.status
      : settleStatus(previous?.status, values.status),
});
```

4. Replace the compact-boundary branch (lines 65-72) with:

```js
if (record.type === "system" && record.subtype === "compact_boundary") {
  const conversationTokens = tokens(record.compactMetadata?.postTokens);
  context = {
    ...context,
    usedTokens: null,
    remainingPercent: null,
    source: null,
    observedAt: at,
    compaction:
      conversationTokens === null ? null : { conversationTokens, observedAt: at },
  };
}
if (record.type === "cost-state") {
  const amount = usd(record.totalCostUSD);
  cost = amount === null ? null : { usd: amount, after: false };
}
if (record.type === "assistant" && !record.isApiErrorMessage && cost) cost.after = true;
```

5. In the assistant usage branch (lines 76-84) record totals next to the context update:

```js
if (Object.hasOwn(usage, "input_tokens")) {
  context = contextValue(
    inputTokens(
      usage.input_tokens,
      usage.cache_creation_input_tokens,
      usage.cache_read_input_tokens,
    ),
    { observedAt: at, modelId: message.model },
  );
  sessionUsage.add(message, at);
}
```

6. In the notification branch (lines 145-154) pass the notification counts:

```js
nativeAgent(event.toolUseId, agentByCall.get(event.toolUseId) || event.taskId, {
  name: text(input.name || input.subagent_type),
  task: text(input.description || input.prompt),
  status: event.status,
  source: "claude-task-notification",
  updatedAt: at,
  ...(event.durationMs !== null || event.toolUses !== null
    ? { usage: { toolUses: event.toolUses, durationMs: event.durationMs } }
    : {}),
});
```

7. Replace `snapshot` (lines 188-192):

```js
const snapshot = () => ({
  context: { ...context },
  totals: sessionUsage.totals(
    cost && !cost.after ? { usd: cost.usd, scope: "cli-exit-incl-subagents" } : null,
  ),
  subagents: [...agents.values()].map((value) => ({ ...value })),
  stale,
});
```

- [ ] **Step 6: Report no totals from a partial provisional page**

In `server/features/chat/claude-history-page.js` replace the returned observability of the provisional path (line 111):

```js
const observed = observeClaude(ordered);
return {
  ...content,
  indexing: history.claudePages?.warming(session, id, reader.identity) || false,
  // Only a page that reached the transcript start saw the whole history.
  observability: {
    ...observed,
    totals: end > 0 ? null : observed.totals,
    stale: end > 0,
  },
  ...split(content.messages, end, reader.identity),
};
```

- [ ] **Step 7: Keep the last known totals in the Chat store**

In `server/features/chat/chat-store.js`:

1. Constructor (after `this.cursorBytes = 0;`): `this.lastKnownTotals = new Map();`
2. `reset(id)` (lines 67-73): add `this.lastKnownTotals.delete(id);` after `this.invalidate(id);`.
3. Add the method below `page(...)`:

```js
  /** A page without whole-history totals keeps the last ones of the same conversation. */
  lastTotals(session, nativeId, totals) {
    if (totals) return totals;
    const remembered = this.lastKnownTotals.get(session.id);
    if (remembered?.nativeId === nativeId) return remembered.totals;
    const stored = readJSON(this.file(session.id, "snapshot"), null);
    return stored?.providerSessionId === nativeId &&
      stored.scope?.accountId === session.accountId &&
      stored.scope?.tool === session.tool
      ? stored.observability?.totals || null
      : null;
  }
```

4. In `snapshot(...)` replace `observability: finalizeObservability(content.observability, session),` with a precomputed value:

```js
const observability = finalizeObservability(
  {
    ...content.observability,
    totals: this.lastTotals(session, nativeId, content.observability?.totals),
  },
  session,
);
if (observability.totals)
  this.lastKnownTotals.set(session.id, { nativeId, totals: observability.totals });
```

and use `observability,` in the `result` object.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `node --test tests/unit/claude-token-totals.test.js tests/integration/claude-token-history.test.js tests/unit/claude-subagents.test.js tests/unit/claude-subagent-lifecycle.test.js tests/unit/observability.test.js tests/integration/claude-history-pages.test.js tests/integration/claude-subagent-history.test.js tests/integration/observability-history.test.js`
Expected: PASS.

- [ ] **Step 9: Format, lint and commit**

```bash
npm run format && npm run lint
git add server/features/chat/claude-subagents.js server/features/chat/claude-observability.js \
  server/features/chat/claude-history-page.js server/features/chat/chat-store.js \
  tests/unit/claude-token-totals.test.js tests/integration/claude-token-history.test.js
git commit -F - <<'EOF'
feat: track Claude session totals, cost and compaction size

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 3: Claude subagent usage cache

**Before starting:** run `git fetch origin && git log --oneline origin/main -5`. If PR #172 has merged and you have not rebased yet, `git rebase origin/main`. Its changes to `claude-history-page.js` add a `whole` metadata branch inside the function body; keep that branch inside `readClaudeContent` (Step 5) unchanged.

**Files:**

- Create: `server/features/chat/claude-subagent-usage.js`
- Modify: `server/features/chat/claude-history-page.js:19-33` (split into `readClaudePage` and `readClaudeContent`)
- Modify: `server/features/chat/provider-history.js:1-5` (imports), `160-175` (constructor), `387-397` (`read`, Claude branch), `493-507` (`close`)
- Test: `tests/integration/claude-subagent-usage.test.js`

**Interfaces:**

- Consumes: `createClaudeUsage`, `usageFromTotals`, `sumUsage` (Task 1); `nativeId`, `list` from `observability-values.js`; agent entries with `status` and `toolUseId` (Task 2); `ProviderHistory#claudeDirectory(session) -> { root, directories }`; `ProviderHistory#onIndexed({ session, id, replaced })` (set by `ChatStore`).
- Produces:
  - `class ClaudeSubagentUsage({ root: (session) => Promise<string>, onUpdated: ({ session, id }) => void, maxSessions = 16 })` with `peek(session, id, transcript, running = []) -> SubagentUsage | null` (synchronous, schedules a background refresh), `close()`, and per-session `entries.get(session.id) -> { pending, reads, result, ... }` (tests read `pending` and `reads`). `root` and `onUpdated` are writable properties.
  - `readAgentUsage(file, previous = null) -> Promise<FileState>` and `runningAgents(observability) -> string[]`.
  - `ProviderHistory#claudeUsage`; first Claude pages and full reads carry `observability.subagentUsage`.

- [ ] **Step 1: Write the failing integration tests**

Create `tests/integration/claude-subagent-usage.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { claudeHistoryFixture } from "../helpers/claude-history.js";
import { launch, notification } from "../helpers/claude-subagents.js";
import { finalizeObservability } from "../../server/features/chat/chat-observability.js";

const usageRecord = (id, output, stop) => ({
  type: "assistant",
  isSidechain: true,
  agentId: "fixture",
  timestamp: "2026-10-01T10:00:00Z",
  message: {
    id,
    role: "assistant",
    model: "claude-opus-5-5",
    stop_reason: stop,
    content: [],
    usage: {
      input_tokens: 2,
      cache_creation_input_tokens: 10,
      cache_read_input_tokens: 100,
      output_tokens: output,
    },
  },
});
const lines = (records) =>
  records.map((record) => JSON.stringify(record) + "\n").join("");

async function setup(t, records) {
  const f = await claudeHistoryFixture(t);
  await f.write([
    f.user("u0", "Review"),
    f.assistant("main-usage", [], {
      message: {
        id: "msg_main",
        role: "assistant",
        model: "claude-opus-5-5",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Started." }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    }),
    ...records,
  ]);
  const directory = path.join(path.dirname(f.file), "native", "subagents");
  await fs.mkdir(directory, { recursive: true });
  const agent = async (agentId, records, meta, folder = directory) => {
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, `agent-${agentId}.jsonl`), lines(records));
    if (meta)
      await fs.writeFile(
        path.join(folder, `agent-${agentId}.meta.json`),
        JSON.stringify({
          agentType: "general-purpose",
          description: "Fixture",
          spawnDepth: 1,
          requestShape: "agent",
          requestNonInteractive: true,
          ...meta,
        }),
      );
  };
  const settle = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    await f.history.claudeUsage.entries.get(f.session.id)?.pending;
  };
  const usage = async () =>
    (await f.history.readPage(f.session, "native")).observability.subagentUsage;
  return { f, directory, agent, settle, usage };
}

test("subagent usage sums files, rolls depth-2 agents into their ancestor and counts workflow agents", async (t) => {
  const { f, directory, agent, settle, usage } = await setup(
    t,
    launch("toolu_review", "agentreview01", "Review parser"),
  );
  await agent(
    "agentreview01",
    [usageRecord("msg_r1", 5, null), usageRecord("msg_r1", 80, "end_turn")],
    { toolUseId: "toolu_review" },
  );
  await agent("agentnested02", [usageRecord("msg_n1", 20, "end_turn")], {
    parentAgentId: "agentreview01",
    spawnDepth: 2,
  });
  await agent(
    "agentwf03",
    [usageRecord("msg_w1", 40, "end_turn")],
    null,
    path.join(directory, "workflows", "wf_fixture"),
  );
  assert.equal(await usage(), null);
  await settle();
  const value = await usage();
  assert.deepEqual(Object.keys(value.agents), ["agentreview01"]);
  assert.equal(value.agents.agentreview01.totalTokens, 192 + 132);
  assert.equal(value.agents.agentreview01.outputIsLowerBound, true);
  assert.deepEqual(value.toolUses, { toolu_review: "agentreview01" });
  assert.deepEqual([value.workflow.count, value.workflow.usage.totalTokens], [1, 152]);
  const page = await f.history.readPage(f.session, "native");
  const final = finalizeObservability(page.observability, f.session);
  assert.equal(
    final.subagents.find((a) => a.id === "agentreview01").usage.totalTokens,
    324,
  );
  assert.equal(
    final.subagents.some((a) => a.id === "agentnested02"),
    false,
  );
  assert.deepEqual(
    [
      final.totals.subagents.count,
      final.totals.subagents.workflowAgents,
      final.totals.subagents.totalTokens,
    ],
    [2, 1, 476],
  );
  assert.equal(final.totals.totalTokens, 2);
});

test("a live file is read in complete lines and re-read once after its agent stops running", async (t) => {
  const { f, agent, directory, settle, usage } = await setup(t, [
    ...launch("toolu_run", "agentrun01", "Run"),
    ...launch("toolu_done", "agentdone02", "Done"),
    notification("toolu_done", "agentdone02", "completed"),
  ]);
  await agent("agentdone02", [usageRecord("msg_d1", 10, "end_turn")], {
    toolUseId: "toolu_done",
  });
  await agent("agentrun01", [usageRecord("msg_a1", 10, "end_turn")], {
    toolUseId: "toolu_run",
  });
  const runFile = path.join(directory, "agent-agentrun01.jsonl");
  const partial = JSON.stringify(usageRecord("msg_a2", 30, "end_turn"));
  await fs.appendFile(runFile, partial.slice(0, 40));
  await usage();
  await settle();
  const entry = f.history.claudeUsage.entries.get(f.session.id);
  assert.equal((await usage()).agents.agentrun01.totalTokens, 122);
  await settle();
  const reads = entry.reads;
  await fs.appendFile(runFile, partial.slice(40) + "\n");
  await fs.appendFile(
    path.join(directory, "agent-agentdone02.jsonl"),
    lines([usageRecord("msg_d2", 10, "end_turn")]),
  );
  await usage();
  await settle();
  assert.equal(entry.reads, reads + 1);
  const value = await usage();
  assert.equal(value.agents.agentrun01.totalTokens, 122 + 142);
  assert.equal(value.agents.agentdone02.totalTokens, 122);
  await settle();
  await fs.appendFile(runFile, lines([usageRecord("msg_a3", 50, "end_turn")]));
  await f.append([notification("toolu_run", "agentrun01", "completed")]);
  await usage();
  await settle();
  assert.equal((await usage()).agents.agentrun01.totalTokens, 122 + 142 + 162);
  await settle();
  const after = entry.reads;
  await usage();
  await settle();
  assert.equal(entry.reads, after);
});

test("the cold scan never delays the live read and announces its result", async (t) => {
  const { f, agent, settle, usage } = await setup(
    t,
    launch("toolu_review", "agentreview01", "Review parser"),
  );
  await agent("agentreview01", [usageRecord("msg_r1", 80, "end_turn")], {
    toolUseId: "toolu_review",
  });
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const root = f.history.claudeUsage.root;
  f.history.claudeUsage.root = (session) => gate.then(() => root(session));
  const updates = [];
  f.history.claudeUsage.onUpdated = (event) => updates.push(event);
  assert.equal(await usage(), null);
  assert.equal(updates.length, 0);
  release();
  await settle();
  assert.deepEqual(
    updates.map((event) => event.id),
    ["native"],
  );
  assert.equal((await usage()).agents.agentreview01.totalTokens, 192);
});

test("a subagent directory outside the profile is ignored without failing the read", async (t) => {
  const { f, settle, usage } = await setup(t, []);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "claude-outside-"));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(outside, "agent-agentx01.jsonl"),
    lines([usageRecord("msg_x", 1, "end_turn")]),
  );
  const directory = path.join(path.dirname(f.file), "native", "subagents");
  await fs.rm(directory, { recursive: true, force: true });
  await fs.symlink(outside, directory);
  await usage();
  await settle();
  assert.equal(await usage(), null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/integration/claude-subagent-usage.test.js`
Expected: FAIL with `TypeError: Cannot read properties of undefined (reading 'entries')` (no `history.claudeUsage`).

- [ ] **Step 3: Create `server/features/chat/claude-subagent-usage.js`**

```js
import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { list, nativeId } from "./observability-values.js";
import { createClaudeUsage, sumUsage, usageFromTotals } from "./token-usage.js";

const BLOCK = 64 * 1024;
const MAX_LINE = 4 * 1024 * 1024;
const MAX_META = 64 * 1024;
const MAX_FILES = 1024;
const MAX_DEPTH = 8;
const AGENT_FILE = /^agent-([A-Za-z0-9][A-Za-z0-9_-]{0,119})\.jsonl$/;
const WORKFLOW_DIR = /^wf_[A-Za-z0-9_-]{1,120}$/;
const USAGE = Buffer.from('"usage"');
const missing = (error) => ["ENOENT", "ENOTDIR"].includes(error?.code);

export const runningAgents = (observability) =>
  list(observability?.subagents)
    .filter((agent) => agent?.status === "running" && nativeId(agent.id))
    .map((agent) => agent.id);

/** Real directory below the profile root, or null when absent or outside it. */
async function inside(directory, root) {
  try {
    const [real, realRoot] = await Promise.all([
      fs.realpath(directory),
      fs.realpath(root),
    ]);
    return real.startsWith(realRoot + path.sep) ? real : null;
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

const regularFile = async (file) => (await fs.lstat(file).catch(() => null))?.isFile();

/**
 * Continues a subagent file from its last complete line. Files are live-appended,
 * so an unfinished last line is read again on the next refresh.
 */
export async function readAgentUsage(file, previous = null) {
  const handle = await fs.open(file, "r");
  try {
    const stat = await handle.stat();
    let state = previous;
    if (!state || state.ino !== stat.ino || stat.size < state.offset)
      state = {
        ino: stat.ino,
        offset: 0,
        size: -1,
        mtimeMs: -1,
        usage: createClaudeUsage(),
      };
    if (state.size === stat.size && state.mtimeMs === stat.mtimeMs) return state;
    let position = state.offset,
      pending = Buffer.alloc(0),
      skipping = false;
    while (position < stat.size) {
      const buffer = Buffer.alloc(Math.min(BLOCK, stat.size - position));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      position += bytesRead;
      pending = Buffer.concat([pending, buffer.subarray(0, bytesRead)]);
      let end;
      while ((end = pending.indexOf(10)) >= 0) {
        const line = pending.subarray(0, end);
        pending = pending.subarray(end + 1);
        if (!skipping && line.includes(USAGE)) {
          try {
            const record = JSON.parse(line.toString("utf8"));
            if (record?.type === "assistant" && record.message?.usage)
              state.usage.add(record.message, record.timestamp);
          } catch {
            /* A malformed line is no usage evidence. */
          }
        }
        skipping = false;
        state.offset = position - pending.length;
      }
      if (pending.length > MAX_LINE) {
        pending = Buffer.alloc(0);
        skipping = true;
      }
      await yieldTurn();
    }
    state.size = stat.size;
    state.mtimeMs = stat.mtimeMs;
    return state;
  } finally {
    await handle.close();
  }
}

/** `{ toolUseId, parentAgentId }`, or null while the meta file does not exist yet. */
async function readMeta(file) {
  let handle;
  try {
    handle = await fs.open(file, "r");
    const buffer = Buffer.alloc(MAX_META);
    const { bytesRead } = await handle.read(buffer, 0, MAX_META, 0);
    if (bytesRead >= MAX_META) return {};
    const meta = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
    return {
      toolUseId: nativeId(meta?.toolUseId),
      parentAgentId: nativeId(meta?.parentAgentId),
    };
  } catch (error) {
    return missing(error) ? null : {};
  } finally {
    await handle?.close();
  }
}

/** Bounded per-session cache of `<session>/subagents` usage, refreshed in the background. */
export class ClaudeSubagentUsage {
  constructor({ root, onUpdated, maxSessions = 16 } = {}) {
    this.root = root;
    this.onUpdated = onUpdated;
    this.maxSessions = maxSessions;
    this.entries = new Map();
  }
  peek(session, id, transcript, running = []) {
    if (this.closed) return null;
    const key = JSON.stringify([session.accountId, session.cwd, id, transcript]);
    let entry = this.entries.get(session.id);
    if (!entry || entry.key !== key)
      entry = {
        key,
        session: { ...session },
        id,
        transcript,
        files: new Map(),
        metas: new Map(),
        names: [],
        directoryMtime: null,
        running: new Set(),
        previous: new Set(),
        result: null,
        digest: null,
        reads: 0,
        pending: null,
      };
    this.entries.delete(session.id);
    this.entries.set(session.id, entry);
    while (this.entries.size > this.maxSessions)
      this.entries.delete(this.entries.keys().next().value);
    entry.running = new Set(running.filter(nativeId));
    if (!entry.pending)
      entry.pending = (async () => {
        await yieldTurn();
        await this.refresh(entry);
      })()
        .catch(() => {})
        .finally(() => {
          entry.pending = null;
        });
    return entry.result;
  }
  async refresh(entry) {
    const root = await this.root(entry.session);
    if (this.closed || this.entries.get(entry.session.id) !== entry) return;
    const directory = await inside(
      path.join(path.dirname(entry.transcript), entry.id, "subagents"),
      root,
    );
    if (!directory) return this.publish(entry, null);
    const stat = await fs.stat(directory);
    if (stat.mtimeMs !== entry.directoryMtime) {
      entry.names = (await fs.readdir(directory))
        .filter((name) => AGENT_FILE.test(name))
        .sort()
        .slice(0, MAX_FILES);
      entry.directoryMtime = stat.mtimeMs;
    }
    const top = (agentId) => {
      let id = agentId;
      for (
        let depth = 0;
        depth < MAX_DEPTH && entry.metas.get(id)?.parentAgentId;
        depth++
      )
        id = entry.metas.get(id).parentAgentId;
      return id;
    };
    // New files are read once; afterwards only files of agents that run now or
    // ran at the previous refresh (their last records) are read again.
    const watched = new Set([...entry.running, ...entry.previous]);
    for (const name of entry.names) {
      const agentId = AGENT_FILE.exec(name)[1];
      const file = path.join(directory, name);
      if (!entry.metas.has(agentId)) {
        const meta = await readMeta(path.join(directory, `agent-${agentId}.meta.json`));
        if (meta) entry.metas.set(agentId, meta);
      }
      const known = entry.files.get(file);
      if (known && !watched.has(agentId) && !watched.has(top(agentId))) continue;
      if (!(await regularFile(file))) continue;
      entry.reads++;
      entry.files.set(
        file,
        await readAgentUsage(file, known).catch((error) => {
          if (missing(error)) return null;
          throw error;
        }),
      );
    }
    const workflowFiles = await this.workflowFiles(directory);
    for (const file of workflowFiles) {
      entry.reads++;
      entry.files.set(
        file,
        await readAgentUsage(file, entry.files.get(file)).catch(
          () => entry.files.get(file) ?? null,
        ),
      );
    }
    entry.previous = new Set(entry.running);
    this.publish(entry, this.summarize(entry, directory, workflowFiles, top));
  }
  async workflowFiles(directory) {
    const workflows = path.join(directory, "workflows");
    const names = await fs.readdir(workflows).catch((error) => {
      if (missing(error)) return [];
      throw error;
    });
    const files = [];
    for (const name of names.filter((value) => WORKFLOW_DIR.test(value)).sort()) {
      const folder = path.join(workflows, name);
      if (!(await fs.lstat(folder).catch(() => null))?.isDirectory()) continue;
      for (const file of (await fs.readdir(folder).catch(() => []))
        .filter((value) => AGENT_FILE.test(value))
        .sort()) {
        if (!(await regularFile(path.join(folder, file)))) continue;
        files.push(path.join(folder, file));
        if (files.length >= MAX_FILES) return files;
      }
    }
    return files;
  }
  summarize(entry, directory, workflowFiles, top) {
    const agents = {},
      toolUses = {},
      current = new Set(workflowFiles);
    let observedAt = null;
    const note = (totals) => {
      if (totals?.observedAt && (!observedAt || totals.observedAt > observedAt))
        observedAt = totals.observedAt;
    };
    for (const name of entry.names) {
      const agentId = AGENT_FILE.exec(name)[1];
      const file = path.join(directory, name);
      current.add(file);
      const meta = entry.metas.get(agentId);
      if (meta?.toolUseId && !meta.parentAgentId) toolUses[meta.toolUseId] = agentId;
      const totals = entry.files.get(file)?.usage.totals();
      note(totals);
      const usage = usageFromTotals(totals);
      if (!usage) continue;
      const owner = top(agentId);
      agents[owner] = Object.hasOwn(agents, owner)
        ? sumUsage([agents[owner], usage])
        : usage;
    }
    const workflow = workflowFiles
      .map((file) => {
        const totals = entry.files.get(file)?.usage.totals();
        note(totals);
        return usageFromTotals(totals);
      })
      .filter(Boolean);
    for (const file of entry.files.keys())
      if (!current.has(file)) entry.files.delete(file);
    return {
      agents,
      toolUses,
      workflow: workflow.length
        ? { count: workflow.length, usage: sumUsage(workflow) }
        : null,
      unavailable: 0,
      observedAt,
    };
  }
  publish(entry, result) {
    const digest = JSON.stringify(result && { ...result, observedAt: null });
    if (digest === entry.digest) return;
    const quiet = entry.digest === null && !result;
    entry.digest = digest;
    entry.result = result;
    if (!quiet)
      void Promise.resolve(
        this.onUpdated?.({ session: entry.session, id: entry.id }),
      ).catch(() => {});
  }
  close() {
    this.closed = true;
    this.entries.clear();
  }
}
```

- [ ] **Step 4: Own the cache in `ProviderHistory`**

In `server/features/chat/provider-history.js`:

1. Add the import: `import { ClaudeSubagentUsage, runningAgents } from "./claude-subagent-usage.js";`
2. In the constructor after `this.claudePages = ...;`:

```js
// A finished background scan re-reads the chat like a finished index does.
this.claudeUsage = new ClaudeSubagentUsage({
  root: async (session) => (await this.claudeDirectory(session)).root,
  onUpdated: (event) => this.onIndexed?.({ ...event, replaced: false }),
});
```

3. Replace the Claude branch of `read` (lines 390-397):

```js
if (session.tool === "claude") {
  const file = await this.claudeFile(session, id);
  const records = await readJsonLines(file);
  if (!records.some((r) => r?.cwd && r.sessionId && !r.isSidechain))
    throw problem(serverMessages.chat.sessionHistoryBeingWritten, 404);
  if (!this.claudeMatches(records, session, id))
    throw problem(serverMessages.chat.sessionHistoryMismatch, 409);
  const observability = observeClaude(records);
  return {
    ...normalizeClaude(records),
    observability: {
      ...observability,
      subagentUsage: this.claudeUsage.peek(
        session,
        id,
        file,
        runningAgents(observability),
      ),
    },
  };
}
```

4. In `close()` add `this.claudeUsage.close();` after `this.closed = true;`.

- [ ] **Step 5: Attach subagent usage to the first Claude page**

In `server/features/chat/claude-history-page.js`, add `import { runningAgents } from "./claude-subagent-usage.js";` and split the function. The new exported wrapper resolves the file (the existing lines 20-26) and delegates:

```js
export async function readClaudePage(history, session, id, state) {
  let file;
  try {
    file = await history.claudeFile(session, id);
  } catch (error) {
    if (state) throw problem(serverMessages.chat.sessionHistoryMismatch, 409);
    throw error;
  }
  const page = await readClaudeContent(history, session, id, state, file);
  if (state || !page.observability || !history.claudeUsage) return page;
  return {
    ...page,
    observability: {
      ...page.observability,
      subagentUsage: history.claudeUsage.peek(
        session,
        id,
        file,
        runningAgents(page.observability),
      ),
    },
  };
}

async function readClaudeContent(history, session, id, state, file) {
  const reader = await JsonlHistoryReader.open(file, state?.identity);
  // ...the existing body from `try { const metadata = await reader.metadata();`
  // through the final `finally { await reader.close(); }` stays unchanged.
}
```

Move the existing body (current lines 27-116) into `readClaudeContent` without other changes.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test tests/integration/claude-subagent-usage.test.js tests/integration/claude-token-history.test.js tests/integration/claude-history-pages.test.js tests/integration/claude-subagent-history.test.js tests/integration/claude-history-index.test.js tests/integration/provider-history.test.js`
Expected: PASS.

- [ ] **Step 7: Format, lint and commit**

```bash
npm run format && npm run lint && npm run check:structure
git add server/features/chat/claude-subagent-usage.js server/features/chat/claude-history-page.js \
  server/features/chat/provider-history.js tests/integration/claude-subagent-usage.test.js
git commit -F - <<'EOF'
feat: read Claude subagent token usage in the background

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 4: Codex rollout metadata, thread totals and limit buckets

**Files:**

- Modify: `server/features/chat/codex-rollout-metadata.js:1-5` (constants), `91-123` (`update`)
- Modify: `server/features/chat/codex-observability.js:1-41, 119-129`
- Test: `tests/unit/codex-token-totals.test.js`, `tests/integration/codex-page-metadata.test.js` (append one test)

**Interfaces:**

- Consumes: `codexTotals` (Task 1), `codexRateLimit` (Task 1).
- Produces:
  - `observeCodex(thread, records)` returns `totals` (source `"codex-thread"` or `"codex-process"`, or `null`) and `limits: { source: "codex-rate-limits", buckets, observedAt } | null` (raw buckets; `finalizeObservability` hides past windows).
  - `CodexRolloutMetadata` projections add records keyed `"thread-usage"` (`type: "token_usage_record"`, `payload: { thread_id, thread_token_usage }`), `"process-usage"` (`event_msg`/`token_count` with `info: { total_token_usage }` only) and `"limits:<limit_id>"` (`event_msg`/`token_count` with `rate_limits` only; at most 16).
  - The context branch of `observeCodex` now requires `info.last_token_usage`, so projected process-usage records never reset the context.

- [ ] **Step 1: Write the failing observer tests**

Create `tests/unit/codex-token-totals.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { observeCodex } from "../../server/features/chat/codex-observability.js";

const usage = (input, cached, output, reasoning) => ({
  input_tokens: input,
  cached_input_tokens: cached,
  cache_write_input_tokens: 0,
  output_tokens: output,
  reasoning_output_tokens: reasoning,
  total_tokens: input + output,
});
const usageRecord = (thread, at, value) => ({
  timestamp: at,
  ordinal: 1,
  type: "token_usage_record",
  payload: {
    thread_id: thread,
    turn_id: "turn1",
    session_id: "session1",
    root_turn_id: "turn1",
    response_id: "resp1",
    usage: value,
    turn_token_usage: value,
    thread_token_usage: value,
  },
});
const tokenCount = (at, total, rateLimits = null) => ({
  timestamp: at,
  ordinal: 2,
  type: "event_msg",
  payload: {
    type: "token_count",
    info: total
      ? {
          total_token_usage: total,
          last_token_usage: total,
          model_context_window: 272000,
        }
      : null,
    rate_limits: rateLimits,
  },
});

test("Codex totals prefer the per-thread record over a reset process total", () => {
  const result = observeCodex({ id: "thread-parent" }, [
    usageRecord("thread-parent", "2026-10-01T10:00:00Z", usage(50000, 40000, 2000, 800)),
    tokenCount("2026-10-01T10:00:01Z", usage(900, 0, 100, 10)),
  ]);
  assert.deepEqual(
    [
      result.totals.inputTokens,
      result.totals.cacheReadTokens,
      result.totals.outputTokens,
      result.totals.reasoningTokens,
      result.totals.totalTokens,
      result.totals.source,
      result.totals.cost,
    ],
    [50000, 40000, 2000, 800, 52000, "codex-thread", null],
  );
  const fallback = observeCodex({ id: "thread-parent" }, [
    tokenCount("2026-10-01T10:00:01Z", usage(900, 0, 100, 10)),
  ]);
  assert.deepEqual(
    [fallback.totals.totalTokens, fallback.totals.source],
    [1000, "codex-process"],
  );
  assert.equal(observeCodex({}, []).totals, null);
});

test("records of another thread and compaction snapshots never replace thread totals", () => {
  const result = observeCodex({ id: "thread-parent" }, [
    usageRecord("thread-parent", "2026-10-01T10:00:00Z", usage(1000, 0, 10, 0)),
    usageRecord("thread-child", "2026-10-01T10:00:01Z", usage(99999, 0, 1, 0)),
    {
      timestamp: "2026-10-01T10:00:02Z",
      type: "compacted",
      payload: {
        message: "",
        latest_token_usage_record: {
          thread_id: "thread-parent",
          thread_token_usage: usage(5, 0, 5, 0),
        },
      },
    },
  ]);
  assert.equal(result.totals.totalTokens, 1010);
  assert.equal(result.totals.observedAt, "2026-10-01T10:00:00.000Z");
});

test("Codex rate limits keep the latest snapshot per limit id", () => {
  const future = Math.floor(Date.now() / 1000) + 7200;
  const result = observeCodex({}, [
    tokenCount("2026-10-01T10:00:00Z", null, {
      limit_id: "codex",
      limit_name: null,
      primary: { used_percent: 10, window_minutes: 10080, resets_at: future },
      secondary: null,
      credits: null,
      plan_type: "pro",
    }),
    tokenCount("2026-10-01T10:00:01Z", null, {
      limit_id: "codex_bengalfox",
      limit_name: "GPT-5.3-Codex-Spark",
      primary: { used_percent: 30, window_minutes: 300, resets_at: future },
      secondary: { used_percent: 5, window_minutes: 10080, resets_at: future },
      credits: null,
    }),
    tokenCount("2026-10-01T10:00:02Z", null, {
      limit_id: "codex",
      primary: { used_percent: 12, window_minutes: 10080, resets_at: future },
      secondary: null,
      credits: null,
      plan_type: "pro",
    }),
  ]);
  assert.deepEqual(
    result.limits.buckets.map((bucket) => [
      bucket.limitId,
      bucket.windows.map((window) => window.usedPercent),
    ]),
    [
      ["codex_bengalfox", [30, 5]],
      ["codex", [12]],
    ],
  );
  assert.equal(result.limits.observedAt, "2026-10-01T10:00:02.000Z");
  assert.equal(result.context.usedTokens, null);
});
```

- [ ] **Step 2: Append the failing metadata integration test**

At the top of `tests/integration/codex-page-metadata.test.js` add (after the `ChatStore` import):

```js
const { observeCodex } = await import(
  new URL("../../server/features/chat/codex-observability.js", import.meta.url)
);
```

and append:

```js
test("rollout metadata projects thread totals, process totals and rate limits incrementally", async (t) => {
  const f = fixture(t, "codex");
  const file = path.join(f.home, ".codex", "sessions", "rollout.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const usage = (input, output) => ({
    input_tokens: input,
    cached_input_tokens: input - 100,
    cache_write_input_tokens: 0,
    output_tokens: output,
    reasoning_output_tokens: 5,
    total_tokens: input + output,
  });
  const record = (input, output) => ({
    timestamp: "2026-10-01T10:00:00Z",
    ordinal: 1,
    type: "token_usage_record",
    payload: {
      thread_id: "native-parent",
      turn_id: "turn1",
      session_id: "native-parent",
      root_turn_id: "turn1",
      response_id: "resp1",
      usage: usage(101, 1),
      turn_token_usage: usage(101, 1),
      thread_token_usage: usage(input, output),
    },
  });
  const count = {
    timestamp: "2026-10-01T10:00:01Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: usage(300, 30),
        last_token_usage: usage(300, 30),
        model_context_window: 272000,
      },
      rate_limits: {
        limit_id: "codex",
        limit_name: null,
        primary: { used_percent: 12.5, window_minutes: 10080, resets_at: 4102444800 },
        secondary: null,
        credits: { has_credits: false, unlimited: false, balance: "0" },
        individual_limit: null,
        spend_control_reached: null,
        plan_type: "pro",
        rate_limit_reached_type: null,
      },
    },
  };
  const line = (r) => JSON.stringify(r) + "\n";
  fs.writeFileSync(
    file,
    line({ type: "session_meta", payload: { id: "native-parent", cwd: f.cwd } }) +
      line(record(5000, 400)) +
      line(count),
  );
  const thread = { id: "native-parent", path: file };
  const read = () => f.history.codexMetadata.read(f.history, f.session, thread);
  const first = observeCodex(thread, await read());
  assert.deepEqual(
    [first.totals.totalTokens, first.totals.source],
    [5400, "codex-thread"],
  );
  assert.equal(first.limits.buckets[0].windows[0].usedPercent, 12.5);
  assert.equal(first.context.usedTokens, 330);
  const entry = [...f.history.codexMetadata.entries.values()][0];
  const offset = entry.offset;
  fs.appendFileSync(file, line(record(9000, 700)));
  const records = await read();
  assert.ok(entry.offset > offset);
  assert.equal(records.filter((r) => r.type === "token_usage_record").length, 1);
  const next = observeCodex(thread, records);
  assert.equal(next.totals.totalTokens, 9700);
  assert.equal(next.context.usedTokens, 330);
  assert.equal(JSON.stringify(records).includes("resp1"), false);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test tests/unit/codex-token-totals.test.js tests/integration/codex-page-metadata.test.js`
Expected: FAIL (`result.totals` is `undefined`).

- [ ] **Step 4: Add totals and limits to `observeCodex`**

In `server/features/chat/codex-observability.js`:

1. Add imports: `import { codexTotals } from "./token-usage.js";` and `import { codexRateLimit } from "./rate-limits.js";`.
2. After `let modelId = null;` add:

```js
let threadUsage = null,
  processUsage = null,
  limitsAt = null;
const limits = new Map();
// A rollout may carry records of other threads; without ids nothing is excluded.
const ownThread = (value) => !value || !thread?.id || value === thread.id;
```

3. Directly before `if (record?.type !== "event_msg") continue;` add:

```js
if (
  record?.type === "token_usage_record" &&
  item.thread_token_usage &&
  ownThread(item.thread_id)
)
  threadUsage = { usage: item.thread_token_usage, at };
```

4. Replace the `token_count` branch (lines 34-41) with:

```js
if (item.type === "token_count" && item.info?.last_token_usage) {
  context = codexContext(item.info.last_token_usage.total_tokens, {
    limitTokens: item.info.model_context_window,
    source: "native-token-count",
    observedAt: at,
    modelId,
  });
}
if (item.type === "token_count" && item.info?.total_token_usage)
  processUsage = { usage: item.info.total_token_usage, at };
if (item.type === "token_count" && item.rate_limits) {
  const bucket = codexRateLimit(item.rate_limits);
  if (bucket) {
    limits.delete(bucket.limitId);
    limits.set(bucket.limitId, bucket);
    limitsAt = at;
  }
}
```

5. Replace the final `return` (line 129):

```js
// Per-thread usage never decreases; the process total restarts on resume.
const totals = threadUsage
  ? codexTotals(threadUsage.usage, "codex-thread", threadUsage.at)
  : processUsage
    ? codexTotals(processUsage.usage, "codex-process", processUsage.at)
    : null;
return {
  context,
  totals,
  limits: limits.size
    ? { source: "codex-rate-limits", buckets: [...limits.values()], observedAt: limitsAt }
    : null,
  subagents: [...agents.values()],
  stale: false,
};
```

- [ ] **Step 5: Project usage and limits in the rollout metadata**

In `server/features/chat/codex-rollout-metadata.js` add below `MAX_RECORD`:

```js
const MAX_LIMITS = 16;
const USAGE_FIELDS = [
  "input_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens",
];
const usage = (value) =>
  value && typeof value === "object"
    ? Object.fromEntries(USAGE_FIELDS.map((field) => [field, value[field]]))
    : undefined;
```

In `update(entry, record)`, insert before `if (JSON.stringify(record).length > 65536) return;` (line 123):

```js
if (record?.type === "token_usage_record" && p?.thread_token_usage)
  entry.records.set("thread-usage", {
    type: "token_usage_record",
    timestamp: record.timestamp,
    payload: { thread_id: p.thread_id, thread_token_usage: usage(p.thread_token_usage) },
  });
if (record?.type === "event_msg" && p?.type === "token_count") {
  if (p.info?.total_token_usage)
    entry.records.set("process-usage", {
      type: "event_msg",
      timestamp: record.timestamp,
      payload: {
        type: "token_count",
        info: { total_token_usage: usage(p.info.total_token_usage) },
      },
    });
  const limits = p.rate_limits;
  if (limits && typeof limits.limit_id === "string" && limits.limit_id) {
    const key = `limits:${limits.limit_id.slice(0, 120)}`;
    entry.records.delete(key);
    entry.records.set(key, {
      type: "event_msg",
      timestamp: record.timestamp,
      payload: {
        type: "token_count",
        rate_limits: {
          limit_id: limits.limit_id,
          limit_name: limits.limit_name,
          plan_type: limits.plan_type,
          primary: limits.primary,
          secondary: limits.secondary,
          credits: limits.credits,
        },
      },
    });
    const keys = [...entry.records.keys()].filter((name) => name.startsWith("limits:"));
    if (keys.length > MAX_LIMITS) entry.records.delete(keys[0]);
  }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test tests/unit/codex-token-totals.test.js tests/integration/codex-page-metadata.test.js tests/unit/observability.test.js tests/property/observability-usage.test.js tests/integration/codex-live-tail.test.js tests/integration/observability-history.test.js`
Expected: PASS.

- [ ] **Step 7: Format, lint and commit**

```bash
npm run format && npm run lint
git add server/features/chat/codex-rollout-metadata.js server/features/chat/codex-observability.js \
  tests/unit/codex-token-totals.test.js tests/integration/codex-page-metadata.test.js
git commit -F - <<'EOF'
feat: track Codex thread totals and rate limit buckets

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 5: Codex child discovery and child usage

**Files:**

- Create: `server/features/chat/readonly-sqlite.js`
- Create: `server/features/chat/codex-child-usage.js`
- Modify: `server/features/chat/opencode-history-page.js:1-13` (imports), `22-65` (`databaseFile`), `94-107` (connection)
- Modify: `server/features/chat/history-page.js:42-60`
- Modify: `server/features/chat/provider-history.js` (import, constructor, Codex branch of `read` at lines 437-452)
- Test: `tests/integration/codex-child-usage.test.js`

**Interfaces:**

- Consumes: `codexTotals`, `usageFromTotals`, `sumUsage` (Task 1); `nativeId`; `ProviderHistory#environment(session)`; `history.home`.
- Produces:
  - `readonly-sqlite.js`: `class DatabaseLocationError extends Error { reason: "unsafe" | "partial-wal" }`; `locateDatabase(root, file) -> Promise<{ file, identity, version, immutable } | null>`; `openDatabase(location) -> DatabaseSync` (read-only, inside `BEGIN`); `unchangedDatabase(root, file, location) -> Promise<boolean>`; `hasColumns(db, table, columns) -> boolean`.
  - `codex-child-usage.js`: `lastTokenUsage(file, threadId = null, { maxBytes = 8 MiB } = {}) -> Promise<Totals | null>`; `class CodexChildUsage({ maxFiles = 512 })` with `read(history, session, threadId) -> Promise<SubagentUsage | null>` and a `reads` counter.
  - `ProviderHistory#codexChildren`; the first Codex page and full Codex reads carry `observability.subagentUsage`.

- [ ] **Step 1: Write the failing integration tests**

Create `tests/integration/codex-child-usage.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  CodexChildUsage,
  lastTokenUsage,
} from "../../server/features/chat/codex-child-usage.js";
import { finalizeObservability } from "../../server/features/chat/chat-observability.js";
import { ProviderHistory } from "../../server/features/chat/provider-history.js";

const usage = (input, output) => ({
  input_tokens: input,
  cached_input_tokens: 0,
  cache_write_input_tokens: 0,
  output_tokens: output,
  reasoning_output_tokens: 0,
  total_tokens: input + output,
});
const record = (thread, input, output) => ({
  timestamp: "2026-10-01T10:00:00Z",
  ordinal: 1,
  type: "token_usage_record",
  payload: {
    thread_id: thread,
    turn_id: "turn1",
    session_id: thread,
    root_turn_id: "turn1",
    response_id: "resp1",
    usage: usage(1, 1),
    turn_token_usage: usage(1, 1),
    thread_token_usage: usage(input, output),
  },
});
const line = (value) => JSON.stringify(value) + "\n";

function fixture(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codex-children-")));
  const outside = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "codex-foreign-")),
  );
  const root = path.join(home, ".codex");
  fs.mkdirSync(path.join(root, "sessions"), { recursive: true });
  const db = new DatabaseSync(path.join(root, "state_5.sqlite"));
  db.exec(`CREATE TABLE threads(id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL);
    CREATE TABLE thread_spawn_edges(parent_thread_id TEXT NOT NULL,
      child_thread_id TEXT NOT NULL PRIMARY KEY, status TEXT NOT NULL);`);
  const rollout = (id, records, directory = path.join(root, "sessions")) => {
    const file = path.join(directory, `rollout-${id}.jsonl`);
    fs.writeFileSync(
      file,
      line({ type: "session_meta", payload: { id } }) + records.map(line).join(""),
    );
    db.prepare("INSERT INTO threads VALUES (?, ?)").run(id, file);
    return file;
  };
  const edge = (parent, child) =>
    db.prepare("INSERT INTO thread_spawn_edges VALUES (?, ?, 'open')").run(parent, child);
  t.after(() => {
    db.close();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  return {
    home,
    root,
    outside,
    db,
    rollout,
    edge,
    history: { home, environment: () => ({ HOME: home }) },
    session: { id: "local", tool: "codex", accountId: "one", cwd: home },
  };
}

test("Codex children come from spawn edges, roll grandchildren up and exclude foreign rollouts", async (t) => {
  const f = fixture(t);
  f.rollout("thread-a", [record("thread-a", 1000, 100), record("thread-a", 2000, 200)]);
  f.rollout("thread-a1", [record("thread-a1", 300, 30)]);
  f.rollout("thread-b", [record("thread-b", 50, 5)]);
  f.rollout("thread-foreign", [record("thread-foreign", 9, 9)], f.outside);
  f.rollout("thread-new", []);
  for (const [parent, child] of [
    ["thread-parent", "thread-a"],
    ["thread-a", "thread-a1"],
    ["thread-parent", "thread-b"],
    ["thread-parent", "thread-foreign"],
    ["thread-parent", "thread-missing"],
    ["thread-parent", "thread-new"],
    ["thread-other", "thread-x"],
  ])
    f.edge(parent, child);
  const children = new CodexChildUsage();
  const value = await children.read(f.history, f.session, "thread-parent");
  assert.deepEqual(Object.keys(value.agents).sort(), ["thread-a", "thread-b"]);
  assert.equal(value.agents["thread-a"].totalTokens, 2200 + 330);
  assert.equal(value.agents["thread-b"].totalTokens, 55);
  assert.equal(value.unavailable, 2);
  const final = finalizeObservability(
    {
      context: {},
      subagents: [{ id: "thread-a", name: "", task: "", status: "completed" }],
      totals: { inputTokens: 1, outputTokens: 1, totalTokens: 2, source: "codex-thread" },
      subagentUsage: value,
    },
    { status: "running", tool: "codex" },
  );
  assert.equal(final.subagents[0].usage.totalTokens, 2530);
  assert.deepEqual(
    [
      final.totals.subagents.count,
      final.totals.subagents.unavailable,
      final.totals.subagents.totalTokens,
    ],
    [2, 2, 2585],
  );
  assert.equal(await children.read(f.history, f.session, "thread-none"), null);
});

test("child usage is read backwards, skips an unfinished append and is cached by size and mtime", async (t) => {
  const f = fixture(t);
  const file = f.rollout("thread-a", [
    record("thread-a", 1000, 100),
    { type: "event_msg", payload: { type: "agent_message", message: "x".repeat(70000) } },
  ]);
  const late = JSON.stringify(record("thread-a", 5000, 500));
  fs.appendFileSync(file, late.slice(0, 60));
  f.edge("thread-parent", "thread-a");
  assert.equal((await lastTokenUsage(file, "thread-a")).totalTokens, 1100);
  const children = new CodexChildUsage();
  await children.read(f.history, f.session, "thread-parent");
  const reads = children.reads;
  await children.read(f.history, f.session, "thread-parent");
  assert.equal(children.reads, reads);
  fs.appendFileSync(file, late.slice(60) + "\n");
  const value = await children.read(f.history, f.session, "thread-parent");
  assert.equal(children.reads, reads + 1);
  assert.equal(value.agents["thread-a"].totalTokens, 5500);
  const quiet = path.join(f.root, "sessions", "quiet.jsonl");
  fs.writeFileSync(
    quiet,
    line(record("thread-q", 1, 1)) +
      line({
        type: "event_msg",
        payload: { type: "agent_message", message: "y".repeat(200000) },
      }),
  );
  assert.equal(await lastTokenUsage(quiet, "thread-q", { maxBytes: 64 * 1024 }), null);
});

test("an inconsistent or unsupported state database is skipped without failing", async (t) => {
  const f = fixture(t);
  f.edge("thread-parent", "thread-a");
  const wal = path.join(f.root, "state_5.sqlite-wal");
  fs.writeFileSync(wal, "");
  assert.equal(
    await new CodexChildUsage().read(f.history, f.session, "thread-parent"),
    null,
  );
  fs.rmSync(wal);
  f.db.exec("DROP TABLE thread_spawn_edges");
  assert.equal(
    await new CodexChildUsage().read(f.history, f.session, "thread-parent"),
    null,
  );
});

test("the first Codex page carries thread totals and child usage", async (t) => {
  const f = fixture(t);
  f.rollout("thread-a", [record("thread-a", 10, 1)]);
  f.edge("native-parent", "thread-a");
  const parent = path.join(f.root, "sessions", "rollout-parent.jsonl");
  fs.writeFileSync(
    parent,
    line({ type: "session_meta", payload: { id: "native-parent", cwd: f.home } }) +
      line({ type: "event_msg", payload: { type: "task_started", turn_id: "turn1" } }) +
      line(record("native-parent", 100, 10)),
  );
  const history = new ProviderHistory({
    home: f.home,
    accounts: { get: () => ({ tool: "codex" }), environment: () => ({ HOME: f.home }) },
  });
  t.after(() => history.close());
  history.codex = () => ({
    request: async (method) =>
      method === "thread/read"
        ? {
            thread: {
              id: "native-parent",
              cwd: f.home,
              path: parent,
              turns: [{ id: "turn1", items: [] }],
            },
          }
        : { data: [{ id: "turn1", items: [] }], nextCursor: null },
  });
  const page = await history.readPage(f.session, "native-parent");
  assert.equal(page.observability.totals.totalTokens, 110);
  assert.equal(page.observability.subagentUsage.agents["thread-a"].totalTokens, 11);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/integration/codex-child-usage.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `codex-child-usage.js`.

- [ ] **Step 3: Create `server/features/chat/readonly-sqlite.js`**

Move the location and connection rules out of `opencode-history-page.js` unchanged in behavior:

```js
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export class DatabaseLocationError extends Error {
  constructor(reason) {
    super(`SQLite database is ${reason}`);
    this.reason = reason; // "unsafe" | "partial-wal"
  }
}

/** A regular database below root with consistent WAL sidecars, or null when absent. */
export async function locateDatabase(root, file) {
  try {
    const [realRoot, realFile, stat] = await Promise.all([
      fs.realpath(root),
      fs.realpath(file),
      fs.lstat(file),
    ]);
    if (
      !realFile.startsWith(realRoot + path.sep) ||
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1
    )
      throw new DatabaseLocationError("unsafe");
    const sidecars = [];
    for (const suffix of ["-wal", "-shm"]) {
      const sidecar = await fs.lstat(file + suffix).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      sidecars.push(Boolean(sidecar));
      if (
        sidecar &&
        (!sidecar.isFile() || sidecar.isSymbolicLink() || sidecar.nlink !== 1)
      )
        throw new DatabaseLocationError("unsafe");
    }
    if (sidecars[0] !== sidecars[1]) throw new DatabaseLocationError("partial-wal");
    return {
      file: realFile,
      identity: `${stat.dev}:${stat.ino}`,
      version: `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`,
      immutable: !sidecars[0],
    };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Read-only connection inside an open transaction. Even READONLY SQLite creates WAL
 * sidecars for a checkpointed database; without sidecars it is opened immutable.
 */
export function openDatabase(location) {
  const { DatabaseSync } = require("node:sqlite");
  const url = pathToFileURL(location.file);
  if (location.immutable) url.search = "?mode=ro&immutable=1";
  const db = new DatabaseSync(location.immutable ? url.href : location.file, {
    readOnly: true,
    allowExtension: false,
  });
  try {
    db.exec(
      "PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=1500; BEGIN",
    );
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

/** An immutable read must have seen the same file it located. */
export async function unchangedDatabase(root, file, location) {
  if (!location.immutable) return true;
  const after = await locateDatabase(root, file).catch(() => null);
  return Boolean(
    after?.immutable &&
    after.identity === location.identity &&
    after.version === location.version,
  );
}

export function hasColumns(db, table, columns) {
  const names = new Set(
    db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => row.name),
  );
  return columns.every((column) => names.has(column));
}
```

- [ ] **Step 4: Use the helper in the OpenCode reader**

In `server/features/chat/opencode-history-page.js`:

1. Add `import { DatabaseLocationError, locateDatabase, openDatabase } from "./readonly-sqlite.js";` and remove the now unused `pathToFileURL` and `createRequire`/`require` lines (keep `fs` only if still used; `fs` becomes unused and is removed too).
2. Replace `databaseFile` (lines 22-65) with:

```js
async function databaseFile(history, session) {
  const env = history.environment(session);
  const root =
    env.XDG_DATA_HOME || path.join(env.HOME || history.home, ".local", "share");
  if (env.OPENCODE_DB === ":memory:") return null;
  const file = path.resolve(root, "opencode", env.OPENCODE_DB || "opencode.db");
  try {
    return await locateDatabase(root, file);
  } catch (error) {
    if (error instanceof DatabaseLocationError)
      throw error.reason === "partial-wal" ? unavailable() : mismatch();
    throw error;
  }
}
```

3. Replace the connection block in `readOpenCodePage` (lines 94-107, from `const { DatabaseSync } = ...` through the `db.exec(...)` call) with:

```js
  let db;
  try {
    db = openDatabase(location);
```

(the following `if (!supported(db))` line stays the first statement inside the `try`).

- [ ] **Step 5: Create `server/features/chat/codex-child-usage.js`**

```js
import fs from "node:fs/promises";
import path from "node:path";
import { nativeId } from "./observability-values.js";
import { codexTotals, sumUsage, usageFromTotals } from "./token-usage.js";
import {
  hasColumns,
  locateDatabase,
  openDatabase,
  unchangedDatabase,
} from "./readonly-sqlite.js";

const BLOCK = 64 * 1024;
const MAX_TAIL = 8 * 1024 * 1024;
const MAX_LINE = 4 * 1024 * 1024;
const MAX_CHILDREN = 512;
const RECORD = Buffer.from('"token_usage_record"');
// Grandchildren roll up into the direct child that spawned them.
const TREE = `WITH RECURSIVE tree(child, top, depth) AS (
    SELECT child_thread_id, child_thread_id, 1 FROM thread_spawn_edges WHERE parent_thread_id=?
    UNION
    SELECT e.child_thread_id, tree.top, tree.depth + 1 FROM thread_spawn_edges e
      JOIN tree ON e.parent_thread_id = tree.child WHERE tree.depth < 4
  )
  SELECT tree.child AS id, tree.top AS top, t.rollout_path AS rollout
  FROM tree LEFT JOIN threads t ON t.id = tree.child LIMIT ${MAX_CHILDREN}`;

function usageLine(line, threadId) {
  if (!line.includes(RECORD)) return null;
  try {
    const record = JSON.parse(line.toString("utf8"));
    const payload = record?.payload;
    if (record?.type !== "token_usage_record" || !payload?.thread_token_usage)
      return null;
    if (payload.thread_id && threadId && payload.thread_id !== threadId) return null;
    return codexTotals(payload.thread_token_usage, "codex-thread", record.timestamp);
  } catch {
    return null;
  }
}

/** The last complete token_usage_record of a rollout, read backwards from its end. */
export async function lastTokenUsage(
  file,
  threadId = null,
  { maxBytes = MAX_TAIL } = {},
) {
  const handle = await fs.open(file, "r");
  try {
    const { size } = await handle.stat();
    let position = size,
      rest = Buffer.alloc(0),
      trailing = true,
      scanned = 0;
    const previous = (buffer, cut) => (cut > 0 ? buffer.lastIndexOf(10, cut - 1) : -1);
    while (position > 0 && scanned < maxBytes) {
      const start = Math.max(0, position - BLOCK);
      const chunk = Buffer.alloc(position - start);
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, start);
      scanned += bytesRead;
      position = start;
      const buffer = Buffer.concat([chunk.subarray(0, bytesRead), rest]);
      let cut = buffer.length;
      for (let index = previous(buffer, cut); index >= 0; index = previous(buffer, cut)) {
        // Bytes after the last newline are an unfinished append.
        if (trailing) trailing = false;
        else {
          const found = usageLine(buffer.subarray(index + 1, cut), threadId);
          if (found) return found;
        }
        cut = index;
      }
      rest = buffer.subarray(0, cut);
      if (rest.length > MAX_LINE) return null;
    }
    return position === 0 && !trailing ? usageLine(rest, threadId) : null;
  } finally {
    await handle.close();
  }
}

/** Child threads from Codex's own state database; usage from their rollouts' tails. */
export class CodexChildUsage {
  constructor({ maxFiles = 512 } = {}) {
    this.files = new Map();
    this.maxFiles = maxFiles;
    this.reads = 0;
  }
  async read(history, session, threadId) {
    const env = history.environment(session);
    const root = env.CODEX_HOME || path.join(env.HOME || history.home, ".codex");
    const file = path.join(root, "state_5.sqlite");
    let location, rows, db;
    try {
      location = await locateDatabase(root, file);
      if (!location) return null;
      db = openDatabase(location);
      if (
        !hasColumns(db, "thread_spawn_edges", ["parent_thread_id", "child_thread_id"]) ||
        !hasColumns(db, "threads", ["id", "rollout_path"])
      )
        return null;
      rows = db.prepare(TREE).all(threadId);
    } catch {
      return null;
    } finally {
      db?.close();
    }
    if (!rows.length || !(await unchangedDatabase(root, file, location))) return null;
    const realRoot = await fs.realpath(root).catch(() => null);
    const agents = {};
    let unavailable = 0,
      observedAt = null;
    for (const row of rows) {
      const id = nativeId(row.id),
        top = nativeId(row.top);
      if (!id || !top) continue;
      const totals = await this.child(row.rollout, id, realRoot);
      if (totals === undefined) {
        unavailable++;
        continue;
      }
      const usage = usageFromTotals(totals);
      if (!usage) continue;
      if (totals.observedAt && (!observedAt || totals.observedAt > observedAt))
        observedAt = totals.observedAt;
      agents[top] = Object.hasOwn(agents, top) ? sumUsage([agents[top], usage]) : usage;
    }
    return { agents, toolUses: {}, workflow: null, unavailable, observedAt };
  }
  /** Totals of one child; undefined when its rollout is missing or outside the profile. */
  async child(rollout, id, realRoot) {
    if (typeof rollout !== "string" || !rollout || !realRoot) return undefined;
    let real, stat;
    try {
      real = await fs.realpath(rollout);
      if (!real.startsWith(realRoot + path.sep)) return undefined;
      stat = await fs.stat(real);
    } catch {
      return undefined;
    }
    const cached = this.files.get(real);
    if (cached?.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
      this.files.delete(real);
      this.files.set(real, cached);
      return cached.totals;
    }
    this.reads++;
    const totals = await lastTokenUsage(real, id).catch(() => null);
    this.files.delete(real);
    this.files.set(real, { size: stat.size, mtimeMs: stat.mtimeMs, totals });
    while (this.files.size > this.maxFiles)
      this.files.delete(this.files.keys().next().value);
    return totals;
  }
}
```

- [ ] **Step 6: Attach child usage to Codex reads**

1. `server/features/chat/provider-history.js`: add `import { CodexChildUsage } from "./codex-child-usage.js";`, and in the constructor after `this.codexMetadata = new CodexRolloutMetadata();` add `this.codexChildren = new CodexChildUsage();`. At the end of the Codex branch of `read` (before `return result;`, line 452) add:

```js
try {
  const children = await this.codexChildren.read(this, session, id);
  if (children)
    result.observability = { ...result.observability, subagentUsage: children };
} catch {
  /* Child usage is supplemental. */
}
```

2. `server/features/chat/history-page.js`: after the `codexMetadata` block (line 52) add:

```js
let children = null;
if (!state && history.codexChildren) {
  try {
    children = await history.codexChildren.read(history, session, id);
  } catch {
    /* Child usage is supplemental. */
  }
}
```

and replace the `observability` object (lines 55-58) with:

```js
    observability: {
      ...observeCodex(full, records),
      ...(children ? { subagentUsage: children } : {}),
      ...(full.tailUnavailable ? { stale: true } : {}),
    },
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node --test tests/integration/codex-child-usage.test.js tests/integration/codex-page-metadata.test.js tests/integration/opencode-history-pages.test.js tests/integration/observability-history.test.js tests/integration/provider-history.test.js`
Expected: PASS.

- [ ] **Step 8: Format, lint and commit**

```bash
npm run format && npm run lint
git add server/features/chat/readonly-sqlite.js server/features/chat/codex-child-usage.js \
  server/features/chat/opencode-history-page.js server/features/chat/history-page.js \
  server/features/chat/provider-history.js tests/integration/codex-child-usage.test.js
git commit -F - <<'EOF'
feat: add Codex child thread usage from the state database

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 6: OpenCode session row totals and child sessions

**Files:**

- Modify: `server/features/chat/opencode-history-page.js` (imports; `readOpenCodePage` after the `page(...)` call at line 146; new `sessionUsage` helper)
- Test: `tests/integration/opencode-token-totals.test.js`

**Interfaces:**

- Consumes: `openCodeTotals`, `usageFromTotals` (Task 1); `hasColumns` (Task 5); `nativeId`.
- Produces: the first OpenCode page (`state === null`) carries `observability.totals` (source `"opencode-session"`, cost scope `"session"`) and `observability.subagentUsage` (child sessions keyed by session id) or `null` for both when the schema lacks the columns. Older pages carry neither.

- [ ] **Step 1: Write the failing integration tests**

Create `tests/integration/opencode-token-totals.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readOpenCodePage } from "../../server/features/chat/opencode-history-page.js";
import { finalizeObservability } from "../../server/features/chat/chat-observability.js";

function fixture(t, { tokenColumns = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-tokens-"));
  const root = path.join(home, "data");
  fs.mkdirSync(path.join(root, "opencode"), { recursive: true });
  const db = new DatabaseSync(path.join(root, "opencode", "opencode.db"));
  const totals = tokenColumns
    ? ", parent_id TEXT, time_updated INTEGER, cost REAL, tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER"
    : "";
  db.exec(`
    CREATE TABLE session(id TEXT PRIMARY KEY, directory TEXT, time_created INTEGER, revert TEXT${totals});
    CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
    CREATE TABLE part(id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT, data TEXT);
    CREATE TABLE todo(session_id TEXT, content TEXT, status TEXT, priority TEXT, position INTEGER);
  `);
  const session = (id, values = {}) => {
    const columns = ["id", "directory", "time_created", "revert", ...Object.keys(values)];
    db.prepare(
      `INSERT INTO session(${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
    ).run(id, home, 1, null, ...Object.values(values));
  };
  const message = (index, parts) => {
    const id = `msg_${String(index).padStart(6, "0")}`;
    db.prepare("INSERT INTO message VALUES (?, ?, ?, ?)").run(
      id,
      "ses_parent",
      index,
      JSON.stringify({
        role: "assistant",
        time: { created: index, completed: index + 1 },
        modelID: "gpt-5",
        tokens: { input: 42, cache: { read: 3, write: 0 } },
      }),
    );
    parts.forEach((part, n) =>
      db
        .prepare("INSERT INTO part VALUES (?, ?, ?, ?)")
        .run(
          `${id}_p${String(n).padStart(6, "0")}`,
          "ses_parent",
          id,
          JSON.stringify(part),
        ),
    );
  };
  t.after(() => {
    db.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  return {
    session,
    message,
    local: { id: "local", tool: "opencode", accountId: "one", cwd: home },
    history: {
      home,
      environment: () => ({ HOME: home, XDG_DATA_HOME: root }),
      read: () => {
        throw Error("must not export");
      },
    },
  };
}
const row = (cost, input, output, reasoning, read, write, extra = {}) => ({
  cost,
  tokens_input: input,
  tokens_output: output,
  tokens_reasoning: reasoning,
  tokens_cache_read: read,
  tokens_cache_write: write,
  ...extra,
});

test("OpenCode totals and cost come from the session row and children from child rows", async (t) => {
  const f = fixture(t);
  f.session(
    "ses_parent",
    row(0.75, 1000, 200, 50, 4000, 100, { time_updated: 1759312800000 }),
  );
  f.session("ses_child_a", row(0.25, 100, 20, 5, 400, 10, { parent_id: "ses_parent" }));
  f.session("ses_child_b", row(0.05, 10, 2, 0, 40, 1, { parent_id: "ses_parent" }));
  f.session("ses_other", row(9, 9, 9, 9, 9, 9, { parent_id: "ses_unrelated" }));
  f.message(1, [
    {
      type: "tool",
      tool: "task",
      state: {
        status: "completed",
        input: { subagent_type: "explore", description: "Scan the parser" },
        metadata: { sessionId: "ses_child_a" },
        time: { start: 1, end: 2 },
      },
    },
  ]);
  const page = await readOpenCodePage(f.history, f.local, "ses_parent");
  const totals = page.observability.totals;
  assert.deepEqual(
    [totals.totalTokens, totals.reasoningTokens, totals.source, totals.observedAt],
    [5350, 50, "opencode-session", "2025-10-01T10:00:00.000Z"],
  );
  assert.deepEqual(totals.cost, { usd: 0.75, scope: "session" });
  assert.deepEqual(Object.keys(page.observability.subagentUsage.agents), [
    "ses_child_a",
    "ses_child_b",
  ]);
  const final = finalizeObservability(page.observability, {
    status: "running",
    tool: "opencode",
  });
  const child = final.subagents.find((agent) => agent.id === "ses_child_a");
  assert.deepEqual([child.usage.totalTokens, child.usage.costUsd], [535, 0.25]);
  assert.deepEqual(
    [final.totals.subagents.count, final.totals.subagents.totalTokens],
    [2, 535 + 53],
  );
  assert.ok(Math.abs(final.totals.subagents.costUsd - 0.3) < 1e-9);
  assert.equal(final.totals.totalTokens, 5350);
});

test("only the first page attaches session totals", async (t) => {
  const f = fixture(t);
  f.session("ses_parent", row(0.1, 1, 1, 0, 0, 0));
  for (let i = 0; i < 60; i++) f.message(i, [{ type: "text", text: `${i}` }]);
  const first = await readOpenCodePage(f.history, f.local, "ses_parent");
  assert.equal(first.observability.totals.totalTokens, 2);
  assert.ok(first.next);
  const older = await readOpenCodePage(f.history, f.local, "ses_parent", first.next);
  assert.equal(older.observability.totals, undefined);
  assert.equal(older.observability.subagentUsage, undefined);
});

test("databases without token columns keep paging and report no totals", async (t) => {
  const f = fixture(t, { tokenColumns: false });
  f.session("ses_parent");
  f.message(1, [{ type: "text", text: "Hello" }]);
  const page = await readOpenCodePage(f.history, f.local, "ses_parent");
  assert.ok(page.messages.length > 0);
  assert.equal(page.observability.totals, null);
  assert.equal(page.observability.subagentUsage, null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/integration/opencode-token-totals.test.js`
Expected: FAIL (`page.observability.totals` is `undefined`).

- [ ] **Step 3: Read the session rows**

In `server/features/chat/opencode-history-page.js` add imports:

```js
import { openCodeTotals, usageFromTotals } from "./token-usage.js";
import { nativeId } from "./observability-values.js";
```

and extend the `readonly-sqlite.js` import with `hasColumns`. Add below `validateBoundary`:

```js
const TOTAL_COLUMNS = [
  "cost",
  "tokens_input",
  "tokens_output",
  "tokens_reasoning",
  "tokens_cache_read",
  "tokens_cache_write",
];
const MAX_CHILDREN = 512;

/** OpenCode maintains these columns per session, so they cover the whole history. */
function sessionUsage(db, id) {
  if (!hasColumns(db, "session", TOTAL_COLUMNS))
    return { totals: null, subagentUsage: null };
  const updated = hasColumns(db, "session", ["time_updated"]) ? ",time_updated" : "";
  const columns = `id,${TOTAL_COLUMNS.join(",")}${updated}`;
  const row = db.prepare(`SELECT ${columns} FROM session WHERE id=?`).get(id);
  const totals = row ? openCodeTotals(row, row.time_updated ?? null) : null;
  if (!hasColumns(db, "session", ["parent_id"])) return { totals, subagentUsage: null };
  const agents = {};
  let count = 0;
  for (const child of db
    .prepare(
      `SELECT ${columns} FROM session WHERE parent_id=? ORDER BY time_created,id LIMIT ?`,
    )
    .iterate(id, MAX_CHILDREN)) {
    count++;
    const usage = usageFromTotals(openCodeTotals(child, child.time_updated ?? null));
    if (nativeId(child.id) && usage) agents[child.id] = usage;
  }
  return {
    totals,
    subagentUsage: count
      ? { agents, toolUses: {}, workflow: null, unavailable: 0, observedAt: null }
      : null,
  };
}
```

In `readOpenCodePage` directly after `const result = page(db, id, scope, cursor?.before || cutoff);` (line 146) add:

```js
if (!state) Object.assign(result.observability, sessionUsage(db, id));
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/integration/opencode-token-totals.test.js tests/integration/opencode-history-pages.test.js tests/integration/observability-history.test.js`
Expected: PASS.

- [ ] **Step 5: Format, lint and commit**

```bash
npm run format && npm run lint
git add server/features/chat/opencode-history-page.js tests/integration/opencode-token-totals.test.js
git commit -F - <<'EOF'
feat: read OpenCode session totals and child usage

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 7: Context bar, totals, limits and subagent usage in the chat UI

**Before starting:** run `git fetch origin && git log --oneline origin/main -5`. If PR #172 has merged and you have not rebased yet, `git rebase origin/main`. #172 rewrites `SubagentList.jsx` (presence and fade-out), `subagent-presentation.js`, `ChatView.jsx`, `observability.css` and the subagent browser fixtures (`subagentFixture` may install a clock). Add the usage line to whatever entry markup `SubagentList.jsx` renders after the rebase, keep #172's CSS rules, and if `subagentFixture` gains options, call it with defaults. This task does not edit `subagent-presentation.js` or `ChatView.jsx`.

**Files:**

- Create: `web/features/chat/token-presentation.js`
- Create: `web/features/chat/ContextBudget.jsx`
- Create: `web/features/chat/TokenDetails.jsx`
- Modify: `web/features/chat/ChatObservability.jsx:1-83`
- Modify: `web/features/chat/ChatMessage.jsx:13, 26-29, 44-52`
- Modify: `web/features/chat/SubagentList.jsx:14-27`
- Modify: `web/features/chat/observability.css` (append), `web/features/chat/mobile-chat.css:52-58`
- Modify: `web/lib/i18n/en/chat-observability.js`, `web/lib/i18n/de/chat-observability.js`
- Test: `tests/unit/token-presentation.test.js`, `tests/browser/chat-tokens.spec.js`

**Interfaces:**

- Consumes: the finalized `observability` shape from Task 1 (`context.compaction`, `context.limitSource === "assumed-model"`, `totals`, `totals.subagents`, `limits`, `subagents[].usage`, `subagents[].toolUseId`); `formatNumber`, `formatTimestamp` from `web/lib/i18n/index.js`; `relativeTime(iso)` exported by `web/features/projects/ProjectOverview.jsx`.
- Produces: `token-presentation.js` exports `tokenCount`, `formatTokens(value) -> string | null`, `formatUsd(value) -> string | null`, `formatDuration(ms) -> string | null`, `windowLabel(minutes) -> string`, `lowerBoundShown(usage) -> boolean`, `usageSummary(usage) -> string | null`, `usedPercent(context) -> number | null`, `observedAgent(message, observed) -> agent | null`. CSS classes `.chat-context-chip`, `.chat-context-bar`, `.chat-token-details`, `.chat-token-totals`, `.chat-token-cost`, `.chat-token-subagents`, `.chat-limit-bucket`, `.chat-limit-window`, `.subagent-usage`.

- [ ] **Step 1: Write the failing presentation unit test**

Create `tests/unit/token-presentation.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { setLanguage } from "../../web/lib/i18n/index.js";
import {
  formatTokens,
  formatUsd,
  formatDuration,
  windowLabel,
  usageSummary,
  lowerBoundShown,
  usedPercent,
  observedAgent,
} from "../../web/features/chat/token-presentation.js";

const nbsp = " ";

test("token, cost, duration and window formats follow the language", (t) => {
  t.after(() => setLanguage("de", { persist: false }));
  setLanguage("en", { persist: false });
  assert.equal(formatTokens(12400), "12.4K");
  assert.equal(formatTokens(1200000), "1.2M");
  assert.equal(formatTokens(null), null);
  assert.equal(formatTokens(-1), null);
  assert.equal(formatUsd(1.25), "$1.25");
  assert.equal(formatUsd(0.0042), "$0.0042");
  assert.equal(formatUsd(0), "$0.00");
  assert.equal(formatUsd(-1), null);
  assert.equal(formatDuration(92000), "1m 32s");
  assert.equal(formatDuration(4000), "4s");
  assert.equal(formatDuration(3720000), "1h 2m");
  assert.equal(windowLabel(300), "5 h");
  assert.equal(windowLabel(10080), "7 days");
  assert.equal(windowLabel(1440), "1 day");
  assert.equal(windowLabel(45), "45 min");
  setLanguage("de", { persist: false });
  assert.equal(formatTokens(12400), "12.400");
  assert.equal(formatTokens(1200000), `1,2${nbsp}Mio.`);
  assert.equal(formatUsd(12.5), `12,50${nbsp}$`);
  assert.equal(formatDuration(92000), "1 min 32 s");
  assert.equal(windowLabel(10080), "7 Tage");
});

test("usage summaries show a lower bound only when output dominates", (t) => {
  t.after(() => setLanguage("de", { persist: false }));
  setLanguage("en", { persist: false });
  assert.equal(
    usageSummary({
      totalTokens: 12400,
      outputTokens: 400,
      outputIsLowerBound: true,
      durationMs: 92000,
    }),
    "12.4K tokens · 1m 32s",
  );
  assert.equal(
    usageSummary({ totalTokens: 1000, outputTokens: 600, outputIsLowerBound: true }),
    "≥1K tokens",
  );
  assert.equal(usageSummary({ totalTokens: null, durationMs: 5000 }), "5s");
  assert.equal(usageSummary(null), null);
  assert.equal(
    lowerBoundShown({ totalTokens: 1000, outputTokens: 600, outputIsLowerBound: false }),
    false,
  );
  assert.equal(usedPercent({ remainingPercent: 41 }), 59);
  assert.equal(usedPercent({ remainingPercent: null }), null);
  const agents = [
    { id: "agentreview01", usage: { totalTokens: 1 } },
    { id: "agentx", toolUseId: "toolu_x" },
  ];
  assert.equal(
    observedAgent({ id: "toolu_review", subagent: { agentId: "agentreview01" } }, agents)
      .id,
    "agentreview01",
  );
  assert.equal(observedAgent({ id: "toolu_x", subagent: {} }, agents).id, "agentx");
  assert.equal(observedAgent({ id: "toolu_none", subagent: {} }, agents), null);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/unit/token-presentation.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `token-presentation.js`.

- [ ] **Step 3: Add the copy in both languages**

Append to the object in `web/lib/i18n/en/chat-observability.js` (before the closing `};`):

```js
  contextUsed: "Context used",
  assumedLimit: "Assumed window (model)",
  usedOfWindow: (used, limit) => `${used} / ${limit}`,
  remainingShort: (value) => `${value}% left`,
  compaction: (value) => `Conversation after compaction (excl. system/tools): ${value}`,
  usage: "Token usage",
  totals: "Session totals",
  processTotals: "This process",
  input: "Input",
  inputInclCache: "Input (incl. cached)",
  output: "Output",
  cacheRead: "Cache read",
  cacheWrite: "Cache write",
  reasoning: "Reasoning",
  total: "Total",
  cost: "Cost",
  costCliExit: "Cost as of last CLI exit (incl. subagents)",
  subagentUsage: (count, tokens) => `Subagents: ${count} · ${tokens} tokens`,
  subagentUsageCount: (count) => `Subagents: ${count}`,
  workflowAgents: "incl. workflow agents",
  unavailableAgents: (count) => `${count} unavailable`,
  limits: "Rate limits",
  limitWindow: "Window",
  windowMinutes: (count) => `${count} min`,
  windowHours: (count) => `${count} h`,
  windowDays: (count) => (count === 1 ? "1 day" : `${count} days`),
  limitUsed: (value) => `${value}% used`,
  resets: (relative) => `resets ${relative}`,
  credits: (balance) => `Credits: ${balance}`,
  creditsUnlimited: "Credits: unlimited",
  tokens: (value) => `${value} tokens`,
  durationSeconds: (seconds) => `${seconds}s`,
  durationMinutes: (minutes, seconds) => `${minutes}m ${seconds}s`,
  durationHours: (hours, minutes) => `${hours}h ${minutes}m`,
```

Append to `web/lib/i18n/de/chat-observability.js`:

```js
  contextUsed: "Kontext genutzt",
  assumedLimit: "Angenommenes Fenster (Modell)",
  usedOfWindow: (used, limit) => `${used} / ${limit}`,
  remainingShort: (value) => `${value} % frei`,
  compaction: (value) => `Unterhaltung nach Komprimierung (ohne System/Tools): ${value}`,
  usage: "Tokenverbrauch",
  totals: "Sitzungssummen",
  processTotals: "Dieser Prozess",
  input: "Eingabe",
  inputInclCache: "Eingabe (inkl. Cache)",
  output: "Ausgabe",
  cacheRead: "Cache gelesen",
  cacheWrite: "Cache geschrieben",
  reasoning: "Reasoning",
  total: "Gesamt",
  cost: "Kosten",
  costCliExit: "Kosten bei letztem CLI-Ende (inkl. Unteragenten)",
  subagentUsage: (count, tokens) => `Unteragenten: ${count} · ${tokens} Tokens`,
  subagentUsageCount: (count) => `Unteragenten: ${count}`,
  workflowAgents: "inkl. Workflow-Agenten",
  unavailableAgents: (count) => `${count} nicht verfügbar`,
  limits: "Ratenlimits",
  limitWindow: "Zeitfenster",
  windowMinutes: (count) => `${count} min`,
  windowHours: (count) => `${count} h`,
  windowDays: (count) => (count === 1 ? "1 Tag" : `${count} Tage`),
  limitUsed: (value) => `${value} % genutzt`,
  resets: (relative) => `Zurücksetzung ${relative}`,
  credits: (balance) => `Guthaben: ${balance}`,
  creditsUnlimited: "Guthaben: unbegrenzt",
  tokens: (value) => `${value} Tokens`,
  durationSeconds: (seconds) => `${seconds} s`,
  durationMinutes: (minutes, seconds) => `${minutes} min ${seconds} s`,
  durationHours: (hours, minutes) => `${hours} h ${minutes} min`,
```

- [ ] **Step 4: Create `web/features/chat/token-presentation.js`**

```js
import { chatObservabilityCopy as copy } from "../../lib/i18n/messages/chat-observability.js";
import { formatNumber } from "../../lib/i18n/index.js";

export const tokenCount = (value) =>
  Number.isSafeInteger(value) && value >= 0 ? value : null;

export const formatTokens = (value) =>
  tokenCount(value) === null
    ? null
    : formatNumber(value, { notation: "compact", maximumFractionDigits: 1 });

export function formatUsd(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  const digits = value > 0 && value < 0.01 ? 4 : 2;
  return formatNumber(value, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function formatDuration(ms) {
  if (tokenCount(ms) === null) return null;
  const seconds = Math.round(ms / 1000);
  const hours = Math.floor(seconds / 3600),
    minutes = Math.floor((seconds % 3600) / 60),
    rest = seconds % 60;
  if (hours) return copy.durationHours(hours, minutes);
  if (minutes) return copy.durationMinutes(minutes, rest);
  return copy.durationSeconds(rest);
}

export function windowLabel(minutes) {
  if (!(tokenCount(minutes) > 0)) return copy.limitWindow;
  if (minutes % 1440 === 0) return copy.windowDays(minutes / 1440);
  if (minutes % 60 === 0) return copy.windowHours(minutes / 60);
  return copy.windowMinutes(minutes);
}

/** "≥" only when an output lower bound makes up at least half of the shown total. */
export function lowerBoundShown(usage) {
  const output = tokenCount(usage?.outputTokens),
    total = tokenCount(usage?.totalTokens);
  return Boolean(
    usage?.outputIsLowerBound && output !== null && total && output * 2 >= total,
  );
}

/** "12.4K tokens · 1m 32s"; null when neither tokens nor a duration are known. */
export function usageSummary(usage) {
  const total = formatTokens(usage?.totalTokens);
  const duration = formatDuration(usage?.durationMs);
  const parts = [];
  if (total !== null)
    parts.push(copy.tokens(`${lowerBoundShown(usage) ? "≥" : ""}${total}`));
  if (duration) parts.push(duration);
  return parts.length ? parts.join(" · ") : null;
}

/** Bar fill; follows the reported remaining percentage (Codex keeps its baseline). */
export const usedPercent = (context) =>
  typeof context?.remainingPercent === "number" &&
  Number.isFinite(context.remainingPercent)
    ? Math.round((100 - context.remainingPercent) * 10) / 10
    : null;

/** The observed agent of a subagent row, by agent id or by its Agent call id. */
export function observedAgent(message, observed = []) {
  const agentId = message?.subagent?.agentId;
  return (
    (observed || []).find(
      (agent) =>
        (agentId && agent.id === agentId) ||
        (agent.toolUseId && agent.toolUseId === message?.id),
    ) || null
  );
}
```

- [ ] **Step 5: Run the unit and catalog tests**

Run: `node --test tests/unit/token-presentation.test.js tests/unit/i18n-catalogs.test.js tests/unit/i18n.test.js`
Expected: PASS.

- [ ] **Step 6: Write the failing browser tests**

Create `tests/browser/chat-tokens.spec.js`:

```js
import { test, expect } from "@playwright/test";
import { subagentFixture } from "./subagent-fixture.js";
import { mockChatStream } from "../helpers/chat-stream-fixture.js";
import { baseURL } from "../helpers/browser.js";

const copy = {
  "de-DE": {
    context: "Kontextbudget",
    assumed: "Angenommenes Fenster (Modell)",
    outputLabel: "Ausgabe",
    output: "≥12.400",
    cost: /^Kosten bei letztem CLI-Ende \(inkl\. Unteragenten\): 1,25\s\$$/,
    subagents: /^Unteragenten: 2 · 1,2\sMio\. Tokens · inkl\. Workflow-Agenten$/,
    row: "12.400 Tokens · 1 min 32 s",
    compaction: "Unterhaltung nach Komprimierung (ohne System/Tools): 41.200",
    stale: "Gespeicherter Stand",
    chip: /^41\s%\sfrei$/,
    showContext: "Kontextdetails anzeigen",
    show: "Unteragenten anzeigen",
    inputCodex: "Eingabe (inkl. Cache)",
    used: /42\s%\sgenutzt/,
    week: "7 Tage",
  },
  "en-GB": {
    context: "Context budget",
    assumed: "Assumed window (model)",
    outputLabel: "Output",
    output: "≥12.4K",
    cost: /^Cost as of last CLI exit \(incl\. subagents\): \$1\.25$/,
    subagents: /^Subagents: 2 · 1\.2M tokens · incl\. workflow agents$/,
    row: "12.4K tokens · 1m 32s",
    compaction: "Conversation after compaction (excl. system/tools): 41.2K",
    stale: "Saved state",
    chip: /^41% left$/,
    showContext: "Show context details",
    show: "Show subagents",
    inputCodex: "Input (incl. cached)",
    used: /42% used/,
    week: "7 days",
  },
};

const claudeObservability = (data) => ({
  ...data.observability,
  context: {
    usedTokens: 590000,
    limitTokens: 1000000,
    remainingPercent: 41,
    source: "last-api-request",
    limitSource: "assumed-model",
    observedAt: "2026-10-01T10:00:00Z",
    modelId: "claude-opus-5-5",
    compaction: null,
  },
  totals: {
    inputTokens: 3200,
    outputTokens: 12400,
    cacheReadTokens: 1180000,
    cacheWriteTokens: 64000,
    reasoningTokens: null,
    totalTokens: 1259600,
    outputIsLowerBound: true,
    cost: { usd: 1.25, scope: "cli-exit-incl-subagents" },
    source: "claude-transcript",
    observedAt: "2026-10-01T10:00:00Z",
    subagents: {
      count: 2,
      inputTokens: 1000,
      outputTokens: 30000,
      cacheReadTokens: 1100000,
      cacheWriteTokens: 69000,
      reasoningTokens: null,
      totalTokens: 1200000,
      outputIsLowerBound: true,
      costUsd: null,
      workflowAgents: 1,
      unavailable: 0,
    },
  },
  limits: null,
  subagents: data.observability.subagents.map((agent) =>
    agent.id === "agentreview01"
      ? {
          ...agent,
          usage: {
            inputTokens: 20,
            outputTokens: 900,
            cacheReadTokens: 11000,
            cacheWriteTokens: 480,
            reasoningTokens: null,
            totalTokens: 12400,
            outputIsLowerBound: true,
            toolUses: 12,
            durationMs: 92000,
            costUsd: null,
          },
        }
      : agent,
  ),
});

async function codexFixture(page, observability) {
  const session = {
    id: "tokens",
    name: "Token session",
    accountId: "local-codex",
    tool: "codex",
    cwd: "/fixture/projects/website",
    status: "running",
    activity: { state: "idle" },
  };
  const data = {
    availability: "ready",
    providerSessionId: "native",
    history: { generation: "one", cursor: null },
    messages: [{ id: "reply", role: "assistant", text: "Done." }],
    tasks: [],
    observability,
  };
  const publish = await mockChatStream(page, () => data);
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/state")
      return route.fulfill({
        json: {
          tools: [{ id: "codex", name: "Codex", installed: true }],
          accounts: [{ id: "local-codex", name: "Codex", tool: "codex", kind: "local" }],
          sessions: [session],
          home: "/fixture",
        },
      });
    if (path.endsWith("/chat")) return route.fulfill({ json: data });
    if (path.endsWith("/models"))
      return route.fulfill({
        json: { currentModel: null, picker: null, pending: false },
      });
    throw new Error(`Unexpected token fixture request: ${path}`);
  });
  await page.goto(baseURL + "/sessions/tokens/chat");
  await expect(page.locator(".chat-messages")).toContainText("Done.");
  return { data, publish };
}

for (const locale of ["de-DE", "en-GB"]) {
  test.describe(locale, () => {
    test.use({ locale });
    const text = copy[locale];

    test("Claude shows an assumed window, totals with a lower bound, cost scope and subagent usage", async ({
      page,
    }) => {
      const { data, publish } = await subagentFixture(page);
      data.observability = claudeObservability(data);
      publish();
      const context = page.getByRole("group", { name: text.context });
      await expect(context).toContainText(text.assumed);
      await expect(context.locator(".chat-context-bar")).toBeVisible();
      await page.locator(".chat-token-details > summary").click();
      await expect(
        page.locator(".chat-token-totals tr", { hasText: text.outputLabel }),
      ).toContainText(text.output);
      await expect(page.locator(".chat-token-cost")).toHaveText(text.cost);
      await expect(page.locator(".chat-token-subagents")).toHaveText(text.subagents);
      await expect(
        page.locator('.chat-subagent[data-message-id="toolu_review"] .subagent-usage'),
      ).toHaveText(text.row);
      await page.getByRole("button", { name: text.show }).click();
      await expect(
        page
          .locator(".subagent-entry", { hasText: "Review parser" })
          .locator(".subagent-usage"),
      ).toHaveText(text.row);
      data.observability.stale = true;
      publish();
      await expect(context).toContainText(text.stale);
      await expect(page.locator(".chat-token-cost")).toHaveText(text.cost);
    });

    test("after a compaction only the conversation size is shown, without a bar", async ({
      page,
    }) => {
      const { data, publish } = await subagentFixture(page);
      data.observability = {
        ...data.observability,
        context: {
          usedTokens: null,
          limitTokens: 1000000,
          remainingPercent: null,
          source: null,
          limitSource: "assumed-model",
          observedAt: "2026-10-01T10:05:00Z",
          modelId: "claude-opus-5-5",
          compaction: { conversationTokens: 41200, observedAt: "2026-10-01T10:05:00Z" },
        },
      };
      publish();
      const context = page.getByRole("group", { name: text.context });
      await expect(context).toContainText(text.compaction);
      await expect(context.locator(".chat-context-bar")).toHaveCount(0);
      await expect(context).not.toContainText("%");
    });

    test("Codex shows thread totals without cost and its limit buckets", async ({
      page,
    }) => {
      const resets = Date.now() + 3 * 3600 * 1000;
      await codexFixture(page, {
        context: {
          usedTokens: 70000,
          limitTokens: 272000,
          remainingPercent: 78,
          source: "native-token-count",
          limitSource: "native",
          observedAt: null,
          modelId: "gpt-5.5",
          compaction: null,
        },
        totals: {
          inputTokens: 52000,
          outputTokens: 2000,
          cacheReadTokens: 40000,
          cacheWriteTokens: 0,
          reasoningTokens: 800,
          totalTokens: 54000,
          outputIsLowerBound: false,
          cost: null,
          source: "codex-thread",
          observedAt: null,
          subagents: null,
        },
        limits: {
          source: "codex-rate-limits",
          observedAt: null,
          buckets: [
            {
              limitId: "codex",
              limitName: null,
              plan: "pro",
              windows: [{ windowMinutes: 10080, usedPercent: 42, resetsAt: resets }],
              credits: null,
            },
            {
              limitId: "codex_bengalfox",
              limitName: "GPT-5.3-Codex-Spark",
              plan: null,
              windows: [
                { windowMinutes: 300, usedPercent: 12, resetsAt: resets },
                { windowMinutes: 10080, usedPercent: 3, resetsAt: resets },
              ],
              credits: null,
            },
          ],
        },
        subagents: [],
      });
      await page.locator(".chat-token-details > summary").click();
      await expect(page.locator(".chat-token-totals")).toContainText(text.inputCodex);
      await expect(page.locator(".chat-token-totals")).toContainText("Reasoning");
      await expect(page.locator(".chat-token-cost")).toHaveCount(0);
      const buckets = page.locator(".chat-limit-bucket");
      await expect(buckets).toHaveCount(2);
      await expect(buckets.nth(0)).toContainText(text.week);
      await expect(buckets.nth(0)).toContainText(text.used);
      await expect(buckets.nth(0).locator("time")).toHaveAttribute("title", /\d/);
      await expect(buckets.nth(1)).toContainText("GPT-5.3-Codex-Spark");
      await expect(buckets.nth(1)).toContainText("5 h");
    });

    test("the collapsed mobile row shows only a compact percentage chip", async ({
      page,
    }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      const { data, publish } = await subagentFixture(page);
      data.observability = claudeObservability(data);
      publish();
      const chip = page.locator(".chat-context-chip");
      await expect(chip).toBeVisible();
      await expect(chip).toHaveText(text.chip);
      await expect(page.locator(".chat-context-budget")).toBeHidden();
      await expect(page.locator(".chat-token-details")).toBeHidden();
      await page.getByRole("button", { name: text.showContext }).click();
      await expect(page.locator(".chat-context-budget")).toBeVisible();
      await expect(chip).toBeHidden();
    });
  });
}
```

- [ ] **Step 7: Run the browser tests to verify they fail**

Run: `npm run build && npx playwright test tests/browser/chat-tokens.spec.js`
Expected: FAIL (no `.chat-context-bar`, no `.chat-token-details`).

- [ ] **Step 8: Create `web/features/chat/ContextBudget.jsx`**

```jsx
import React from "react";
import { chatObservabilityCopy as copy } from "../../lib/i18n/messages/chat-observability.js";
import { formatNumber, formatTimestamp } from "../../lib/i18n/index.js";
import { formatTokens, tokenCount, usedPercent } from "./token-presentation.js";

const sourceLabel = (source) =>
  source === "last-api-request"
    ? copy.lastRequest
    : source === "native-token-count"
      ? copy.nativeUsage
      : copy.unknownSource;
const limitLabel = (source) =>
  ({
    configured: copy.configuredLimit,
    native: copy.nativeLimit,
    "assumed-model": copy.assumedLimit,
  })[source] || copy.unspecifiedLimit;

/** Context row: bar, used / window, labels; a compaction shows only its size. */
export default function ContextBudget({ context = {}, stale = false }) {
  const used = tokenCount(context.usedTokens),
    limit = tokenCount(context.limitTokens);
  const remaining =
    typeof context.remainingPercent === "number" &&
    Number.isFinite(context.remainingPercent)
      ? context.remainingPercent
      : null;
  const percent = used !== null && limit ? usedPercent(context) : null;
  const compaction =
    used === null ? tokenCount(context.compaction?.conversationTokens) : null;
  return (
    <>
      {remaining !== null && limit !== null && (
        <span className="chat-context-chip" aria-hidden="true">
          {copy.remainingShort(formatNumber(remaining, { maximumFractionDigits: 0 }))}
        </span>
      )}
      <div
        className="chat-context-budget"
        role="group"
        aria-label={copy.context}
        title={context.observedAt ? formatTimestamp(context.observedAt) : undefined}
      >
        {percent !== null && (
          <span
            className="chat-context-bar"
            role="meter"
            aria-label={copy.contextUsed}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          >
            <span style={{ width: `${percent}%` }} />
          </span>
        )}
        <span>
          {used !== null
            ? `${sourceLabel(context.source)}: ${formatTokens(used)}`
            : compaction !== null
              ? copy.compaction(formatTokens(compaction))
              : copy.unknownUsage}
        </span>
        {limit !== null && limit > 0 && (
          <span>
            {limitLabel(context.limitSource)}: {formatTokens(limit)}
          </span>
        )}
        {used !== null && limit !== null && limit > 0 && (
          <span>{copy.usedOfWindow(formatTokens(used), formatTokens(limit))}</span>
        )}
        {remaining !== null && (
          <span>
            {copy.remaining(formatNumber(remaining, { maximumFractionDigits: 1 }))}
          </span>
        )}
        {stale && <span>{copy.stale}</span>}
      </div>
    </>
  );
}
```

- [ ] **Step 9: Create `web/features/chat/TokenDetails.jsx`**

```jsx
import React from "react";
import { chatObservabilityCopy as copy } from "../../lib/i18n/messages/chat-observability.js";
import { formatNumber, formatTimestamp } from "../../lib/i18n/index.js";
import { relativeTime } from "../projects/ProjectOverview.jsx";
import {
  formatTokens,
  formatUsd,
  lowerBoundShown,
  tokenCount,
  windowLabel,
} from "./token-presentation.js";

function totalsRows(totals) {
  const codex = typeof totals.source === "string" && totals.source.startsWith("codex-");
  return [
    [codex ? copy.inputInclCache : copy.input, totals.inputTokens, ""],
    [copy.output, totals.outputTokens, totals.outputIsLowerBound ? "≥" : ""],
    [copy.cacheRead, totals.cacheReadTokens, ""],
    [copy.cacheWrite, totals.cacheWriteTokens, ""],
    [copy.reasoning, totals.reasoningTokens, ""],
    [copy.total, totals.totalTokens, lowerBoundShown(totals) ? "≥" : ""],
  ].filter(([, value]) => tokenCount(value) !== null);
}

function Cost({ cost }) {
  const amount = formatUsd(cost?.usd);
  if (!amount) return null;
  return (
    <p className="chat-token-cost">
      {cost.scope === "cli-exit-incl-subagents" ? copy.costCliExit : copy.cost}: {amount}
    </p>
  );
}

function SubagentLine({ subagents }) {
  if (!subagents?.count && !subagents?.unavailable) return null;
  const tokens = formatTokens(subagents.totalTokens);
  const parts = [
    tokens === null
      ? copy.subagentUsageCount(subagents.count)
      : copy.subagentUsage(
          subagents.count,
          `${lowerBoundShown(subagents) ? "≥" : ""}${tokens}`,
        ),
  ];
  if (subagents.workflowAgents) parts.push(copy.workflowAgents);
  if (subagents.unavailable) parts.push(copy.unavailableAgents(subagents.unavailable));
  return <p className="chat-token-subagents">{parts.join(" · ")}</p>;
}

function Credits({ credits }) {
  if (credits?.unlimited) return <span>{copy.creditsUnlimited}</span>;
  if (credits?.hasCredits && credits.balance !== null)
    return <span>{copy.credits(credits.balance)}</span>;
  return null;
}

function Limits({ limits }) {
  if (!limits?.buckets?.length) return null;
  return (
    <section className="chat-token-limits" aria-label={copy.limits}>
      {limits.buckets.map((bucket) => (
        <div className="chat-limit-bucket" key={bucket.limitId}>
          <strong>
            {[bucket.limitName || bucket.limitId, bucket.plan]
              .filter(Boolean)
              .join(" · ")}
          </strong>
          {bucket.windows.map((window, index) => {
            const label = windowLabel(window.windowMinutes);
            const resets = Number.isSafeInteger(window.resetsAt)
              ? new Date(window.resetsAt).toISOString()
              : null;
            return (
              <div className="chat-limit-window" key={index}>
                <span>{label}</span>
                <span
                  className="chat-context-bar"
                  role="meter"
                  aria-label={label}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={window.usedPercent}
                >
                  <span style={{ width: `${window.usedPercent}%` }} />
                </span>
                <span>
                  {copy.limitUsed(
                    formatNumber(window.usedPercent, { maximumFractionDigits: 1 }),
                  )}
                </span>
                {resets && (
                  <time dateTime={resets} title={formatTimestamp(resets)}>
                    {copy.resets(relativeTime(resets))}
                  </time>
                )}
              </div>
            );
          })}
          <Credits credits={bucket.credits} />
        </div>
      ))}
    </section>
  );
}

/** Session totals, cost, subagent share and Codex limits behind one disclosure. */
export default function TokenDetails({ totals, limits }) {
  const rows = totals ? totalsRows(totals) : [];
  if (!rows.length && !totals?.cost && !totals?.subagents && !limits?.buckets?.length)
    return null;
  return (
    <details className="chat-token-details">
      <summary>{copy.usage}</summary>
      {rows.length > 0 && (
        <table className="chat-token-totals" aria-label={copy.totals}>
          {totals.source === "codex-process" && <caption>{copy.processTotals}</caption>}
          <tbody>
            {rows.map(([label, value, prefix]) => (
              <tr key={label}>
                <th scope="row">{label}</th>
                <td>
                  {prefix}
                  {formatTokens(value)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Cost cost={totals?.cost} />
      <SubagentLine subagents={totals?.subagents} />
      <Limits limits={limits} />
    </details>
  );
}
```

- [ ] **Step 10: Compose them in `ChatObservability.jsx`**

Replace `web/features/chat/ChatObservability.jsx` with:

```jsx
import React, { useState } from "react";
import { chatObservabilityCopy as copy } from "../../lib/i18n/messages/chat-observability.js";
import { sessionActivity } from "../sessions/sessionPresentation.js";
import { subagentHeading } from "./subagent-presentation.js";
import ContextBudget from "./ContextBudget.jsx";
import TokenDetails from "./TokenDetails.jsx";

export default function ChatObservability({
  session,
  observability,
  showSubagents,
  subagents = [],
}) {
  const [expanded, setExpanded] = useState(false);
  const activity = sessionActivity(session);
  return (
    <div className={`chat-observability${expanded ? " expanded" : ""}`}>
      <span className="chat-activity" role="status" aria-label={copy.activity}>
        <span
          className={
            activity.state === "working"
              ? "chat-working-spinner"
              : `activity-dot ${activity.state}`
          }
          aria-hidden="true"
        />
        {activity.label}
      </span>
      <button
        type="button"
        className="chat-context-toggle"
        aria-expanded={expanded}
        aria-label={expanded ? copy.hideContext : copy.showContext}
        onClick={() => setExpanded((value) => !value)}
      >
        {copy.details} {expanded ? "⌃" : "⌄"}
      </button>
      <ContextBudget
        context={observability?.context || {}}
        stale={Boolean(observability?.stale)}
      />
      <TokenDetails totals={observability?.totals} limits={observability?.limits} />
      {subagents.length > 0 && (
        <button type="button" aria-label={copy.showSubagents} onClick={showSubagents}>
          {subagentHeading(subagents)}
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 11: Show usage on subagent rows and list entries**

1. `web/features/chat/ChatMessage.jsx`: add `import { observedAgent, usageSummary } from "./token-presentation.js";`. After the `status` constant (line 29) add:

```js
const usage = subagent
  ? usageSummary(observedAgent(message, observedSubagents)?.usage)
  : null;
```

and after the closing `</small>` of the status (line 52, inside `<summary>`) add:

<!-- prettier-ignore -->
```jsx
          {usage && <small className="subagent-usage">{usage}</small>}
```

2. `web/features/chat/SubagentList.jsx`: add `import { usageSummary } from "./token-presentation.js";`. Inside the `subagents.map` callback compute `const usage = usageSummary(agent.usage);` (convert the arrow body to a block returning the `<article>`), and render below `<p>{agent.task || copy.noTask}</p>`:

<!-- prettier-ignore -->
```jsx
          {usage && <small className="subagent-usage">{usage}</small>}
```

- [ ] **Step 12: Style the bar, details and chip**

Append to `web/features/chat/observability.css`:

```css
.chat-context-chip {
  display: none;
}
.chat-context-bar {
  position: relative;
  display: inline-block;
  width: 72px;
  height: 5px;
  flex-shrink: 0;
  overflow: hidden;
  border-radius: 3px;
  background: var(--line);
}
.chat-context-bar > span {
  position: absolute;
  inset: 0 auto 0 0;
  background: var(--accent);
}
.chat-token-details > summary {
  color: var(--accent);
  cursor: pointer;
}
.chat-token-details[open] {
  flex-basis: 100%;
}
.chat-token-totals {
  border-collapse: collapse;
  margin: 6px 0;
}
.chat-token-totals caption {
  text-align: left;
}
.chat-token-totals th,
.chat-token-totals td {
  padding: 1px 12px 1px 0;
  text-align: left;
  font-weight: normal;
}
.chat-token-totals td {
  font-variant-numeric: tabular-nums;
}
.chat-token-cost,
.chat-token-subagents {
  margin: 4px 0;
}
.chat-limit-bucket {
  display: grid;
  gap: 4px;
  margin-top: 8px;
}
.chat-limit-window {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.subagent-usage {
  margin-left: 8px;
  color: var(--muted);
  font-size: 9px;
}
.subagent-entry .subagent-usage {
  display: block;
  margin: 0;
  padding: 0 10px 6px;
}
```

In `web/features/chat/mobile-chat.css`, inside the `@media (max-width: 700px)` block after the `.chat-context-budget` rules (lines 52-58) add:

```css
.mobile-chat-workspace .chat-observability:not(.expanded) .chat-context-chip {
  display: inline-block;
}
.mobile-chat-workspace .chat-observability:not(.expanded) .chat-token-details {
  display: none;
}
.mobile-chat-workspace .chat-token-details {
  order: 5;
  width: 100%;
}
```

- [ ] **Step 13: Run all affected tests in Chromium and WebKit**

Run:

```bash
npm run build
npx playwright test tests/browser/chat-tokens.spec.js tests/browser/chat-subagents.spec.js tests/browser/chat-presentation.spec.js
AGENTPIER_TEST_BROWSER=webkit npx playwright test tests/browser/chat-tokens.spec.js tests/browser/chat-subagents.spec.js tests/browser/chat-presentation.spec.js
node --test tests/unit/token-presentation.test.js tests/unit/subagent-presentation.test.js tests/unit/i18n-catalogs.test.js
```

Expected: PASS. If WebKit is missing, install it with `npx playwright install webkit` first. The en-GB cases exercise the changed UI in English. For the PR screenshots, copy the spec to an uncommitted `tests/browser/zz-token-screenshots.spec.js`, add `await page.screenshot({ path: "<scratchpad>/<name>.png" })` after the en-GB assertions of the Claude, Codex and mobile cases, run it with `npx playwright test tests/browser/zz-token-screenshots.spec.js` (isolated server on port 4389), then delete the copy. Never start a server on port 4380 for this.

- [ ] **Step 14: Format, lint and commit**

```bash
npm run format && npm run lint && npm run check:structure
git add web/features/chat/token-presentation.js web/features/chat/ContextBudget.jsx \
  web/features/chat/TokenDetails.jsx web/features/chat/ChatObservability.jsx \
  web/features/chat/ChatMessage.jsx web/features/chat/SubagentList.jsx \
  web/features/chat/observability.css web/features/chat/mobile-chat.css \
  web/lib/i18n/en/chat-observability.js web/lib/i18n/de/chat-observability.js \
  tests/unit/token-presentation.test.js tests/browser/chat-tokens.spec.js
git commit -F - <<'EOF'
feat: show context bar, session totals, limits and subagent usage

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 8: Documentation, real-data validation and full check

**Files:**

- Modify: `docs/chat-observability.md:5-21` (shape), `:37` (window policy), `:39-45` (compaction), new sections after `:45` and `:58`, `:82-95` (verification)
- Create (not committed): `$SCRATCH/validate-token-tracking.mjs`, where `$SCRATCH` is the session scratchpad directory

**Interfaces:**

- Consumes: everything from Tasks 1-7.
- Produces: updated operating documentation; validation numbers for the PR description.

- [ ] **Step 1: Update the documented shape**

Replace the JSON block at `docs/chat-observability.md:5-21` with:

````md
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
````

- [ ] **Step 2: Replace the window policy paragraph**

Replace line 37 ("When no native limit exists, ...") with:

```md
Native limits take precedence. When no native limit exists, an exact persisted launch provider configuration can supply `limitTokens`, labeled `limitSource: "configured"`; a known model mismatch suppresses this fallback, and the current editable account selection is not evidence of an already running session's model. First-party Claude sessions (no provider object) then use Claude Code's own model table (2.1.289), labeled `limitSource: "assumed-model"` and shown as "assumed": claude-opus-4-6, -4-7, -4-8, claude-opus-5, -5-5, claude-sonnet-4-6, claude-sonnet-5, -5-5, claude-fable-5 (and -5-1) and claude-mythos have 1,000,000 tokens; claude-haiku-4-5, older models and any other `claude-*` id have 200,000. The model is the observed `message.model`, else the session's selected model, with `[1m]` removed. When the observed usage exceeds the assumed window, the assumption is dropped and no percentage is shown. Provider and gateway sessions never use the table. The assumption is re-evaluated on every read, including saved snapshots.
```

- [ ] **Step 3: Document compaction, totals, cost, limits and subagent usage**

Append to the "Source ordering and compaction" section (after line 45):

```md
After a Claude compaction, `context.compaction.conversationTokens` holds `compactMetadata.postTokens`. That count leaves out the system prompt, tools and re-injected attachments and is typically 2–13x smaller than the next real context, so it is shown as "conversation after compaction (excl. system/tools)" without a bar. `usedTokens` stays null until the next assistant usage.
```

Insert a new section before "## Subagent identities and lifecycle":

```md
## Session totals and cost

`totals` holds `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `reasoningTokens`, `totalTokens`, `outputIsLowerBound`, `cost: { usd, scope } | null`, `source`, `observedAt` and `subagents`. Totals come only from whole-history sources: the Claude history index or a full read, the Codex thread record, or the OpenCode session row. A page that sees only part of the history reports `totals: null`, and Chat keeps the last known totals of the same conversation. Main totals never include subagent usage; `totals.subagents` reports it separately.

| CLI         | Source                                                                                                                                                                                        | `totalTokens`                                         | Cost                                                                                                                           |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Claude Code | Assistant `message.usage` in the main transcript, last record per `message.id`                                                                                                                | input + cache write + cache read + output             | `cost-state.totalCostUSD`, only while no assistant record follows the latest `cost-state` (`scope: "cli-exit-incl-subagents"`) |
| Codex       | Latest `token_usage_record.payload.thread_token_usage` (`source: "codex-thread"`); `token_count.info.total_token_usage` only as a fallback labeled "this process" (`source: "codex-process"`) | `total_tokens` as reported                            | none                                                                                                                           |
| OpenCode    | `session` row: `tokens_input`, `tokens_output`, `tokens_reasoning`, `tokens_cache_read`, `tokens_cache_write`, `cost`                                                                         | input + output + reasoning + cache read + cache write | `cost` (`scope: "session"`)                                                                                                    |

Claude writes duplicates of one `message.id` next to each other and their `output_tokens` only grows, so the last record per id counts. About half of current responses never receive their final usage (`stop_reason: null` with a placeholder `output_tokens`), so Claude output is a lower bound (`outputIsLowerBound: true`, shown with "≥"). Thinking is part of output and is not reported separately (`reasoningTokens: null`). `usage.iterations[]`, `speed`, `fallback_credit` and `server_tool_use` are ignored. Claude writes `cost-state` only when the CLI exits, and it includes subagents and side queries such as titles and web search, hence its label "Cost as of last CLI exit (incl. subagents)". Codex input includes the cached part and reasoning is a subset of output; both are shown as reported. OpenCode's session row equals the sum of its messages.

## Codex rate limits

`limits.buckets` keeps the latest `token_count.rate_limits` snapshot per `limit_id` (for example "codex", "codex_bengalfox" for GPT-5.3-Codex-Spark, "premium"). Each window carries `windowMinutes`, `usedPercent` and `resetsAt` (epoch milliseconds) and is labeled by its length ("5 h", "7 days"). Windows whose reset time has passed are hidden. Credits are shown only when the account has credits or unlimited credits; the balance stays the reported decimal string.

## Subagent usage

Subagent entries may carry `usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, totalTokens, outputIsLowerBound, toolUses, durationMs, costUsd }`.

- **Claude Code:** tokens come only from `<session>/subagents/agent-<agentId>.jsonl` (last record per `message.id`, output a lower bound) and link through the file's agent id or `agent-<agentId>.meta.json`'s `toolUseId`. Agents with `parentAgentId` (spawn depth 2) are added to their top-level ancestor and never listed. Agents under `subagents/workflows/wf_*/` have no Agent call: they count in `totals.subagents` as workflow agents but get no row. Duration and tool uses come from the task notification's `<duration_ms>` and `<tool_uses>`; its `<subagent_tokens>` is the last request's size, not consumption, and is never used. A bounded per-session cache reads these files in the background: it only parses complete lines that contain `"usage"`, stays inside the profile root, re-reads only files of running (or just finished) agents plus new files, and never delays the chat read; a finished scan refreshes the chat.
- **Codex:** children come from `$CODEX_HOME/state_5.sqlite` (`thread_spawn_edges` joined with `threads.rollout_path`, opened read-only or immutable). Each child's usage is its rollout's last `token_usage_record`, read backwards and cached by size and modification time; grandchildren are added to the child that spawned them. Linking is by thread id only. Children whose rollout lies outside the session's profile root are excluded and counted as unavailable.
- **OpenCode:** child sessions are the `session` rows with `parent_id` equal to the session, linked to task rows through the child session id; their usage and cost come from those rows.

`totals.subagents` (`count`, token fields, `outputIsLowerBound`, `costUsd`, `workflowAgents`, `unavailable`) covers all known subagents, not only the listed ones. Rows and the task panel show "12.4K tokens · 1m 32s"; "≥" appears when a Claude output lower bound makes up at least half of the shown total.
```

- [ ] **Step 4: Extend the verification commands**

In the "## Verification" code block add these files to the `node --test` list:

```text
  tests/unit/token-usage.test.js \
  tests/unit/observability-finalize.test.js \
  tests/unit/claude-token-totals.test.js \
  tests/unit/codex-token-totals.test.js \
  tests/unit/token-presentation.test.js \
  tests/integration/claude-token-history.test.js \
  tests/integration/claude-subagent-usage.test.js \
  tests/integration/codex-child-usage.test.js \
  tests/integration/opencode-token-totals.test.js \
```

- [ ] **Step 5: Write the real-data validation script (scratchpad only, never committed)**

Create `$SCRATCH/validate-token-tracking.mjs`. It prints only aggregate numbers, never record content:

```js
// Real-data validation for the PR description. Prints aggregate numbers only.
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const repo = "/Users/d.kaulig/Projects/agent-pier/.worktrees/token-tracking";
const load = (file) => import(path.join(repo, file));
const { readJsonLines } = await load("server/features/chat/provider-history.js");
const { observeClaude, observeCodex } = await load(
  "server/features/chat/chat-observability.js",
);
const { ClaudeSubagentUsage } = await load(
  "server/features/chat/claude-subagent-usage.js",
);
const { CodexChildUsage, lastTokenUsage } = await load(
  "server/features/chat/codex-child-usage.js",
);
const { CodexRolloutMetadata } = await load(
  "server/features/chat/codex-rollout-metadata.js",
);
const { openCodeTotals } = await load("server/features/chat/token-usage.js");
const profiles = "/Users/d.kaulig/Library/Application Support/AgentPier/profiles";
const list = async (directory) => (await fs.readdir(directory).catch(() => [])).sort();

/** Independent recomputation: a Map over all ids, no adjacency assumption. */
function independent(records) {
  const last = new Map();
  const anonymous = [];
  for (const record of records)
    if (record?.type === "assistant" && record.message?.usage && !record.isSidechain)
      record.message.id
        ? last.set(record.message.id, record.message.usage)
        : anonymous.push(record.message.usage);
  const all = [...last.values(), ...anonymous];
  const sum = (field) => all.reduce((total, usage) => total + (usage[field] || 0), 0);
  return {
    input: sum("input_tokens"),
    cacheWrite: sum("cache_creation_input_tokens"),
    cacheRead: sum("cache_read_input_tokens"),
    output: sum("output_tokens"),
  };
}
const subagentRecords = async (directory) => {
  const files = [];
  for (const name of await list(directory)) {
    const file = path.join(directory, name);
    if ((await fs.stat(file)).isDirectory()) files.push(...(await subagentRecords(file)));
    else if (/^agent-.*\.jsonl$/.test(name)) files.push(file);
  }
  return files;
};

// Claude session 57444b1d
for (const profile of await list(profiles)) {
  const projects = path.join(profiles, profile, "claude", "projects");
  for (const project of await list(projects)) {
    const file = path.join(
      projects,
      project,
      "57444b1d-ee52-4ebe-9641-34847aaddfbf.jsonl",
    );
    if (!(await fs.stat(file).catch(() => null))) continue;
    const records = await readJsonLines(file);
    const totals = observeClaude(records).totals;
    const check = independent(records);
    console.log("claude main", {
      observed: [
        totals.inputTokens,
        totals.cacheWriteTokens,
        totals.cacheReadTokens,
        totals.outputTokens,
      ],
      independent: [check.input, check.cacheWrite, check.cacheRead, check.output],
      outputIsLowerBound: totals.outputIsLowerBound,
      cost: totals.cost,
    });
    const usage = new ClaudeSubagentUsage({
      root: async () => path.join(profiles, profile, "claude"),
    });
    const session = { id: "validate", accountId: "validate", cwd: "/" };
    usage.peek(session, "57444b1d-ee52-4ebe-9641-34847aaddfbf", file, []);
    await usage.entries.get("validate").pending;
    const result = usage.peek(session, "57444b1d-ee52-4ebe-9641-34847aaddfbf", file, []);
    const sub = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
    for (const agentFile of await subagentRecords(
      path.join(projects, project, "57444b1d-ee52-4ebe-9641-34847aaddfbf", "subagents"),
    )) {
      const part = independent(
        (await readJsonLines(agentFile)).map((r) => ({ ...r, isSidechain: false })),
      );
      for (const key of Object.keys(sub)) sub[key] += part[key];
    }
    const agents = [
      ...Object.values(result?.agents || {}),
      ...(result?.workflow?.usage ? [result.workflow.usage] : []),
    ];
    const sum = (field) =>
      agents.reduce((total, entry) => total + (entry[field] || 0), 0);
    console.log("claude subagents", {
      agents: Object.keys(result?.agents || {}).length,
      workflowAgents: result?.workflow?.count || 0,
      observed: [
        sum("inputTokens"),
        sum("cacheWriteTokens"),
        sum("cacheReadTokens"),
        sum("outputTokens"),
      ],
      independent: [sub.input, sub.cacheWrite, sub.cacheRead, sub.output],
    });
    usage.close();
  }
}

// Codex: the parent with the most children per profile
for (const profile of await list(profiles)) {
  const root = path.join(profiles, profile, "codex");
  const stateFile = path.join(root, "state_5.sqlite");
  if (!(await fs.stat(stateFile).catch(() => null))) continue;
  const db = new DatabaseSync(stateFile, { readOnly: true });
  const parent = db
    .prepare(
      "SELECT e.parent_thread_id AS id, t.rollout_path AS rollout, COUNT(*) AS children FROM thread_spawn_edges e JOIN threads t ON t.id=e.parent_thread_id GROUP BY 1 ORDER BY 3 DESC LIMIT 1",
    )
    .get();
  const edges = parent
    ? db
        .prepare(
          "SELECT e.child_thread_id AS id, t.rollout_path AS rollout FROM thread_spawn_edges e LEFT JOIN threads t ON t.id=e.child_thread_id WHERE e.parent_thread_id=?",
        )
        .all(parent.id)
    : [];
  db.close();
  if (!parent) continue;
  const parentTail = await lastTokenUsage(parent.rollout, parent.id);
  // The same bounded incremental projection the chat uses; rollouts can exceed 900 MB.
  const projected = await new CodexRolloutMetadata().scan(parent.rollout, {
    offset: 0,
    records: new Map(),
    plans: new Map(),
    agents: [],
  });
  const observed = observeCodex({ id: parent.id }, projected).totals;
  const children = await new CodexChildUsage().read(
    { home: root, environment: () => ({ CODEX_HOME: root }) },
    {},
    parent.id,
  );
  let independentChildren = 0;
  for (const edge of edges) {
    if (!edge.rollout) continue;
    const records = await readJsonLines(edge.rollout).catch(() => []);
    const last = records.filter((r) => r?.type === "token_usage_record").at(-1);
    independentChildren += last?.payload?.thread_token_usage?.total_tokens || 0;
  }
  const childTotal = Object.values(children?.agents || {}).reduce(
    (total, entry) => total + (entry.totalTokens || 0),
    0,
  );
  console.log("codex", {
    profile: profile.slice(0, 8),
    edges: edges.length,
    parentObserved: observed?.totalTokens ?? null,
    parentTail: parentTail?.totalTokens ?? null,
    childrenObserved: childTotal,
    childrenIndependent: independentChildren,
    unavailable: children?.unavailable ?? null,
  });
}

// OpenCode: session rows against message sums, for every local database
const openCodeDatabases = ["/Users/d.kaulig/.local/share/opencode/opencode.db"];
for (const profile of await list(profiles))
  for (const provider of await list(path.join(profiles, profile, "providers")))
    openCodeDatabases.push(
      path.join(
        profiles,
        profile,
        "providers",
        provider,
        "data",
        "opencode",
        "opencode.db",
      ),
    );
for (const openCode of openCodeDatabases) {
  if (!(await fs.stat(openCode).catch(() => null))) continue;
  const db = new DatabaseSync(openCode, { readOnly: true });
  for (const row of db
    .prepare(
      "SELECT id, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write FROM session ORDER BY time_updated DESC LIMIT 5",
    )
    .all()) {
    const sums = { input: 0, output: 0, reasoning: 0, read: 0, write: 0, cost: 0 };
    for (const message of db
      .prepare("SELECT data FROM message WHERE session_id=?")
      .iterate(row.id)) {
      const data = JSON.parse(message.data);
      sums.input += data.tokens?.input || 0;
      sums.output += data.tokens?.output || 0;
      sums.reasoning += data.tokens?.reasoning || 0;
      sums.read += data.tokens?.cache?.read || 0;
      sums.write += data.tokens?.cache?.write || 0;
      sums.cost += data.cost || 0;
    }
    const totals = openCodeTotals(row);
    console.log("opencode", {
      database: openCode.includes("/providers/") ? "provider profile" : "local",
      row: [
        totals?.inputTokens,
        totals?.outputTokens,
        totals?.reasoningTokens,
        totals?.cacheReadTokens,
        totals?.cacheWriteTokens,
        totals?.cost?.usd,
      ],
      messages: [
        sums.input,
        sums.output,
        sums.reasoning,
        sums.read,
        sums.write,
        Number(sums.cost.toFixed(6)),
      ],
    });
  }
  db.close();
}
```

Run: `node "$SCRATCH/validate-token-tracking.mjs"`
Expected: Claude main and subagent input/cache numbers equal their independent values; Claude output observed equals the independent output and is flagged `outputIsLowerBound: true`; the Codex `parentObserved` equals `parentTail` and `childrenObserved` equals `childrenIndependent` (minus excluded or unavailable children); OpenCode row values equal the message sums. Record the printed numbers (no content) for the PR description. Investigate any mismatch before continuing.

- [ ] **Step 6: Run the full check and browser suites**

Run:

```bash
npm run check
npx playwright test tests/browser/chat-tokens.spec.js tests/browser/chat-subagents.spec.js tests/browser/chat-presentation.spec.js
AGENTPIER_TEST_BROWSER=webkit npx playwright test tests/browser/chat-tokens.spec.js tests/browser/chat-subagents.spec.js tests/browser/chat-presentation.spec.js
```

Expected: PASS. A failure in `shell.test.js` that also fails on an unchanged `main` checkout is environment-related; note it in the PR instead of changing it.

- [ ] **Step 7: Commit**

```bash
npm run format
git add docs/chat-observability.md
git commit -F - <<'EOF'
chore: document token tracking sources and policies

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

## After the last task (controller, not a task)

1. Remove the completed working documents in a final cleanup commit: `git rm docs/superpowers/specs/2026-10-04-token-tracking-design.md docs/superpowers/plans/2026-10-04-token-tracking.md` and commit `chore: remove completed token tracking spec and plan` (ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`).
2. Rebase onto `origin/main` once more (PR #172 may have merged meanwhile), rerun `npm run check`, and push `feat/token-tracking`.
3. Open the pull request in English: problem, resulting behavior, the real-data validation numbers from Task 8 Step 5, test commands, and screenshots of the desktop details, Codex limits and the mobile chip. End the description with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
4. Run the local multi-agent review on the branch and resolve its findings before merge (rebase merge after required CI passes).

---

### Task 9: Follow-ups from the PR #172 review

**Files:**
- Modify: `server/features/chat/claude-history-page.js` (provisional first page, ~L108)
- Modify: `web/features/chat/subagent-presentation.js` (first-seen cutoff, ~L72)
- Modify: `tests/browser/chat-presentation.spec.js` (~L179), `tests/browser/subagent-fixture.js` (~L15)
- Test: extend `tests/integration/claude-subagent-history.test.js` and `tests/unit/subagent-presentation.test.js`

**Interfaces:** none new.

- [ ] **Step 1: Write failing tests**
  1. Integration: a small transcript is read completely by the backward read (`end === 0`). After an append that completes an agent, the provisional first page returns the fresh tail state, not the older indexed snapshot.
  2. Unit: an agent first seen already finished, with `updatedAt` 30 s before the client's `now`, is still listed once. The first-seen tolerance is 60 s; the linger stays 10 s of client time.
- [ ] **Step 2: Run them and confirm they fail**
- [ ] **Step 3: Implement**
  - `claude-history-page.js`: `const whole = state || end === 0 ? null : await history.claudePages?.metadata(session, id, reader);`. Keep the Task 2 totals rule: a complete page reports totals.
  - `subagent-presentation.js`: add `SUBAGENT_FIRST_SEEN_TOLERANCE_MS = 60_000`, used only for the "first seen already finished" check (`now - time > tolerance`). The linger stays `SUBAGENT_LINGER_MS`.
  - Browser fixtures: set `page.clock.install` time equal to the completed agent's `updatedAt` (or 1 s after it), so the full 10 s linger budget is available before `pauseClockSoon`.
- [ ] **Step 4: Run the tests**
  - The focused tests.
  - `tests/browser/chat-presentation.spec.js` and `tests/browser/chat-subagents.spec.js` in Chromium and WebKit, the latter with `--repeat-each=3`.
- [ ] **Step 5: Commit** `fix: serve complete small transcripts live and tolerate clock skew for finished subagents`
