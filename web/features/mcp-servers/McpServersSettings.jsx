import React, { useCallback, useEffect, useState } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { mcpServerCopy as copy } from "../../lib/i18n/messages/mcp-servers.js";
import { assistantApi } from "../assistants/assistant-api.js";
import McpServerForm from "./McpServerForm.jsx";
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
          <dt>{copy.headerNames}</dt>
          <dd>{names(server.headerNames)}</dd>
        </>
      )}
    </dl>
  );
}

/** The owner's central MCP servers: list, add, edit and remove. */
export default function McpServersSettings() {
  const [servers, setServers] = useState(null),
    [error, setError] = useState(""),
    [editing, setEditing] = useState(undefined),
    [removing, setRemoving] = useState(null),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
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
  async function remove(server) {
    setBusy(true);
    try {
      const result = await assistantApi.removeMcpServer(server.id);
      setNotice(result?.pending ? copy.pendingNotice : "");
      setRemoving(null);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="mcp-servers" aria-label={copy.title}>
      <h2>{copy.title}</h2>
      <p className="mcp-hint">{copy.description}</p>
      <ErrorMessage error={error} />
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
            </div>
            <ServerDetails server={server} />
            {removing === server.id ? (
              <div className="mcp-confirmation" role="alertdialog">
                <p>{copy.confirmRemove(server.name)}</p>
                <div className="mcp-actions">
                  <button
                    type="button"
                    className="button primary"
                    disabled={busy}
                    onClick={() => remove(server)}
                  >
                    {copy.confirmRemoveAction}
                  </button>
                  <button
                    type="button"
                    className="button secondary"
                    disabled={busy}
                    onClick={() => setRemoving(null)}
                  >
                    {copy.cancel}
                  </button>
                </div>
              </div>
            ) : (
              <div className="mcp-actions">
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
            setNotice(saved?.pending ? copy.pendingNotice : "");
            setEditing(undefined);
            await load();
          }}
        />
      )}
    </section>
  );
}
