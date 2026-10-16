import { randomUUID } from "node:crypto";
import { MAX_ATTACHMENTS_PER_MESSAGE } from "./agent-attachment-types.js";
import { assistantProblem, textValue } from "./assistant-validation.js";

const MAX_TEXT = 65536;
// Each part keeps its own lines; trailing blanks never pile up between them.
export const joinedText = (...parts) =>
  parts
    .map((part) => String(part || "").trimEnd())
    .filter((part) => part.trim())
    .join("\n");

const record = (row) =>
  row
    ? {
        conversationId: row.conversation_id,
        clientRequestId: row.client_key,
        text: row.text,
        teamAllowed: row.team_allowed === 1,
        attachments: JSON.parse(row.attachments),
        state: row.state,
        error: row.error,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        lastAppend: row.last_append,
      }
    : null;

// The owner's input for queueing: like a send without a delivery key. `appendId`
// names one submission, so a repeated request adds its text only once.
export function validateQueueInput(input) {
  const keys = ["text", "teamAllowed", "attachments", "appendId"];
  if (
    !input ||
    typeof input !== "object" ||
    Object.keys(input).some((k) => !keys.includes(k)) ||
    ("teamAllowed" in input && typeof input.teamAllowed !== "boolean") ||
    ("appendId" in input &&
      (typeof input.appendId !== "string" ||
        !input.appendId ||
        input.appendId.length > 100)) ||
    ("attachments" in input &&
      (!Array.isArray(input.attachments) ||
        input.attachments.some((id) => typeof id !== "string" || id.length > 100)))
  )
    throw assistantProblem("invalid");
  const attachments = input.attachments || [];
  textValue(input.text ?? "", MAX_TEXT, attachments.length > 0);
  return {
    text: input.text ?? "",
    teamAllowed: input.teamAllowed === true,
    attachments,
    appendId: input.appendId ?? null,
  };
}

/**
 * The one message per conversation the owner queued while its agent works. It is
 * persisted, so a reload, another tab or a restart still sees it, and it is
 * dispatched once through the normal send path when the conversation is idle:
 * `waiting` → `sending` (its delivery key is the ledger's dedupe key) → gone, or
 * `failed` with the refusal. Its staged files stay unclaimed until then and are
 * kept from expiry and removal (agent-attachments.js).
 */
export class QueuedMessages {
  constructor(db, now = Date.now) {
    this.db = db;
    this.now = now;
    // A dispatch cut off by a restart starts over, unless the ledger took it already.
    db.prepare("UPDATE queued_messages SET state='waiting' WHERE state='sending'").run();
    this.forgetDelivered();
  }
  // A row whose delivery key the ledger knows was sent: a later append must start a
  // new message instead of sending the old text again.
  forgetDelivered(conversationId = null) {
    this.db
      .prepare(
        `DELETE FROM queued_messages WHERE (? IS NULL OR conversation_id=?) AND EXISTS
          (SELECT 1 FROM requests r WHERE r.conversation_id=queued_messages.conversation_id
            AND r.client_key=queued_messages.client_key)`,
      )
      .run(conversationId, conversationId);
  }
  get(conversationId) {
    this.forgetDelivered(conversationId);
    return record(
      this.db
        .prepare("SELECT * FROM queued_messages WHERE conversation_id=?")
        .get(conversationId),
    );
  }
  waiting() {
    return this.db
      .prepare("SELECT * FROM queued_messages WHERE state='waiting' ORDER BY rowid")
      .all()
      .map(record);
  }
  // Appends to the queued message on a new line (or starts it); every change is a new
  // message with a new delivery key. Refused once its dispatch has started.
  put(conversationId, { text, teamAllowed, attachments, appendId = null }) {
    const current = this.get(conversationId);
    if (current?.state === "sending") throw assistantProblem("queuedSending", 409);
    // A refused message waits for the owner to edit it; it is not retried quietly.
    if (current?.state === "failed") throw assistantProblem("queuedFailed", 409);
    if (appendId && current?.lastAppend === appendId) return current;
    const joined = joinedText(current?.text, text);
    if (joined.length > MAX_TEXT) throw assistantProblem("queuedTooLong", 413);
    const files = [...(current?.attachments || []), ...attachments];
    if (new Set(files).size !== files.length) throw assistantProblem("invalid");
    if (files.length > MAX_ATTACHMENTS_PER_MESSAGE)
      throw assistantProblem("attachmentTooMany");
    const stamp = new Date(this.now()).toISOString();
    this.db
      .prepare(
        `INSERT INTO queued_messages VALUES (?,?,?,?,?,'waiting',NULL,?,?,?)
        ON CONFLICT(conversation_id) DO UPDATE SET client_key=excluded.client_key,
          text=excluded.text, team_allowed=excluded.team_allowed,
          attachments=excluded.attachments, state='waiting', error=NULL,
          updated_at=excluded.updated_at, last_append=excluded.last_append`,
      )
      .run(
        conversationId,
        randomUUID(),
        joined,
        current?.teamAllowed || teamAllowed ? 1 : 0,
        JSON.stringify(files),
        stamp,
        stamp,
        appendId,
      );
    return this.get(conversationId);
  }
  // Claims the dispatch of exactly this content; false when it changed or is gone.
  begin(message) {
    return (
      this.db
        .prepare(
          "UPDATE queued_messages SET state='sending' WHERE conversation_id=? AND client_key=? AND state='waiting'",
        )
        .run(message.conversationId, message.clientRequestId).changes === 1
    );
  }
  // The agent cannot take it yet: it waits for the next chance.
  release(message) {
    this.set(message, "waiting", null);
  }
  fail(message, error) {
    this.set(message, "failed", String(error || ""));
  }
  done(message) {
    this.db
      .prepare("DELETE FROM queued_messages WHERE conversation_id=? AND client_key=?")
      .run(message.conversationId, message.clientRequestId);
  }
  set(message, state, error) {
    this.db
      .prepare(
        "UPDATE queued_messages SET state=?, error=? WHERE conversation_id=? AND client_key=?",
      )
      .run(state, error, message.conversationId, message.clientRequestId);
  }
  // Takes the message back to the composer, unless its dispatch has started.
  take(conversationId) {
    const current = this.get(conversationId);
    if (!current) throw assistantProblem("notFound", 404);
    if (current.state === "sending") throw assistantProblem("queuedSending", 409);
    this.done(current);
    return current;
  }
}
