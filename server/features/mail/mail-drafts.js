import { assistantProblem } from "../assistants/assistant-validation.js";
import { mailError } from "./mail-connection.js";
import { openFolder, resolveFolders } from "./mail-folders.js";
import { attachmentsOf, leafParts, mailBounds } from "./mail-messages.js";
import { draftFields, threadHeaders, validMessageId } from "./mail-compose.js";

// A stored draft read back for sending (agent `send` with `draftUid`): its envelope and
// its plain text, checked again like an agent's own draft fields. A draft with an
// attachment, or without a text/plain part, is not sent: AgentPier only sends what
// the owner's card can show in full.

const quoteName = (name) => `"${name.replace(/["\\]/g, (c) => `\\${c}`)}"`;
const entry = (a) => (a.name ? `${quoteName(a.name)} <${a.address ?? ""}>` : a.address);
const entries = (list) => (list || []).map(entry);

// The whole text part within `partBytes`; a longer one cannot be sent from the draft.
async function partText(client, uid, part) {
  const { content } = await client.download(String(uid), part, {
    uid: true,
    maxBytes: mailBounds.partBytes,
  });
  if (!content) return "";
  const chunks = [];
  let size = 0;
  for await (const chunk of content) {
    chunks.push(chunk);
    size += chunk.length;
  }
  if (size >= mailBounds.partBytes) throw assistantProblem("invalid");
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Draft `uid` of the Drafts folder as `{ fields, thread, messageId }`: the fields as
 * draftFields returns them, the thread headers it carries and its own Message-ID
 * (null when malformed). Without Drafts MAIL_NO_DRAFTS, an unknown UID
 * MAIL_NOT_FOUND, any attachment MAIL_ATTACHMENTS_UNSUPPORTED.
 */
export async function loadDraft(client, uid) {
  const { drafts } = await resolveFolders(client);
  if (!drafts) throw mailError("MAIL_NO_DRAFTS");
  await openFolder(client, drafts);
  const row = await client.fetchOne(
    String(uid),
    { uid: true, envelope: true, bodyStructure: true, headers: ["references"] },
    { uid: true },
  );
  if (!row || row.uid !== uid) throw mailError("MAIL_NOT_FOUND");
  if (attachmentsOf(row.bodyStructure).length)
    throw mailError("MAIL_ATTACHMENTS_UNSUPPORTED");
  const part = leafParts(row.bodyStructure).find((n) => n.type === "text/plain");
  if (!part) throw assistantProblem("invalid");
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
  };
}
