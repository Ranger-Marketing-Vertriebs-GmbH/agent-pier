import { readRoute, routePath } from "../../app/routes.js";
import { appPathParts, returnParam, withoutReturnParam } from "../../app/return-to.js";

function returnPath(value) {
  const parts = appPathParts(value);
  if (!parts) return "/artifacts";
  const route = readRoute({
    ...parts,
    hash: "",
    search: withoutReturnParam(parts.search),
  });
  if (route.view === "artifacts" || (route.view === "workspace" && route.mode))
    return routePath(route);
  return "/artifacts";
}

export function artifactReturnPath(search) {
  return returnPath(new URLSearchParams(search).get(returnParam));
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
    url.searchParams.set(returnParam, returnPath(returnTo));
    return url.pathname + url.search + url.hash;
  } catch {
    return null;
  }
}
