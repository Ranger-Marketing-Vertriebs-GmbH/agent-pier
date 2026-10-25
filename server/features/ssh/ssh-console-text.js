// Text of an interactive device console (docs/ssh-access.md, "Interactive shell"):
// terminal control sequences, redraws and pager prompts are removed so agents read
// plain lines. These are heuristics for common switch and router CLIs, not a
// terminal emulator.

// CSI (ESC [ … final), OSC (ESC ] … BEL or ST), charset selection and other
// two-byte ESC sequences.
const escapes =
  /\x1b\[[0-?]*[ -/]*[@-~]|\x9b[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[()*+][0-9A-Za-z]|\x1b[@-Z\\-_]|\x1b./g;
// A pager waiting for a key: "--More--", "-- More --", "<--- More --->",
// "Press any key to continue", "Press SPACE for more".
export const pagerPattern =
  /<-+\s*More\s*-+>|-+\s*More\s*-+|Press\s+any\s+key[^\n]*|Press\s+SPACE[^\n]*/i;
const pagerAll = new RegExp(pagerPattern.source, "gi");
// A shell or device prompt: a line ending in >, #, $ or ], then at most one space.
export const promptPattern = /[>#$\]] ?$/;

/** The line as a terminal shows it: the last redraw after CR, backspaces applied. */
function visibleLine(line) {
  const redraws = line.split("\r");
  const shown = redraws.findLast((part) => /\S/.test(part.replace(/[\b]/g, ""))) ?? "";
  const kept = [];
  for (const character of shown) {
    if (character === "\b") kept.pop();
    else kept.push(character);
  }
  return kept.join("").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

/** Plain console text: no control sequences, LF line ends, no pager prompts. */
export function consoleText(raw) {
  return raw
    .replace(escapes, "")
    .replace(/\r+\n/g, "\n")
    .split("\n")
    .map((line) => visibleLine(line).replace(pagerAll, "").trimEnd())
    .join("\n");
}

/** The unfinished last line of console output (what a prompt or pager prints). */
export function lastLine(raw) {
  const text = raw.replace(escapes, "").replace(/\r+\n/g, "\n");
  return visibleLine(text.slice(text.lastIndexOf("\n") + 1));
}

/**
 * One step's console text without the echo of the line that was sent: the first
 * non-empty line is dropped when it ends with that line (devices may repeat the
 * prompt in front of it). Lines the device did not echo (passwords) stay untouched.
 */
export function withoutEcho(text, sent) {
  const echo = sent.trim();
  if (!echo) return text;
  const lines = text.split("\n");
  const first = lines.findIndex((line) => line.trim());
  if (first !== -1 && lines[first].trimEnd().endsWith(echo)) lines.splice(first, 1);
  return lines.join("\n");
}
