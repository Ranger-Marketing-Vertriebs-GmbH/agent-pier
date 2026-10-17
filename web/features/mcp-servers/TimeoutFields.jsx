import React, { useState } from "react";
import { mcpServerCopy as copy } from "../../lib/i18n/messages/mcp-servers.js";
import FieldError from "./FieldError.jsx";
import { timeoutBounds, timeoutFields } from "./mcp-timeouts.js";

const labels = {
  startupTimeout: () => [copy.startupTimeoutLabel, copy.startupTimeoutHint],
  toolTimeout: () => [copy.toolTimeoutLabel, copy.toolTimeoutHint],
};

/**
 * "Advanced: timeouts": the optional startup and tool timeouts of any server. Opens
 * once for stored values or a refusal; afterwards the owner opens and closes it.
 */
export default function TimeoutFields({
  formId,
  values,
  set,
  errorOf,
  describe,
  errorId,
}) {
  const refused = timeoutFields.some((field) => errorOf(field));
  const [shown] = useState(() => timeoutFields.some((field) => values[field]?.trim()));
  return (
    <details className="mcp-advanced" open={shown || refused || undefined}>
      <summary>{copy.timeoutsTitle}</summary>
      <small className="mcp-hint">{copy.timeoutsHint}</small>
      {timeoutFields.map((field) => {
        const [label, hint] = labels[field]();
        const id = `${formId}-${field}`;
        const described = describe(field);
        return (
          <label key={field} htmlFor={id}>
            {label}
            <input
              id={id}
              type="number"
              inputMode="numeric"
              min={timeoutBounds[field].min}
              max={timeoutBounds[field].max}
              step={1}
              value={values[field] ?? ""}
              {...described}
              aria-describedby={[described["aria-describedby"], `${id}-hint`]
                .filter(Boolean)
                .join(" ")}
              onChange={(event) => set(field)(event.target.value)}
            />
            <small className="mcp-hint" id={`${id}-hint`}>
              {hint}
            </small>
            <FieldError id={errorId} text={errorOf(field)} />
          </label>
        );
      })}
    </details>
  );
}
