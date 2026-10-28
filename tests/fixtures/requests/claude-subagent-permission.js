import fs from "node:fs/promises";
import path from "node:path";

/**
 * Sanitized shape of a Claude Code 2.1 session with a background subagent. The
 * PermissionRequest hook of a subagent carries `agent_id` and `agent_type`, and
 * names the parent transcript as `transcript_path`. The subagent writes its own
 * records (with `isSidechain` and `agentId`) to
 * `<session>/subagents/agent-<agent_id>.jsonl`, beside a `.meta.json` file. All
 * ids, paths and commands here are made up.
 */
export const subagentId = "a0f1e2d3c4b5a6978";
export const sessionId = "0b7c2d1e-0000-4000-8000-00000000f1a7";

export const subagentPermission = (transcriptPath, overrides = {}) => ({
  session_id: sessionId,
  transcript_path: transcriptPath,
  cwd: "/fixture/project",
  permission_mode: "default",
  hook_event_name: "PermissionRequest",
  agent_id: subagentId,
  agent_type: "general-purpose",
  tool_name: "Bash",
  tool_input: { command: "npm test", description: "Run the tests" },
  ...overrides,
});

const record = (fields) =>
  JSON.stringify({
    parentUuid: null,
    isSidechain: true,
    agentId: subagentId,
    sessionId,
    cwd: "/fixture/project",
    version: "2.1.285",
    ...fields,
  }) + "\n";

export const subagentToolUse = (payload, id = "toolu_subagent") =>
  record({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "tool_use", id, name: payload.tool_name, input: payload.tool_input },
      ],
    },
  });

export const subagentToolResult = (id = "toolu_subagent") =>
  record({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content: "ok" }],
    },
    permissionDecision: "allow",
  });

/** The subagent transcript file Claude writes for `transcriptPath`. */
export const subagentFile = (transcriptPath, agentId = subagentId) =>
  path.join(
    path.dirname(transcriptPath),
    path.basename(transcriptPath, ".jsonl"),
    "subagents",
    `agent-${agentId}.jsonl`,
  );

/** Writes a parent transcript without the call and, unless `write` is false, the subagent's. */
export async function subagentSession(root, { write = true } = {}) {
  const transcript = path.join(root, `${sessionId}.jsonl`);
  await fs.writeFile(
    transcript,
    record({
      isSidechain: false,
      agentId: undefined,
      type: "user",
      message: { role: "user", content: "Delegate the tests" },
    }),
  );
  const payload = subagentPermission(transcript);
  const file = subagentFile(transcript);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(
    file.replace(/\.jsonl$/, ".meta.json"),
    JSON.stringify({ agentType: "general-purpose", isBuiltIn: true }),
  );
  if (write)
    await fs.writeFile(
      file,
      record({ type: "user", message: { role: "user", content: "Run the tests" } }) +
        subagentToolUse(payload),
    );
  return { payload, transcript, file };
}
