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
