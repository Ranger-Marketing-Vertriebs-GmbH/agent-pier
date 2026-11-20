import React from "react";
import { connectionCopy } from "../../lib/i18n/messages/connections.js";
import { focusContextField } from "./context-focus.js";
import { missingContextModels } from "./endpoint-draft.js";

/**
 * Names the manual models (Azure deployments) that still need a context size, each with
 * a button to its field. `asked`: a save was held back for them, so it is an alert.
 */
export default function ContextNeeded({ draft, asked = false }) {
  const copy = connectionCopy.endpoint;
  const missing = missingContextModels(draft);
  if (!missing.length) return null;
  return (
    <div className="endpoint-context-needed" role={asked ? "alert" : "status"}>
      <p className="field-description">{copy.contextNeeded(missing.length)}</p>
      <div className="endpoint-context-needed-actions">
        {missing.slice(0, 5).map((model) => (
          <button
            key={model.modelId}
            type="button"
            className="button secondary compact"
            onClick={() => focusContextField(model.modelId)}
          >
            {copy.setContext(model.modelId)}
          </button>
        ))}
      </div>
      {asked && <p className="field-description">{copy.contextAsk}</p>}
    </div>
  );
}
