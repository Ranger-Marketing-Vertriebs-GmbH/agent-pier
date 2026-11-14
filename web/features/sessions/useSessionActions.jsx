import React, { lazy, Suspense, useMemo, useState } from "react";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { mcpCopy } from "../../lib/i18n/messages/mcp.js";
import { sessionReloadCopy } from "../../lib/i18n/messages/sessions.js";
import { sshCopy } from "../../lib/i18n/messages/ssh.js";
import { sessionTalkCopy } from "../../lib/i18n/messages/session-talk.js";
import { cliDefinition, isCodingCli } from "../../../server/features/clis/catalog.js";
import { usePageAction } from "../../app/page-action.js";
import { usePane } from "../../lib/pane-context.js";
import { talkEligibleSession } from "../session-talk/talk-eligible.js";
import useAssistantFeature from "../assistants/useAssistantFeature.js";

const SessionReloadDialog = lazy(() => import("./SessionReloadDialog.jsx"));
const SessionMcpDialog = lazy(() => import("../mcp/SessionMcpDialog.jsx"));
const SessionSshDialog = lazy(() => import("../ssh/SessionSshDialog.jsx"));
const SessionAgentAccessDialog = lazy(
  () => import("../session-talk/SessionAgentAccessDialog.jsx"),
);

/**
 * A session's own actions (reload, account switch, MCP tools, SSH, agent access, rename
 * and stop or remove) with the dialogs they open. The page header shows `items` as icon buttons,
 * a pane header lists them in its ⋯ menu. A dialog belongs to the session it was
 * opened for: a new session identity closes it.
 */
export default function useSessionActions({ session, action, reloadable, openTerminal }) {
  const [sshSession, setSshSession] = useState(null);
  const [mcpSession, setMcpSession] = useState(null);
  const [agentSession, setAgentSession] = useState(null);
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
  // Agent access (session-talk) for running coding sessions while agents are on; ⌘K
  // opens it through the page action, in a split view only from the focused pane.
  const agentsEnabled = useAssistantFeature().enabled === true;
  const talk = agentsEnabled && talkEligibleSession(session);
  const focused = usePane()?.focused !== false;
  usePageAction(
    "session-agent-access",
    () => setAgentSession(sessionIdentity),
    talk && focused,
  );
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
    isCodingCli(session.tool) &&
    cliDefinition(session.tool).capabilities.accountTransfer &&
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
  if (talk)
    items.push({
      id: "agent-access",
      label: sessionTalkCopy.dialog.title,
      title: sessionTalkCopy.dialog.title,
      icon: "talk",
      run: () => setAgentSession(sessionIdentity),
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
      {agentSession === sessionIdentity && talk && (
        <Suspense fallback={<p role="status">{sessionTalkCopy.dialog.loading}</p>}>
          <SessionAgentAccessDialog
            key={sessionIdentity}
            session={session}
            close={() => setAgentSession(null)}
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
