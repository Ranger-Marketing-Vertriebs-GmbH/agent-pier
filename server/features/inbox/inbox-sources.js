import {
  actionItem,
  chatLink,
  gateItem,
  requestItem,
  teamItem,
  unresolvedItem,
} from "./inbox-items.js";
import { escalationKey } from "../assistants/coding-sessions/session-requests.js";

// The escalation of a session prompt (coding-sessions/session-escalations.js) while
// it waits, with its agent's name and note, or null. A lookup that fails is null, so
// the request still shows.
function escalationOf(assistants, entry) {
  let a;
  try {
    a = assistants?.workflows?.store.byKey(escalationKey(entry.sessionId, entry.id));
  } catch {
    return null;
  }
  if (a?.state !== "awaiting_approval") return null;
  let name = "";
  try {
    name = assistants.store.getAssistant(a.assistantId).name;
  } catch {}
  return { agentId: a.assistantId, agentName: name, note: a.payload.note ?? null };
}

// Agent work that has not moved for this long is listed as unresolved.
export const unresolvedAfterMs = 24 * 60 * 60000;
const actionBusy = new Set(["approved", "executing", "unknown", "running"]);
const segment = (value) => encodeURIComponent(String(value));

/**
 * Agent work that stopped moving for a day: Telegram inputs still open, chat turns of
 * unknown outcome nobody reviewed and agent actions without progress. They would block
 * an OpenClaw update; listed here they are found before it. A user's own chats and
 * channel belong to that user alone, never the owner.
 */
function unresolvedSources({ services, assistants, agents, conversations, users, now }) {
  const old = (time) => {
    const at = typeof time === "number" ? time : Date.parse(time);
    return Number.isFinite(at) && now - at > unresolvedAfterMs;
  };
  const agent = (id) => ({ id, name: agents.get(id)?.name || "" });
  return {
    channels: () => {
      const c = services.assistantChannels;
      return (
        (c?.store.list() || [])
          // A user's channel sends to that user's own chat (owner-privacy.js).
          .filter((ch) => !users.has(ch.conversationId))
          .flatMap((ch) =>
            c.ledger
              .active(ch.id)
              .filter((entry) => old(entry.createdAt))
              .map((entry) =>
                unresolvedItem({
                  kind: "channel_input",
                  id: entry.id,
                  state: entry.state,
                  agent: agent(ch.assistantId),
                  since: entry.createdAt,
                  link: `/agents/${segment(ch.assistantId)}/settings?tab=channels&page=telegram-activity`,
                }),
              ),
          )
      );
    },
    attempts: () =>
      (assistants.ledger?.unresolved() || [])
        .filter(
          (a) =>
            ["uncertain", "interrupted"].includes(a.state) &&
            !a.reviewedAt &&
            old(a.createdAt),
        )
        .flatMap((attempt) => {
          const { conversationId } = assistants.ledger.getRequest(attempt.requestId);
          const chat = conversations.find((c) => c.id === conversationId);
          if (!chat || users.has(chat.id)) return [];
          return [
            unresolvedItem({
              kind: "chat_attempt",
              id: attempt.id,
              state: attempt.state,
              agent: agent(chat.assistantId),
              since: attempt.createdAt,
              link: chatLink(chat.assistantId, chat.id, conversations),
            }),
          ];
        }),
    actions: () =>
      (assistants.workflows?.store.list() || [])
        .filter(
          (a) =>
            actionBusy.has(a.state) &&
            !users.has(a.conversationId) &&
            old(a.updatedAt ?? a.createdAt),
        )
        .map((a) =>
          unresolvedItem({
            kind: "stalled_action",
            id: a.id,
            state: a.state,
            agent: agent(a.assistantId),
            since: a.updatedAt ?? a.createdAt,
            link: chatLink(a.assistantId, a.conversationId, conversations),
          }),
        ),
  };
}

// Reads every place a decision can wait, without changing any of them. A source that
// fails to read is reported and left out, so the others still show.
export async function collectItems(
  services,
  { now = Date.now(), onError = () => {} } = {},
) {
  const items = [];
  const read = async (name, collect) => {
    try {
      items.push(...(await collect()));
    } catch (error) {
      onError(name, error);
    }
  };
  await read("requests", async () => {
    if (!services.requests?.listAll) return [];
    const running = new Map(
      (await services.sessions.list())
        .filter((s) => s.status === "running")
        .map((s) => [s.id, s]),
    );
    // A stopped session's requests are discarded on its next read; never shown.
    return services.requests
      .listAll()
      .filter((entry) => running.has(entry.sessionId))
      .map((entry) =>
        requestItem(
          entry,
          running.get(entry.sessionId),
          escalationOf(services.assistants, entry),
        ),
      );
  });
  await read("pipelines", () =>
    (services.pipelines?.store?.withStatus("awaiting-human") || [])
      .filter((run) => run.status === "awaiting-human" && !run.imported?.historyOnly)
      .map(gateItem),
  );
  const assistants = services.assistants;
  if (!assistants || assistants.closed) return items;
  let agents = new Map(),
    conversations = [];
  await read("agents", () => {
    agents = new Map(assistants.store.listAssistants().map((a) => [a.id, a]));
    conversations = assistants.store.listConversations();
    return [];
  });
  // A user's approvals go to her alone (approval-audience.js), never to the owner.
  const users = new Set(
    conversations.filter((c) => typeof c.userId === "string").map((c) => c.id),
  );
  await read("actions", () =>
    (assistants.workflows?.store.awaiting(now) || [])
      // An escalated session prompt shows as the request itself (above), once.
      .filter(
        (a) => !users.has(a.conversationId) && a.payload?.action !== "session_request",
      )
      .map((a) => actionItem(a, agents, conversations)),
  );
  await read("teams", () =>
    (assistants.teams?.store.list() || [])
      .filter((t) => t.phase === "awaiting_approval" && !t.archivedAt)
      .map((t) => teamItem(t, agents, conversations)),
  );
  const stale = unresolvedSources({
    services,
    assistants,
    agents,
    conversations,
    users,
    now,
  });
  await read("unresolved channel inputs", stale.channels);
  await read("unresolved chat turns", stale.attempts);
  await read("unresolved agent actions", stale.actions);
  return items;
}
