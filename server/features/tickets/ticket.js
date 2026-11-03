export const TICKET_SOURCE_IDS = Object.freeze(["github", "plane"]);

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

export function htmlToText(html) {
  return String(html ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|li)\s*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(?:amp|lt|gt|quot|#39|#x27|nbsp);/g, (entity) => ENTITIES[entity])
    .trim();
}

// Cut without splitting a surrogate pair.
function cutAt(value, limit) {
  const end = /[\ud800-\udbff]/.test(value[limit - 1] ?? "") ? limit - 1 : limit;
  return value.slice(0, end);
}

function httpUrl(value) {
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
