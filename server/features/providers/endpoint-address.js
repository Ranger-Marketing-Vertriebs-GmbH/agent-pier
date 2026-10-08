import dns from "node:dns";
import net from "node:net";
import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";

function ipv4Number(ip) {
  return ip.split(".").reduce((sum, part) => sum * 256 + Number(part), 0);
}
function inV4(ip, base, bits) {
  const mask = bits === 0 ? 0 : 2 ** 32 - 2 ** (32 - bits);
  return (ipv4Number(ip) & mask) >>> 0 === (ipv4Number(base) & mask) >>> 0;
}
/** Expands a valid IPv6 literal (incl. dotted IPv4 tails) to eight 16-bit words. */
function expandV6(ip) {
  let text = ip;
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const n = ipv4Number(dotted[1]);
    const tail = `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
    text = text.slice(0, -dotted[1].length) + tail;
  }
  const [head, tail = ""] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const fill = text.includes("::") ? 8 - left.length - right.length : 0;
  return [...left, ...Array(fill).fill("0"), ...right].map((part) => parseInt(part, 16));
}
function wordsToV4(high, low) {
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}
function classifyV4(ip) {
  if (inV4(ip, "0.0.0.0", 8) || inV4(ip, "224.0.0.0", 4) || ip === "255.255.255.255")
    return "forbidden";
  if (inV4(ip, "127.0.0.0", 8)) return "loopback";
  if (
    inV4(ip, "10.0.0.0", 8) ||
    inV4(ip, "172.16.0.0", 12) ||
    inV4(ip, "192.168.0.0", 16)
  )
    return "private";
  if (inV4(ip, "169.254.0.0", 16)) return "linkLocal";
  if (inV4(ip, "100.64.0.0", 10)) return "cgnat";
  return "public";
}
export function classifyAddress(input) {
  const ip = String(input ?? "")
    .replace(/^\[|\]$/g, "")
    .split("%")[0];
  if (net.isIPv4(ip)) return classifyV4(ip);
  if (!net.isIPv6(ip)) return "forbidden";
  const words = expandV6(ip);
  if (words.every((word) => word === 0)) return "forbidden";
  const zeros = (count) => words.slice(0, count).every((word) => word === 0);
  // IPv4-mapped (::ffff:0:0/96) classifies as its IPv4 address; NAT64 (64:ff9b::/96) is
  // reached via a translator, so it is public (or forbidden for non-global embeds).
  if (zeros(5) && words[5] === 0xffff) return classifyV4(wordsToV4(words[6], words[7]));
  if (words[0] === 0x64 && words[1] === 0xff9b && words.slice(2, 6).every((w) => w === 0))
    return classifyV4(wordsToV4(words[6], words[7])) === "forbidden"
      ? "forbidden"
      : "public";
  if (zeros(7) && words[7] === 1) return "loopback";
  if (zeros(6)) return "forbidden"; // deprecated IPv4-compatible range
  if ((words[0] & 0xff00) === 0xff00) return "forbidden";
  if ((words[0] & 0xfe00) === 0xfc00) return "private";
  if ((words[0] & 0xffc0) === 0xfe80) return "linkLocal";
  return "public";
}
const LOCAL = new Set(["loopback", "private", "linkLocal", "cgnat"]);
const notAllowed = () =>
  Object.assign(problem(serverMessages.providers.endpointUrlNotAllowed), {
    reason: "notAllowed",
  });

/** Throws the `notAllowed` problem for any scheme other than http and https. */
export function assertAllowedProtocol(protocol) {
  if (protocol !== "http:" && protocol !== "https:") throw notAllowed();
}

/**
 * Throws the `notAllowed` problem unless every address may be reached over `protocol`:
 * no address may be forbidden, and plain http is limited to local address kinds.
 */
export function assertAllowedAddresses(addresses, protocol) {
  const kinds = addresses.map(({ address }) => classifyAddress(address));
  if (
    kinds.includes("forbidden") ||
    (protocol === "http:" && kinds.some((kind) => !LOCAL.has(kind)))
  )
    throw notAllowed();
}

/**
 * A Node socket `lookup` that resolves every address of the host and applies the endpoint
 * URL rule on each call. An agent using it re-checks the policy for every new connection,
 * so a name that later resolves elsewhere (DNS rebinding) cannot reach a refused address;
 * the socket connects only to the addresses that passed the check.
 */
export function policyLookup(protocol, lookup = dns.lookup) {
  return (hostname, options, callback) =>
    lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error) return callback(error);
      try {
        if (!Array.isArray(addresses) || !addresses.length) throw new Error("unresolved");
        assertAllowedAddresses(addresses, protocol);
      } catch {
        return callback(
          Object.assign(new Error("upstream address not allowed"), {
            code: "EADDRNOTALLOWED",
            reason: "notAllowed",
            adapterKind: "network",
          }),
        );
      }
      const checked = addresses.map(({ address, family }) => ({ address, family }));
      if (options?.all) callback(null, checked);
      else callback(null, checked[0].address, checked[0].family);
    });
}
/**
 * Resolves and checks an endpoint host. A host that does not resolve is a reachability
 * problem (`reason: "network"`), not a policy refusal (`reason: "notAllowed"`).
 */
export async function resolveEndpointTarget(
  value,
  { lookup = dns.promises.lookup, timeoutMs } = {},
) {
  const url = new URL(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const unresolved = () =>
    Object.assign(problem(serverMessages.providers.endpointHostUnresolved, 502), {
      reason: "network",
    });
  let timer;
  // dns.lookup cannot be cancelled; with timeoutMs a stalled lookup ends as unresolved.
  const deadline =
    timeoutMs === undefined || net.isIP(hostname)
      ? []
      : [
          new Promise((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
          }),
        ];
  const addresses = net.isIP(hostname)
    ? [{ address: hostname, family: net.isIP(hostname) }]
    : await Promise.race([lookup(hostname, { all: true, verbatim: true }), ...deadline])
        .catch(() => {
          throw unresolved();
        })
        .finally(() => clearTimeout(timer));
  if (!Array.isArray(addresses) || !addresses.length) throw unresolved();
  assertAllowedAddresses(addresses, url.protocol);
  // Every address passed the check, so a connection may fall back between them.
  return {
    hostname,
    address: addresses[0].address,
    family: addresses[0].family,
    addresses: addresses.map(({ address, family }) => ({ address, family })),
  };
}
