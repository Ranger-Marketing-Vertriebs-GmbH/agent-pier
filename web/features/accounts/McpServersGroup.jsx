import React, { useEffect, useId, useRef, useState } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import GroupLabel from "../../components/GroupLabel.jsx";
import ListCard from "../../components/ListCard.jsx";
import ListRow from "../../components/ListRow.jsx";
import { routePath } from "../../app/routes.js";
import { mcpCliCopy as cliCopy } from "../../lib/i18n/messages/mcp-cli.js";
import { mcpServerCopy as copy } from "../../lib/i18n/messages/mcp-servers.js";
import { accountsHubCopy as hubCopy } from "../../lib/i18n/messages/accounts.js";
import McpFeedback from "../mcp-servers/McpFeedback.jsx";
import { McpOAuthResultBanner } from "../mcp-servers/McpOAuthLogin.jsx";
import AddLabel from "./AddLabel.jsx";
import { itemRoute } from "./accounts-items.js";
import { usageEntry, usageValue } from "./account-usage-view.js";
import "../mcp-servers/mcp-servers.css";
import "../mcp-servers/mcp-cli.css";

/**
 * The central MCP servers: restart note, the OAuth result a login brought back, the
 * list's notices (unless an open server shows them, `feedback`), one row per server
 * and the CLI finds. The extensions link and an
 * OAuth result scroll this group into view.
 */
export default function McpServersGroup({
  servers,
  error,
  feedback = true,
  notice,
  oauth,
  oauthResult,
  focus,
  usage,
  selected,
  navigate,
}) {
  const id = useId();
  const ref = useRef(null);
  const [resultShown, setResultShown] = useState(true);
  useEffect(() => {
    if (!oauthResult) return;
    setResultShown(true);
    ref.current?.scrollIntoView?.({ block: "start" });
  }, [oauthResult]);
  useEffect(() => {
    if (focus) ref.current?.scrollIntoView?.({ block: "start" });
  }, [focus]);
  const open = (item) => {
    const route = itemRoute("mcp-servers", item);
    return { href: routePath(route), onClick: () => navigate(route) };
  };
  // The open entry: highlighted and announced as the current page.
  const current = (item) => {
    const shown = selected?.section === "mcp-servers" && selected.item === item;
    return { current: shown, className: shown ? "is-selected" : "" };
  };
  return (
    <section className="accounts-group" aria-labelledby={`${id}-label`} ref={ref}>
      <GroupLabel
        id={`${id}-label`}
        hint={copy.description}
        action={{
          label: <AddLabel text={copy.add} />,
          onClick: () => navigate(itemRoute("mcp-servers", "new")),
        }}
      >
        {copy.title}
      </GroupLabel>
      <p className="accounts-note">{cliCopy.restartNote}</p>
      {oauthResult && resultShown && (
        <McpOAuthResultBanner
          result={oauthResult}
          servers={servers}
          onDismiss={() => setResultShown(false)}
        />
      )}
      <ErrorMessage error={error} />
      {feedback && <McpFeedback oauth={oauth} notice={notice} />}
      {servers && !servers.length && <p className="accounts-note">{copy.empty}</p>}
      <ListCard labelledBy={`${id}-label`}>
        {(servers || []).map((server) => (
          <ListRow
            key={server.id}
            label={server.name}
            sub={
              <>
                {copy.transports[server.transport]}
                {server.transport === "stdio" && (
                  <span className="list-row-pill">{copy.stdioBadge}</span>
                )}
              </>
            }
            value={usageValue(usageEntry(usage, "mcp-server", server.id))}
            {...current(server.id)}
            {...open(server.id)}
          />
        ))}
        <ListRow
          label={cliCopy.foundTitle}
          sub={hubCopy.cliFindsSub}
          {...current("cli-finds")}
          {...open("cli-finds")}
        />
      </ListCard>
    </section>
  );
}
