import { extensionProfiles } from "../features/extensions/sharedProfiles.js";
import { useWorkspaceNavigationCopy as copy } from "../lib/i18n/messages/app.js";
import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { SessionViewMemory } from "./session-view-memory.js";
import { readRoute, routePath } from "./routes.js";
import { projectsRoute } from "../features/projects/routes.js";
import { requestFileNavigation } from "../features/files/file-navigation-guard.js";
const navigationIndex = "agentPierNavigationIndex";
export default function useWorkspaceNavigation({ state, ready, setMobileNav, setModal }) {
  const [route, setRoute] = useState(() => readRoute(window.location));
  const view = route.view,
    selected = route.sessionId || "";
  const profileMemory = useRef("");
  const [sessionViews] = useState(
    () => new SessionViewMemory(() => window.sessionStorage),
  );
  const index = useRef(
    Number.isSafeInteger(window.history.state?.[navigationIndex])
      ? window.history.state[navigationIndex]
      : 0,
  );
  const committedPath = useRef(
    window.location.pathname + window.location.search + window.location.hash,
  );
  const historyOperation = useRef(null);
  const pendingNavigation = useRef(null);
  const activeIntent = useRef(null);
  useEffect(() => {
    if (!Number.isSafeInteger(window.history.state?.[navigationIndex]))
      window.history.replaceState(
        { ...(window.history.state || {}), [navigationIndex]: index.current },
        "",
      );
  }, []);
  const commitWorkspaceNavigation = useCallback(
    (next, replace = false) => {
      const path = routePath(next);
      if (
        window.location.pathname + window.location.search + window.location.hash !==
        path
      ) {
        if (!replace) index.current += 1;
        window.history[replace ? "replaceState" : "pushState"](
          { ...(window.history.state || {}), [navigationIndex]: index.current },
          "",
          path,
        );
      }
      setRoute(next);
      committedPath.current = path;
      setMobileNav(false);
      setModal(null);
    },
    [setMobileNav, setModal],
  );
  const runNavigation = useCallback(
    (next, replace = false) =>
      requestFileNavigation({
        next,
        reason: replace ? "normalization" : "application",
        commit: () => commitWorkspaceNavigation(next, replace),
      }),
    [commitWorkspaceNavigation],
  );
  const navigate = useCallback(
    (next, replace = false) => {
      let operation = historyOperation.current;
      if (replace && (activeIntent.current || operation)) return Promise.resolve(false);
      const physicalIndex = window.history.state?.[navigationIndex];
      if (
        !operation &&
        Number.isSafeInteger(physicalIndex) &&
        physicalIndex !== index.current
      ) {
        operation = {
          phase: "restore",
          from: index.current,
          physicalIndex,
          cancelled: true,
        };
        historyOperation.current = operation;
      }
      if (!operation) return runNavigation(next, replace);
      operation.cancelled = true;
      pendingNavigation.current?.resolve(false);
      return new Promise((resolve) => {
        pendingNavigation.current = { next, replace, resolve };
        if (operation.physicalIndex !== operation.from)
          window.history.go(operation.from - operation.physicalIndex);
      });
    },
    [runNavigation],
  );
  useEffect(() => {
    const finishRestore = (operation) => {
      historyOperation.current = null;
      const pending = pendingNavigation.current;
      pendingNavigation.current = null;
      if (pending) {
        activeIntent.current = pending;
        runNavigation(pending.next, pending.replace).then((accepted) => {
          if (activeIntent.current === pending) activeIntent.current = null;
          pending.resolve(accepted);
        });
      } else if (!operation.cancelled) {
        activeIntent.current = operation;
        requestFileNavigation({
          next: operation.route,
          reason: "history",
          commit: () => {
            if (activeIntent.current !== operation) return;
            const delta = operation.to - operation.from;
            if (!delta) {
              index.current = operation.to;
              committedPath.current = operation.path;
              setRoute(operation.route);
              return;
            }
            historyOperation.current = { ...operation, phase: "replay" };
            window.history.go(delta);
          },
        }).then(() => {
          if (activeIntent.current === operation) activeIntent.current = null;
        });
      }
    };
    const restore = (event) => {
      const operation = historyOperation.current;
      const targetIndex = event.state?.[navigationIndex];
      const path =
        window.location.pathname + window.location.search + window.location.hash;
      if (operation) operation.physicalIndex = targetIndex;
      if (
        operation?.phase === "replay" &&
        !operation.cancelled &&
        targetIndex === operation.to &&
        path === operation.path
      ) {
        historyOperation.current = null;
        index.current = operation.to;
        committedPath.current = operation.path;
        setRoute(operation.route);
        setMobileNav(false);
        setModal(null);
        return;
      }
      if (operation && targetIndex === operation.from && path === committedPath.current) {
        finishRestore(operation);
        return;
      }
      if (operation && Number.isSafeInteger(targetIndex)) {
        if (!operation.cancelled) {
          operation.to = targetIndex;
          operation.route = readRoute(window.location);
          operation.path = path;
          operation.phase = "restore";
        }
        window.history.go(operation.from - targetIndex);
        return;
      }
      const route = readRoute(window.location);
      if (Number.isSafeInteger(targetIndex) && targetIndex !== index.current) {
        const nextOperation = {
          phase: "restore",
          from: index.current,
          to: targetIndex,
          route,
          path,
          physicalIndex: targetIndex,
          cancelled: false,
        };
        activeIntent.current = nextOperation;
        historyOperation.current = nextOperation;
        window.history.go(index.current - targetIndex);
        return;
      }
      if (Number.isSafeInteger(targetIndex)) {
        committedPath.current = path;
        setRoute(route);
        setMobileNav(false);
        setModal(null);
        return;
      }
      const previousPath = committedPath.current;
      window.history.replaceState(
        { ...(window.history.state || {}), [navigationIndex]: index.current },
        "",
        previousPath,
      );
      requestFileNavigation({
        next: route,
        reason: "history-unindexed",
        commit: () => commitWorkspaceNavigation(route),
      });
    };
    window.addEventListener("popstate", restore);
    window.addEventListener("hashchange", restore);
    return () => {
      window.removeEventListener("popstate", restore);
      window.removeEventListener("hashchange", restore);
    };
  }, [commitWorkspaceNavigation, runNavigation, setMobileNav, setModal]);
  const select = (session) => {
    navigate(
      session
        ? {
            view: "workspace",
            sessionId: session.id,
            mode: sessionViews.mode(
              session,
              window.matchMedia("(max-width: 700px)").matches,
            ),
          }
        : {
            view: "workspace",
            sessionId: "",
          },
    );
  };
  const activeSession = state.sessions.find((s) => s.id === selected);
  const profileAccounts = useMemo(
    () => extensionProfiles(state.accounts, state.sharedCliExtensions),
    [state.accounts, state.sharedCliExtensions],
  );
  const activeProfile = profileAccounts.find((account) => account.id === route.profileId);
  useEffect(() => {
    if (!ready || view === "missing") return;
    let normalized = route;
    if (view === "extensions") {
      const legacy =
        state.sharedCliExtensions &&
        state.accounts.find(
          (account) => account.id === route.profileId && account.tool !== "shell",
        );
      if (legacy && legacy.id !== `local-${legacy.tool}`)
        normalized = { ...route, profileId: `local-${legacy.tool}` };
      if (activeProfile) profileMemory.current = activeProfile.id;
      else if (!route.profileId && profileAccounts.length)
        normalized = {
          ...route,
          profileId:
            profileAccounts.find((a) => a.id === profileMemory.current)?.id ||
            profileAccounts[0].id,
        };
    }
    if (
      activeSession &&
      (!route.mode ||
        (activeSession.tool === "shell" && !["terminal", "files"].includes(route.mode)))
    )
      normalized = {
        ...route,
        mode: sessionViews.mode(
          activeSession,
          window.matchMedia("(max-width: 700px)").matches,
        ),
      };
    if (activeSession && normalized.mode)
      sessionViews.remember(activeSession, normalized.mode);
    if (
      routePath(normalized) !== window.location.pathname + window.location.search ||
      window.location.hash
    )
      navigate(normalized, true);
  }, [
    ready,
    route,
    view,
    activeSession,
    activeProfile,
    profileAccounts,
    navigate,
    state.accounts,
    state.sharedCliExtensions,
    sessionViews,
  ]);
  const resolveProfileId = () =>
    activeProfile?.id ||
    profileAccounts.find((a) => a.id === profileMemory.current)?.id ||
    profileAccounts[0]?.id ||
    "";
  // "repositories" is a legacy alias for the Projekte sidebar item (used by utilityPages);
  // memory/agentbus/plugins stay reachable by tab until the Projects hub replaces this
  // stop-gap in a later task.
  const page = (view) => {
    if (view === "settings/github")
      return navigate({ view: "settings", settingsSection: "github" });
    if (view === "repositories" || view === "projects") return navigate(projectsRoute());
    if (view === "memory") return navigate(projectsRoute({ projectTab: "knowledge" }));
    if (view === "agentbus") return navigate(projectsRoute({ projectTab: "agentbus" }));
    if (view === "plugins")
      return navigate({
        view: "extensions",
        extensionTab: "plugins",
        profileId: resolveProfileId(),
      });
    return navigate({
      view,
      ...(view === "extensions"
        ? { extensionTab: "mcp", profileId: resolveProfileId() }
        : {}),
    });
  };
  const missing =
    view === "missing"
      ? copy.pageNotFound
      : ready && selected && !activeSession
        ? copy.sessionNotFound
        : ready && view === "extensions" && route.profileId && !activeProfile
          ? copy.profileNotFound
          : null;
  return {
    route,
    view,
    selected,
    navigate,
    select,
    activeSession,
    page,
    missing,
  };
}
