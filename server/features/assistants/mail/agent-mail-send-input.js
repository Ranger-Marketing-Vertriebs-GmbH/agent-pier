import { createHash } from "node:crypto";
import { assistantProblem } from "../assistant-validation.js";
import { hasHiddenCharacters } from "../agent-ssh-text.js";
import { draftFields } from "../../mail/mail-compose.js";
import { attachmentLimits } from "../../mail/mail-parts.js";
import { validPath } from "./agent-mail-sources.js";

// The input of an agent's `send` and the digests that bind an approval card to what
// goes out (mail/agent-mail-sends.js).

const fieldKeys = ["to", "cc", "bcc", "subject", "body", "replyToUid", "replyToFolder"];
const sendKeys = new Set([
  "action",
  "accountId",
  "draftUid",
  "attachments",
  ...fieldKeys,
]);
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
 * The `attachments` list of a draft or send, checked beyond the tool schema: at most
 * `attachmentLimits.files` entries, each a valid path (validPath) with an optional
 * string projectId, no entry twice. Returns the entries or [] when absent.
 */
export function attachmentList(list) {
  if (list === undefined) return [];
  if (!Array.isArray(list) || list.length > attachmentLimits.files)
    throw assistantProblem("invalid");
  const seen = new Set();
  for (const entry of list) {
    if (!entry || typeof entry !== "object" || !validPath(entry.path))
      throw assistantProblem("invalid");
    if (entry.projectId !== undefined) {
      if (
        typeof entry.projectId !== "string" ||
        /[\u0000-\u001f\u007f]/.test(entry.projectId)
      )
        throw assistantProblem("invalid");
    }
    const key = JSON.stringify([entry.projectId ?? null, entry.path]);
    if (seen.has(key)) throw assistantProblem("invalid");
    seen.add(key);
  }
  return list.map(({ path, projectId }) => ({
    path,
    ...(projectId !== undefined && { projectId }),
  }));
}

/**
 * `{ draftUid }` for a stored draft, or `{ fields, attachments }` (draftFields, the
 * body's line ends as LF; attachmentList) for a new message; fields, attachments and
 * draftUid never mix, and a new message needs at least one recipient. Anything else
 * is 400 `invalid`, before any file or mailbox is read.
 */
export function sendInput(input) {
  if (Object.keys(input).some((key) => !sendKeys.has(key)))
    throw assistantProblem("invalid");
  if (input.draftUid !== undefined) {
    if ([...fieldKeys, "attachments"].some((key) => input[key] !== undefined))
      throw assistantProblem("invalid");
    return { draftUid: input.draftUid };
  }
  const attachments = attachmentList(input.attachments);
  const fields = draftFields(input);
  if (fields.to.length + fields.cc.length + fields.bcc.length === 0)
    throw assistantProblem("invalid");
  return {
    fields: { ...fields, body: fields.body.replace(/\r\n?/g, "\n") },
    attachments,
  };
}

const forwardKeys = new Set([
  "action",
  "accountId",
  "folder",
  "uid",
  "to",
  "cc",
  "bcc",
  "subject",
  "body",
  "includeAttachments",
  "attachments",
]);

/**
 * The input of a `forward`: `{ forward: { folder, uid, includeAttachments }, fields,
 * attachments }` with the folder INBOX by default, `fields` as draftFields (the
 * subject null when the agent gave none: mail-forward.js forwardFields then derives
 * it) and attachmentList; at least one recipient. Anything else is 400 `invalid`.
 */
export function forwardInput(input) {
  if (Object.keys(input).some((key) => !forwardKeys.has(key)))
    throw assistantProblem("invalid");
  const folder = input.folder ?? "INBOX";
  if (
    !Number.isSafeInteger(input.uid) ||
    input.uid < 1 ||
    typeof folder !== "string" ||
    !folder ||
    /[\u0000-\u001f\u007f]/.test(folder) ||
    (input.includeAttachments !== undefined &&
      typeof input.includeAttachments !== "boolean")
  )
    throw assistantProblem("invalid");
  const attachments = attachmentList(input.attachments);
  const fields = draftFields(input);
  if (fields.to.length + fields.cc.length + fields.bcc.length === 0)
    throw assistantProblem("invalid");
  return {
    forward: {
      folder,
      uid: input.uid,
      includeAttachments: input.includeAttachments !== false,
    },
    fields: {
      to: fields.to,
      cc: fields.cc,
      bcc: fields.bcc,
      subject: fields.subject || null,
      body: fields.body.replace(/\r\n?/g, "\n"),
    },
    attachments,
  };
}

/** The digest of the agent's call, so a retry finds its card and nothing else does. */
export const inputDigest = (input) => sha256(JSON.stringify(sorted(input)));

export const bodyDigest = (body) => sha256(String(body));

/**
 * Everything a card's mail is composed from, as one digest. The attachments, the
 * forwarded original and the HTML part join it only when the card has any, so a
 * card raised before them still verifies.
 */
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
      ...(p.attachments?.length || p.forward || p.html
        ? [p.attachments ?? [], p.forward ?? null, p.html ?? null]
        : []),
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
