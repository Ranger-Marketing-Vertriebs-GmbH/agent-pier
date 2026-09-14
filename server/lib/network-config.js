import net from "node:net";
import { problem } from "./storage.js";
import { serverMessages } from "./i18n/de.js";

const MAX_HOSTS = 20;
/** Only wildcards: a fixed interface address silently loses reachability on a new lease. */
const binds = ["0.0.0.0", "::"];
const keys = ["enabled", "bind", "hosts"];
// A DNS label is at most 63 characters, the whole name at most 253.
const hostPattern =
  /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const invalid = () => problem(serverMessages.settings.invalidNetworkConfig);

/** Accepts the stored or submitted `network` block; missing means disabled. */
export function normalizeNetworkConfig(raw) {
  if (raw === undefined || raw === null)
    return { enabled: false, bind: "0.0.0.0", hosts: [] };
  if (typeof raw !== "object" || Array.isArray(raw)) throw invalid();
  if (Object.keys(raw).some((key) => !keys.includes(key))) throw invalid();
  const enabled = raw.enabled === undefined ? false : raw.enabled;
  if (typeof enabled !== "boolean") throw invalid();
  const bind = raw.bind === undefined ? "0.0.0.0" : raw.bind;
  if (!binds.includes(bind)) throw invalid();
  const hosts = raw.hosts === undefined ? [] : raw.hosts;
  if (!Array.isArray(hosts) || hosts.length > MAX_HOSTS) throw invalid();
  const normalized = hosts.map((host) => {
    if (typeof host !== "string") throw invalid();
    const value = host.toLowerCase();
    if (net.isIP(value) === 0 && !hostPattern.test(value)) throw invalid();
    return value;
  });
  return { enabled, bind, hosts: [...new Set(normalized)] };
}
