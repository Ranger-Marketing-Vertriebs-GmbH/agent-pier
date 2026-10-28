import { mailError } from "./mail-connection.js";
import { openFolder, resolveFolders } from "./mail-folders.js";
import { download, isAttachment, leafParts } from "./mail-messages.js";
import { fetchRawParts, messageParts, sha256 } from "./mail-parts.js";
import { draftFields, threadHeaders, validMessageId } from "./mail-compose.js";

// A stored draft read back for sending (agent `send` with `draftUid`): its envelope,
// its plain text, checked again like an agent's own draft fields, and its
// attachments with their digests. Only the text/plain part and the attachments are
// sent (an HTML alternative of another mail program's draft is not). A draft without
// a text/plain part or with more than 1 MiB of text is not sent: AgentPier only sends
// what the owner's card can show in full.

const quoteName = (name) => `"${name.replace(/["\\]/g, (c) => `\\${c}`)}"`;
const entry = (a) => (a.name ? `${quoteName(a.name)} <${a.address ?? ""}>` : a.address);
const entries = (list) => (list || []).map(entry);

// The whole text part within `partBytes`; a longer one cannot be sent from the draft.
async function partText(client, uid, part) {
  const { bytes, limited } = await download(client, uid, part);
  if (limited) throw mailError("MAIL_DRAFT_UNSUPPORTED");
  return bytes.toString("utf8");
}

async function openDrafts(client) {
  const { drafts } = await resolveFolders(client);
  if (!drafts) throw mailError("MAIL_NO_DRAFTS");
  await openFolder(client, drafts);
}

/**
 * Draft `uid` of the Drafts folder as `{ fields, thread, messageId, attachments }`:
 * the fields as draftFields returns them, the thread headers it carries, its own
 * Message-ID (null when malformed) and its attachments as messageParts lists them.
 * Without Drafts MAIL_NO_DRAFTS, an unknown UID MAIL_NOT_FOUND, no plain text or too
 * much of it MAIL_DRAFT_UNSUPPORTED.
 */
export async function loadDraft(client, uid) {
  await openDrafts(client);
  const row = await client.fetchOne(
    String(uid),
    { uid: true, envelope: true, bodyStructure: true, headers: ["references"] },
    { uid: true },
  );
  if (!row || row.uid !== uid) throw mailError("MAIL_NOT_FOUND");
  // A text file attached to the draft is no body.
  const part = leafParts(row.bodyStructure).find(
    (n) => n.type === "text/plain" && !isAttachment(n),
  );
  if (!part) throw mailError("MAIL_DRAFT_UNSUPPORTED");
  const text = await partText(client, uid, part.part || "1");
  const envelope = row.envelope || {};
  const fields = draftFields({
    to: entries(envelope.to),
    cc: entries(envelope.cc),
    bcc: entries(envelope.bcc),
    subject: envelope.subject ?? "",
    body: text.replace(/\r\n?/g, "\n"),
  });
  const references = String(row.headers ?? "")
    .replace(/\r?\n[ \t]+/g, " ")
    .match(/^references:(.*)$/im)?.[1];
  return {
    fields,
    thread: threadHeaders({ inReplyTo: envelope.inReplyTo, references }),
    messageId: validMessageId(envelope.messageId),
    attachments: await messageParts(client, uid),
  };
}

/**
 * The raw parts `expected` (`{ part, partSha256 }` as saveDraft or loadDraft listed
 * them) of draft `draftUid`, in that order. A draft or part that is gone, or one
 * whose bytes differ, is MAIL_DRAFT_CHANGED: what was approved is no longer there.
 */
export async function loadDraftParts(client, draftUid, expected) {
  await openDrafts(client);
  let raws;
  try {
    raws = await fetchRawParts(
      client,
      draftUid,
      expected.map((e) => e.part),
    );
  } catch (error) {
    if (error?.code === "MAIL_NOT_FOUND") throw mailError("MAIL_DRAFT_CHANGED");
    throw error;
  }
  return expected.map(({ part, partSha256 }) => {
    const raw = raws.get(part);
    if (sha256(raw) !== partSha256) throw mailError("MAIL_DRAFT_CHANGED");
    return raw;
  });
}
