import React, { useEffect, useId, useState } from "react";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import GroupLabel from "../../../components/GroupLabel.jsx";
import ListCard from "../../../components/ListCard.jsx";
import { CheckboxRow } from "../../../components/ListRow.jsx";
import ReferenceRow from "../../../components/ReferenceRow.jsx";
import { routePath } from "../../../app/routes.js";
import { useCrossLink } from "../../../app/cross-link.js";
import { mcpOAuthCopy } from "../../../lib/i18n/messages/mcp-oauth.js";
import { mcpServerCopy as copy } from "../../../lib/i18n/messages/mcp-servers.js";
import { assistantSettingsCopy as settingsCopy } from "../../../lib/i18n/messages/assistant-settings.js";
import { assistantApi } from "../assistant-api.js";
import McpOAuthStatus, {
  oauthStatusOf,
  usesOAuth,
} from "../../mcp-servers/McpOAuthStatus.jsx";
import RouteLink from "../RouteLink.jsx";
import { toggleId } from "./agent-settings-fields.js";
import "../../mcp-servers/mcp-servers.css";

/** Which central MCP servers the agent may use; saved with the Capabilities tab. */
export default function McpGroup({ assistant, draft, notice, reloadKey, navigate }) {
  const id = useId();
  const crossLink = useCrossLink();
  const [servers, setServers] = useState(null),
    [error, setError] = useState("");
  const bound = assistant.mcpServers || [];
  // An agent with its own Telegram bot for other people binds remote servers only.
  const noStdio = Boolean(assistant.telegramSenders);
  const stdioLocked = (server) =>
    noStdio &&
    server.transport === "stdio" &&
    !draft.values.mcpServers.includes(server.id);
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
  const loginShown = (server) => usesOAuth(server) && bound.includes(server.id);
  const loginMissing = (servers || []).some(
    (server) => loginShown(server) && oauthStatusOf(server) !== "connected",
  );
  const accounts = crossLink({ view: "accounts", section: "mcp-servers" });
  return (
    <section id="agent-mcp" aria-labelledby={id}>
      <GroupLabel id={id} hint={copy.agentDescription}>
        {copy.agentTitle}
      </GroupLabel>
      <ErrorMessage error={error} />
      {servers && !servers.length ? (
        <div className="list-card agent-empty">
          <p>{copy.agentNone}</p>
          <RouteLink route={accounts} navigate={navigate}>
            {copy.agentOpenAccounts}
          </RouteLink>
        </div>
      ) : (
        <ListCard labelledBy={id}>
          {(servers || []).map((server) => (
            <CheckboxRow
              key={server.id}
              label={server.name}
              sub={loginShown(server) ? <McpOAuthStatus server={server} /> : undefined}
              pill={server.transport === "stdio" ? copy.stdioBadge : undefined}
              checked={draft.values.mcpServers.includes(server.id)}
              disabled={draft.saving || stdioLocked(server)}
              onChange={(on) =>
                draft.set("mcpServers", toggleId(draft.values.mcpServers, server.id, on))
              }
            />
          ))}
        </ListCard>
      )}
      {noStdio && (servers || []).some((server) => server.transport === "stdio") && (
        <p className="mcp-hint">{copy.stdioTelegramSenders}</p>
      )}
      {loginMissing && <p className="mcp-hint">{mcpOAuthCopy.agentLoginHint}</p>}
      {notice && (
        <p role="status" className="mcp-hint">
          {notice}
        </p>
      )}
      <ReferenceRow
        title={settingsCopy.manageMcpServers}
        href={routePath(accounts)}
        onOpen={() => navigate(accounts)}
      />
    </section>
  );
}
