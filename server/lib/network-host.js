// Network mode's extra hosts (network-config.js), also checked in the browser before
// a host is added (Settings › Remote access › Network): a DNS name or an IP address,
// without scheme, port or path. Pure: no Node module, so the web app imports it too.

// A DNS label is at most 63 characters, the whole name at most 253.
const hostPattern =
  /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const ipv4 =
  /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** Whether `value` is an IPv6 address (as the URL parser reads one in brackets). */
function ipv6(value) {
  if (!value.includes(":") || /[[\]/%\s]/.test(value)) return false;
  try {
    return new URL(`http://[${value}]/`).hostname.length > 2;
  } catch {
    return false;
  }
}

/** The host as stored (lower case), or null when it is no name or address. */
export function networkHost(value) {
  if (typeof value !== "string") return null;
  const host = value.trim().toLowerCase();
  return host && (hostPattern.test(host) || ipv4.test(host) || ipv6(host)) ? host : null;
}
