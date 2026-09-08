import React, { useEffect, useState } from "react";
import api from "../../lib/api.js";
import { mcpCopy as copy } from "../../lib/i18n/de/mcp.js";
import useMcpResource from "./useMcpResource.js";
export const resourceFields = {
  projectIds: "projects",
  accountIds: "accounts",
  connectionIds: "connections",
};
export const formatDate = (value) =>
  value ? new Date(value).toLocaleString("de-DE") : copy.neverUsed;
function ConsentForm({ authorization, config }) {
  const [selection, setSelection] = useState({
    scopes: authorization.requestedScopes.filter((scope) =>
      ["catalog:read", "runs:read"].includes(scope),
    ),
    projectIds: [],
    accountIds: [],
    connectionIds: [],
  });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [returning, setReturning] = useState(false);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);
  const expired = authorization.expiresAt <= now;
  const toggle = (field, id) =>
    setSelection((current) => ({
      ...current,
      [field]: current[field].includes(id)
        ? current[field].filter((value) => value !== id)
        : [...current[field], id],
    }));
  const decide = async (decision) => {
    if (busy || returning) return;
    setBusy(true);
    setError("");
    try {
      const result = await api(
        `/mcp-access/authorizations/${encodeURIComponent(authorization.id)}/${decision}`,
        "POST",
        decision === "approve" ? selection : {},
      );
      const redirect = new URL(result.redirectUrl);
      if (
        !["http:", "https:"].includes(redirect.protocol) ||
        redirect.username ||
        redirect.password
      )
        throw new Error(copy.invalidRedirect);
      setReturning(true);
      window.location.assign(redirect.href);
    } catch (cause) {
      setError(cause.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <p>{copy.consentHelp}</p>
      <div className="mcp-client">
        <strong>{authorization.client.name}</strong>
        <dl>
          <dt>{copy.clientId}</dt>
          <dd>{authorization.client.id}</dd>
          <dt>{copy.expires}</dt>
          <dd>{formatDate(authorization.expiresAt)}</dd>
          <dt>{copy.callback}</dt>
          <dd>
            {authorization.client.redirectUris.map((uri) => (
              <div key={uri}>{uri}</div>
            ))}
          </dd>
        </dl>
      </div>
      {error && (
        <p role="alert" className="mcp-notice">
          {error}
        </p>
      )}
      {expired && (
        <p role="alert" className="mcp-notice">
          {copy.expiredRequest}
        </p>
      )}
      {returning && <p role="status">{copy.returning}</p>}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void decide("approve");
        }}
      >
        <fieldset disabled={busy || expired || returning} className="mcp-options">
          <legend>{copy.scopes}</legend>
          {authorization.requestedScopes
            .filter((scope) => config.scopes.includes(scope))
            .map((scope) => (
              <label
                key={scope}
                className={`mcp-check ${scope === "runs:publish" ? "mcp-publishing" : ""}`}
              >
                <input
                  type="checkbox"
                  aria-label={copy.scopeLabels[scope] || scope}
                  aria-describedby={
                    scope === "runs:publish" ? "mcp-publishing-help" : undefined
                  }
                  checked={selection.scopes.includes(scope)}
                  onChange={() => toggle("scopes", scope)}
                />
                <span>
                  {copy.scopeLabels[scope] || scope}
                  {scope === "runs:publish" && (
                    <small id="mcp-publishing-help">{copy.publishingHelp}</small>
                  )}
                </span>
              </label>
            ))}
        </fieldset>
        <h3>{copy.resources}</h3>
        <p>{copy.resourceHelp}</p>
        <div className="mcp-resource-grid">
          {Object.entries(resourceFields).map(([field, group]) => (
            <fieldset
              key={field}
              disabled={busy || expired || returning}
              className="mcp-options"
            >
              <legend>{copy[group]}</legend>
              {!config.resources[group].length && <p>{copy.none}</p>}
              {config.resources[group].map((resource) => (
                <label key={resource.id} className="mcp-check">
                  <input
                    type="checkbox"
                    aria-label={resource.name}
                    aria-describedby={`mcp-${field}-${resource.id}`}
                    checked={selection[field].includes(resource.id)}
                    onChange={() => toggle(field, resource.id)}
                  />
                  <span>
                    {resource.name}
                    <small id={`mcp-${field}-${resource.id}`}>{resource.id}</small>
                  </span>
                </label>
              ))}
            </fieldset>
          ))}
        </div>
        {!selection.scopes.length && <p>{copy.noScopes}</p>}
        <div className="mcp-actions">
          <button
            className="button primary"
            type="submit"
            disabled={busy || expired || returning || !selection.scopes.length}
          >
            {copy.approve}
          </button>
          <button
            className="button"
            type="button"
            disabled={busy || expired || returning}
            onClick={() => void decide("deny")}
          >
            {copy.deny}
          </button>
        </div>
      </form>
    </>
  );
}
export default function McpConsent({ id, config }) {
  const request = useMcpResource(`/mcp-access/authorizations/${encodeURIComponent(id)}`);
  return (
    <section className="mcp-card mcp-consent" aria-labelledby="mcp-consent-title">
      <h2 id="mcp-consent-title">{copy.consent}</h2>
      {request.error ? (
        <>
          <p role="alert">{request.error}</p>
          <button className="button" onClick={request.reload}>
            {copy.retry}
          </button>
        </>
      ) : request.data ? (
        <ConsentForm key={id} authorization={request.data} config={config} />
      ) : (
        <p role="status">{copy.loading}</p>
      )}
    </section>
  );
}
