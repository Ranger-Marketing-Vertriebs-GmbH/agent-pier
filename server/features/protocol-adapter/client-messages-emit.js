// Claude Code client (Anthropic Messages wire format): turns adapter IR events into the
// Messages SSE stream or a non-streaming Message object.

import { encodeCarrier } from "./carrier.js";
import { messagesErrorEvent } from "./errors.js";
import { assertIrEvent } from "./ir.js";
import { stopToMessages, usageToMessages } from "./mapping.js";
import { sseEvent } from "./sse.js";

const ZERO_USAGE = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const USAGE_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "reasoning"];
const TRUNCATED = Object.freeze({
  kind: "network",
  message: "upstream stream ended before completion",
});

/** Rejection of `emitMessagesResponse` when the upstream reported an error event. */
export class AdapterUpstreamError extends Error {
  constructor(error) {
    super(error.message);
    this.name = "AdapterUpstreamError";
    this.error = error;
  }
}

function contentBlock(block) {
  if (block.kind === "text") return { type: "text", text: "" };
  if (block.kind === "reasoning")
    return { type: "thinking", thinking: "", signature: "" };
  const { id, name } = block.toolCall;
  return { type: "tool_use", id, name, input: {} };
}

/** Usage counts are cumulative, so the largest value seen per field is the total. */
function mergeUsage(current, event) {
  const merged = { ...(current ?? {}) };
  for (const field of USAGE_FIELDS) {
    merged[field] = Math.max(merged[field] ?? 0, event[field]);
  }
  return merged;
}

/**
 * Stateful translation of IR events into Messages wire events (`{ type, ... }` objects,
 * or `{ type: "error", irError }`). Messages blocks never interleave, so a block that
 * starts while another is open is buffered until the earlier blocks are closed.
 */
function createWireState({ model, messageId, display, origin = "chat" }) {
  const out = [];
  const queue = [];
  const open = new Map();
  let startEvent;
  let started = false;
  let usage;
  let stop;
  let nextIndex = 0;

  const ensureStarted = () => {
    if (started) return;
    started = true;
    out.push({
      type: "message_start",
      message: {
        id: messageId ?? startEvent?.id ?? "msg_adapter",
        type: "message",
        role: "assistant",
        model: model ?? startEvent?.model ?? "",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: usageToMessages(usage ?? ZERO_USAGE),
      },
    });
  };

  const delta = (block, payload) =>
    out.push({ type: "content_block_delta", index: block.wireIndex, delta: payload });

  const activate = (block) => {
    block.wireIndex = nextIndex++;
    out.push({
      type: "content_block_start",
      index: block.wireIndex,
      content_block: contentBlock(block),
    });
    const pending = block.pending;
    block.pending = [];
    for (const event of pending) {
      if (block.closed) break;
      apply(block, event);
    }
  };

  const close = (block) => {
    if (block.kind === "reasoning") {
      const signature = block.carrier ?? encodeCarrier(origin, null);
      delta(block, { type: "signature_delta", signature });
    }
    out.push({ type: "content_block_stop", index: block.wireIndex });
    block.closed = true;
    queue.shift();
    if (queue.length > 0) activate(queue[0]);
  };

  const reasoningText = (event) => {
    if (display === "omitted") return "";
    return event.text ?? event.summary ?? "";
  };

  function apply(block, event) {
    if (event.type === "textDelta") {
      delta(block, { type: "text_delta", text: event.text });
    } else if (event.type === "reasoningDelta") {
      const thinking = reasoningText(event);
      if (thinking !== "") delta(block, { type: "thinking_delta", thinking });
    } else if (event.type === "reasoningCarrier") {
      block.carrier = event.carrier;
    } else if (event.type === "toolInputDelta") {
      delta(block, { type: "input_json_delta", partial_json: event.fragment });
    } else if (event.type === "blockStop") {
      close(block);
    }
  }

  const blockStart = (event) => {
    if (event.kind === "toolCall" && event.toolCall.kind !== "function") {
      throw new TypeError("unexpectedCustomToolCall");
    }
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

  return {
    /** Returns the wire events produced by one IR event; `done` after an error. */
    push(event) {
      assertIrEvent(event);
      if (event.type === "start") startEvent = event;
      else if (event.type === "usage") usage = mergeUsage(usage, event);
      else if (event.type === "stop") stop = event;
      else if (event.type === "error")
        return { wire: [{ type: "error", irError: event.error }], done: true };
      else {
        ensureStarted();
        if (event.type === "blockStart") blockStart(event);
        else blockEvent(event);
      }
      return { wire: out.splice(0), done: false };
    },
    /** Wire events that end the message, or an error when the upstream never stopped. */
    finish() {
      if (!stop) return [{ type: "error", irError: TRUNCATED }];
      ensureStarted();
      finishBlocks();
      out.push(
        {
          type: "message_delta",
          delta: {
            stop_reason: stopToMessages(stop.reason),
            stop_sequence: stop.stopSequence ?? null,
          },
          usage: usageToMessages(usage ?? ZERO_USAGE),
        },
        { type: "message_stop" },
      );
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

function frame(wire) {
  return wire.type === "error"
    ? messagesErrorEvent(wire.irError)
    : sseEvent(wire.type, wire);
}

/**
 * Messages SSE text for IR events. `model` is the model the client requested (echoed so
 * Claude Code keeps replaying thinking), `display` the client's thinking display and
 * `origin` the carrier origin used for reasoning blocks that arrive without a carrier.
 */
export async function* emitMessagesStream(events, options = {}) {
  for await (const wire of wireEvents(events, options)) yield frame(wire);
}

function parseToolInput(text) {
  if (text === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new TypeError("toolInputInvalidJson");
  }
}

function applyDelta(block, payload, inputs, index) {
  if (payload.type === "text_delta") block.text += payload.text;
  else if (payload.type === "thinking_delta") block.thinking += payload.thinking;
  else if (payload.type === "signature_delta") block.signature = payload.signature;
  else if (payload.type === "input_json_delta") {
    inputs.set(index, (inputs.get(index) ?? "") + payload.partial_json);
  }
}

/** Non-streaming Message object built from the same IR events as the stream. */
export async function emitMessagesResponse(events, options = {}) {
  let message;
  const inputs = new Map();
  for await (const wire of wireEvents(events, options)) {
    if (wire.type === "error") throw new AdapterUpstreamError(wire.irError);
    if (wire.type === "message_start") message = structuredClone(wire.message);
    else if (wire.type === "content_block_start") {
      message.content[wire.index] = structuredClone(wire.content_block);
    } else if (wire.type === "content_block_delta") {
      applyDelta(message.content[wire.index], wire.delta, inputs, wire.index);
    } else if (wire.type === "content_block_stop" && inputs.has(wire.index)) {
      message.content[wire.index].input = parseToolInput(inputs.get(wire.index));
    } else if (wire.type === "message_delta") {
      Object.assign(message, wire.delta);
      message.usage = wire.usage;
    }
  }
  return message;
}

/** Keep-alive frame for Claude Code's idle watchdogs. */
export function messagesPing() {
  return sseEvent("ping", { type: "ping" });
}

/** In-stream error frame; the caller ends the stream afterwards (no `message_stop`). */
export function emitMessagesStreamError(error) {
  return messagesErrorEvent(error);
}
