import { artifactCopy } from "../../lib/i18n/messages/artifacts.js";
import {
  sessionInterruptionCopy,
  sessionReloadCopy,
} from "../../lib/i18n/messages/sessions.js";
import "./session-reload.css";
import "../artifacts/artifacts.css";
import { sessionActivity } from "./sessionPresentation.js";
import { filesCopy } from "../../lib/i18n/messages/files.js";
import { pipelineCopy } from "../../lib/i18n/messages/pipelines.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import {
  sessionChangesCopy,
  sessionWorkspaceCopy as copy,
} from "../../lib/i18n/messages/sessions.js";
import React, { lazy, Suspense, useRef, useState } from "react";
import api from "../../lib/api.js";
import { routePath } from "../../app/routes.js";
import { names, statusLabels } from "../../lib/providers.js";
import Icon from "../../components/Icon.jsx";
import useMediaQuery from "../../lib/useMediaQuery.js";
import { mediaQueries } from "../../lib/breakpoints.js";
import { RowMenu, useRowMenu } from "../extensions/RowMenu.jsx";
import ProviderMark from "../../components/ProviderMark.jsx";
import { routeLabel } from "../provider-connections/route-label.js";
import ChatView from "../chat/ChatView.jsx";
import useSessionViewport from "./useSessionViewport.js";
import useSessionChanges from "./useSessionChanges.js";
import ChangesSend from "./ChangesSend.jsx";
import { changedCount } from "./session-changes-state.js";
import ChangesBadge from "./ChangesBadge.jsx";
import useSessionActions from "./useSessionActions.jsx";
import SessionGithubStatus from "./SessionGithubStatus.jsx";
import SessionPaneHeader from "./SessionPaneHeader.jsx";
import StatusDot from "../../components/StatusDot.jsx";
import TicketLink from "../projects/TicketLink.jsx";

// The terminal connection as a status dot: connected is ok, not the accent.
const connectionTones = { connecting: "waiting", connected: "ok", disconnected: "error" };
const PipelineSessionRecovery = lazy(
  () => import("../pipelines/PipelineSessionRecovery.jsx"),
);
const SessionPreviews = lazy(() => import("../previews/SessionPreviews.jsx"));
const SessionArtifacts = lazy(() => import("../artifacts/SessionArtifacts.jsx"));
const FileExplorer = lazy(() => import("../files/FileExplorer.jsx"));
const SessionChanges = lazy(() => import("./SessionChanges.jsx"));
const TerminalView = lazy(() => import("../terminal/TerminalView.jsx"));

