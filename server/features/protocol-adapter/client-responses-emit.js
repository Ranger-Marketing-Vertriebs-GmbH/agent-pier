// Codex client (OpenAI Responses wire format): turns adapter IR events into the Responses
// SSE stream or a non-streaming Response object.

import { encodeCarrier } from "./carrier.js";
import { AdapterUpstreamError } from "./client-messages-emit.js";
import { responseShell, responsesErrorStream, responsesFailedEvent } from "./errors.js";
import { assertIrEvent } from "./ir.js";
import { stopToResponses, usageToOpenAI } from "./mapping.js";
import { sseEvent } from "./sse.js";

const ZERO_USAGE = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const USAGE_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "reasoning"];
const TRUNCATED = Object.freeze({
  kind: "network",
  message: "upstream stream ended before completion",
});
const CONTENT_FILTERED = Object.freeze({
  kind: "invalidRequest",
  message: "the upstream content filter blocked the response",
});
const REFUSAL_FALLBACK = "The upstream model declined to respond.";
const ITEM_PREFIXES = Object.freeze({
  message: "msg",
  reasoning: "rs",
  function_call: "fc",
  custom_tool_call: "ctc",
});

/** Usage counts are cumulative, so the largest value seen per field is the total. */
function mergeUsage(current, event) {
  const merged = { ...(current ?? {}) };
  for (const field of USAGE_FIELDS) {
    merged[field] = Math.max(merged[field] ?? 0, event[field]);
  }
  return merged;
}

const toolKey = (name, namespace) => `${namespace ?? ""}\u0000${name}`;

/** Item type for an IR block; function calls of declared custom tools are unwrapped. */
function itemType(block, customTools) {
  if (block.kind === "text") return "message";
  if (block.kind === "reasoning") return "reasoning";
  if (block.toolCall.kind === "custom") return "custom_tool_call";
  const { name, namespace } = block.toolCall;
  if (customTools.has(toolKey(name, namespace))) {
    block.wrapped = true;
    return "custom_tool_call";
  }
  return "function_call";
}

/** Raw custom input from a function-call wrapper `{"input": "..."}`; raw text otherwise. */
function unwrapCustomInput(text) {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed?.input === "string") return parsed.input;
  } catch {
    // Not a wrapper: the upstream sent the raw input.
  }
  return text;
}

function itemSkeleton(type, id, toolCall) {
  if (type === "message") {
    return { type, id, status: "in_progress", role: "assistant", content: [] };
  }
  if (type === "reasoning") return { type, id, summary: [] };
  const namespace = toolCall.namespace ? { namespace: toolCall.namespace } : {};
  const call = { type, id, call_id: toolCall.id, name: toolCall.name, ...namespace };
  return type === "function_call" ? { ...call, arguments: "" } : { ...call, input: "" };
}

/**
 * Stateful translation of IR events into Responses wire events (`{ type, ... }` objects
 * without sequence numbers, or `{ type: "error", irError }`). Items are emitted one at a
 * time, so a block that starts while another is open is buffered until earlier ones end.
 */
