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
