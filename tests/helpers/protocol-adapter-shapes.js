// Hand-written validators for upstream request shapes and client SSE streams, shared by
// the protocol adapter unit tests and the direction (translator) tests.

import assert from "node:assert/strict";
import { createSseParser } from "../../server/features/protocol-adapter/sse.js";

export const MESSAGES_TOOL_NAME = /^[a-zA-Z0-9_-]{1,128}$/;
export const MESSAGES_TOOL_ID = /^[a-zA-Z0-9_-]+$/;
export const OPENAI_TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

/** Fails when a key of the adapter IR leaks into an upstream body. */
function assertNoKeys(value, path, keys, skip) {
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertNoKeys(item, `${path}[${i}]`, keys, skip));
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (skip(key, path)) continue; // user-defined content
      assert.ok(!keys.has(key), `${path}.${key} is an IR leftover`);
      assertNoKeys(item, `${path}.${key}`, keys, skip);
    }
  }
}

// --- Messages --------------------------------------------------------------------------

const MESSAGES_TOP = new Set([
  "model",
  "max_tokens",
  "system",
  "messages",
  "tools",
  "tool_choice",
  "thinking",
  "output_config",
  "stop_sequences",
  "stream",
]);
const MESSAGES_IR_KEYS = new Set([
  "parts",
  "kind",
  "namespace",
  "cache",
  "carrier",
  "isError",
  "callId",
  "mediaType",
  "hints",
  "summary",
  "redacted",
]);
const MESSAGES_BLOCKS = {
  user: ["text", "image", "tool_result"],
  assistant: ["text", "tool_use", "thinking", "redacted_thinking"],
};

export function countBreakpoints(body) {
  let count = 0;
  const visit = (value) => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") {
      if (value.cache_control) count += 1;
      for (const [key, item] of Object.entries(value)) {
        if (key !== "cache_control" && key !== "input_schema") visit(item);
      }
    }
  };
  visit([body.system, body.tools, body.messages]);
  return count;
}

function assertToolUsesAnswered(messages, message, index, uses) {
  if (uses.length === 0) return;
  const next = messages[index + 1];
  assert.ok(next, "tool_use is followed by a user message");
  const leading = next.content.slice(0, uses.length);
  assert.deepEqual(
    leading.map((block) => block.type),
    uses.map(() => "tool_result"),
  );
  assert.deepEqual(
    new Set(leading.map((block) => block.tool_use_id)),
    new Set(uses.map((use) => use.id)),
  );
}

/** Structural validity of a built Messages request `{ path, body, headers }`. */
export function assertMessagesRequest(built) {
  const { body } = built;
  assert.equal(built.path, "/v1/messages");
  assert.equal(built.headers["anthropic-version"], "2023-06-01");
  for (const key of Object.keys(body)) assert.ok(MESSAGES_TOP.has(key), `top key ${key}`);
  assert.ok(Number.isInteger(body.max_tokens) && body.max_tokens > 0);
  assert.equal(body.messages[0].role, "user");
  body.messages.forEach((message, index) => {
    assert.ok(["user", "assistant"].includes(message.role));
    if (index > 0) assert.notEqual(message.role, body.messages[index - 1].role);
    assert.ok(Array.isArray(message.content) && message.content.length > 0);
    for (const block of message.content) {
      assert.ok(MESSAGES_BLOCKS[message.role].includes(block.type), block.type);
      if (block.type === "text") assert.ok(block.text !== "");
    }
    const uses = message.content.filter((block) => block.type === "tool_use");
    for (const use of uses) {
      assert.match(use.id, MESSAGES_TOOL_ID);
      assert.match(use.name, MESSAGES_TOOL_NAME);
      assert.ok(use.input && typeof use.input === "object" && !Array.isArray(use.input));
    }
    assertToolUsesAnswered(body.messages, message, index, uses);
  });
  for (const tool of body.tools ?? []) {
    assert.match(tool.name, MESSAGES_TOOL_NAME);
    assert.equal(tool.input_schema.type, "object");
  }
  for (const key of ["temperature", "top_p", "top_k"]) assert.ok(!(key in body));
  assert.ok(countBreakpoints(body) <= 4, "at most 4 cache breakpoints");
  if (body.thinking?.type === "enabled") {
    assert.ok(body.thinking.budget_tokens >= 1024);
    assert.ok(body.thinking.budget_tokens < body.max_tokens);
  }
  if (body.thinking) assert.ok(!["any", "tool"].includes(body.tool_choice?.type));
  assertNoKeys(
    body,
    "body",
    MESSAGES_IR_KEYS,
    (key) => key === "input_schema" || key === "input",
  );
}

// --- Responses -------------------------------------------------------------------------

const RESPONSES_TOP = new Set([
  "model",
  "instructions",
  "input",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "reasoning",
  "include",
  "max_output_tokens",
  "temperature",
  "top_p",
  "text",
  "prompt_cache_key",
  "store",
  "stream",
]);
const RESPONSES_IR_KEYS = new Set([
  "parts",
  "kind",
  "namespace",
  "cache",
  "carrier",
  "isError",
  "callId",
  "id",
  "mediaType",
  "data",
]);
const RESPONSES_CONTENT = {
  user: ["input_text", "input_image"],
  developer: ["input_text"],
  assistant: ["output_text"],
};
const skipSchemas = (_key, path) => path.includes(".parameters");

