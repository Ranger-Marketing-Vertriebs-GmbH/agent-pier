import { createHash } from "node:crypto";

/**
 * Characters an owner cannot see in a command: C0 and C1 controls other than tab and
 * line feed, the soft hyphen, Unicode bidi controls and zero-width characters. The
 * web card and run notes show them as codes (web/features/assistants/
 * ssh-command-text.js uses the same class); Telegram offers no buttons for a command
 * that contains one.
 */
export const hiddenCharacterSource =
  "[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\u00ad\\u061c\\u180e\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u2069\\ufeff]";
const hidden = new RegExp(hiddenCharacterSource, "u");

export const hasHiddenCharacters = (text) => hidden.test(String(text));

/** Correlates an audit record with the transcript's tool call without the text. */
export const commandDigest = (command) =>
  createHash("sha256").update(String(command), "utf8").digest("hex");

/** The first line, at most `limit` code points, with an ellipsis when shortened. */
export function commandPreview(command, limit = 80) {
  const lines = String(command).split("\n");
  const points = Array.from(lines[0]);
  if (points.length <= limit && lines.length === 1) return lines[0];
  return `${points.slice(0, limit - 1).join("")}…`;
}
