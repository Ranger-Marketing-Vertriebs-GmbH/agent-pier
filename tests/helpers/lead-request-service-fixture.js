import { setImmediate as tick } from "node:timers/promises";
import { teamFixture } from "./assistant-team-fixture.js";
import { requestCaps } from "../../server/features/assistants/lead-request-store.js";
import { TeamBridge } from "../../server/features/assistants/team-bridge.js";

// The owner's own words for each member of the fixture team.
export const quoteFor = (member) => `ask ${member.name} what the budget is`;
const ownerText =
  "Please ask Member 0 what the budget is, and ask Member 1 what the budget is";
export async function until(read, label = "condition", ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await tick();
  }
  throw Error(`Timed out waiting for ${label}`);
}
// A lead whose team finished: its members can be asked; the second one is permanent.
// `count` adds further members, left temporary (`members` lists them all).
export async function lead(t, { count = 2 } = {}) {
  const f = teamFixture(t);
  // Rate limits have their own tests; flows here run many requests in a moment.
  const saved = requestCaps.perMinute;
  requestCaps.perMinute = 1000;
  t.after(() => (requestCaps.perMinute = saved));
  const { team, parent, chat, attempt } = await f.proposal({ count });
  f.assistants.ledger.transition(attempt.id, "completed");
  await f.service.reconcile();
  for (const m of f.service.store.members(team.id)) f.complete(m.attemptId);
  await f.service.reconcile();
  const synthesis = f.service.store.get(team.id).resultAttemptId;
  if (synthesis) f.complete(synthesis);
  await f.service.reconcile();
  const members = f.service.store.members(team.id);
  const [temporary, second] = members;
  const permanent = await f.service.lifecycle("promote", second.id, second.revision);
  const turn = (text = ownerText, context = { kind: "owner" }) => {
    const request = f.assistants.ledger.accept(chat.id, {
      clientRequestId: crypto.randomUUID(),
      text,
    });
    f.service.store.recordContext(request.id, context);
    const attempt = f.assistants.ledger.recordAttempt(request.id);
    return { attemptId: attempt.id, toolCallId: crypto.randomUUID(), assertCurrent() {} };
  };
  // Ends every turn of the lead's chat, so a follow-up may be delivered.
  const idle = () => {
    for (const a of f.assistants.ledger.pending())
      if (f.assistants.ledger.getRequest(a.requestId).conversationId === chat.id)
        f.assistants.ledger.transition(a.id, "completed");
  };
  const requests = () => f.service.requests.store.list();
  const sends = () => f.calls.filter((c) => c.method === "sessions.send");
  return {
    ...f,
    team,
    parent,
    chat,
    temporary,
    permanent,
    members,
    turn,
    idle,
    requests,
    sends,
  };
}
export const ask = (f, member, inv, extra = {}) =>
  f.service.ask(inv, {
    memberId: member.id,
    question: "What is the budget?",
    ...extra,
  });

// The write gate (Q5): owner-requested or owner-approved tasks may write in the
// member's own workspace during exactly their own run; nothing else from a lead may.
export async function writeGate(t) {
  const f = await lead(t);
  const bridge = new TeamBridge({ assistants: f.assistants, teams: f.service });
  await bridge.start();
  t.after(() => bridge.close());
  const member = f.store.getAssistant(f.permanent.assistantId);
  const memberChat = f.store.getConversation(
    f.service.store.member(f.permanent.id).conversationId,
  );
  const write = (path = "notes/plan.md", who = member, session = memberChat) =>
    bridge.toolPolicy({
      agentId: who.runtimeAgentId,
      sessionKey: session.runtimeSessionKey,
      toolName: "write",
      path,
    }).allow;
  const delegate = (inv, extra) =>
    f.service.delegate(inv, {
      memberId: f.permanent.id,
      task: "Draft the plan",
      ownerRequested: true,
      ownerRequestQuote: quoteFor(f.permanent),
      ...extra,
    });
  return { ...f, bridge, member, memberChat, write, delegate };
}
