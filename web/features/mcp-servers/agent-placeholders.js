// A copy of the server's placeholder grammar (server/features/mcp-servers/
// agent-placeholders.js), kept equal by tests/unit/mcp-wizard-placeholders.test.js:
// the form explains and refuses what the server would refuse before anything is sent.
export const placeholderNames = ["agent.workspace", "agent.attachments"];

const candidate = /\{\s*(?:agent|session)\s*\./i;
const shape = /^([^{}]*)\{([^{}]*)\}([^{}]*)$/;
const badSegment = /[\x00-\x1f\x7f]/;
// Setting names that usually hold a folder or file path: the form offers the
// agent's folder there. A hint only; the owner may type a placeholder anywhere valid.
const pathName = /PATH|DIR|FOLDER|ROOT|BASE|OUTPUT|INPUT|WORKSPACE|STORAGE|HOME|CWD/i;

export const hasPlaceholderCandidate = (value) =>
  typeof value === "string" && candidate.test(value);

/** `{ prefix, name, segments }`, null without a candidate, false when invalid. */
export function parsePlaceholder(value, { prefix: allowPrefix = false } = {}) {
  if (!hasPlaceholderCandidate(value)) return null;
  const match = shape.exec(value);
  if (!match) return false;
  const [, prefix, name, tail] = match;
  if (!placeholderNames.includes(name) || (prefix && !allowPrefix)) return false;
  if (tail === "" || tail === "/") return { prefix, name, segments: [] };
  if (!tail.startsWith("/")) return false;
  const segments = tail.slice(1).replace(/\/$/, "").split("/");
  if (
    segments.some(
      (segment) =>
        segment === "" || segment === "." || segment === ".." || badSegment.test(segment),
    )
  )
    return false;
  return { prefix, name, segments };
}

/** Whether a typed value uses the placeholder namespace wrongly. */
export const placeholderInvalid = (value, options) =>
  parsePlaceholder(value, options) === false;

/** Whether the form should offer the agent's folder for a setting of this name. */
export const looksLikePath = (name) => pathName.test(String(name ?? ""));

/**
 * Whether a form draft (`args` as rows or newline text, `cwd`, `env` rows) uses agent
 * placeholders, counting stored environment values the draft keeps (their templates
 * come from `server.placeholders`).
 */
export function draftUsesPlaceholders(values, server = null) {
  if (values.transport !== "stdio") return false;
  const args = Array.isArray(values.argRows)
    ? values.argRows
    : String(values.args ?? "").split("\n");
  if (args.some(hasPlaceholderCandidate) || hasPlaceholderCandidate(values.cwd))
    return true;
  const stored = server?.placeholders?.env ?? {};
  return (values.env ?? []).some((row) => {
    if (row.removed) return false;
    if (row.value) return hasPlaceholderCandidate(row.value);
    return row.stored === true && row.name.trim() in stored;
  });
}
