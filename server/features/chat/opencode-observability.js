import {
  list,
  object,
  text,
  timestamp,
  emptyContext,
  inputTokens,
  contextValue,
  agentStatus,
  putAgent,
} from "./observability-values.js";
export function observeOpenCode(exported) {
  let context = emptyContext();
  const agents = new Map();
  for (const message of list(exported?.messages)) {
    const info = object(message?.info),
      at = timestamp(info.time?.completed ?? info.time?.created);
    if (list(message?.parts).some((part) => part?.type === "compaction"))
      context = {
        ...context,
        usedTokens: null,
        remainingPercent: null,
        source: null,
        observedAt: at,
      };
    if (info.role !== "assistant") continue;
    const usage = object(info.tokens),
      used = inputTokens(usage.input, usage.cache?.read, usage.cache?.write);
    if (
      !info.summary &&
      !info.error &&
      (info.time?.completed !== undefined || used > 0) &&
      Object.hasOwn(usage, "input")
    )
      context = contextValue(used, { modelId: info.modelID, observedAt: at });
    for (const part of list(message.parts)) {
      if (part?.type !== "tool" || part.tool !== "task") continue;
      const state = object(part.state),
        metadata = object(state.metadata),
        input = object(state.input);
      if (metadata.parentSessionId && metadata.parentSessionId !== exported.info?.id)
        continue;
      const id = metadata.sessionId || metadata.sessionID;
      const status =
        metadata.background === true && state.status === "completed"
          ? "unknown"
          : agentStatus(state.status);
      putAgent(agents, id, {
        name: text(input.subagent_type),
        task: text(input.description || state.title),
        status,
        source: "opencode-task-metadata",
        updatedAt: timestamp(state.time?.end ?? state.time?.start) ?? at,
      });
    }
  }
  return { context, subagents: [...agents.values()], stale: false };
}
