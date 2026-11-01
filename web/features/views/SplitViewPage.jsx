import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import SplitLayout from "../../components/SplitLayout.jsx";
import DropZoneOverlay from "../../components/DropZoneOverlay.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import useMediaQuery from "../../lib/useMediaQuery.js";
import { mediaQueries } from "../../lib/breakpoints.js";
import { appCopy } from "../../lib/i18n/messages/app.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { viewsCopy } from "../../lib/i18n/messages/views.js";
import { setPresenceRoutes } from "../notifications/presence-routes.js";
import { useViews } from "./views-context.js";
import { itemRoute, singleRoute } from "./click-rule.js";
import {
  MIN_PANE,
  firstPane,
  itemKey,
  panes as panesOf,
  removePane,
  replaceItem,
  setRatio,
  setTab,
  wouldAdd,
} from "./split-tree.js";
import ViewHeader from "./ViewHeader.jsx";
import PaneHost from "./PaneHost.jsx";
import useViewDrop, { usePaneZone } from "./useViewDrop.js";
import "./views.css";

const FLASH_MS = 700;
const keyOf = (leaf) => itemKey(leaf.item);
const paneOf = (leaf) => ({ key: itemKey(leaf.item), item: leaf.item, tab: leaf.tab });

/** A pane's drop zones: edges split it, the centre replaces it. */
function PaneDropTarget({ drop, paneKey, children }) {
  const zone = usePaneZone(drop, paneKey);
  return (
    <div className="split-pane-drop" {...zone.handlers}>
      {children}
      <DropZoneOverlay
        side={zone.side}
        label={drop.full && drop.adding ? viewsCopy.full : undefined}
      />
    </div>
  );
}

