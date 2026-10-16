// A copy of the server's reference rule (server/features/mcp-servers/value-references.js),
// kept equal by tests/unit/mcp-wizard-references.test.js: AgentPier stores literal
// values, so the wizard refuses what the server would refuse before anything is sent.
export const referenceOpeners = ["${", "{env:", "{file:"];

/** The body of the first non-empty `opener…}` in `value`, or null (a linear scan). */
function opened(value, opener) {
  for (let start = value.indexOf(opener); start !== -1;) {
    const body = start + opener.length;
    const close = value.indexOf("}", body);
    if (close === -1) return null;
    if (close > body) return value.slice(body, close);
    start = value.indexOf(opener, close + 1);
  }
  return null;
}

/** Whether `value` is a string holding a reference a CLI would expand. */
export const hasReference = (value) =>
  typeof value === "string" &&
  referenceOpeners.some((opener) => opened(value, opener) !== null);

/** The variable a reference names (`API_TOKEN` in `${API_TOKEN}`), for messages only. */
export function referenceName(value) {
  if (typeof value !== "string") return null;
  for (const opener of referenceOpeners) {
    const body = opened(value, opener);
    if (body === null) continue;
    return body.replace(/^(?:env|input):/, "").replace(/:-.*$/, "");
  }
  return null;
}
