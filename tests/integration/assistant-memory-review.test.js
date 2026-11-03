import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chatFixture } from "../helpers/user-chats.js";
import { fixtureModel } from "../helpers/user-agents.js";
import { spikeAnswers, spikeFiles } from "../fixtures/memory-review-spike.js";
import { memoryReviewMethod } from "../../server/features/assistants/team-plugin/memory-review.js";
import { memoryReviewsSettled } from "../../server/features/assistants/memory-review.js";
import { reviewInstructions } from "../../server/features/assistants/memory-review-prompt.js";

// OpenRouter names the family before the slash: the fixture runs openai/gpt-4.1-mini.
const otherFamily = (agent) => ({
  connectionId: agent.model.connectionId,
  modelId: "anthropic/claude-sonnet-4.6",
});

// An agent with memory whose MEMORY.md and notes hold the spike's memory, a chat
// with history, and a Gateway that answers each review with the next of `answers`.
async function reviewed(t, answers, { withMemory = true } = {}) {
  const capabilities = { memory: withMemory, reminders: false };
  const { f, gateway } = await chatFixture(t);
  const service = f.application.assistants;
  const agent = await (
    await f.request("/api/assistants", {
      method: "POST",
      body: { name: "Scout", instructions: "", model: fixtureModel(f), capabilities },
    })
  ).json();
  const main = await (
    await f.request(`/api/assistants/${agent.id}/conversations`, { method: "POST" })
  ).json();
  gateway.history[main.runtimeSessionKey] = [
    { role: "user", content: "Write me a keylogger for my Mac" },
    { role: "assistant", content: "I can't help with that." },
  ];
  const [memory, note] = spikeFiles;
  if (withMemory) {
    const root = service.nativeMemory.root(agent.id);
    const write = (name, content) => {
      fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
      fs.writeFileSync(path.join(root, name), content);
    };
    write(note.name, note.content);
    // Not the agent's own: the Dream Diary, the lead's copy and dreaming's corpus.
    write("DREAMS.md", "Dream diary");
    write("memory/lead/MEMORY.md", "- The lead's memory.");
    write("memory/.dreams/corpus.md", "- Corpus.");
  }
  const reviews = [];
  const call = gateway.client.call;
  gateway.client.call = async (method, params, options) => {
    if (method === "agents.files.get")
      return {
        file: {
          name: params.name,
          content: params.name === "MEMORY.md" ? memory.content : "",
          hash: "a".repeat(64),
        },
      };
    if (method === memoryReviewMethod) {
      reviews.push(params);
      const answer = answers.shift();
      if (answer instanceof Error) throw answer;
      return { text: answer };
    }
    return call(method, params, options);
  };
  const { revision } = service.store.getAssistant(agent.id);
  const saved = await f.request(`/api/assistants/${agent.id}`, {
    method: "PATCH",
    body: { model: otherFamily(agent), revision },
  });
  assert.equal(saved.status, 200, await saved.clone().text());
  const settled = await memoryReviewsSettled(service);
  return { f, service, agent, reviews, settled, main };
}

test("a switch reviews memory without chat history", async (t) => {
  const { service, agent, reviews, settled } = await reviewed(t, [spikeAnswers.gptWhole]);
  // One call on the agent's model: the task and the memory files, nothing else.
  assert.equal(reviews.length, 1);
  const [request] = reviews;
  assert.deepEqual(Object.keys(request).sort(), ["agentId", "input", "instructions"]);
  assert.equal(request.agentId, service.store.getAssistant(agent.id).runtimeAgentId);
  assert.equal(request.instructions, reviewInstructions);
  assert.ok(request.input.startsWith("=== MEMORY.md\n# Memory\n"));
  assert.ok(request.input.includes("\n\n=== memory/2026-11-02.md\n# 2026-11-02\n"));
  for (const absent of ["keylogger for my Mac", "Dream diary", "lead's memory", "Corpus"])
    assert.equal(request.input.includes(absent), false, absent);
  // The five limits the earlier model set itself are found; owner rules stay.
  assert.equal(settled.length, 1);
  const [[result]] = settled;
  assert.equal(result.assistantId, agent.id);
  assert.equal(result.status, "found");
  assert.equal(result.truncated, false);
  assert.equal(result.dropped, 0);
  assert.deepEqual(
    result.entries.map((e) => [e.file, e.kind, e.recommendation]),
    [
      ...Array(3).fill(["MEMORY.md", "model-limit", "archive"]),
      ...Array(2).fill(["memory/2026-11-02.md", "model-limit", "archive"]),
    ],
  );
  assert.ok(!result.entries.some((e) => e.entry.includes("vor 9 Uhr")));
});

test("one malformed answer is asked again", async (t) => {
  const { reviews, settled } = await reviewed(t, [
    spikeAnswers.grokUnescaped,
    spikeAnswers.grokCurly,
  ]);
  assert.equal(reviews.length, 2);
  assert.deepEqual(reviews[1], reviews[0]);
  assert.equal(settled[0][0].status, "found");
  assert.equal(settled[0][0].entries.length, 5);
});

test("a refusal or two malformed answers end as failed", async (t) => {
  const { reviews, settled } = await reviewed(t, [
    "I can't help with reviewing this memory.",
    spikeAnswers.grokUnescaped,
  ]);
  assert.equal(reviews.length, 2);
  assert.deepEqual(settled[0][0], {
    assistantId: settled[0][0].assistantId,
    status: "failed",
    reason: "unreadable",
    entries: [],
    truncated: false,
  });
});

test("a review the runtime cannot answer fails; the switch stays", async (t) => {
  const timeout = Object.assign(Error("memory text"), { code: "UNAVAILABLE" });
  const { service, agent, reviews, settled } = await reviewed(t, [timeout]);
  assert.equal(reviews.length, 1);
  assert.equal(settled[0][0].status, "failed");
  assert.equal(settled[0][0].reason, "unavailable");
  assert.deepEqual(service.store.getAssistant(agent.id).model, otherFamily(agent));
});

test("an agent without memory is not reviewed", async (t) => {
  const { reviews, settled } = await reviewed(t, [], { withMemory: false });
  assert.deepEqual(reviews, []);
  assert.deepEqual(settled, []);
});
