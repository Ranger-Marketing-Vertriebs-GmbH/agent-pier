// The restricted user's own routes. Her app knows only these; every other path of
// the owner's app is "missing" in it, so a pasted owner link leads nowhere.
const segment = "([A-Za-z0-9_-]+)";
const chat = new RegExp(`^/agents/${segment}/chats/${segment}$`);
const settings = new RegExp(`^/agents/${segment}/settings$`);
const browser = new RegExp(`^/agents/${segment}/browser$`);
const pages = new Set(["memory"]);

/** The route of `location` ({ pathname, search }) in the user app. */
export function readUserRoute({ pathname = "/", search = "" } = {}) {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/" || path === "/agents") return { view: "agents" };
  if (path === "/account") return { view: "account" };
  let match = chat.exec(path);
  if (match) return { view: "chat", agentId: match[1], conversationId: match[2] };
  match = settings.exec(path);
  if (match) {
    const page = new URLSearchParams(search).get("page");
    return { view: "settings", agentId: match[1], ...(pages.has(page) && { page }) };
  }
  match = browser.exec(path);
  if (match) return { view: "browser", agentId: match[1] };
  return { view: "missing" };
}

const id = (value) => encodeURIComponent(value);

/** The address of a user app route; an unknown one leads to her agents. */
export function userRoutePath(route) {
  switch (route?.view) {
    case "chat":
      return `/agents/${id(route.agentId)}/chats/${id(route.conversationId)}`;
    case "settings":
      return `/agents/${id(route.agentId)}/settings${route.page ? `?page=${route.page}` : ""}`;
    case "browser":
      return `/agents/${id(route.agentId)}/browser`;
    case "account":
      return "/account";
    default:
      return "/agents";
  }
}
