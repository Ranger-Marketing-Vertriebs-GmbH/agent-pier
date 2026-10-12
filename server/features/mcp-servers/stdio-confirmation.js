import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";

export const STDIO_CONFIRMATION_REQUIRED = "MCP_STDIO_CONFIRMATION_REQUIRED";
const record = (value) => !!value && typeof value === "object" && !Array.isArray(value);

/** Refuses a stdio server the owner has not confirmed; nothing is persisted then. */
export function requireStdioConfirmation(confirmed) {
  if (!confirmed)
    throw Object.assign(
      problem(serverMessages.mcpServers.stdioConfirmationRequired, 409),
      {
        code: STDIO_CONFIRMATION_REQUIRED,
      },
    );
}

/** Whether a patch alters what a stdio server runs: command, arguments, cwd or env. */
export function changesStdio(current, patch) {
  if (current.transport !== "stdio" || !record(patch)) return false;
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  return (
    (patch.command !== undefined && patch.command !== current.command) ||
    (patch.args !== undefined && !same(patch.args, current.args)) ||
    (patch.cwd !== undefined && (patch.cwd || null) !== (current.cwd || null)) ||
    (record(patch.env) && Object.keys(patch.env).length > 0)
  );
}
