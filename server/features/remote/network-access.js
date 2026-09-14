import os from "node:os";
import net from "node:net";
import path from "node:path";
import { problem, readJSON, writePrivate } from "../../lib/storage.js";
import { serverMessages } from "../../lib/i18n/de.js";

const MAX_HOSTS = 20;
const hostPattern =
  /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)*$/;
const invalid = () => problem(serverMessages.settings.invalidNetworkConfig);

/** Accepts the stored or submitted `network` block; missing means disabled. */
export function normalizeNetworkConfig(raw) {
  if (raw === undefined || raw === null)
    return { enabled: false, bind: "0.0.0.0", hosts: [] };
  if (typeof raw !== "object" || Array.isArray(raw)) throw invalid();
  const enabled = raw.enabled === undefined ? false : raw.enabled;
  if (typeof enabled !== "boolean") throw invalid();
  const bind = raw.bind === undefined ? "0.0.0.0" : raw.bind;
  if (typeof bind !== "string" || net.isIP(bind) === 0) throw invalid();
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

/** Non-internal interface addresses and the lower-cased machine name. */
export function detectNetworkAddresses({
  interfaces = os.networkInterfaces,
  hostname = os.hostname,
} = {}) {
  const addresses = [];
  for (const entries of Object.values(interfaces()))
    for (const entry of entries || []) {
      if (entry.internal) continue;
      const address = entry.address.split("%")[0];
      if (entry.family === "IPv6" && address.startsWith("fe80:")) continue;
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
    `${detected.hostname}.local`,
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
