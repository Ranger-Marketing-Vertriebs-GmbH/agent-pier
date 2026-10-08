// Codex client (OpenAI Responses wire format): turns adapter IR events into the Responses
// SSE stream or a non-streaming Response object.

import { encodeCarrier } from "./carrier.js";
import {
  AdapterUpstreamError,
  responseShell,
  responsesErrorStream,
  responsesFailedEvent,
} from "./errors.js";
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

/** Block kind each IR delta event belongs to (`blockStop` fits every kind). */
const DELTA_KINDS = Object.freeze({
  textDelta: "text",
  reasoningDelta: "reasoning",
  reasoningCarrier: "reasoning",
  toolInputDelta: "toolCall",
});

const nonEmptyText = (value) => typeof value === "string" && value !== "";

const toolKey = (name, namespace) => `${namespace ?? ""}\u0000${name}`;

/** True for a function call of a declared custom tool (its `{"input": …}` is unwrapped). */
function isWrappedCustomCall(block, customTools) {
  if (block.kind !== "toolCall" || block.toolCall.kind === "custom") return false;
  return customTools.has(toolKey(block.toolCall.name, block.toolCall.namespace));
}

/** Item type for an IR block (`wrapped`: a function call of a declared custom tool). */
function itemType(block, wrapped) {
  if (block.kind === "text") return "message";
  if (block.kind === "reasoning") return "reasoning";
  return block.toolCall.kind === "custom" || wrapped
    ? "custom_tool_call"
    : "function_call";
}

const WRAPPER_START = /^\s*\{\s*"input"\s*:\s*"/;

const ESCAPES = Object.freeze({
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
});

/**
 * Decoded value of a JSON string whose closing quote may be missing (`text` starts right
 * after the opening quote). Decoding stops at the closing quote or at an escape that was
 * cut off; unknown escapes keep the escaped character.
 */
function partialJsonString(text) {
  let value = "";
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"') break;
    if (char !== "\\") {
      value += char;
      continue;
    }
    const next = text[i + 1];
    if (next === undefined) break;
    if (next === "u") {
      const hex = text.slice(i + 2, i + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
      value += String.fromCharCode(Number.parseInt(hex, 16));
      i += 5;
    } else {
      value += Object.hasOwn(ESCAPES, next) ? ESCAPES[next] : next;
      i += 1;
    }
  }
  return value;
}

/**
 * Raw custom input from a function-call wrapper `{"input": "..."}`. A wrapper that was
 * cut off (e.g. by `max_tokens`) is unwrapped best-effort to the partial string value;
 * anything else is passed through as raw text.
 */
function unwrapCustomInput(text) {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed?.input === "string") return parsed.input;
    return text;
  } catch {
    const start = WRAPPER_START.exec(text);
    return start ? partialJsonString(text.slice(start[0].length)) : text;
  }
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
    const wrapped = isWrappedCustomCall(block, customTools);
    const type = itemType(block, wrapped);
    const id = `${ITEM_PREFIXES[type]}_${context().responseId}_${outputIndex}`;
    Object.assign(block, { type, id, outputIndex, wrapped, text: "", raw: "" });
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
      if (block.raw !== "") item.content = [{ type: "reasoning_text", text: block.raw }];
      item.encrypted_content = includeEncrypted
        ? (block.carrier ?? encodeCarrier(origin, null))
        : null;
    } else if (block.type === "function_call") {
      // A parameterless call arrives without argument text; Codex parses `""` as a JSON
      // error ("EOF"), so it gets the empty object.
      item.arguments = block.text === "" ? "{}" : block.text;
    } else {
      item.input = block.text;
    }
    return item;
  };

  const closeReasoning = (block) => {
    if (!block.hasSummary && block.raw !== "") {
      // No summary arrived: the buffered raw reasoning becomes the visible summary.
      const raw = block.raw;
      block.raw = "";
      summaryDelta(block, raw);
    } else if (block.raw !== "") {
      out.push({
        type: "response.reasoning_text.delta",
        item_id: block.id,
        output_index: block.outputIndex,
        content_index: 0,
        delta: block.raw,
      });
    }
    if (block.text === "") return;
    out.push({
      type: "response.reasoning_summary_text.done",
      item_id: block.id,
      output_index: block.outputIndex,
      summary_index: 0,
      text: block.text,
    });
  };

  const close = (block) => {
    if (block.wrapped) {
      const raw = block.text;
      block.text = "";
      const unwrapped = unwrapCustomInput(raw);
      if (unwrapped !== "") customDelta(block, unwrapped);
    }
    if (block.type === "reasoning") closeReasoning(block);
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

  const summaryDelta = (block, text) =>
    delta(block, "response.reasoning_summary_text.delta", { summary_index: 0 }, text);

  /**
   * Summary and raw reasoning text are never mixed. Only a Responses upstream can send
   * summaries, so for that origin raw text is buffered until the block ends: it becomes
   * the summary when no summary arrived, else the item's `reasoning_text` content (which
   * Codex shows only with raw reasoning enabled). Other origins stream raw text as the
   * summary right away (they have no summary channel).
   */
  const reasoningDelta = (block, event) => {
    if (nonEmptyText(event.summary)) {
      block.hasSummary = true;
      summaryDelta(block, event.summary);
    }
    if (!nonEmptyText(event.text)) return;
    if (origin === "responses" || block.hasSummary) block.raw += event.text;
    else summaryDelta(block, event.text);
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
    const kind = DELTA_KINDS[event.type];
    if (kind !== undefined && kind !== block.kind)
      throw new TypeError("deltaKindMismatch");
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

/**
 * Keep-alive for Codex's idle timer, which ignores SSE comments. It carries no
 * `sequence_number`: keep-alives are not counted as frames, so the numbering of the real
 * frames stays gapless, and Codex ignores `response.in_progress` (facts §3.5).
 */
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
