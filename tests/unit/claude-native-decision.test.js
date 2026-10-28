import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  watchNativeDecision,
  recentLines,
  subagentTranscriptPath,
} from "../../server/features/requests/claude-native-decision.js";

const input = { command: "echo ü€ ready", description: "Write marker" };
const line = (value) => JSON.stringify(value) + "\n";
const toolUse = (id) =>
  line({
    type: "assistant",
    message: { content: [{ type: "tool_use", id, name: "Bash", input }] },
  });
const toolResult = (id) =>
  line({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
  });
const filler = (count) =>
  Array.from({ length: count }, (_, i) => line({ type: "attachment", i })).join("");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function watch(t, content) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-native-decision-"));
  const file = path.join(root, "transcript.jsonl");
  await fs.writeFile(file, content);
  const seen = { matched: [], settled: 0 };
  const stop = watchNativeDecision({
    transcriptPath: file,
    toolName: "Bash",
    toolInput: input,
    interval: 10,
    onMatched: (id) => seen.matched.push(id),
    onSettled: () => seen.settled++,
  });
  t.after(async () => {
    stop();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { file, seen };
}
async function until(predicate) {
  const end = Date.now() + 3000;
  while (Date.now() < end) {
    if (predicate()) return;
    await sleep(5);
  }
  throw Error("watcher observation timed out");
}

test("an orphaned identical call never becomes the target; a late append does", async (t) => {
  // An interrupted earlier run left the same call without any result.
  const { file, seen } = await watch(
    t,
    toolUse("toolu_orphan") + filler(recentLines + 5),
  );
  await sleep(80);
  assert.deepEqual(seen.matched, [], "the orphan must not lift the bounded wait");
  // Claude writes this hook's call only after the hook started.
  await fs.appendFile(file, toolUse("toolu_current"));
  await until(() => seen.matched.length === 1);
  assert.deepEqual(seen.matched, ["toolu_current"]);
  await fs.appendFile(file, toolResult("toolu_orphan"));
  await sleep(60);
  assert.equal(seen.settled, 0, "the orphan's result is not this decision");
  await fs.appendFile(file, toolResult("toolu_current"));
  await until(() => seen.settled === 1);
});

test("a recent call at hook start is the target and its result settles it", async (t) => {
  const { file, seen } = await watch(t, filler(30) + toolUse("toolu_now") + filler(4));
  await until(() => seen.matched.length === 1);
  assert.deepEqual(seen.matched, ["toolu_now"]);
  await fs.appendFile(file, toolResult("toolu_now"));
  await until(() => seen.settled === 1);
});

test("a multibyte character split across reads still matches", async (t) => {
  const bytes = Buffer.from(toolUse("toolu_split"));
  const cut = bytes.indexOf(Buffer.from("€")) + 1;
  const { file, seen } = await watch(t, "");
  await fs.appendFile(file, bytes.subarray(0, cut));
  await sleep(60);
  await fs.appendFile(file, bytes.subarray(cut));
  await until(() => seen.matched.length === 1);
  assert.deepEqual(seen.matched, ["toolu_split"]);
});

test("a rewritten transcript starts over without reusing what was seen", async (t) => {
  const { file, seen } = await watch(t, filler(40) + toolUse("toolu_a"));
  await until(() => seen.matched.length === 1);
  // Shorter rewrite: the old result-less call is gone, a new one is recent.
  await fs.writeFile(file, toolUse("toolu_b"));
  await sleep(60);
  await fs.appendFile(file, toolResult("toolu_a"));
  await sleep(60);
  assert.equal(seen.settled, 0, "a result for a forgotten call does not settle");
  await fs.appendFile(file, toolResult("toolu_b"));
  await until(() => seen.settled === 1);
});

test("a subagent's calls are watched in its own transcript beside the session's", () => {
  assert.equal(
    subagentTranscriptPath("/home/me/.claude/projects/p/s-1.jsonl", "a01f0579e46face77"),
    "/home/me/.claude/projects/p/s-1/subagents/agent-a01f0579e46face77.jsonl",
  );
  assert.equal(
    subagentTranscriptPath("/p/s.jsonl", "agent_x-1"),
    "/p/s/subagents/agent-agent_x-1.jsonl",
  );
});

test("an unsafe agent id or transcript path derives no subagent transcript", () => {
  for (const agentId of [
    "../x",
    "a/b",
    "a\\b",
    "..",
    "",
    " a1",
    "a1\n",
    "a".repeat(65),
    undefined,
    null,
    42,
    { toString: () => "a1" },
  ])
    assert.equal(subagentTranscriptPath("/p/s.jsonl", agentId), null, String(agentId));
  for (const transcriptPath of ["p/s.jsonl", "/p/s.json", "", undefined, 7])
    assert.equal(
      subagentTranscriptPath(transcriptPath, "a1"),
      null,
      String(transcriptPath),
    );
  assert.equal(subagentTranscriptPath("/p/s.jsonl", "a".repeat(64)) !== null, true);
});

test("a transcript that appears only after the hook started is still watched", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-native-decision-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "subagents", "agent-a1.jsonl");
  const seen = { matched: [], settled: 0 };
  const stop = watchNativeDecision({
    transcriptPath: file,
    toolName: "Bash",
    toolInput: input,
    interval: 10,
    onMatched: (id) => seen.matched.push(id),
    onSettled: () => seen.settled++,
  });
  t.after(stop);
  await sleep(40);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, filler(3) + toolUse("toolu_late"));
  await until(() => seen.matched.length === 1);
  assert.deepEqual(seen.matched, ["toolu_late"]);
  await fs.appendFile(file, toolResult("toolu_late"));
  await until(() => seen.settled === 1);
});
