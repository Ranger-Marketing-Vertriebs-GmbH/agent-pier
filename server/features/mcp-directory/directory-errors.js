import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";

const codes = {
  MCP_DIRECTORY_DISABLED: ["disabled", 409],
  MCP_DIRECTORY_UNAVAILABLE: ["unavailable", 503],
  MCP_DIRECTORY_MISCONFIGURED: ["misconfigured", 502],
  MCP_DIRECTORY_NOT_FOUND: ["notFound", 404],
  MCP_DIRECTORY_INVALID: ["invalid", 502],
  MCP_DIRECTORY_INVALID_REQUEST: ["invalidRequest", 400],
};

/** A directory problem with its stable code; the message names no host or term. */
export function directoryProblem(code) {
  const known = codes[code];
  if (!known) throw Error(`Unknown directory code ${code}`);
  const [key, status] = known;
  return Object.assign(problem(serverMessages.mcpDirectory[key], status), { code });
}
