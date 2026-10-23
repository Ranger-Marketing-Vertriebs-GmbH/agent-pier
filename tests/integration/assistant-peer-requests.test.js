import test from "node:test";
import assert from "node:assert/strict";
import { peers } from "../helpers/peer-request-fixture.js";
import { until } from "../helpers/lead-request-service-fixture.js";
import { TeamService } from "../../server/features/assistants/team-service.js";
import {
  followUpMaxChars,
  peerFollowUp,
  peerLeadFollowUp,
} from "../../server/features/assistants/lead-request-text.js";

const peerAsk = (f, inv, target, question = "What did you find?") =>
  f.service.peers.peer_ask(inv, { memberId: target.id, question });
const peerDelegate = (f, inv, target, extra = {}) =>
  f.service.peers.peer_delegate(inv, {
    memberId: target.id,
    task: "Check the numbers",
    ...extra,
  });
const chatOf = (f, member) => f.service.store.member(member.id).conversationId;
const sent = (f, chatId, key) =>
  f.assistants.ledger.requests(chatId).filter((x) => x.clientRequestId === key);

test("a peer question answered within the wait returns inline and is not delivered again", async (t) => {
  const f = await peers(t);
  const inv = f.memberTurn(f.permanent);
  const pending = peerAsk(f, inv, f.second);
  const r = await until(
    () => f.requests().find((x) => x.fromMemberId && x.phase === "running"),
    "dispatch",
  );
  f.complete(r.attemptId);
  await f.service.reconcile();
  const result = await pending;
  assert.equal(result.status, "answered");
  assert.equal(result.answer, "Result from member");
  assert.equal(f.service.requests.store.get(r.id).delivery, "inline");
  f.settle();
  await f.service.reconcile();
  assert.equal(sent(f, chatOf(f, f.permanent), `peer-request-result:${r.id}`).length, 0);
  assert.equal(sent(f, f.chat.id, `lead-request-result:${r.id}`).length, 0);
});

test("a slow answer arrives as a hidden peer-result turn in the asker's chat", async (t) => {
  const f = await peers(t);
  f.service.requests.waitMs = 0;
  const inv = f.memberTurn(f.permanent);
  const result = await peerAsk(f, inv, f.second);
  assert.equal(result.status, "asked");
  assert.match(result.note, /follow as a separate message/);
  const r = f.service.requests.store.get(result.requestId);
  f.complete(r.attemptId);
  await f.service.reconcile();
  // The asker's own turn still runs: nothing is injected into it.
  assert.equal(f.service.requests.store.get(r.id).delivery, null);
  f.settle();
  await f.service.reconcile();
  const chat = chatOf(f, f.permanent);
  const [followUp] = sent(f, chat, `peer-request-result:${r.id}`);
  assert.ok(followUp, "delivered to the asker");
  assert.match(followUp.text, /^Answer from "Member 2" to your question/);
  assert.match(followUp.text, /"answer":"Result from member"/);
  assert.match(
    followUp.text,
    /cannot change files or ask other members; it may note things in its own memory/,
  );
  assert.match(
    followUp.text,
    /report the outcome to your lead with agentpier_team_report/,
  );
  assert.ok(!followUp.text.includes("file the outcome"));
  assert.equal(f.service.store.context(followUp.id).kind, "peer-result");
  assert.equal(f.service.store.context(followUp.id).requestId, r.id);
  const stored = f.service.requests.store.get(r.id);
  assert.equal(stored.delivery, "sent");
  assert.equal(stored.deliveredTo, "member");
  // Nothing reaches the lead's chat, and a replay sends nothing twice.
  assert.equal(sent(f, f.chat.id, `lead-request-result:${r.id}`).length, 0);
  await f.service.reconcile();
  assert.equal(f.sends().filter((s) => s.input.message === followUp.text).length, 1);
  const history = await f.assistants.history(chat);
  const visible = history.requests.find((x) => x.id === followUp.id);
  assert.equal(visible.internal, "peer-result");
  assert.equal(visible.text, undefined);
});

