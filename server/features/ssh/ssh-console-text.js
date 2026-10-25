// Text of an interactive device console (docs/ssh-access.md, "Interactive shell"):
// terminal control sequences, redraws and pager prompts are removed so agents read
// plain lines. These are heuristics for common switch and router CLIs, not a
// terminal emulator.

// CSI (ESC [ … final), OSC (ESC ] … BEL or ST), charset selection and other
// two-byte ESC sequences.
const escapes =
  /\x1b\[[0-?]*[ -/]*[@-~]|\x9b[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[()*+][0-9A-Za-z]|\x1b[@-Z\\-_]|\x1b./g;
// A pager waiting for a key, as the whole line: "--More--", "-- More --",
// "<--- More --->", "Press any key to continue", "Press SPACE for more". Text that
// merely contains "more" (a hostname, an option) is no pager.
const pagerText =
  /<-+\s*More\s*-+>|-+\s*More\s*-+|Press\s+any\s+key\b.*|Press\s+SPACE\b.*/i;
export const pagerPattern = new RegExp(`^\\s*(?:${pagerText.source})\\s*$`, "i");
// A pager marker the device left in front of the next page's first line.
const pagerPrefix = /^\s*(?:<-+\s*More\s*-+>|-{2,}\s*More\s*-{2,})\s*/i;
// A shell or device prompt: a line ending in >, #, $ or ], then at most one space.
// A bracketed status word in capitals ("[OK]", "[DONE]") is output, not a prompt.
const promptEnd = /[>#$\]] ?$/;
// A question that ends in its answer hint ("Proceed? [confirm]") is no prompt either.
const statusLine = /^\s*\[[A-Z ]+\]\s*$/;
const questionLine = /\?\s*\[[^\]]*\] ?$|\[(?:confirm|yes\/no|y\/n)\] ?$/i;
export const promptPattern = {
  test: (line) =>
    promptEnd.test(line) && !statusLine.test(line) && !questionLine.test(line),
};

/**
 * The line as a terminal shows it: CR returns to the start and later characters
 * overwrite earlier ones (`% Error\rOK` shows `OKrror`), a backspace moves one
 * column left; other control characters are dropped.
 */
function visibleLine(line) {
  const cells = [];
  let column = 0;
  for (const character of line) {
    if (character === "\r") column = 0;
    else if (character === "\b") column = Math.max(0, column - 1);
    else if (/[\x00-\x08\x0b-\x1f\x7f]/.test(character)) continue;
    else cells[column++] = character;
  }
  return Array.from(cells, (cell) => cell ?? " ").join("");
}

/** Plain console text: no control sequences, LF line ends, no pager prompts. */
export function consoleText(raw) {
  return raw
    .replace(escapes, "")
    .replace(/\r+\n/g, "\n")
    .split("\n")
    .map((line) => {
      const shown = visibleLine(line);
      return (pagerPattern.test(shown) ? "" : shown.replace(pagerPrefix, "")).trimEnd();
    })
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
