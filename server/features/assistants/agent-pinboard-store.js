import { randomUUID } from "node:crypto";
import { assistantProblem } from "./assistant-validation.js";

export const PINBOARD_LIMITS = Object.freeze({
  openLists: 50,
  entries: 100,
  title: 120,
  description: 500,
  name: 200,
  note: 200,
});

const maxChangeNames = 3;
const kindColumn = { added: "added", updated: "updated", removed: "removed" };

const listFrom = (row, entries) => ({
  id: row.id,
  assistantId: row.assistant_id,
  title: row.title,
  description: row.description,
  originConversationId: row.origin_conversation_id,
  archivedAt: row.archived_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  entries,
});
const parse = (text) => (text ? JSON.parse(text) : null);
const entryFrom = (row) => ({
  id: row.id,
  listId: row.list_id,
  name: row.name,
  note: row.note,
  root: row.root,
  path: row.path,
  admitConversationId: row.admit_conversation_id,
  position: row.position,
  version: row.version,
  identity: parse(row.identity),
  seenIdentity: parse(row.seen_identity),
  updatedAt: row.updated_at,
});
const json = (value) => (value == null ? null : JSON.stringify(value));

/**
 * An agent's pinboard (agentpier_pinboard): named lists of links to files the agent
 * works on. Entries are links (root + path), never copies. Every method is scoped by the
 * agent; rows go with it (agent-deletion.js agentTables).
 */
export class AgentPinboardStore {
  constructor(db) {
    this.db = db;
    db.exec(
      "CREATE TABLE IF NOT EXISTS agent_pinboard_lists(id TEXT PRIMARY KEY, assistant_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', origin_conversation_id TEXT, archived_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
    );
    db.exec(
      "CREATE INDEX IF NOT EXISTS agent_pinboard_lists_agent ON agent_pinboard_lists(assistant_id)",
    );
    db.exec(
      "CREATE TABLE IF NOT EXISTS agent_pinboard_entries(id TEXT PRIMARY KEY, list_id TEXT NOT NULL, assistant_id TEXT NOT NULL, name TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', root TEXT NOT NULL, path TEXT NOT NULL, admit_conversation_id TEXT, position INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1, identity TEXT, seen_identity TEXT, updated_at TEXT NOT NULL, UNIQUE(list_id, name))",
    );
    db.exec(
      "CREATE INDEX IF NOT EXISTS agent_pinboard_entries_agent ON agent_pinboard_entries(assistant_id)",
    );
    db.exec(
      "CREATE TABLE IF NOT EXISTS agent_pinboard_changes(conversation_id TEXT NOT NULL, request_id TEXT NOT NULL, list_id TEXT NOT NULL, assistant_id TEXT NOT NULL, title TEXT NOT NULL, at TEXT NOT NULL, added INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL DEFAULT 0, removed INTEGER NOT NULL DEFAULT 0, names TEXT NOT NULL DEFAULT '[]', PRIMARY KEY(conversation_id, request_id, list_id))",
    );
  }

