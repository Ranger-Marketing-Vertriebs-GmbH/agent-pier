export const TICKET_SOURCE_IDS = Object.freeze(["github", "plane"]);

/** The one spelling every rule label comparison uses. */
export const labelKey = (name) =>
  String(name ?? "")
    .trim()
    .toLowerCase();

export const BODY_LIMIT = 16000;
const TITLE_LIMIT = 500;
const LABEL_LIMIT = 100;
const LABEL_COUNT = 50;
// Everything except tab (\t) and newline (\n).
// Also line/paragraph separators, bidi controls and zero-width characters.
const CONTROL =
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\u200b-\u200d\ufeff]/g;

function text(value) {
  return typeof value === "string"
    ? value.replace(/\r\n?/g, "\n").replace(CONTROL, "")
    : "";
}

const ENTITIES = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&#x27;": "'",
  "&nbsp;": " ",
};

// Strips tags until none is left, so nested fragments such as "<scr<b>ipt>" cannot
// reassemble into a tag. The result is plain text; entities are decoded last, in one
// pass, so "&amp;lt;" stays the literal text "&lt;".
export function htmlToText(html) {
  let text = String(html ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|li)\s*>/gi, "\n");
  let previous;
  do {
    previous = text;
    text = text.replace(/<[^<>]*>/g, "");
  } while (text !== previous);
  return text
    .replace(/&(?:amp|lt|gt|quot|#39|#x27|nbsp);/g, (entity) => ENTITIES[entity])
    .trim();
}

// Cut without splitting a surrogate pair.
function cutAt(value, limit) {
  const end = /[\ud800-\udbff]/.test(value[limit - 1] ?? "") ? limit - 1 : limit;
  return value.slice(0, end);
}

/** One line of untrusted forge text: control characters and newlines removed, capped. */
export function plainLine(value, limit) {
  return cutAt(
    text(value)
      .replace(/[\t\n]/g, " ")
      .trim(),
    limit,
  );
}

export function httpUrl(value) {
  try {
    const url = new URL(String(value ?? ""));
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

export function cleanTicket(raw = {}) {
  const body = text(raw.body).trim();
  const truncated = body.length > BODY_LIMIT;
  const labels = [];
  for (const label of Array.isArray(raw.labels) ? raw.labels : []) {
    const name = text(typeof label === "string" ? label : "").trim();
    if (name && name.length <= LABEL_LIMIT && !labels.includes(name)) labels.push(name);
    if (labels.length >= LABEL_COUNT) break;
  }
  const ticket = {
    source: String(raw.source ?? ""),
    key: text(String(raw.key ?? "")).trim(),
    number: Number.isFinite(Number(raw.number)) ? Number(raw.number) : 0,
    id: String(raw.id ?? ""),
    title: cutAt(text(raw.title).replace(/\n/g, " ").trim(), TITLE_LIMIT),
    body: truncated ? cutAt(body, BODY_LIMIT) : body,
    url: httpUrl(raw.url),
    labels,
    state: text(typeof raw.state === "string" ? raw.state : "").trim(),
    updatedAt: String(raw.updatedAt ?? ""),
  };
  // Plane's state id: "already started" and "already done" compare it, since two
  // states may share a name.
  const stateId = text(typeof raw.stateId === "string" ? raw.stateId : "").trim();
  if (stateId) ticket.stateId = stateId.slice(0, 100);
  if (truncated) ticket.truncated = true;
  return ticket;
}

export function ticketRef(ticket) {
  return {
    source: ticket.source,
    key: ticket.key,
    title: cutAt(String(ticket.title ?? ""), 200),
    url: ticket.url ?? "",
  };
}

/** A ticket reference a session or run keeps, or null when it is not a valid one. */
export function validTicketRef(value) {
  if (
    !value ||
    typeof value !== "object" ||
    !TICKET_SOURCE_IDS.includes(value.source) ||
    typeof value.key !== "string" ||
    !value.key ||
    value.key.length > 200 ||
    typeof value.title !== "string" ||
    value.title.length > 200 ||
    typeof value.url !== "string" ||
    value.url.length > 2000 ||
    (value.url !== "" && httpUrl(value.url) === "")
  )
    return null;
  return {
    source: value.source,
    key: value.key,
    title: value.title,
    url: httpUrl(value.url),
  };
}
