import { readSettingsRoute, settingsRoutePath } from "../features/operations/routes.js";
import { readPipelineRoute, pipelineRoutePath } from "../features/pipelines/routes.js";
import { readExplorerRoute, explorerQuery } from "../features/files/routes.js";
import {
  readProjectsRoute,
  projectsRoute,
  projectsRoutePath,
} from "../features/projects/routes.js";
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
const extensionTabs = ["mcp", "skills", "plugins", "marketplaces", "agents"];
function readExtensionTab(search) {
  const tab = new URLSearchParams(search).get("tab");
  return extensionTabs.includes(tab) ? tab : "mcp";
}
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
  if (pathname === "/accounts")
    return {
      view: "accounts",
    };
  if (pathname === "/repositories") return projectsRoute();
  if (pathname === "/files")
    return {
      view: "files",
      ...readExplorerRoute(location.search),
    };
  const projectsRouteResult = readProjectsRoute(pathname, location.search);
  if (projectsRouteResult) return projectsRouteResult;
  const settingsRoute = readSettingsRoute(pathname, location.search);
  if (settingsRoute) return settingsRoute;
  const pipelineRoute = readPipelineRoute(pathname, location.search);
  if (pipelineRoute) return pipelineRoute;
  const artifacts = /^\/artifacts(?:\/([^/]+))?$/.exec(pathname);
  if (artifacts && (!artifacts[1] || idPattern.test(artifacts[1])))
    return { view: "artifacts", projectId: artifacts[1] || "" };
  const memory = /^\/memory(?:\/([^/]+))?$/.exec(pathname);
  if (memory && (!memory[1] || idPattern.test(memory[1]))) {
    const query = new URLSearchParams(location.search);
    const rawPage = query.get("page") || "1";
    return projectsRoute({
      projectId: memory[1] || "",
      projectTab: "knowledge",
      query: (query.get("q") || "").slice(0, 300),
      archived: query.get("archived") === "1",
      memoryPage:
        /^[1-9]\d*$/.test(rawPage) &&
        Number.isSafeInteger(Number(rawPage)) &&
        Number(rawPage) <= 100000
          ? Number(rawPage)
          : 1,
    });
  }
  const bus = /^\/agentbus(?:\/(messages)(?:\/([^/]+))?)?$/.exec(pathname);
  if (bus && (!bus[2] || idPattern.test(bus[2]))) {
    const page = new URLSearchParams(location.search).get("page") || "";
    const messagePage =
      bus[1] && /^[1-9]\d*$/.test(page) && Number.isSafeInteger(Number(page))
        ? Number(page)
        : 1;
    return projectsRoute({
      projectId: bus[2] || "",
      projectTab: "agentbus",
      busTab: bus[1] || "status",
      messagePage,
    });
  }
  const profile = /^\/(extensions|plugins)(?:\/([^/]+))?$/.exec(pathname);
  if (profile && (!profile[2] || idPattern.test(profile[2])))
    return {
      view: "extensions",
      profileId: profile[2] || "",
      extensionTab:
        profile[1] === "plugins" ? "plugins" : readExtensionTab(location.search),
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
  if (route.view === "artifacts")
    return `/artifacts${route.projectId ? `/${encodeURIComponent(route.projectId)}` : ""}`;
  if (route.view === "files") return `/files${explorerQuery(route)}`;
  if (route.view === "settings") return settingsRoutePath(route);
  if (route.view === "pipelines") return pipelineRoutePath(route);
  if (route.view === "projects") return projectsRoutePath(route);
  if (route.view === "workspace")
    return route.sessionId
      ? `/sessions/${encodeURIComponent(route.sessionId)}${route.mode ? `/${route.mode === "reader" ? "chat" : route.mode}` : ""}${route.mode === "files" ? explorerQuery(route) : ""}`
      : "/";
  if (route.view === "extensions") {
    const query = new URLSearchParams();
    if (route.extensionTab && route.extensionTab !== "mcp")
      query.set("tab", route.extensionTab);
    return `/extensions${route.profileId ? `/${encodeURIComponent(route.profileId)}` : ""}${query.size ? `?${query}` : ""}`;
  }
  return `/${route.view}`;
}
export function defaultSessionMode(session, mobile) {
  return session.tool !== "shell" && session.purpose !== "login" && mobile
    ? "reader"
    : "terminal";
}