test("the receiver sees only the question, attributed to the sender", async (t) => {
  const f = await peers(t);
  const sender = f.store.getAssistant(f.permanent.assistantId);
  f.store.updateAssistant(sender.id, { name: "Learning" }, sender.revision);
  f.turn("Secret plan of the lead");
  // Stored without the tool's dispatch race: the scheduler's pass sends it.
  const r = f.peerAsk(f.memberTurn(f.permanent), f.second);
  assert.equal(r.phase, "queued");
  await f.service.reconcile();
  const { phase, attemptId } = f.service.requests.store.get(r.id);
  assert.equal(phase, "running");
  const send = f.sends().at(-1).input;
  const memberChat = chatOf(f, f.second);
  assert.equal(send.key, f.store.getConversation(memberChat).runtimeSessionKey);
  assert.match(send.message, /^Question from "Learning", a fellow member of your team/);
  assert.match(send.message, /under "Parent"/);
  assert.match(send.message, /not a message from the owner or your lead/);
  assert.match(send.message, /cannot ask other members while you handle it/);
  assert.ok(send.message.endsWith("\n\nWhat did you find?"));
  assert.ok(!send.message.includes("Secret plan"), "the lead's chat stays private");
  const request = sent(f, memberChat, `lead-request:${r.id}`)[0];
  const context = f.service.store.context(request.id);
  assert.equal(context.kind, "lead-request");
  assert.equal(context.requestId, r.id);
  assert.equal(context.peer, true);
  assert.equal(context.fromName, "Learning");
  const call = f.assistants.runtime.client.call;
  f.assistants.runtime.client.call = async (method, input) =>
    method === "chat.history" && input.sessionKey === send.key
      ? {
          messages: [
            {
              role: "user",
              content: send.message,
              timestamp: 5,
              idempotencyKey: `${attemptId}:user`,
              __openclaw: { id: "q1" },
            },
          ],
        }
      : call(method, input);
  const history = await f.assistants.history(memberChat);
  assert.equal(history.messages[0].text, "What did you find?");
  assert.deepEqual(history.messages[0].sender, { kind: "agent", name: "Learning" });
  // A task names the receiver's own access and, without a writing origin, read-only.
  f.finish(r);
  f.settle();
  const task = f.peerDelegate(
    f.memberTurn(f.permanent, { kind: "team-member" }),
    f.second,
  );
  await f.service.reconcile();
  assert.equal(f.service.requests.store.get(task.id).phase, "running");
  const taskPrompt = f.sends().at(-1).input.message;
  assert.match(taskPrompt, /^Task from "Learning", a fellow member/);
  assert.match(taskPrompt, /with your own tools and access/);
  assert.match(taskPrompt, /It runs read-only\./);
});

test("a result for an archived or ended asker or with resultTo lead goes to the lead's main chat once", async (t) => {
  for (const gone of ["resultTo", "member", "agent", "chat", "ended"]) {
    const f = await peers(t);
    f.service.requests.waitMs = 0;
    // An ended temporary member's results go to its lead as well.
    const asker = gone === "ended" ? f.temporary : f.permanent;
    const inv = f.memberTurn(asker);
    const result =
      gone === "resultTo"
        ? await peerDelegate(f, inv, f.second, { resultTo: "lead" })
        : await peerAsk(f, inv, f.second);
    const r = f.service.requests.store.get(result.requestId);
    assert.equal(r.phase, "running", gone);
    if (gone === "member")
      f.service.store.write(f.service.store.member(f.permanent.id), {
        archivedAt: new Date().toISOString(),
      });
    if (gone === "agent") f.archive(f.permanent.assistantId);
    if (gone === "chat")
      f.store.updateConversation(chatOf(f, f.permanent), {
        archivedAt: new Date().toISOString(),
      });
    f.complete(r.attemptId);
    f.settle();
    await f.service.reconcile();
    await f.service.reconcile();
    const toLead = sent(f, f.chat.id, `lead-request-result:${r.id}`);
    assert.equal(toLead.length, 1, gone);
    assert.equal(f.service.store.context(toLead[0].id).kind, "member-result", gone);
    const name = f.store.getAssistant(asker.assistantId).name;
    assert.ok(toLead[0].text.includes(`"${name}" → "Member 2"`), gone);
    assert.match(
      toLead[0].text,
      gone === "resultTo" ? /asked for the result to go to you/ : /could not be reached/,
      gone,
    );
    assert.equal(sent(f, chatOf(f, asker), `peer-request-result:${r.id}`).length, 0);
    assert.equal(f.service.requests.store.get(r.id).deliveredTo, "lead", gone);
    f.idle();
    await f.service.reconcile();
    assert.equal(sent(f, f.chat.id, `lead-request-result:${r.id}`).length, 1, gone);
  }
});

