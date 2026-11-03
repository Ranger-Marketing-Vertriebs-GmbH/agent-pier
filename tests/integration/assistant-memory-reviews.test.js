import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { as, chatFixture, sharedAgentOfTwo } from "../helpers/user-chats.js";
import { fixtureModel, ownUserAgent } from "../helpers/user-agents.js";
import { switchTeam } from "../helpers/model-switch-team.js";
import { spikeAnswers, spikeFiles } from "../fixtures/memory-review-spike.js";
import { memoryReviewMethod } from "../../server/features/assistants/team-plugin/memory-review.js";
import { memoryReviewsSettled } from "../../server/features/assistants/memory-review.js";
import { memoryArchiveOf } from "../../server/features/assistants/memory-archive.js";
import { mainConversation } from "../../server/features/assistants/routine-targets.js";
import { pushEvent } from "../../server/features/notifications/push-validation.js";
import { pushLink } from "../../server/features/notifications/push-content.js";

const sha = (text) => createHash("sha256").update(text).digest("hex");
const [memory, note] = spikeFiles;
// OpenRouter names the family before the slash: the fixture runs openai/gpt-4.1-mini.
const model = (agent, modelId) => ({ connectionId: agent.model.connectionId, modelId });
const families = ["anthropic/claude-sonnet-4.6", "x-ai/grok-4", "google/gemini-2.5-pro"];
const capabilities = { memory: true, reminders: false };
// Words only the memory entries hold: never in a lead's view or a user's.
const entryText = /Keylogger|Phishing/i;

// A Gateway whose MEMORY.md (per agent) checks hashes as OpenClaw's agents.files.set
// does, and whose memory review answers with the next of `answers`.
function memoryGateway(gateway, answers) {
  const files = new Map();
  const memoryOf = (agentId) => {
    if (!files.has(agentId)) files.set(agentId, memory.content);
    return files.get(agentId);
  };
  const call = gateway.client.call;
  gateway.client.call = async (method, params, options) => {
    if (method === "agents.files.get") {
      const content = params.name === "MEMORY.md" ? memoryOf(params.agentId) : "";
      return { file: { name: params.name, content, hash: sha(content) } };
    }
    if (method === "agents.files.set") {
      if (gateway.failSet?.())
        throw Object.assign(new Error("down"), { code: "UNAVAILABLE" });
      if (params.expectedHash !== sha(memoryOf(params.agentId)))
        throw Object.assign(new Error("changed"), { code: "CONFLICT" });
      files.set(params.agentId, params.content);
      return { ok: true, file: { name: params.name, content: params.content } };
    }
    if (method === memoryReviewMethod) {
      const answer = answers.shift() ?? spikeAnswers.grok;
      return { text: answer };
    }
    return call(method, params, options);
  };
  return { memoryOf };
}

// The day note of the spike in the agent's workspace.
function writeNote(service, assistantId) {
  const root = service.nativeMemory.root(assistantId);
  fs.mkdirSync(path.join(root, "memory"), { recursive: true });
  fs.writeFileSync(path.join(root, note.name), note.content);
  return path.join(root, note.name);
}

async function switchModel(f, service, id, modelId) {
  const agent = service.store.getAssistant(id);
  const saved = await f.request(`/api/assistants/${id}`, {
    method: "PATCH",
    body: { model: model(agent, modelId), revision: agent.revision },
  });
  assert.equal(saved.status, 200, await saved.clone().text());
  return memoryReviewsSettled(service);
}

// The owner's agent with the spike's memory and a main chat, and its Gateway.
async function reviewed(t, answers = []) {
  const { f, gateway } = await chatFixture(t);
  const service = f.application.assistants;
  const agent = await (
    await f.request("/api/assistants", {
      method: "POST",
      body: { name: "Scout", instructions: "", model: fixtureModel(f), capabilities },
    })
  ).json();
  await f.request(`/api/assistants/${agent.id}/conversations`, { method: "POST" });
  const notePath = writeNote(service, agent.id);
  const { memoryOf } = memoryGateway(gateway, answers);
  const runtimeId = service.store.getAssistant(agent.id).runtimeAgentId;
  return {
    f,
    gateway,
    service,
    agent,
    notePath,
    memory: () => memoryOf(runtimeId),
    switchTo: (modelId = families[0]) => switchModel(f, service, agent.id, modelId),
  };
}

const reviewsOf = async (f, request = f.request) => {
  const res = await request("/api/assistant-memory-reviews");
  assert.equal(res.status, 200);
  return (await res.json()).reviews;
};
const decide = (f, review, choices, request = f.request) =>
  request(`/api/assistant-memory-reviews/${review.id}/decision`, {
    method: "POST",
    body: { revision: review.revision, choices },
  });
const all = (review, choice) =>
  Object.fromEntries(review.agents.flatMap((a) => a.entries.map((e) => [e.id, choice])));

