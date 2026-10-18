// The inbox at /inbox, a tab as `?tab=`, and every item at its stable address
// /inbox/<type>/<id> (the server's item types).
export const inboxTypes = ["question", "approval", "gate", "action", "team"];
export const inboxTabs = ["all", "questions", "approvals", "gates", "agents"];
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;

export function readInboxRoute(pathname, search) {
  const match = /^\/inbox(?:\/([^/]+)\/([^/]+))?$/.exec(pathname);
  if (!match) return null;
  if (match[1] && (!inboxTypes.includes(match[1]) || !idPattern.test(match[2])))
    return { view: "missing" };
  const tab = new URLSearchParams(search).get("tab");
  return {
    view: "inbox",
    inboxTab: inboxTabs.includes(tab) ? tab : "all",
    itemType: match[1] || "",
    itemId: match[2] || "",
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
