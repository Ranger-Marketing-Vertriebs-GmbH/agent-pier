import { createHash } from "node:crypto";

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
