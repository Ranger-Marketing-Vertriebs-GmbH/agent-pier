import { createHash } from "node:crypto";
import { mailError } from "./mail-connection.js";
import { openFolder } from "./mail-folders.js";
import { attachmentsOf, fileName } from "./mail-messages.js";
import { decodedEstimate } from "./mail-shared.js";

// Attachment parts of stored mail: their raw bytes as the server keeps them (MIME
// header and encoded body), decoded bytes and digests, within fixed size limits.
// A raw part is what a forward or a kept draft attachment carries unchanged; it is
// never decoded and encoded again.

export const attachmentLimits = Object.freeze({
  mailBytes: 26_214_400,
  fileBytes: 26_214_400,
  files: 20,
});

/** The SHA-256 hex digest of `bytes`. */
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// imapflow's client.download also removes the transfer encoding, but it converts text
// parts to UTF-8 and needs one more FETCH per part; raw parts already fetched are
// decoded here instead, so the digest covers the attachment's exact bytes.

/**
 * The body of a part without its Content-Transfer-Encoding: base64, quoted-printable,
 * or 7bit/8bit/binary as is. Any other encoding is MAIL_PROTOCOL.
 */
export function decodeTransfer(body, encoding) {
  const name = String(encoding || "7bit")
    .trim()
    .toLowerCase();
  if (name === "base64")
    return Buffer.from(body.toString("latin1").replace(/[^A-Za-z0-9+/=]/g, ""), "base64");
  if (name === "quoted-printable") {
    const text = body.toString("latin1").replace(/=\r?\n/g, "");
    const out = Buffer.alloc(text.length);
    let size = 0;
    for (let i = 0; i < text.length; i++) {
      const hex = text[i] === "=" ? text.slice(i + 1, i + 3) : "";
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        out[size++] = parseInt(hex, 16);
        i += 2;
      } else out[size++] = text.charCodeAt(i);
    }
    return out.subarray(0, size);
  }
  if (["7bit", "8bit", "binary"].includes(name)) return Buffer.from(body);
  throw mailError("MAIL_PROTOCOL");
}

/** An attachment node of a BODYSTRUCTURE as `{ part, name, type, size, encoding, charset }`. */
export function partInfo(node) {
  return {
    // The message itself is the attachment (no multipart): its MIME header is the
    // message's header, which a raw part must not carry along.
    ...(!node.part && { root: true }),
    part: node.part || "1",
    name: fileName(node),
    type: String(node.type || "application/octet-stream"),
    size: decodedEstimate(node),
    encoding: String(node.encoding || "7bit").toLowerCase(),
    charset: node.parameters?.charset ?? null,
  };
}

/**
 * The fewest bytes `info` can decode to: base64 estimates count line breaks too, so
 * lines of 64 characters (the shortest common) are assumed; quoted-printable takes
 * at most 3 characters per byte.
 */
export function decodedAtLeast(info) {
  if (info.encoding === "base64") return Math.floor((info.size * 64) / 66);
  if (info.encoding === "quoted-printable") return Math.floor(info.size / 3);
  return info.size;
}

/**
 * The raw bytes (MIME header, then body as stored) of `parts` of message `uid` in the
 * selected folder, from one FETCH. A part the server does not have is MAIL_NOT_FOUND.
 */
export async function fetchRawParts(client, uid, parts) {
  const raws = new Map();
  if (!parts.length) return raws;
  const row = await client.fetchOne(
    String(uid),
    { uid: true, bodyParts: parts.flatMap((p) => [`${p}.mime`, p]) },
    { uid: true },
  );
  if (!row || row.uid !== uid) throw mailError("MAIL_NOT_FOUND");
  for (const part of parts) {
    const mime = row.bodyParts?.get(`${part}.mime`);
    const body = row.bodyParts?.get(part);
    if (!mime?.length || !body) throw mailError("MAIL_NOT_FOUND");
    raws.set(part, Buffer.concat([mime, body]));
  }
  return raws;
}

// The body of a raw part: everything after its header's blank line.
function rawBody(raw) {
  const text = raw.toString("latin1");
  const end = /\r?\n\r?\n/.exec(text);
  return end ? raw.subarray(end.index + end[0].length) : Buffer.alloc(0);
}

/** The transfer encoding a raw part declares (7bit when it names none). */
function rawEncoding(raw) {
  const header = raw.toString("latin1").split(/\r?\n\r?\n/)[0];
  const match = header
    .replace(/\r?\n[ \t]+/g, " ")
    .match(/^content-transfer-encoding:[ \t]*([^\s;]+)/im);
  return match?.[1] ?? "7bit";
}

// A message that is one attachment: only its Content-* header fields, then its body.
function contentOnly(raw) {
  const text = raw.toString("latin1");
  const end = /\r?\n\r?\n/.exec(text);
  const header = end ? text.slice(0, end.index) : text;
  const fields = header
    .split(/\r?\n(?![ \t])/)
    .filter((field) => /^content-[\w-]*:/i.test(field));
  return Buffer.concat([
    Buffer.from(`${fields.join("\r\n")}\r\n\r\n`, "latin1"),
    rawBody(raw),
  ]);
}

