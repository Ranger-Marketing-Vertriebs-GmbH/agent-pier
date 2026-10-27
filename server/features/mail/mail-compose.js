import MailComposer from "nodemailer/lib/mail-composer";
import addressparser from "nodemailer/lib/addressparser";
import { assistantProblem } from "../assistants/assistant-validation.js";
import { addressValue } from "./mail-account-fields.js";

// Drafts and outgoing mail of agents: the agent's fields checked (one addr-spec per
// entry, no line breaks in headers) and an RFC 5322 text/plain UTF-8 message built
// with nodemailer's composer, which encodes every header. Thread headers come only
// from a real parent message (replyHeaders), never from the agent.

const maxRecipients = 50;
const maxReferences = 20;
const headerControls = /[\u0000-\u001f\u007f\u2028\u2029]/;
const messageIdPattern = /^<[^\s<>()\u0000-\u001f\u007f]{1,996}>$/;

const invalid = () => assistantProblem("invalid");

// `"Name" <addr>` with the name quoted for addressparser, or the bare addr-spec.
const quoteName = (name) => `"${name.replace(/["\\]/g, (c) => `\\${c}`)}"`;

function recipient(value) {
  if (typeof value !== "string" || headerControls.test(value)) throw invalid();
  const parsed = addressparser(value.trim());
  if (parsed.length !== 1 || parsed[0].group) throw invalid();
  const { name = "", address } = parsed[0];
  let spec;
  try {
    spec = addressValue(address ?? "");
  } catch {
    throw invalid();
  }
  if (name.length > 200) throw invalid();
  return name ? `${quoteName(name)} <${spec}>` : spec;
}

function recipientList(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalid();
  return value.map(recipient);
}

/**
 * The agent's draft fields, each recipient canonical (`"Name" <addr>` or `addr`), or
 * 400 `invalid`: one addr-spec of at most 320 characters per entry, at most 50 in
 * all, no control characters in the subject or any address and no NUL in the body.
 */
export function draftFields(raw) {
  const to = recipientList(raw.to);
  const cc = recipientList(raw.cc);
  const bcc = recipientList(raw.bcc);
  if (to.length + cc.length + bcc.length > maxRecipients) throw invalid();
  const subject = raw.subject ?? "";
  if (typeof subject !== "string" || subject.length > 998 || headerControls.test(subject))
    throw invalid();
  const body = raw.body ?? "";
  if (typeof body !== "string" || body.length > 100_000 || body.includes("\u0000"))
    throw invalid();
  const fields = { to, cc, bcc, subject, body };
  if (raw.replyToUid === undefined) {
    if (raw.replyToFolder !== undefined) throw invalid();
    return fields;
  }
  const folder = raw.replyToFolder ?? "INBOX";
  if (
    !Number.isSafeInteger(raw.replyToUid) ||
    raw.replyToUid < 1 ||
    typeof folder !== "string" ||
    !folder ||
    headerControls.test(folder)
  )
    throw invalid();
  return { ...fields, replyToUid: raw.replyToUid, replyToFolder: folder };
}

/** The lower-cased addr-specs of every to, cc and bcc recipient. */
export function recipientsOf(fields) {
  return [...fields.to, ...fields.cc, ...fields.bcc].map((entry) =>
    addressparser(entry)[0].address.toLowerCase(),
  );
}

const messageIds = (value) =>
  String(value ?? "")
    .split(/\s+/)
    .filter((id) => messageIdPattern.test(id));

/**
 * In-Reply-To and References of a reply to `parent` ({ messageId, inReplyTo,
 * references }): the parent's References (else its In-Reply-To) plus its own
 * Message-ID, the last 20 ids; {} when the parent has no usable Message-ID.
 */
export function replyHeaders(parent) {
  const [id] = messageIds(parent.messageId);
  if (!id) return {};
  const chain = messageIds(parent.references);
  const before = chain.length ? chain : messageIds(parent.inReplyTo);
  const references = [...before.filter((ref) => ref !== id), id].slice(-maxReferences);
  return { inReplyTo: id, references };
}

/**
 * An RFC 5322 text/plain UTF-8 message. `keepBcc` keeps the Bcc header (a draft that
 * is sent later); without it the recipients only see To and Cc.
 */
export async function composeMessage(message, { keepBcc }) {
  const node = new MailComposer({
    from: message.from,
    to: message.to,
    cc: message.cc,
    bcc: message.bcc,
    subject: message.subject,
    text: message.body,
    messageId: message.messageId,
    ...(message.inReplyTo && { inReplyTo: message.inReplyTo }),
    ...(message.references?.length && { references: message.references }),
    disableFileAccess: true,
    disableUrlAccess: true,
  }).compile();
  node.keepBcc = keepBcc === true;
  return node.build();
}
