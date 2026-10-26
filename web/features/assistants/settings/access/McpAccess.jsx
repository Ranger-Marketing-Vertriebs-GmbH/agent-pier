import React, { useEffect, useState } from "react";
import ErrorMessage from "../../../../components/ErrorMessage.jsx";
import { routePath } from "../../../../app/routes.js";
import { useCrossLink } from "../../../../app/cross-link.js";
import { isPlainClick } from "../../../../components/link-click.js";
import { assistantSettingsCopy } from "../../../../lib/i18n/messages/assistant-settings.js";
import { mcpOAuthCopy } from "../../../../lib/i18n/messages/mcp-oauth.js";
import { mcpPackageCopy } from "../../../../lib/i18n/messages/mcp-packages.js";
import { mcpServerCopy } from "../../../../lib/i18n/messages/mcp-servers.js";
import McpOAuthStatus, {
  oauthStatusOf,
  usesOAuth,
} from "../../../mcp-servers/McpOAuthStatus.jsx";
import { connectionsRoute } from "../../../connections/routes.js";
import { assistantApi } from "../../assistant-api.js";
import AccessGroup from "./AccessGroup.jsx";
import GrantRow from "./GrantRow.jsx";
import { addIds, candidatesOf, grantedItems, removeId } from "./access-groups.js";
import "../../../mcp-servers/mcp-servers.css";

const copy = assistantSettingsCopy.access;

/**
 * MCP-Server (moved from Capabilities): the central servers bound to this agent, each
 * with its sign-in status and "Öffnen" into Zugänge. Saved with the agent's PATCH
 * through the Access tab's save bar; binding a local server asks to confirm.
 */
export default function McpAccess({
  assistant,
  draft,
  disabled,
  notice,
  reloadKey,
  navigate,
}) {
  const crossLink = useCrossLink();
  const [servers, setServers] = useState(null),
    [error, setError] = useState(""),
    [expanded, setExpanded] = useState(false);
  const bound = assistant.mcpServers || [];
  const selected = draft.values.mcpServers || [];
  // An agent with its own Telegram bot for other people binds remote servers only.
  const noStdio = Boolean(assistant.telegramSenders);
  const stdioLocked = (server) =>
    noStdio && server.transport === "stdio" && !selected.includes(server.id);
  // A package that is not installed (installing, failed, missing) gets no new agent.
  const packageLocked = (server) =>
    !!server.source && server.source.status !== "ready" && !selected.includes(server.id);
  // A saved binding compiles the server: its login status is read again after a save.
  useEffect(() => {
    let live = true;
    assistantApi
      .mcpServers()
      .then((list) => live && setServers(list))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [assistant.revision, reloadKey]);
  const list = servers || [];
  const loginShown = (server) => usesOAuth(server) && bound.includes(server.id);
  const loginMissing = list.some(
    (server) => loginShown(server) && oauthStatusOf(server) !== "connected",
  );
  const set = (next) => draft.set("mcpServers", next);
  const open = (server) => crossLink(connectionsRoute("mcp-servers", server.id));
  return (
    <AccessGroup
      id="agent-mcp"
      title={copy.mcp}
      hint={mcpServerCopy.agentDescription}
      entries={grantedItems(list, selected)}
      total={servers ? servers.length : error ? null : undefined}
      loading={!servers && !error}
      more={{ expanded, open: () => setExpanded(true) }}
      renderRow={(server) => (
        <GrantRow
          key={server.id}
          id={server.id}
          name={server.name}
          sub={loginShown(server) ? <McpOAuthStatus server={server} /> : undefined}
          pill={server.transport === "stdio" ? mcpServerCopy.stdioBadge : undefined}
          disabled={disabled}
          actions={
            <a
              className="button secondary compact"
              href={routePath(open(server))}
              aria-label={copy.mcpOpenLabel(server.name)}
              onClick={(event) => {
                if (!isPlainClick(event)) return;
                event.preventDefault();
                navigate(open(server));
              }}
            >
              {copy.mcpOpen}
            </a>
          }
          onRevoke={() => set(removeId(selected, server.id))}
        />
      )}
      picker={{
        typeLabel: copy.mcpType,
        candidates: candidatesOf(
          list.filter((server) => !stdioLocked(server) && !packageLocked(server)),
          (server) => ({
            sub:
              server.transport === "stdio" ? mcpServerCopy.stdioBadge : server.transport,
          }),
        ),
        granted: selected,
        disabled,
        onAdd: (items) =>
          set(
            addIds(
              selected,
              items.map((item) => item.id),
            ),
          ),
      }}
      setup={{
        title:
          servers?.length === 0 ? copy.mcpSetup : assistantSettingsCopy.manageMcpServers,
        route: crossLink(connectionsRoute("mcp-servers")),
        navigate,
        always: true,
      }}
      notes={
        <>
          <ErrorMessage error={error} />
          {servers?.length === 0 && <p className="mcp-hint">{mcpServerCopy.agentNone}</p>}
          {noStdio && list.some((server) => server.transport === "stdio") && (
            <p className="mcp-hint">{mcpServerCopy.stdioTelegramSenders}</p>
          )}
          {list.some(packageLocked) && (
            <p className="mcp-hint">{mcpPackageCopy.bindingLocked}</p>
          )}
          {loginMissing && <p className="mcp-hint">{mcpOAuthCopy.agentLoginHint}</p>}
          {notice && (
            <p role="status" className="mcp-hint">
              {notice}
            </p>
          )}
        </>
      }
    />
  );
}
