import MailComposer from "nodemailer/lib/mail-composer";
import addressparser from "nodemailer/lib/addressparser";
import { assistantProblem } from "../assistants/assistant-validation.js";
import { addressValue } from "./mail-account-fields.js";
import { headerControlChar } from "./mail-shared.js";

// Drafts and outgoing mail of agents: the agent's fields checked (one addr-spec per
// entry, no line breaks in headers) and an RFC 5322 text/plain UTF-8 message built
// with nodemailer's composer, which encodes every header. Thread headers come only
// from a real parent message (replyHeaders), never from the agent.

const maxRecipients = 50;
const maxReferences = 20;
const messageIdPattern = /^<[^\s<>()\u0000-\u001f\u007f]{1,996}>$/;

const invalid = () => assistantProblem("invalid");

// `"Name" <addr>` with the name quoted for addressparser, or the bare addr-spec.
const quoteName = (name) => `"${name.replace(/["\\]/g, (c) => `\\${c}`)}"`;

function recipient(value) {
  if (typeof value !== "string" || headerControlChar.test(value)) throw invalid();
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
  if (
    typeof subject !== "string" ||
    subject.length > 998 ||
    headerControlChar.test(subject)
  )
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
    headerControlChar.test(folder)
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
 * The In-Reply-To and References a stored draft carries, kept only as well-formed
 * ids (the last 20 references), like replyHeaders.
 */
export function threadHeaders({ inReplyTo, references }) {
  const [id] = messageIds(inReplyTo);
  const chain = messageIds(references).slice(-maxReferences);
  return { inReplyTo: id ?? null, references: chain };
}

/** A Message-ID as stored in a draft, or null when it is not well formed. */
export const validMessageId = (value) => messageIds(value)[0] ?? null;

// An attachment as nodemailer takes it: a file's bytes, or a raw MIME part (header and
// encoded body) written out exactly as given.
const attachmentOf = (a) =>
  a.raw
    ? { raw: a.raw }
    : { filename: a.filename, content: a.content, contentType: a.contentType };

/**
 * An RFC 5322 message with a text/plain UTF-8 body. `keepBcc` keeps the Bcc header (a
 * draft that is sent later); without it the recipients only see To and Cc.
 * `attachments` are files (`{ filename, content, contentType }`) or raw parts
 * (`{ raw }`), in this order; `html` adds an HTML alternative and `htmlRaw` one that
 * is a raw part.
 */
export async function composeMessage(message, { keepBcc }) {
  const parts = Boolean(
    message.attachments?.length || typeof message.html === "string" || message.htmlRaw,
  );
  const node = new MailComposer({
    from: message.from,
    to: message.to,
    cc: message.cc,
    bcc: message.bcc,
    subject: message.subject,
    // As an object even when empty: without a text part nodemailer would make the
    // first attachment, raw or not, the whole message.
    text: parts ? { content: message.body || Buffer.alloc(0) } : message.body,
    messageId: message.messageId,
    ...(message.date && { date: message.date }),
    ...(message.inReplyTo && { inReplyTo: message.inReplyTo }),
    ...(message.references?.length && { references: message.references }),
    ...(typeof message.html === "string" && { html: message.html }),
    ...(message.htmlRaw && { alternatives: [{ raw: message.htmlRaw }] }),
    ...(message.attachments?.length && {
      attachments: message.attachments.map(attachmentOf),
    }),
    disableFileAccess: true,
    disableUrlAccess: true,
  }).compile();
  node.keepBcc = keepBcc === true;
  return node.build();
}
