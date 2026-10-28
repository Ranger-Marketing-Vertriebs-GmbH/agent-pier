import { randomUUID } from "node:crypto";
import { recipientsOf } from "../../mail/mail-compose.js";
import { mailCatalog, recipientAllowed } from "./agent-mail-grants.js";
import { bodyDigest, contentDigest } from "./agent-mail-send-input.js";

const domainOf = (from) => from.address.slice(from.address.lastIndexOf("@") + 1);

/** The approval card's payload: exactly what is sent, with its digests. */
export function cardPayload({
  account,
  from,
  draft,
  fields,
  cls,
  trusted,
  inputSha256,
  expiresAt,
}) {
  const payload = {
    action: "mail_send",
    accountId: account.id,
    accountName: account.name,
    from,
    ...fields,
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
 * rules, and the card's digests unchanged. `UNAVAILABLE` while the catalog cannot be
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
  return null;
}
