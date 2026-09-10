import { normalizeClaude } from "./history-parsers.js";
import { createClaudeObserver } from "./claude-observability.js";

const list = (value) => (Array.isArray(value) ? value : []);
const object = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};
const string = (value) => (typeof value === "string" ? value : "");
const identifier = (value) =>
  ["string", "number"].includes(typeof value) ? String(value) : "";
const parse = (value) => {
  try {
    return typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    return null;
  }
};
const taskTools = new Set(["TodoWrite", "TaskCreate", "TaskUpdate"]);

function taskInput(name, value) {
  const input = object(parse(value));
  if (name === "TodoWrite")
    return Array.isArray(input.todos)
      ? {
          todos: input.todos.map((value) => {
            const entry = object(value);
            return {
              id: identifier(entry.id),
              content: string(entry.content || entry.step || entry.text || entry.subject),
              status: string(entry.status),
            };
          }),
        }
      : {};
  return {
    subject: string(input.subject),
    ...(name === "TaskUpdate"
      ? { taskId: identifier(input.taskId), status: string(input.status) }
      : {}),
  };
}
function createdTask(value) {
  const raw =
    typeof value === "string"
      ? value
      : list(value)
          .filter((block) =>
            ["text", "input_text", "output_text", "inputText"].includes(block?.type),
          )
          .map((block) => string(block.text))
          .join("\n");
  const parsed = object(parse(raw) || value);
  const task = object(parsed.task || parsed);
  const id =
    identifier(task.id || task.taskId) ||
    raw.match(/^Task #([^\s]+) created successfully:/)?.[1];
  return id
    ? {
        id,
        // A truthy non-string subject suppresses the input fallback in normalizeClaude.
        subject: typeof task.subject === "string" ? task.subject : Boolean(task.subject),
        status: string(task.status),
      }
    : null;
}

/** Forward-only metadata, with no retained ordinary conversation or command output. */
export class ClaudeHistoryMetadata {
  #records = [];
  #calls = new Set();
  #messageIds = new Set();
  #bytes = 0;
  #index = 0;
  #tasks = [];
  #dirty = false;
  #truncated = false;
  #observer;
  constructor({ maxRecords = 4096, maxBytes = 8 * 1024 * 1024, maxEntries = 4096 } = {}) {
    this.maxRecords = maxRecords;
    this.maxBytes = maxBytes;
    this.#observer = createClaudeObserver({ maxEntries, compact: true });
  }
  update(records) {
    for (const record of list(records)) {
      this.#observer.update([record]);
      const index = this.#index++;
      if (
        this.#truncated ||
        !record ||
        !["assistant", "user"].includes(record.type) ||
        record.isMeta ||
        record.isCompactSummary
      )
        continue;
      const message = object(record.message);
      if (message.role && message.role !== record.type) continue;
      const id = identifier(message.id || record.uuid) || `claude:${index}`;
      const content = list(message.content).map((block) => {
        if (
          record.type === "assistant" &&
          block?.type === "tool_use" &&
          taskTools.has(block.name)
        ) {
          if (identifier(block.id)) this.#calls.add(identifier(block.id));
          return {
            type: "tool_use",
            id: block.id,
            name: block.name,
            input: taskInput(block.name, block.input),
          };
        }
        if (block?.type === "tool_result" && identifier(block.tool_use_id)) {
          const created = createdTask(block.content);
          if (this.#calls.has(identifier(block.tool_use_id)) || block.is_error || created)
            return {
              type: "tool_result",
              tool_use_id: block.tool_use_id,
              is_error: Boolean(block.is_error),
              content: created || "",
            };
        }
        // Preserve block positions and explicit-ID overwrites, without their payload.
        return block?.id ? { id: block.id, type: block.type } : null;
      });
      const relevant = content.some(
        (block) => block?.name || block?.type === "tool_result",
      );
      if (!relevant && !this.#messageIds.has(id)) continue;
      this.#messageIds.add(id);
      const compact = {
        type: record.type,
        message: { id, content: typeof message.content === "string" ? "" : content },
      };
      const bytes = Buffer.byteLength(JSON.stringify(compact));
      if (
        this.#records.length >= this.maxRecords ||
        this.#bytes + bytes > this.maxBytes
      ) {
        // Retain the last fully understood state. Dropping old creates/results and
        // replaying a suffix could silently erase active tasks or undo deletions.
        this.#refreshTasks();
        this.#records = [];
        this.#calls.clear();
        this.#messageIds.clear();
        this.#bytes = 0;
        this.#truncated = true;
        continue;
      }
      this.#records.push(compact);
      this.#bytes += bytes;
      this.#dirty = true;
    }
    return this;
  }
  #refreshTasks() {
    if (!this.#dirty) return;
    this.#tasks = normalizeClaude(this.#records).tasks;
    this.#dirty = false;
  }
  snapshot() {
    this.#refreshTasks();
    const observability = this.#observer.snapshot();
    return {
      tasks: this.#tasks.map((task) => ({ ...task })),
      observability: { ...observability, stale: observability.stale || this.#truncated },
    };
  }
  stats() {
    return {
      records: this.#records.length,
      bytes: this.#bytes,
      truncated: this.#truncated,
    };
  }
}