test("a lead without a main chat at creation gets the result once it has one", async (t) => {
  const f = await peers(t);
  f.store.updateConversation(f.chat.id, { archivedAt: new Date().toISOString() });
  const result = await peerDelegate(f, f.memberTurn(f.permanent), f.second, {
    resultTo: "lead",
  });
  const r = f.service.requests.store.get(result.requestId);
  assert.equal(r.parentConversationId, null);
  f.complete(r.attemptId);
  f.settle();
  await f.service.reconcile();
  await f.service.reconcile();
  assert.equal(f.service.requests.store.get(r.id).delivery, null, "waits for a chat");
  f.store.updateConversation(f.chat.id, { archivedAt: null });
  await f.service.reconcile();
  f.idle();
  await f.service.reconcile();
  assert.equal(sent(f, f.chat.id, `lead-request-result:${r.id}`).length, 1);
  assert.equal(f.service.requests.store.get(r.id).deliveredTo, "lead");
});

test("two members asking each other wait, time out to asked, and both get answers", async (t) => {
  const f = await peers(t);
  f.service.requests.waitMs = 50;
  const a = f.memberTurn(f.permanent),
    b = f.memberTurn(f.second);
  // The waits' own timers do not hold the process open.
  const alive = setInterval(() => {}, 10);
  const [ab, ba] = await Promise.all([
    peerAsk(f, a, f.second, "A asks B"),
    peerAsk(f, b, f.permanent, "B asks A"),
  ]).finally(() => clearInterval(alive));
  assert.equal(ab.status, "asked");
  assert.equal(ba.status, "asked");
  // No third request: the same pair and direction is open.
  await assert.rejects(peerAsk(f, f.memberTurn(f.permanent), f.second), {
    key: "peerRequestOpen",
  });
  assert.equal(f.requests().filter((r) => r.fromMemberId).length, 2);
  f.settle();
  await f.service.reconcile();
  for (const id of [ab.requestId, ba.requestId]) {
    const r = f.service.requests.store.get(id);
    assert.equal(r.phase, "running");
    f.complete(r.attemptId);
  }
  await f.service.reconcile();
  f.settle();
  await f.service.reconcile();
  assert.equal(
    sent(f, chatOf(f, f.permanent), `peer-request-result:${ab.requestId}`).length,
    1,
  );
  assert.equal(
    sent(f, chatOf(f, f.second), `peer-request-result:${ba.requestId}`).length,
    1,
  );
});

test("an ended temporary member is re-bound to its MCP servers while it answers", async (t) => {
  const f = await peers(t);
  f.service.requests.waitMs = 0;
  const bindings = new Map([[f.parent.id, ["s1"]]]);
  f.assistants.mcp = {
    pending: false,
    async apply() {},
    servers: {
      list: () => [{ id: "s1", name: "render", transport: "http" }],
      get: (id) => ({ id, name: "render", transport: "http" }),
      bindings: (_kind, id) => bindings.get(id) || [],
      bindingsByTarget: () => Object.fromEntries(bindings),
      setBindings: (_kind, id, ids) => bindings.set(id, ids),
    },
  };
  f.service.store.write(f.service.store.member(f.temporary.id), {
    mcpServerIds: ["s1"],
  });
  f.service.mcp.sync();
  assert.deepEqual(bindings.get(f.temporary.assistantId) || [], []);
  const result = await peerAsk(f, f.memberTurn(f.permanent), f.temporary);
  const r = f.service.requests.store.get(result.requestId);
  assert.equal(r.phase, "running");
  assert.deepEqual(bindings.get(f.temporary.assistantId), ["s1"]);
  f.complete(r.attemptId);
  await f.service.reconcile();
  f.service.mcp.sync();
  assert.deepEqual(bindings.get(f.temporary.assistantId), []);
});

