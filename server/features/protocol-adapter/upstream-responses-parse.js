// OpenAI Responses upstream: turns streamed events or a complete response into IR events.

import { encodeCarrier } from "./carrier.js";
import { classifyUpstreamError } from "./errors.js";
import { fallbackCallId, isObject, modelName, nonEmpty, parseData } from "./shared.js";
import { estimatedUsage, stopFromResponses, usageFromOpenAI } from "./mapping.js";

const SUMMARY_SEPARATOR = "\n\n";
const CALL_TYPES = Object.freeze({
  function_call: "function",
  custom_tool_call: "custom",
});

const textOrEmpty = (value) => (typeof value === "string" ? value : "");

function usageEvent(usage) {
  return {
    type: "usage",
    ...usageFromOpenAI({
      prompt: usage.input_tokens,
      completion: usage.output_tokens,
      cached: usage.input_tokens_details?.cached_tokens,
      cacheWrite: usage.input_tokens_details?.cache_write_tokens,
      reasoning: usage.output_tokens_details?.reasoning_tokens,
    }),
  };
}

/** Text of a finished message item: output text and refusal parts in order. */
function messageText(item) {
  const parts = Array.isArray(item.content) ? item.content : [];
  let text = "";
  let refusal = false;
  for (const part of parts) {
    if (part?.type === "output_text") text += textOrEmpty(part.text);
    else if (part?.type === "refusal") {
      refusal = true;
      text += textOrEmpty(part.refusal);
    }
  }
  return { text, refusal };
}

const joinTexts = (parts, type) =>
  (Array.isArray(parts) ? parts : [])
    .filter(
      (part) =>
        part?.type === type || (type === "reasoning_text" && part?.type === "text"),
    )
    .map((part) => textOrEmpty(part.text))
    .join(SUMMARY_SEPARATOR);

