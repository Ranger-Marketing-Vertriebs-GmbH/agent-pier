// Optional per-server timeouts in whole seconds; the server checks the bounds
// (server/features/mcp-servers/mcp-timeouts.js) and names a refused field.
export const timeoutBounds = {
  startupTimeout: { min: 1, max: 600 },
  toolTimeout: { min: 1, max: 3600 },
};
export const timeoutFields = Object.keys(timeoutBounds);
// The request field of each draft field.
export const timeoutKeys = {
  startupTimeout: "startupTimeoutSec",
  toolTimeout: "toolTimeoutSec",
};
const refusals = {
  "mcpServers.invalidStartupTimeout": "startupTimeout",
  "mcpServers.invalidToolTimeout": "toolTimeout",
};

/** The draft text of a stored timeout. */
export const timeoutText = (value) => (Number.isInteger(value) ? String(value) : "");

/**
 * A draft text as the request sends it: empty clears (null), digits are a number,
 * anything else goes as typed and the server refuses it at its field.
 */
export function timeoutValue(text = "") {
  const value = text.trim();
  if (!value) return null;
  return /^\d+$/.test(value) ? Number(value) : value;
}

/** The draft field a refused save names, else null. */
export const timeoutRefusal = (error) => refusals[error?.messageKey] ?? null;
