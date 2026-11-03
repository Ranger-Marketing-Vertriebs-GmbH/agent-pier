import { randomUUID } from "node:crypto";
import { assistantProblem } from "./assistant-validation.js";
import { exact } from "./assistant-access.js";
import { decideAudited } from "./approval-audit.js";
import { archiveEntries } from "./memory-archive.js";
import { modelName } from "./model-switch.js";
import { mainConversation } from "./routine-targets.js";

/**
 * The owner's card after a model switch's memory review (memory-review.js): the entries
 * that only record an earlier model's refusals or self-set limits, grouped by agent,
 * one card per switch. Per entry the owner chooses Archive (the default) or Keep and
 * applies; until then nothing changes. Only the owner sees and decides it: never a
 * lead (no team tool or status names it), never a user of a shared agent (her app has
 * no route to it), never for a user's own agent, whose memory the owner does not
 * change. A later switch of the same agents replaces its card; a decided card is gone. Private
 * (operations/private-tables.js) and removed with its agents (agent-deletion.js).
 */
export const memoryReviewsTable =
  "CREATE TABLE IF NOT EXISTS assistant_memory_reviews (id TEXT PRIMARY KEY, body TEXT NOT NULL)";

export class MemoryReviews {
  constructor(db, now = () => new Date().toISOString()) {
    Object.assign(this, { db, now });
    db.exec(memoryReviewsTable);
  }
  /** Every stored review, oldest first. */
  list() {
    return this.db
      .prepare("SELECT body FROM assistant_memory_reviews ORDER BY rowid")
      .all()
      .map((row) => JSON.parse(row.body));
  }
  get(id) {
    const row =
      typeof id === "string"
        ? this.db.prepare("SELECT body FROM assistant_memory_reviews WHERE id=?").get(id)
        : null;
    return row ? JSON.parse(row.body) : null;
  }
  save(body) {
    this.db
      .prepare(
        "INSERT INTO assistant_memory_reviews VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
      )
      .run(body.id, JSON.stringify(body));
    return body;
  }
  remove(id) {
    this.db.prepare("DELETE FROM assistant_memory_reviews WHERE id=?").run(id);
  }
}

// One store per database, made on first use (the service has no room for it).
const stores = new WeakMap();
export function memoryReviewsOf(service) {
  const db = service.store.db;
  if (!stores.has(db)) stores.set(db, new MemoryReviews(db));
  return stores.get(db);
}

const agentOf = (service, id) => {
  try {
    return service.store.getAssistant(id);
  } catch {
    return null;
  }
};
// The owner decides on his own agents and shared ones, not on a user's own agent.
const ownersToDecide = (agent) =>
  Boolean(agent) && !agent.archivedAt && agent.userAccess?.mode !== "own";
// The agent whose chat the card shows in: the agent, or for a member its lead.
const chatAgentOf = (service, id) => {
  const agent = agentOf(service, id);
  return agent?.parentAssistantId && agentOf(service, agent.parentAssistantId)
    ? agent.parentAssistantId
    : id;
};
// A failed review: one push notice that the memory could not be reviewed, linking to
// the agent's memory page. The switch itself stays.
async function noticeFailed(service, assistantId) {
  const notifications = service.workflows?.s?.notifications;
  await notifications
    ?.notify({
      kind: "agent-memory-review-failed",
      eventId: `memory-review-failed-${randomUUID()}`,
      assistantId,
      label: agentOf(service, assistantId)?.name || "",
    })
    .catch((error) => console.error("Memory review notice failed:", error?.code));
}

/**
 * The results of one switch's reviews (memory-review.js startMemoryReviews): agents
 * whose review found entries get one card together, which replaces an undecided card
 * of the same agents; a review that found none drops them from such a card too. A
 * failed review sends the owner a notice and leaves an older card as it is.
 */
export async function recordReviews(service, plan, reviews) {
  const store = memoryReviewsOf(service);
  const owned = reviews.filter((r) => ownersToDecide(agentOf(service, r.assistantId)));
  const found = owned
    .map((r) => ({
      assistantId: r.assistantId,
      entries:
        r.status === "found" ? r.entries.filter((e) => e.kind === "model-limit") : [],
    }))
    .filter((r) => r.entries.length);
  const replaced = new Set(
    owned.filter((r) => r.status !== "failed").map((r) => r.assistantId),
  );
  for (const old of store.list()) {
    const agents = old.agents.filter((a) => !replaced.has(a.assistantId));
    if (agents.length === old.agents.length) continue;
    if (agents.length) store.save({ ...old, agents, revision: old.revision + 1 });
    else store.remove(old.id);
  }
  if (found.length) {
    let n = 0;
    const chatAgentId = chatAgentOf(service, plan.agents[0]);
    store.save({
      id: randomUUID(),
      switchId: randomUUID(),
      createdAt: store.now(),
      switch: {
        from: await modelName(service, plan.from),
        to: await modelName(service, plan.to),
      },
      chatAgentId,
      conversationId: mainConversation(service.store, chatAgentId, null)?.id ?? null,
      agents: found.map(({ assistantId, entries }) => ({
        assistantId,
        entries: entries.map(({ file, entry, kind, recommendation }) => ({
          id: `e${++n}`,
          file,
          entry,
          kind,
          recommendation,
        })),
      })),
      revision: 1,
    });
  }
  for (const r of owned.filter((r) => r.status === "failed"))
    await noticeFailed(service, r.assistantId);
  service.changed?.();
}

