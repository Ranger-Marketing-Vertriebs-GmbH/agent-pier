import { actionItem, gateItem, requestItem, teamItem } from "./inbox-items.js";
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
  return items;
}
