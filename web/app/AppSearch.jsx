import React, {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import api from "../lib/api.js";
import useAssistants from "../features/assistants/useAssistants.js";
import useAssistantFeature from "../features/assistants/useAssistantFeature.js";
import { codingRoute } from "../features/coding/routes.js";
import { requestPageAction } from "./page-action.js";
import { SearchDialogContext, openSearchEvent } from "./search-dialog.js";
import { loadConnectionNames } from "./search-connections.js";
import { isMacPlatform, opensSearch } from "./search-shortcut.js";
const SearchDialog = lazy(() => import("./SearchDialog.jsx"));

// Connection names load on the first open and again when an open finds them older
// than this, so a long session still finds newly added accesses.
const connectionsMaxAge = 60_000;

/**
 * The app's ⌘K search: provides `useSearchDialog().open` to the sidebar and the phone
 * menu, listens for the shortcut and the `agentpier:open-search` event, and performs
 * the chosen result (navigate, open a page's dialog, or the new session dialog).
 */
export default function AppSearch({
  navigate,
  launch,
  extensionProfileId,
  providerConnections,
  children,
}) {
  const [open, setOpen] = useState(false);
  const [connections, setConnections] = useState(null);
  const [loading, setLoading] = useState(false);
  const loadedAt = useRef(0);
  const { enabled: agentsEnabled } = useAssistantFeature();
  const { assistants } = useAssistants();
  const show = useCallback(() => setOpen(true), []);
  const context = useMemo(() => ({ open: show }), [show]);
  useEffect(() => {
    const mac = isMacPlatform();
    const keydown = (event) => {
      if (!opensSearch(event, mac)) return;
      event.preventDefault();
      setOpen(true);
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
    if (target.pending) requestPageAction(target.pending);
    setOpen(false);
    if (target.action === "launch") return launch();
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
            agents={assistants}
            agentsEnabled={Boolean(agentsEnabled)}
            connections={connections}
            loading={loading && !connections}
          />
        </Suspense>
      )}
    </SearchDialogContext.Provider>
  );
}
