import fs from "node:fs";

/** Current Claude CLI shape: background launches, notifications and hand-backs. */
export const backgroundRecords = () =>
  JSON.parse(
    fs.readFileSync(
      new URL("../fixtures/observability/claude-background.json", import.meta.url),
      "utf8",
    ),
  );

/** A TaskStop call and its successful result for a background agent. */
export const taskStop = (agentId) => [
  {
    type: "assistant",
    uuid: "stop-call",
    message: {
      id: "msg-stop",
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "toolu_stop",
          name: "TaskStop",
          input: { task_id: agentId },
        },
      ],
    },
  },
  {
    type: "user",
    uuid: "stop-result",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_stop",
          content: `{"message":"Successfully stopped task: ${agentId}"}`,
        },
      ],
    },
    toolUseResult: {
      message: `Successfully stopped task: ${agentId}`,
      task_id: agentId,
      task_type: "local_agent",
    },
  },
];

/** An Agent call and its background launch result. */
export const launch = (callId, agentId, description) => [
  {
    type: "assistant",
    uuid: `${callId}-call`,
    message: {
      id: `${callId}-message`,
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: callId,
          name: "Agent",
          input: { description, subagent_type: "general-purpose", prompt: description },
        },
      ],
    },
  },
  {
    type: "user",
    uuid: `${callId}-launch`,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: callId, content: "Launched." }],
    },
    toolUseResult: { isAsync: true, status: "async_launched", agentId },
  },
];

let sequence = 0;
/** A generated task notification for an Agent call. */
export const notification = (callId, agentId, status) => ({
  type: "user",
  uuid: `notification-${++sequence}`,
  origin: { kind: "task-notification", producer: "session-task" },
  message: {
    role: "user",
    content: `<task-notification>\n<task-id>${agentId}</task-id>\n<tool-use-id>${callId}</tool-use-id>\n<status>${status}</status>\n<summary>Agent ${status}</summary>\n</task-notification>`,
  },
});

/** A generated peer hand-back carrying a subagent's report. */
export const handback = (agentId, report) => ({
  type: "user",
  uuid: `handback-${++sequence}`,
  isMeta: true,
  origin: {
    kind: "peer",
    from: agentId,
    senderTaskId: agentId,
    name: "general-purpose",
    body: `[Subagent hand-back] Frame. The report follows:\n  ${report}`,
    handback: true,
  },
  message: { role: "user", content: "Another Claude session sent a message." },
});
