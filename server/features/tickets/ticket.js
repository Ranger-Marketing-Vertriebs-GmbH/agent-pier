export const TICKET_SOURCE_IDS = Object.freeze(["github", "plane"]);

const BODY_LIMIT = 16000;
const TITLE_LIMIT = 500;
const LABEL_LIMIT = 100;
const LABEL_COUNT = 50;
// Everything except tab (\t) and newline (\n).
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

function text(value) {
  return typeof value === "string"
    ? value.replace(/\r\n?/g, "\n").replace(CONTROL, "")
    : "";
}

const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };

export function htmlToText(html) {
  return String(html ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|li)\s*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => ENTITIES[entity])
    .trim();
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
    title: text(raw.title).replace(/\n/g, " ").trim().slice(0, TITLE_LIMIT),
    body: truncated ? body.slice(0, BODY_LIMIT) : body,
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
    title: String(ticket.title ?? "").slice(0, 200),
    url: ticket.url ?? "",
  };
}
