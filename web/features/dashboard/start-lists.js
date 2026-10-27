// The start page's session and agent lists (tests/unit/start-lists.test.js): their
// order, filter chips, search and how many rows show.
import { sessionActivity } from "../sessions/sessionPresentation.js";

/** Rows a card shows before "Show n more"; phones show fewer and no inner scroll. */
export const SESSION_LIMIT = 6;
export const AGENT_LIMIT = 5;
export const PHONE_LIMIT = 4;

const sessionRanks = { waiting: 0, working: 1, idle: 2, terminal: 2, unknown: 3 };
const agentRanks = { needsYou: 0, working: 1, ready: 2, offline: 3 };

/** The session chips, "running" (everything but stopped) first and preselected. */
export const sessionFilters = {
  running: (state) => state !== "stopped",
  waiting: (state) => state === "waiting",
  working: (state) => state === "working",
  ready: (state) => state === "idle" || state === "terminal",
  stopped: (state) => state === "stopped",
};
export const agentFilters = {
  all: () => true,
  needsYou: (state) => state === "needsYou",
  working: (state) => state === "working",
  ready: (state) => state === "ready",
};

/** The words of a search, lower case; every word has to match some field. */
export const searchWords = (query = "") =>
  query.toLocaleLowerCase().split(/\s+/).filter(Boolean);

export function matchesWords(fields, words) {
  const text = fields.filter(Boolean).map((field) => String(field).toLocaleLowerCase());
  return words.every((word) => text.some((field) => field.includes(word)));
}

const folder = (cwd) =>
  typeof cwd === "string" ? cwd.split(/[\\/]/).filter(Boolean).at(-1) || "" : "";

/** The repository, else the folder's name; a shell names no project. */
export function sessionProject(session) {
  if (session.tool === "shell") return "";
  return session.repositoryName || folder(session.cwd);
}

const time = (value) => {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
};

/** When the session last changed: its current state's start, else its record. */
export const sessionTime = (session) =>
  time(session.activity?.since) || time(session.updatedAt) || time(session.createdAt);

/**
 * Sessions as list items: `{ id, session, state, label, project, time, search }`.
 * `toolName(tool)` names the CLI for the search ("Claude Code").
 */
export function sessionItems(sessions = [], toolName = (tool) => tool) {
  return sessions.map((session) => {
    const { state, label } = sessionActivity(session);
    const project = sessionProject(session);
    return {
      id: session.id,
      session,
      state,
      label,
      project,
      time: sessionTime(session),
      rank: state === "stopped" ? 4 : (sessionRanks[state] ?? 3),
      search: [session.name, project, toolName(session.tool), session.tool],
    };
  });
}

/**
 * The category of an agent: `tone` is `headerStatus().tone` (waiting, attention,
 * working, ready, muted, missing). A stopped service or a missing connection is
 * offline; an unclear outcome needs the owner like a pending approval.
 */
export function agentState(tone) {
  if (tone === "waiting" || tone === "attention") return "needsYou";
  if (tone === "working") return "working";
  if (tone === "ready") return "ready";
  return "offline";
}

export const agentRank = (state) => agentRanks[state] ?? 3;

const byRank = (a, b) =>
  a.rank - b.rank ||
  b.time - a.time ||
  String(a.name ?? a.search[0] ?? "").localeCompare(
    String(b.name ?? b.search[0] ?? ""),
    undefined,
    { sensitivity: "base" },
  );

/**
 * One card's list: the chip counts after the search, and the rows of the chosen chip
 * in rank order (then the most recent first, then by name). `items` carry `state`,
 * `rank`, `time` and `search` (the fields a search word may match).
 */
export function filterList(items, { filters, filter, query }) {
  const words = searchWords(query);
  const found = items.filter((item) => matchesWords(item.search, words));
  const counts = Object.fromEntries(
    Object.entries(filters).map(([id, test]) => [
      id,
      found.filter((item) => test(item.state)).length,
    ]),
  );
  const test = filters[filter] ?? Object.values(filters)[0];
  return { counts, rows: found.filter((item) => test(item.state)).sort(byRank) };
}

/** The rows that show: all once expanded, else the first `limit`. */
export const shownRows = (rows, limit, expanded) =>
  expanded ? rows : rows.slice(0, limit);
