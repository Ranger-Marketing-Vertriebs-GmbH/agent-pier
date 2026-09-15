import { readSettingsRoute, settingsRoutePath } from "../features/operations/routes.js";
import { readPipelineRoute, pipelineRoutePath } from "../features/pipelines/routes.js";
import { readExplorerRoute, explorerQuery } from "../features/files/routes.js";
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
export function readRoute(location) {
  let pathname;
  try {
    pathname = decodeURIComponent(location.pathname);
  } catch {
    return {
      view: "missing",
    };
  }
  pathname = pathname.replace(/\/+$/, "") || "/";
  if (pathname === "/" && location.hash?.length > 1) {
    let id;
    try {
      id = decodeURIComponent(location.hash.slice(1));
    } catch {
      return {
        view: "missing",
      };
    }
    return idPattern.test(id)
      ? {
          view: "workspace",
          sessionId: id,
          mode: null,
        }
      : {
          view: "missing",
        };
  }
  if (pathname === "/")
    return {
      view: "workspace",
      sessionId: "",
    };
  if (["/accounts", "/repositories"].includes(pathname))
    return {
      view: pathname.slice(1),
    };
  if (pathname === "/files")
    return {
      view: "files",
      ...readExplorerRoute(location.search),
    };
  const settingsRoute = readSettingsRoute(pathname, location.search);
  if (settingsRoute) return settingsRoute;
  const pipelineRoute = readPipelineRoute(pathname, location.search);
  if (pipelineRoute) return pipelineRoute;
  const memory = /^\/memory(?:\/([^/]+))?$/.exec(pathname);
  if (memory && (!memory[1] || idPattern.test(memory[1]))) {
    const query = new URLSearchParams(location.search);
    const rawPage = query.get("page") || "1";
    return {
      view: "memory",
      projectId: memory[1] || "",
      query: (query.get("q") || "").slice(0, 300),
      archived: query.get("archived") === "1",
      memoryPage:
        /^[1-9]\d*$/.test(rawPage) &&
        Number.isSafeInteger(Number(rawPage)) &&
        Number(rawPage) <= 100000
          ? Number(rawPage)
          : 1,
    };
  }
  const bus = /^\/agentbus(?:\/(messages)(?:\/([^/]+))?)?$/.exec(pathname);
  if (bus && (!bus[2] || idPattern.test(bus[2]))) {
    const page = new URLSearchParams(location.search).get("page") || "";
    const messagePage =
      bus[1] && /^[1-9]\d*$/.test(page) && Number.isSafeInteger(Number(page))
        ? Number(page)
        : 1;
    return {
      view: "agentbus",
      busTab: bus[1] || "status",
      projectId: bus[2] || "",
      messagePage,
    };
  }
  const profile = /^\/(extensions|plugins)(?:\/([^/]+))?$/.exec(pathname);
  if (profile && (!profile[2] || idPattern.test(profile[2])))
    return {
      view: profile[1],
      profileId: profile[2] || "",
    };
  const session = /^\/sessions\/([^/]+)(?:\/(chat|reader|terminal|files))?$/.exec(
    pathname,
  );
  if (session && idPattern.test(session[1]))
    return {
      view: "workspace",
      sessionId: session[1],
      mode: session[2] === "chat" ? "reader" : session[2] || null,
      ...(session[2] === "files" ? readExplorerRoute(location.search) : {}),
    };
  return {
    view: "missing",
  };
}
export function routePath(route) {
  if (route.view === "files") return `/files${explorerQuery(route)}`;
  if (route.view === "settings") return settingsRoutePath(route);
  if (route.view === "pipelines") return pipelineRoutePath(route);
  if (route.view === "memory") {
    const query = new URLSearchParams();
    if (route.query) query.set("q", route.query);
    if (route.archived) query.set("archived", "1");
    if (Number.isSafeInteger(route.memoryPage) && route.memoryPage > 1)
      query.set("page", String(route.memoryPage));
    return `/memory${route.projectId ? `/${encodeURIComponent(route.projectId)}` : ""}${query.size ? `?${query}` : ""}`;
  }
  if (route.view === "agentbus")
    return route.busTab === "messages"
      ? `/agentbus/messages${route.projectId ? `/${encodeURIComponent(route.projectId)}` : ""}${Number.isSafeInteger(route.messagePage) && route.messagePage > 1 ? `?page=${route.messagePage}` : ""}`
      : "/agentbus";
  if (route.view === "workspace")
    return route.sessionId
      ? `/sessions/${encodeURIComponent(route.sessionId)}${route.mode ? `/${route.mode === "reader" ? "chat" : route.mode}` : ""}${route.mode === "files" ? explorerQuery(route) : ""}`
      : "/";
  if (route.view === "extensions" || route.view === "plugins")
    return `/${route.view}${route.profileId ? `/${encodeURIComponent(route.profileId)}` : ""}`;
  return `/${route.view}`;
}
export function defaultSessionMode(session, mobile) {
  return session.tool !== "shell" && session.purpose !== "login" && mobile
    ? "reader"
    : "terminal";
}