// The review as the owner's card shows it: its agents that still exist, with their
// names, and the chat it shows in now (the owner's current main chat of that agent,
// which a deferred swap may have replaced since). Null when no agent is left.
function project(service, review) {
  const agents = review.agents
    .map((a) => ({ ...a, agent: agentOf(service, a.assistantId) }))
    .filter((a) => ownersToDecide(a.agent))
    .map(({ agent, ...a }) => ({ ...a, name: agent.name }));
  if (!agents.length) return null;
  let conversationId = review.conversationId;
  try {
    conversationId =
      mainConversation(service.store, review.chatAgentId, null)?.id ?? conversationId;
  } catch {
    /* The stored chat stays. */
  }
  return {
    id: review.id,
    createdAt: review.createdAt,
    switch: review.switch,
    assistantId: review.chatAgentId,
    assistantName: agentOf(service, review.chatAgentId)?.name || "",
    conversationId,
    agents,
    revision: review.revision,
  };
}

/** The undecided cards, oldest first: `{ reviews: [...] }`. */
export function memoryReviews(service) {
  return {
    reviews: memoryReviewsOf(service)
      .list()
      .map((r) => project(service, r))
      .filter(Boolean),
  };
}

// Only one decision of a review at a time.
const deciding = new Set();

function checkedChoices(review, input) {
  exact(input, ["revision", "choices"]);
  if (!Number.isSafeInteger(input.revision)) throw assistantProblem("invalid");
  const choices = input.choices;
  const ids = review.agents.flatMap((a) => a.entries.map((e) => e.id));
  if (
    !choices ||
    typeof choices !== "object" ||
    Array.isArray(choices) ||
    Object.keys(choices).length !== ids.length ||
    !ids.every((id) => ["archive", "keep"].includes(choices[id]))
  )
    throw assistantProblem("invalid");
  return choices;
}

/**
 * Applies the owner's choices (`{ revision, choices: { [entryId]: "archive" | "keep"
 * } }`, every entry named) to review `id`: per agent the entries to archive go to the
 * archive (memory-archive.js archiveEntries). Returns `{ archived, kept, changed }`
 * as counts; `changed` are entries left in place because their file changed. The
 * decided card is gone (its entries are in the archive or the memory). An agent
 * whose archive failed stays on the card, the error is thrown and the owner applies
 * again. Audited as `assistant.answered` (kind "memory-review"), counts only. Takes no
 * admission itself (archiveEntries takes it per file).
 */
export function decideReview(service, id, input, origin) {
  const store = memoryReviewsOf(service);
  // Read before the decision: a decided card is gone when the audit names its agent.
  const chatAgentId = store.get(id)?.chatAgentId;
  return decideAudited(
    service.audit,
    {
      origin,
      actionId: id,
      decision: "apply",
      revision: input?.revision,
      kind: "memory-review",
      assistantId: () => chatAgentId,
    },
    async () => {
      const review = store.get(id);
      // The agents the card shows: one archived or deleted since is left out.
      const shown = review && project(service, review);
      if (!shown) throw assistantProblem("notFound", 404);
      const choices = checkedChoices(shown, input);
      if (input.revision !== review.revision || deciding.has(id))
        throw assistantProblem("conflict", 409);
      deciding.add(id);
      const result = { archived: 0, kept: 0, changed: 0 };
      const left = [...shown.agents];
      try {
        while (left.length) {
          const { assistantId, entries } = left[0];
          const chosen = entries.filter((e) => choices[e.id] === "archive");
          result.kept += entries.length - chosen.length;
          if (chosen.length) {
            const done = await archiveEntries(
              service,
              assistantId,
              chosen.map(({ file, entry }) => ({ file, entry })),
              { switch: review.switch, reviewId: review.id },
            );
            result.archived += done.archived;
            result.changed += chosen.length - done.archived;
          }
          left.shift();
        }
        // Decided: its entries are in the archive or stay in memory; the audit log
        // keeps how it ended (inbox-history.js).
        store.remove(id);
        return result;
      } catch (error) {
        // What was archived stays archived; the agents not done stay on the card, as
        // far as the card still holds them (a newer switch may have shrunk or replaced
        // it meanwhile; a card gone is not made again).
        const current = store.get(id);
        if (current && left.length < shown.agents.length) {
          const open = new Set(left.map((a) => a.assistantId));
          const agents = current.agents.filter((a) => open.has(a.assistantId));
          if (agents.length)
            store.save({ ...current, agents, revision: current.revision + 1 });
          else store.remove(id);
        }
        throw error;
      } finally {
        deciding.delete(id);
        service.changed?.();
      }
    },
  );
}
