import React, { useState } from "react";
import api from "../../lib/api.js";
import { mcpCopy as copy } from "../../lib/i18n/messages/mcp.js";
import { formatDate, resourceFields } from "./McpConsent.jsx";
import useMcpResource from "./useMcpResource.js";
function Grant({ grant, resources, reload }) {
  const [confirm, setConfirm] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const revoke = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await api(`/mcp-access/grants/${encodeURIComponent(grant.id)}/revoke`, "POST", {});
      reload();
    } catch (cause) {
      setError(cause.message);
    } finally {
      setBusy(false);
    }
  };
  const status = grant.revokedAt
    ? "revoked"
    : grant.expiresAt <= Date.now()
      ? "expired"
      : "active";
  return (
    <article className="mcp-grant">
      <header>
        <h3>{grant.client.name}</h3>
        <span className={`mcp-badge mcp-${status}`}>{copy[status]}</span>
      </header>
      <dl>
        <dt>{copy.created}</dt>
        <dd>{formatDate(grant.createdAt)}</dd>
        <dt>{copy.expires}</dt>
        <dd>{formatDate(grant.expiresAt)}</dd>
        <dt>{copy.lastUsed}</dt>
        <dd>{formatDate(grant.lastUsedAt)}</dd>
      </dl>
      <h4>{copy.scopes}</h4>
      <ul className="mcp-scope-list">
        {grant.scopes.map((scope) => (
          <li key={scope}>{copy.scopeLabels[scope] || scope}</li>
        ))}
      </ul>
      <dl>
        {Object.entries(resourceFields).map(([field, group]) => (
          <React.Fragment key={field}>
            <dt>{copy[group]}</dt>
            <dd>
              {grant[field]
                .map(
                  (id) =>
                    resources[group].find((resource) => resource.id === id)?.name || id,
                )
                .join(", ") || copy.none}
            </dd>
          </React.Fragment>
        ))}
      </dl>
      {error && <p role="alert">{error}</p>}
      {status === "active" &&
        (confirm ? (
          <div className="mcp-notice">
            <p>{copy.revokeWarning}</p>
            <div className="mcp-actions">
              <button
                className="button danger"
                disabled={busy}
                onClick={() => void revoke()}
              >
                {copy.confirmRevoke}
              </button>
              <button
                className="button"
                disabled={busy}
                onClick={() => setConfirm(false)}
              >
                {copy.cancel}
              </button>
            </div>
          </div>
        ) : (
          <button className="button" onClick={() => setConfirm(true)}>
            {copy.revoke}
          </button>
        ))}
    </article>
  );
}
export default function McpGrants({ resources, page, navigate }) {
  const result = useMcpResource(`/mcp-access/grants?offset=${(page - 1) * 20}&limit=20`);
  return (
    <section className="mcp-card" aria-labelledby="mcp-grants-title">
      <h2 id="mcp-grants-title">{copy.grants}</h2>
      {result.error ? (
        <>
          <p role="alert">{result.error}</p>
          <button className="button" onClick={result.reload}>
            {copy.retry}
          </button>
        </>
      ) : !result.data ? (
        <p role="status">{copy.loading}</p>
      ) : (
        <>
          {!result.data.grants.length && <p>{copy.noGrants}</p>}
          <div className="mcp-grants">
            {result.data.grants.map((grant) => (
              <Grant
                key={grant.id}
                grant={grant}
                resources={resources}
                reload={result.reload}
              />
            ))}
          </div>
          {result.data.total > 20 || page > 1 ? (
            <nav className="mcp-pagination" aria-label={copy.grants}>
              <button
                className="button"
                disabled={page <= 1}
                onClick={() => navigate({ mcpPage: page - 1 })}
              >
                {copy.previous}
              </button>
              <span>{copy.page(page, result.data.total)}</span>
              <button
                className="button"
                disabled={page * 20 >= result.data.total}
                onClick={() => navigate({ mcpPage: page + 1 })}
              >
                {copy.next}
              </button>
            </nav>
          ) : null}
        </>
      )}
    </section>
  );
}
