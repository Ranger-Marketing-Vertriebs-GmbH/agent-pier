import React, { lazy, Suspense, useMemo, useState } from "react";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { mcpCopy } from "../../lib/i18n/messages/mcp.js";
import { sessionReloadCopy } from "../../lib/i18n/messages/sessions.js";
import { sshCopy } from "../../lib/i18n/messages/ssh.js";

const SessionReloadDialog = lazy(() => import("./SessionReloadDialog.jsx"));
const SessionMcpDialog = lazy(() => import("../mcp/SessionMcpDialog.jsx"));
const SessionSshDialog = lazy(() => import("../ssh/SessionSshDialog.jsx"));

/**
 * A session's own actions (reload, account switch, MCP tools, SSH, rename and stop or
 * remove) with the dialogs they open. The page header shows `items` as icon buttons,
 * a pane header lists them in its ⋯ menu. A dialog belongs to the session it was
 * opened for: a new session identity closes it.
 */
export default function useSessionActions({ session, action, reloadable, openTerminal }) {
  const [sshSession, setSshSession] = useState(null);
  const [mcpSession, setMcpSession] = useState(null);
  const [reloadSession, setReloadSession] = useState(null);
  const [switchAccount, setSwitchAccount] = useState(false);
  const sessionIdentity = JSON.stringify([
    session.id,
    session.deliveryAccountId || session.accountId,
    session.tool,
    session.createdAt,
  ]);
  const pendingReload = useMemo(
    () => ({ current: null, identity: sessionIdentity }),
    [sessionIdentity],
  );
  const running = session.status === "running";
  const items = [];
  if (reloadable)
    items.push({
      id: "reload",
      label: sessionReloadCopy.title,
      title: sessionReloadCopy.title,
      icon: "refresh",
      run: () => {
        setSwitchAccount(false);
        setReloadSession(sessionIdentity);
      },
    });
  if (
    reloadable &&
    ["codex", "claude"].includes(session.tool) &&
    !session.provider &&
    !session.access?.providerConnectionId
  )
    items.push({
      id: "switch-account",
      label: sessionReloadCopy.switchTitle,
      title: sessionReloadCopy.switchTitle,
      icon: "users",
      run: () => {
        setSwitchAccount(true);
        setReloadSession(sessionIdentity);
      },
    });
  if (session.agentpierTools)
    items.push({
      id: "mcp",
      label: mcpCopy.sessionTools,
      title: mcpCopy.sessionTools,
      icon: "shield",
      run: () => setMcpSession(sessionIdentity),
    });
  if (running && !session.pipeline?.headless && session.purpose !== "login")
    items.push({
      id: "ssh",
      label: sshCopy.title,
      title: sshCopy.title,
      icon: "link",
      run: () => setSshSession(sessionIdentity),
    });
  items.push({
    id: "rename",
    label: commonCopy.renameSession,
    icon: "edit",
    run: () => action("rename", session),
  });
  items.push({
    id: running ? "stop" : "remove",
    label: running ? commonCopy.stopSession : commonCopy.removeSession,
    icon: running ? "stop" : "trash",
    disabled: running && Boolean(session.pipeline?.headless),
    run: () => action(running ? "stop" : "remove", session),
  });
  const dialogs = (
    <>
      {mcpSession === sessionIdentity && session.agentpierTools && (
        <Suspense fallback={<p role="status">{mcpCopy.loading}</p>}>
          <SessionMcpDialog session={session} close={() => setMcpSession(null)} />
        </Suspense>
      )}
      {sshSession === sessionIdentity && running && !session.pipeline?.headless && (
        <Suspense fallback={<p role="status">{sshCopy.loading}</p>}>
          <SessionSshDialog
            key={sessionIdentity}
            session={session}
            close={() => setSshSession(null)}
            openReload={
              reloadable
                ? () => {
                    setSshSession(null);
                    setReloadSession(sessionIdentity);
                  }
                : undefined
            }
          />
        </Suspense>
      )}
      {reloadSession === sessionIdentity && reloadable && (
        <Suspense fallback={<p role="status">{sessionReloadCopy.loading}</p>}>
          <SessionReloadDialog
            key={sessionIdentity}
            session={session}
            close={() => setReloadSession(null)}
            pending={pendingReload}
            switchAccount={switchAccount}
            openTerminal={() => {
              setReloadSession(null);
              openTerminal();
            }}
          />
        </Suspense>
      )}
    </>
  );
  // The reload notice reopens the dialog as it was last opened.
  const openReload = () => setReloadSession(sessionIdentity);
  return { items, dialogs, openReload, sessionIdentity };
}