function createWireState(options) {
  const { model, responseId, includeEncrypted = false, origin = "chat" } = options;
  const customTools = new Set(
    (options.customTools ?? []).map((tool) => toolKey(tool.name, tool.namespace)),
  );
  const out = [];
  const queue = [];
  const open = new Map();
  const output = [];
  let startEvent;
  let started = false;
  let usage;
  let stop;

  const context = () => ({
    responseId: responseId ?? startEvent?.id ?? "resp_adapter",
    model: model ?? startEvent?.model ?? "",
    createdAt: options.createdAt,
  });

  const ensureStarted = () => {
    if (started) return;
    started = true;
    out.push({
      type: "response.created",
      response: responseShell(context(), "in_progress"),
    });
  };

  const activate = (block) => {
    const outputIndex = output.length;
    const type = itemType(block, customTools);
    const id = `${ITEM_PREFIXES[type]}_${context().responseId}_${outputIndex}`;
    Object.assign(block, { type, id, outputIndex, text: "" });
    out.push({
      type: "response.output_item.added",
      output_index: outputIndex,
      item: itemSkeleton(type, id, block.toolCall),
    });
    const pending = block.pending;
    block.pending = [];
    for (const event of pending) {
      if (block.closed) break;
      apply(block, event);
    }
  };

  const delta = (block, type, extra, text) => {
    block.text += text;
    out.push({
      type,
      item_id: block.id,
      output_index: block.outputIndex,
      ...extra,
      delta: text,
    });
  };

  const customDelta = (block, text) =>
    delta(
      block,
      "response.custom_tool_call_input.delta",
      { call_id: block.toolCall.id },
      text,
    );

  const completeItem = (block) => {
    const item = itemSkeleton(block.type, block.id, block.toolCall);
    if (block.type === "message") {
      item.status = "completed";
      item.content = [{ type: "output_text", text: block.text, annotations: [] }];
    } else if (block.type === "reasoning") {
      if (block.text !== "") item.summary = [{ type: "summary_text", text: block.text }];
      item.encrypted_content = includeEncrypted
        ? (block.carrier ?? encodeCarrier(origin, null))
        : null;
    } else if (block.type === "function_call") {
      item.arguments = block.text;
    } else {
      item.input = block.text;
    }
    return item;
  };

  const close = (block) => {
    if (block.wrapped) {
      const raw = block.text;
      block.text = "";
      const unwrapped = unwrapCustomInput(raw);
      if (unwrapped !== "") customDelta(block, unwrapped);
    }
    const item = completeItem(block);
    out.push({
      type: "response.output_item.done",
      output_index: block.outputIndex,
      item,
    });
    output.push(item);
    block.closed = true;
    queue.shift();
    if (queue.length > 0) activate(queue[0]);
  };

  const reasoningDelta = (block, event) => {
    // Summary text is preferred; raw reasoning text fills in while no summary arrived.
    if (event.summary !== undefined) block.hasSummary = true;
    const text = event.summary ?? (block.hasSummary ? undefined : event.text);
    if (text === undefined || text === "") return;
    delta(block, "response.reasoning_summary_text.delta", { summary_index: 0 }, text);
  };

  const toolInput = (block, fragment) => {
    if (block.wrapped) block.text += fragment;
    else if (block.type === "custom_tool_call") customDelta(block, fragment);
    else delta(block, "response.function_call_arguments.delta", {}, fragment);
  };

  function apply(block, event) {
    if (event.type === "textDelta") {
      delta(block, "response.output_text.delta", { content_index: 0 }, event.text);
    } else if (event.type === "reasoningDelta") reasoningDelta(block, event);
    else if (event.type === "reasoningCarrier") block.carrier = event.carrier;
    else if (event.type === "toolInputDelta") toolInput(block, event.fragment);
    else if (event.type === "blockStop") close(block);
  }

  const blockStart = (event) => {
    if (open.has(event.index)) throw new TypeError("duplicateBlockIndex");
    const block = { kind: event.kind, toolCall: event.toolCall, pending: [] };
    open.set(event.index, block);
    queue.push(block);
    if (queue.length === 1) activate(block);
  };

  const blockEvent = (event) => {
    const block = open.get(event.index);
    if (!block) throw new TypeError("unknownBlockIndex");
    if (event.type === "blockStop") open.delete(event.index);
    if (block === queue[0]) apply(block, event);
    else block.pending.push(event);
  };

  const finishBlocks = () => {
    // The queue head is always active; closing it activates the next buffered block.
    while (queue.length > 0) apply(queue[0], { type: "blockStop" });
    open.clear();
  };

  const fail = (irError) => {
    ensureStarted();
    out.push({ type: "error", irError, context: context() });
    return out.splice(0);
  };

  const refusalItem = () => {
    if (output.some((item) => item.type === "message")) return;
    const block = { kind: "text", pending: [] };
    queue.push(block);
    activate(block);
    apply(block, { type: "textDelta", text: REFUSAL_FALLBACK });
    close(block);
  };

  return {
    /** Returns the wire events produced by one IR event; `done` after an error. */
    push(event) {
      assertIrEvent(event);
      if (event.type === "start") startEvent = event;
      else if (event.type === "usage") usage = mergeUsage(usage, event);
      else if (event.type === "stop") stop = event;
      else if (event.type === "error") return { wire: fail(event.error), done: true };
      else {
        ensureStarted();
        if (event.type === "blockStart") blockStart(event);
        else blockEvent(event);
      }
      return { wire: out.splice(0), done: false };
    },
    /** Wire events that end the response, or an error when the upstream never stopped. */
    finish() {
      if (!stop) return fail(TRUNCATED);
      ensureStarted();
      finishBlocks();
      const { status, refusalAsText } = stopToResponses(stop.reason);
      if (status === "failed") return fail(CONTENT_FILTERED);
      if (refusalAsText) refusalItem();
      out.push({
        type: "response.completed",
        response: {
          ...responseShell(context(), "completed"),
          output,
          usage: usageToOpenAI(usage ?? ZERO_USAGE),
        },
      });
      return out.splice(0);
    },
  };
}

async function* wireEvents(events, options = {}) {
  const state = createWireState(options);
  for await (const event of events) {
    const { wire, done } = state.push(event);
    yield* wire;
    if (done) return;
  }
  yield* state.finish();
}

/**
 * Responses SSE text for IR events. `model` and `responseId` are echoed to Codex,
 * `includeEncrypted` adds reasoning carriers as `encrypted_content`, `origin` names the
 * carrier origin for reasoning without a carrier, and `customTools` (`{ name, namespace? }`)
 * lists the client's custom tools whose calls an upstream returned as function calls.
 */
export async function* emitResponsesStream(events, options = {}) {
  let sequence = 0;
  for await (const wire of wireEvents(events, options)) {
    if (wire.type === "error") {
      yield responsesFailedEvent(wire.irError, {
        ...wire.context,
        sequenceNumber: sequence++,
      });
      return;
    }
    const { type, ...rest } = wire;
    yield sseEvent(type, { type, sequence_number: sequence++, ...rest });
  }
}

/** Non-streaming Response object: the `response` of the stream's `response.completed`. */
export async function emitResponsesResponse(events, options = {}) {
  let response;
  for await (const wire of wireEvents(events, options)) {
    if (wire.type === "error") throw new AdapterUpstreamError(wire.irError);
    if (wire.type === "response.completed") response = wire.response;
  }
  return response;
}

/** Keep-alive for Codex's idle timer, which ignores SSE comments. */
export function responsesKeepalive(responseId) {
  return sseEvent("response.in_progress", {
    type: "response.in_progress",
    response: { id: responseId, object: "response", status: "in_progress" },
  });
}

/** Complete error stream (`response.created` then `response.failed`) before any output. */
export function emitResponsesStreamError(error, options = {}) {
  return responsesErrorStream(error, options);
}
