import React from "react";
import { mcpCopy as copy } from "../../lib/i18n/messages/mcp.js";
import McpSetup from "./McpSetup.jsx";
import McpConsent from "./McpConsent.jsx";
import McpGrants from "./McpGrants.jsx";
import useMcpResource from "./useMcpResource.js";
import "./mcp.css";
export default function McpSettings({ route, navigate }) {
  const result = useMcpResource("/mcp-access");
  return (
    <div className="page mcp-page">
      <h1>{copy.title}</h1>
      <p className="mcp-introduction">{copy.introduction}</p>
      {result.error ? (
        <section className="mcp-card">
          <p role="alert">{result.error}</p>
          <button className="button" onClick={result.reload}>
            {copy.retry}
          </button>
        </section>
      ) : !result.data ? (
        <p role="status">{copy.loading}</p>
      ) : (
        <>
          {route.mcpAuthorization ? (
            <McpConsent
              key={route.mcpAuthorization}
              id={route.mcpAuthorization}
              config={result.data}
            />
          ) : null}
          <McpSetup
            config={result.data}
            cli={route.mcpCli || "codex"}
            navigate={navigate}
          />
          {!route.mcpAuthorization && (
            <McpGrants
              resources={result.data.resources}
              page={route.mcpPage || 1}
              navigate={navigate}
            />
          )}
        </>
      )}
    </div>
  );
}
