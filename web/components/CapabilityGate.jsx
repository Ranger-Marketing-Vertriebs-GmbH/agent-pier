import React, { useId } from "react";
import { unavailableText } from "./capability-gate.js";
import "./capability-gate.css";

/**
 * A control that needs capability `capability` of the agent's runtime. While the
 * runtime offers it, the children render unchanged. Otherwise they stay visible but
 * disabled, below the translated reason (ADR 0006: never silently hidden): form
 * controls through the disabled fieldset, links and buttons by swallowing clicks.
 */
export default function CapabilityGate({ runtime, capability, children }) {
  const id = useId();
  const reason = unavailableText(runtime, capability);
  if (!reason) return children;
  const stop = (event) => {
    event.preventDefault();
    event.stopPropagation();
  };
  return (
    <fieldset
      className="capability-gate"
      disabled
      aria-describedby={id}
      data-capability={capability}
    >
      <p id={id} className="field-description capability-gate-reason" role="note">
        {reason}
      </p>
      <div className="capability-gate-body" aria-disabled="true" onClickCapture={stop}>
        {children}
      </div>
    </fieldset>
  );
}
