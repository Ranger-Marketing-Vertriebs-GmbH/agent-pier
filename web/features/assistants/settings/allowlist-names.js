/**
 * An exact command as a delete label and dialog title name it: on one line (every run
 * of whitespace, newlines included, as one space) and cut to `max` characters by code
 * points, so a surrogate pair is never split.
 */
export function commandName(command, max = 80) {
  const chars = Array.from(String(command).replace(/\s+/g, " ").trim());
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : chars.join("");
}
