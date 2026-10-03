// Current Claude Code CLIs launch subagents in the background. The Agent tool
// result only confirms the launch; completion arrives later as generated user
// records: a task notification (origin.kind "task-notification") and, for agents
// that call SubagentHandback, a peer hand-back (origin.kind "peer"). Both records
// stay out of the visible chat; they only feed the subagent's state and report.
const REPORT_LIMIT = 256 * 1024;
const REPORT_MARKER = "The report follows:\n";
const HANDBACK_PREFIX = "[Subagent hand-back]";
const SUBAGENT_TOOLS = new Set(["Agent", "Task"]);

const list = (value) => (Array.isArray(value) ? value : []);
const object = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};
const string = (value) => (typeof value === "string" ? value : "");
const nativeId = (value) =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(value)
    ? value
    : null;

export const isSubagentTool = (name) => SUBAGENT_TOOLS.has(name);

/** The Agent tool result of a background launch, not of a finished foreground run. */
export function asyncLaunch(result) {
  const value = object(result);
  return value.isAsync === true || ["async_launched", "launched"].includes(value.status);
}

/** Notification states: only an explicit completion or failure is conclusive. */
export function notificationStatus(value) {
  if (value === "completed") return "completed";
  if (["failed", "error", "errored"].includes(value)) return "failed";
  return "unknown";
}

function recordText(record) {
  const content = record?.message?.content;
  if (typeof content === "string") return content;
  return list(content)
    .filter((block) => block?.type === "text")
    .map((block) => string(block.text))
    .join("\n");
}
// Tags are read only from the notification envelope Claude writes, never from prose.
const tag = (source, name) => {
  const match = new RegExp(`<${name}>([^<]{0,2000})</${name}>`).exec(source);
  return match ? match[1].trim() : "";
};

function handbackReport(body) {
  const marker = body.indexOf(REPORT_MARKER);
  const report =
    marker >= 0
      ? body
          .slice(marker + REPORT_MARKER.length)
          .split("\n")
          .map((line) => (line.startsWith("  ") ? line.slice(2) : line))
          .join("\n")
      : body.startsWith(HANDBACK_PREFIX)
        ? body.slice(HANDBACK_PREFIX.length)
        : body;
  return report.trim().slice(0, REPORT_LIMIT);
}

/** A subagent lifecycle event from a generated user record, or null. */
export function subagentEvent(record) {
  if (record?.type !== "user" || record.isSidechain) return null;
  const origin = object(record.origin);
  if (origin.kind === "task-notification") {
    const source = recordText(record);
    const envelope = /<task-notification>([\s\S]*?)<\/task-notification>/.exec(source);
    if (!envelope) return null;
    const taskId = nativeId(tag(envelope[1], "task-id"));
    const toolUseId = nativeId(tag(envelope[1], "tool-use-id"));
    if (!taskId && !toolUseId) return null;
    return {
      kind: "notification",
      taskId,
      toolUseId,
      status: notificationStatus(tag(envelope[1], "status")),
      summary: tag(envelope[1], "summary").slice(0, 1000),
    };
  }
  if (origin.kind === "peer" && origin.handback === true && nativeId(origin.from))
    return {
      kind: "handback",
      agentId: origin.from,
      report: handbackReport(string(origin.body)),
    };
  // A successful TaskStop result names the stopped agent in its structured result.
  const result = object(record.toolUseResult);
  const blocks = list(record.message?.content).filter(
    (block) => block?.type === "tool_result",
  );
  if (
    ["local_agent", "remote_agent"].includes(result.task_type) &&
    nativeId(result.task_id) &&
    typeof result.message === "string" &&
    !blocks.some((block) => block.is_error)
  )
    return { kind: "stopped", agentId: result.task_id };
  return null;
}

/** Collects launches and lifecycle events so Agent rows show their real state. */
export function createSubagentTracker() {
  const launches = new Map(); // tool-use id -> { agentId, async }
  const byCall = new Map(); // tool-use id -> notification state
  const byAgent = new Map(); // agent id -> latest event state
  const order = { value: 0 };
  return {
    record(record) {
      if (record?.type !== "user" || record.isSidechain) return;
      if (record.toolUseResult) {
        const block = list(record.message?.content).find(
          (item) => item?.type === "tool_result" && nativeId(item.tool_use_id),
        );
        if (block)
          launches.set(block.tool_use_id, {
            agentId: nativeId(object(record.toolUseResult).agentId),
            async: asyncLaunch(record.toolUseResult),
          });
      }
      const event = subagentEvent(record);
      if (!event) return;
      const at = ++order.value;
      if (event.kind === "notification") {
        const state = { status: event.status, summary: event.summary, at };
        if (event.toolUseId) byCall.set(event.toolUseId, state);
        if (event.taskId)
          byAgent.set(event.taskId, { ...byAgent.get(event.taskId), ...state });
      } else if (event.kind === "stopped") {
        byAgent.set(event.agentId, {
          ...byAgent.get(event.agentId),
          status: "unknown",
          at,
        });
      } else {
        byAgent.set(event.agentId, {
          ...byAgent.get(event.agentId),
          status: "completed",
          report: event.report,
          at,
        });
      }
    },
    /** Subagent fields for an Agent/Task tool row; `row` holds the generic values. */
    apply(row, input) {
      const launch = launches.get(row.id);
      const subagent = {
        description: string(input.description).slice(0, 300),
        type: string(input.subagent_type || input.name).slice(0, 120),
        status: row.status,
      };
      if (!launch?.async) return { ...row, subagent };
      const agent = launch.agentId ? byAgent.get(launch.agentId) : undefined;
      const call = byCall.get(row.id);
      const latest = [agent, call].filter(Boolean).sort((a, b) => b.at - a.at)[0];
      const status = row.status === "failed" ? "failed" : latest?.status || "running";
      const text =
        agent?.report || call?.summary || agent?.summary || string(input.prompt);
      return {
        ...row,
        text: text || row.text,
        status,
        subagent: { ...subagent, status },
      };
    },
  };
}
