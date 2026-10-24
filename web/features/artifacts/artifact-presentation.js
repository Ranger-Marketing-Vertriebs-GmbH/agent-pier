// Pure presentation of artifact summaries: type, time, date group, source and size.
import { artifactSearchTerm } from "./routes.js";
const imageFormats = {
  "image/png": "PNG",
  "image/jpeg": "JPEG",
  "image/gif": "GIF",
  "image/webp": "WebP",
  "image/avif": "AVIF",
  "image/svg+xml": "SVG",
};

/** "page" for HTML, "image" for images, "file" for anything else. */
export function artifactKind(mediaType) {
  if (mediaType === "text/html") return "page";
  if (typeof mediaType === "string" && mediaType.startsWith("image/")) return "image";
  return "file";
}

/** "Web page", "Image · PNG" or "File", from the catalog's `types`. */
export function artifactTypeLabel(mediaType, types) {
  const kind = artifactKind(mediaType);
  if (kind === "page") return types.page;
  if (kind === "image")
    return types.image(
      imageFormats[mediaType] || mediaType.slice(6).toUpperCase() || "IMAGE",
    );
  return types.file;
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

// Calendar days between two local dates; DST days count as one.
function dayDistance(date, now) {
  return Math.round((startOfDay(now) - startOfDay(date)) / 86400000);
}

/** "today", "yesterday", "week" (the last 7 days) or "earlier", in local time. */
export function artifactDateGroup(value, now = new Date()) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "earlier";
  const days = dayDistance(date, now);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return "week";
  return "earlier";
}

export const artifactDateGroups = ["today", "yesterday", "week", "earlier"];

/** Consecutive groups in list order: [{ group, items }]. */
export function groupArtifactsByDate(items, now = new Date()) {
  const groups = [];
  for (const item of items || []) {
    const group = artifactDateGroup(item.updatedAt, now);
    const last = groups.at(-1);
    if (last?.group === group) last.items.push(item);
    else groups.push({ group, items: [item] });
  }
  return groups;
}

const units = [
  ["year", 365 * 86400],
  ["month", 30 * 86400],
  ["day", 86400],
  ["hour", 3600],
  ["minute", 60],
];

/** "18 minutes ago", "yesterday", "3 days ago"; `justNow` below one minute. */
export function relativeTime(value, { now = new Date(), locale, justNow }) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const seconds = Math.round((date.getTime() - now.getTime()) / 1000);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  for (const [unit, size] of units)
    if (Math.abs(seconds) >= size) {
      // Whole days follow the calendar so "yesterday" matches the group label.
      const amount =
        unit === "day" ? -dayDistance(date, now) : Math.trunc(seconds / size);
      return format.format(amount, unit);
    }
  return justNow;
}

/** The exact local time for a `title` attribute. */
export function exactTime(value, locale) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
}

/** Usage above 80 % of the limit asks the owner to clean up. */
export function storageWarning(usage) {
  return Boolean(usage?.limitBytes) && usage.usedBytes / usage.limitBytes > 0.8;
}

/**
 * Where an artifact came from: its session (name and tool, or deleted) and project.
 * `sessions` and `projects` are the workspace lists; either may be missing.
 */
export function artifactSource(item, { sessions, projects } = {}) {
  const session = (sessions || []).find((entry) => entry.id === item.sessionId) || null;
  const project = (projects || []).find((entry) => entry.id === item.projectId) || null;
  return {
    session,
    sessionGone: Boolean(item.orphaned),
    project,
  };
}

/** "Session name · project", "Session deleted · project" or just one of them. */
export function artifactSourceLine(item, lists, copy) {
  const { session, sessionGone, project } = artifactSource(item, lists);
  const first = sessionGone
    ? copy.sessionDeleted
    : session?.name || (session ? copy.sessionUnnamed : "");
  return [first, project?.name].filter(Boolean).join(" · ");
}

/** The `/api/artifacts` query of a list: filters and page. */
export function artifactListQuery({ sessionId, projectId, page = 1, q, pinned }) {
  const query = new URLSearchParams({ page: String(page) });
  if (sessionId) query.set("sessionId", sessionId);
  if (projectId) query.set("projectId", projectId);
  const term = artifactSearchTerm(q);
  if (term) query.set("q", term);
  if (pinned) query.set("pinned", "true");
  return query.toString();
}

/** First and last characters of a long ID: "3f2a9c1e…5b6c". */
export function shortId(id) {
  return typeof id === "string" && id.length > 14
    ? `${id.slice(0, 8)}…${id.slice(-4)}`
    : id;
}
