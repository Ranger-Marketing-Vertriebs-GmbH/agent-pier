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
import { readAccountsQuery } from "../features/accounts/routes.js";
import { readExtensionTab } from "../features/extensions/routes.js";
import { readMcpOAuthResult } from "../features/mcp-servers/oauth-result.js";
import { appPathParts, returnParam, withoutReturnParam } from "./return-to.js";
import { artifactsRoutePath, readArtifactsQuery } from "../features/artifacts/routes.js";
import { inboxRoutePath, readInboxRoute } from "../features/inbox/routes.js";
import {
  connectionsRoutePath,
  readConnectionsQuery,
} from "../features/connections/routes.js";
import { codingRoutePath, readCodingRoute } from "../features/coding/routes.js";
import { agentsHubQuery, readAgentsHubQuery } from "../features/assistants/hub-routes.js";
import { canonicalRoute, movedRoute } from "./route-redirects.js";
import { screenRoute } from "./route-screens.js";
export { canonicalRoute } from "./route-redirects.js";
export { screenRoute } from "./route-screens.js";
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
  if (pathname === "/agents") {
    const query = new URLSearchParams(location.search);
    if (query.get("new") !== "1") {
      // The hub's tabs; Runtime (the former agent service settings) honours returnTo.
      const hub = readAgentsHubQuery(location.search);
      return {
        view: "agents",
        ...hub,
        ...(hub.agentsTab === "runtime" ? readReturnTo(location.search) : {}),
      };
    }
    // "Add agent for this person" from Settings › Users.
    const forUser = query.get("user");
    if (forUser && idPattern.test(forUser))
      return { view: "agents", creating: true, forUser };
    // "Duplicate" from an agent's settings: the agent the new one starts from.
    const duplicate = query.get("duplicate");
    if (duplicate && idPattern.test(duplicate))
      return { view: "agents", creating: true, duplicate };
    // "Create agent" from an Agency entry: the template and its pinned revision.
    const template = query.get("template"),
      revision = query.get("revision");
    return template && revision
      ? { view: "agents", creating: true, template: { id: template, revision } }
      : { view: "agents", creating: true };
  }
  const agent =
    /^\/agents\/([A-Za-z0-9_-]+)\/(settings|browser|chats\/([A-Za-z0-9_-]+)|teams\/([A-Za-z0-9_-]+))$/.exec(
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
          : agent[2] === "browser"
            ? {
                agentBrowser: true,
                // The chat preview's "Take over" opens the view taking over.
                ...(new URLSearchParams(location.search).get("takeover") === "1"
                  ? { takeover: true }
                  : {}),
              }
            : { agentSettings: true, ...readAgentSettingsQuery(location.search) }),
    };
  if (pathname === "/connections")
    return {
      view: "connections",
      ...readConnectionsQuery(location.search),
      ...readReturnTo(location.search),
      ...readMcpOAuthResult(location.search),
    };
  const coding = readCodingRoute(pathname, location.search);
  if (coding)
    return ["accounts", "mcp"].includes(coding.codingTab)
      ? { ...coding, ...readReturnTo(location.search) }
      : coding;
  // The former Accounts page: its sections moved to Zugänge and Coding.
  if (pathname === "/accounts")
    return movedRoute({
      view: "accounts",
      // A subpage (`section`, optional `item`); `section=mcp-servers` alone opens the
      // central MCP list, as linked from the CLI extensions page.
      ...readAccountsQuery(location.search),
      ...readReturnTo(location.search),
      // An MCP OAuth login's result; the address drops it (see routePath).
      ...readMcpOAuthResult(location.search),
    });
  const inbox = readInboxRoute(pathname, location.search);
  if (inbox) return inbox;
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
      ? canonicalRoute({ ...settingsRoute, ...readReturnTo(location.search) })
      : settingsRoute;
  const pipelineRoute = readPipelineRoute(pathname, location.search);
  if (pipelineRoute) return pipelineRoute;
  const artifacts = /^\/artifacts(?:\/([^/]+))?$/.exec(pathname);
  if (artifacts && (!artifacts[1] || idPattern.test(artifacts[1])))
    return {
      view: "artifacts",
      projectId: artifacts[1] || "",
      ...readArtifactsQuery(location.search),
      ...readReturnTo(location.search, "artifacts"),
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
    return movedRoute({
      view: "extensions",
      profileId: profile[2] || "",
      extensionTab:
        profile[1] === "plugins" ? "plugins" : readExtensionTab(location.search),
    });
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
// Pages a cross-link may return to, and pages that honour a `returnTo`. The Artifacts
// page is opened from a session's artifact panel and returns only to sessions. Both
// name the page that renders a route (`screenRoute`): Zugänge and Coding act as the
// Accounts and settings pages they come from, the agents hub's Runtime tab as the
// agent service settings.
const returnOrigins = new Set(["agents", "settings", "extensions", "accounts"]);
const returnTargets = new Set(["settings", "accounts", "artifacts"]);
const artifactReturnOrigins = new Set(["workspace"]);
const originsFor = (view) =>
  view === "artifacts" ? artifactReturnOrigins : returnOrigins;
const screenView = (route) => screenRoute(route).view;

// How many origins a chain of cross-links remembers beyond the first: Agent settings →
// Deepgram (Accounts) → Agent service settings leads back to Deepgram, and from
// there back to the agent. Deeper chains drop the oldest origin.
const returnDepth = 1;

// The origin route a `returnTo` value names, rebuilt from its parsed route; an origin
// that honours `returnTo` itself keeps its own origin up to `depth` more levels.
function parseOrigin(value, depth, origins = returnOrigins) {
  const parts = appPathParts(value);
  if (!parts) return null;
  const origin = readRoute({ ...parts, search: withoutReturnParam(parts.search) });
  if (!origins.has(screenView(origin))) return null;
  if (depth > 0 && returnTargets.has(screenView(origin))) {
    const inner = parseOrigin(
      new URLSearchParams(parts.search).get(returnParam),
      depth - 1,
    );
    if (inner) origin.returnTo = routePath(inner);
  }
  return origin;
}

/**
 * `{ returnTo }` with the canonical origin path of a valid `returnTo`, else `{}`.
 * `view` is the page that honours it (its allowed origins).
 */
export function readReturnTo(search, view) {
  const origin = parseOrigin(
    new URLSearchParams(search).get(returnParam),
    returnDepth,
    originsFor(view),
  );
  return origin ? { returnTo: routePath(origin) } : {};
}

/** The route a page opened through a cross-link leads back to, or null. */
export function returnRoute(route) {
  return route?.returnTo
    ? parseOrigin(route.returnTo, returnDepth, originsFor(route.view))
    : null;
}

/**
 * A cross-link from `origin` (the current route) to `target` in another area: the
 * target carries `returnTo`, so its back arrow leads to exactly this page.
 */
export function crossLinkRoute(target, origin) {
  if (!origin) return target;
  const view = screenView(target);
  if (!returnTargets.has(view) || view === screenView(origin)) return target;
  const moved = canonicalRoute(target);
  const { returnTo } = readReturnTo(
    `?${new URLSearchParams({ returnTo: routePath(origin) })}`,
    moved.view,
  );
  return returnTo ? { ...moved, returnTo } : target;
}

function withReturnTo(path, route) {
  if (!route.returnTo || !returnTargets.has(screenView(route))) return path;
  const query = new URLSearchParams({ [returnParam]: route.returnTo });
  return `${path}${path.includes("?") ? "&" : "?"}${query}`;
}

/** The address of a route; a moved page's route gets the address of its new place. */
export function routePath(route) {
  const target = canonicalRoute(route);
  return withReturnTo(basePath(target), target);
}

function basePath(route) {
  if (route.view === "artifacts") return artifactsRoutePath(route);
  if (route.view === "files") return `/files${explorerQuery(route)}`;
  if (route.view === "inbox") return inboxRoutePath(route);
  if (route.view === "agents")
    return route.conversationId
      ? `/agents/${encodeURIComponent(route.assistantId)}/chats/${encodeURIComponent(route.conversationId)}`
      : route.teamId
        ? `/agents/${encodeURIComponent(route.assistantId)}/teams/${encodeURIComponent(route.teamId)}`
        : route.assistantId && route.agentBrowser
          ? `/agents/${encodeURIComponent(route.assistantId)}/browser${route.takeover ? "?takeover=1" : ""}`
          : route.assistantId
            ? `/agents/${encodeURIComponent(route.assistantId)}/settings${agentSettingsQuery(route)}`
            : route.creating
              ? `/agents?new=1${
                  route.forUser ? `&${new URLSearchParams({ user: route.forUser })}` : ""
                }${
                  route.duplicate
                    ? `&${new URLSearchParams({ duplicate: route.duplicate })}`
                    : ""
                }${
                  route.template
                    ? `&${new URLSearchParams({ template: route.template.id, revision: route.template.revision })}`
                    : ""
                }`
              : `/agents${agentsHubQuery(route)}`;
  if (route.view === "settings") return settingsRoutePath(route);
  if (route.view === "pipelines") return pipelineRoutePath(route);
  if (route.view === "projects") return projectsRoutePath(route);
  if (route.view === "workspace")
    return route.sessionId
      ? `/sessions/${encodeURIComponent(route.sessionId)}${route.mode ? `/${route.mode === "reader" ? "chat" : route.mode}` : ""}${route.mode === "files" ? explorerQuery(route) : ""}`
      : "/";
  if (route.view === "connections") return connectionsRoutePath(route);
  if (route.view === "coding") return codingRoutePath(route);
  return `/${route.view}`;
}
export function defaultSessionMode(session, mobile) {
  return session.tool !== "shell" && session.purpose !== "login" && mobile
    ? "reader"
    : "terminal";
}
