/**
 * The browser toolbar of a takeover (docs/assistant-gateway.md "Takeover"): checks
 * the owner's navigation and tab commands, maps back, forward, reload and stop to
 * the CDP calls the takeover sends to the shown tab, and applies the agent browser's
 * private-network rule to the addresses the owner opens.
 */
import { promises as dns } from "node:dns";
import net from "node:net";

const MAX_URL = 2048;
const actions = ["go", "back", "forward", "reload", "stop"];
const tabActions = ["switch", "close"];
// Any scheme the owner names; a bare "host:port" is not one.
const scheme = /^[a-z][a-z0-9+.-]*:(?!\d+(?:[/?#]|$))/i;
const controls = /[\u0000-\u001f\u007f]/;

/**
 * The web address for what the owner typed: http(s), or about:blank; without a
 * scheme it is https. Null for anything else (javascript:, file:, data:, chrome:),
 * for credentials in the address, for spaces (there is no search) and for overlong
 * text.
 */
export function typedAddress(text) {
  if (typeof text !== "string") return null;
  const value = text.trim();
  if (!value || value.length > MAX_URL || controls.test(value) || /\s/.test(value))
    return null;
  if (value.toLowerCase() === "about:blank") return "about:blank";
  let url;
  try {
    url = new URL(scheme.test(value) ? value : `https://${value}`);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname) return null;
  if (url.username || url.password) return null;
  return url.href.length > MAX_URL ? null : url.href;
}

/** A checked `navigate` command (`{ action, url? }`), or null. */
export function validateNavigation(command) {
  if (!command || typeof command !== "object" || command.type !== "navigate") return null;
  if (!actions.includes(command.action)) return null;
  if (command.action !== "go") return { action: command.action };
  const url = typedAddress(command.url);
  return url ? { action: "go", url } : null;
}

/** A checked `tab` command (`{ action, targetId }`), or null. */
export function validateTab(command) {
  if (!command || typeof command !== "object" || command.type !== "tab") return null;
  if (!tabActions.includes(command.action)) return null;
  const { targetId } = command;
  if (typeof targetId !== "string" || !targetId || targetId.length > 200) return null;
  return { action: command.action, targetId };
}

/**
 * The first CDP calls of a history command: reload and stop act at once, back and
 * forward first read the tab's history (`historyStep` picks the entry).
 */
export function historyCalls(action) {
  if (action === "reload") return [["Page.reload", {}]];
  if (action === "stop") return [["Page.stopLoading", {}]];
  return [["Page.getNavigationHistory", {}]];
}

/** The history entry back or forward leads to (`{ id, url }`), or null at an end. */
export function historyStep(history, action) {
  const entries = Array.isArray(history?.entries) ? history.entries : null;
  const index = history?.currentIndex;
  if (!entries || !Number.isInteger(index)) return null;
  const entry = entries[index + (action === "back" ? -1 : 1)];
  if (!Number.isInteger(entry?.id) || typeof entry.url !== "string") return null;
  return { id: entry.id, url: entry.url };
}

// Loopback, private, link-local (cloud metadata), shared and unspecified ranges: what
// OpenClaw's browser SSRF policy refuses unless the owner allows private networks.
const blocked = new net.BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
])
  blocked.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
])
  blocked.addSubnet(address, prefix, "ipv6");

function privateAddress(address) {
  const family = net.isIP(address);
  if (!family) return true;
  if (family === 6) {
    // An IPv4 address written as IPv6 (::ffff:127.0.0.1) counts as that address.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
    if (mapped) return blocked.check(mapped, "ipv4");
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
    if (hex) {
      const high = parseInt(hex[1], 16),
        low = parseInt(hex[2], 16);
      return blocked.check(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`, "ipv4");
    }
    return blocked.check(address, "ipv6");
  }
  return blocked.check(address, "ipv4");
}

/**
 * Whether the owner may open `url` in an agent's browser: http(s) or about:blank,
 * and, unless the owner allowed private networks for agent browsers, only a host
 * whose every address is public (`lookup` resolves names; one that does not resolve
 * is refused). OpenClaw's own policy still applies to its navigation on top.
 */
export async function navigationAllowed(
  url,
  {
    allowPrivateNetwork = false,
    lookup = (host) => dns.lookup(host, { all: true }),
  } = {},
) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.href === "about:blank") return true;
  if (!["http:", "https:"].includes(parsed.protocol)) return false;
  if (parsed.username || parsed.password) return false;
  if (allowPrivateNetwork) return true;
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  if (net.isIP(host)) return !privateAddress(host);
  try {
    const addresses = await lookup(host);
    return (
      Array.isArray(addresses) &&
      addresses.length > 0 &&
      addresses.every(({ address }) => !privateAddress(address))
    );
  } catch {
    return false;
  }
}
