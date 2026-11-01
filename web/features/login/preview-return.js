// A preview sends a signed-out owner here with ?preview=<port>&path=<path>.
export const previewParams = ["preview", "path"];

/**
 * Where to return after signing in: the preview port on the host name this page was
 * opened with, never another host. Null when the parameters are missing or unsafe.
 */
export function previewReturn(search, location) {
  const params = new URLSearchParams(search);
  const slot = params.get("preview");
  if (!slot || !/^[1-9]\d{3,4}$/.test(slot)) return null;
  const port = Number(slot);
  if (port < 1024 || port > 65535) return null;
  const path = params.get("path") ?? "/";
  // "//host" and "/\host" leave the origin; control characters never belong in a path.
  if (
    !path.startsWith("/") ||
    /^\/[/\\]/.test(path) ||
    /[\\\u0000-\u001f\u007f]/.test(path)
  )
    return null;
  if (!["http:", "https:"].includes(location.protocol)) return null;
  const target = `${location.protocol}//${location.hostname}:${port}${path}`;
  try {
    const url = new URL(target);
    if (url.hostname !== location.hostname || url.port !== slot) return null;
  } catch {
    return null;
  }
  return target;
}