  #transaction(work) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  #entries(listId) {
    return this.db
      .prepare("SELECT * FROM agent_pinboard_entries WHERE list_id=? ORDER BY position")
      .all(listId)
      .map(entryFrom);
  }

  #row(assistantId, listId) {
    return this.db
      .prepare("SELECT * FROM agent_pinboard_lists WHERE id=? AND assistant_id=?")
      .get(listId, assistantId);
  }

  #openCount(assistantId) {
    return this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM agent_pinboard_lists WHERE assistant_id=? AND archived_at IS NULL",
      )
      .get(assistantId).n;
  }

  #refuseFullBoard(assistantId) {
    if (this.#openCount(assistantId) >= PINBOARD_LIMITS.openLists)
      throw assistantProblem("pinboardListLimit", 409, PINBOARD_LIMITS.openLists);
  }

  lists(assistantId) {
    return this.db
      .prepare(
        "SELECT * FROM agent_pinboard_lists WHERE assistant_id=? ORDER BY archived_at IS NOT NULL, CASE WHEN archived_at IS NULL THEN updated_at END DESC, archived_at DESC, id",
      )
      .all(assistantId)
      .map((row) => listFrom(row, this.#entries(row.id)));
  }

  listOrNull(assistantId, listId) {
    const row = this.#row(assistantId, listId);
    return row ? listFrom(row, this.#entries(row.id)) : null;
  }

  /** A list's title, or null once it is deleted (the chat cards read only this). */
  listTitle(assistantId, listId) {
    return (
      this.db
        .prepare("SELECT title FROM agent_pinboard_lists WHERE id=? AND assistant_id=?")
        .get(listId, assistantId)?.title ?? null
    );
  }

  getList(assistantId, listId) {
    const list = this.listOrNull(assistantId, listId);
    if (!list) throw assistantProblem("pinboardListNotFound", 404);
    return list;
  }

  createList(assistantId, { title, description = "", originConversationId = null }, now) {
    return this.#transaction(() => {
      this.#refuseFullBoard(assistantId);
      const id = randomUUID();
      this.db
        .prepare(
          "INSERT INTO agent_pinboard_lists(id,assistant_id,title,description,origin_conversation_id,archived_at,created_at,updated_at) VALUES(?,?,?,?,?,NULL,?,?)",
        )
        .run(id, assistantId, title, description, originConversationId, now, now);
      return this.getList(assistantId, id);
    });
  }

  updateList(assistantId, listId, { title, description }, now) {
    const list = this.getList(assistantId, listId);
    this.db
      .prepare(
        "UPDATE agent_pinboard_lists SET title=?, description=?, updated_at=? WHERE id=?",
      )
      .run(title ?? list.title, description ?? list.description, now, listId);
    return this.getList(assistantId, listId);
  }

  setArchived(assistantId, listId, archived, now) {
    return this.#transaction(() => {
      const list = this.getList(assistantId, listId);
      if (!archived && list.archivedAt) this.#refuseFullBoard(assistantId);
      this.db
        .prepare("UPDATE agent_pinboard_lists SET archived_at=?, updated_at=? WHERE id=?")
        .run(archived ? now : null, now, listId);
      return this.getList(assistantId, listId);
    });
  }

  /** Entries go with the list; the change rows stay (they only name the list). */
  deleteList(assistantId, listId) {
    this.#transaction(() => {
      this.getList(assistantId, listId);
      this.db.prepare("DELETE FROM agent_pinboard_entries WHERE list_id=?").run(listId);
      this.db.prepare("DELETE FROM agent_pinboard_lists WHERE id=?").run(listId);
    });
  }

  /**
   * Pins a file by name: the same name replaces the entry in place. `reopen` brings an
   * archived list back in the same transaction, so a refused pin leaves it archived.
   */
  pin(
    assistantId,
    listId,
    { name, note, root, path, admitConversationId, identity },
    now,
    { reopen = false } = {},
  ) {
    return this.#transaction(() => {
      const list = this.getList(assistantId, listId);
      if (reopen && list.archivedAt) {
        this.#refuseFullBoard(assistantId);
        this.db
          .prepare("UPDATE agent_pinboard_lists SET archived_at=NULL WHERE id=?")
          .run(listId);
      }
      const existing = this.db
        .prepare("SELECT id FROM agent_pinboard_entries WHERE list_id=? AND name=?")
        .get(listId, name);
      if (existing) {
        this.db
          .prepare(
            "UPDATE agent_pinboard_entries SET note=?, root=?, path=?, admit_conversation_id=?, identity=?, version=version+1, updated_at=? WHERE id=?",
          )
          .run(
            note,
            root,
            path,
            admitConversationId ?? null,
            json(identity),
            now,
            existing.id,
          );
      } else {
        const { n, top } = this.db
          .prepare(
            "SELECT COUNT(*) AS n, COALESCE(MAX(position), -1) AS top FROM agent_pinboard_entries WHERE list_id=?",
          )
          .get(listId);
        if (n >= PINBOARD_LIMITS.entries)
          throw assistantProblem("pinboardEntryLimit", 409, PINBOARD_LIMITS.entries);
        this.db
          .prepare(
            "INSERT INTO agent_pinboard_entries(id,list_id,assistant_id,name,note,root,path,admit_conversation_id,position,version,identity,seen_identity,updated_at) VALUES(?,?,?,?,?,?,?,?,?,1,?,NULL,?)",
          )
          .run(
            randomUUID(),
            listId,
            assistantId,
            name,
            note,
            root,
            path,
            admitConversationId ?? null,
            top + 1,
            json(identity),
            now,
          );
      }
      this.#touch(listId, now);
      const row = this.db
        .prepare("SELECT * FROM agent_pinboard_entries WHERE list_id=? AND name=?")
        .get(listId, name);
      return { entry: entryFrom(row), replaced: !!existing };
    });
  }

  #touch(listId, now) {
    this.db
      .prepare("UPDATE agent_pinboard_lists SET updated_at=? WHERE id=?")
      .run(now, listId);
  }

  unpin(assistantId, listId, { entryId, name }) {
    return this.#transaction(() => {
      this.getList(assistantId, listId);
      if (entryId === undefined && name === undefined)
        throw assistantProblem("pinboardEntryNotFound", 404);
      const row =
        entryId !== undefined
          ? this.db
              .prepare("SELECT * FROM agent_pinboard_entries WHERE list_id=? AND id=?")
              .get(listId, entryId)
          : this.db
              .prepare("SELECT * FROM agent_pinboard_entries WHERE list_id=? AND name=?")
              .get(listId, name);
      if (!row) throw assistantProblem("pinboardEntryNotFound", 404);
      this.db.prepare("DELETE FROM agent_pinboard_entries WHERE id=?").run(row.id);
      return entryFrom(row);
    });
  }

  reorder(assistantId, listId, entryIds) {
    return this.#transaction(() => {
      const list = this.getList(assistantId, listId);
      const known = new Set(list.entries.map((entry) => entry.id));
      if (entryIds.some((id) => !known.has(id)))
        throw assistantProblem("pinboardEntryNotFound", 404);
      const named = [...new Set(entryIds)];
      const order = [
        ...named,
        ...list.entries.map((entry) => entry.id).filter((id) => !named.includes(id)),
      ];
      const update = this.db.prepare(
        "UPDATE agent_pinboard_entries SET position=? WHERE id=?",
      );
      order.forEach((id, position) => update.run(position, id));
      return this.getList(assistantId, listId);
    });
  }

  entry(assistantId, entryId) {
    const row = this.db
      .prepare("SELECT * FROM agent_pinboard_entries WHERE id=? AND assistant_id=?")
      .get(entryId, assistantId);
    if (!row) throw assistantProblem("pinboardEntryNotFound", 404);
    return { ...entryFrom(row), list: this.getList(assistantId, row.list_id) };
  }

  /**
   * Stores the identity a view read, only if nobody changed it meanwhile (`expected` is
   * the JSON text the caller read, or null), so concurrent views give one change and
   * one version bump. A bump also moves the list up; a plain refresh does not.
   */
  setIdentity(entryId, identity, { bump, expected }) {
    const now = new Date().toISOString();
    return this.#transaction(() => {
      const result = this.db
        .prepare(
          `UPDATE agent_pinboard_entries SET identity=?${bump ? ", version=version+1, updated_at=?" : ""} WHERE id=? AND identity IS ?`,
        )
        .run(...[json(identity), ...(bump ? [now] : []), entryId, expected ?? null]);
      if (!result.changes) return false;
      if (bump)
        this.db
          .prepare(
            "UPDATE agent_pinboard_lists SET updated_at=? WHERE id=(SELECT list_id FROM agent_pinboard_entries WHERE id=?)",
          )
          .run(now, entryId);
      return true;
    });
  }

  markSeen(assistantId, entryId, identity) {
    this.db
      .prepare(
        "UPDATE agent_pinboard_entries SET seen_identity=? WHERE id=? AND assistant_id=?",
      )
      .run(json(identity), entryId, assistantId);
  }

  recordChange({
    conversationId,
    requestId,
    listId,
    assistantId,
    title,
    at,
    kind,
    name,
  }) {
    const column = kindColumn[kind];
    if (!column) throw new Error(`Unknown pinboard change ${kind}`);
    this.#transaction(() => {
      const row = this.db
        .prepare(
          "SELECT names FROM agent_pinboard_changes WHERE conversation_id=? AND request_id=? AND list_id=?",
        )
        .get(conversationId, requestId, listId);
      const names = row ? JSON.parse(row.names) : [];
      if (!names.includes(name) && names.length < maxChangeNames) names.push(name);
      if (!row)
        this.db
          .prepare(
            "INSERT INTO agent_pinboard_changes(conversation_id,request_id,list_id,assistant_id,title,at) VALUES(?,?,?,?,?,?)",
          )
          .run(conversationId, requestId, listId, assistantId, title, at);
      this.db
        .prepare(
          `UPDATE agent_pinboard_changes SET ${column}=${column}+1, names=?, title=?, at=? WHERE conversation_id=? AND request_id=? AND list_id=?`,
        )
        .run(JSON.stringify(names), title, at, conversationId, requestId, listId);
    });
  }

  /** A deleted chat's cards go with it (chat-removal.js forgetChat). */
  forgetChanges(conversationId) {
    this.db
      .prepare("DELETE FROM agent_pinboard_changes WHERE conversation_id=?")
      .run(conversationId);
  }

  changesFor(conversationId) {
    return this.db
      .prepare(
        "SELECT * FROM agent_pinboard_changes WHERE conversation_id=? ORDER BY at, rowid",
      )
      .all(conversationId)
      .map((row) => ({
        assistantId: row.assistant_id,
        listId: row.list_id,
        requestId: row.request_id,
        title: row.title,
        at: row.at,
        added: row.added,
        updated: row.updated,
        removed: row.removed,
        names: JSON.parse(row.names),
      }));
  }
}
