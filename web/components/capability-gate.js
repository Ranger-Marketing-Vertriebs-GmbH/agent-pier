import { capabilityGateCopy as copy } from "../lib/i18n/messages/components.js";

// The rules behind CapabilityGate.jsx (tests/unit/capability-gate.test.js).

/**
 * The capability `name` of a runtime view (`{ name, capabilities }`, the agent's
 * `runtimeInfo`): available unless the runtime says it lacks it, so a view without
 * capabilities (an older server) changes nothing.
 */
export function capabilityOf(runtime, name) {
  const capability = runtime?.capabilities?.[name];
  return capability?.available === false
    ? { available: false, reason: capability.reason || "" }
    : { available: true };
}

/** Why `runtime` lacks capability `name`, in the current language; "" when it has it. */
export function unavailableText(runtime, name) {
  const state = capabilityOf(runtime, name);
  if (state.available) return "";
  const runtimeName = runtime?.name || copy.unknownRuntime;
  const reason = Object.hasOwn(copy.reasons, state.reason)
    ? copy.reasons[state.reason]
    : copy.fallback;
  return reason(runtimeName);
}
