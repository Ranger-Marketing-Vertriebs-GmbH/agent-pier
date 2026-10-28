import { mailError } from "./mail-connection.js";
import { openFolder } from "./mail-folders.js";
import {
  attachmentsOf,
  decodeText,
  download,
  isAttachment,
  leafParts,
  summary,
  summaryQuery,
  textPart,
} from "./mail-messages.js";
import { attachmentLimits, messageParts } from "./mail-parts.js";
import { htmlQuote, htmlText } from "./mail-html.js";
import { draftFields } from "./mail-compose.js";
import { assistantProblem } from "../assistants/assistant-validation.js";

// Forwarding a received mail for an agent: the original's envelope, its text (plain,
// or its HTML as text), its HTML part when one of at most 1 MiB exists, and its
// attachments as raw parts that go out byte for byte; then the forward's fields with
// the quoted original below the agent's text. No In-Reply-To or References.

export const forwardBodyChars = 100_000;
const separator = "---------- Forwarded message ----------";
const prefixed = /^\s*(fwd?|wg)\s*:/i;
const controls = /[\u0000-\u001f\u007f\u2028\u2029]+/g;

const oneLine = (value) => String(value ?? "").replace(controls, " ");
const person = (a) =>
  a?.name ? `${oneLine(a.name)} <${oneLine(a.address)}>` : oneLine(a?.address);

/**
 * Message `uid` of `folder` (opened read-only) as `{ envelope: { from, to, date,
 * subject }, text, html, htmlOmitted, rawParts, parts }`: `text` the plain part (LF
 * line ends), or the HTML part as text (mail-html.js htmlText); `html` the HTML
 * part of at most 1 MiB as mail-html.js htmlQuote returns it, else null with
 * `htmlOmitted` (only the text goes along); with `includeAttachments` its attachments
 * as raw parts (`rawParts`) and `{ name, type, size, sha256 }` (`parts`). Text over
 * `forwardBodyChars`, or only HTML over 1 MiB or that cannot be quoted or read in
 * time, is MAIL_DRAFT_UNSUPPORTED, more than `maxFiles` attachments 400 `invalid` and more than `maxBytes` decoded
 * MAIL_ATTACHMENT_TOO_LARGE, before any attachment is fetched.
 */
export async function loadOriginal(
  client,
  folder,
  uid,
  {
    includeAttachments = true,
    maxBytes = attachmentLimits.mailBytes,
    maxFiles = attachmentLimits.files,
  } = {},
) {
  await openFolder(client, folder);
  const row = await client.fetchOne(String(uid), summaryQuery, { uid: true });
  if (!row || row.uid !== uid) throw mailError("MAIL_NOT_FOUND");
  const head = summary(row);
  const envelope = {
    from: head.from[0] ?? { name: "", address: "" },
    to: head.to,
    date: head.date,
    subject: head.subject,
  };
  const part = textPart(row.bodyStructure);
  const htmlNode = leafParts(row.bodyStructure).find(
    (n) => n.type === "text/html" && !isAttachment(n),
  );
  const read = async (node) => {
    const { bytes, limited } = await download(client, uid, node.part || "1");
    return { content: decodeText(bytes, node), limited };
  };
  // The HTML as sent (htmlQuote), null when over 1 MiB, beyond its bounds or not
  // quoted in time.
  let source = null;
  let html = null;
  if (htmlNode) {
    const got = await read(htmlNode);
    if (!got.limited) {
      html = await htmlQuote(got.content);
      if (html !== null) source = got.content;
    }
  }
  const htmlOmitted = Boolean(htmlNode) && html === null;
  let text = "";
  if (part?.type === "text/html") {
    // Only HTML: its text is all there is to quote, so it must be complete and read
    // in time.
    if (source === null) throw mailError("MAIL_DRAFT_UNSUPPORTED");
    const converted = await htmlText(source, forwardBodyChars + 1);
    if (converted.truncated || converted.tooComplex)
      throw mailError("MAIL_DRAFT_UNSUPPORTED");
    text = converted.text;
  } else if (part) {
    const got = await read(part);
    if (got.limited) throw mailError("MAIL_DRAFT_UNSUPPORTED");
    text = got.content.replace(/\r\n?/g, "\n");
  }
  if (text.length > forwardBodyChars) throw mailError("MAIL_DRAFT_UNSUPPORTED");
  let attachments = [];
  if (includeAttachments) {
    if (attachmentsOf(row.bodyStructure).length > maxFiles)
      throw assistantProblem("invalid");
    attachments = await messageParts(client, uid, { raw: true, maxBytes });
    if (attachments.reduce((sum, a) => sum + a.size, 0) > maxBytes)
      throw mailError("MAIL_ATTACHMENT_TOO_LARGE");
  }
  return {
    envelope,
    text: text.replaceAll("\u0000", "\ufffd"),
    html,
    htmlOmitted,
    rawParts: attachments.map((a) => a.raw),
    parts: attachments.map(({ name, type, size, sha256 }) => ({
      name,
      type,
      size,
      sha256,
    })),
  };
}

const escapeHtml = (text) =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
const htmlLines = (text) => escapeHtml(text).replace(/\n/g, "<br>\n");

/** The forward's subject: `Fwd: <original>` unless it already starts Fwd:, FW: or WG:. */
export function forwardSubject(original) {
  const subject = oneLine(original).trim();
  return (prefixed.test(subject) ? subject : `Fwd: ${subject}`).slice(0, 998);
}

/**
 * The forward's fields (draftFields) and HTML alternative for `original`
 * (loadOriginal): the agent's `body`, a blank line, the header block and the original
 * text; `subject` the agent's, else forwardSubject. `html` (null without an original
 * HTML part) is the agent's text escaped, the header block, then the original markup
 * (already sanitized by loadOriginal) in `<blockquote type="cite">`. A body over
 * `forwardBodyChars` is
 * MAIL_DRAFT_UNSUPPORTED; bad recipients or subject 400 `invalid`.
 */
export function forwardFields(original, { body = "", subject, to, cc, bcc }) {
  const { envelope } = original;
  const date = envelope.date ? new Date(envelope.date).toUTCString() : "";
  const header = [
    separator,
    `From: ${person(envelope.from)}`,
    `Date: ${date}`,
    `Subject: ${oneLine(envelope.subject)}`,
    `To: ${envelope.to.map(person).join(", ")}`,
  ].join("\n");
  const own = String(body).replace(/\r\n?/g, "\n");
  const text = `${own ? `${own}\n\n` : ""}${header}\n\n${original.text}`;
  if (text.length > forwardBodyChars) throw mailError("MAIL_DRAFT_UNSUPPORTED");
  const fields = draftFields({
    to,
    cc,
    bcc,
    subject: subject || forwardSubject(envelope.subject),
    body: text,
  });
  const html =
    original.html === null
      ? null
      : `${own ? `<p>${htmlLines(own)}</p>\n` : ""}<p>${htmlLines(header)}</p>\n<blockquote type="cite">${original.html}</blockquote>`;
  return { fields, html };
}