test("a review with findings shows one card in the chat and the inbox", async (t) => {
  const { f, service, agent, switchTo } = await reviewed(t);
  await switchTo();
  const [review, ...more] = await reviewsOf(f);
  assert.deepEqual(more, []);
  // In the owner's fresh main chat of the switched agent.
  const main = mainConversation(service.store, agent.id, null);
  assert.equal(review.assistantId, agent.id);
  assert.equal(review.conversationId, main.id);
  assert.deepEqual(review.switch, {
    from: "openai/gpt-4.1-mini",
    to: "anthropic/claude-sonnet-4.6",
  });
  const [entries] = review.agents.map((a) => a.entries);
  assert.equal(review.agents[0].name, "Scout");
  assert.deepEqual(
    entries.map((e) => [e.file, e.kind, e.recommendation]),
    [
      ...Array(3).fill(["MEMORY.md", "model-limit", "archive"]),
      ...Array(2).fill([note.name, "model-limit", "archive"]),
    ],
  );
  assert.ok(
    entries.every(
      (e) => memory.content.includes(e.entry) || note.content.includes(e.entry),
    ),
  );
  // The inbox lists it under Agents, with counts only, opening the chat.
  const inbox = await (await f.request("/api/inbox")).json();
  const items = inbox.items.filter((i) => i.type === "memory-review");
  assert.equal(items.length, 1);
  const [item] = items;
  assert.equal(item.id, review.id);
  assert.equal(item.tab, "agents");
  assert.equal(item.entries, 5);
  assert.equal(item.link, `/agents/${agent.id}/chats/${main.id}`);
  assert.doesNotMatch(JSON.stringify(inbox), entryText);
  assert.equal(inbox.counts.agents, 1);
});

test("Apply archives the chosen entries and keeps the rest", async (t) => {
  const { f, service, agent, notePath, memory: memoryNow, switchTo } = await reviewed(t);
  await switchTo();
  const [review] = await reviewsOf(f);
  const [kept, ...archived] = review.agents[0].entries;
  // Every entry is named, with a known choice, at the card's revision.
  for (const choices of [
    { ...all(review, "archive"), [kept.id]: "maybe" },
    { [kept.id]: "keep" },
    { ...all(review, "archive"), extra: "keep" },
  ])
    assert.equal((await decide(f, review, choices)).status, 400);
  assert.equal(
    (
      await f.request(`/api/assistant-memory-reviews/${review.id}/decision`, {
        method: "POST",
        body: { revision: review.revision + 1, choices: all(review, "archive") },
      })
    ).status,
    409,
  );
  const res = await decide(f, review, { ...all(review, "archive"), [kept.id]: "keep" });
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual(await res.json(), { archived: 4, kept: 1, changed: 0 });
  const remaining = memoryNow() + fs.readFileSync(notePath, "utf8");
  assert.ok(remaining.includes(kept.entry));
  for (const e of archived) assert.equal(remaining.includes(e.entry), false, e.entry);
  const rows = memoryArchiveOf(service).list(agent.id);
  assert.deepEqual(rows.map((r) => r.text).sort(), archived.map((e) => e.entry).sort());
  assert.ok(
    rows.every((r) => r.reviewId === review.id && r.switch.to === review.switch.to),
  );
  // The card is gone; the inbox shows how it ended.
  assert.deepEqual(await reviewsOf(f), []);
  assert.equal((await decide(f, review, all(review, "archive"))).status, 404);
  const status = await (await f.request(`/api/inbox/memory-review/${review.id}`)).json();
  assert.equal(status.state, "done");
  assert.equal(status.decision, "apply");
  // The Apply that succeeded names the agent; the refused ones above failed.
  const answered = service.audit
    .list({ action: "assistant.answered" })
    .events.find((e) => e.outcome === "success");
  assert.equal(answered.details.kind, "memory-review");
  assert.equal(answered.details.actionId, review.id);
  assert.equal(answered.resourceId, agent.id);
  assert.doesNotMatch(JSON.stringify(service.audit.list({}).events), entryText);
});

test("a failed Apply keeps the card for another try", async (t) => {
  const { f, gateway, service, agent, switchTo } = await reviewed(t);
  await switchTo();
  const [review] = await reviewsOf(f);
  let fail = true;
  gateway.failSet = () => fail;
  const res = await decide(f, review, all(review, "archive"));
  assert.ok(res.status >= 500, String(res.status));
  assert.doesNotMatch(await res.text(), entryText);
  // MEMORY.md kept its entries; the card waits as it was.
  const [still] = await reviewsOf(f);
  assert.equal(still.id, review.id);
  assert.equal(still.revision, review.revision);
  fail = false;
  const again = await decide(f, still, all(still, "archive"));
  assert.equal(again.status, 200, await again.clone().text());
  assert.deepEqual(await again.json(), { archived: 5, kept: 0, changed: 0 });
  assert.equal(memoryArchiveOf(service).list(agent.id).length, 5);
});