/** Synchronous state machine shared by the stream and the non-streaming parser. */
function createResponsesState(ctx) {
  const out = [];
  const items = new Map(); // item key → { kind, index, streamed, ... }
  const aliases = new Map(); // item id → item key
  let started = false;
  let closed = false;
  let nextIndex = 0;
  let sawToolCalls = false;
  let refused = false;
  let outputChars = 0;

  const ensureStarted = (response) => {
    if (started) return;
    started = true;
    out.push({
      type: "start",
      id: nonEmpty(response?.id) ? response.id : "resp",
      model: nonEmpty(response?.model) ? response.model : modelName(ctx.model),
    });
  };

  const keyOf = (event) => {
    const itemId = event.item_id ?? event.item?.id;
    const key = Number.isInteger(event.output_index)
      ? `o${event.output_index}`
      : (aliases.get(itemId) ?? (nonEmpty(itemId) ? `i${itemId}` : "o?"));
    if (nonEmpty(itemId) && !aliases.has(itemId)) aliases.set(itemId, key);
    return key;
  };

  const itemFor = (event, kind) => {
    const key = keyOf(event);
    let item = items.get(key);
    if (!item) {
      item = {
        kind,
        index: null,
        streamed: "",
        raw: "",
        summaryIndex: null,
        done: false,
      };
      items.set(key, item);
    }
    return item;
  };

  const open = (item, toolCall) => {
    if (item.index !== null) return;
    item.index = nextIndex++;
    const event = { type: "blockStart", index: item.index, kind: item.kind };
    if (toolCall) event.toolCall = toolCall;
    out.push(event);
  };

  const close = (item) => {
    if (item.done) return;
    item.done = true;
    if (item.index !== null) out.push({ type: "blockStop", index: item.index });
  };

  const emitText = (item, text) => {
    if (text === "" || item.done) return;
    open(item);
    item.streamed += text;
    outputChars += text.length;
    out.push({ type: "textDelta", index: item.index, text });
  };

  const emitReasoning = (item, field, text) => {
    if (text === "" || item.done) return;
    open(item);
    if (field === "summary") item.streamed += text;
    else item.raw += text;
    outputChars += text.length;
    out.push({ type: "reasoningDelta", index: item.index, [field]: text });
  };

  const emitFragment = (item, fragment) => {
    if (fragment === "" || item.done || item.index === null) return;
    item.streamed += fragment;
    outputChars += fragment.length;
    out.push({ type: "toolInputDelta", index: item.index, fragment });
  };

  /** Emits what the final value adds to the streamed prefix; nothing when they diverge. */
  const remainder = (streamed, final) =>
    final.startsWith(streamed) ? final.slice(streamed.length) : "";

  const startCall = (item, raw) => {
    if (item.index !== null) return;
    const restored = ctx.names.fromUpstream(textOrEmpty(raw.name));
    const toolCall = {
      id: ctx.ids.fromUpstream(
        nonEmpty(raw.call_id) ? raw.call_id : fallbackCallId(ctx, nextIndex),
      ),
      name: restored.name,
      kind: CALL_TYPES[raw.type],
    };
    if (restored.namespace !== undefined) toolCall.namespace = restored.namespace;
    sawToolCalls = true;
    outputChars += toolCall.name.length;
    open(item, toolCall);
  };

  const added = (event) => {
    const raw = event.item;
    if (!isObject(raw)) return;
    if (CALL_TYPES[raw.type]) startCall(itemFor(event, "toolCall"), raw);
    else if (raw.type === "message") itemFor(event, "text");
    else if (raw.type === "reasoning") itemFor(event, "reasoning");
  };

  const finishMessage = (item, raw) => {
    const { text, refusal } = messageText(raw);
    if (refusal) refused = true;
    emitText(item, remainder(item.streamed, text));
  };

  const finishReasoning = (item, raw) => {
    const summary = joinTexts(raw.summary, "summary_text");
    emitReasoning(item, "summary", remainder(item.streamed, summary));
    if (item.streamed === "" && item.raw === "") {
      emitReasoning(item, "text", joinTexts(raw.content, "reasoning_text"));
    }
    if (nonEmpty(raw.encrypted_content)) {
      open(item);
      out.push({
        type: "reasoningCarrier",
        index: item.index,
        carrier: encodeCarrier("responses", raw.encrypted_content),
      });
    }
  };

  const finishCall = (item, raw) => {
    startCall(item, raw);
    const final = raw.type === "custom_tool_call" ? raw.input : raw.arguments;
    const text =
      typeof final === "string" ? final : isObject(final) ? JSON.stringify(final) : "";
    emitFragment(item, remainder(item.streamed, text));
  };

  const itemDone = (event) => {
    const raw = event.item;
    if (!isObject(raw)) return;
    let item;
    if (CALL_TYPES[raw.type]) finishCall((item = itemFor(event, "toolCall")), raw);
    else if (raw.type === "message") finishMessage((item = itemFor(event, "text")), raw);
    else if (raw.type === "reasoning") {
      finishReasoning((item = itemFor(event, "reasoning")), raw);
    }
    if (item) close(item);
  };

  const summaryDelta = (event) => {
    const item = itemFor(event, "reasoning");
    const index = Number.isInteger(event.summary_index) ? event.summary_index : 0;
    let text = textOrEmpty(event.delta);
    if (text === "") return;
    if (
      item.summaryIndex !== null &&
      index !== item.summaryIndex &&
      item.streamed !== ""
    ) {
      text = SUMMARY_SEPARATOR + text;
    }
    item.summaryIndex = index;
    emitReasoning(item, "summary", text);
  };

  const finishBlocks = () => {
    const pending = [...items.values()].filter((item) => !item.done);
    pending.sort((a, b) => (a.index ?? Infinity) - (b.index ?? Infinity));
    pending.forEach(close);
  };

  const fail = (body) => {
    finishBlocks();
    out.push({
      type: "error",
      error: classifyUpstreamError({ protocol: "responses", body }),
    });
    closed = true;
  };

  const complete = (response) => {
    ensureStarted(response);
    finishBlocks();
    if (isObject(response?.usage)) out.push(usageEvent(response.usage));
    else out.push({ type: "usage", ...estimatedUsage(ctx, outputChars) });
    const status = response?.status;
    const reason = response?.incomplete_details?.reason;
    let stop = stopFromResponses(status, reason, sawToolCalls);
    if (refused && (stop === "end" || stop === "toolUse")) stop = "refusal";
    out.push({ type: "stop", reason: stop });
    closed = true;
  };

  const HANDLERS = {
    "response.created": (event) => ensureStarted(event.response),
    "response.output_item.added": added,
    "response.output_item.done": itemDone,
    "response.output_text.delta": (event) =>
      emitText(itemFor(event, "text"), textOrEmpty(event.delta)),
    "response.refusal.delta": (event) => {
      refused = true;
      emitText(itemFor(event, "text"), textOrEmpty(event.delta));
    },
    "response.reasoning_summary_text.delta": summaryDelta,
    "response.reasoning_text.delta": (event) =>
      emitReasoning(itemFor(event, "reasoning"), "text", textOrEmpty(event.delta)),
    "response.function_call_arguments.delta": (event) =>
      emitFragment(itemFor(event, "toolCall"), textOrEmpty(event.delta)),
    "response.custom_tool_call_input.delta": (event) =>
      emitFragment(itemFor(event, "toolCall"), textOrEmpty(event.delta)),
    "response.completed": (event) => complete(event.response),
    "response.incomplete": (event) => complete(event.response),
    "response.failed": (event) => fail(event),
    error: (event) => fail(event),
  };

  const drain = () => out.splice(0);

  return {
    get closed() {
      return closed;
    },
    /** One parsed event; the `type` field wins over the SSE event name. */
    event(json, name) {
      if (closed) return [];
      if (!isObject(json)) {
        fail(json);
        return drain();
      }
      const type = nonEmpty(json.type) ? json.type : name;
      const handler = HANDLERS[type];
      if (handler) {
        if (type !== "error" && type !== "response.failed") ensureStarted(json.response);
        handler(json);
      }
      return drain();
    },
    error(body) {
      if (!closed) fail(body);
      return drain();
    },
    /** End of input without a terminal event: blocks are closed, no stop (truncated). */
    end() {
      if (!closed) finishBlocks();
      closed = true;
      return drain();
    },
  };
}

/** IR events for a Responses SSE stream (`{ event, data }` items from sse.js). */
export async function* parseResponsesStream(sseEvents, ctx) {
  const state = createResponsesState(ctx);
  for await (const { event, data } of sseEvents) {
    if (data.trim() === "[DONE]") break;
    const parsed = parseData(data);
    if (!parsed.ok) yield* state.error(data);
    else yield* state.event(parsed.value, event);
    if (state.closed) return;
  }
  yield* state.end();
}

const TERMINAL = Object.freeze({
  incomplete: "response.incomplete",
  failed: "response.failed",
});

/** IR events for a non-streaming Responses body (the response object). */
export function parseResponsesResponse(json, ctx) {
  const state = createResponsesState(ctx);
  const failed = json?.error !== undefined && json?.error !== null;
  if (!isObject(json) || failed || !Array.isArray(json.output)) {
    return state.error(json);
  }
  const events = [...state.event({ type: "response.created", response: json })];
  json.output.forEach((item, index) => {
    events.push(
      ...state.event({ type: "response.output_item.done", output_index: index, item }),
    );
  });
  const type = TERMINAL[json.status] ?? "response.completed";
  events.push(...state.event({ type, response: json }));
  return events;
}
