import { blockingKinds } from "./push-preferences.js";

// What a push notification may say. The server sends data only (kind, link, names,
// preview, tag, count); the service worker words it in the owner's language
// (public/pwa-render.js). Nothing here ever carries a command, a path, a URL or a
// secret: text that looks like one is dropped, never shown in part.

/** The encrypted payload's plaintext JSON never exceeds this many bytes. */
export const payloadBudget = 1024;
export const previewLimit = 140;
const labelLimit = 60;

// Kinds whose preview level may show a short text: questions, the start of a reply,
// check-ins and team goals. Approvals never do.
const previewKinds = new Set(["question", "session-completed", "agent-checkin"]);
const previewAllowed = (event) =>
  previewKinds.has(event.kind) ||
  (event.kind === "agent-approval" && event.subject === "team");

const sensitivePatterns = [
  // URLs and mail addresses.
  /\b[a-z][a-z0-9+.-]*:\/\/\S/i,
  /\bwww\.\S/i,
  /\bmailto:/i,
  /[\w.+-]+@[\w-]+\.[\w.-]+/,
  // Absolute, home, relative and Windows paths, and file paths with folders.
  /(?:^|[\s"'`([{=:,])(?:~|\.{1,2})?\/[\w.@-]/,
  /\b[A-Za-z]:\\/,
  /\b[\w.-]+\/[\w.-]+\/[\w.-]/,
  /\b[\w-]+\/[\w-]+\.[a-z0-9]{1,5}\b/i,
  // Command lines: prompts, chains, pipes, flags and common programs.
  /^[$#>]\s?[\w./-]/,
  /&&|\|\||\s\|\s|`/,
  /(?:^|\s)--?[a-z][\w-]*(?:=|\s|$)/i,
  /\b(?:sudo|rm|curl|wget|chmod|chown|ssh|scp|rsync|git|npm|npx|pnpm|yarn|pip3?|brew|docker|kubectl|bash|zsh|python3?|mkdir|cargo)\s+[\w./~"'-]/,
  // Secrets: known token prefixes, assignments, keys and long opaque strings.
  /\b(?:sk|pk|rk|ghp|gho|ghs|ghu|ghr|github_pat|glpat|xox[abprs]|AKIA|AIza)[-_A-Za-z0-9]{6,}/,
  /\b(?:password|passwort|passwd|secret|token|api[_-]?key|bearer|authorization|credential)s?\b\s*[:=]/i,
  /-----BEGIN/,
  /\beyJ[\w-]{8,}\./,
  /[A-Za-z0-9+/_=-]{32,}/,
  /\b[A-Z][A-Z0-9_]{2,}=\S/,
];

/** Whether a text looks like a command, a path, a URL or a secret. */
export function looksSensitive(text) {
  return sensitivePatterns.some((pattern) => pattern.test(text));
}

const clip = (text, limit) => {
  const characters = [...text];
  return characters.length <= limit
    ? text
    : `${characters
        .slice(0, limit - 1)
        .join("")
        .trimEnd()}…`;
};

// Control and formatting characters (bidi overrides, zero-width marks) never reach
// a lock screen.
const plain = (text) =>
  text
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

/** A name for the lock screen (session, agent, run, project), or null. */
export function safeLabel(value, limit = labelLimit) {
  if (typeof value !== "string") return null;
  const text = plain(value);
  if (!text || looksSensitive(text)) return null;
  return clip(text, limit);
}

/** At most 140 characters of a question, reply, check-in or team goal, or null. */
export function safePreview(value) {
  if (typeof value !== "string") return null;
  const text = plain(
    value
      // Code never shows: fenced blocks and inline code go entirely.
      .replace(/```[\s\S]*?(?:```|$)/g, " ")
      .replace(/~~~[\s\S]*?(?:~~~|$)/g, " ")
      .replace(/`[^`\n]*`/g, " ")
      // Markdown decoration: headings, quotes, list marks, emphasis, link targets.
      .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/(\*\*|__|\*|_)(?=\S)([^*_\n]+?)\1/g, "$2"),
  );
  if (!text || looksSensitive(text)) return null;
  return clip(text, previewLimit);
}

const segment = (value) => encodeURIComponent(value);

/** The page a tap opens: the inbox item, or the exact session, chat or run. */
export function pushLink(event) {
  if (event.inbox)
    return `/inbox/${segment(event.inbox.type)}/${segment(event.inbox.id)}`;
  if (event.kind === "github-token") return "/connections?section=github";
  if (event.kind === "disk-space") return "/";
  if (event.kind === "test") return "/settings/notifications";
  if (event.kind === "telegram-revocation")
    return event.assistantId
      ? `/agents/${segment(event.assistantId)}/settings`
      : "/agents";
  if (event.runId) return `/pipelines/runs/${segment(event.runId)}`;
  if (event.sessionId) return `/sessions/${segment(event.sessionId)}/chat`;
  if (event.assistantId && event.conversationId)
    return `/agents/${segment(event.assistantId)}/chats/${segment(event.conversationId)}`;
  return "/agents";
}

/**
 * Where an event comes from: one session, agent chat, agent or run, or null. Agents
 * hold several chats, so an event of one chat is its chat's, not the whole agent's.
 */
export function pushSource(event) {
  if (event.sessionId) return `session:${event.sessionId}`;
  if (event.runId) return `run:${event.runId}`;
  if (event.assistantId && event.conversationId && event.kind !== "telegram-revocation")
    return `chat:${event.conversationId}`;
  if (event.assistantId && event.kind !== "telegram-revocation")
    return `agent:${event.assistantId}`;
  return null;
}

const bytes = (payload) => Buffer.byteLength(JSON.stringify(payload), "utf8");

/**
 * The payload for one device: the event filtered to the device's detail level, its
 * grouping tag, and the inbox count. Optional text is shed (preview first) until the
 * payload fits the budget.
 */
export function buildPayload(event, preferences, { count } = {}) {
  const source = pushSource(event);
  const grouped = Boolean(preferences.grouping && source);
  const payload = {
    v: 2,
    kind: event.kind,
    eventId: event.eventId,
    link: pushLink(event),
    tag: grouped ? source : event.eventId,
  };
  // A replacement that still waits for the owner alerts again; others replace quietly.
  if (grouped && blockingKinds.has(event.kind)) payload.renotify = true;
  if (Number.isSafeInteger(count) && count >= 0) payload.count = Math.min(count, 999);
  if (preferences.level !== "type") {
    if (event.subject) payload.subject = event.subject;
    for (const key of ["label", "tool", "project", "stage"]) {
      const value = safeLabel(event[key]);
      if (value) payload[key] = value;
    }
  }
  if (preferences.level === "preview" && previewAllowed(event)) {
    const preview = safePreview(event.preview);
    if (preview) payload.preview = preview;
  }
  for (const key of ["preview", "stage", "project", "tool", "label"]) {
    if (bytes(payload) <= payloadBudget) break;
    delete payload[key];
  }
  if (bytes(payload) > payloadBudget) throw Error("Push payload exceeds its budget.");
  return payload;
}
