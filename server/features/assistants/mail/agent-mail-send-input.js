import { createHash } from "node:crypto";
import { assistantProblem } from "../assistant-validation.js";
import { hasHiddenCharacters } from "../agent-ssh-text.js";
import { draftFields } from "../../mail/mail-compose.js";

// The input of an agent's `send` and the digests that bind an approval card to what
// goes out (mail/agent-mail-sends.js).

const fieldKeys = ["to", "cc", "bcc", "subject", "body", "replyToUid", "replyToFolder"];
const sendKeys = new Set(["action", "accountId", "draftUid", ...fieldKeys]);
// Telegram shows a card's buttons only when the owner can read all of it there.
export const telegramBodyLimit = 3000;
export const telegramRecipientLimit = 20;

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const sorted = (value) =>
  Array.isArray(value)
    ? value.map(sorted)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((k) => [k, sorted(value[k])]),
        )
      : value;

/**
 * `{ draftUid }` for a stored draft, or `{ fields }` (draftFields, the body's line
 * ends as LF) for a new message; fields and draftUid never mix, and a new message
 * needs at least one recipient. Anything else is 400 `invalid`.
 */
export function sendInput(input) {
  if (Object.keys(input).some((key) => !sendKeys.has(key)))
    throw assistantProblem("invalid");
  if (input.draftUid !== undefined) {
    if (fieldKeys.some((key) => input[key] !== undefined))
      throw assistantProblem("invalid");
    return { draftUid: input.draftUid };
  }
  const fields = draftFields(input);
  if (fields.to.length + fields.cc.length + fields.bcc.length === 0)
    throw assistantProblem("invalid");
  return { fields: { ...fields, body: fields.body.replace(/\r\n?/g, "\n") } };
}

/** The digest of the agent's call, so a retry finds its card and nothing else does. */
export const inputDigest = (input) => sha256(JSON.stringify(sorted(input)));

export const bodyDigest = (body) => sha256(String(body));

/** Everything a card's mail is composed from, as one digest. */
export const contentDigest = (p) =>
  sha256(
    JSON.stringify([
      p.accountId,
      p.from,
      p.to,
      p.cc,
      p.bcc,
      p.subject,
      p.body,
      p.inReplyTo,
      p.references,
      p.draftMessageId,
      p.draftUid,
    ]),
  );

/**
 * Whether Telegram may offer Send for a card: a body of at most 3000 code points, at
 * most 20 recipients, and no character the owner cannot see in the body, the subject,
 * the sender's name or any recipient.
 */
export function mailTelegramApprovable(payload) {
  const recipients = [
    ...(payload.to ?? []),
    ...(payload.cc ?? []),
    ...(payload.bcc ?? []),
  ];
  return (
    Array.from(String(payload.body ?? "")).length <= telegramBodyLimit &&
    recipients.length <= telegramRecipientLimit &&
    ![payload.body, payload.subject, payload.from?.name, ...recipients].some((text) =>
      hasHiddenCharacters(text ?? ""),
    )
  );
}
