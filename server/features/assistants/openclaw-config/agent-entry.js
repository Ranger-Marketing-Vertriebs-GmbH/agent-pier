import {
  personalCapabilities,
  personalShell,
  profileTools,
} from "../native-capabilities.js";
import { agentExec } from "./shell.js";

// One definition for a Gateway start and a live apply: the same assistant and
// runtime state always yield the same managed entry paths. `toolsManaged` and
// `memoryManaged` let a caller whose readiness probes are wired but report "not
// ready" still reset those paths; they default to the readiness itself. `available`
// (see webToolsAvailability) withholds web tools whose browser or provider is absent;
// `mcpTools` are the agent's MCP globs the Gateway was started with (mcpSections).
// `pathPrepend` is the owner's login PATH for an agent with shell (see shell.js); the
// exec override accompanies exec in the tool list, so both follow native readiness.
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
    mcpTools = [],
    pathPrepend = [],
  },
) {
  const next = { ...entry };
  const exec = nativeReady ? agentExec(personalShell(assistant), pathPrepend) : undefined;
  if (toolsManaged)
    next.tools = {
      allow: profileTools(
        assistant,
        teamsReady,
        nativeReady,
        guardProven,
        available,
        mcpTools,
      ),
      ...(exec && { exec }),
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
