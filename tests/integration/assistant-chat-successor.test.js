import test from "node:test";
import assert from "node:assert/strict";
import { chatFixture, holdBackgroundPasses } from "../helpers/user-chats.js";
import { fixtureModel } from "../helpers/user-agents.js";
import { freshMainChat } from "../../server/features/assistants/main-chat-swap.js";
import {
  redirectedTo,
  successorOf,
} from "../../server/features/assistants/chat-successor.js";
import { mainConversation } from "../../server/features/assistants/routine-targets.js";

const switched = { reason: "model-switched", details: { from: "Old", to: "New" } };

// The owner's agent with its main chat; the background passes stand still, so the
// test drives every delivery itself.
async function agentWithMain(t) {
  const { f, gateway } = await chatFixture(t);
  holdBackgroundPasses(f);
  const service = f.application.assistants;
  const agent = await (
    await f.request("/api/assistants", {
      method: "POST",
      body: { name: "Lead", instructions: "", model: fixtureModel(f) },
    })
  ).json();
  const main = await (
    await f.request(`/api/assistants/${agent.id}/conversations`, { method: "POST" })
  ).json();
  return { f, gateway, service, agent, main };
}

// The swap a model switch runs (Task 4a), or Restart main chat's without options.
const swapMain = (service, id, options) =>
  service.admit(() =>
    freshMainChat(service, service.store.getConversation(id), undefined, options),
  );
const modelSwitch = (service, id) =>
  swapMain(service, id, { ...switched, successor: true });

const notes = (service, id) =>
  service.memoryNotes.forConversation(id).map((n) => n.reason);
const sentTo = (gateway, service, id) =>
  gateway.sent.filter(
    (s) => s.key === service.store.getConversation(id).runtimeSessionKey,
  );

function completedRequest(s, fields) {
  return s.service.teams.store.insert({
    kind: "lead-request",
    revision: 1,
    type: "question",
    parentAssistantId: s.agent.id,
    parentConversationId: s.main.id,
    parentRequestId: null,
    parentAttemptId: null,
    leadName: "Lead",
    memberId: "member-x",
    memberAssistantId: "member-agent-x",
    memberName: "Scout",
    ownerProof: null,
    writeAllowed: false,
    delivery: null,
    text: "What did you find?",
    answer: "The answer",
    phase: "completed",
    createdAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    ...fields,
  });
}

test("a model switch records the successor; a restart records none", async (t) => {
  const { service, main, agent } = await agentWithMain(t);
  const fresh = await modelSwitch(service, main.id);
  assert.equal(service.store.storedConversation(main.id).successorId, fresh.id);
  assert.equal(fresh.main, true);
  assert.deepEqual(notes(service, fresh.id), ["model-switched"]);
  const restarted = await swapMain(service, fresh.id);
  assert.equal(service.store.storedConversation(fresh.id).successorId, undefined);
  assert.deepEqual(notes(service, restarted.id), ["main-restarted"]);
  assert.equal(mainConversation(service.store, agent.id).id, restarted.id);
  // The line ends at the restarted chat, which has no successor: nothing follows.
  assert.equal(redirectedTo(service.store, main.id), null);
  assert.equal(successorOf(service.store, main.id).id, main.id);
});

test("a fresh chat keeps the old chat's main flag when asked to", async (t) => {
  const { service, main } = await agentWithMain(t);
  const fresh = await swapMain(service, main.id, {
    ...switched,
    successor: true,
    main: false,
  });
  assert.equal(fresh.main, undefined);
  assert.equal(service.store.storedConversation(main.id).successorId, fresh.id);
});

test("a member result after a switch lands in the fresh main chat with a redirected note", async (t) => {
  const s = await agentWithMain(t);
  const { service, gateway, agent, main } = s;
  service.teams.store.insert({
    id: "team-1",
    kind: "team",
    revision: 1,
    parentAssistantId: agent.id,
    parentConversationId: main.id,
    objective: "Research",
    phase: "completed",
    resultState: "queued",
    resultBatch: [
      { memberId: "m1", name: "Scout", role: "Research", phase: "completed", text: "Hi" },
    ],
  });
  const fresh = await modelSwitch(service, main.id);
  await service.teams.scheduler.results.dispatch("team-1");
  const team = service.teams.store.get("team-1");
  assert.notEqual(team.resultState, "skipped");
  const [request] = service.ledger.requests(fresh.id);
  assert.equal(request.clientRequestId, "team-result:team-1");
  assert.equal(team.resultAttemptId, service.ledger.attemptFor(request.id).id);
  assert.deepEqual(service.ledger.requests(main.id), []);
  assert.equal(sentTo(gateway, service, fresh.id).length, 1);
  assert.deepEqual(notes(service, fresh.id), ["model-switched", "redirected"]);
});

