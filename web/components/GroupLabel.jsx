import React from "react";
import { InfoHintButton, InfoHintText, useInfoHint } from "./InfoHint.jsx";

export default function GroupLabel({
  children,
  as: Heading = "h2",
  id,
  hint,
  hintLabel,
  action,
}) {
  const info = useInfoHint();
  return (
    <div className="group-label">
      <div className="group-label-row">
        <Heading id={id}>{children}</Heading>
        {hint && <InfoHintButton hint={info} label={hintLabel} />}
        {action && (
          <button
            type="button"
            className="group-label-action"
            onClick={action.onClick}
            disabled={action.disabled}
          >
            {action.label}
          </button>
        )}
      </div>
      {hint && <InfoHintText hint={info}>{hint}</InfoHintText>}
    </div>
  );
}
