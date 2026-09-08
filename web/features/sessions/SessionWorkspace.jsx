import { sshCopy } from "../../lib/i18n/messages/ssh.js";
import { sessionActivity } from "./sessionPresentation.js";
import { filesCopy } from "../../lib/i18n/messages/files.js";
import { pipelineCopy } from "../../lib/i18n/messages/pipelines.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { sessionWorkspaceCopy as copy } from "../../lib/i18n/messages/sessions.js";
import React, { lazy, Suspense, useRef, useState } from "react";
import api from "../../lib/api.js";
import { names, statusLabels } from "../../lib/providers.js";
import Icon from "../../components/Icon.jsx";
import ProviderMark from "../../components/ProviderMark.jsx";
import ChatView from "../chat/ChatView.jsx";
import useChatViewport from "../chat/useChatViewport.js";
const SessionSshDialog = lazy(() => import("../ssh/SessionSshDialog.jsx"));
const FileExplorer = lazy(() => import("../files/FileExplorer.jsx"));
const TerminalView = lazy(() => import("../terminal/TerminalView.jsx"));
export default function SessionWorkspace({
  session,
  account,
  action,
  mode,
  setMode,
  route,
  navigate,
  openNavigation,
}) {
  const [sshSession, setSshSession] = useState(null);
  const sessionIdentity = JSON.stringify([
    session.id,
    session.accountId,
    session.tool,
    session.createdAt,
  ]);
  const [connection, setConnection] = useState("connecting");
  const coding = session.tool !== "shell";
  const mobileChat = coding && mode === "reader";
  useChatViewport(mobileChat);
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
    <div className={`session-workspace${mobileChat ? " mobile-chat-workspace" : ""}`}>
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
            </p>
          </div>
        </div>
        <div className="session-actions">
          {session.status === "running" &&
            !session.pipeline?.headless &&
            session.purpose !== "login" && (
              <button
                className="icon-button"
                aria-label={sshCopy.title}
                title={sshCopy.title}
                onClick={() => setSshSession(sessionIdentity)}
              >
                <Icon name="link" />
              </button>
            )}
          <button
            className="icon-button"
            aria-label={commonCopy.renameSession}
            onClick={() => action("rename", session)}
          >
            <Icon name="edit" />
          </button>
          <button
            className="icon-button"
            aria-label={
              session.status === "running"
                ? commonCopy.stopSession
                : commonCopy.removeSession
            }
            disabled={Boolean(session.pipeline?.headless)}
            onClick={() =>
              action(session.status === "running" ? "stop" : "remove", session)
            }
          >
            <Icon name={session.status === "running" ? "stop" : "trash"} />
          </button>
        </div>
      </header>
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
        </div>
        {mode !== "files" && (
          <span className={`connection ${connection}`} role="status">
            <i />
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
      <div className="terminal-shell">
        {mode === "files" && (
          <Suspense fallback={<p>{filesCopy.loading}</p>}>
            <FileExplorer session={session} route={route} navigate={navigate} />
          </Suspense>
        )}
        {mode === "terminal" && (
          <Suspense fallback={<p className="chat-notice">{copy.chatNotice}</p>}>
            <TerminalView
              session={session}
              mode={mode}
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
      {sshSession === sessionIdentity &&
        session.status === "running" &&
        !session.pipeline?.headless && (
          <Suspense fallback={<p role="status">{sshCopy.loading}</p>}>
            <SessionSshDialog
              key={sessionIdentity}
              session={session}
              close={() => setSshSession(null)}
            />
          </Suspense>
        )}
      <footer className="session-footer">
        <span title={session.cwd}>
          <Icon name="folder" size={13} />
          {session.repositoryName || session.cwd}
        </span>
        <span>{copy.sessionFooterLabel}</span>
      </footer>
    </div>
  );
}
