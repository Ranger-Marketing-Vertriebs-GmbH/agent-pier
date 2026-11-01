import React, { lazy, Suspense, useState } from "react";
import Icon from "../../components/Icon.jsx";
import ProviderMark from "../../components/ProviderMark.jsx";
import Sheet from "../../components/Sheet.jsx";
import StatusChip from "../../components/StatusChip.jsx";
import StatusDot from "../../components/StatusDot.jsx";
import { activityTone } from "../../components/status-tones.js";
import { routePath } from "../../app/routes.js";
import { names } from "../../lib/providers.js";
import { artifactCopy } from "../../lib/i18n/messages/artifacts.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { filesCopy } from "../../lib/i18n/messages/files.js";
import { sessionWorkspaceCopy as copy } from "../../lib/i18n/messages/sessions.js";
import { viewsCopy } from "../../lib/i18n/messages/views.js";
import { RowMenu, useRowMenu } from "../extensions/RowMenu.jsx";
import { sessionActivity } from "./sessionPresentation.js";

const SessionPreviews = lazy(() => import("../previews/SessionPreviews.jsx"));
const SessionArtifacts = lazy(() => import("../artifacts/SessionArtifacts.jsx"));

const folderName = (cwd = "") => cwd.split("/").filter(Boolean).at(-1) || cwd;

/**
 * One compact row on top of a session pane: name, activity, repository and CLI, the
 * Terminal / Chat / Files switch, previews, ⋯ (the pane's own entries, then the
 * session's actions and its artifacts) and × to take the pane out of the view.
 */
export default function SessionPaneHeader({
  session,
  mode,
  setMode,
  coding,
  actions,
  pane,
  route,
  navigate,
  // The terminal or chat connection; a lost one shows as a small "Disconnected" chip.
  connection,
}) {
  const menu = useRowMenu();
  const [artifactsOpen, setArtifactsOpen] = useState(false);
  const { state: activity, label: activityLabel } = sessionActivity(session);
  const items = [
    ...pane.menuItems,
    ...(pane.menuItems.length ? [{ id: "pane-separator", kind: "separator" }] : []),
    ...actions.items.map(({ id, label, run, disabled }) => ({
      id,
      label,
      run,
      disabled,
      danger: id === "stop" || id === "remove",
    })),
    ...(coding
      ? [
          {
            id: "artifacts",
            label: artifactCopy.title,
            run: () => setArtifactsOpen(true),
          },
        ]
      : []),
  ];
  const tab = (value, icon, label) => (
    <button
      type="button"
      className={mode === value ? "selected" : ""}
      onClick={() => setMode(value)}
    >
      {icon}
      {label}
    </button>
  );
  return (
    <>
      <header className="session-pane-header" {...pane.headerProps}>
        <ProviderMark tool={session.tool} small />
        <div className="session-pane-title">
          <div className="session-pane-name">
            <h2>{session.name}</h2>
            <StatusDot
              tone={activityTone(activity)}
              pulse={activity === "working"}
              label={activityLabel}
            />
            {connection === "disconnected" && mode !== "files" && (
              <span
                className="session-pane-offline"
                role="status"
                title={copy.terminalTopbarDisconnected}
              >
                <StatusChip tone="error">{viewsCopy.disconnected}</StatusChip>
              </span>
            )}
          </div>
          <p title={session.cwd}>
            {session.repositoryName || folderName(session.cwd)} · {names[session.tool]}
          </p>
        </div>
        <div className="segmented">
          {tab("terminal", <Icon name="terminal" size={15} />, copy.terminalTab)}
          {coding &&
            tab(
              "reader",
              activity === "working" ? (
                <span className="chat-working-spinner" aria-hidden="true" />
              ) : (
                <Icon name="book" size={15} />
              ),
              copy.chatTab,
            )}
          {tab("files", <Icon name="folder" size={15} />, filesCopy.tab)}
        </div>
        <div className="session-pane-actions">
          {coding && (
            <Suspense>
              <SessionPreviews sessionId={session.id} />
            </Suspense>
          )}
          <button
            type="button"
            className="icon-button"
            aria-label={viewsCopy.paneMenu(session.name)}
            aria-haspopup="menu"
            aria-expanded={menu.open}
            onClick={menu.toggle}
          >
            <Icon name="more" />
          </button>
          <RowMenu label={viewsCopy.paneMenu(session.name)} state={menu} items={items} />
          <button
            type="button"
            className="icon-button"
            aria-label={viewsCopy.removePane(session.name)}
            title={viewsCopy.removePane(session.name)}
            onClick={pane.close}
          >
            <Icon name="close" />
          </button>
        </div>
      </header>
      <Sheet
        open={artifactsOpen}
        title={artifactCopy.title}
        onCancel={() => setArtifactsOpen(false)}
      >
        <Suspense>
          <SessionArtifacts
            key={session.id}
            sessionId={session.id}
            returnTo={routePath({ ...route, sessionId: session.id, mode })}
            navigate={navigate}
          />
        </Suspense>
        <div className="sheet-actions">
          <button
            type="button"
            className="button secondary"
            onClick={() => setArtifactsOpen(false)}
          >
            {commonCopy.close}
          </button>
        </div>
      </Sheet>
    </>
  );
}
