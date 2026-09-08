import {
  list,
  object,
  text,
  nativeId,
  timestamp,
  emptyContext,
  inputTokens,
  contextValue,
  agentStatus,
  putAgent,
} from "./observability-values.js";
export function observeClaude(records) {
  let context = emptyContext();
  const agents = new Map(),
    calls = new Map(),
    tasks = new Map(),
    agentByCall = new Map();
  function nativeAgent(callId, agentId, values) {
    if (!nativeId(agentId)) return;
    agentByCall.set(callId, agentId);
    for (const [taskId, toolId] of tasks) {
      if (toolId !== callId || taskId === agentId || !agents.has(taskId)) continue;
      const prior = agents.get(taskId);
      agents.delete(taskId);
      if (!agents.has(agentId)) putAgent(agents, agentId, prior);
    }
    const previous = agents.get(agentId);
    putAgent(agents, agentId, {
      ...values,
      ...(values.status === "unknown" &&
      ["completed", "failed"].includes(previous?.status)
        ? { status: previous.status }
        : {}),
    });
  }
  for (const record of list(records)) {
    if (!record || record.isSidechain) continue;
    const at = timestamp(record.timestamp);
    if (record.type === "system" && record.subtype === "compact_boundary")
      context = {
        ...context,
        usedTokens: null,
        remainingPercent: null,
        source: null,
        observedAt: at,
      };
    if (record.type === "assistant" && !record.isMeta && !record.isCompactSummary) {
      const message = object(record.message),
        usage = object(message.usage);
      if (Object.hasOwn(usage, "input_tokens"))
        context = contextValue(
          inputTokens(
            usage.input_tokens,
            usage.cache_creation_input_tokens,
            usage.cache_read_input_tokens,
          ),
          { observedAt: at, modelId: message.model },
        );
      for (const block of list(message.content))
        if (
          block?.type === "tool_use" &&
          ["Agent", "Task"].includes(block.name) &&
          nativeId(block.id)
        )
          calls.set(block.id, object(block.input));
    }
    if (
      record.type === "progress" &&
      record.data?.type === "agent_progress" &&
      calls.has(record.parentToolUseID)
    ) {
      const input = calls.get(record.parentToolUseID);
      nativeAgent(record.parentToolUseID, record.data.agentId, {
        name: text(input.name || input.subagent_type),
        task: text(input.description || input.prompt),
        status: "running",
        source: "claude-agent-progress",
        updatedAt: at,
      });
    }
    if (record.type === "user" && record.toolUseResult) {
      const result = object(record.toolUseResult);
      const block = list(record.message?.content).find(
        (block) => block?.type === "tool_result" && calls.has(block.tool_use_id),
      );
      if (block && nativeId(result.agentId)) {
        const input = calls.get(block.tool_use_id);
        const status = block.is_error
          ? "failed"
          : result.isAsync === true || result.status === "launched"
            ? "unknown"
            : agentStatus(result.status);
        nativeAgent(block.tool_use_id, result.agentId, {
          name: text(input.name || input.subagent_type),
          task: text(input.description || input.prompt),
          status,
          source: "claude-tool-result",
          updatedAt: at,
        });
      }
    }
    if (record.type === "system" && nativeId(record.task_id)) {
      const callId = nativeId(record.tool_use_id) || tasks.get(record.task_id);
      const isAgentStart =
        record.subtype === "task_started" &&
        ["local_agent", "remote_agent"].includes(record.task_type);
      const knownAgent = tasks.has(record.task_id) || (callId && calls.has(callId));
      if (isAgentStart || knownAgent) {
        tasks.set(record.task_id, callId || null);
        const id = agentByCall.get(callId) || record.task_id;
        if (
          ["task_started", "task_progress", "task_notification"].includes(record.subtype)
        )
          putAgent(agents, id, {
            ...(record.description ? { task: text(record.description) } : {}),
            status:
              record.subtype === "task_notification"
                ? agentStatus(record.status)
                : "running",
            source: "claude-task-event",
            updatedAt: at,
          });
      }
    }
  }
  return { context, subagents: [...agents.values()], stale: false };
}
