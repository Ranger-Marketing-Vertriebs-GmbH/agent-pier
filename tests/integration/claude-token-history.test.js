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
