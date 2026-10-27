// A small MIME reader for the fake IMAP server: the part tree with byte-exact header
// and body sections, ENVELOPE and BODYSTRUCTURE items, and the decoded text that
// SEARCH matches. Strings are latin1 so one character is one byte of the message.

const headerEnd = /\r?\n\r?\n/;

function splitHeaders(source) {
  const match = headerEnd.exec(source);
  if (!match) return { header: source, body: "" };
  const end = match.index + match[0].length;
  return { header: source.slice(0, end), body: source.slice(end) };
}

function parseHeaders(header) {
  const fields = new Map();
  for (const line of header.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (!fields.has(name)) fields.set(name, line.slice(colon + 1).trim());
  }
  return fields;
}

// Splits on `;` outside quotes; values keep their raw (possibly RFC 2231) form.
function parseParams(value = "") {
  const parts = [];
  let current = "";
  let quoted = false;
  for (const char of value) {
    if (char === '"') quoted = !quoted;
    if (char === ";" && !quoted) {
      parts.push(current);
      current = "";
    } else current += char;
  }
  parts.push(current);
  const [main, ...rest] = parts.map((p) => p.trim());
  const params = [];
  for (const part of rest) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    let val = part.slice(eq + 1).trim();
    if (val.startsWith('"')) val = val.slice(1, -1).replace(/\\(.)/g, "$1");
    params.push([part.slice(0, eq).trim().toLowerCase(), val]);
  }
  return { value: main.toLowerCase(), params };
}

function parsePart(source, path) {
  const { header, body } = splitHeaders(source);
  const headers = parseHeaders(header);
  const contentType = parseParams(headers.get("content-type") || "text/plain");
  const [type, subtype = "plain"] = contentType.value.split("/");
  const node = {
    path,
    header,
    body,
    headers,
    type: type || "text",
    subtype,
    params: contentType.params,
    disposition: headers.has("content-disposition")
      ? parseParams(headers.get("content-disposition"))
      : null,
    encoding: (headers.get("content-transfer-encoding") || "7bit").toLowerCase(),
    children: null,
  };
  const boundary = node.params.find(([key]) => key === "boundary")?.[1];
  if (node.type === "multipart" && boundary) {
    node.children = [];
    const delimiter = `--${boundary}`;
    const pieces = body.split(new RegExp(`\\r?\\n?${escape(delimiter)}`));
    // pieces[0] is the preamble; a piece starting with `--` closes the multipart.
    for (const piece of pieces.slice(1)) {
      if (piece.startsWith("--")) break;
      const content = piece.replace(/^[ \t]*\r?\n/, "");
      node.children.push(
        parsePart(content, [...path, node.children.length + 1].filter(Boolean)),
      );
    }
  }
  // An attached mail: its own header and parts, for ENVELOPE and BODYSTRUCTURE.
  if (node.type === "message" && node.subtype === "rfc822")
    node.inner = parsePart(body, path);
  return node;
}

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The parsed tree of a stored message, cached on it. */
export function parsed(message) {
  message.parsed ??= parsePart(message.raw.toString("latin1"), []);
  return message.parsed;
}

/** Finds a section like `1.2`; a single-part message's body is part `1`. */
export function partOf(message, path) {
  let node = parsed(message);
  for (const index of path.split(".").map(Number)) {
    if (!node.children) {
      if (index !== 1) return null;
      continue;
    }
    node = node.children[index - 1];
    if (!node) return null;
  }
  return node;
}

// --- IMAP item rendering. Each returns latin1 text, with literals for 8-bit data.

