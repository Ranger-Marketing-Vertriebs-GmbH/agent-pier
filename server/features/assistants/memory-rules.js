import { assistantProblem } from "./assistant-validation.js";
import { dreamingCovered } from "./dreaming-service.js";
import { webCapabilityKeys } from "./native-capabilities.js";
import { lacksMemory } from "./proactivity-changes.js";

/**
 * Why a save may not leave the agent without memory, as a message key, or null. While
 * dreaming is on every permanent agent keeps its memory (dreaming-service.js); check-ins
 * need it as well (proactivity-changes.js).
 */
export function memoryRequirement(current, patch, { dreaming }) {
  if (dreaming && dreamingCovered(current) && patch.capabilities?.memory === false)
    return "dreamingMemoryRequired";
  return lacksMemory(current, patch) ? "heartbeatMemoryRequired" : null;
}

/**
 * A new agent remembers unless its body switches memory off. Capabilities that are not
 * an object stay as sent, for the definition check to refuse.
 */
export function withDefaultMemory(input) {
  const c = input.capabilities;
  if (c === undefined)
    return { ...input, capabilities: { memory: true, reminders: false } };
  if (!c || typeof c !== "object" || Array.isArray(c) || "memory" in c) return input;
  return { ...input, capabilities: { ...c, memory: true } };
}

/**
 * The capabilities a new agent starts with: memory on by default, and refused off while
 * dreaming is on. Web capabilities need the Gateway sections an update can apply with
 * the owner's confirmation; a new agent starts with them off.
 */
export function newCapabilities(input, dreaming) {
  const capabilities = { ...withDefaultMemory(input).capabilities };
  for (const key of webCapabilityKeys) if (key in capabilities) capabilities[key] = false;
  if (dreaming && capabilities.memory === false)
    throw assistantProblem("dreamingMemoryRequired", 409);
  return capabilities;
}
