import { restoreClaudeImagePaths } from "./claude-image-history.js";
import { codexImageInput } from "./codex-image-input.js";
import { codexInputTime } from "./native-input-time.js";
import { markOpenCodeInput } from "./opencode-input-state.js";
import { toolFileChanges, codexFileChanges } from "./tool-file-changes.js";
import {
  claudeConversationRecord,
  claudeVisibleRecord,
} from "./claude-conversation-record.js";
import { createSubagentTracker, isSubagentTool } from "./claude-subagents.js";
import {
  attachmentPlaceholders,
  extractToolImages,
  imagePlaceholders,
} from "./tool-images.js";
import { createHash } from "node:crypto";

const list = (value) => (Array.isArray(value) ? value : []);
const object = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};
const string = (value) => (typeof value === "string" ? value : "");
const identifier = (value) =>
  typeof value === "string" || typeof value === "number" ? String(value) : "";
const hash = (value) =>
  createHash("sha256").update(string(value)).digest("hex").slice(0, 16);
const parse = (value) => {
  try {
    return typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    return null;
  }
};
const failedOutput = (item) => {
  const output = object(parse(item.output));
  return (
    Boolean(item.is_error) ||
    (typeof output.metadata?.exit_code === "number" && output.metadata.exit_code !== 0)
  );
};
const show = (value, images) => {
  const safe = images ? extractToolImages(value, images) : value;
  return typeof safe === "string"
    ? safe
    : safe == null
      ? ""
      : JSON.stringify(safe, null, 2);
};
const text = (value) =>
  typeof value === "string"
    ? value
    : list(value)
        .filter((block) =>
          ["text", "input_text", "output_text", "inputText"].includes(block?.type),
        )
        .map((block) => string(block.text))
        .join("\n");
// Text blocks win; images in the same content become `[image N]` placeholders.
const body = (value, images) => {
  const out = text(value);
  if (out) return join(out, imagePlaceholders(value, images));
  const start = images.length;
  const safe = extractToolImages(value, images);
  // A content array made only of images reads as plain placeholders, not JSON.
  return images.length > start &&
    Array.isArray(safe) &&
    safe.every((e) => typeof e === "string")
    ? safe.join("\n")
    : show(safe);
};
const withImages = (row, images, input) => {
  if (!images.length) return row;
  const parsed = object(parse(input));
  const path = parsed.file_path ?? parsed.filePath;
  return {
    ...row,
    toolImages: images,
    ...(typeof path === "string" ? { toolImagePath: path } : {}),
  };
};
const join = (...values) =>
  values.filter((value) => typeof value === "string" && value.length).join("\n\n");
const stamp = (value) =>
  typeof value === "string" || typeof value === "number" ? { timestamp: value } : {};
const taskStatus = (value) =>
  value === "inProgress"
    ? "in_progress"
    : ["pending", "in_progress", "completed"].includes(value)
      ? value
      : undefined;
const toolStatus = (value, failed = false) =>
  failed || ["failed", "error", "declined", "interrupted"].includes(value)
    ? "failed"
    : value === "completed"
      ? "completed"
      : "running";

function taskList(values, prefix) {
  const occurrences = new Map();
  return list(values).flatMap((value) => {
    const entry = object(value);
    const label = string(entry.content || entry.step || entry.text || entry.subject);
    const status = taskStatus(entry.status);
    if (!label || !status) return [];
    const occurrence = occurrences.get(label) || 0;
    occurrences.set(label, occurrence + 1);
    return [
      {
        id: identifier(entry.id) || `${prefix}:${hash(label)}:${occurrence}`,
        text: label,
        status,
      },
    ];
  });
}

