import { extensionProfiles } from "../features/extensions/sharedProfiles.js";
import { useWorkspaceNavigationCopy as copy } from "../lib/i18n/messages/app.js";
import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { SessionViewMemory } from "./session-view-memory.js";
import { readRoute, routePath } from "./routes.js";
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
  const navigate = useCallback(
    (next, replace = false) =>
      requestFileNavigation({
        next,
        reason: replace ? "normalization" : "application",
        commit: () => commitWorkspaceNavigation(next, replace),
      }),
    [commitWorkspaceNavigation],
  );
  useEffect(() => {
    const restore = (event) => {
      const operation = historyOperation.current;
      const targetIndex = event.state?.[navigationIndex];
      if (operation?.phase === "restore" && targetIndex === operation.from) {
        historyOperation.current = null;
        requestFileNavigation({
          next: operation.route,
          reason: "history",
          commit: () => {
            historyOperation.current = { ...operation, phase: "replay" };
            window.history.go(operation.to - operation.from);
          },
        });
        return;
      }
      if (operation?.phase === "replay" && targetIndex === operation.to) {
        historyOperation.current = null;
        index.current = operation.to;
        committedPath.current = operation.path;
        setRoute(operation.route);
        setMobileNav(false);
        setModal(null);
        return;
      }
      const route = readRoute(window.location);
      const path =
        window.location.pathname + window.location.search + window.location.hash;
      if (Number.isSafeInteger(targetIndex) && targetIndex !== index.current) {
        historyOperation.current = {
          phase: "restore",
          from: index.current,
          to: targetIndex,
          route,
          path,
        };
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
  }, [commitWorkspaceNavigation, setMobileNav, setModal]);
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
    if (["extensions", "plugins"].includes(view)) {
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
  const page = (view) =>
    navigate({
      view,
      ...(["extensions", "plugins"].includes(view)
        ? {
            profileId:
              activeProfile?.id ||
              profileAccounts.find((a) => a.id === profileMemory.current)?.id ||
              profileAccounts[0]?.id ||
              "",
          }
        : {}),
    });
  const missing =
    view === "missing"
      ? copy.pageNotFound
      : ready && selected && !activeSession
        ? copy.sessionNotFound
        : ready &&
            ["extensions", "plugins"].includes(view) &&
            route.profileId &&
            !activeProfile
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
