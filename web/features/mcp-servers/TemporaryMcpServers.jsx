import React from "react";
import { mcpServerCopy as copy } from "../../lib/i18n/messages/mcp-servers.js";
import "./mcp-servers.css";

/** The servers a lead agent granted to a temporary member; the owner cannot change them. */
export default function TemporaryMcpServers({ servers = [] }) {
  return (
    <section className="mcp-servers" aria-label={copy.temporaryTitle}>
      <h2>{copy.temporaryTitle}</h2>
      <p className="mcp-hint">{copy.temporaryNote}</p>
      {servers.length ? (
        <ul className="mcp-list">
          {servers.map((server) => (
            <li key={server.name}>
              {server.name}{" "}
              {server.stdio && (
                <span className="mcp-badge mcp-badge-warn" title={copy.stdioMarker}>
                  {copy.stdioMarker}
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mcp-hint">{copy.temporaryNone}</p>
      )}
    </section>
  );
}
