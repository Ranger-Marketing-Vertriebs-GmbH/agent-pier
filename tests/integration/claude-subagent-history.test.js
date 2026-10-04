import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ClaudeHistoryIndex } from "../../server/features/chat/claude-history-index.js";
import { JsonlHistoryReader } from "../../server/features/chat/jsonl-history-reader.js";
import { normalizeClaude } from "../../server/features/chat/history-parsers.js";
import {
  backgroundRecords as background,
  taskStop,
  notification,
} from "../helpers/claude-subagents.js";
import { claudeHistoryFixture } from "../helpers/claude-history.js";

const filler = (count) =>
  Array.from({ length: count }, (_, i) => ({
    type: "assistant",
    uuid: `filler${i}`,
    message: {
      id: `filler${i}`,
      role: "assistant",
      content: [{ type: "text", text: `${i}` }],
    },
  }));

async function indexed(t, records) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "claude-subagents-"));
  const file = path.join(directory, "source.jsonl");
  await fs.writeFile(file, records.map((r) => JSON.stringify(r) + "\n").join(""));
  const index = new ClaudeHistoryIndex({ file, directory });
  t.after(async () => {
    await index.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const reader = await JsonlHistoryReader.open(file);
  const identity = reader.identity;
  await reader.close();
  await index.refresh(identity);
  const pages = [];
  let page = await index.page({ identity, limit: 50 });
  pages.unshift(normalizeClaude(page.records).messages);
  while (page.nextBefore !== null) {
    page = await index.page({
      identity,
      before: page.nextBefore,
      generation: page.generation,
      limit: 50,
    });
    pages.unshift(normalizeClaude(page.records).messages);
  }
  return pages;
}

test("indexed pages attach hidden completion records to their Agent call", async (t) => {
  const all = background();
  const split = all.findIndex((record) => record.uuid === "waiting") + 1;
  // Completion records land on a newer page than the Agent call they complete.
  const records = [...all.slice(0, split), ...filler(60), ...all.slice(split)];
  const pages = await indexed(t, records);
  assert.equal(pages.length, 2);
  const [older, newest] = pages;
  const review = older.find((message) => message.id === "toolu_review");
  assert.equal(review.status, "completed");
  assert.equal(review.subagent.status, "completed");
  assert.match(review.text, /^## Parser review/);
  assert.equal(older.find((message) => message.id === "toolu_styles").status, "running");
  assert.equal(older.find((message) => message.id === "toolu_broken").status, "failed");
  assert.equal(
    newest.some((message) => /Parser review|agent-message|npm test/.test(message.text)),
    false,
  );
  assert.deepEqual([...older, ...newest], normalizeClaude(records).messages);
});

test("a single indexed page keeps completion records out of visible rows", async (t) => {
  const records = background();
  const [page] = await indexed(t, records);
  assert.deepEqual(page, normalizeClaude(records).messages);
  assert.equal(page.find((message) => message.id === "toolu_review").status, "completed");
});

test("a TaskStop on a newer page ends the background agent shown on an older page", async (t) => {
  const records = [...background(), ...filler(60), ...taskStop("agentstyles02")];
  const pages = await indexed(t, records);
  const styles = pages[0].find((message) => message.id === "toolu_styles");
  assert.equal(styles.status, "unknown");
  assert.deepEqual(pages.flat(), normalizeClaude(records).messages);
});

test("block-shaped notifications on a newer page still complete their agent", async (t) => {
  const note = notification("toolu_styles", "agentstyles02", "completed");
  note.message.content = [{ type: "text", text: note.message.content }];
  const records = [...background(), ...filler(60), note];
  const pages = await indexed(t, records);
  const styles = pages[0].find((message) => message.id === "toolu_styles");
  assert.equal(styles.status, "completed");
  assert.deepEqual(pages.flat(), normalizeClaude(records).messages);
});

test("an append before the index catches up keeps the indexed subagent state", async (t) => {
  const f = await claudeHistoryFixture(t);
  // The Agent launches sit far before the provisional tail of the newest page.
  await f.write([...background(), ...filler(120)]);
  await f.history.readPage(f.session, "native");
  await f.indexed();
  const states = (page) =>
    Object.fromEntries(
      page.observability.subagents.map((agent) => [agent.id, agent.status]),
    );
  const ready = await f.history.readPage(f.session, "native");
  assert.equal(ready.observability.stale, false);
  assert.equal(states(ready).agentstyles02, "running");
  for (let round = 0; round < 3; round++) {
    // Each source change is read before the background index has seen it.
    const more = filler(2).map((record) => ({
      ...record,
      uuid: `${round}${record.uuid}`,
    }));
    await f.append(more);
    const page = await f.history.readPage(f.session, "native");
    assert.equal(page.observability.stale, false);
    assert.deepEqual(states(page), states(ready));
    assert.deepEqual(page.tasks, ready.tasks);
    await f.indexed();
  }
});
