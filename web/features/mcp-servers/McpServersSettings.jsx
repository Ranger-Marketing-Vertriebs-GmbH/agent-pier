import React, { useCallback, useEffect, useRef, useState } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { mcpOAuthCopy } from "../../lib/i18n/messages/mcp-oauth.js";
import { mcpServerCopy as copy } from "../../lib/i18n/messages/mcp-servers.js";
import { assistantApi } from "../assistants/assistant-api.js";
import { useAlertDialogFocus } from "../../components/useAlertDialogFocus.js";
import McpServerForm from "./McpServerForm.jsx";
import { McpOAuthActions, McpOAuthResultBanner, useMcpOAuth } from "./McpOAuthLogin.jsx";
import McpOAuthStatus, { McpOAuthStatusHint, usesOAuth } from "./McpOAuthStatus.jsx";
import "./mcp-servers.css";

const names = (list) => (list.length ? list.join(", ") : copy.noNames);

function ServerDetails({ server }) {
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

/** A saved change's notices: a pending apply and a deferred OAuth logout. */
const savedNotice = (saved) =>
  [
    saved?.pending ? copy.pendingNotice : "",
    saved?.oauthWarning?.code === "oauth-logout-deferred"
      ? mcpOAuthCopy.logoutDeferred
      : "",
  ]
    .filter(Boolean)
    .join(" ");

/** Asks before a server is removed; focus starts on the safe choice. */
function RemoveConfirmation({ server, busy, onConfirm, onCancel }) {
  const focus = useAlertDialogFocus(onCancel);
  return (
    <div {...focus} className="mcp-confirmation" role="alertdialog">
      <p>{copy.confirmRemove(server.name)}</p>
      <div className="mcp-actions">
        <button
          type="button"
          className="button primary"
          disabled={busy}
          onClick={onConfirm}
        >
          {copy.confirmRemoveAction}
        </button>
        <button
          type="button"
          className="button secondary"
          data-autofocus
          disabled={busy}
          onClick={onCancel}
        >
          {copy.cancel}
        </button>
      </div>
    </div>
  );
}

/**
 * The owner's central MCP servers: list, add, edit and remove, and log in to OAuth
 * servers. `oauthResult` is the result a login's callback brought back.
 */
export default function McpServersSettings({ oauthResult }) {
  const [servers, setServers] = useState(null),
    [error, setError] = useState(""),
    [editing, setEditing] = useState(undefined),
    [removing, setRemoving] = useState(null),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [resultShown, setResultShown] = useState(true);
  const section = useRef(null);
  const load = useCallback(async () => {
    try {
      setServers(await assistantApi.mcpServers());
      setError("");
    } catch (e) {
      setError(e.message);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  const oauth = useMcpOAuth({ reload: load, notify: setNotice });
  // The callback lands on the Accounts page; its result belongs in view.
  useEffect(() => {
    if (!oauthResult) return;
    setResultShown(true);
    section.current?.scrollIntoView?.({ block: "start" });
  }, [oauthResult]);
  async function remove(server) {
    setBusy(true);
    try {
      const result = await assistantApi.removeMcpServer(server.id);
      setNotice(savedNotice(result));
      setRemoving(null);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="mcp-servers" aria-label={copy.title} ref={section}>
      <h2>{copy.title}</h2>
      <p className="mcp-hint">{copy.description}</p>
      {oauthResult && resultShown && (
        <McpOAuthResultBanner
          result={oauthResult}
          servers={servers}
          onDismiss={() => setResultShown(false)}
        />
      )}
      <ErrorMessage error={error} />
      {oauth.originBlocked && (
        <p role="status" className="mcp-notice">
          {mcpOAuthCopy.originBlocked}
        </p>
      )}
      {notice && (
        <p role="status" className="mcp-hint">
          {notice}
        </p>
      )}
      {servers && !servers.length && <p className="mcp-hint">{copy.empty}</p>}
      <ul className="mcp-list">
        {(servers || []).map((server) => (
          <li key={server.id} className="mcp-item">
            <div className="mcp-item-head">
              <strong>{server.name}</strong>
              <span className="mcp-badge">{copy.transports[server.transport]}</span>
              {server.transport === "stdio" && (
                <span className="mcp-badge mcp-badge-warn">{copy.stdioBadge}</span>
              )}
              {usesOAuth(server) && <McpOAuthStatus server={server} />}
            </div>
            <ServerDetails server={server} />
            {usesOAuth(server) && <McpOAuthStatusHint server={server} />}
            {removing === server.id ? (
              <RemoveConfirmation
                server={server}
                busy={busy}
                onConfirm={() => remove(server)}
                onCancel={() => setRemoving(null)}
              />
            ) : (
              <div className="mcp-actions">
                {usesOAuth(server) && <McpOAuthActions server={server} oauth={oauth} />}
                <button
                  type="button"
                  className="button secondary"
                  aria-label={copy.editNamed(server.name)}
                  onClick={() => setEditing(server)}
                >
                  {copy.edit}
                </button>
                <button
                  type="button"
                  className="button secondary"
                  aria-label={copy.removeNamed(server.name)}
                  data-focus-key={`remove-${server.id}`}
                  onClick={() => setRemoving(server.id)}
                >
                  {copy.remove}
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
      <div className="mcp-actions">
        <button type="button" className="button primary" onClick={() => setEditing(null)}>
          {copy.add}
        </button>
      </div>
      {editing !== undefined && (
        <McpServerForm
          key={editing?.id || "new"}
          server={editing}
          close={() => setEditing(undefined)}
          onSaved={async (saved) => {
            setNotice(savedNotice(saved));
            setEditing(undefined);
            await load();
          }}
        />
      )}
    </section>
  );
}
