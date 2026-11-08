// The inbox at /inbox, a tab as `?tab=`, and every item at its stable address
// /inbox/<type>/<id> (the server's item types).
export const inboxTypes = [
  "question",
  "approval",
  "gate",
  "craft",
  "action",
  "team",
  "unresolved",
];
export const inboxTabs = ["all", "questions", "approvals", "gates", "agents"];
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;
// A rebuild's question is `<rebuildId>:<questionId>` (its ":" arrives encoded).
const craftPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;

function itemId(type, raw) {
  if (type !== "craft") return idPattern.test(raw) ? raw : null;
  try {
    const id = decodeURIComponent(raw);
    return craftPattern.test(id) ? id : null;
  } catch {
    return null;
  }
}

export function readInboxRoute(pathname, search) {
  const match = /^\/inbox(?:\/([^/]+)\/([^/]+))?$/.exec(pathname);
  if (!match) return null;
  const id = match[1] && inboxTypes.includes(match[1]) && itemId(match[1], match[2]);
  if (match[1] && !id) return { view: "missing" };
  const tab = new URLSearchParams(search).get("tab");
  return {
    view: "inbox",
    inboxTab: inboxTabs.includes(tab) ? tab : "all",
    itemType: match[1] || "",
    itemId: id || "",
  };
}

export function inboxRoutePath(route) {
  const item =
    route.itemType && route.itemId
      ? `/${encodeURIComponent(route.itemType)}/${encodeURIComponent(route.itemId)}`
      : "";
  const tab = route.inboxTab && route.inboxTab !== "all" ? `?tab=${route.inboxTab}` : "";
  return `/inbox${item}${tab}`;
}

export const itemKey = (item) => `${item.type}:${item.id}`;
