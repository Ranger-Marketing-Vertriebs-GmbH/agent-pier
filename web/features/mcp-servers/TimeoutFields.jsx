import React, { useEffect, useState } from "react";
import { mcpServerCopy as copy } from "../../lib/i18n/messages/mcp-servers.js";
import FieldError from "./FieldError.jsx";
import { timeoutFields } from "./mcp-timeouts.js";

const labels = {
  startupTimeout: () => [copy.startupTimeoutLabel, copy.startupTimeoutHint],
  toolTimeout: () => [copy.toolTimeoutLabel, copy.toolTimeoutHint],
};

/**
 * "Advanced: timeouts": the optional startup and tool timeouts of any server. Opens
 * for stored values and on a refusal and stays open until the owner closes it. Text
 * fields: a number field reports "" for what it cannot parse, which would clear a
 * stored timeout; the server refuses anything that is no whole number instead.
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
  const [open, setOpen] = useState(() =>
    timeoutFields.some((field) => values[field]?.trim()),
  );
  useEffect(() => {
    if (refused) setOpen(true);
  }, [refused]);
  return (
    <details
      className="mcp-advanced"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
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
              type="text"
              inputMode="numeric"
              autoComplete="off"
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
