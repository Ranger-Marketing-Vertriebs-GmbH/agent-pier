import { mailError } from "./mail-connection.js";
import { openFolder } from "./mail-folders.js";
import { clipText } from "./mail-text.js";
import { htmlText } from "./mail-html.js";

// Listing and reading mail for agents, always within fixed bounds: a page of at most
// `limit` summaries, at most 1 MiB of one text part downloaded and 32 000 characters
// returned. Folders are opened read-only and parts fetched with BODY.PEEK, so reading
// never sets \Seen.

export const mailBounds = Object.freeze({
  textChars: 32_000,
  partBytes: 1_048_576,
  subjectChars: 300,
  addresses: 50,
  attachments: 50,
  nameChars: 200,
  headerChars: 998,
  // BODYSTRUCTURE leaves looked at per message; a hostile server cannot make us walk more.
  parts: 500,
});

export const summaryQuery = Object.freeze({
  uid: true,
  flags: true,
  envelope: true,
  bodyStructure: true,
  internalDate: true,
  size: true,
});

const cut = (value, max) => clipText(String(value ?? ""), max).text;

const addresses = (list) =>
  (list || []).slice(0, mailBounds.addresses).map((a) => ({
    name: cut(a.name, mailBounds.nameChars),
    address: cut(a.address, 320),
  }));

const validDate = (value) =>
  value instanceof Date && !Number.isNaN(value.getTime()) ? value : null;

/** The leaf parts of a BODYSTRUCTURE, depth-first, at most `mailBounds.parts`. */
export function leafParts(structure) {
  const leaves = [];
  const stack = structure ? [structure] : [];
  while (stack.length && leaves.length < mailBounds.parts) {
    const node = stack.pop();
    // An attached mail (message/rfc822) or attached multipart is one attachment: its
    // own parts are neither listed nor read as the message's text.
    if (
      node.childNodes?.length &&
      node.type !== "message/rfc822" &&
      node.disposition !== "attachment"
    ) {
      for (let i = node.childNodes.length - 1; i >= 0; i--)
        stack.push(node.childNodes[i]);
    } else leaves.push(node);
  }
  return leaves;
}

/** An attachment's file name (RFC 2231/2047 already decoded by imapflow), or null. */
export const fileName = (node) =>
  node.dispositionParameters?.filename || node.parameters?.name || null;

/**
 * A part counts as an attachment when it is marked so, is an attached mail, or
 * carries a file name and is no text part (an inline image with a name, for instance).
 */
export const isAttachment = (node) =>
  node.disposition === "attachment" ||
  node.type === "message/rfc822" ||
  (!!fileName(node) && !String(node.type).startsWith("text/"));

export const attachmentsOf = (structure) => leafParts(structure).filter(isAttachment);

// Decoded size estimate: base64 carries 3 bytes in 4 characters.
const partSize = (node) =>
  node.encoding === "base64" ? Math.floor(((node.size || 0) * 3) / 4) : node.size || 0;

/** A message's summary from a FETCH of `summaryQuery`. */
export function summary(row) {
  const envelope = row.envelope || {};
  const flags = row.flags || new Set();
  const date = validDate(envelope.date) || validDate(row.internalDate);
  return {
    uid: row.uid,
    from: addresses(envelope.from),
    to: addresses(envelope.to),
    subject: cut(envelope.subject, mailBounds.subjectChars),
    date: date ? date.toISOString() : null,
    unseen: !flags.has("\\Seen"),
    flagged: flags.has("\\Flagged"),
    size: Number(row.size) || 0,
    hasAttachments: attachmentsOf(row.bodyStructure).length > 0,
  };
}

/** Summaries of `uids`, newest first. */
export async function fetchSummaries(client, uids) {
  if (!uids.length) return [];
  const rows = await client.fetchAll(uids.join(","), summaryQuery, { uid: true });
  return rows.map(summary).sort((a, b) => b.uid - a.uid);
}

/** UID SEARCH; a refused search is MAIL_PROTOCOL unless the caller knows better. */
export async function uidSearch(client, query, failure = "MAIL_PROTOCOL") {
  const uids = await client.search(query, { uid: true });
  if (!Array.isArray(uids)) throw mailError(failure);
  return uids;
}

/**
 * A page of `folder`, newest first. `before` is the cursor of the previous page (its
 * lowest UID); the returned `cursor` is null when nothing older is left.
 */
export async function listMessages(client, { folder, limit, before }) {
  const box = await openFolder(client, folder);
  if (!box.exists || before === 1) return { messages: [], cursor: null };
  let page;
  let older;
  if (before) {
    const uids = await uidSearch(client, { uid: `1:${before - 1}` });
    const below = uids.filter((uid) => uid < before);
    page = below.slice(-limit);
    older = below.length > page.length;
  } else {
    // The newest messages by sequence number: no UID list of the whole folder.
    const first = Math.max(1, box.exists - limit + 1);
    const rows = await client.fetchAll(`${first}:*`, summaryQuery);
    const messages = rows
      .map(summary)
      .sort((a, b) => b.uid - a.uid)
      .slice(0, limit);
    const lowest = messages.at(-1)?.uid;
    return { messages, cursor: first > 1 && lowest ? String(lowest) : null };
  }
  const messages = await fetchSummaries(client, page);
  return { messages, cursor: older && page.length ? String(page[0]) : null };
}

