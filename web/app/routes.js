import { readSettingsRoute, settingsRoutePath } from "../features/operations/routes.js";
import { readPipelineRoute, pipelineRoutePath } from "../features/pipelines/routes.js";
import { readExplorerRoute, explorerQuery } from "../features/files/routes.js";
import {
  readProjectsRoute,
  projectsRoute,
  projectsRoutePath,
} from "../features/projects/routes.js";
import {
  agentSettingsQuery,
  readAgentSettingsQuery,
} from "../features/assistants/settings-routes.js";
import { accountsQuery, readAccountsQuery } from "../features/accounts/routes.js";
import { defaultExtensionTab, readExtensionTab } from "../features/extensions/routes.js";
import { readMcpOAuthResult } from "../features/mcp-servers/oauth-result.js";
import { appPathParts, returnParam, withoutReturnParam } from "./return-to.js";
import { artifactsRoutePath, readArtifactsQuery } from "../features/artifacts/routes.js";
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
  if (pathname === "/agents") return { view: "agents" };
  const agent =
    /^\/agents\/([A-Za-z0-9_-]+)\/(settings|chats\/([A-Za-z0-9_-]+)|teams\/([A-Za-z0-9_-]+))$/.exec(
      pathname,
    );
  const child = agent?.[3] || agent?.[4];
  if (agent && idPattern.test(agent[1]) && (!child || idPattern.test(child)))
    return {
      view: "agents",
      assistantId: agent[1],
      ...(agent[3]
        ? { conversationId: agent[3] }
        : agent[4]
          ? { teamId: agent[4] }
          : { agentSettings: true, ...readAgentSettingsQuery(location.search) }),
    };
  if (pathname === "/accounts")
    return {
      view: "accounts",
      // A subpage (`section`, optional `item`); `section=mcp-servers` alone opens the
      // central MCP list, as linked from the CLI extensions page.
      ...readAccountsQuery(location.search),
      ...readReturnTo(location.search),
      // An MCP OAuth login's result; the address drops it (see routePath).
      ...readMcpOAuthResult(location.search),
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
  if (settingsRoute)
    return settingsRoute.view === "settings"
      ? { ...settingsRoute, ...readReturnTo(location.search) }
      : settingsRoute;
  const pipelineRoute = readPipelineRoute(pathname, location.search);
  if (pipelineRoute) return pipelineRoute;
  const artifacts = /^\/artifacts(?:\/([^/]+))?$/.exec(pathname);
  if (artifacts && (!artifacts[1] || idPattern.test(artifacts[1])))
    return {
      view: "artifacts",
      projectId: artifacts[1] || "",
      ...readArtifactsQuery(location.search),
    };
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
// Pages a cross-link may return to, and pages that honour a `returnTo`.
const returnOrigins = new Set(["agents", "settings", "extensions", "accounts"]);
const returnTargets = new Set(["settings", "accounts"]);

// How many origins a chain of cross-links remembers beyond the first: Agent settings →
// Deepgram (Accounts) → Agent service settings leads back to Deepgram, and from
// there back to the agent. Deeper chains drop the oldest origin.
const returnDepth = 1;

// The origin route a `returnTo` value names, rebuilt from its parsed route; an origin
// that honours `returnTo` itself keeps its own origin up to `depth` more levels.
function parseOrigin(value, depth) {
  const parts = appPathParts(value);
  if (!parts) return null;
  const origin = readRoute({ ...parts, search: withoutReturnParam(parts.search) });
  if (!returnOrigins.has(origin.view)) return null;
  if (depth > 0 && returnTargets.has(origin.view)) {
    const inner = parseOrigin(
      new URLSearchParams(parts.search).get(returnParam),
      depth - 1,
    );
    if (inner) origin.returnTo = routePath(inner);
  }
  return origin;
}

/** `{ returnTo }` with the canonical origin path of a valid `returnTo`, else `{}`. */
export function readReturnTo(search) {
  const origin = parseOrigin(new URLSearchParams(search).get(returnParam), returnDepth);
  return origin ? { returnTo: routePath(origin) } : {};
}

/** The route a page opened through a cross-link leads back to, or null. */
export function returnRoute(route) {
  return route?.returnTo ? parseOrigin(route.returnTo, returnDepth) : null;
}

/**
 * A cross-link from `origin` (the current route) to `target` in another area: the
 * target carries `returnTo`, so its back arrow leads to exactly this page.
 */
export function crossLinkRoute(target, origin) {
  if (!origin || !returnTargets.has(target.view) || target.view === origin.view)
    return target;
  const { returnTo } = readReturnTo(
    `?${new URLSearchParams({ returnTo: routePath(origin) })}`,
  );
  return returnTo ? { ...target, returnTo } : target;
}

function withReturnTo(path, route) {
  if (!route.returnTo || !returnTargets.has(route.view)) return path;
  const query = new URLSearchParams({ [returnParam]: route.returnTo });
  return `${path}${path.includes("?") ? "&" : "?"}${query}`;
}

export function routePath(route) {
  return withReturnTo(basePath(route), route);
}

function basePath(route) {
  if (route.view === "artifacts") return artifactsRoutePath(route);
  if (route.view === "files") return `/files${explorerQuery(route)}`;
  if (route.view === "agents")
    return route.conversationId
      ? `/agents/${encodeURIComponent(route.assistantId)}/chats/${encodeURIComponent(route.conversationId)}`
      : route.teamId
        ? `/agents/${encodeURIComponent(route.assistantId)}/teams/${encodeURIComponent(route.teamId)}`
        : route.assistantId
          ? `/agents/${encodeURIComponent(route.assistantId)}/settings${agentSettingsQuery(route)}`
          : "/agents";
  if (route.view === "settings") return settingsRoutePath(route);
  if (route.view === "pipelines") return pipelineRoutePath(route);
  if (route.view === "projects") return projectsRoutePath(route);
  if (route.view === "workspace")
    return route.sessionId
      ? `/sessions/${encodeURIComponent(route.sessionId)}${route.mode ? `/${route.mode === "reader" ? "chat" : route.mode}` : ""}${route.mode === "files" ? explorerQuery(route) : ""}`
      : "/";
  if (route.view === "accounts") return `/accounts${accountsQuery(route)}`;
  if (route.view === "extensions") {
    const query = new URLSearchParams();
    if (route.extensionTab && route.extensionTab !== defaultExtensionTab)
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
