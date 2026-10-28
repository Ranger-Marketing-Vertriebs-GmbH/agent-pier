import { randomUUID } from "node:crypto";
import { recipientsOf } from "../../mail/mail-compose.js";
import { mailCatalog, recipientAllowed } from "./agent-mail-grants.js";
import { bodyDigest, contentDigest } from "./agent-mail-send-input.js";
import { sourceAllowed } from "./agent-mail-sources.js";

const domainOf = (from) => from.address.slice(from.address.lastIndexOf("@") + 1);

// Sources that name a file on the host, checked again at approval.
const fileKinds = new Set(["workspace", "project", "host"]);
const fileSource = (a) => fileKinds.has(a.source?.kind);

/**
 * The card's attachments: the draft's parts as read back (`{ part, name, type, size,
 * sha256, partSha256 }`) with where each came from (`sourceOf(part, index)`, else the
 * draft itself).
 */
export const cardAttachments = (parts, sourceOf = () => null) =>
  parts.map((p, i) => ({
    name: p.name ?? null,
    type: p.type,
    size: p.size,
    sha256: p.sha256,
    part: p.part,
    partSha256: p.partSha256,
    source: sourceOf(p, i) ?? { kind: "draft" },
  }));

/**
 * The approval card's payload: exactly what is sent, with its digests. `attachments`
 * (cardAttachments) are the draft's parts that go along, `files` the turn's file
 * context (storedFiles) a file source is checked against again, `html` an HTML part
 * of the draft that goes along and `forward` the forwarded original.
 */
export function cardPayload({
  account,
  from,
  draft,
  fields,
  cls,
  trusted,
  inputSha256,
  expiresAt,
  attachments = [],
  files = null,
  html = null,
  forward = null,
}) {
  const payload = {
    action: "mail_send",
    accountId: account.id,
    accountName: account.name,
    from,
    ...fields,
    attachments,
    attachmentBytes: attachments.reduce((sum, a) => sum + a.size, 0),
    files: attachments.some(fileSource) ? files : null,
    html,
    forward,
    bodySha256: bodyDigest(fields.body),
    inReplyTo: draft.thread?.inReplyTo ?? null,
    references: draft.thread?.references ?? [],
    draftMessageId: draft.messageId ?? `<${randomUUID()}@${domainOf(from)}>`,
    draftUid: draft.draftUid ?? null,
    originClass: cls,
    trusted,
    inputSha256,
    expiresAt,
  };
  payload.contentSha256 = contentDigest(payload);
  return payload;
}

/**
 * Why a card may no longer send, or null: the grant at the send level, the account
 * with the card's sender address, for a rule send every recipient still within the
 * rules, the card's digests unchanged and every attached file still within the
 * agent's reach (sourceAllowed). `UNAVAILABLE` while the catalog cannot be
 * read.
 */
export function staleReason(w, a) {
  const p = a.payload;
  const catalog = mailCatalog(w.s);
  if (!catalog) return "UNAVAILABLE";
  const account = catalog.find((x) => x.id === p.accountId);
  if (!account) return "ACCOUNT_REMOVED";
  if (account.address.toLowerCase() !== p.from?.address?.toLowerCase())
    return "ACCESS_CHANGED";
  const grant = w.access.mailGrant(a.assistantId, p.accountId, catalog);
  if (grant?.level !== "send") return "ACCESS_CHANGED";
  if (
    p.trusted &&
    !recipientsOf(p).every((r) => recipientAllowed(grant.recipients ?? [], r))
  )
    return "ACCESS_CHANGED";
  if (bodyDigest(p.body) !== p.bodySha256 || contentDigest(p) !== p.contentSha256)
    return "ACCESS_CHANGED";
  // Each attached file the agent may still read where it came from.
  const files = (p.attachments ?? []).filter(fileSource);
  if (files.some((x) => !p.files || !sourceAllowed(w, a.assistantId, p.files, x.source)))
    return "ACCESS_CHANGED";
  return null;
}
