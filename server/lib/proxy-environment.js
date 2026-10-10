/**
 * Proxy settings are the only network configuration AgentPier passes on to the
 * processes it starts (npm ci, the assistant Gateway, its own service). Node never
 * reads a lowercase node_extra_ca_certs, so only the uppercase form is kept.
 */
const routing = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"];
const exclusions = ["NO_PROXY", "no_proxy"];
export const proxyVariables = [...routing, ...exclusions, "NODE_EXTRA_CA_CERTS"];
// Proxy clients match IPv6 loopback with or without brackets; both forms are kept.
export const loopbackHosts = ["localhost", "127.0.0.1", "::1", "[::1]"];
/** Node's built-in fetch honours NODE_USE_ENV_PROXY from these versions on. */
export const ENV_PROXY_MINIMUM_NODE = "22.21.0";

const present = (env, name) => typeof env?.[name] === "string" && env[name] !== "";

/** True when a request should be routed through an HTTP(S) proxy. */
export function proxyRouted(env = process.env) {
  return routing.some((name) => present(env, name));
}

/** NODE_USE_ENV_PROXY works on Node 22.21+ and 24+; 23 and older 22 ignore it. */
export function envProxySupported(version = process.versions.node) {
  const [major, minor] = String(version).split(".").map(Number);
  return major >= 24 || (major === 22 && minor >= 21);
}

/**
 * The allowlisted variables present in `parent`. When any proxy variable is set,
 * Node is told to use it, and loopback is always excluded so AgentPier, its health
 * checks and the Gateway connection never go through the proxy.
 */
export function proxyEnvironment(parent = process.env) {
  const picked = Object.fromEntries(
    proxyVariables
      .filter((name) => present(parent, name))
      .map((name) => [name, parent[name]]),
  );
  if (![...routing, ...exclusions].some((name) => picked[name])) return picked;
  const hosts = [
    ...new Set(
      [picked.NO_PROXY, picked.no_proxy, loopbackHosts.join(",")]
        .flatMap((value) => (value || "").split(","))
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ].join(",");
  return { ...picked, NO_PROXY: hosts, no_proxy: hosts, NODE_USE_ENV_PROXY: "1" };
}
