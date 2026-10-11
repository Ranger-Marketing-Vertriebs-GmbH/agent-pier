import React, { useEffect, useState } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { mcpServerCopy as copy } from "../../lib/i18n/messages/mcp-servers.js";
import { assistantApi } from "../assistants/assistant-api.js";
import StdioConfirmation from "./StdioConfirmation.jsx";
import { stdioConfirmationRequired } from "./stdio-confirmation.js";
import "./mcp-servers.css";

/** Which central MCP servers a personal agent or permanent member can use. */
export default function AgentMcpServers({ assistant, refresh, navigate }) {
  const bound = assistant.mcpServers || [];
  const [servers, setServers] = useState(null),
    [selected, setSelected] = useState(bound),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [confirming, setConfirming] = useState(false);
  const boundKey = bound.join("\n");
  useEffect(() => {
    setSelected(boundKey ? boundKey.split("\n") : []);
  }, [boundKey]);
  useEffect(() => {
    let live = true;
    assistantApi
      .mcpServers()
      .then((list) => live && setServers(list))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, []);
  const toggle = (id, on) => {
    setConfirming(false);
    setNotice("");
    setSelected((current) =>
      on ? [...current, id] : current.filter((value) => value !== id),
    );
  };
  async function save(confirmStdio = false) {
    setBusy(true);
    setError("");
    try {
      await assistantApi.update(assistant.id, {
        revision: assistant.revision,
        mcpServers: selected,
        ...(confirmStdio ? { confirmStdio: true } : {}),
      });
      setConfirming(false);
      setNotice(copy.agentSaved);
      await refresh();
    } catch (e) {
      if (stdioConfirmationRequired(e)) setConfirming(true);
      else setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="mcp-servers" aria-label={copy.agentTitle}>
      <h2>{copy.agentTitle}</h2>
      <p className="mcp-hint">{copy.agentDescription}</p>
      <ErrorMessage error={error} />
      {servers && !servers.length ? (
        <>
          <p className="mcp-hint">{copy.agentNone}</p>
          {navigate && (
            <div className="mcp-actions">
              <button
                type="button"
                className="button secondary"
                onClick={() => navigate({ view: "accounts" })}
              >
                {copy.agentOpenAccounts}
              </button>
            </div>
          )}
        </>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <fieldset className="mcp-agent-options">
            <legend className="mcp-hint">{copy.agentServersLegend}</legend>
            {(servers || []).map((server) => (
              <label key={server.id}>
                <input
                  type="checkbox"
                  checked={selected.includes(server.id)}
                  onChange={(event) => toggle(server.id, event.target.checked)}
                />
                <span>
                  {server.name}{" "}
                  {server.transport === "stdio" && (
                    <span className="mcp-badge mcp-badge-warn">{copy.stdioBadge}</span>
                  )}
                </span>
              </label>
            ))}
          </fieldset>
          {confirming && (
            <StdioConfirmation
              binding
              busy={busy}
              onConfirm={() => save(true)}
              onCancel={() => setConfirming(false)}
            />
          )}
          {notice && (
            <p role="status" className="mcp-hint">
              {notice}
            </p>
          )}
          <div className="mcp-actions">
            <button className="button primary" disabled={busy || !servers}>
              {copy.agentSave}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
