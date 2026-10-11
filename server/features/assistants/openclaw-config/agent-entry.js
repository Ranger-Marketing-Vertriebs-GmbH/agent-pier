import { personalCapabilities, profileTools } from "../native-capabilities.js";

// One definition for a Gateway start and a live apply: the same assistant and
// runtime state always yield the same managed entry paths. `toolsManaged` and
// `memoryManaged` let a caller whose readiness probes are wired but report "not
// ready" still reset those paths; they default to the readiness itself. `available`
// (see webToolsAvailability) withholds web tools whose browser or provider is absent.
export function agentEntry(
  entry,
  assistant,
  {
    teamsReady,
    nativeReady,
    guardProven,
    agentRuntime,
    toolsManaged = !!(teamsReady || nativeReady),
    memoryManaged = !!nativeReady,
    available = {},
  },
) {
  const next = { ...entry };
  if (toolsManaged)
    next.tools = {
      allow: profileTools(assistant, teamsReady, nativeReady, guardProven, available),
    };
  if (memoryManaged)
    next.memory = {
      search: {
        enabled: !!nativeReady && personalCapabilities(assistant).memory,
        rememberAcrossConversations: false,
      },
    };
  if (agentRuntime)
    next.models = {
      ...entry.models,
      [agentRuntime.model]: {
        ...entry.models?.[agentRuntime.model],
        agentRuntime: { id: agentRuntime.id },
      },
    };
  return next;
}
