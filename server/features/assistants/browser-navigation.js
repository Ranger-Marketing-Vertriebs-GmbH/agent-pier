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

// The 16 bytes of an IPv6 address (net.isIP 6), or null.
function ipv6Bytes(address) {
  let text = address.toLowerCase();
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)?.[1];
  if (dotted) {
    const [a, b, c, d] = dotted.split(".").map(Number);
    text = `${text.slice(0, -dotted.length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.includes("::") ? text.split("::") : [text, null];
  const part = (value) => (value ? value.split(":") : []);
  const left = part(head);
  const right = tail === null ? [] : part(tail);
  const groups =
    tail === null
      ? left
      : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  if (groups.length !== 8) return null;
  return groups.flatMap((group) => {
    const value = parseInt(group, 16);
    return [value >> 8, value & 255];
  });
}

/**
 * The IPv4 address an IPv6 address stands for, or null: IPv4-mapped
 * (`::ffff:a.b.c.d`), IPv4-compatible (`::a.b.c.d`, also written `::7f00:1`) and the
 * NAT64 prefixes `64:ff9b::/96` and `64:ff9b:1::/48`, which reach that IPv4 host.
 */
export function embeddedIpv4(address) {
  if (net.isIP(address) !== 6) return null;
  const bytes = ipv6Bytes(address);
  if (!bytes) return null;
  const zero = (from, to) => bytes.slice(from, to).every((b) => b === 0);
  const v4 = bytes.slice(12).join(".");
  if (zero(0, 10) && bytes[10] === 255 && bytes[11] === 255) return v4;
  // ::a.b.c.d, but not :: and ::1 themselves.
  if (zero(0, 12) && !zero(12, 15)) return v4;
  if (bytes[0] === 0 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b) {
    if (zero(4, 12)) return v4;
    // A /48 prefix carries the IPv4 address around the "u" octet (RFC 6052 2.2).
    if (bytes[4] === 0 && bytes[5] === 1)
      return [bytes[6], bytes[7], bytes[9], bytes[10]].join(".");
  }
  return null;
}

/**
 * Whether an IP address is loopback, private, link-local (cloud metadata), shared,
 * unspecified or multicast, also when an IPv6 form stands for such an IPv4 address
 * (embeddedIpv4). Anything that is no IP address counts as private.
 */
export function privateAddress(address) {
  const value = String(address || "").replace(/^\[|\]$/g, "");
  const family = net.isIP(value);
  if (!family) return true;
  if (family === 6) {
    const v4 = embeddedIpv4(value);
    return v4 ? blocked.check(v4, "ipv4") : blocked.check(value, "ipv6");
  }
  return blocked.check(value, "ipv4");
}

// Cloud metadata services: never opened, whatever the private-network setting.
const metadataV4 = new Set(["169.254.169.254", "100.100.100.200"]);
export const metadataHosts = new Set(["metadata.google.internal", "metadata"]);

/** Whether an IP address (any form of it) is a cloud metadata service's. */
export function metadataAddress(address) {
  const value = String(address || "")
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  const family = net.isIP(value);
  if (family === 4) return metadataV4.has(value);
  if (family !== 6) return false;
  const v4 = embeddedIpv4(value);
  if (v4) return metadataV4.has(v4);
  const bytes = ipv6Bytes(value);
  // fd00:ec2::254 (AWS over IPv6).
  return !!bytes && bytes.join(",") === ipv6Bytes("fd00:ec2::254").join(",");
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
