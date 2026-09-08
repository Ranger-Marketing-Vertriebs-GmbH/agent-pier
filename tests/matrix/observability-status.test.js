import test from "node:test";
import assert from "node:assert/strict";
import {
  observeClaude,
  observeCodex,
  observeOpenCode,
} from "../../server/features/chat/chat-observability.js";
const cases = [
  ["running", "running"],
  ["completed", "completed"],
  ["failed", "failed"],
  ["error", "failed"],
  ["pending", "unknown"],
  ["stopped", "unknown"],
];
for (const tool of ["claude", "codex", "opencode"])
  for (const [nativeStatus, expected] of cases) {
    test(`${tool} reports native agent ${nativeStatus} as ${expected}`, () => {
      let result;
      if (tool === "claude")
        result = observeClaude([
          {
            type: "assistant",
            message: {
              content: [
                {
                  type: "tool_use",
                  name: "Agent",
                  id: "tool-one",
                  input: { description: "A task" },
                },
              ],
            },
          },
          {
            type: "user",
            message: { content: [{ type: "tool_result", tool_use_id: "tool-one" }] },
            toolUseResult: { agentId: "native-agent", status: nativeStatus },
          },
        ]);
      if (tool === "codex")
        result = observeCodex({
          turns: [
            {
              items: [
                {
                  type: "collabAgentToolCall",
                  status: "completed",
                  receiverThreadIds: ["native-agent"],
                  agentsStates: { "native-agent": { status: nativeStatus } },
                },
              ],
            },
          ],
        });
      if (tool === "opencode")
        result = observeOpenCode({
          messages: [
            {
              info: { role: "assistant" },
              parts: [
                {
                  type: "tool",
                  tool: "task",
                  state: {
                    status: nativeStatus,
                    metadata: { sessionID: "native-agent" },
                  },
                },
              ],
            },
          ],
        });
      assert.equal(result.subagents[0].id, "native-agent");
      assert.equal(result.subagents[0].status, expected);
    });
  }
