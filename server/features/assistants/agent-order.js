import { assistantProblem } from "./assistant-validation.js";

// Each person's own order of the root agents in her agent list: the owner's
// (`owner`) and each restricted user's (`user:<id>`), so the list looks the same on
// every device. A person's order never changes another's. Agents without a stored
// position follow the positioned ones in their usual order, so a new agent comes
// last. Archived agents keep their position for a restore; a permanent delete drops
// it (foreign key cascade), a deleted user's order goes with her (user-release.js).
export const OWNER_ORDER = "owner";
export const userOrder = (userId) => `user:${userId}`;
// More ids than any real list holds; a larger body is refused.
const MAX_IDS = 2000;

/**
 * `stored` with the agents `ids` names in their new order: an agent `ids` leaves out
 * (an archived one) keeps its slot, the named ones fill the other slots in order.
 */
export function mergeOrder(stored, ids) {
  const named = new Set(ids);
  const result = [];
  let next = 0;
  for (const id of stored) {
    if (!named.has(id)) result.push(id);
    else if (next < ids.length) result.push(ids[next++]);
  }
  return [...result, ...ids.slice(next)];
}

/** `items` (with `id`) sorted by `order`; the rest keep their order after them. */
export function sortByOrder(items, order) {
  const rank = new Map(order.map((id, index) => [id, index]));
  const at = (item) => rank.get(item.id) ?? Infinity;
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => at(a.item) - at(b.item) || a.index - b.index)
    .map(({ item }) => item);
}

export class AgentOrder {
  constructor(store) {
    this.db = store.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_order (
        person TEXT NOT NULL,
        assistant_id TEXT NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        PRIMARY KEY (person, assistant_id)
      );
    `);
  }
  /** The person's stored order, as agent ids. */
  of(person) {
    return this.db
      .prepare(
        "SELECT assistant_id FROM agent_order WHERE person=? ORDER BY position, assistant_id",
      )
      .all(person)
      .map((row) => row.assistant_id);
  }
  /** `agents` in the person's order. */
  sort(person, agents) {
    return sortByOrder(agents, this.of(person));
  }
  /**
   * Stores `ids` as the person's order of the agents she sees. `visible(id)` says
   * whether she may order that agent; any other id refuses the whole write as unknown.
   */
  save(person, ids, visible) {
    if (
      !Array.isArray(ids) ||
      ids.length > MAX_IDS ||
      ids.some((id) => typeof id !== "string" || !id) ||
      new Set(ids).size !== ids.length
    )
      throw assistantProblem("invalid");
    if (!ids.every((id) => visible(id))) throw assistantProblem("notFound", 404);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const order = mergeOrder(this.of(person), ids);
      this.db.prepare("DELETE FROM agent_order WHERE person=?").run(person);
      const insert = this.db.prepare("INSERT INTO agent_order VALUES (?, ?, ?)");
      order.forEach((id, index) => insert.run(person, id, index));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { ids: this.of(person) };
  }
  forget(person) {
    this.db.prepare("DELETE FROM agent_order WHERE person=?").run(person);
  }
}
