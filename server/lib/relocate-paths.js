/**
 * Replaces `from` by `to` at the start of every string in a JSON value that is `from`
 * or a path below it. `check(rewritten)` may reject a rewritten path by throwing.
 * Used where a data directory's own files name it by absolute path and it is
 * restored, moved or copied elsewhere (AGENTPIER-467).
 */
export function relocatePaths(value, from, to, check) {
  if (typeof value === "string") {
    if (value !== from && !value.startsWith(`${from}/`)) return value;
    const rewritten = to + value.slice(from.length);
    check?.(rewritten);
    return rewritten;
  }
  if (Array.isArray(value))
    return value.map((item) => relocatePaths(item, from, to, check));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([name, item]) => [
      name,
      relocatePaths(item, from, to, check),
    ]),
  );
}