test("a lead never sees the card", async (t) => {
  const s = await switchTeam(t);
  const { f, service, lead, main, keeper } = s;
  memoryGateway(s.gateway, []);
  const { revision } = service.store.getAssistant(keeper.assistantId);
  service.store.updateAssistant(keeper.assistantId, { capabilities }, revision);
  writeNote(service, keeper.assistantId);
  const turn = service.ledger.recordAttempt(
    service.ledger.accept(main.id, { clientRequestId: "lead-turn", text: "Edit" }).id,
  );
  const result = await service.teams.member_update(
    { attemptId: turn.id, toolCallId: randomUUID(), assertCurrent() {} },
    { memberId: keeper.id, model: model(lead, families[0]), freshChat: true },
  );
  assert.equal(result.memoryReview, "waits_for_owner");
  await memoryReviewsSettled(service);
  // The owner's card, in his main chat of the lead.
  const [review] = await reviewsOf(f);
  assert.equal(review.assistantId, lead.id);
  assert.equal(review.conversationId, main.id);
  assert.deepEqual(
    review.agents.map((a) => a.assistantId),
    [keeper.assistantId],
  );
  // What the lead reads of its team names no entry and no card.
  const leadView = JSON.stringify([result, service.teams.list()]);
  assert.doesNotMatch(leadView, entryText);
  assert.equal(leadView.includes(review.id), false);
  // Nor does its chat: the history route and the requests of the lead's turns.
  const res = await f.request(`/api/assistant-conversations/${main.id}/messages`);
  assert.equal(res.status, 200);
  const history = await res.text();
  assert.ok(history.includes("Edit"), "the lead's own turn is in its history");
  assert.doesNotMatch(history, entryText);
  assert.doesNotMatch(JSON.stringify(service.ledger.requests(main.id)), entryText);
});

test("a user of a shared agent never sees it", async (t) => {
  const { f, gateway } = await chatFixture(t);
  const service = f.application.assistants;
  const { anna, agent } = await sharedAgentOfTwo(f);
  const { revision } = service.store.getAssistant(agent.id);
  service.store.updateAssistant(agent.id, { capabilities }, revision);
  writeNote(service, agent.id);
  memoryGateway(gateway, []);
  await switchModel(f, service, agent.id, families[0]);
  // The owner decides the shared agent's card.
  const [review] = await reviewsOf(f);
  assert.equal(review.agents[0].assistantId, agent.id);
  const request = as(f, anna.cookie);
  for (const res of [
    await request("/api/assistant-memory-reviews"),
    await decide(f, review, all(review, "archive"), request),
    await request("/api/me/inbox"),
  ]) {
    assert.notEqual(res.status, 200);
    assert.doesNotMatch(await res.text(), entryText);
  }
  assert.equal((await reviewsOf(f)).length, 1);
  // A user's own agent is hers: no review runs and no card shows for the owner.
  const own = await ownUserAgent(f, { username: "Cleo", body: { capabilities } });
  writeNote(service, own.agent.id);
  const asked = [];
  const call = gateway.client.call;
  gateway.client.call = (method, ...rest) => {
    asked.push(method);
    return call(method, ...rest);
  };
  assert.deepEqual(await switchModel(f, service, own.agent.id, families[0]), []);
  assert.equal(asked.includes(memoryReviewMethod), false);
  assert.deepEqual(
    (await reviewsOf(f)).map((r) => r.assistantId),
    [agent.id],
  );
});

test("a second switch replaces an undecided card", async (t) => {
  const { f, switchTo } = await reviewed(t);
  await switchTo(families[0]);
  const [first] = await reviewsOf(f);
  await switchTo(families[1]);
  const reviews = await reviewsOf(f);
  assert.equal(reviews.length, 1);
  assert.notEqual(reviews[0].id, first.id);
  assert.equal(reviews[0].switch.to, families[1]);
  assert.equal((await decide(f, first, all(first, "archive"))).status, 404);
});

test("a failed review sends a notice", async (t) => {
  const refusal = "I can't help with reviewing this memory.";
  const { f, service, agent, switchTo } = await reviewed(t, [refusal, refusal]);
  const notices = [];
  const notifications = service.workflows.s.notifications;
  const notify = notifications.notify;
  notifications.notify = async (input) => notices.push(input);
  t.after(() => {
    notifications.notify = notify;
  });
  const [[result]] = await switchTo();
  assert.equal(result.status, "failed");
  assert.deepEqual(await reviewsOf(f), []);
  assert.equal(notices.length, 1);
  const [notice] = notices;
  assert.equal(notice.kind, "agent-memory-review-failed");
  assert.equal(notice.assistantId, agent.id);
  assert.equal(notice.label, "Scout");
  // A valid notice that opens the agent's memory page.
  assert.equal(
    pushLink(pushEvent(notice)),
    `/agents/${agent.id}/settings?tab=capabilities&page=memory`,
  );
});
