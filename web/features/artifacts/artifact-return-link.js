import { readRoute, routePath } from "../../app/routes.js";

function returnPath(value) {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[\\\x00-\x1f\x7f]/.test(value)
  )
    return "/artifacts";
  const separator = value.search(/[?#]/);
  const pathname = separator < 0 ? value : value.slice(0, separator);
  const route = readRoute({
    pathname,
    search: value.slice(pathname.length).split("#")[0],
  });
  if (route.view === "artifacts" || (route.view === "workspace" && route.mode))
    return routePath(route);
  return "/artifacts";
}

export function artifactReturnPath(search) {
  return returnPath(new URLSearchParams(search).get("returnTo"));
}

// Context belongs to the browser opening the artifact, not its publisher or iframe.
// Returning null lets callers preserve their handling of ordinary web/file links.
export function artifactLink(href, returnTo, location = window.location) {
  if (typeof href !== "string" || !href) return null;
  try {
    const url = new URL(href, location.href);
    if (
      url.origin !== location.origin ||
      url.username ||
      url.password ||
      !/^\/artifacts\/view\/[A-Za-z0-9-]+\/?$/.test(url.pathname)
    )
      return null;
    url.searchParams.set("returnTo", returnPath(returnTo));
    return url.pathname + url.search + url.hash;
  } catch {
    return null;
  }
}