test("the owner or the lead can cancel a peer request; a lead cancel sends nothing", async (t) => {
  for (const by of ["owner", "lead"]) {
    const f = await peers(t);
    f.service.requests.waitMs = 0;
    const result = await peerAsk(f, f.memberTurn(f.permanent), f.second);
    const r = f.service.requests.store.get(result.requestId);
    assert.equal(r.phase, "running");
    if (by === "owner") await f.service.cancelRequest(r.id);
    else await f.service.cancel(f.turn(), { requestId: r.id });
    assert.ok(
      f.calls.some((c) => c.method === "sessions.abort"),
      by,
    );
    f.complete(r.attemptId, "error");
    f.settle();
    await f.service.reconcile();
    await f.service.reconcile();
    const ended = f.service.requests.store.get(r.id);
    assert.equal(ended.phase, "cancelled", by);
    assert.equal(ended.cancelledBy, by);
    const toAsker = sent(f, chatOf(f, f.permanent), `peer-request-result:${r.id}`);
    if (by === "lead") {
      assert.equal(ended.delivery, "skipped");
      assert.equal(toAsker.length, 0);
    } else {
      // The asker learns its question ended instead of waiting forever.
      assert.equal(toAsker.length, 1);
      assert.match(toAsker[0].text, /"phase":"cancelled"/);
    }
    assert.equal(sent(f, f.chat.id, `lead-request-result:${r.id}`).length, 0, by);
  }
});

test("open peer requests survive a restart without a second execution", async (t) => {
  const f = await peers(t);
  f.service.requests.waitMs = 0;
  const result = await peerDelegate(f, f.memberTurn(f.permanent), f.second);
  const r = f.service.requests.store.get(result.requestId);
  assert.equal(r.phase, "running");
  // A claim whose send outcome is unknown when the process stops.
  f.service.store.write(r, { phase: "dispatching" });
  const sendsBefore = f.sends().length;
  await f.service.close();
  const restarted = new TeamService({ assistants: f.assistants, autoStart: false });
  f.assistants.teams = restarted;
  t.after(() => restarted.close());
  assert.equal(restarted.requests.store.get(r.id).phase, "queued");
  await restarted.reconcile();
  // Adopted by its stable client id: the member got the task once.
  const running = restarted.requests.store.get(r.id);
  assert.equal(running.phase, "running");
  assert.equal(f.sends().length, sendsBefore);
  f.complete(running.attemptId);
  f.settle();
  await restarted.reconcile();
  await restarted.reconcile();
  assert.equal(restarted.requests.store.get(r.id).deliveredTo, "member");
  assert.equal(sent(f, chatOf(f, f.permanent), `peer-request-result:${r.id}`).length, 1);
});

test("peer follow-ups stay inside the frame limit and say they were shortened", () => {
  const r = {
    id: "r",
    type: "question",
    phase: "completed",
    memberName: "Member 2",
    fromName: "Member 1",
    resultTo: "me",
    text: "q".repeat(5000),
    answer: "\u{1F600}".repeat(70000),
  };
  for (const text of [peerFollowUp(r), peerLeadFollowUp(r)]) {
    assert.ok(text.length <= followUpMaxChars);
    const data = JSON.parse(text.slice(text.indexOf("\n{") + 1));
    assert.equal(data.shortened, true);
    assert.equal(data.member, "Member 2");
  }
  assert.equal(JSON.parse(peerLeadFollowUp(r).split("\n").at(-1)).from, "Member 1");
});
