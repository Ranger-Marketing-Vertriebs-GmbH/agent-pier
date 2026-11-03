import { cleanTicket, htmlToText } from "../ticket.js";
import { requestJson, TicketSourceError } from "../http-json.js";

const PAGE_SIZE = 100;
const MAX_PAGES = 5;
const CLOSED_GROUPS = new Set(["completed", "cancelled"]);
const KEY = /^([A-Z0-9]{1,12})-([1-9]\d{0,8})$/;

export function planeWebUrl(baseUrl) {
  const base = String(baseUrl ?? "").replace(/\/+$/, "");
  return base === "https://api.plane.so" ? "https://app.plane.so" : base;
}

function call(access, path, options = {}) {
  return requestJson({
    fetchImpl: access.fetchImpl,
    url: `${String(access.baseUrl).replace(/\/+$/, "")}/api/v1/workspaces/${path}`,
    headers: { "X-API-Key": access.token, Accept: "application/json" },
    ...options,
  });
}

function slugPath(access) {
  return encodeURIComponent(access.workspaceSlug);
}

function projectPath(access) {
  return `${slugPath(access)}/projects/${encodeURIComponent(access.projectId)}`;
}

// Reads a cursor-paginated collection; also accepts a bare array.
async function readPages(access, path, query, signal) {
  const rows = [];
  let cursor = "";
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const params = `per_page=${PAGE_SIZE}${query}${
      cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
    }`;
    const { data } = await call(access, `${path}?${params}`, { signal });
    if (Array.isArray(data)) {
      rows.push(...data);
      break;
    }
    if (!data || typeof data !== "object" || !Array.isArray(data.results))
      throw new TicketSourceError("invalidResponse");
    rows.push(...data.results);
    if (!data.next_page_results || !data.next_cursor) break;
    cursor = String(data.next_cursor);
  }
  return rows;
}

function normalizeStates(rows) {
  return rows
    .filter((row) => row && typeof row.id === "string")
    .map((row) => ({
      id: row.id,
      name: String(row.name ?? ""),
      group: String(row.group ?? ""),
      sequence: Number(row.sequence) || 0,
    }));
}

async function readStates(access, signal) {
  return normalizeStates(
    await readPages(access, `${projectPath(access)}/states/`, "", signal),
  );
}

async function readLabelNames(access, signal) {
  const rows = await readPages(access, `${projectPath(access)}/labels/`, "", signal);
  return new Map(rows.filter((r) => r?.id).map((r) => [r.id, String(r.name ?? "")]));
}

function toTicket(access, item, { states, labelNames }) {
  const identifier = access.identifier;
  const key = `${identifier}-${item.sequence_id}`;
  let state = "";
  let group = "";
  if (item.state && typeof item.state === "object") {
    state = String(item.state.name ?? "");
    group = String(item.state.group ?? "");
  } else if (typeof item.state === "string") {
    const known = states?.find((s) => s.id === item.state);
    state = known?.name ?? "";
    group = known?.group ?? "";
  }
  const labels = (Array.isArray(item.labels) ? item.labels : []).map((label) =>
    label && typeof label === "object" ? label.name : labelNames?.get(label),
  );
  const stripped =
    typeof item.description_stripped === "string" ? item.description_stripped.trim() : "";
  const ticket = cleanTicket({
    source: "plane",
    key,
    number: item.sequence_id,
    id: item.id,
    title: item.name,
    body: stripped || htmlToText(item.description_html),
    url: `${planeWebUrl(access.baseUrl)}/${access.workspaceSlug}/browse/${key}/`,
    labels,
    state,
    updatedAt: item.updated_at,
  });
  return { ticket, group };
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export const planeSource = {
  id: "plane",
  async list(access, { label, signal } = {}) {
    const [states, labelNames] = await Promise.all([
      readStates(access, signal),
      readLabelNames(access, signal),
    ]);
    const items = await readPages(
      access,
      `${projectPath(access)}/work-items/`,
      "&expand=state,labels",
      signal,
    );
    const open = [];
    for (const item of items) {
      if (!item || typeof item.id !== "string" || !Number.isInteger(item.sequence_id))
        continue;
      const { ticket, group } = toTicket(access, item, { states, labelNames });
      if (!CLOSED_GROUPS.has(group)) open.push(ticket);
    }
    const names = new Set(open.flatMap((ticket) => ticket.labels));
    const labels = [...names].sort((a, b) =>
      a.localeCompare(b, "en", { sensitivity: "base" }),
    );
    const tickets = label ? open.filter((ticket) => ticket.labels.includes(label)) : open;
    return { tickets, labels };
  },
  async get(access, key, { signal } = {}) {
    const match = KEY.exec(String(key ?? ""));
    if (!match || match[1] !== access.identifier) throw new TicketSourceError("notFound");
    const { data } = await call(
      access,
      `${slugPath(access)}/work-items/${match[1]}-${match[2]}/?expand=state,labels`,
      { signal },
    );
    if (
      !data ||
      typeof data !== "object" ||
      data.project !== access.projectId ||
      typeof data.id !== "string" ||
      !Number.isInteger(data.sequence_id)
    )
      throw new TicketSourceError("notFound");
    let states;
    let labelNames;
    if (typeof data.state === "string") states = await readStates(access, signal);
    if (Array.isArray(data.labels) && data.labels.some((l) => typeof l === "string"))
      labelNames = await readLabelNames(access, signal);
    return toTicket(access, data, { states, labelNames }).ticket;
  },
  async markInProgress(access, ticket, { link, kind, signal } = {}) {
    const states = await readStates(access, signal);
    const started = states
      .filter((s) => s.group === "started")
      .sort((a, b) => a.sequence - b.sequence);
    if (!started.length) throw new TicketSourceError("invalidResponse");
    const target = started.find((s) => s.id === access.inProgressStateId) ?? started[0];
    const base = `${projectPath(access)}/work-items/${encodeURIComponent(ticket.id)}/`;
    const alreadyStarted = started.some((s) => s.name === ticket.state);
    if (!alreadyStarted)
      await call(access, base, { method: "PATCH", body: { state: target.id }, signal });
    const noun = kind === "session" ? "session" : "pipeline run";
    await call(access, `${base}comments/`, {
      method: "POST",
      body: {
        comment_html: `<p>Started in AgentPier: <a href="${escapeHtml(link)}">${noun}</a></p>`,
      },
      signal,
    });
    return { state: "done" };
  },
  async projects(access, { signal } = {}) {
    const rows = await readPages(access, `${slugPath(access)}/projects/`, "", signal);
    return rows
      .filter((row) => row && typeof row.id === "string")
      .map((row) => ({
        id: row.id,
        identifier: String(row.identifier ?? ""),
        name: String(row.name ?? ""),
      }));
  },
  async states(access, { signal } = {}) {
    return readStates(access, signal);
  },
};