function assertContent(item, where) {
  assert.ok(Array.isArray(item.content) && item.content.length > 0, where);
  for (const part of item.content) {
    assert.ok(RESPONSES_CONTENT[item.role].includes(part.type), `${where} ${part.type}`);
    if (part.type === "input_image") assert.match(part.image_url, /^(data:|https?:)/);
    else assert.equal(typeof part.text, "string");
  }
}

/** Minimal Responses request validator for the item shapes this adapter sends. */
export function assertResponsesRequest(body) {
  for (const key of Object.keys(body))
    assert.ok(RESPONSES_TOP.has(key), `unexpected ${key}`);
  assert.equal(typeof body.model, "string");
  assert.equal(body.store, false);
  assert.ok(Array.isArray(body.input) && body.input.length > 0);
  const toolNames = new Set();
  for (const tool of body.tools ?? []) {
    assert.ok(["function", "custom"].includes(tool.type));
    assert.match(tool.name, OPENAI_TOOL_NAME);
    if (tool.type === "function") assert.equal(typeof tool.strict, "boolean");
    assert.ok(!toolNames.has(tool.name), "tool names are unique");
    toolNames.add(tool.name);
  }
  const open = new Map();
  body.input.forEach((item, index) => {
    const where = `input[${index}]`;
    assert.equal(item.id, undefined, `${where} carries no item id`);
    if (item.type === "message") {
      assert.ok(["user", "developer", "assistant"].includes(item.role), where);
      assertContent(item, where);
    } else if (item.type === "function_call" || item.type === "custom_tool_call") {
      assert.match(item.name, OPENAI_TOOL_NAME);
      assert.ok(toolNames.has(item.name), `${where} names a declared tool`);
      open.set(item.call_id, item.type);
    } else if (item.type.endsWith("_call_output")) {
      const call = open.get(item.call_id);
      assert.ok(call, `${where} answers an open call`);
      assert.equal(item.type, `${call}_output`);
      open.delete(item.call_id);
      assert.ok(typeof item.output === "string" || Array.isArray(item.output));
    } else if (item.type === "reasoning") {
      assert.ok(Array.isArray(item.summary));
      assert.equal(typeof item.encrypted_content, "string");
    } else assert.fail(`${where} unknown type ${item.type}`);
  });
  assert.equal(open.size, 0, "every call has an output");
  assertNoKeys(body.input, "input", RESPONSES_IR_KEYS, skipSchemas);
  assertNoKeys(body.tools ?? [], "tools", RESPONSES_IR_KEYS, skipSchemas);
}

// --- Chat Completions ------------------------------------------------------------------

const CHAT_TOP = new Set([
  "model",
  "messages",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "max_tokens",
  "temperature",
  "top_p",
  "stop",
  "reasoning_effort",
  "response_format",
  "prompt_cache_key",
  "stream",
  "stream_options",
]);
const CHAT_IR_KEYS = new Set([
  "parts",
  "kind",
  "namespace",
  "cache",
  "carrier",
  "isError",
  "callId",
]);

function assertChatRoles(messages, inline) {
  const roles = messages.map((message) => message.role);
  roles.forEach((role, index) => {
    if (index === 0) return;
    assert.ok(
      !(role === "user" && roles[index - 1] === "user"),
      `consecutive user at ${index}`,
    );
    if (!inline)
      assert.ok(role !== "system" || roles[index - 1] === "system", `system at ${index}`);
  });
}

function assertChatMessage(message, where, toolNames, pending) {
  assert.ok(["system", "user", "assistant", "tool"].includes(message.role), where);
  if (message.role === "tool") {
    assert.ok(pending.has(message.tool_call_id), `${where} answers an open tool call`);
    assert.equal(typeof message.content, "string");
    pending.delete(message.tool_call_id);
    return;
  }
  assert.equal(pending.size, 0, `${where}: tool results must follow their calls`);
  if (message.role === "assistant" && message.tool_calls) {
    for (const call of message.tool_calls) {
      assert.equal(call.type, "function");
      assert.match(call.function.name, OPENAI_TOOL_NAME);
      assert.ok(toolNames.has(call.function.name), `${call.function.name} is declared`);
      assert.equal(typeof call.function.arguments, "string");
      JSON.parse(call.function.arguments);
      pending.add(call.id);
    }
  }
  if (typeof message.content !== "string" && message.content !== null) {
    assert.ok(Array.isArray(message.content), `${where} content`);
    for (const part of message.content)
      assert.ok(["text", "image_url"].includes(part.type));
  }
}

