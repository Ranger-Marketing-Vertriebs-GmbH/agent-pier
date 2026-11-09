import { randomUUID } from "node:crypto";
import { CARD_LIMITS, cardError } from "./agent-card-schema.js";

const parse = (text, fallback) => (text ? JSON.parse(text) : fallback);
const cardFrom = (row) => ({
  id: row.id,
  assistantId: row.assistant_id,
  conversationId: row.conversation_id,
  title: row.title,
  blocks: parse(row.blocks, []),
  version: row.version,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  placements: parse(row.placements, []),
  frozenAt: row.frozen_at,
  changedAt: row.changed_at,
  seenAt: row.seen_at,
  pressed: parse(row.pressed, null),
});

/**
 * Agent cards (agentpier_card, agent-cards.js): one row per card of a chat, with its
 * checked blocks (agent-card-schema.js), the person's ticks inside them, and every
 * place in the chat the card was put at (`placements`, oldest first; the history shows
 * the card at the last one). `changedAt` is the person's latest tick or press,
 * `seenAt` when the agent last saw the card, `pressed` the latest button the person
 * pressed since. `agent_card_notes` keeps the card note each turn carried, so the
 * history can leave it out. Rows go with their chat (forgetConversation) and their
 * agent (agent-deletion.js agentTables).
 */
export class AgentCardStore {
  constructor(db) {
    this.db = db;
    db.exec(
      "CREATE TABLE IF NOT EXISTS agent_cards(id TEXT PRIMARY KEY, assistant_id TEXT NOT NULL, conversation_id TEXT NOT NULL, title TEXT NOT NULL, blocks TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, placements TEXT NOT NULL, frozen_at TEXT, changed_at TEXT, seen_at TEXT, pressed TEXT)",
    );
    db.exec(
      "CREATE INDEX IF NOT EXISTS agent_cards_conversation ON agent_cards(conversation_id)",
    );
    db.exec(
      "CREATE TABLE IF NOT EXISTS agent_card_notes(conversation_id TEXT NOT NULL, request_id TEXT NOT NULL, assistant_id TEXT NOT NULL, note TEXT NOT NULL, PRIMARY KEY(conversation_id, request_id))",
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

  /** The card, or null. */
  get(id) {
    const row =
      typeof id === "string"
        ? this.db.prepare("SELECT * FROM agent_cards WHERE id=?").get(id)
        : null;
    return row ? cardFrom(row) : null;
  }

  /** The card `id` of chat `conversationId`, or CARD_NOT_FOUND. */
  inChat(conversationId, id) {
    const card = this.get(id);
    if (!card || card.conversationId !== conversationId)
      throw cardError("CARD_NOT_FOUND", 404);
    return card;
  }

  /** The chat's cards, oldest first. */
  forConversation(conversationId) {
    return this.db
      .prepare(
        "SELECT * FROM agent_cards WHERE conversation_id=? ORDER BY created_at, rowid",
      )
      .all(conversationId)
      .map(cardFrom);
  }

  /**
   * A new card in its chat at `at`. Beyond CARD_LIMITS.openCards open cards the
   * oldest open ones are frozen: kept and shown, never changed again.
   */
  create({ assistantId, conversationId, requestId, title, blocks, at }) {
    const id = `card_${randomUUID()}`;
    return this.#transaction(() => {
      this.db
        .prepare(
          "INSERT INTO agent_cards(id,assistant_id,conversation_id,title,blocks,version,created_at,updated_at,placements,seen_at) VALUES(?,?,?,?,?,1,?,?,?,?)",
        )
        .run(
          id,
          assistantId,
          conversationId,
          title,
          JSON.stringify(blocks),
          at,
          at,
          JSON.stringify([{ at, requestId }]),
          at,
        );
      const open = this.db
        .prepare(
          "SELECT id FROM agent_cards WHERE conversation_id=? AND frozen_at IS NULL ORDER BY created_at, rowid",
        )
        .all(conversationId);
      for (const row of open.slice(0, Math.max(0, open.length - CARD_LIMITS.openCards)))
        this.db.prepare("UPDATE agent_cards SET frozen_at=? WHERE id=?").run(at, row.id);
      return this.get(id);
    });
  }

