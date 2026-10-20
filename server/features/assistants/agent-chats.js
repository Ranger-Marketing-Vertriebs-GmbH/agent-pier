import { randomUUID } from "node:crypto";
import { problem } from "../../lib/storage.js";
import { serverMessages } from "../../lib/i18n/de.js";
import { assistantProblem } from "./assistant-validation.js";
import { createGatewaySession } from "./session-create.js";
import { mainConversation } from "./routine-targets.js";
import { assertChatPerson, openMainConversation } from "./conversation-open.js";
import { firstTurnTitle, setTitle } from "./chat-titles.js";

/**
 * Several chats per agent (AGENTPIER-181). Each chat is one AgentPier conversation
 * with its own native session from `sessions.create`; New chat never resets or
 * replaces a session (OpenClaw's `/new` and `sessions.reset` keep the key). The
 * person's main chat stays the one reminders, routines, check-ins and Telegram
 * deliver into (routine-targets.js). Archive and title state live in AgentPier.
 */

const chatErrors = Object.freeze({
  CHAT_ARCHIVED: ["chatArchived", 409],
  CHAT_MAIN: ["chatMain", 409],
  CHAT_BUSY: ["chatBusy", 409],
  CHAT_COMMAND: ["chatCommand", 400],
  CHAT_CONFIRM: ["chatConfirm", 400],
});

/** A refusal of a chat action with its stable code. */
export function chatProblem(code) {
  const [key, status] = chatErrors[code];
  return Object.assign(problem(serverMessages.assistants[key], status), { key, code });
}

/** Whether a turn runs, a message waits or team work reports into the conversation. */
export function chatBusy(service, conversationId, pending = busyChats(service)) {
  return pending.has(conversationId) || !!service.queued?.get(conversationId);
}

const teamEnded = new Set(["completed", "failed", "cancelled", "declined"]);

/**
 * Whether a team or lead request started from a chat still has to report into it: a
 * team whose members work or whose result is not yet sent, a request not yet
 * delivered (team-results.js, lead-requests.js). Sent results are ledger turns.
 */
function teamWorking(service, team) {
  if (!teamEnded.has(team.phase)) return true;
  if (service.teams.store.members(team.id).some((m) => !teamEnded.has(m.phase)))
    return true;
  return (
    !!team.resultBatch &&
    !team.resultAttemptId &&
    !["skipped", "unsent"].includes(team.resultState)
  );
}

// The conversations a team or lead request it started reports into later.
function teamChats(service, ids) {
  const teams = service.teams;
  if (!teams?.store) return;
  for (const team of teams.store.list())
    if (team.parentConversationId && teamWorking(service, team))
      ids.add(team.parentConversationId);
  for (const request of teams.requests?.store.pending() || [])
    if (request.parentConversationId && !request.resultAttemptId)
      ids.add(request.parentConversationId);
}

// The conversations with a turn under way, an approval waiting or team work open.
function busyChats(service) {
  const ids = new Set(
    (service.workflows?.store.awaiting?.() || []).map((a) => a.conversationId),
  );
  for (const attempt of service.ledger.pending()) {
    try {
      ids.add(service.ledger.getRequest(attempt.requestId).conversationId);
    } catch {
      /* A request that went away meanwhile. */
    }
  }
  teamChats(service, ids);
  return ids;
}

const person = (conversation) =>
  typeof conversation.userId === "string" ? conversation.userId : null;
const activity = (conversation) => conversation.lastActivityAt || conversation.createdAt;

/** A chat as a chat list shows it; `owner` also names whose chat it is. */
export function chatSummary(conversation, { busy = false, owner = false } = {}) {
  return {
    id: conversation.id,
    title: conversation.title ?? null,
    main: conversation.main === true,
    archivedAt: conversation.archivedAt ?? null,
    lastActivityAt: activity(conversation),
    busy,
    ...(owner && { userId: person(conversation) }),
  };
}

export class AgentChats {
  constructor(service) {
    this.service = service;
  }
  /**
   * A new chat of one person (the owner's without `userId`): its own native session,
   * labelled with the pre-generated conversation id, so labels stay unique. A person
   * without chats gets the main chat first.
   */
  create(assistantId, { userId = null } = {}) {
    const service = this.service;
    return service.admit(async () => {
      const agent = service.store.getAssistant(assistantId);
      assertChatPerson(agent, userId);
      // A team member's chat is its team's; it gets no further chats.
      if (agent.teamMemberId) throw assistantProblem("invalid");
      if (agent.archivedAt) throw assistantProblem("active", 409);
      if (!mainConversation(service.store, assistantId, userId))
        return openMainConversation(service, assistantId, { turn: true, userId });
      service.requireReady();
      await service.config.apply(assistantId);
      const id = randomUUID();
      const client = service.runtime.client;
      const created = await createGatewaySession(
        client,
        { agentId: agent.runtimeAgentId, label: `AgentPier ${agent.id} chat ${id}` },
        service.sessionCreate,
      );
      if (!created.key) throw assistantProblem("unavailable", 503);
      const conversation = service.store.saveConversation({
        id,
        assistantId,
        runtimeSessionKey: created.key,
        ...(userId === null ? {} : { userId }),
      });
      await client.call("sessions.messages.subscribe", { key: created.key });
      service.changed();
      return conversation;
    });
  }
  /**
   * One person's chats with the agent, the main chat first, then the most recently
   * active. `archived` lists the archived ones instead. With `view` (the owner's
   * list) it lists every person's chats as `view(conversation)` shows them, leaving
   * out those it returns null for (assistant-chats.js).
   */
  list(assistantId, { userId = null, archived = false, view = null } = {}) {
    const service = this.service;
    const store = service.store;
    let chats = store
      .listConversations()
      .filter(
        (c) =>
          c.assistantId === assistantId &&
          c.channel === "agentpier" &&
          !c.userReleased &&
          !!c.archivedAt === archived &&
          (view || person(c) === userId),
      );
    // A chat stored before several chats existed becomes its person's main on read.
    for (const owner of new Set(chats.map(person))) {
      const main = mainConversation(store, assistantId, owner);
      const index = chats.findIndex((c) => c.id === main?.id);
      if (index >= 0) chats[index] = main;
    }
    if (view) chats = chats.map(view).filter(Boolean);
    const pending = busyChats(service);
    return chats
      .sort(
        (a, b) =>
          (b.main === true) - (a.main === true) ||
          String(activity(b)).localeCompare(String(activity(a))),
      )
      .map((c) =>
        chatSummary(c, { busy: chatBusy(service, c.id, pending), owner: !!view }),
      );
  }
  /**
   * Renames a chat: a set title, or with "" its automatic one again. An archived
   * chat is read-only.
   */
  rename(conversationId, value, options = {}) {
    const service = this.service;
    const conversation = service.store.getConversation(conversationId);
    if (conversation.archivedAt) throw chatProblem("CHAT_ARCHIVED");
    const title = setTitle(value);
    const auto = title ? null : firstTurnTitle(service, conversationId);
    service.store.updateConversation(
      conversationId,
      title
        ? { title, titleSource: "set" }
        : { title: auto, titleSource: auto ? "auto" : null },
    );
    service.changed({ conversationId });
    return this.summary(conversationId, options);
  }
  /** The summary of one conversation now. */
  summary(conversationId, options = {}) {
    return chatSummary(this.service.store.getConversation(conversationId), {
      busy: chatBusy(this.service, conversationId),
      ...options,
    });
  }
}