const ActionButton = ({ item }) => (
  <button
    className="icon-button"
    aria-label={item.label}
    title={item.title}
    disabled={item.disabled}
    onClick={item.run}
  >
    <Icon name={item.icon} />
  </button>
);
export default function SessionWorkspace({
  session,
  account,
  action,
  mode,
  setMode,
  route,
  navigate,
  openNavigation,
  autoResume = true,
  // The pane's chrome inside a split view ({ menuItems, close, headerProps }), else null.
  pane = null,
}) {
  const [artifactsOpen, setArtifactsOpen] = useState(false);
  // On a phone the session's actions share one More menu, so the header never overflows.
  const phone = useMediaQuery(mediaQueries.phone);
  const actionsMenu = useRowMenu();
  const [connection, setConnection] = useState("connecting");
  const coding = session.tool !== "shell";
  // The tab badge follows the summary; the diff is read only once the tab is open.
  // A login session follows nothing: it has no work to review.
  const changes = useSessionChanges(session.purpose === "login" ? null : session.id);
  const changed = changedCount(changes.summary);
  // The terminal connection does not matter on the Files and Changes tabs.
  const offTerminal = mode === "files" || mode === "changes";
  const reloadable = coding && !session.pipeline && session.purpose !== "login";
  // A pane is never the phone layout: it keeps its own height inside the view.
  const mobileChat = !pane && coding && mode === "reader";
  const mobileViewport = !pane && (mobileChat || mode === "terminal");
  useSessionViewport(mobileViewport);
  const sendRef = useRef(null);
  const focusRef = useRef(null);
  const showTerminal = () => {
    if (mode !== "terminal") {
      setConnection("connecting");
      setMode("terminal");
    } else {
      focusRef.current?.();
    }
  };
  const actions = useSessionActions({
    session,
    action,
    reloadable,
    openTerminal: showTerminal,
  });
  const { sessionIdentity } = actions;
  const reloadItem = actions.items.find((item) => item.id === "reload");
  const keys = [
    ["Esc", "", commonCopy.sendEscape],
    ["Tab", "\t", commonCopy.sendTab],
    ["↑", "[A", commonCopy.sendArrowUp],
    ["↓", "[B", commonCopy.sendArrowDown],
    ["←", "[D", commonCopy.sendArrowLeft],
    ["→", "[C", commonCopy.sendArrowRight],
    ["Ctrl C", "", copy.interruptKeyboardLabel],
    ["Enter ↵", "\r", commonCopy.sendEnter],
  ];
  return (
    <div
      className={`session-workspace${pane ? " in-pane" : ""}${mobileViewport ? " mobile-session-workspace" : ""}${mobileChat ? " mobile-chat-workspace" : ""}`}
    >
      {pane ? (
        <SessionPaneHeader
          session={session}
          mode={mode}
          setMode={(next) => (next === "terminal" ? showTerminal() : setMode(next))}
          coding={coding}
          actions={actions}
          pane={pane}
          route={route}
          navigate={navigate}
          connection={connection}
          changed={changed}
        />
      ) : (
        <header className="session-heading">
          {mobileChat && (
            <button
              type="button"
              className="icon-button chat-navigation"
              aria-label={copy.openNavigation}
              onClick={openNavigation}
            >
              <Icon name="menu" />
            </button>
          )}
          <div className="session-title">
            <ProviderMark tool={session.tool} small />
            <div>
              <h1>{session.name}</h1>
              <p>
                {names[session.tool]}
                <span> / </span>
                {session.access?.providerConnectionName ||
                  account?.name ||
                  copy.sessionTitleDescription}
                {/* The space keeps screen readers from joining name and route. */}
                {session.provider?.route && " "}
                {session.provider?.route && (
                  <span className="route-badge" title={copy.routeTitle}>
                    {routeLabel(session.provider.route)}
                  </span>
                )}
              </p>
              {session.startedBy?.kind === "agent" && (
                <p className="session-started-by">
                  {copy.startedByAgent(session.startedBy.name)}
                </p>
              )}
              <TicketLink
                ticket={session.ticket}
                text={copy.ticket}
                className="session-started-by"
              />
            </div>
          </div>
          <div className="session-actions">
            {!phone && reloadItem && <ActionButton item={reloadItem} />}
            {coding && (
              <Suspense>
                <SessionPreviews sessionId={session.id} />
              </Suspense>
            )}
            {coding && (
              <details
                className="session-artifacts"
                onToggle={(event) => setArtifactsOpen(event.currentTarget.open)}
              >
                <summary>{artifactCopy.title}</summary>
                {artifactsOpen && (
                  <Suspense>
                    <SessionArtifacts
                      key={session.id}
                      sessionId={session.id}
                      returnTo={routePath({ ...route, sessionId: session.id, mode })}
                      navigate={navigate}
                    />
                  </Suspense>
                )}
              </details>
            )}
            {!phone &&
              actions.items
                .filter((item) => item !== reloadItem)
                .map((item) => <ActionButton key={item.id} item={item} />)}
            {phone && (
              <>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={commonCopy.moreActions}
                  aria-haspopup="menu"
                  aria-expanded={actionsMenu.open}
                  onClick={actionsMenu.toggle}
                >
                  <Icon name="more" />
                </button>
                <RowMenu
                  label={commonCopy.moreActions}
                  state={actionsMenu}
                  sheet={{ title: session.name }}
                  items={actions.items.map(({ id, label, run, disabled }) => ({
                    id,
                    label,
                    disabled,
                    danger: id === "stop" || id === "remove",
                    run: () => run(),
                  }))}
                />
              </>
            )}
          </div>
        </header>
      )}
      {reloadable &&
        ["waiting", "reloading", "failed"].includes(session.reload?.state) && (
          <div className="session-reload-notice" role="status">
            <button className="button" onClick={actions.openReload}>
              {sessionReloadCopy[session.reload.state]}
            </button>
          </div>
        )}
      {reloadable && session.status === "stopped" && session.interruption && (
        <div className="session-reload-notice" role="status">
          <span>
            {["failed", "skipped"].includes(session.interruption.resume)
              ? Object.hasOwn(
                  sessionInterruptionCopy.reasons,
                  session.interruption.reason,
                )
                ? sessionInterruptionCopy.failed(
                    sessionInterruptionCopy.reasons[session.interruption.reason],
                  )
                : sessionInterruptionCopy.failedUnknown
              : session.interruption.resume === "pending" && !autoResume
                ? sessionInterruptionCopy.disabled
                : sessionInterruptionCopy.resuming}
          </span>
        </div>
      )}
      {session.pipeline?.headless && (
        <div className="pipeline-session-notice">
          <span>{pipelineCopy.pipelineSessionReadOnly}</span>
          {session.pipeline.runId && (
            <a href={`/pipelines/runs/${encodeURIComponent(session.pipeline.runId)}`}>
              {pipelineCopy.returnToRun}
            </a>
          )}
        </div>
      )}
      {session.pipeline?.headless &&
        session.pipeline.runId &&
        session.status === "stopped" && (
          <Suspense fallback={null}>
            <PipelineSessionRecovery key={sessionIdentity} session={session} />
          </Suspense>
        )}
      {!pane && (
        <div className="terminal-topbar">
          <div className="segmented">
            <button
              className={mode === "terminal" ? "selected" : ""}
              onClick={showTerminal}
            >
              <Icon name="terminal" size={15} />
              {copy.terminalTab}
            </button>
            {coding && (
              <button
                className={mode === "reader" ? "selected" : ""}
                onClick={() => setMode("reader")}
              >
                {sessionActivity(session).state === "working" ? (
                  <span className="chat-working-spinner" aria-hidden="true" />
                ) : (
                  <Icon name="book" size={15} />
                )}
                {copy.chatTab}
              </button>
            )}
            <button
              className={mode === "files" ? "selected" : ""}
              onClick={() => setMode("files")}
            >
              <Icon name="folder" size={15} />
              {filesCopy.tab}
            </button>
            <button
              className={mode === "changes" ? "selected" : ""}
              aria-label={changed ? copy.changesTabCount(changed) : undefined}
              onClick={() => setMode("changes")}
            >
              <Icon name="diff" size={15} />
              {copy.changesTab}
              <ChangesBadge count={changed} />
            </button>
          </div>
          {!offTerminal && (
            <span className={`connection ${connection}`} role="status">
              <StatusDot tone={connectionTones[connection] ?? "idle"} />
              {
                {
                  connecting: commonCopy.connecting,
                  connected: commonCopy.connected,
                  disconnected: copy.terminalTopbarDisconnected,
                  ended: statusLabels[session.status] || commonCopy.ended,
                }[connection]
              }
            </span>
          )}
        </div>
      )}
      <div className="terminal-shell">
        {mode === "files" && (
          <Suspense fallback={<p>{filesCopy.loading}</p>}>
            <FileExplorer session={session} route={route} navigate={navigate} />
          </Suspense>
        )}
        {mode === "changes" && (
          <Suspense fallback={<p>{sessionChangesCopy.loading}</p>}>
            <SessionChanges
              key={session.id}
              session={session}
              changes={changes}
              toolbar={(review) => (
                <ChangesSend
                  session={session}
                  {...review}
                  // The batch is in the composer: show it; the owner sends.
                  onSend={() => setMode("reader")}
                />
              )}
            />
          </Suspense>
        )}
        {mode === "terminal" && (
          <Suspense fallback={<p className="chat-notice">{copy.chatNotice}</p>}>
            <TerminalView
              key={JSON.stringify([
                session.id,
                session.createdAt,
                session.status,
                session.restartGeneration,
              ])}
              session={session}
              mode={mode}
              connected={connection === "connected"}
              sendRef={sendRef}
              focusRef={focusRef}
              onConnection={setConnection}
              request={api}
            />
          </Suspense>
        )}
        {coding && (
          <div className="chat-container" hidden={mode !== "reader"}>
            <ChatView
              key={JSON.stringify([
                session.id,
                session.accountId,
                session.tool,
                session.createdAt,
              ])}
              active={mode === "reader"}
              session={session}
              request={api}
              onConnection={setConnection}
              openTerminal={showTerminal}
              openFile={(file) =>
                navigate({ ...route, mode: "files", file, filePath: "", filePage: 1 })
              }
            />
          </div>
        )}
      </div>
      {mode === "terminal" && (
        <div className="keyboard-toolbar" aria-label={copy.keyboardToolbarAriaLabel}>
          {keys.map(([label, data, title]) => (
            <button
              key={label}
              aria-label={title}
              disabled={
                session.pipeline?.headless ||
                session.status !== "running" ||
                connection !== "connected"
              }
              onClick={() => sendRef.current?.(data)}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {actions.dialogs}
      {!pane && (
        <footer className="session-footer">
          <span title={session.cwd}>
            <Icon name="folder" size={13} />
            {session.repositoryName || session.cwd}
          </span>
          {session.purpose !== "login" && !session.pipeline?.headless && (
            <SessionGithubStatus session={session} />
          )}
          <span>{copy.sessionFooterLabel}</span>
        </footer>
      )}
    </div>
  );
}
