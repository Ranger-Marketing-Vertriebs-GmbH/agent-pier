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
import { asyncLaunch, settleStatus, subagentEvent } from "./claude-subagents.js";

// Identities retained per session; finished agents are evicted first.
const MAX_AGENTS = 100;
export function createClaudeObserver({ maxEntries = Infinity, compact = false } = {}) {
  let stale = false;
  const field = (value) => (typeof value === "string" ? text(value) : Boolean(value));
  let context = emptyContext();
  const agents = new Map(),
    calls = new Map(),
    tasks = new Map(),
    agentByCall = new Map();
  function remember(map, key, value) {
    map.set(key, value);
    if (map.size > maxEntries) {
      map.delete(map.keys().next().value);
      stale = true;
    }
  }
  function agent(id, values) {
    // At the identity cap the oldest finished agent makes room. Only when every
    // retained agent is still running would a live state be lost.
    if (!agents.has(id) && agents.size >= MAX_AGENTS) {
      const finished = [...agents.values()].find((entry) => entry.status !== "running");
      if (finished) agents.delete(finished.id);
      else if (Number.isFinite(maxEntries)) stale = true;
    }
    putAgent(agents, id, values);
  }
  function nativeAgent(callId, agentId, values) {
    if (!nativeId(agentId)) return;
    remember(agentByCall, callId, agentId);
    for (const [taskId, toolId] of tasks) {
      if (toolId !== callId || taskId === agentId || !agents.has(taskId)) continue;
      const prior = agents.get(taskId);
      agents.delete(taskId);
      if (!agents.has(agentId)) agent(agentId, prior);
    }
    const previous = agents.get(agentId);
    // A new background launch starts over; other reports follow settleStatus.
    agent(agentId, {
      ...values,
      status:
        values.source === "claude-async-launch"
          ? values.status
          : settleStatus(previous?.status, values.status),
    });
  }
  function update(records) {
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
          ) {
            const input = object(block.input);
            remember(
              calls,
              block.id,
              compact
                ? {
                    name: field(input.name),
                    subagent_type: field(input.subagent_type),
                    description: field(input.description),
                    prompt: field(input.prompt),
                  }
                : input,
            );
          }
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
          const launched = !block.is_error && asyncLaunch(result);
          const status = block.is_error
            ? "failed"
            : launched
              ? "running"
              : agentStatus(result.status);
          nativeAgent(block.tool_use_id, result.agentId, {
            name: text(input.name || input.subagent_type),
            task: text(input.description || input.prompt),
            status,
            source: launched ? "claude-async-launch" : "claude-tool-result",
            updatedAt: at,
          });
        }
      }
      // Background agents finish through generated user records, linked only by
      // the native tool-use id of a known Agent call or a known agent id.
      const event = subagentEvent(record);
      if (event?.kind === "notification" && calls.has(event.toolUseId)) {
        const input = calls.get(event.toolUseId);
        nativeAgent(event.toolUseId, agentByCall.get(event.toolUseId) || event.taskId, {
          name: text(input.name || input.subagent_type),
          task: text(input.description || input.prompt),
          status: event.status,
          source: "claude-task-notification",
          updatedAt: at,
        });
      }
      if (["handback", "stopped"].includes(event?.kind) && agents.has(event.agentId))
        agent(event.agentId, {
          status: settleStatus(agents.get(event.agentId).status, event.status),
          source: `claude-${event.kind}`,
          updatedAt: at,
        });
      if (record.type === "system" && nativeId(record.task_id)) {
        const callId = nativeId(record.tool_use_id) || tasks.get(record.task_id);
        const isAgentStart =
          record.subtype === "task_started" &&
          ["local_agent", "remote_agent"].includes(record.task_type);
        const knownAgent = tasks.has(record.task_id) || (callId && calls.has(callId));
        if (isAgentStart || knownAgent) {
          remember(tasks, record.task_id, callId || null);
          const id = agentByCall.get(callId) || record.task_id;
          if (
            ["task_started", "task_progress", "task_notification"].includes(
              record.subtype,
            )
          )
            agent(id, {
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
  }
  const snapshot = () => ({
    context: { ...context },
    subagents: [...agents.values()].map((value) => ({ ...value })),
    stale,
  });
  return { update, snapshot };
}

export function observeClaude(records) {
  const observer = createClaudeObserver();
  observer.update(records);
  return observer.snapshot();
}
