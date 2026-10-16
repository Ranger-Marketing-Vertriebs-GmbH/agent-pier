// Server names follow the store's rule: a letter, then up to 29 letters, digits, "-"
// or "_" (tools appear under this name in every CLI and agent).
const limit = 30;

/** A name the server accepts made from any text, or "" when nothing usable is left. */
export function sanitiseName(raw) {
  const text = String(raw ?? "")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^[^A-Za-z]+/, "")
    .replace(/-+/g, "-")
    .replace(/-$/, "");
  return text.slice(0, limit).replace(/-$/, "");
}

/** `name`, or `name-2`, `name-3`… (shortened to fit) when it is already taken. */
export function uniqueName(name, taken = []) {
  const used = new Set(taken);
  if (!used.has(name)) return name;
  for (let index = 2; ; index += 1) {
    const suffix = `-${index}`;
    const candidate = `${name.slice(0, limit - suffix.length)}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}
