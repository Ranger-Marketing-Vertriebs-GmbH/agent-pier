import { locale as currentLocale } from "../../lib/i18n/index.js";
import { assistantSftpCopy as copy } from "../../lib/i18n/messages/assistant-sftp.js";
import { formatBytes } from "../../lib/format-bytes.js";

const tones = {
  executing: "running",
  completed: "ok",
  failed: "error",
  cancelled: "neutral",
  unknown: "error",
};
const transfers = new Set(["upload", "download", "sync"]);
const seconds = (ms, locale) =>
  copy.note.seconds(
    new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(
      Math.round(ms / 100) / 10,
    ),
  );
const skippedCount = (skipped) =>
  skipped && typeof skipped === "object"
    ? Object.values(skipped).reduce((sum, n) => sum + (Number(n) || 0), 0)
    : Number(skipped) || 0;

/** The operation's name, a sync with its direction ("Sync to the server"). */
export function sftpOperationText(operation, direction) {
  if (operation === "sync" && copy.syncDirections[direction])
    return copy.syncDirections[direction];
  return copy.operations[operation] ?? operation;
}

/**
 * A running job's progress: "42 % · 12 of 124 files" (by bytes when it moves bytes,
 * else by files), or null while nothing is planned (a mkdir or rename).
 */
export function sftpProgressText(progress) {
  const p = progress || {};
  const files = Number(p.files) || 0;
  if (!files) return null;
  const done = Math.min(files, Number(p.filesDone) || 0);
  const share = p.bytes > 0 ? (Number(p.bytesDone) || 0) / p.bytes : done / files;
  const percent = Math.max(0, Math.min(100, Math.floor(share * 100)));
  return copy.progress(percent, done, files);
}

/**
 * A stable problem or diagnostic code (server sftp-errors.js, tool-errors.js) as its
 * catalog text; an unknown one as "Transfer failed (CODE)".
 */
export function sftpCodeText(code) {
  return Object.hasOwn(copy.codes, code) ? copy.codes[code] : copy.unknownCode(code);
}

function label(note) {
  const t = copy.note.labels;
  const key =
    note.operation === "sync"
      ? note.direction === "down"
        ? "syncDown"
        : "syncUp"
      : note.operation;
  // A future operation keeps its own name rather than reading as an upload.
  return key !== "other" && t[key]
    ? t[key](note.hostName)
    : t.other(sftpOperationText(note.operation, note.direction), note.hostName);
}
function icon(note) {
  if (note.operation === "delete") return "trash";
  if (!transfers.has(note.operation)) return "folder";
  return note.direction === "down" ? "download" : "upload";
}
// "120 new · 4 changed · 0 deleted" for a transfer, "3 files · 1 folder" for a delete.
function counts(operation, r) {
  if (operation === "delete")
    return r.files != null ? copy.deleted(r.files, r.dirs ?? 0) : null;
  if (!transfers.has(operation) || r.created == null) return null;
  return copy.counts(r.created, r.updated ?? 0, r.deleted ?? 0);
}

/**
 * An SFTP note (server actionNotes, agent-sftp-notes.js) as its activity row: icon by
 * operation and direction, "Upload to nas-01", the remote path (a rename's both),
 * the state's chip (a running job's progress) and the facts of its body: paths,
 * counts, bytes, duration and, when it failed, its code and the path it stopped at.
 */
export function sftpRunView(note, locale = currentLocale) {
  const t = copy.note;
  const state = note.state in tones ? note.state : "unknown";
  const r = note.result || {};
  const progress = state === "executing" ? sftpProgressText(note.progress) : null;
  const local =
    note.localPath != null
      ? copy.card.local(note.localProject || copy.card.workspace, note.localPath)
      : null;
  const facts = [
    [t.remotePath, note.remotePath],
    [t.toPath, note.toPath],
    [t.localPath, local],
    [t.files, counts(note.operation, r)],
    [
      t.size,
      transfers.has(note.operation) && r.bytes != null
        ? formatBytes(r.bytes, locale)
        : null,
    ],
    [t.overwrites, r.overwrites > 0 ? String(r.overwrites) : null],
    [t.skipped, skippedCount(r.skipped) > 0 ? String(skippedCount(r.skipped)) : null],
    [t.duration, r.durationMs != null ? seconds(r.durationMs, locale) : null],
    [t.code, state !== "completed" && r.code ? sftpCodeText(r.code) : null],
    [t.failedPath, r.failedPath ?? null],
    [t.progress, progress],
    [t.current, state === "executing" ? (note.progress?.current ?? null) : null],
  ].filter(([, value]) => value != null && value !== "");
  return {
    icon: icon(note),
    label: label(note),
    detail: note.toPath ? `${note.remotePath} → ${note.toPath}` : note.remotePath,
    status: progress ?? t.status[state],
    tone: tones[state],
    facts,
  };
}

/** One Work tab history line: operation, host, outcome, files, size and duration. */
export function sftpHistoryText(action, locale = currentLocale) {
  const p = action.payload || {};
  const r = action.result || {};
  // A card cancelled before its job started (its host changed or went) never ran: it
  // reads as the card does.
  const ran =
    ["completed", "failed", "unknown"].includes(action.state) ||
    (action.state === "cancelled" && Boolean(action.chatNotes?.started));
  const parts = [
    copy.history.title(sftpOperationText(p.operation, p.direction), p.hostName),
    ran
      ? copy.note.status[action.state]
      : action.state === "cancelled" && action.diagnostic === "HOST_REMOVED"
        ? copy.card.removed
        : copy.card.states[action.state] || copy.card.states.unknown,
  ];
  if (action.state === "completed") {
    if (p.operation === "delete" && r.files != null)
      parts.push(copy.deleted(r.files, r.dirs ?? 0));
    else if (transfers.has(p.operation) && r.files != null) {
      parts.push(copy.fileCount(r.files));
      if (r.bytes != null) parts.push(formatBytes(r.bytes, locale));
    }
  } else if (ran && (r.code || action.diagnostic))
    parts.push(sftpCodeText(r.code || action.diagnostic));
  if (action.state === "completed" && r.durationMs != null)
    parts.push(seconds(r.durationMs, locale));
  return parts.join(" · ");
}
