// A `returnTo` query parameter names the in-app page a cross-link came from, so the
// page it opens can lead back there. Only same-origin app paths pass: no scheme, no
// protocol-relative `//host`, no backslashes or control characters (browsers fold
// `\` into `/`), and a bounded length. Callers still parse the parts as an app route
// and rebuild the path from it, so nothing from the address is echoed verbatim.
export const returnParam = "returnTo";
const maxLength = 2048;

/** `{ pathname, search, hash }` of a safe app path, otherwise null. */
export function appPathParts(value) {
  if (
    typeof value !== "string" ||
    value.length > maxLength ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[\\\x00-\x1f\x7f]/.test(value)
  )
    return null;
  const separator = value.search(/[?#]/);
  const pathname = separator < 0 ? value : value.slice(0, separator);
  const rest = value.slice(pathname.length);
  const hashAt = rest.indexOf("#");
  return {
    pathname,
    search: hashAt < 0 ? rest : rest.slice(0, hashAt),
    hash: hashAt < 0 ? "" : rest.slice(hashAt),
  };
}

/** The search string without `returnTo`, so a return target never nests another. */
export function withoutReturnParam(search) {
  const query = new URLSearchParams(search);
  query.delete(returnParam);
  return query.size ? `?${query}` : "";
}
