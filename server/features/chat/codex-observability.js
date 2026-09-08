import {
  list,
  object,
  text,
  nativeId,
  timestamp,
  emptyContext,
  codexContext,
  agentStatus,
  putAgent,
} from "./observability-values.js";
export function observeCodex(thread, records = []) {
  let context = emptyContext();
  const agents = new Map();
  let modelId = null;
  const native = (id, values) =>
    putAgent(agents, id, { source: "codex-agent-event", ...values });
  for (const record of list(records)) {
    const item = object(record?.payload),
      at = timestamp(record?.timestamp);
    if (record?.type === "turn_context") modelId = text(item.model, 200) || modelId;
    if (
      record?.type === "compacted" ||
      (record?.type === "event_msg" && item.type === "context_compacted")
    )
      context = {
        ...context,
        usedTokens: null,
        remainingPercent: null,
        source: null,
        observedAt: at,
      };
    if (record?.type !== "event_msg") continue;
    if (item.type === "token_count" && item.info) {
      context = codexContext(item.info.last_token_usage?.total_tokens, {
        limitTokens: item.info.model_context_window,
        source: "native-token-count",
        observedAt: at,
        modelId,
      });
    }
    if (item.type === "collab_agent_spawn_end")
      native(item.new_thread_id, {
        name: text(item.new_agent_nickname || item.new_agent_role),
        task: text(item.prompt),
        status: agentStatus(item.status),
        updatedAt: at,
      });
    if (
      ["collab_agent_interaction_end", "collab_resume_end", "collab_close_end"].includes(
        item.type,
      )
    )
      native(item.receiver_thread_id, {
        ...(item.receiver_agent_nickname || item.receiver_agent_role
          ? { name: text(item.receiver_agent_nickname || item.receiver_agent_role) }
          : {}),
        ...(item.prompt ? { task: text(item.prompt) } : {}),
        status: agentStatus(item.status),
        updatedAt: at,
      });
    if (item.type === "collab_waiting_end") {
      for (const [id, status] of Object.entries(object(item.statuses)))
        native(id, { status: agentStatus(status), updatedAt: at });
      for (const state of list(item.agent_statuses))
        native(state?.thread_id, {
          ...(state?.agent_nickname || state?.agent_role
            ? { name: text(state.agent_nickname || state.agent_role) }
            : {}),
          status: agentStatus(state?.status),
          updatedAt: at,
        });
    }
    if (item.type === "sub_agent_activity" && nativeId(item.agent_thread_id))
      native(item.agent_thread_id, {
        name: text(item.agent_path, 120),
        status: agentStatus(item.kind === "interacted" ? "running" : item.kind),
        updatedAt: at,
      });
  }
  // Full structured thread state wins when event timestamps cannot be compared.
  // A rollout append provably newer than that snapshot must remain authoritative.
  const snapshotAt = timestamp(
    typeof thread?.updatedAt === "number" ? thread.updatedAt * 1000 : null,
  );
  const snapshotWins = (previous, at) => !previous || !at || at >= previous;
  for (const turn of list(thread?.turns))
    for (const item of list(turn?.items)) {
      const eventAt = timestamp(item?.timestamp);
      const comparisonAt = eventAt || snapshotAt;
      if (item?.type === "collabAgentToolCall") {
        const states = object(item.agentsStates);
        for (const id of new Set([
          ...list(item.receiverThreadIds),
          ...Object.keys(states),
        ])) {
          const previous = agents.get(id);
          if (!snapshotWins(previous?.updatedAt, comparisonAt)) continue;
          native(id, {
            ...(item.prompt ? { task: text(item.prompt) } : {}),
            ...(Object.hasOwn(states, id)
              ? { status: agentStatus(states[id]?.status), updatedAt: eventAt }
              : previous
                ? {}
                : { status: "unknown", updatedAt: null }),
          });
        }
      }
      if (
        item?.type === "subAgentActivity" &&
        snapshotWins(agents.get(item.agentThreadId)?.updatedAt, comparisonAt)
      )
        native(item.agentThreadId, {
          name: text(item.agentPath, 120),
          status: agentStatus(item.kind === "interacted" ? "running" : item.kind),
          updatedAt: eventAt,
        });
    }
  const usage = thread?.tokenUsage;
  if (
    usage?.last?.totalTokens !== undefined &&
    snapshotWins(context.observedAt, snapshotAt)
  )
    context = codexContext(usage.last.totalTokens, {
      limitTokens: usage.modelContextWindow,
      source: "native-token-count",
      modelId: context.modelId,
    });
  return { context, subagents: [...agents.values()], stale: false };
}
