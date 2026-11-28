// Whether a listening socket's local address, as `lsof` or `ss` prints it, is on
// loopback: 127.0.0.0/8, ::1, or an IPv4-mapped 127.x address (`::ffff:127.0.0.1`,
// what Linux shows for a dual-stack socket bound to IPv4 loopback). Brackets around
// an IPv6 address are accepted. Everything else is not loopback, in particular the
// wildcards `*`, `0.0.0.0`, `::` and `::ffff:0.0.0.0`.
const octet = "(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)";
const ipv4Loopback = `127(?:\\.${octet}){3}`;
const pattern = new RegExp(`^(?:${ipv4Loopback}|::1|::ffff:${ipv4Loopback})$`, "i");

export function isLoopbackAddress(address) {
  if (typeof address !== "string") return false;
  const bare = /^\[.*\]$/.test(address) ? address.slice(1, -1) : address;
  return pattern.test(bare);
}
