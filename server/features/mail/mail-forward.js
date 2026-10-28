import { parse, serialize } from "parse5";
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
import { htmlToText } from "./mail-text.js";
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
 * line ends), or the HTML part as text; `html` the HTML part of at most 1 MiB as
 * quotedHtml returns it, else null with `htmlOmitted` (only the text goes along); with `includeAttachments` its
 * attachments as raw parts (`rawParts`) and `{ name, type, size, sha256 }` (`parts`).
 * Text over `forwardBodyChars` or only HTML over 1 MiB or beyond quoteBounds is
 * MAIL_DRAFT_UNSUPPORTED,
 * more than `maxFiles` attachments 400 `invalid` and more than `maxBytes` decoded
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
  // The HTML as sent (quotedHtml), null when over 1 MiB or not quotable.
  let source = null;
  let html = null;
  if (htmlNode) {
    const got = await read(htmlNode);
    if (!got.limited) {
      html = quotedHtml(got.content);
      if (html !== null) source = got.content;
    }
  }
  const htmlOmitted = Boolean(htmlNode) && html === null;
  let text = "";
  if (part?.type === "text/html") {
    // Only HTML: its text is all there is to quote, so it must be complete and
    // within quoteBounds.
    if (source === null) throw mailError("MAIL_DRAFT_UNSUPPORTED");
    const converted = htmlToText(source, forwardBodyChars + 1);
    if (converted.truncated) throw mailError("MAIL_DRAFT_UNSUPPORTED");
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

// Elements of the original's HTML that could reach beyond its quote (a base URL,
// styles of the whole forward, refreshes, scripts, embedded or active content) are
// dropped, and so are comments (Outlook honors conditional ones) and every inline
// style, which could move, cover or hide the agent's own text.
const droppedTags = new Set([
  "base",
  "script",
  "style",
  "meta",
  "link",
  "iframe",
  "form",
  "object",
  "embed",
  "plaintext",
]);
// Parsing is quadratic in the nesting depth and the serializer recurses, so a
// hostile mail could block the server: HTML with more tags or deeper nesting than
// this is not parsed and goes along as text only. Ordinary newsletters stay far
// below both.
export const quoteBounds = Object.freeze({ tags: 20_000, depth: 500 });
const voidTags = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);
// Elements whose end tag is optional: an unclosed one does not nest deeper.
const openEnded = new Set(["p", "li", "td", "th", "tr", "dt", "dd", "option"]);
const tagPattern = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)[^<>]*?(\/?)>/g;

/**
 * Whether `html` is within quoteBounds, by one linear scan: at most `tags` start tags
 * and an estimated nesting depth of at most `depth` (start tags that are not void,
 * self-closed or open-ended count up, end tags down).
 */
export function quotable(html) {
  let tags = 0;
  let depth = 0;
  for (const [, end, name, selfClosed] of html.matchAll(tagPattern)) {
    const tag = name.toLowerCase();
    if (end) {
      if (!voidTags.has(tag) && !openEnded.has(tag)) depth = Math.max(0, depth - 1);
      continue;
    }
    if (++tags > quoteBounds.tags) return false;
    if (selfClosed || voidTags.has(tag) || openEnded.has(tag)) continue;
    if (++depth > quoteBounds.depth) return false;
  }
  return true;
}

/**
 * The original's HTML as quoted, or null when it is not quotable or cannot be
 * parsed: only the content of its `<body>`, without comments, inline styles and the
 * droppedTags elements, so it cannot restyle or hide what stands above the quote.
 */
export function quotedHtml(html) {
  const source = String(html);
  if (!quotable(source)) return null;
  try {
    const document = parse(source);
    const root = document.childNodes.find((n) => n.nodeName === "html");
    const body = root?.childNodes.find((n) => n.nodeName === "body");
    if (!body) return "";
    const stack = [body];
    while (stack.length) {
      const node = stack.pop();
      if (!node.childNodes) continue;
      node.childNodes = node.childNodes.filter(
        (child) => !droppedTags.has(child.nodeName) && child.nodeName !== "#comment",
      );
      for (const child of node.childNodes) {
        if (child.attrs) child.attrs = child.attrs.filter((a) => a.name !== "style");
        stack.push(child.content ?? child);
      }
    }
    return serialize(body);
  } catch {
    return null;
  }
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
 * (loadOriginal: already quotedHtml) in `<blockquote type="cite">`. A body over `forwardBodyChars` is
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
