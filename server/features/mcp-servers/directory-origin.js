import { invalid } from "./mcp-server-fields.js";

// Which MCP Registry entry a server was set up from (decision Q9). Not secret; it
// only decides the "Update available" hint.
const namePattern = /^[A-Za-z0-9.-]{1,150}\/[A-Za-z0-9._-]{1,150}$/;
const versionPattern = /^[\x21-\x7e]{1,128}$/;

const valid = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).every((key) => key === "name" || key === "version") &&
  typeof value.name === "string" &&
  namePattern.test(value.name) &&
  typeof value.version === "string" &&
  versionPattern.test(value.version);

/** The origin a create request carries, or null; a present invalid one is a 400. */
export function cleanDirectoryOrigin(value) {
  if (value === undefined || value === null) return null;
  if (!valid(value)) throw invalid();
  return { name: value.name, version: value.version };
}

/** The stored column, or null for anything that does not validate. */
export function readDirectoryOrigin(text) {
  if (typeof text !== "string" || !text) return null;
  try {
    const value = JSON.parse(text);
    return valid(value) ? { name: value.name, version: value.version } : null;
  } catch {
    return null;
  }
}
