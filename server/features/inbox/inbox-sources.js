import { actionItem, gateItem, requestItem, teamItem } from "./inbox-items.js";

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
      .map((entry) => requestItem(entry, running.get(entry.sessionId)));
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
  await read("actions", () =>
    (assistants.workflows?.store.awaiting(now) || []).map((a) =>
      actionItem(a, agents, conversations),
    ),
  );
  await read("teams", () =>
    (assistants.teams?.store.list() || [])
      .filter((t) => t.phase === "awaiting_approval" && !t.archivedAt)
      .map((t) => teamItem(t, agents, conversations)),
  );
  return items;
}
