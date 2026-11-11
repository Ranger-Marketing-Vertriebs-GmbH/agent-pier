import { randomUUID } from "node:crypto";
import { assistantProblem } from "./assistant-validation.js";

// Owner-managed areas, independent of team groups and runtime configuration. The
// membership key enforces one group per root agent; children follow their lead in
// the view. Archiving retains membership, deleting an agent or group removes it.
export class AgentGroups {
  constructor(store) {
    this.store = store;
    this.db = store.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_groups (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, position INTEGER NOT NULL,
        revision INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_group_members (
        assistant_id TEXT PRIMARY KEY REFERENCES assistants(id) ON DELETE CASCADE,
        group_id TEXT NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS agent_group_members_group ON agent_group_members(group_id);
    `);
  }
  transaction(write) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = write();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  list() {
    const members = this.db.prepare("SELECT * FROM agent_group_members").all();
    return this.db
      .prepare("SELECT * FROM agent_groups ORDER BY position, id")
      .all()
      .map((group) => ({
        ...group,
        assistantIds: members
          .filter((m) => m.group_id === group.id)
          .map((m) => m.assistant_id),
      }));
  }
  get(id, revision) {
    const group =
      typeof id === "string"
        ? this.db.prepare("SELECT * FROM agent_groups WHERE id=?").get(id)
        : null;
    if (!group) throw assistantProblem("memberGroupNotFound", 404);
    if (revision !== undefined && group.revision !== revision)
      throw assistantProblem("conflict", 409);
    return group;
  }
  name(value, exceptId) {
    const name = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
    if (!name || name.includes("\0") || Array.from(name).length > 60)
      throw assistantProblem("memberGroupName");
    if (
      this.list().some(
        (g) => g.id !== exceptId && g.name.toLowerCase() === name.toLowerCase(),
      )
    )
      throw assistantProblem("agentGroupNameTaken", 409);
    return name;
  }
  create(name) {
    return this.transaction(() => {
      const value = this.name(name);
      if (this.list().length >= 100) throw assistantProblem("agentGroupLimit", 409);
      const id = randomUUID();
      this.db
        .prepare(
          "INSERT INTO agent_groups VALUES (?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM agent_groups), 1)",
        )
        .run(id, value);
      return this.get(id);
    });
  }
  rename(id, { name, revision }) {
    return this.transaction(() => {
      this.assertRevision(revision);
      this.get(id, revision);
      this.db
        .prepare("UPDATE agent_groups SET name=?, revision=revision+1 WHERE id=?")
        .run(this.name(name, id), id);
      return this.get(id);
    });
  }
  remove(id, { revision }) {
    return this.transaction(() => {
      this.assertRevision(revision);
      this.get(id, revision);
      this.db.prepare("DELETE FROM agent_groups WHERE id=?").run(id);
      return { id };
    });
  }
  // Swaps neighbours in the current order, never replacing a stale client's list.
  reorder(id, { direction, revision }) {
    return this.transaction(() => {
      this.assertRevision(revision);
      const group = this.get(id, revision);
      if (!["up", "down"].includes(direction)) throw assistantProblem("invalid");
      const groups = this.list(),
        index = groups.findIndex((g) => g.id === id);
      const neighbour = groups[index + (direction === "up" ? -1 : 1)];
      if (neighbour) {
        const update = this.db.prepare(
          "UPDATE agent_groups SET position=?, revision=revision+1 WHERE id=?",
        );
        update.run(neighbour.position, id);
        update.run(group.position, neighbour.id);
      }
      return this.get(id);
    });
  }
  assertRevision(revision) {
    if (!Number.isSafeInteger(revision)) throw assistantProblem("conflict", 409);
  }
  of(id) {
    return (
      this.db
        .prepare("SELECT group_id FROM agent_group_members WHERE assistant_id=?")
        .get(id)?.group_id ?? null
    );
  }
  assign(id, { groupId, previousGroupId }) {
    return this.transaction(() => this.assignInside(id, { groupId, previousGroupId }));
  }
  // Also used in the creation transaction; never await between its writes.
  assignInside(id, { groupId, previousGroupId }) {
    const agent = this.store.storedAssistant(id);
    if (agent.teamMemberId || agent.archivedAt || agent.deletingAt)
      throw assistantProblem("agentGroupRootOnly", 409);
    if (this.of(id) !== previousGroupId) throw assistantProblem("conflict", 409);
    if (groupId !== null) this.get(groupId);
    this.db.prepare("DELETE FROM agent_group_members WHERE assistant_id=?").run(id);
    if (groupId !== null)
      this.db.prepare("INSERT INTO agent_group_members VALUES (?,?)").run(id, groupId);
    return { assistantId: id, groupId };
  }
}