  /**
   * The agent's new content for an open card: a new version, placed again at `at`
   * (the oldest places beyond CARD_LIMITS.placements are forgotten). The agent has
   * seen the card now.
   */
  update(card, { title, blocks, requestId, at }) {
    if (card.frozenAt) throw cardError("CARD_FROZEN", 409);
    const placements = [...card.placements, { at, requestId }].slice(
      -CARD_LIMITS.placements,
    );
    const changed = this.db
      .prepare(
        "UPDATE agent_cards SET title=?, blocks=?, version=version+1, updated_at=?, placements=?, seen_at=?, pressed=NULL WHERE id=? AND version=?",
      )
      .run(
        title,
        JSON.stringify(blocks),
        at,
        JSON.stringify(placements),
        at,
        card.id,
        card.version,
      );
    if (!changed.changes) throw cardError("CARD_CHANGED", 409);
    return this.get(card.id);
  }

  #open(card, version) {
    if (card.frozenAt) throw cardError("CARD_FROZEN", 409);
    if (version !== card.version) throw cardError("CARD_CHANGED", 409);
  }

  #block(card, index, type) {
    const block = Number.isInteger(index) ? card.blocks[index] : undefined;
    if (block?.type !== type) throw cardError("CARD_CHANGED", 409);
    return block;
  }

  #person(card, blocks, pressed, at) {
    const changed = this.db
      .prepare(
        "UPDATE agent_cards SET blocks=?, changed_at=?, pressed=COALESCE(?, pressed) WHERE id=? AND version=?",
      )
      .run(
        JSON.stringify(blocks),
        at,
        pressed && JSON.stringify(pressed),
        card.id,
        card.version,
      );
    if (!changed.changes) throw cardError("CARD_CHANGED", 409);
    return this.get(card.id);
  }

  /**
   * The person ticks (or unticks) checklist item `item` of block `block` of the
   * card's `version`. Silent: no turn starts; the agent learns it with its next turn.
   */
  check(card, { version, block, item, checked, at }) {
    this.#open(card, version);
    const list = this.#block(card, block, "checklist");
    if (!list.items.some((entry) => entry.id === item) || typeof checked !== "boolean")
      throw cardError("CARD_CHANGED", 409);
    const blocks = card.blocks.map((b, i) =>
      i === block
        ? {
            ...b,
            items: b.items.map((entry) =>
              entry.id === item ? { ...entry, checked } : entry,
            ),
          }
        : b,
    );
    return this.#person(card, blocks, null, at);
  }

  /**
   * The person presses a button of the card's `version`: item `item` of an actions
   * block, or the action of row `row` of a table. Returns `{ card, text }`, `text`
   * being the message the press sends: the button's own message, else its label
   * (with the row's cells for a row's button).
   */
  press(card, { version, block, row, item, at }) {
    this.#open(card, version);
    const target = card.blocks[block];
    let button, rowText;
    if (target?.type === "actions" && Number.isInteger(item)) button = target.items[item];
    else if (target?.type === "table" && Number.isInteger(row)) {
      button = target.rows[row]?.action;
      rowText = target.rows[row]?.cells.join(" · ");
    }
    if (!button) throw cardError("CARD_CHANGED", 409);
    const text =
      button.message ?? (rowText ? `${button.label}: ${rowText}` : button.label);
    const pressed = { label: button.label, ...(rowText && { row: rowText }), at };
    return { card: this.#person(card, card.blocks, pressed, at), text };
  }

  /** The agent has seen these cards now (a read, or a turn note that named them). */
  seen(ids, at) {
    const mark = this.db.prepare(
      "UPDATE agent_cards SET seen_at=?, pressed=NULL WHERE id=?",
    );
    for (const id of ids) mark.run(at, id);
  }

  /** The cards of the chat the person changed since the agent last saw them. */
  changedFor(conversationId) {
    return this.forConversation(conversationId).filter(
      (card) => card.changedAt && (!card.seenAt || card.changedAt > card.seenAt),
    );
  }

  recordNote({ conversationId, requestId, assistantId, note }) {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO agent_card_notes(conversation_id,request_id,assistant_id,note) VALUES(?,?,?,?)",
      )
      .run(conversationId, requestId, assistantId, note);
  }

  /** The card notes the chat's turns carried. */
  notes(conversationId) {
    return this.db
      .prepare("SELECT note FROM agent_card_notes WHERE conversation_id=?")
      .all(conversationId)
      .map((row) => row.note);
  }

  /** A deleted chat's cards and notes go with it (chat-removal.js forgetChat). */
  forgetConversation(conversationId) {
    this.db
      .prepare("DELETE FROM agent_cards WHERE conversation_id=?")
      .run(conversationId);
    this.db
      .prepare("DELETE FROM agent_card_notes WHERE conversation_id=?")
      .run(conversationId);
  }
}