function nstring(value) {
  if (value === null || value === undefined) return "NIL";
  if (/^[\x20-\x7e]*$/.test(value) && !/["\\]/.test(value)) return `"${value}"`;
  if (/^[\x20-\x7e]*$/.test(value)) return `"${value.replace(/["\\]/g, "\\$&")}"`;
  return `{${value.length}}\r\n${value}`;
}

function splitAddresses(value) {
  const list = [];
  let current = "";
  let quoted = false;
  let angle = false;
  for (const char of value) {
    if (char === '"') quoted = !quoted;
    else if (char === "<" && !quoted) angle = true;
    else if (char === ">" && !quoted) angle = false;
    if (char === "," && !quoted && !angle) {
      list.push(current);
      current = "";
    } else current += char;
  }
  list.push(current);
  return list.map((item) => item.trim()).filter(Boolean);
}

/** `"Name" <a@b>` and `a@b` as { name, mailbox, host }. */
export function parseAddresses(value) {
  if (!value) return [];
  return splitAddresses(value).map((item) => {
    const angle = item.match(/^(.*)<([^>]*)>\s*$/);
    let name = angle ? angle[1].trim() : "";
    const address = (angle ? angle[2] : item).trim();
    if (name.startsWith('"') && name.endsWith('"'))
      name = name.slice(1, -1).replace(/\\(.)/g, "$1");
    const at = address.lastIndexOf("@");
    return { name, mailbox: address.slice(0, at), host: address.slice(at + 1) };
  });
}

function addressList(value) {
  const list = parseAddresses(value);
  if (!list.length) return "NIL";
  return `(${list
    .map(
      (a) => `(${nstring(a.name || null)} NIL ${nstring(a.mailbox)} ${nstring(a.host)})`,
    )
    .join("")})`;
}

export const envelope = (message) => envelopeOf(parsed(message).headers);

function envelopeOf(h) {
  const from = h.get("from");
  return `(${[
    nstring(h.get("date")),
    nstring(h.get("subject")),
    addressList(from),
    addressList(h.get("sender") || from),
    addressList(h.get("reply-to") || from),
    addressList(h.get("to")),
    addressList(h.get("cc")),
    addressList(h.get("bcc")),
    nstring(h.get("in-reply-to")),
    nstring(h.get("message-id")),
  ].join(" ")})`;
}

const paramList = (params) =>
  params.length
    ? `(${params.flatMap(([k, v]) => [nstring(k), nstring(v)]).join(" ")})`
    : "NIL";

function structure(node) {
  const disposition = node.disposition
    ? `(${nstring(node.disposition.value)} ${paramList(node.disposition.params)})`
    : "NIL";
  if (node.children)
    return `(${node.children.map(structure).join("")} ${nstring(node.subtype)} ${paramList(node.params)} ${disposition} NIL NIL)`;
  const count = ` ${node.body.split("\n").length}`;
  // message/rfc822 carries the attached mail's envelope, structure and line count.
  const extra = node.inner
    ? ` ${envelopeOf(node.inner.headers)} ${structure(node.inner)}${count}`
    : node.type === "text"
      ? count
      : "";
  return `(${nstring(node.type)} ${nstring(node.subtype)} ${paramList(node.params)} NIL NIL ${nstring(node.encoding)} ${node.body.length}${extra} NIL ${disposition} NIL NIL)`;
}

export const bodyStructure = (message) => structure(parsed(message));

// --- Decoded text for SEARCH.

const decoderFor = (charset) => {
  try {
    return new TextDecoder(charset || "utf-8");
  } catch {
    return new TextDecoder("utf-8");
  }
};

function transferDecode(body, encoding) {
  if (encoding === "base64")
    return Buffer.from(body.replace(/[^A-Za-z0-9+/=]/g, ""), "base64");
  if (encoding === "quoted-printable")
    return Buffer.from(
      body
        .replace(/=\r?\n/g, "")
        .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) =>
          String.fromCharCode(parseInt(hex, 16)),
        ),
      "latin1",
    );
  return Buffer.from(body, "latin1");
}

/** RFC 2047 encoded words decoded, as servers do before matching a header. */
export function decodeWords(value = "") {
  return value
    .replace(/\?=\s+=\?/g, "?==?")
    .replace(/=\?([^?]+)\?([bqBQ])\?([^?]*)\?=/g, (_, charset, kind, text) => {
      const bytes =
        kind.toUpperCase() === "B"
          ? Buffer.from(text, "base64")
          : transferDecode(text.replace(/_/g, " "), "quoted-printable");
      return decoderFor(charset).decode(bytes);
    });
}

function textParts(node) {
  if (node.children) return node.children.flatMap(textParts);
  if (node.type !== "text") return [];
  const charset = node.params.find(([key]) => key === "charset")?.[1];
  return [decoderFor(charset).decode(transferDecode(node.body, node.encoding))];
}

/** The decoded headers and the decoded text parts, for TEXT and BODY. */
export function searchable(message) {
  const root = parsed(message);
  message.searchable ??= {
    headers: decodeWords(root.header.replace(/\r?\n[ \t]+/g, " ")),
    body: textParts(root).join("\n"),
  };
  return message.searchable;
}
