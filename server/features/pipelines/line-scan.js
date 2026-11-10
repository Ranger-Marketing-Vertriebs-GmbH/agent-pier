// Scanners for single lines of specs and dependency manifests. These lines come from
// repositories and agents, so each scanner reads its line a bounded number of times:
// the regular expression it replaces (quoted above it) took quadratic or cubic time on
// a crafted line and blocked the event loop. Results are those of the expression,
// including its corner cases: whitespace is what `\s` matches, and a line terminator
// what `.` refuses, so text that `(.*)$` would have to carry across one never matches.
const space = /\s/;
const terminator = /[\n\r\u2028\u2029]/;
const digit = /[0-9]/;
const keyChar = /[A-Za-z0-9_.-]/;
const bareChar = /[A-Za-z0-9_-]/;

const isSpace = (line, at) => at >= 0 && at < line.length && space.test(line[at]);

/** The index of the first character at or after `from` that is no whitespace. */
function skipSpace(line, from) {
  let at = from;
  while (isSpace(line, at)) at += 1;
  return at;
}

function skipWhile(line, from, chars) {
  let at = from;
  while (at < line.length && chars.test(line[at])) at += 1;
  return at;
}

/** `text` without trailing whitespace and without trailing characters of `chars`. */
export function withoutTail(text, chars) {
  let end = text.length;
  while (end > 0 && (isSpace(text, end - 1) || chars.includes(text[end - 1]))) end -= 1;
  return text.slice(0, end);
}

/**
 * The text of an ATX heading, without its closing hashes; null for any other line.
 * `/^ {0,3}#{1,6}\s+(.*?)\s*#*\s*$/`
 */
export function headingText(line) {
  let at = 0;
  while (at < 3 && line[at] === " ") at += 1;
  let end = at;
  while (line[end] === "#") end += 1;
  if (end === at || end - at > 6) return null;
  const start = skipSpace(line, end);
  if (start === end) return null;
  let text = line.slice(start).trimEnd();
  let hashes = text.length;
  while (hashes > 0 && text[hashes - 1] === "#") hashes -= 1;
  text = text.slice(0, hashes).trimEnd();
  return terminator.test(text) ? null : text;
}

/**
 * The text of a numbered list item ("1." or "1)"), or of a bullet item as well when
 * `bullets` is set; null for any other line.
 * `/^\s*\d{1,3}[.)]\s+(.*)$/` and `/^\s*(?:[-*+]|\d{1,3}[.)])\s+(.*)$/`
 */
export function listItemText(line, bullets = false) {
  let at = skipSpace(line, 0);
  if (bullets && at < line.length && "-*+".includes(line[at])) at += 1;
  else {
    const digits = skipWhile(line, at, digit) - at;
    if (digits < 1 || digits > 3) return null;
    at += digits;
    if (line[at] !== "." && line[at] !== ")") return null;
    at += 1;
  }
  const start = skipSpace(line, at);
  if (start === at) return null;
  const text = line.slice(start);
  return terminator.test(text) ? null : text;
}

/**
 * `line` without its `#` comment: a `#` at the start or after whitespace, unless it
 * begins `#egg=`. A comment runs to the end of the line.
 * `line.replace(/(?:^|\s+)#(?!egg=).*$/, "")`
 */
export function withoutComment(line) {
  const from =
    Math.max(
      line.lastIndexOf("\n"),
      line.lastIndexOf("\r"),
      line.lastIndexOf("\u2028"),
      line.lastIndexOf("\u2029"),
    ) + 1;
  for (let at = line.indexOf("#", from); at !== -1; at = line.indexOf("#", at + 1)) {
    if (at > 0 && !isSpace(line, at - 1)) continue;
    if (line.startsWith("egg=", at + 1)) continue;
    let start = at;
    while (isSpace(line, start - 1)) start -= 1;
    return line.slice(0, start);
  }
  return line;
}

/**
 * The name in a TOML table header such as `[dependencies]`; null for any other line.
 * `/^\[\s*([^\]]+?)\s*\]$/`
 */
export function tableName(line) {
  const end = line.length - 1;
  if (end < 2 || line[0] !== "[" || line.indexOf("]", 1) !== end) return null;
  const inner = line.slice(1, end);
  return inner.trim() || inner.at(-1);
}

/**
 * The key and the value of a TOML `key = value` line as `[key, value]`; null for any
 * other line. Of a dotted key before the `=`, the last part does not belong to the key
 * (`serde.workspace = true` has the key `serde`).
 * `/^"?([A-Za-z0-9_.-]+?)"?\s*(?:\.[A-Za-z0-9_-]+\s*)?=\s*(.*)$/`
 */
export function keyValue(line) {
  const start = line[0] === '"' ? 1 : 0;
  const end = skipWhile(line, start, keyChar);
  if (end === start) return null;
  const valueAt = (at) => {
    if (line[at] !== "=") return null;
    const value = line.slice(skipSpace(line, at + 1));
    return terminator.test(value) ? null : value;
  };
  const dot = line.lastIndexOf(".", end - 1);
  if (dot > start && dot < end - 1) {
    const value = valueAt(skipSpace(line, end));
    if (value !== null) return [line.slice(start, dot), value];
  }
  let at = skipSpace(line, line[end] === '"' ? end + 1 : end);
  if (line[at] === ".") {
    const part = skipWhile(line, at + 1, bareChar);
    if (part === at + 1) return null;
    at = skipSpace(line, part);
  }
  const value = valueAt(at);
  return value === null ? null : [line.slice(start, end), value];
}