/** Minimal Chat Completions request validator (system only leading unless `inline`). */
export function assertChatRequest(body, { inline = false } = {}) {
  assertChatRoles(body.messages, inline);
  for (const key of Object.keys(body)) assert.ok(CHAT_TOP.has(key), `unexpected ${key}`);
  assert.equal(typeof body.model, "string");
  assert.ok(Array.isArray(body.messages) && body.messages.length > 0);
  const toolNames = new Set();
  for (const tool of body.tools ?? []) {
    assert.equal(tool.type, "function");
    assert.match(tool.function.name, OPENAI_TOOL_NAME);
    assert.equal(typeof tool.function.parameters, "object");
    assert.ok(!toolNames.has(tool.function.name), "tool names are unique");
    toolNames.add(tool.function.name);
  }
  const pending = new Set();
  body.messages.forEach((message, index) =>
    assertChatMessage(message, `messages[${index}]`, toolNames, pending),
  );
  assert.equal(pending.size, 0, "every tool call has a result");
  assertNoKeys(body.messages, "messages", CHAT_IR_KEYS, skipSchemas);
}

// --- Client streams --------------------------------------------------------------------

/** Parses SSE text into `{ event, data }` items with JSON data. */
export function parseSseText(text) {
  const parser = createSseParser();
  return [...parser.push(text), ...parser.end()].map(({ event, data }) => ({
    event,
    data: JSON.parse(data),
  }));
}

/**
 * Checks a Claude Code (Messages) stream: `message_start` first, blocks strictly
 * sequential with matching start/delta/stop, then `message_delta` and `message_stop`, or
 * a final `error` event. Returns `{ message, error }` with the assembled message.
 */
export function assertMessagesStream(text) {
  const events = parseSseText(text);
  for (const { event, data } of events) assert.equal(event, data.type);
  const last = events.at(-1).data;
  if (last.type === "error") {
    assert.ok(
      events.slice(0, -1).every(({ data }) => data.type !== "error"),
      "single error",
    );
    return { error: last.error, events: events.map(({ data }) => data) };
  }
  const types = events.map(({ data }) => data.type).filter((type) => type !== "ping");
  assert.equal(types[0], "message_start");
  assert.deepEqual(types.slice(-2), ["message_delta", "message_stop"]);
  const message = structuredClone(events[0].data.message);
  const inputs = new Map();
  let open = null;
  for (const { data } of events.slice(1, -2)) {
    if (data.type === "ping") continue;
    if (data.type === "content_block_start") {
      assert.equal(open, null, "blocks never interleave");
      assert.equal(data.index, message.content.length, "indexes are sequential");
      open = data.index;
      message.content.push(structuredClone(data.content_block));
    } else if (data.type === "content_block_delta") {
      assert.equal(data.index, open, "delta belongs to the open block");
      const block = message.content[open];
      const delta = data.delta;
      if (delta.type === "text_delta") block.text += delta.text;
      else if (delta.type === "thinking_delta") block.thinking += delta.thinking;
      else if (delta.type === "signature_delta") block.signature = delta.signature;
      else if (delta.type === "input_json_delta")
        inputs.set(open, (inputs.get(open) ?? "") + delta.partial_json);
      else assert.fail(`unknown delta ${delta.type}`);
    } else if (data.type === "content_block_stop") {
      assert.equal(data.index, open, "stop closes the open block");
      const block = message.content[open];
      if (block.type === "tool_use") block.input = JSON.parse(inputs.get(open) ?? "{}");
      if (block.type === "thinking") assert.ok(block.signature !== "", "signed");
      open = null;
    } else assert.fail(`unexpected event ${data.type}`);
  }
  assert.equal(open, null, "every block is closed");
  const delta = events.at(-2).data;
  Object.assign(message, delta.delta);
  message.usage = delta.usage;
  return { message, events: events.map(({ data }) => data) };
}

/**
 * Checks a Codex (Responses) stream: sequence numbers from 0, `response.created` first,
 * every item added then done in order, deltas only for the open item, and a terminal
 * `response.completed` (output = done items) or `response.failed`. Returns
 * `{ response, items, events }`.
 */
export function assertResponsesStream(text) {
  const events = parseSseText(text).map(({ event, data }) => {
    assert.equal(event, data.type);
    return data;
  });
  const progress = events.filter((data) => data.type !== "response.in_progress");
  progress.forEach((data, index) => assert.equal(data.sequence_number, index));
  assert.equal(progress[0].type, "response.created");
  const terminal = progress.at(-1);
  assert.ok(["response.completed", "response.failed"].includes(terminal.type));
  const items = [];
  let open = null;
  for (const data of progress.slice(1, -1)) {
    if (data.type === "response.output_item.added") {
      assert.equal(open, null, "items never interleave");
      assert.equal(data.output_index, items.length);
      open = data.item;
    } else if (data.type === "response.output_item.done") {
      assert.equal(data.item.id, open?.id, "done matches the added item");
      items.push(data.item);
      open = null;
    } else {
      assert.ok(data.type.endsWith(".delta"), `unexpected ${data.type}`);
      assert.equal(data.item_id, open?.id, "delta belongs to the open item");
    }
  }
  if (terminal.type === "response.completed") {
    assert.equal(open, null, "every item is done");
    assert.deepEqual(terminal.response.output, items);
  }
  return { response: terminal.response, items, events };
}
