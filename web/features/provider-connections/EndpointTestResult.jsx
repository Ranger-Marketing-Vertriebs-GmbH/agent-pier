import React from "react";
import { connectionCopy } from "../../lib/i18n/messages/connections.js";

export default function EndpointTestResult({ draft, setDraft, result }) {
  const copy = connectionCopy.endpoint;
  return (
    <fieldset className="endpoint-protocols">
      <legend>{copy.protocols}</legend>
      {Object.keys(copy.protocolNames).map((name) => {
        const status = result?.protocols[name];
        const reason = result?.reasons?.[name];
        const unavailable = name === "messages" && !draft.anthropicBaseUrl.trim();
        return (
          <label key={name} className="provider-check">
            <input
              type="checkbox"
              checked={draft.protocols[name] && !unavailable}
              disabled={unavailable}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  protocols: { ...current.protocols, [name]: event.target.checked },
                }))
              }
            />
            <span>
              {copy.protocolNames[name]} · {copy.enables[name]}
              {status && (
                <small data-status={status}>
                  {copy.statuses[status]}
                  {reason ? ` · ${copy.reasons[reason] || reason}` : ""}
                </small>
              )}
            </span>
          </label>
        );
      })}
      {result && !result.listed && <p className="field-description">{copy.notListed}</p>}
      {result?.warnings?.map((warning) => (
        <p key={warning} className="field-description" role="status">
          {copy.warnings[warning] || warning}
        </p>
      ))}
    </fieldset>
  );
}
