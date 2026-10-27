// "New mail since the last check" per agent and account: the highest INBOX UID an
// agent's `list` with `new: true` has shown, under the mailbox's UIDVALIDITY.
// agent-deletion.js removes an agent's rows; AgentMail.revokeAccount an account's.
export function mailCursorTable(db) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS agent_mail_cursors(assistant_id TEXT NOT NULL,account_id TEXT NOT NULL,uid_validity TEXT NOT NULL,last_uid INTEGER NOT NULL,PRIMARY KEY(assistant_id,account_id))",
  );
}

export class MailCursors {
  constructor(db) {
    this.db = db;
    mailCursorTable(db);
  }
  /** { uidValidity, lastUid } or null. */
  get(assistantId, accountId) {
    const row = this.db
      .prepare(
        "SELECT uid_validity,last_uid FROM agent_mail_cursors WHERE assistant_id=? AND account_id=?",
      )
      .get(assistantId, accountId);
    return row ? { uidValidity: String(row.uid_validity), lastUid: row.last_uid } : null;
  }
  set(assistantId, accountId, { uidValidity, lastUid }) {
    this.db
      .prepare(
        "INSERT INTO agent_mail_cursors(assistant_id,account_id,uid_validity,last_uid) VALUES(?,?,?,?) ON CONFLICT(assistant_id,account_id) DO UPDATE SET uid_validity=excluded.uid_validity,last_uid=excluded.last_uid",
      )
      .run(assistantId, accountId, String(uidValidity), lastUid);
  }
  removeAccount(accountId) {
    this.db.prepare("DELETE FROM agent_mail_cursors WHERE account_id=?").run(accountId);
  }
  removeAgent(assistantId) {
    this.db
      .prepare("DELETE FROM agent_mail_cursors WHERE assistant_id=?")
      .run(assistantId);
  }
}
