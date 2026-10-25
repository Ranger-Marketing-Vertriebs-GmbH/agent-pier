const path = (id) => `/hooks/${id}`;

/**
 * The working addresses of a hook, one per host branch the endpoint accepts: the
 * loopback address always, the Tailscale Serve origin when one is configured and
 * every network-mode URL while network mode is on.
 */
export function hookAddresses({ config = {}, networkUrls = [] } = {}, hookId) {
  let tailscale = null;
  if (config.remoteUrl) {
    try {
      tailscale = new URL(config.remoteUrl).origin + path(hookId);
    } catch {
      tailscale = null;
    }
  }
  return {
    local: `http://127.0.0.1:${config.port}${path(hookId)}`,
    tailscale,
    network: config.network?.enabled
      ? networkUrls.map((url) => url.replace(/\/+$/, "") + path(hookId))
      : [],
  };
}
