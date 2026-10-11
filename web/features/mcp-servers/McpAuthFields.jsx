import React, { useId, useState } from "react";
import Segment from "../../components/Segment.jsx";
import { mcpOAuthCopy as copy } from "../../lib/i18n/messages/mcp-oauth.js";
import { mcpServerCopy } from "../../lib/i18n/messages/mcp-servers.js";

/**
 * How a remote server authenticates: headers (a token) or OAuth. OAuth's optional
 * scope sits in the advanced section; the login itself starts from the server list.
 */
export default function McpAuthFields({ draft, server, set }) {
  const id = useId();
  const oauth = draft.auth === "oauth";
  // Opens once for a stored scope; afterwards the owner opens and closes it.
  const [scopeShown] = useState(() => !!draft.oauthScope);
  return (
    <>
      <div className="mcp-field">
        <span aria-hidden="true">{copy.authLabel}</span>
        <Segment
          label={copy.authLabel}
          value={draft.auth}
          onChange={set("auth")}
          options={["headers", "oauth"].map((value) => ({
            value,
            label: copy.auths[value],
          }))}
        />
        {oauth && <small className="mcp-hint">{copy.oauthHint}</small>}
        {server?.auth === "oauth" && (
          <small className="mcp-hint">{copy.oauthEditHint}</small>
        )}
      </div>
      {oauth && (
        <details className="mcp-advanced" open={scopeShown}>
          <summary>{copy.advanced}</summary>
          <label htmlFor={`${id}-scope`}>
            {copy.scopeLabel}
            <input
              id={`${id}-scope`}
              aria-describedby={`${id}-scope-hint`}
              value={draft.oauthScope}
              maxLength={512}
              autoCapitalize="none"
              spellCheck={false}
              onChange={(event) => set("oauthScope")(event.target.value)}
            />
          </label>
          <small className="mcp-hint" id={`${id}-scope-hint`}>
            {copy.scopeHint}
          </small>
        </details>
      )}
    </>
  );
}

/** Confirms that switching to OAuth deletes the server's stored headers. */
export function OAuthSwitchConfirmation({ names, busy, onConfirm, onCancel }) {
  return (
    <div className="mcp-confirmation" role="alertdialog" aria-label={copy.switchTitle}>
      <strong>{copy.switchTitle}</strong>
      <p>{copy.switchWarning(names.join(", "))}</p>
      <div className="mcp-actions">
        <button
          type="button"
          className="button primary"
          disabled={busy}
          onClick={onConfirm}
        >
          {copy.switchConfirm}
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={onCancel}
        >
          {mcpServerCopy.cancel}
        </button>
      </div>
    </div>
  );
}
