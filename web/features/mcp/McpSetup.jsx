import React, { useState } from "react";
import { mcpCopy as copy } from "../../lib/i18n/messages/mcp.js";
import { clients, mcpEndpoint, setupSteps } from "./setup.js";
function CopyBlock({ label, value }) {
  const [status, setStatus] = useState("");
  const copyValue = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setStatus(copy.copied);
    } catch {
      setStatus(copy.copyFailed);
    }
  };
  return (
    <div className="mcp-command">
      <header>
        <strong>{label}</strong>
        <button className="button" onClick={copyValue} aria-label={copy.copy(label)}>
          {copy.copy(label)}
        </button>
      </header>
      <pre tabIndex={0}>
        <code>{value}</code>
      </pre>
      {status && <p role="status">{status}</p>}
    </div>
  );
}
export default function McpSetup({ config, cli, navigate }) {
  const endpoint = config.available && mcpEndpoint(config.mcpUrl);
  const local = endpoint && new URL(endpoint).protocol === "http:";
  return (
    <section className="mcp-card" aria-labelledby="mcp-setup-title">
      <h2 id="mcp-setup-title">{copy.setup}</h2>
      <p>{local ? copy.localPrerequisites : copy.prerequisites}</p>
      {!endpoint ? (
        <div className="mcp-notice">
          <h3>{copy.unavailable}</h3>
          <p>{copy.unavailableHelp}</p>
        </div>
      ) : (
        <>
          <CopyBlock
            label={local ? copy.localEndpoint : copy.endpoint}
            value={endpoint}
          />
          <div className="mcp-tabs" role="tablist" aria-label={copy.setup}>
            {Object.entries(clients).map(([id, client]) => (
              <button
                key={id}
                role="tab"
                id={`mcp-tab-${id}`}
                aria-controls="mcp-cli-panel"
                aria-selected={cli === id}
                tabIndex={cli === id ? 0 : -1}
                onClick={() => navigate({ mcpCli: id })}
                onKeyDown={(event) => {
                  const ids = Object.keys(clients),
                    index = ids.indexOf(id);
                  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
                    return;
                  event.preventDefault();
                  const next =
                    event.key === "Home"
                      ? ids[0]
                      : event.key === "End"
                        ? ids.at(-1)
                        : ids[
                            (index + (event.key === "ArrowRight" ? 1 : ids.length - 1)) %
                              ids.length
                          ];
                  navigate({ mcpCli: next });
                  document.getElementById(`mcp-tab-${next}`)?.focus();
                }}
              >
                {client.name}
              </button>
            ))}
          </div>
          <div id="mcp-cli-panel" role="tabpanel" aria-labelledby={`mcp-tab-${cli}`}>
            <p>{copy[`${cli}Hint`]}</p>
            <p>{copy.connectionHint}</p>
            {setupSteps(cli, endpoint).map(([id, value]) => (
              <CopyBlock
                key={`${cli}-${id}`}
                label={cli === "codex" && id === "login" ? copy.retryLogin : copy[id]}
                value={value}
              />
            ))}
            {cli === "opencode" && <p>{copy.opencodeRemove}</p>}
            <p>{copy.revokeHint}</p>
            <a href={clients[cli].docs} target="_blank" rel="noreferrer">
              {copy.docs} · {clients[cli].name}
            </a>
          </div>
        </>
      )}
    </section>
  );
}
