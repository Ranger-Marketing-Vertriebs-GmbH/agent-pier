import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";

// The owner's MCP directory setting. The base URL is the only address AgentPier sends
// search terms to, so it is held to https (http only on this computer).
export const defaultBaseUrl = "https://registry.modelcontextprotocol.io";
const limit = 512;

const invalid = () =>
  Object.assign(problem(serverMessages.mcpDirectory.invalidSettings, 400), {
    code: "MCP_DIRECTORY_INVALID_SETTINGS",
  });

export const isLoopbackHost = (hostname) =>
  hostname === "localhost" ||
  hostname === "[::1]" ||
  /^127(?:\.\d{1,3}){3}$/.test(hostname);

export function normaliseBaseUrl(value) {
  if (typeof value !== "string") throw invalid();
  const text = value.trim();
  if (!text || text.length > limit || /[?#]/.test(text)) throw invalid();
  let url;
  try {
    url = new URL(text);
  } catch {
    throw invalid();
  }
  if (url.username || url.password) throw invalid();
  const secure = url.protocol === "https:";
  const local = url.protocol === "http:" && isLoopbackHost(url.hostname);
  if (!secure && !local) throw invalid();
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

/** The stored setting, or the defaults for anything that does not validate. */
export function directorySettings(saved) {
  const record = saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
  let baseUrl = defaultBaseUrl;
  try {
    if (record.baseUrl !== undefined) baseUrl = normaliseBaseUrl(record.baseUrl);
  } catch {
    baseUrl = defaultBaseUrl;
  }
  return {
    enabled: typeof record.enabled === "boolean" ? record.enabled : true,
    baseUrl,
  };
}
