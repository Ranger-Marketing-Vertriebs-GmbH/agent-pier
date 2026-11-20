/**
 * The address of a preview: the page's own host name on the preview's slot port, so a
 * tailnet name stays a tailnet name. An IPv6 host is put in brackets.
 */
export function previewHref(preview, location = window.location) {
  const host = location.hostname.includes(":")
    ? `[${location.hostname.replace(/^\[|\]$/g, "")}]`
    : location.hostname;
  return `${location.protocol}//${host}:${preview.slot}${preview.path || "/"}`;
}

const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * True when AgentPier is open at this computer's own address while Tailscale Serve
 * carries the previews (`serve` of GET /api/previews): the preview links then point at
 * slots whose local listeners sit 1000 ports higher, so they do not open.
 */
export function loopbackUnderTailscale(serve, location = window.location) {
  return Boolean(serve && !serve.skipped && loopbackHosts.has(location.hostname));
}
