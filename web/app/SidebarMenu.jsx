import React, { useEffect, useRef, useState } from "react";
import StatusDot from "../components/StatusDot.jsx";
import Icon from "../components/Icon.jsx";
import LogoutButton from "../features/login/LogoutButton.jsx";
import { assistantCopy } from "../lib/i18n/messages/assistants.js";
import { artifactCopy } from "../lib/i18n/messages/artifacts.js";
import { commonCopy } from "../lib/i18n/messages/common.js";
import { filesCopy } from "../lib/i18n/messages/files.js";
import { pipelineCopy } from "../lib/i18n/messages/pipelines.js";
import { sidebarCopy as copy } from "../lib/i18n/messages/app.js";

// The landmark wraps the trigger, so "Hauptnavigation" exists while the list is closed.
export default function SidebarMenu({
  view,
  selected,
  page,
  select,
  state,
  agentsEnabled,
  localAccess,
  error,
  loading,
  mobileNav,
}) {
  const [open, setOpen] = useState(false);
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
  }, [view, selected, mobileNav]);
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
  const entry = ({ key, icon, label, active, onClick, ariaLabel, extra }) => (
    <button
      key={key}
      type="button"
      aria-label={ariaLabel}
      className={active ? "nav-item selected" : "nav-item"}
      aria-current={active ? "page" : undefined}
      onClick={() => {
        close();
        onClick();
      }}
    >
      <Icon name={icon} size={17} />
      {label}
      {extra}
    </button>
  );
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
        {entry({
          key: "overview",
          icon: "grid",
          label: commonCopy.overview,
          active: view === "workspace" && !selected,
          onClick: () => select(null),
        })}
        {entry({
          key: "artifacts",
          icon: "grid",
          label: artifactCopy.title,
          active: view === "artifacts",
          onClick: () => page("artifacts"),
        })}
        {agentsEnabled &&
          entry({
            key: "agents",
            icon: "users",
            label: assistantCopy.title,
            active: view === "agents",
            onClick: () => page("agents"),
          })}
        <div className="sidebar-menu-label">{commonCopy.projectsGroup}</div>
        {entry({
          key: "projects",
          icon: "folder",
          label: copy.projectsNavigation,
          active: view === "projects",
          onClick: () => page("projects"),
        })}
        {entry({
          key: "files",
          icon: "history",
          label: filesCopy.tab,
          active: view === "files",
          onClick: () => page("files"),
        })}
        {entry({
          key: "pipelines",
          icon: "refresh",
          label: pipelineCopy.title,
          active: view === "pipelines",
          onClick: () => page("pipelines"),
        })}
        <div className="sidebar-menu-label">{commonCopy.configurationGroup}</div>
        {entry({
          key: "accounts",
          icon: "users",
          label: commonCopy.accounts,
          ariaLabel: commonCopy.accounts,
          active: view === "accounts" || view === "connections",
          onClick: () => page("accounts"),
          extra: (
            <span className="count">
              {state.accounts.filter((a) => a.tool !== "shell").length}
            </span>
          ),
        })}
        {entry({
          key: "extensions",
          icon: "grid",
          label: copy.extensionsNavigation,
          active: view === "extensions",
          onClick: () => page("extensions"),
        })}
        {entry({
          key: "settings",
          icon: "settings",
          label: commonCopy.settings,
          active: view === "settings",
          onClick: () => page("settings"),
        })}
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
