import { list, object, text, timestamp, putShell } from "./observability-values.js";
import { settleStatus, subagentEvent } from "./claude-subagents.js";

// Background shells of the main loop: a Bash call with run_in_background, joined to
// its result by tool-use id, then ended by a task notification or a TaskStop result.
// Sidechain (subagent) records never reach this tracker's state.
const MAX_PENDING = 100;
const OUTPUT_LINE = /Output is being written to: (\S+?)\.?(?:\s|$)/;

const resultText = (block) =>
  typeof block?.content === "string"
    ? block.content
    : list(block?.content)
        .map((part) => (typeof part?.text === "string" ? part.text : ""))
        .join("\n");

const reEscape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The CLI's own task file, only when it sits where this session's tasks live. */
function trustedOutputFile(path, sessionId, id) {
  if (!sessionId || typeof path !== "string") return null;
  const expected = new RegExp(
    `^/(?:[^/]+/)*claude-\\d+/[^/]+/${reEscape(sessionId)}/tasks/${reEscape(id)}\\.output$`,
  );
  return !path.includes("..") && expected.test(path) ? path : null;
}

const exitCode = (summary) => {
  const match = /\bexit code (-?\d{1,5})\b/i.exec(summary || "");
  return match ? Number(match[1]) : undefined;
};

export function claudeShellTracker() {
  const shells = new Map();
  const pending = new Map(); // tool-use id -> { command, description }
  const finish = (id, status, at, extra = {}) => {
    const shell = shells.get(id);
    if (!shell) return;
    putShell(shells, id, {
      ...extra,
      status: settleStatus(shell.status, status),
      updatedAt: at ?? shell.updatedAt,
    });
  };
  return {
    record(source, at = null) {
      if (!source || source.isSidechain) return;
      const when = at ?? timestamp(source.timestamp);
      if (source.type === "assistant") {
        for (const block of list(source.message?.content)) {
          const input = object(block?.input);
          if (
            block?.type === "tool_use" &&
            block.name === "Bash" &&
            input.run_in_background === true &&
            typeof block.id === "string"
          )
            pending.set(block.id, {
              command: text(input.command, 1000),
              description: text(input.description, 300),
            });
          if (pending.size > MAX_PENDING) pending.delete(pending.keys().next().value);
        }
        return;
      }
      const result = object(source.toolUseResult);
      if (source.type === "user" && typeof result.backgroundTaskId === "string") {
        const block = list(source.message?.content).find(
          (item) => item?.type === "tool_result" && pending.has(item.tool_use_id),
        );
        if (block && !block.is_error) {
          const id = result.backgroundTaskId;
          const call = pending.get(block.tool_use_id);
          pending.delete(block.tool_use_id);
          const output = OUTPUT_LINE.exec(resultText(block))?.[1];
          const outputFile = trustedOutputFile(output, source.sessionId, id);
          putShell(shells, id, {
            ...call,
            status: "running",
            startedAt: when,
            updatedAt: when,
            ...(outputFile ? { outputFile } : {}),
          });
        }
        return;
      }
      if (
        source.type === "user" &&
        result.task_type === "local_bash" &&
        typeof result.task_id === "string" &&
        !list(source.message?.content).some(
          (block) => block?.type === "tool_result" && block.is_error,
        )
      )
        finish(result.task_id, "stopped", when);
      const event = subagentEvent(source);
      if (event?.kind === "notification" && shells.has(event.taskId)) {
        if (event.status === "unknown") return;
        const code = exitCode(event.summary);
        finish(
          event.taskId,
          event.status,
          when,
          code === undefined ? {} : { exitCode: code },
        );
      }
    },
    snapshot: () => [...shells.values()].map((shell) => ({ ...shell })),
  };
}
