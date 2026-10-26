export {
  sessionActivity,
  sandboxBadge,
} from "../features/sessions/sessionPresentation.js";
import React, { useEffect, useId, useRef, useState } from "react";
import StatusDot from "../components/StatusDot.jsx";
import Icon from "../components/Icon.jsx";
import LogoutButton from "../features/login/LogoutButton.jsx";
import { artifactCopy } from "../lib/i18n/messages/artifacts.js";
import { assistantCopy } from "../lib/i18n/messages/assistants.js";
import { codingPageCopy } from "../lib/i18n/messages/coding.js";
import { commonCopy } from "../lib/i18n/messages/common.js";
import { connectionsAreaCopy } from "../lib/i18n/messages/connections-area.js";
import { filesCopy } from "../lib/i18n/messages/files.js";
import { pipelineCopy } from "../lib/i18n/messages/pipelines.js";
import { sidebarCopy as copy } from "../lib/i18n/messages/app.js";
import useMobileLayout from "../lib/useMobileLayout.js";
import { codingRoute } from "../features/coding/routes.js";
import { connectionsRoute } from "../features/connections/routes.js";
import { hintText, hintTone, menuArea, menuGroups } from "./sidebar-menu-model.js";
import useMenuHints from "./useMenuHints.js";
import { routePath } from "./routes.js";
import useSearchDialog from "./search-dialog.js";

const labels = {
  overview: () => commonCopy.overview,
  projects: () => copy.projectsNavigation,
  pipelines: () => pipelineCopy.title,
  files: () => filesCopy.tab,
  artifacts: () => artifactCopy.title,
  agents: () => assistantCopy.title,
  clis: () => codingPageCopy.title,
  connections: () => connectionsAreaCopy.title,
  settings: () => commonCopy.settings,
};
const groupLabels = { work: () => copy.workGroup, setup: () => copy.setupGroup };

// The landmark wraps the trigger, so "Hauptnavigation" exists while the list is closed.
// Menü variant A (handoff §5.1): Arbeiten and Einrichten with status hints.
export default function SidebarMenu({
  address,
  selected,
  page,
  navigate,
  select,
  state,
  ready,
  localAccess,
  error,
  loading,
  mobileNav,
}) {
  const [open, setOpen] = useState(false);
  const mobile = useMobileLayout();
  const search = useSearchDialog();
  const id = useId();
  const hints = useMenuHints(open, state, ready && !error);
  const area = menuArea(address, selected);
  const location = address ? routePath(address) : "";
  const root = useRef(null),
    trigger = useRef(null),
    popover = useRef(null);
  const close = (restore = true) => {
    setOpen(false);
    if (restore) queueMicrotask(() => trigger.current?.focus());
  };
  // A new page or a closed drawer leaves no menu behind.
  useEffect(() => {
    setOpen(false);
  }, [location, selected, mobileNav]);
  useEffect(() => {
    if (!open) return undefined;
    popover.current?.querySelector("button:not(:disabled), a")?.focus();
    const outside = (event) => {
      if (!root.current?.contains(event.target)) setOpen(false);
    };
    // Document level, so Escape works even when focus fell back to the body; stopping
    // it here keeps App's window listener from also closing the drawer (one layer).
    const escape = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  const go = {
    overview: () => select(null),
    projects: () => page("projects"),
    pipelines: () => page("pipelines"),
    files: () => page("files"),
    artifacts: () => page("artifacts"),
    agents: () => page("agents"),
    clis: () => navigate(codingRoute()),
    connections: () => navigate(connectionsRoute()),
    settings: () => page("settings"),
  };
  const entry = ({ id: key, icon }) => {
    const hint = hints[key];
    const hintId = `${id}-${key}-hint`;
    const labelId = `${id}-${key}-label`;
    const active = area === key;
    return (
      <button
        key={key}
        type="button"
        className={active ? "nav-item selected" : "nav-item"}
        aria-current={active ? "page" : undefined}
        // The name is the area; its hint describes it.
        aria-labelledby={labelId}
        aria-describedby={hint ? hintId : undefined}
        onClick={() => {
          close();
          go[key]();
        }}
      >
        <Icon name={icon} size={17} />
        <span className="sidebar-menu-entry" id={labelId}>
          {labels[key]()}
        </span>
        {hint && (
          <span id={hintId} className={`sidebar-menu-hint ${hintTone(hint)}`}>
            {hintText(hint, copy.hints)}
          </span>
        )}
      </button>
    );
  };
  return (
    <nav className="sidebar-menu" aria-label={copy.ariaLabel} ref={root}>
      <button
        ref={trigger}
        type="button"
        className={`sidebar-menu-button ${open ? "open" : ""}`}
        aria-label={open ? copy.closeMenu : undefined}
        aria-expanded={open}
        aria-controls="sidebar-menu"
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name={open ? "close" : "menu"} size={16} />
        {copy.menu}
      </button>
      <div
        className="sidebar-menu-scrim"
        hidden={!open}
        aria-hidden="true"
        onClick={() => close()}
      />
      <div
        id="sidebar-menu"
        className="sidebar-menu-popover"
        hidden={!open}
        ref={popover}
      >
        {mobile && (
          <button
            type="button"
            className="sidebar-menu-search"
            onClick={() => {
              close();
              search.open();
            }}
          >
            <Icon name="search" size={16} />
            {copy.searchRow}
          </button>
        )}
        {menuGroups.map((group) => (
          <div
            key={group.id}
            role="group"
            className="sidebar-menu-group"
            aria-labelledby={`${id}-${group.id}`}
          >
            <div className="sidebar-menu-label" id={`${id}-${group.id}`}>
              {groupLabels[group.id]()}
            </div>
            {group.entries.map(entry)}
          </div>
        ))}
        <div className="sidebar-menu-divider" />
        <div className="host-status">
          <StatusDot tone={error ? "error" : "ok"} />
          <span>
            {copy.hostStatusLabel}
            <small>
              {error
                ? commonCopy.serviceUnavailable
                : loading
                  ? copy.serviceConnecting
                  : copy.localHostDescription}
            </small>
          </span>
          <Icon name="shield" size={16} />
        </div>
        {state.remoteUrl && localAccess && (
          <a
            className="remote-link"
            href={state.remoteUrl}
            target="_blank"
            rel="noreferrer"
          >
            <Icon name="link" size={14} />
            {copy.remoteLink}
            <Icon name="arrow" size={14} />
          </a>
        )}
        <div className="sidebar-menu-logout">
          <LogoutButton />
        </div>
      </div>
    </nav>
  );
}