/**
 * Unseen INBOX mail above the cursor: the oldest `limit` of it, newest first, with
 * how many remain. Without a cursor or after a UIDVALIDITY change the newest `limit`
 * unseen messages are the baseline and the cursor moves to the highest UID, so a first
 * run never floods.
 */
export async function newMessages(client, cursor, limit) {
  const box = await openFolder(client, "INBOX");
  const uidValidity = String(box.uidValidity);
  const uidNext = Number(box.uidNext) || 0;
  if (!cursor || cursor.uidValidity !== uidValidity) {
    const unseen = await uidSearch(client, { seen: false });
    const shown = unseen.slice(-limit);
    const lastUid = Math.max(uidNext - 1, unseen.at(-1) ?? 0, 0);
    return {
      messages: await fetchSummaries(client, shown),
      remaining: 0,
      next: { uidValidity, lastUid },
    };
  }
  if (uidNext && uidNext - 1 <= cursor.lastUid)
    return { messages: [], remaining: 0, next: cursor };
  // `n:*` always matches the highest UID, even below n.
  const found = (
    await uidSearch(client, { seen: false, uid: `${cursor.lastUid + 1}:*` })
  ).filter((uid) => uid > cursor.lastUid);
  const shown = found.slice(0, limit);
  return {
    messages: await fetchSummaries(client, shown),
    remaining: found.length - shown.length,
    next: { uidValidity, lastUid: shown.at(-1) ?? cursor.lastUid },
  };
}

/** The first text/plain part not marked as an attachment, else the first text/html. */
export function textPart(structure) {
  const leaves = leafParts(structure).filter((n) => n.disposition !== "attachment");
  return (
    leaves.find((n) => n.type === "text/plain") ||
    leaves.find((n) => n.type === "text/html")
  );
}

// At most `partBytes` of the part, decoded to UTF-8 by imapflow, never the whole part;
// one byte more is fetched so that a part of exactly `partBytes` is not `limited`.
export async function download(client, uid, part) {
  const { content } = await client.download(String(uid), part, {
    uid: true,
    maxBytes: mailBounds.partBytes + 1,
  });
  if (!content) return { bytes: Buffer.alloc(0), limited: false };
  const chunks = [];
  let size = 0;
  for await (const chunk of content) {
    chunks.push(chunk);
    size += chunk.length;
  }
  const bytes = Buffer.concat(chunks);
  return size > mailBounds.partBytes
    ? { bytes: bytes.subarray(0, mailBounds.partBytes), limited: true }
    : { bytes, limited: false };
}

const metaCharset = /<meta\b[^>]*?charset\s*=\s*["']?\s*([\w.:-]+)/i;

/**
 * The part's text. imapflow converts a declared charset to UTF-8; an HTML part
 * without one may name its charset in a `<meta>` tag within its first 4 KiB.
 */
export function decodeText(bytes, part) {
  if (part.type === "text/html" && !part.parameters?.charset) {
    const label = bytes.subarray(0, 4096).toString("latin1").match(metaCharset)?.[1];
    if (label)
      try {
        return new TextDecoder(label).decode(bytes);
      } catch {}
  }
  return bytes.toString("utf8");
}

/**
 * One message with its text (plain, or HTML as text) and each attachment's part,
 * name, type and approximate size, never its content.
 */
export async function readMessage(client, folder, uid) {
  await openFolder(client, folder);
  const row = await client.fetchOne(String(uid), summaryQuery, { uid: true });
  if (!row || row.uid !== uid) throw mailError("MAIL_NOT_FOUND");
  const envelope = row.envelope || {};
  const part = textPart(row.bodyStructure);
  let text = { text: "", truncated: false };
  if (part) {
    const { bytes, limited } = await download(client, uid, part.part || "1");
    const body = decodeText(bytes, part);
    text =
      part.type === "text/html"
        ? await htmlText(body, mailBounds.textChars)
        : clipText(body.replace(/\r\n?/g, "\n"), mailBounds.textChars);
    if (limited) text = { ...text, truncated: true };
  }
  return {
    ...summary(row),
    cc: addresses(envelope.cc),
    replyTo: addresses(envelope.replyTo),
    messageId: cut(envelope.messageId, mailBounds.headerChars) || null,
    inReplyTo: cut(envelope.inReplyTo, mailBounds.headerChars) || null,
    text: text.text,
    truncated: text.truncated,
    // The HTML-only text could not be read: too many tags or nested too deeply.
    ...(text.tooComplex && { htmlTooComplex: true }),
    attachments: attachmentsOf(row.bodyStructure)
      .slice(0, mailBounds.attachments)
      .map((node) => ({
        part: node.part || "1",
        name: cut(fileName(node), mailBounds.nameChars) || null,
        size: partSize(node),
        type: String(node.type || "application/octet-stream"),
      })),
  };
}
