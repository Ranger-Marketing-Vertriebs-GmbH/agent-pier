import { toolError } from "../tool-errors.js";
import { composeMessage, recipientsOf } from "../../mail/mail-compose.js";
import { fileSent } from "../../mail/mail-changes.js";
import { auditDelete } from "./agent-mail-changes.js";

// Rule sends kept as rows; well above an hour's cap, which counts them with the cards.
const trustedMailRows = 200;
// Mail errors that end a send before the server could accept the message. Edge: these
// codes come from the connection setup (DNS, connect, TLS handshake, sign-in). A TLS
// or network error code raised mid-session, after DATA (a socket that dies with
// EHOSTUNREACH, a TLS alert during the transfer), would also map here and read as
// failed although the mail may have gone out. A session that drops or stalls after
// DATA usually ends as a reset or a timeout (MAIL_PROTOCOL or MAIL_TIMEOUT, so
// unknown); the narrower case is accepted as rare.
const notSent = new Set([
  "MAIL_AUTH_FAILED",
  "MAIL_TLS_FAILED",
  "MAIL_UNREACHABLE",
  "MAIL_PLAINTEXT_REFUSED",
]);
const isMailCode = (code) => typeof code === "string" && code.startsWith("MAIL_");
export const isBug = (error) =>
  error instanceof TypeError || error instanceof ReferenceError;

/**
 * Sends the row's mail once, to exactly its recipients and without Bcc, then files
 * it (a copy with Bcc in Sent when the account saves sent mail, the draft to Trash).
 */
export async function deliverMail(sends, a, authorizedBy) {
  const { w, accounts } = sends;
  const p = a.payload;
  const recipients = recipientsOf(p);
  const message = {
    from: p.from,
    to: p.to,
    cc: p.cc,
    bcc: p.bcc,
    subject: p.subject,
    body: p.body,
    messageId: p.draftMessageId,
    inReplyTo: p.inReplyTo,
    references: p.references,
    date: new Date(sends.now()),
  };
  let sent;
  let raw;
  try {
    raw = await composeMessage(message, { keepBcc: false });
    sent = await accounts.sendRaw(p.accountId, {
      envelope: { from: p.from.address, to: recipients },
      raw,
    });
  } catch (error) {
    const { code } = toolError(error);
    // Only an error before the SMTP session proves nothing went out; a timeout,
    // reset or odd answer later (after DATA) may have delivered it.
    const failed = !raw || !isMailCode(error?.code) || notSent.has(error.code);
    auditSend(w, a, authorizedBy, recipients.length, failed ? "failed" : "unknown", code);
    return sends.finish(a.id, {
      state: failed ? "failed" : "unknown",
      diagnostic: code,
      result: { code },
    });
  }
  let filed = { savedToSent: false, draftTrashed: false };
  try {
    const copy = await composeMessage(message, { keepBcc: true });
    const saveSent = accounts.get(p.accountId).saveSent === true;
    filed = await accounts.withImap(p.accountId, (client) =>
      fileSent(client, { raw: copy, saveSent, draftUid: p.draftUid }),
    );
  } catch (error) {
    if (isBug(error)) console.error("Agent mail filing failed:", error?.name);
  }
  auditSend(w, a, authorizedBy, recipients.length, "sent");
  // The sent draft went to Trash, audited like every Trash move.
  if (filed.draftTrashed)
    auditDelete(w.s, { account: { id: p.accountId }, agent: { id: a.assistantId } }, 1);
  const next = sends.finish(a.id, {
    state: "completed",
    result: {
      recipients: recipients.length,
      savedToSent: filed.savedToSent,
      ...(sent?.rejected ? { rejected: sent.rejected } : {}),
    },
  });
  if (p.trusted) w.store.pruneTrusted(a.assistantId, "mail_send", trustedMailRows);
  return next;
}

/** `mail.sent` with `delivery` sent, failed or unknown (outcome failure for both). */
export function auditSend(w, a, authorizedBy, recipients, delivery, code) {
  try {
    w.s.audit?.append({
      action: "mail.sent",
      resourceType: "mail",
      resourceId: a.payload.accountId,
      source: "system",
      outcome: delivery === "sent" ? "success" : "failure",
      details: {
        kind: "message",
        assistantId: a.assistantId,
        actionId: a.id,
        authorizedBy,
        recipients,
        delivery,
        ...(code ? { code } : {}),
      },
    });
  } catch (error) {
    console.error("Agent mail audit failed:", error?.code || "error");
  }
}
