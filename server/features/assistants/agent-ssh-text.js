import { createHash } from "node:crypto";
import { redactSecrets } from "../../lib/secret-redaction.js";

/**
 * Characters an owner cannot see in a command: controls other than tab and line feed,
 * format characters (soft hyphen, bidi controls, zero-width characters, Unicode tags),
 * default-ignorable code points (variation selectors, Hangul fillers) and the line and
 * paragraph separators, which a browser may draw as a break the shell ignores. The
 * web card and run notes show them as codes (web/features/assistants/
 * ssh-command-text.js uses the same class); Telegram offers no buttons for a command
 * that contains one.
 */
export const hiddenCharacterSource =
  "(?![\\t\\n])[\\p{Cc}\\p{Cf}\\p{Default_Ignorable_Code_Point}\\u2028\\u2029\\u115f\\u1160\\u3164\\uffa0]";
const hidden = new RegExp(hiddenCharacterSource, "u");

export const hasHiddenCharacters = (text) => hidden.test(String(text));

/** Correlates an audit record with the transcript's tool call without the text. */
export const commandDigest = (command) =>
  createHash("sha256").update(String(command), "utf8").digest("hex");

/**
 * The first line, at most `limit` code points, with an ellipsis when shortened. A CRLF
 * line end is dropped, but the preview is otherwise raw text: escape it (visibleCommand
 * or an equivalent) before showing it.
 */
export function commandPreview(command, limit = 80) {
  const lines = String(command).split(/\r?\n/);
  const points = Array.from(lines[0]);
  if (points.length <= limit && lines.length === 1) return lines[0];
  return `${points.slice(0, limit - 1).join("")}…`;
}

/** The most of a command a chat note carries (web/features/assistants/SshRunNote.jsx). */
export const noteCommandBytes = 8192;

/**
 * A command for a chat note: whole up to 8 KiB of UTF-8, else its first 8 KiB cut at a
 * character boundary with `commandCut`. Raw text, escaped by the web before display.
 */
export function noteCommand(command) {
  if (typeof command !== "string") return {};
  if (Buffer.byteLength(command) <= noteCommandBytes) return { command };
  let bytes = 0,
    end = 0;
  for (const point of command) {
    bytes += Buffer.byteLength(point);
    if (bytes > noteCommandBytes) break;
    end += point.length;
  }
  return { command: command.slice(0, end), commandCut: true };
}

/**
 * A settled row's command with recognisable secrets replaced (server/lib/
 * secret-redaction.js), as payload fields: `command` and `commandRedacted` when it
 * changed, else nothing. The digest of the original stays with the audit.
 */
export function redactedCommand(payload) {
  if (typeof payload?.command !== "string") return {};
  const command = redactSecrets(payload.command);
  return command === payload.command ? {} : { command, commandRedacted: true };
}