function claudeTaskCreated(input, output) {
  const raw = text(output);
  const parsed = object(parse(raw) || output);
  const task = object(parsed.task || parsed);
  const id =
    identifier(task.id || task.taskId) ||
    raw.match(/^Task #([^\s]+) created successfully:/)?.[1];
  const label = string(task.subject || input.subject);
  return id && label
    ? { id, text: label, status: taskStatus(task.status) || "pending" }
    : null;
}

/** Normalize parsed Claude JSONL records, without interpreting terminal-like prose. */
export function normalizeClaude(records) {
  const snapshots = new Map();
  const fragments = new Map();
  const results = new Map();
  const subagents = createSubagentTracker();
  restoreClaudeImagePaths(list(records)).forEach((source, index) => {
    const record = claudeConversationRecord(source);
    subagents.record(record);
    if (!claudeVisibleRecord(record)) return;
    const message = object(record.message);
    const id = identifier(message.id || record.uuid) || `claude:${index}`;
    const previous = snapshots.get(id);
    // Claude streams one content block per fragment record of a message.id, each
    // at index 0. Blocks without an id are therefore keyed per record, so later
    // fragments append instead of replacing an earlier text or thinking block.
    const origin = identifier(record.uuid) || `record:${index}`;
    const blockKey = (block, position) =>
      identifier(block?.id) || `${origin}:${position}`;
    if (record.type === "assistant" && previous && Array.isArray(message.content)) {
      const blocks = fragments.get(id) || new Map();
      message.content.forEach((block, position) =>
        blocks.set(blockKey(block, position), block),
      );
      fragments.set(id, blocks);
      snapshots.set(id, {
        ...record,
        message: { ...message, content: [...blocks.values()] },
        normalizedId: id,
      });
    } else {
      fragments.set(
        id,
        new Map(list(message.content).map((block, i) => [blockKey(block, i), block])),
      );
      snapshots.set(id, { ...record, message, normalizedId: id });
    }
    for (const block of list(message.content)) {
      if (block?.type === "tool_result" && identifier(block.tool_use_id))
        results.set(String(block.tool_use_id), block);
    }
  });
  const messages = new Map();
  let todos = [];
  const tasks = new Map();
  for (const record of snapshots.values()) {
    const content = record.message.content;
    const baseId = record.normalizedId;
    const timestamp = stamp(record.timestamp);
    if (typeof content === "string") {
      if (content)
        messages.set(baseId, {
          id: baseId,
          role: record.type,
          text: content,
          ...timestamp,
        });
      continue;
    }
    // Text attached to a tool-result envelope is provider-injected context, not a new user message.
    const resultEnvelope =
      record.type === "user" &&
      list(content).some((block) => block?.type === "tool_result");
    list(content).forEach((block, index) => {
      if (!block) return;
      const id = identifier(block.id) || `${baseId}:${index}`;
      if (
        block.type === "text" &&
        !resultEnvelope &&
        typeof block.text === "string" &&
        block.text
      ) {
        messages.set(id, {
          id,
          role: record.type,
          text: block.text,
          ...timestamp,
        });
      }
      if (block.type === "tool_use" && record.type === "assistant") {
        const output = results.get(id);
        const input = object(parse(block.input));
        const images = [];
        const row = withImages(
          {
            id,
            role: "tool",
            toolName: string(block.name) || "Tool",
            ...toolFileChanges(block.name, block.input),
            text: join(
              show(block.input, images),
              output ? body(output.content, images) : "",
            ),
            status: output ? (output.is_error ? "failed" : "completed") : "running",
            ...timestamp,
          },
          images,
          block.input,
        );
        messages.set(id, isSubagentTool(block.name) ? subagents.apply(row, input) : row);
        if (output?.is_error) return;
        if (block.name === "TodoWrite" && Array.isArray(input.todos))
          todos = taskList(input.todos, "claude-todo");
        if (block.name === "TaskCreate" && output) {
          const created = claudeTaskCreated(input, output.content);
          if (created) tasks.set(created.id, created);
        }
        if (block.name === "TaskUpdate") {
          const taskId = identifier(input.taskId);
          if (input.status === "deleted") tasks.delete(taskId);
          else if (tasks.has(taskId)) {
            const current = tasks.get(taskId);
            tasks.set(taskId, {
              ...current,
              text: string(input.subject) || current.text,
              status: taskStatus(input.status) || current.status,
            });
          }
        }
      }
      if (block.type === "tool_result" && !messages.has(identifier(block.tool_use_id))) {
        const resultId = identifier(block.tool_use_id) || id;
        const images = [];
        messages.set(
          resultId,
          withImages(
            {
              id: resultId,
              role: "tool",
              toolName: "Tool",
              text: body(block.content, images),
              status: block.is_error ? "failed" : "completed",
              ...timestamp,
            },
            images,
          ),
        );
      }
    });
  }
  return {
    messages: [...messages.values()],
    tasks: [...todos, ...tasks.values()],
  };
}

/** App-server ThreadItem/Turn schema. `plan.text` is prose, never checklist state. */
export function normalizeCodex(thread) {
  const messages = new Map();
  let tasks = [];
  list(thread?.turns).forEach((turn, turnIndex) => {
    list(turn?.items).forEach((item, index) => {
      if (!item) return;
      const id =
        identifier(item.id) || `codex:${identifier(turn?.id) || turnIndex}:${index}`;
      const timestamp = stamp(item.timestamp);
      const add = (role, value, extra = {}) => {
        if (value || role === "tool")
          messages.set(id, { id, role, text: value, ...extra, ...timestamp });
      };
      if (item.type === "userMessage")
        add("user", text(item.content), {
          ...stamp(item.timestamp ?? codexInputTime(item.id)),
          ...codexImageInput(item.content),
        });
      if (item.type === "agentMessage" || item.type === "plan")
        add("assistant", string(item.text));
      if (item.type === "commandExecution")
        add("tool", join(string(item.command), string(item.aggregatedOutput)), {
          toolName: "Command",
          status: toolStatus(
            item.status,
            typeof item.exitCode === "number" && item.exitCode !== 0,
          ),
        });
      if (item.type === "fileChange")
        add(
          "tool",
          list(item.changes)
            .map((change) => join(string(change?.path), string(change?.diff)))
            .join("\n\n"),
          {
            toolName: "File change",
            ...codexFileChanges(item.changes),
            status: toolStatus(item.status),
          },
        );
      if (item.type === "mcpToolCall" || item.type === "dynamicToolCall") {
        const status = toolStatus(
          item.status,
          Boolean(item.error) || item.success === false,
        );
        const images = [];
        const shown = [item.result?.content, item.contentItems].find((value) =>
          text(value),
        );
        add(
          "tool",
          join(
            show(item.arguments, images),
            shown ? body(shown, images) : show(item.result, images),
            show(item.error, images),
          ),
          withImages(
            {
              toolName: string(item.tool) || "Tool",
              ...toolFileChanges(item.tool, item.arguments),
              status,
            },
            images,
            item.arguments,
          ),
        );
        const args = object(parse(item.arguments));
        if (
          item.tool === "update_plan" &&
          status !== "failed" &&
          Array.isArray(args.plan)
        )
          tasks = taskList(args.plan, "codex-plan");
      }
      if (item.type === "functionCallOutput") {
        const images = [];
        add(
          "tool",
          join(text(item.output), imagePlaceholders(item.output, images)),
          withImages(
            { toolName: string(item.name) || "Tool", status: "completed" },
            images,
          ),
        );
      }
      if (item.type === "webSearch")
        add("tool", string(item.query), {
          toolName: "Web search",
          status: "completed",
        });
      if (item.type === "imageView")
        add("tool", string(item.path), {
          toolName: "View image",
          status: "completed",
        });
    });
    const error = string(turn?.error?.message);
    if (error) {
      const id = `codex-turn-error:${identifier(turn.id) || turnIndex}`;
      messages.set(id, { id, role: "assistant", text: error, status: "failed" });
    }
    // Optional reader enrichment from a captured turn/plan/updated notification.
    if (Array.isArray(turn?.plan)) tasks = taskList(turn.plan, "codex-plan");
  });
  return { messages: [...messages.values()], tasks };
}

/** Legacy Codex rollout fallback, especially persisted update_plan call arguments. */
export function normalizeCodexRecords(records) {
  const messages = [];
  const calls = new Map();
  const unpaired = new Map();
  const callInputs = new Map();
  const failedCalls = new Set(
    list(records)
      .filter(
        (record) =>
          record?.type === "response_item" &&
          ["function_call_output", "custom_tool_call_output"].includes(
            record.payload?.type,
          ) &&
          failedOutput(record.payload),
      )
      .map((record) => identifier(record.payload.call_id || record.payload.id)),
  );
  let tasks = [];
  list(records).forEach((record, index) => {
    const item = object(record?.payload);
    const isResponse = record?.type === "response_item";
    const isEvent = record?.type === "event_msg";
    if (isEvent && item.type === "task_complete" && string(item.error?.message)) {
      const id = `codex-turn-error:${identifier(item.turn_id) || index}`;
      const message = {
        id,
        role: "assistant",
        text: item.error.message,
        status: "failed",
        ...stamp(record.timestamp),
      };
      const existing = messages.findIndex((entry) => entry.id === id);
      if (existing < 0) messages.push(message);
      else messages[existing] = message;
    }
    const role =
      isResponse && item.type === "message" && ["user", "assistant"].includes(item.role)
        ? item.role
        : isEvent && item.type === "user_message"
          ? "user"
          : isEvent && item.type === "agent_message"
            ? "assistant"
            : null;
    if (role) {
      const content = isResponse ? text(item.content) : string(item.message);
      if (!content) return;
      const key = `${role}:${hash(content)}`;
      const candidates = unpaired.get(key) || [];
      const pairIndex = candidates.findIndex(
        (candidate) => candidate.isResponse !== isResponse,
      );
      if (pairIndex >= 0) {
        const [pair] = candidates.splice(pairIndex, 1);
        if (isResponse && identifier(item.id)) pair.message.id = String(item.id);
      } else {
        const message = {
          id: identifier(item.id) || `codex-record:${index}`,
          role,
          text: content,
          ...stamp(record.timestamp),
        };
        messages.push(message);
        candidates.push({ isResponse, message });
      }
      unpaired.set(key, candidates);
    }
    if (isResponse && ["function_call", "custom_tool_call"].includes(item.type)) {
      const id = identifier(item.call_id || item.id) || `codex-record:${index}`;
      const images = [];
      const message = {
        id,
        role: "tool",
        text: show(item.arguments ?? item.input, images),
        ...toolFileChanges(item.name, item.arguments ?? item.input),
        toolName: string(item.name) || "Tool",
        status: "running",
        ...stamp(record.timestamp),
      };
      messages.push(message);
      calls.set(id, message);
      callInputs.set(id, { images, input: item.arguments ?? item.input });
      const args = object(parse(item.arguments));
      if (item.name === "update_plan" && !failedCalls.has(id) && Array.isArray(args.plan))
        tasks = taskList(args.plan, "codex-plan");
    }
    if (
      isResponse &&
      ["function_call_output", "custom_tool_call_output"].includes(item.type)
    ) {
      const id = identifier(item.call_id || item.id) || `codex-record:${index}`;
      const call = calls.get(id);
      const pending = callInputs.get(id);
      const images = pending?.images || [];
      const output = body(item.output, images);
      if (call) {
        call.text = join(call.text, output);
        call.status = failedOutput(item) ? "failed" : "completed";
        Object.assign(call, withImages({}, images, pending?.input));
      } else
        messages.push(
          withImages(
            {
              id,
              role: "tool",
              toolName: "Tool",
              text: output,
              status: failedOutput(item) ? "failed" : "completed",
              ...stamp(record.timestamp),
            },
            images,
          ),
        );
    }
  });
  return { messages, tasks };
}

/** OpenCode `export` session envelope. Reasoning and synthetic prompt parts stay internal. */
export function normalizeOpenCode(exported) {
  const messages = new Map();
  let tasks = [];
  list(exported?.messages).forEach((message, messageIndex) => {
    const info = object(message?.info);
    if (!["user", "assistant"].includes(info.role)) return;
    list(message?.parts).forEach((part, index) => {
      if (!part) return;
      const id =
        identifier(part.id) ||
        `${identifier(info.id) || `opencode:${messageIndex}`}:${index}`;
      const timestamp = stamp(info.time?.created);
      if (part.type === "text" && !part.synthetic && !part.ignored && string(part.text)) {
        messages.set(id, {
          id,
          role: info.role,
          text: part.text,
          ...timestamp,
        });
      }
      if (part.type === "tool" && info.role === "assistant") {
        const state = object(part.state);
        const status = toolStatus(state.status);
        const images = [];
        messages.set(
          id,
          withImages(
            {
              id,
              role: "tool",
              toolName: string(part.tool) || "Tool",
              ...toolFileChanges(
                part.tool,
                state.input,
                status === "completed" ? state.metadata : {},
              ),
              text: join(
                show(state.input, images),
                body(state.output, images),
                attachmentPlaceholders(state.attachments, images),
                show(state.error, images),
              ),
              status,
              ...timestamp,
            },
            images,
            state.input,
          ),
        );
        const input = object(parse(state.input));
        if (
          part.tool === "todowrite" &&
          status !== "failed" &&
          Array.isArray(input.todos)
        )
          tasks = taskList(input.todos, "opencode-todo");
      }
    });
  });
  if (Array.isArray(exported?.todos)) tasks = taskList(exported.todos, "opencode-todo");
  return {
    messages: markOpenCodeInput([...messages.values()], list(exported?.messages)),
    tasks,
  };
}
