import { BlockList, isIP } from "node:net";
import { lookup } from "node:dns";
const denied = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
])
  denied.addSubnet(address, prefix, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
for (const [address, prefix] of [
  ["2001::", 32],
  ["2001:db8::", 32],
  ["2001:10::", 28],
  ["2001:20::", 28],
  ["2002::", 16],
])
  denied.addSubnet(address, prefix, "ipv6");
export function publicPushAddress(address) {
  const family = isIP(address);
  return family === 4
    ? !denied.check(address, "ipv4")
    : family === 6 && globalV6.check(address, "ipv6") && !denied.check(address, "ipv6");
}
export function pushLookup(hostname, options, callback) {
  lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
    if (error) return callback(error);
    if (!addresses.length || addresses.some(({ address }) => !publicPushAddress(address)))
      return callback(Error("Push endpoint resolved to a non-public address."));
    if (options?.all) return callback(null, addresses);
    const target =
      addresses.find((item) => !options?.family || item.family === options.family) ||
      addresses[0];
    callback(null, target.address, target.family);
  });
}