/** A pane shown alone (below 1151 px): measured before its content renders. */
function SinglePane({ paneKey, render }) {
  const root = useRef(null);
  const [size, setSize] = useState(null);
  useLayoutEffect(() => {
    const element = root.current;
    const measure = () => {
      const { width, height } = element.getBoundingClientRect();
      if (width > 0 && height > 0)
        setSize((current) =>
          current?.width === width && current?.height === height
            ? current
            : { width, height },
        );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={root} className="split-single">
      {size && (
        <div className="split-pane" data-pane-key={paneKey}>
          {render(size)}
        </div>
      )}
    </div>
  );
}

/**
 * A saved split view: its header and its panes side by side (wider than 1150 px),
 * else its first pane alone with a note. Opening it marks it used; presence reports
 * every visible pane.
 */
export default function SplitViewPage({
  viewId,
  state,
  ready,
  navigate,
  openRoute,
  action,
  autoResume,
}) {
  const views = useViews();
  const view = views.byId(viewId);
  const offered = useMediaQuery(mediaQueries.aboveTablet);
  const { touch, setLayout, rename, remove, requestFocus, focusRequest, consumeFocus } =
    views;
  useEffect(() => {
    touch(viewId);
  }, [viewId, touch]);

  const layout = view?.layout ?? null;
  const all = useMemo(() => panesOf(layout), [layout]);
  const visible = useMemo(() => (offered ? all : all.slice(0, 1)), [offered, all]);
  const presence = visible.map((pane) => itemRoute(pane.item)).join("\n");
  useEffect(() => {
    setPresenceRoutes(presence ? presence.split("\n") : []);
  }, [presence]);
  useEffect(() => () => setPresenceRoutes(null), []);

  const [focusedKey, setFocusedKey] = useState(null);
  const [flashKey, setFlashKey] = useState(null);
  const focused = all.some((pane) => pane.key === focusedKey)
    ? focusedKey
    : (all[0]?.key ?? null);
  // A focus request is handled once and then consumed: coming back to the view later
  // neither flashes nor focuses that pane again.
  useEffect(() => {
    if (!focusRequest || focusRequest.viewId !== viewId) return;
    setFocusedKey(focusRequest.key);
    setFlashKey(focusRequest.key);
    document
      .querySelector(
        `.split-pane[data-pane-key="${CSS.escape(focusRequest.key)}"] .split-pane-host`,
      )
      ?.focus({ preventScroll: true });
    consumeFocus(focusRequest.nonce);
  }, [focusRequest, viewId, consumeFocus]);
  useEffect(() => {
    if (!flashKey) return undefined;
    const timer = setTimeout(() => setFlashKey(null), FLASH_MS);
    return () => clearTimeout(timer);
  }, [flashKey]);

  // The latest layout for actions that run after an await or from a stale closure.
  const latest = useRef(layout);
  latest.current = layout;
  const change = useCallback(
    (edit) => {
      const next = edit(latest.current);
      if (next === latest.current) return;
      latest.current = next;
      setLayout(viewId, next);
    },
    [setLayout, viewId],
  );
  const actions = useMemo(
    () => ({
      remove: (key) => change((current) => removePane(current, key)),
      setTab: (key, tab) => change((current) => setTab(current, key, tab)),
      replaceItem: (key, item) => {
        if (latest.current && !wouldAdd(latest.current, item))
          return requestFocus(viewId, itemKey(item));
        change((current) => replaceItem(current, key, item));
      },
      openRoute: (route) => openRoute(route),
      navigate: (route) => navigate(route),
      openAlone: (item, tab) => navigate(singleRoute(item, tab)),
    }),
    [change, navigate, openRoute, requestFocus, viewId],
  );
  const onRatio = useCallback(
    (path, ratio) => change((current) => setRatio(current, path, ratio)),
    [change],
  );
  const shared = useMemo(
    () => ({ state, ready, action, autoResume }),
    [state, ready, action, autoResume],
  );
  const [stageSize, setStageSize] = useState(null);
  const drop = useViewDrop({ view, stageSize });
  const renderPane = (leaf, size, arranged = false) => {
    const pane = paneOf(leaf);
    const host = (
      <PaneHost
        pane={pane}
        size={size}
        focused={pane.key === focused}
        flash={pane.key === flashKey}
        actions={actions}
        onFocusPane={setFocusedKey}
        shared={shared}
        dragHeader={arranged ? drop.onHeaderDragStart : null}
      />
    );
    return arranged ? (
      <PaneDropTarget drop={drop} paneKey={pane.key}>
        {host}
      </PaneDropTarget>
    ) : (
      host
    );
  };

  const renderArranged = (leaf, size) => renderPane(leaf, size, true);

  if (!view)
    return (
      <div className="page">
        {views.error && !views.loaded ? (
          <>
            <ErrorMessage error={views.error} />
            <button type="button" className="button secondary" onClick={views.retry}>
              {commonCopy.retry}
            </button>
          </>
        ) : (
          <p className="loading" role="status">
            {appCopy.workspaceLoading}
          </p>
        )}
      </div>
    );
  const first = firstPane(layout);
  return (
    <div className="split-view-page">
      <ViewHeader
        key={view.id}
        view={view}
        paneCount={all.length}
        onRename={(name) => rename(view.id, name)}
        onDelete={async () => {
          // Leaving first: the panes' unsaved documents ask before the view goes.
          if (await navigate({ view: "workspace", sessionId: "" })) await remove(view.id);
        }}
      />
      <ErrorMessage error={views.error || drop.error} />
      {!layout ? (
        <div className="split-view-body split-view-drop" {...drop.emptyZone.handlers}>
          <p className="split-view-empty">{viewsCopy.empty}</p>
          <DropZoneOverlay side={drop.emptyZone.side} />
        </div>
      ) : offered ? (
        <div className="split-view-body">
          <SplitLayout
            layout={layout}
            keyOf={keyOf}
            renderPane={renderArranged}
            onRatio={onRatio}
            minPane={MIN_PANE}
            onSize={setStageSize}
          />
        </div>
      ) : (
        <>
          {all.length > 1 && <p className="split-view-note">{viewsCopy.narrowNote}</p>}
          <div className="split-view-body">
            <SinglePane
              key={first.key}
              paneKey={first.key}
              render={(size) =>
                renderPane({ type: "pane", item: first.item, tab: first.tab }, size)
              }
            />
          </div>
        </>
      )}
    </div>
  );
}
