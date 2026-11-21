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

/** An Agent call and its background launch result; `input` replaces the call input. */
export const launch = (callId, agentId, description, input = null) => [
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
          input: input ?? {
            description,
            subagent_type: "general-purpose",
            prompt: description,
          },
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
    toolUseResult: { isAsync: true, status: "async_launched", agentId, description },
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

/**
 * The same completions as Claude Code writes them while the parent is mid-turn:
 * a queued-command attachment instead of a generated user record.
 */
export const queuedNotification = (callId, agentId, status) => {
  const source = notification(callId, agentId, status);
  return {
    type: "attachment",
    uuid: `queued-${source.uuid}`,
    isSidechain: false,
    attachment: {
      type: "queued_command",
      prompt: source.message.content,
      source_uuid: `source-${source.uuid}`,
      commandMode: "task-notification",
      origin: source.origin,
      usage: { totalTokens: 1200, toolUses: 3, durationMs: 4000 },
    },
  };
};

/** A peer hand-back absorbed mid-turn; `origin` overrides origin fields. */
export const queuedHandback = (agentId, report, origin = {}) => {
  const source = handback(agentId, report);
  return {
    type: "attachment",
    uuid: `queued-${source.uuid}`,
    isSidechain: false,
    attachment: {
      type: "queued_command",
      prompt: `<peer-message from="${agentId}">\n${source.origin.body}\n</peer-message>`,
      source_uuid: `source-${source.uuid}`,
      commandMode: "prompt",
      origin: { ...source.origin, ...origin },
      isMeta: true,
    },
  };
};

/** The queue operation Claude writes before absorbing a queued command. */
export const queueOperation = (content, operation = "enqueue") => ({
  type: "queue-operation",
  operation,
  reason: "absorbed_mid_turn",
  content,
});

/**
 * A context compaction as Claude Code 2.1.32x writes it: the boundary, the
 * continuation (compact summary) prompt, then one `task_status` attachment per
 * background task the CLI still tracks. `tasks` holds
 * `{ taskId, status, description, taskType? }`; a `local_bash` task carries its shell.
 * Ids and text are synthetic; the record shapes follow real transcripts.
 */
export const compaction = (tasks = [], at = "2026-11-21T05:00:46.000Z") => [
  {
    parentUuid: null,
    logicalParentUuid: "before-compaction",
    isSidechain: false,
    type: "system",
    subtype: "compact_boundary",
    content: "Conversation compacted",
    isMeta: false,
    timestamp: at,
    uuid: `boundary-${++sequence}`,
    level: "info",
    compactMetadata: { trigger: "auto", preTokens: 400000, durationMs: 48000 },
  },
  {
    isSidechain: false,
    type: "user",
    uuid: `summary-${sequence}`,
    timestamp: at,
    isVisibleInTranscriptOnly: true,
    isCompactSummary: true,
    message: {
      role: "user",
      content:
        "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary text.",
    },
  },
  ...tasks.map(({ taskId, status, description, taskType = "local_agent" }) => ({
    isSidechain: false,
    type: "attachment",
    uuid: `task-status-${taskId}-${sequence}`,
    timestamp: at,
    attachment: {
      type: "task_status",
      taskId,
      taskType,
      description,
      status,
      deltaSummary: null,
      outputFilePath: `/private/tmp/claude-501/project/session/tasks/${taskId}.output`,
      ...(taskType === "local_bash"
        ? { shell: { command: "sleep 600", kind: "bash", toolUseId: `toolu_${taskId}` } }
        : { canContinueAgent: true }),
    },
    rendered: [
      {
        content:
          taskType === "local_bash"
            ? `<system-reminder>\nBackground shell ${taskId} ("${description}") is still running\n</system-reminder>`
            : `<system-reminder>\nTask ${taskId} (type: ${taskType}) (status: ${status}) (description: ${description}) Read the output file to retrieve the result\n</system-reminder>`,
      },
    ],
    renderedRole: "system",
  })),
];

/** The first assistant reply of the continued conversation. */
export const reply = (text = "Continuing.") => ({
  type: "assistant",
  uuid: `reply-${++sequence}`,
  message: {
    id: `reply-message-${sequence}`,
    role: "assistant",
    content: [{ type: "text", text }],
  },
});

/** A background Bash call and its launch result. */
export const backgroundShell = (taskId, description) => [
  {
    type: "assistant",
    uuid: `${taskId}-call`,
    message: {
      id: `${taskId}-message`,
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: `toolu_${taskId}`,
          name: "Bash",
          input: { command: "sleep 600", description, run_in_background: true },
        },
      ],
    },
  },
  {
    type: "user",
    uuid: `${taskId}-launch`,
    sessionId: "fixture-session",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: `toolu_${taskId}`,
          content: `Command running in background with ID: ${taskId}.`,
        },
      ],
    },
    toolUseResult: { stdout: "", backgroundTaskId: taskId },
  },
];
