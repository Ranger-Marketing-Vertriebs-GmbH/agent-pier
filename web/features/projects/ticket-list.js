import { pipelineRunRoute } from "./routes.js";

/** The tickets shown for a label filter and a source filter ("" keeps all). */
export function visibleTickets(tickets, { label = "", source = "" } = {}) {
  return (Array.isArray(tickets) ? tickets : []).filter(
    (ticket) =>
      (!source || ticket.source === source) &&
      (!label || (ticket.labels || []).includes(label)),
  );
}

/** The newest start record of `ticket` (same source and key), or null. */
export function startOf(starts, ticket) {
  let newest = null;
  for (const start of Array.isArray(starts) ? starts : [])
    if (
      start.source === ticket.source &&
      start.key === ticket.key &&
      (!newest || start.startedAt > newest.startedAt)
    )
      newest = start;
  return newest;
}

/** The route that opens what a start created: its session or its pipeline run. */
export function startRoute(start) {
  return start.kind === "pipeline"
    ? pipelineRunRoute(start.targetId)
    : { view: "workspace", sessionId: start.targetId };
}

/** Whether each source of a project's ticket view is connected. */
export function sourceStates(view) {
  return {
    github: view?.sources?.github?.state === "connected",
    plane: view?.sources?.plane?.state === "connected",
  };
}

/** Why the server refused a ticket start: "started", "starting" or null. */
export function startRefusal(error) {
  if (error?.status !== 409) return null;
  if (error.messageKey === "tickets.alreadyStarted") return "started";
  if (error.messageKey === "tickets.alreadyStarting") return "starting";
  return null;
}

/** The request path of a project's ticket start. */
export const ticketStartPath = (projectId) =>
  `/tickets/projects/${encodeURIComponent(projectId)}/start`;

const TITLE_MAX = 80;

/** "<key> · <title>" with the title cut at 80 characters; "" without a ticket key. */
export function ticketLinkLabel(ticket) {
  if (!ticket || typeof ticket.key !== "string" || !ticket.key) return "";
  const title = typeof ticket.title === "string" ? ticket.title.trim() : "";
  if (!title) return ticket.key;
  const chars = [...title];
  return `${ticket.key} · ${chars.length > TITLE_MAX ? `${chars.slice(0, TITLE_MAX).join("")}…` : title}`;
}

/** The ticket's URL when it is http(s), else "". */
export function ticketHref(ticket) {
  try {
    const url = new URL(ticket?.url);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}
