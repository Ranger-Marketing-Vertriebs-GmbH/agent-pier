// "New mail since the last check" per agent and account: the highest INBOX UID an
// agent's `list` with `new: true` has shown, under the mailbox's UIDVALIDITY.
// agent-deletion.js removes an agent's rows.
export function mailCursorTable(db) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS agent_mail_cursors(assistant_id TEXT NOT NULL,account_id TEXT NOT NULL,uid_validity INTEGER NOT NULL,last_uid INTEGER NOT NULL,PRIMARY KEY(assistant_id,account_id))",
  );
}
