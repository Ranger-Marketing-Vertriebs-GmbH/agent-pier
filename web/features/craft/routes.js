// Rebuilds page: /craft (the list, the start form and the defaults) and
// /craft/<rebuildId> (one rebuild). Rebuild ids are UUIDs (REBUILD_ID on the server).
const rebuildId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const craftRoute = (id = "") => ({ view: "craft", rebuildId: id });

/** The route of a decoded pathname under /craft, `{ view: "missing" }` or null. */
export function readCraftRoute(pathname) {
  const match = /^\/craft(?:\/([^/]+))?$/.exec(pathname);
  if (!match) return null;
  if (match[1] && !rebuildId.test(match[1])) return { view: "missing" };
  return craftRoute(match[1] || "");
}

export const craftRoutePath = (route) =>
  route.rebuildId && rebuildId.test(route.rebuildId)
    ? `/craft/${route.rebuildId}`
    : "/craft";
