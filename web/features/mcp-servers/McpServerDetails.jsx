import React from "react";
import { mcpCliCopy as cliCopy } from "../../lib/i18n/messages/mcp-cli.js";
import { mcpOAuthCopy } from "../../lib/i18n/messages/mcp-oauth.js";
import { mcpServerCopy as copy } from "../../lib/i18n/messages/mcp-servers.js";
import { names as cliNames } from "../../lib/providers.js";
import { usesOAuth } from "./McpOAuthStatus.jsx";

const names = (list) => (list.length ? list.join(", ") : copy.noNames);

/** "Agents: Home, Lead · CLIs: Claude Code, Codex": who uses a server, by name. */
export function usersText(server) {
  const parts = [];
  if (server.users?.agents?.length)
    parts.push(cliCopy.agentsUsing(server.users.agents.join(", ")));
  if (server.users?.clis?.length)
    parts.push(
      cliCopy.clisUsing(server.users.clis.map((cli) => cliNames[cli] || cli).join(", ")),
    );
  return parts.length ? parts.join(" · ") : cliCopy.unused;
}

export default function McpServerDetails({ server }) {
  const stdio = server.transport === "stdio";
  return (
    <dl className="mcp-details">
      {stdio ? (
        <>
          <dt>{copy.resolvedCommand}</dt>
          <dd>
            <code>{server.command}</code>
          </dd>
          {server.args?.length > 0 && (
            <>
              <dt>{copy.argsLabel}</dt>
              <dd>
                <code>{server.args.join(" ")}</code>
              </dd>
            </>
          )}
          {server.cwd && (
            <>
              <dt>{copy.cwdLabel}</dt>
              <dd>
                <code>{server.cwd}</code>
              </dd>
            </>
          )}
          <dt>{copy.envNames}</dt>
          <dd>{names(server.envNames)}</dd>
        </>
      ) : (
        <>
          <dt>{copy.urlLabel}</dt>
          <dd>
            <code>{server.url}</code>
          </dd>
          {usesOAuth(server) ? (
            <>
              <dt>{mcpOAuthCopy.authDetail}</dt>
              <dd>{mcpOAuthCopy.auths.oauth}</dd>
              {server.oauthScope && (
                <>
                  <dt>{mcpOAuthCopy.scopeDetail}</dt>
                  <dd>
                    <code>{server.oauthScope}</code>
                  </dd>
                </>
              )}
            </>
          ) : (
            <>
              <dt>{copy.headerNames}</dt>
              <dd>{names(server.headerNames)}</dd>
            </>
          )}
        </>
      )}
    </dl>
  );
}
