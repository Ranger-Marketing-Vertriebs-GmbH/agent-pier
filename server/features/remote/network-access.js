import os from "node:os";
import net from "node:net";
import path from "node:path";
import { readJSON, writePrivate } from "../../lib/storage.js";
import { normalizeNetworkConfig } from "../../lib/network-config.js";

export { normalizeNetworkConfig };

// Tailscale's own ranges belong to the Tailscale path and are never auto-allowed here.
const tailscaleRange = (address) =>
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address) ||
  address.startsWith("fd7a:115c:a1e0:");
// RFC1918 IPv4 and IPv6 unique local addresses; public and CGNAT addresses stay off the list.
const privateRange = (address) =>
  /^10\./.test(address) ||
  /^172\.(1[6-9]|2\d|3[01])\./.test(address) ||
  /^192\.168\./.test(address) ||
  (net.isIPv6(address) && /^f[cd]/.test(address));

/** Private, non-internal interface addresses and the lower-cased machine name. */
export function detectNetworkAddresses({
  interfaces = os.networkInterfaces,
  hostname = os.hostname,
} = {}) {
  const addresses = [];
  for (const entries of Object.values(interfaces()))
    for (const entry of entries || []) {
      if (entry.internal) continue;
      const address = entry.address.split("%")[0].toLowerCase();
      if (tailscaleRange(address) || !privateRange(address)) continue;
      if (!addresses.includes(address)) addresses.push(address);
    }
  return {
    addresses,
    hostname: hostname()
      .toLowerCase()
      .replace(/\.local$/, ""),
  };
}

const hostWithPort = (host, port) => `${net.isIPv6(host) ? `[${host}]` : host}:${port}`;

function candidates(network, detected) {
  if (!network.enabled) return [];
  const names = [
    ...network.hosts,
    detected.hostname,
    // mDNS only ever answers for the bare machine name, never for a name that already has a domain.
    ...(detected.hostname && !detected.hostname.includes(".")
      ? [`${detected.hostname}.local`]
      : []),
    ...detected.addresses,
  ];
  return [...new Set(names.filter(Boolean))];
}

/** Exact `Host` header values accepted by the network branch. */
export function allowedNetworkHosts(network, port, detected) {
  return new Set(candidates(network, detected).map((host) => hostWithPort(host, port)));
}

export function networkUrls(network, port, detected) {
  return candidates(network, detected).map(
    (host) => `http://${hostWithPort(host, port)}`,
  );
}

const file = (dataDir) => path.join(dataDir, "config.json");

export function readNetworkConfig(dataDir) {
  const saved = readJSON(file(dataDir), {});
  return { ...saved, network: normalizeNetworkConfig(saved.network) };
}

export function writeNetworkConfig(dataDir, network) {
  const saved = readJSON(file(dataDir), {});
  writePrivate(file(dataDir), { ...saved, network: normalizeNetworkConfig(network) });
}