test("a lead-request answer follows the successor", async (t) => {
  const s = await agentWithMain(t);
  const { service, gateway, main } = s;
  completedRequest(s, { id: "req-1" });
  const fresh = await modelSwitch(service, main.id);
  await service.teams.requests.deliver("req-1");
  const r = service.teams.requests.store.get("req-1");
  assert.equal(r.delivery, "sent");
  const [request] = service.ledger.requests(fresh.id);
  assert.equal(request.clientRequestId, "lead-request-result:req-1");
  assert.equal(r.resultAttemptId, service.ledger.attemptFor(request.id).id);
  assert.equal(sentTo(gateway, service, fresh.id).length, 1);
  assert.deepEqual(notes(service, fresh.id), ["model-switched", "redirected"]);
});

test("an SSH follow-up follows the successor", async (t) => {
  const { service, gateway, main } = await agentWithMain(t);
  const fresh = await modelSwitch(service, main.id);
  const input = { clientRequestId: "ssh-result:a1", text: "SSH result" };
  const context = { kind: "ssh-result", actionId: "a1" };
  const sent = await service.send(main.id, input, context);
  assert.equal(sent.request.conversationId, fresh.id);
  // A retry adopts the accepted turn: no second send and no second note.
  for (const a of service.ledger.pending()) service.ledger.transition(a.id, "completed");
  const again = await service.send(main.id, input, context);
  assert.equal(again.request.id, sent.request.id);
  assert.equal(sentTo(gateway, service, fresh.id).length, 1);
  assert.deepEqual(notes(service, fresh.id), ["model-switched", "redirected"]);
});

test("the owner's message from a stale view follows the successor without a note", async (t) => {
  const { service, gateway, main } = await agentWithMain(t);
  const fresh = await modelSwitch(service, main.id);
  const sent = await service.send(main.id, { clientRequestId: "owner-1", text: "Hi" });
  assert.equal(sent.request.conversationId, fresh.id);
  assert.equal(sentTo(gateway, service, fresh.id).length, 1);
  assert.deepEqual(notes(service, fresh.id), ["model-switched"]);
  // A goal turn is AgentPier's own delivery, sent as the owner: it keeps the note.
  for (const a of service.ledger.pending()) service.ledger.transition(a.id, "completed");
  const goal = { id: "g1", anchorRequestId: sent.request.id, title: "Goal" };
  await service.send(
    main.id,
    { clientRequestId: "goal-1", text: "Go on" },
    { kind: "owner", goal },
  );
  assert.deepEqual(notes(service, fresh.id), ["model-switched", "redirected"]);
});

test("a follow-up accepted in the old chat before the switch is not sent again", async (t) => {
  const { service, gateway, main } = await agentWithMain(t);
  const input = { clientRequestId: "ssh-result:a2", text: "SSH result" };
  const context = { kind: "ssh-result", actionId: "a2" };
  const first = await service.send(main.id, input, context);
  for (const a of service.ledger.pending()) service.ledger.transition(a.id, "completed");
  const fresh = await modelSwitch(service, main.id);
  const again = await service.send(main.id, input, context);
  assert.equal(again.request.id, first.request.id);
  assert.equal(sentTo(gateway, service, fresh.id).length, 0);
  assert.deepEqual(notes(service, fresh.id), ["model-switched"]);
});

test("two switches in a row deliver to the newest chat", async (t) => {
  const { service, gateway, main } = await agentWithMain(t);
  const second = await modelSwitch(service, main.id);
  const third = await modelSwitch(service, second.id);
  assert.equal(successorOf(service.store, main.id).id, third.id);
  const sent = await service.send(
    main.id,
    { clientRequestId: "ssh-result:a3", text: "SSH result" },
    { kind: "ssh-result", actionId: "a3" },
  );
  assert.equal(sent.request.conversationId, third.id);
  assert.equal(sentTo(gateway, service, third.id).length, 1);
  assert.deepEqual(service.ledger.requests(second.id), []);
});

test("a successor line that loops or runs too long ends at the input chat", async (t) => {
  const { service, main } = await agentWithMain(t);
  const store = service.store;
  const at = new Date().toISOString();
  const chats = Array.from({ length: 22 }, (_, n) =>
    store.saveConversation({
      assistantId: main.assistantId,
      runtimeSessionKey: `line-${n}`,
    }),
  );
  chats.forEach((c, n) =>
    store.updateConversation(c.id, {
      archivedAt: n < 21 ? at : null,
      successorId: chats[n + 1]?.id,
    }),
  );
  // 21 hops to the live chat: beyond the bound.
  assert.equal(successorOf(store, chats[0].id).id, chats[0].id);
  assert.equal(redirectedTo(store, chats[0].id), null);
  assert.equal(successorOf(store, chats[1].id).id, chats[21].id);
  store.updateConversation(chats[3].id, { successorId: chats[2].id });
  assert.equal(successorOf(store, chats[2].id).id, chats[2].id);
});

