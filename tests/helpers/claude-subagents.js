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
