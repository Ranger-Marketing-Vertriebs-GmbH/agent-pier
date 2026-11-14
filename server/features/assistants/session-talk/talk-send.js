// An agent writes to, or reads, a coding session it did not start but may talk to
// (agentpier_coding_session send and read on a granted session, talk-reach.js). The
// text reaches the session through ChatDelivery like the agent's own sends, starting
// with the agent's header, so the session knows who wrote and how to answer. Without
// reach the session answers NOT_FOUND, as an unknown one; sends count against the
// pair's talk budget, are logged in the chat that sent them and audited.
import { assistantProblem } from "../assistant-validation.js";
import { mainConversation } from "../routine-targets.js";
import { sessionScope } from "../../chat/chat-delivery.js";
import { confirmedDelivery, isHookBlock } from "../../chat/chat-delivery-blocked.js";
import {
  activity,
  checkSend,
  readOptions,
  readReplies,
  sendDeliveryId,
} from "../coding-sessions/session-steering.js";
import { noteLimit, talkBudgetRefusal } from "./talk-budget.js";
import { sessionProjectId, talkAgent, talkVia } from "./talk-reach.js";
import { agentHeader, quotedName } from "./talk-text.js";

const notFound = () => assistantProblem("notFound", 404);
const deliveryStatuses = new Set([
  "pending",
  "handed-off",
  "accepted",
  "rejected",
  "uncertain",
]);

/** The session as the agent may reach it through talk: `{ session, via, agent }`. */
async function reach(w, assistantId, sessionId) {
  if (typeof sessionId !== "string") throw notFound();
  let session;
  try {
    session = await w.s.sessions.get(sessionId);
  } catch (error) {
    if (error?.status === 404) throw notFound();
    throw error;
  }
  const via = session ? talkVia(w, assistantId, session) : null;
  const agent = via ? talkAgent(w, assistantId) : null;
  if (!agent) throw notFound();
  return { session, via, agent };
}

// What the session reads: the header, the agent's text and who to answer with which
// tools; without a live agentpier_session capability the session has none of them.
function pasted(w, agent, session, text) {
  const q = quotedName;
  let tools = false;
  try {
    tools = !!w.s.sessionMcp?.grantFor(session.id);
  } catch {
    tools = false;
  }
  const note = tools
    ? `(AgentPier: this message is from the agent ${q(agent.name)}, not from the user. Answer it with agent_tell, or ask with agent_ask, agentId ${JSON.stringify(agent.id)}.)`
    : `(AgentPier: this message is from the agent ${q(agent.name)}, not from the user.)`;
  return `${agentHeader(agent.name)} ${text}\n\n${note}`;
}

function projectName(w, projectId) {
  if (!projectId) return null;
  try {
    return w.s.memory.projects().projects.find((p) => p.id === projectId)?.name ?? null;
  } catch {
    return null;
  }
}

/**
 * send on a granted session: `{ deliveryId, status, reason? }` as sendToSession, at
 * most once per `requestId` (or tool call). TALK_LIMIT (429) over the pair's budget,
 * with one note in the sending chat per window.
 */
export async function talkSend(w, ctx, input, inv) {
  checkSend(input);
  const { session, via, agent } = await reach(w, ctx.assistantId, input.sessionId);
  const talk = w.sessions.talk;
  const deliveryId = sendDeliveryId(ctx, session.id, input, inv);
  const rowId = `send:${deliveryId}`;
  const projectId = sessionProjectId(session);
  const fields = {
    op: "send",
    direction: "to-session",
    assistantId: agent.id,
    agentName: agent.name,
    conversationId: ctx.conversationId ?? null,
    sessionId: session.id,
    sessionCreatedAt: session.createdAt ?? null,
    projectId,
    sessionName: session.name ?? "",
    projectName: projectName(w, projectId),
    tool: session.tool,
    via,
  };
  // A retry of a send already made is the same message: it neither counts again
  // nor is refused.
  const retry = talk.store.get(rowId);
  const refusal = retry
    ? null
    : talkBudgetRefusal(talk.store, {
        sessionId: session.id,
        assistantId: agent.id,
        now: talk.now(),
      });
  if (refusal) {
    const conversationId =
      ctx.conversationId ?? mainConversation(w.a.store, agent.id)?.id ?? null;
    noteLimit(talk.store, { ...fields, conversationId, limit: refusal.limit });
    talk.changed();
    throw Object.assign(assistantProblem("talkLimit", 429, refusal.retryAfterSeconds), {
      retryAfterSeconds: refusal.retryAfterSeconds,
    });
  }
  // The turn may have ended while the session was read: never send for a stale turn.
  inv?.assertCurrent?.();
  const receipt = await confirmedDelivery(
    w.s.chatDelivery,
    session.id,
    await w.s.chatDelivery.send(session.id, {
      deliveryId,
      deliveryScope: sessionScope(session),
      text: pasted(w, agent, session, input.text),
      submit: true,
    }),
  );
  const status = deliveryStatuses.has(receipt?.status) ? receipt.status : "uncertain";
  if (retry) talk.store.patch(rowId, { status });
  else
    talk.store.create({
      ...fields,
      id: rowId,
      ...(typeof input.requestId === "string" ? { requestId: input.requestId } : {}),
      deliveryId,
      text: input.text,
      phase: "sent",
      status,
    });
  talk.changed();
  audit(w, session, fields, {
    deliveryId,
    status: isHookBlock(receipt) ? "hook-blocked" : status,
  });
  return {
    deliveryId,
    status,
    ...(typeof receipt?.reason === "string" ? { reason: receipt.reason } : {}),
  };
}

// Ids and enums only (audit-agent-session-details.js); never the text.
function audit(w, session, fields, { deliveryId, status }) {
  try {
    w.s.audit?.append({
      action: "session.sent",
      resourceType: "session",
      source: "system",
      outcome: ["rejected", "hook-blocked"].includes(status) ? "failure" : "success",
      sessionId: session.id,
      projectId: fields.projectId,
      details: {
        tool: session.tool,
        agentSession: {
          assistantId: fields.assistantId,
          op: "send",
          deliveryId,
          status,
          via: fields.via,
        },
      },
    });
  } catch (error) {
    console.error("Session talk send audit failed:", error?.message);
  }
}

/** read on a granted session: its replies (readReplies) and state; nothing is kept. */
export async function talkRead(w, ctx, input) {
  readOptions(input);
  const { session } = await reach(w, ctx.assistantId, input.sessionId);
  const { replies, cursor } = await readReplies(w, session.id, input);
  return { replies, cursor, state: await activity(w, session) };
}