test("restart main chat still drops late follow-ups", async (t) => {
  const s = await agentWithMain(t);
  const { service, gateway, main } = s;
  completedRequest(s, { id: "req-2" });
  const fresh = await swapMain(service, main.id);
  await assert.rejects(
    service.send(
      main.id,
      { clientRequestId: "ssh-result:a4", text: "SSH result" },
      { kind: "ssh-result", actionId: "a4" },
    ),
    { code: "CHAT_ARCHIVED" },
  );
  await service.teams.requests.deliver("req-2");
  // Refused as archived (409): no follow-up reaches the fresh chat.
  const r = service.teams.requests.store.get("req-2");
  assert.notEqual(r.delivery, "sent");
  assert.equal(r.deliveryFailures, 1);
  assert.deepEqual(service.ledger.requests(fresh.id), []);
  assert.equal(sentTo(gateway, service, fresh.id).length, 0);
  assert.deepEqual(notes(service, fresh.id), ["main-restarted"]);
});

test("lead request reply reads the chat its run ran in", async (t) => {
  const { service, main } = await agentWithMain(t);
  const member = service.teams.store.insert({
    id: "member-r",
    kind: "member",
    revision: 1,
    conversationId: main.id,
  });
  const request = service.ledger.accept(main.id, { clientRequestId: "r1", text: "Go" });
  const attempt = service.ledger.recordAttempt(request.id);
  const fresh = await modelSwitch(service, main.id);
  service.teams.store.write(service.teams.store.member(member.id), {
    conversationId: fresh.id,
  });
  const read = [];
  t.mock.method(service, "history", async (id) => {
    read.push(id);
    return { stale: false, messages: [] };
  });
  await service.teams.requests.reply({ memberId: member.id }, attempt);
  assert.deepEqual(read, [main.id]);
});

test("a peer's answer follows the asking member's successor chat", async (t) => {
  const { service, main } = await agentWithMain(t);
  const peers = service.teams.peers;
  t.mock.method(peers, "reachable", () => true);
  const r = {
    id: "peer-1",
    fromMemberId: "member-a",
    fromConversationId: main.id,
    resultTo: "sender",
    type: "question",
    phase: "completed",
    fromName: "Asker",
    memberName: "Target",
  };
  assert.equal(peers.target(r).conversationId, main.id);
  assert.equal(peers.target(r).redirectedFrom, undefined);
  const fresh = await modelSwitch(service, main.id);
  const target = peers.target(r);
  assert.equal(target.conversationId, fresh.id);
  assert.equal(target.redirectedFrom, main.id);
});

const allRequests = (service, ids, clientRequestId) =>
  ids.flatMap((id) =>
    service.ledger.requests(id).filter((r) => r.clientRequestId === clientRequestId),
  );
const endTurns = (service) => {
  for (const a of service.ledger.pending()) service.ledger.transition(a.id, "completed");
};

test("a lead-request result accepted before a second switch is delivered once", async (t) => {
  const s = await agentWithMain(t);
  const { service, gateway, main } = s;
  completedRequest(s, { id: "req-3" });
  const second = await modelSwitch(service, main.id);
  await service.teams.requests.deliver("req-3");
  assert.equal(service.ledger.requests(second.id).length, 1);
  // The process stopped before the delivery's bookkeeping was written.
  const r = service.teams.requests.store.get("req-3");
  service.teams.store.write(r, {
    delivery: "pending",
    resultAttemptId: undefined,
    resultState: undefined,
  });
  endTurns(service);
  const third = await modelSwitch(service, second.id);
  await service.teams.requests.deliver("req-3");
  const ids = [main.id, second.id, third.id];
  const [accepted, ...more] = allRequests(service, ids, "lead-request-result:req-3");
  assert.deepEqual(more, []);
  assert.equal(accepted.conversationId, second.id);
  const after = service.teams.requests.store.get("req-3");
  assert.equal(after.delivery, "sent");
  assert.equal(after.resultAttemptId, service.ledger.attemptFor(accepted.id).id);
  assert.equal(sentTo(gateway, service, third.id).length, 0);
  assert.equal(sentTo(gateway, service, second.id).length, 1);
  assert.deepEqual(notes(service, third.id), ["model-switched"]);
});

test("a follow-up accepted before a second switch is adopted, not sent again", async (t) => {
  const { service, gateway, main } = await agentWithMain(t);
  const input = { clientRequestId: "ssh-result:a5", text: "SSH result" };
  const context = { kind: "ssh-result", actionId: "a5" };
  const second = await modelSwitch(service, main.id);
  const first = await service.send(main.id, input, context);
  assert.equal(first.request.conversationId, second.id);
  endTurns(service);
  const third = await modelSwitch(service, second.id);
  const again = await service.send(main.id, input, context);
  assert.equal(again.request.id, first.request.id);
  assert.equal(
    allRequests(service, [main.id, second.id, third.id], input.clientRequestId).length,
    1,
  );
  assert.equal(sentTo(gateway, service, third.id).length, 0);
  assert.deepEqual(notes(service, third.id), ["model-switched"]);
});