/** The decoded bytes of a raw part (header and body, as fetchRawParts returns it). */
export const decodedRaw = (raw) => decodeTransfer(rawBody(raw), rawEncoding(raw));

/**
 * The attachments of message `uid` in the selected folder, in attachmentsOf order, as
 * `{ part, name, type, size, sha256, partSha256 }` (`raw` too with `raw: true`):
 * `size` and `sha256` of the decoded bytes, `partSha256` of the raw part. Attachments
 * that would decode to more than `maxBytes` together are MAIL_ATTACHMENT_TOO_LARGE
 * before any of them is fetched; attachments named exactly in `skipNames` are left
 * out first, neither counted nor fetched. A message that is one attachment keeps only
 * the Content-* fields of its header.
 */
export async function messageParts(
  client,
  uid,
  { raw = false, maxBytes = attachmentLimits.mailBytes, skipNames = [] } = {},
) {
  const row = await client.fetchOne(
    String(uid),
    { uid: true, bodyStructure: true },
    { uid: true },
  );
  if (!row || row.uid !== uid) throw mailError("MAIL_NOT_FOUND");
  const infos = attachmentsOf(row.bodyStructure)
    .map(partInfo)
    .filter((info) => !skipNames.includes(info.name));
  const atLeast = infos.reduce((sum, info) => sum + decodedAtLeast(info), 0);
  if (atLeast > maxBytes) throw mailError("MAIL_ATTACHMENT_TOO_LARGE");
  const raws = await fetchRawParts(
    client,
    uid,
    infos.map((info) => info.part),
  );
  return infos.map(({ part, name, type, encoding, root }) => {
    const bytes = root ? contentOnly(raws.get(part)) : raws.get(part);
    const decoded = decodeTransfer(rawBody(bytes), encoding);
    return {
      part,
      name,
      type,
      size: decoded.length,
      sha256: sha256(decoded),
      partSha256: sha256(bytes),
      ...(raw && { raw: bytes }),
    };
  });
}

/**
 * The decoded bytes of the attachment `info` (partInfo) of message `uid` in the
 * selected folder, without opening it or fetching its BODYSTRUCTURE again, as
 * `{ bytes, fetched, uidValidity }`: `fetched` is the size of the encoded body, as
 * BODYSTRUCTURE gives it before the download,
 * `uidValidity` is the folder's after the FETCH. More than `maxBytes` decoded is
 * MAIL_ATTACHMENT_TOO_LARGE, carrying that `uidValidity` too.
 */
export async function partBytes(client, uid, info, { maxBytes }) {
  const raw = (await fetchRawParts(client, uid, [info.part])).get(info.part);
  const uidValidity = String(client.mailbox?.uidValidity ?? "");
  const body = rawBody(raw);
  const bytes = decodeTransfer(body, info.encoding);
  if (bytes.length > maxBytes)
    throw Object.assign(mailError("MAIL_ATTACHMENT_TOO_LARGE"), { uidValidity });
  return { bytes, fetched: body.length, uidValidity };
}

/**
 * The attachment `part` of message `uid` in `folder` (opened read-only), without
 * downloading it: `{ info, uidValidity }`, `info` as partInfo and `uidValidity` the
 * folder's once opened. A part that is no attachment is MAIL_NOT_FOUND.
 */
export async function attachmentPart(client, folder, uid, part) {
  await openFolder(client, folder);
  const uidValidity = String(client.mailbox?.uidValidity ?? "");
  const row = await client.fetchOne(
    String(uid),
    { uid: true, bodyStructure: true },
    { uid: true },
  );
  if (!row || row.uid !== uid) throw mailError("MAIL_NOT_FOUND");
  const node = attachmentsOf(row.bodyStructure).find((n) => (n.part || "1") === part);
  if (!node) throw mailError("MAIL_NOT_FOUND");
  return { info: partInfo(node), uidValidity };
}

/**
 * The decoded bytes of attachment `part` of message `uid` in `folder` (opened
 * read-only) as `{ name, type, charset, bytes, uidValidity }`. More than `maxBytes`,
 * estimated or decoded, is MAIL_ATTACHMENT_TOO_LARGE; a part that is no attachment
 * MAIL_NOT_FOUND.
 */
export async function attachmentBytes(client, folder, uid, part, { maxBytes }) {
  const { info } = await attachmentPart(client, folder, uid, part);
  if (decodedAtLeast(info) > maxBytes) throw mailError("MAIL_ATTACHMENT_TOO_LARGE");
  const { bytes, uidValidity } = await partBytes(client, uid, info, { maxBytes });
  return { name: info.name, type: info.type, charset: info.charset, bytes, uidValidity };
}
