import React from "react";
import CapabilityGate from "../../../components/CapabilityGate.jsx";
import { surfaceCapabilities } from "../runtime-capabilities.js";

/** A settings surface of `assistant` that needs its runtime's capability for `surface`. */
export default function AgentCapability({ assistant, surface, children }) {
  return (
    <CapabilityGate
      runtime={assistant?.runtimeInfo}
      capability={surfaceCapabilities[surface]}
    >
      {children}
    </CapabilityGate>
  );
}
