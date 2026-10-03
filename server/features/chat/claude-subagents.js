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

function notificationEnvelope(record) {
  const match = /<task-notification>([\s\S]*?)<\/task-notification>/.exec(
    recordText(record),
  );
  return match ? match[1] : null;
}

/**
 * Cheap identification of a lifecycle record: its kind and native ids only.
 * The history index uses it per record; reports are built only by the tracker.
 */
export function subagentKey(record) {
  if (record?.type !== "user" || record.isSidechain) return null;
  const origin = object(record.origin);
  if (origin.kind === "task-notification") {
    const envelope = notificationEnvelope(record);
    if (envelope === null) return null;
    const taskId = nativeId(tag(envelope, "task-id"));
    const toolUseId = nativeId(tag(envelope, "tool-use-id"));
    return taskId || toolUseId ? { kind: "notification", taskId, toolUseId } : null;
  }
  if (origin.kind === "peer" && origin.handback === true && nativeId(origin.from))
    return { kind: "handback", agentId: origin.from };
  // A successful TaskStop result names the stopped agent in its structured result.
  const result = object(record.toolUseResult);
  if (
    ["local_agent", "remote_agent"].includes(result.task_type) &&
    nativeId(result.task_id) &&
    typeof result.message === "string" &&
    !list(record.message?.content).some(
      (block) => block?.type === "tool_result" && block.is_error,
    )
  )
    return { kind: "stopped", agentId: result.task_id };
  return null;
}

/** A subagent lifecycle event with its state (and report for hand-backs), or null. */
export function subagentEvent(record) {
  const key = subagentKey(record);
  if (key?.kind === "notification") {
    const envelope = notificationEnvelope(record);
    return {
      ...key,
      status: notificationStatus(tag(envelope, "status")),
      summary: tag(envelope, "summary").slice(0, 1000),
    };
  }
  if (key?.kind === "handback")
    return {
      ...key,
      status: "completed",
      report: handbackReport(string(record.origin.body)),
    };
  if (key?.kind === "stopped") return { ...key, status: "unknown" };
  return null;
}

/**
 * One precedence rule for chat rows and the observer: within one launch the
 * latest event wins, but an inconclusive state (killed, stopped) never replaces
 * a reported completion or failure. A new launch starts over as running.
 */
export function settleStatus(current, next) {
  return next === "unknown" && ["completed", "failed"].includes(current) ? current : next;
}

/** Collects launches and lifecycle events so Agent rows show their real state. */
export function createSubagentTracker() {
  const launches = new Map(); // tool-use id -> { agentId, async }
  const states = new Map(); // agent id (or call:<id>) -> state of the latest launch
  const key = (toolUseId, agentId) =>
    launches.get(toolUseId)?.agentId || agentId || (toolUseId && `call:${toolUseId}`);
  return {
    record(record) {
      if (record?.type !== "user" || record.isSidechain) return;
      if (record.toolUseResult) {
        const block = list(record.message?.content).find(
          (item) => item?.type === "tool_result" && nativeId(item.tool_use_id),
        );
        const agentId = nativeId(object(record.toolUseResult).agentId);
        const async = asyncLaunch(record.toolUseResult);
        if (block) launches.set(block.tool_use_id, { agentId, async });
        // A launch reusing an agent id never inherits an earlier run's events.
        if (block && async && agentId) states.set(agentId, { status: "running" });
      }
      const event = subagentEvent(record);
      if (!event) return;
      const id =
        event.kind === "notification"
          ? key(event.toolUseId, event.taskId)
          : key(null, event.agentId);
      const current = states.get(id) || { status: "running" };
      states.set(id, {
        ...current,
        status: settleStatus(current.status, event.status),
        ...(event.summary ? { summary: event.summary } : {}),
        ...(event.report ? { report: event.report } : {}),
      });
    },
    /** Subagent fields for an Agent/Task tool row; `row` holds the generic values. */
    apply(row, input) {
      const launch = launches.get(row.id);
      const subagent = {
        description: string(input.description).slice(0, 300),
        type: string(input.subagent_type || input.name).slice(0, 120),
        status: row.status,
        ...(launch?.agentId ? { agentId: launch.agentId } : {}),
      };
      if (!launch?.async) return { ...row, subagent };
      const state = states.get(key(row.id)) || { status: "running" };
      const status = row.status === "failed" ? "failed" : state.status;
      const text = state.report || state.summary || string(input.prompt);
      return {
        ...row,
        text: text || row.text,
        status,
        subagent: { ...subagent, status },
      };
    },
  };
}
