import React, { useState } from "react";
import Icon from "../../components/Icon.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import SidebarGroup from "../../app/SidebarGroup.jsx";
import { viewsCopy } from "../../lib/i18n/messages/views.js";
import { paneCount } from "./split-tree.js";
import { useViews } from "./views-context.js";
import useViewsOffered from "./useViewsOffered.js";
import "./views.css";

/** The next default name "View n": the smallest n ≥ 1 no view is named after. */
export function nextDefaultName(views, defaultName) {
  const names = new Set(views.map((view) => view.name));
  let n = 1;
  while (names.has(defaultName(n))) n += 1;
  return defaultName(n);
}

/**
 * The sidebar's Views group (wider than 1150 px only): one row per saved view with
 * its pane count, and "+" in the head that creates an empty view and opens it.
 */
export default function ViewsSidebarGroup({ navigate, route }) {
  const offered = useViewsOffered();
  const store = useViews();
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  if (!offered || !store) return null;
  const { views } = store;
  const current = route?.view === "split" ? route.viewId : "";
  const create = async () => {
    setError("");
    setCreating(true);
    try {
      const view = await store.create({
        name: nextDefaultName(views, viewsCopy.defaultName),
        layout: null,
      });
      if (view) navigate({ view: "split", viewId: view.id });
    } catch (failure) {
      setError(failure.message);
    } finally {
      setCreating(false);
    }
  };
  return (
    <SidebarGroup
      name="views"
      label={viewsCopy.group}
      count={String(views.length)}
      defaultOpen
      activeKey={current}
      actions={
        <button
          type="button"
          className="icon-button"
          aria-label={viewsCopy.newView}
          title={viewsCopy.newView}
          disabled={creating}
          onClick={create}
        >
          <Icon name="plus" size={16} />
        </button>
      }
    >
      <ErrorMessage error={error} />
      <div className="session-list">
        {views.map((view) => {
          const n = paneCount(view.layout ?? null);
          const open = view.id === current;
          return (
            <button
              key={view.id}
              type="button"
              className={`session-item views-sidebar-item ${open ? "selected" : ""}`}
              aria-label={viewsCopy.rowLabel(view.name, n)}
              aria-current={open ? "page" : undefined}
              onClick={() => navigate({ view: "split", viewId: view.id })}
            >
              <span className="views-sidebar-icon" aria-hidden="true">
                <Icon name="grid" size={16} />
              </span>
              <span className="views-sidebar-name">
                <strong>{view.name}</strong>
                <span className="sidebar-group-count">{n}</span>
              </span>
            </button>
          );
        })}
      </div>
    </SidebarGroup>
  );
}
