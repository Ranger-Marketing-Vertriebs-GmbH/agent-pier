import React, {
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import api from "../lib/api.js";
import useAssistants from "../features/assistants/useAssistants.js";
import useAssistantFeature from "../features/assistants/useAssistantFeature.js";
import { codingRoute } from "../features/coding/routes.js";
import { projectsRoute } from "../features/projects/routes.js";
import { projectOnScreen } from "./project-search-entries.js";
import { orderActionIds } from "../features/autopilot/search.js";
import { pageActionOffered, requestPageAction } from "./page-action.js";
import { SearchDialogContext, openSearchEvent, searchOpener } from "./search-dialog.js";
import { loadConnectionNames } from "./search-connections.js";
import { isMacPlatform, opensSearch } from "./search-shortcut.js";
import { readRecent, rememberRecent } from "../features/quick-open/recent-items.js";
import { LoginContext } from "../features/login/LoginContext.js";
import { useViews } from "../features/views/views-context.js";
import { requestNavigation } from "../lib/navigation-guard.js";
// The page actions of the chat on screen (AgentChatTop).
const chatActions = ["chat-new", "chat-summarise", "chat-archived", "chat-usage"];
const SearchDialog = lazy(() => import("./SearchDialog.jsx"));

// Connection names load on the first open and again when an open finds them older
// than this, so a long session still finds newly added accesses.
const connectionsMaxAge = 60_000;

/**
 * The app's ⌘K search: provides `useSearchDialog().open` to the sidebar, the phone
 * header and menu, listens for the shortcut and the `agentpier:open-search` event, and
 * performs the chosen result (navigate, open a session in its last view, open a
 * page's dialog, or the new session dialog), which it keeps as a recent result.
 * `workspace` is the loaded workspace state (sessions, accounts, tools) or null.
 */
export default function AppSearch({
  navigate,
  select,
  workspace,
  launch,
  route,
  extensionProfileId,
  providerConnections,
  children,
}) {
  const [open, setOpen] = useState(false);
  const [opener, setOpener] = useState(null);
  const [connections, setConnections] = useState(null);
  const [loading, setLoading] = useState(false);
  const loadedAt = useRef(0);
  const { enabled: agentsEnabled } = useAssistantFeature();
  const { assistants, conversations } = useAssistants();
  const [recent, setRecent] = useState(() => readRecent("owner"));
  const auth = useContext(LoginContext);
  const views = useViews()?.views;
  // The clicked opener gets the focus back on close (Safari does not focus it).
  const show = useCallback((from) => {
    setOpener(searchOpener(from));
    setOpen(true);
  }, []);
  const context = useMemo(() => ({ open: show }), [show]);
  useEffect(() => {
    const mac = isMacPlatform();
    const keydown = (event) => {
      if (!opensSearch(event, mac)) return;
      event.preventDefault();
      show();
    };
    window.addEventListener("keydown", keydown);
    window.addEventListener(openSearchEvent, show);
    return () => {
      window.removeEventListener("keydown", keydown);
      window.removeEventListener(openSearchEvent, show);
    };
  }, [show]);
  useEffect(() => {
    if (!open || Date.now() - loadedAt.current < connectionsMaxAge) return undefined;
    let alive = true;
    loadedAt.current = Date.now();
    setLoading(true);
    loadConnectionNames(api, { providerConnections })
      .then((names) => alive && setConnections(names))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // Only an open starts a load; provider connections come along when it does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const close = useCallback(() => setOpen(false), []);
  const choose = (entry) => {
    const target = entry.target;
    setRecent(rememberRecent("owner", entry.id));
    // Delete project only opens the dialog of a project that was current; otherwise
    // it just shows the projects page, so no auto-selected project is offered.
    const noProject = target.action === "delete-project" && !projectOnScreen(route);
    if (target.pending && !noProject) requestPageAction(target.pending);
    setOpen(false);
    if (target.session) {
      const session = workspace?.sessions?.find((item) => item.id === target.session);
      // Background tasks show in the chat tab.
      if (target.mode)
        return navigate({
          view: "workspace",
          sessionId: target.session,
          mode: target.mode,
        });
      if (session) return select(session);
      return navigate({ view: "workspace", sessionId: target.session, mode: null });
    }
    if (target.action === "launch") return launch();
    // Signing out leaves the workspace: unsaved changes ask first, as the menu's button.
    if (target.action === "sign-out")
      return requestNavigation({ reason: "logout", commit: auth.logout }).catch(
        () => undefined,
      );
    if (target.action === "session-changes")
      return navigate({ ...route, mode: "changes" });
    // The run page on screen takes the requested page action and opens its changes.
    if (
      orderActionIds.includes(target.pending) ||
      target.action === "run-changes" ||
      target.action === "chat-new" ||
      target.action === "chat-summarise" ||
      target.action === "chat-archived" ||
      target.action === "chat-usage" ||
      target.action === "view-new"
    )
      return undefined;
    if (target.action === "delete-project")
      return navigate(
        projectsRoute(projectOnScreen(route) ? { projectId: route.projectId } : {}),
      );
    if (target.action === "start-tickets" || target.action === "add-label-rule")
      return navigate(
        projectsRoute(
          route?.view === "projects" && route.projectId
            ? { projectId: route.projectId, projectTab: "tickets" }
            : {},
        ),
      );
    if (target.extensions)
      return navigate(
        codingRoute("extensions", {
          profileId: extensionProfileId || "",
          extensionTab: target.extensions,
        }),
      );
    return navigate(target.route);
  };
  return (
    <SearchDialogContext.Provider value={context}>
      {children}
      {open && (
        <Suspense fallback={null}>
          <SearchDialog
            close={close}
            choose={choose}
            opener={opener}
            agents={assistants}
            conversations={conversations}
            agentsEnabled={Boolean(agentsEnabled)}
            sessionOpen={route?.view === "workspace" && Boolean(route.sessionId)}
            runOpen={
              route?.view === "pipelines" &&
              route.pipelineTab === "runs" &&
              Boolean(route.pipelineItem) &&
              // the run on screen offers its changes (not an imported history run)
              pageActionOffered("run-changes")
            }
            offered={[
              ...orderActionIds.filter(pageActionOffered),
              ...chatActions.filter(pageActionOffered),
              ...(pageActionOffered("view-new") ? ["view-new"] : []),
              ...(auth ? ["sign-out"] : []),
            ]}
            connections={connections}
            workspace={workspace}
            views={views || []}
            recent={recent}
            loading={loading && !connections}
          />
        </Suspense>
      )}
    </SearchDialogContext.Provider>
  );
}
