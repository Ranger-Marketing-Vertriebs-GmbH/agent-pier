import { extensionProfiles } from "../features/extensions/sharedProfiles.js";
import { useWorkspaceNavigationCopy as copy } from "../lib/i18n/messages/app.js";
import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { readRoute, routePath, defaultSessionMode } from "./routes.js";
export default function useWorkspaceNavigation({ state, ready, setMobileNav, setModal }) {
  const [route, setRoute] = useState(() => readRoute(window.location));
  const view = route.view,
    selected = route.sessionId || "";
  const profileMemory = useRef("");
  const navigate = useCallback(
    (next, replace = false) => {
      const path = routePath(next);
      if (
        window.location.pathname + window.location.search + window.location.hash !==
        path
      )
        window.history[replace ? "replaceState" : "pushState"](null, "", path);
      setRoute(next);
      setMobileNav(false);
      setModal(null);
    },
    [setMobileNav, setModal],
  );
  useEffect(() => {
    const restore = () => {
      setRoute(readRoute(window.location));
      setMobileNav(false);
      setModal(null);
    };
    window.addEventListener("popstate", restore);
    window.addEventListener("hashchange", restore);
    return () => {
      window.removeEventListener("popstate", restore);
      window.removeEventListener("hashchange", restore);
    };
  }, [setMobileNav, setModal]);
  const select = (session) => {
    navigate(
      session
        ? {
            view: "workspace",
            sessionId: session.id,
            mode: defaultSessionMode(
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
        mode: defaultSessionMode(
          activeSession,
          window.matchMedia("(max-width: 700px)").matches,
        ),
      };
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
