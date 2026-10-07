// Anthropic Messages upstream: turns streamed events or a complete Message into IR events.

import { encodeCarrier } from "./carrier.js";
import { classifyUpstreamError } from "./errors.js";
import { fallbackCallId, isObject, modelName, nonEmpty, parseData } from "./shared.js";
import { estimatedUsage, stopFromMessages, usageFromMessages } from "./mapping.js";

/**
 * Carrier payload for a Messages thinking block: JSON `{"s": signature, "t": text}` for
 * `thinking` and `{"r": data}` for `redacted_thinking`. Anthropic rejects thinking blocks
 * that are not passed back byte-exact, so the text travels with the signature and the
 * client's (possibly summarized or edited) reasoning text is never replayed.
 */
export function encodeThinkingPayload({ signature, text, redacted }) {
  return JSON.stringify(
    redacted !== undefined ? { r: redacted } : { s: signature, t: text },
  );
}

/**
 * Messages content block for a carrier payload, or null. A payload that is not JSON is a
 * plain signature (legacy) and is replayed with empty thinking text.
 */
export function thinkingBlockFromPayload(payload) {
  if (typeof payload !== "string" || payload === "") return null;
  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return { type: "thinking", thinking: "", signature: payload };
  }
  if (!isObject(parsed)) return null;
  if (typeof parsed.r === "string") return { type: "redacted_thinking", data: parsed.r };
  if (typeof parsed.s !== "string" || parsed.s === "") return null;
  const thinking = typeof parsed.t === "string" ? parsed.t : "";
  return { type: "thinking", thinking, signature: parsed.s };
}

/** Usage fields of a Messages usage object; absent fields keep their previous value. */
function mergeUsage(previous, usage) {
  if (!isObject(usage)) return previous;
  const pick = (field, key) =>
    Number.isFinite(usage[field]) ? usage[field] : previous[key];
  return {
    input: pick("input_tokens", "input"),
    output: pick("output_tokens", "output"),
    cacheRead: pick("cache_read_input_tokens", "cacheRead"),
    cacheWrite: pick("cache_creation_input_tokens", "cacheWrite"),
  };
}

/** Synchronous state machine shared by the stream and the non-streaming parser. */
function createMessagesState(ctx) {
  const out = [];
  const blocks = new Map(); // upstream index → block state
  let started = false;
  let closed = false;
  let nextIndex = 0;
  let totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let usageDirty = false;
  let usageSent = false;
  let stopReason = null;
  let stopSequence = null;
  let outputChars = 0;

  const ensureStarted = (message) => {
    if (started) return;
    started = true;
    out.push({
      type: "start",
      id: nonEmpty(message?.id) ? message.id : "msg",
      model: nonEmpty(message?.model) ? message.model : modelName(ctx.model),
    });
  };

  const addUsage = (usage) => {
    if (!isObject(usage)) return;
    totals = mergeUsage(totals, usage);
    usageDirty = true;
  };

  const flushUsage = () => {
    if (!usageDirty) return;
    usageDirty = false;
    usageSent = true;
    out.push({ type: "usage", ...usageFromMessages(totals) });
  };

  const open = (upstreamIndex, kind, extra = {}) => {
    const block = {
      kind,
      index: nextIndex++,
      signature: "",
      text: "",
      input: null,
      deltas: 0,
    };
    blocks.set(upstreamIndex, block);
    out.push({ type: "blockStart", index: block.index, kind, ...extra });
    return block;
  };

  const toolCallOf = (content) => {
    const restored = ctx.names.fromUpstream(content.name ?? "");
    const toolCall = {
      id: ctx.ids.fromUpstream(
        nonEmpty(content.id) ? content.id : fallbackCallId(ctx, nextIndex),
      ),
      name: restored.name,
      kind: "function",
    };
    if (restored.namespace !== undefined) toolCall.namespace = restored.namespace;
    return toolCall;
  };

  const carrier = (block, payload) => {
    out.push({
      type: "reasoningCarrier",
      index: block.index,
      carrier: encodeCarrier("messages", payload),
    });
  };

  const textDelta = (block, text) => {
    if (!nonEmpty(text)) return;
    outputChars += text.length;
    out.push({ type: "textDelta", index: block.index, text });
  };
  const thinkingDelta = (block, text) => {
    if (!nonEmpty(text)) return;
    outputChars += text.length;
    block.text += text; // replayed byte-exact through the carrier
    out.push({ type: "reasoningDelta", index: block.index, text });
  };
  const inputDelta = (block, fragment) => {
    if (!nonEmpty(fragment)) return;
    outputChars += fragment.length;
    block.deltas += 1;
    out.push({ type: "toolInputDelta", index: block.index, fragment });
  };

  const startBlock = (upstreamIndex, content) => {
    if (!isObject(content) || blocks.has(upstreamIndex)) return;
    if (content.type === "text") {
      textDelta(open(upstreamIndex, "text"), content.text);
    } else if (content.type === "thinking") {
      const block = open(upstreamIndex, "reasoning");
      thinkingDelta(block, content.thinking);
      if (nonEmpty(content.signature)) block.signature = content.signature;
    } else if (content.type === "redacted_thinking") {
      const block = open(upstreamIndex, "reasoning");
      if (typeof content.data === "string") block.redacted = content.data;
    } else if (content.type === "tool_use") {
      const toolCall = toolCallOf(content);
      outputChars += toolCall.name.length;
      const block = open(upstreamIndex, "toolCall", { toolCall });
      if (isObject(content.input) && Object.keys(content.input).length > 0) {
        block.input = JSON.stringify(content.input);
      }
    }
    // Server tool blocks and unknown block types have no IR equivalent and are skipped.
  };

  const deltaBlock = (upstreamIndex, delta) => {
    const block = blocks.get(upstreamIndex);
    if (!block || !isObject(delta)) return;
    if (delta.type === "text_delta" && block.kind === "text")
      textDelta(block, delta.text);
    else if (delta.type === "thinking_delta" && block.kind === "reasoning") {
      thinkingDelta(block, delta.thinking);
    } else if (delta.type === "signature_delta" && block.kind === "reasoning") {
      if (typeof delta.signature === "string") block.signature += delta.signature;
    } else if (delta.type === "input_json_delta" && block.kind === "toolCall") {
      inputDelta(block, delta.partial_json);
    }
  };

  const stopBlock = (upstreamIndex) => {
    const block = blocks.get(upstreamIndex);
    if (!block) return;
    blocks.delete(upstreamIndex);
    if (block.kind === "reasoning") {
      if (block.redacted !== undefined) {
        carrier(block, encodeThinkingPayload({ redacted: block.redacted }));
      } else if (block.signature !== "") {
        carrier(
          block,
          encodeThinkingPayload({ signature: block.signature, text: block.text }),
        );
      }
    } else if (block.kind === "toolCall" && block.deltas === 0 && block.input !== null) {
      inputDelta(block, block.input);
    }
    out.push({ type: "blockStop", index: block.index });
  };

  const closeOpenBlocks = () => {
    for (const key of [...blocks.keys()].sort((a, b) => a - b)) stopBlock(key);
  };

  const fail = (body) => {
    closeOpenBlocks();
    out.push({
      type: "error",
      error: classifyUpstreamError({ protocol: "messages", body }),
    });
    closed = true;
  };

  const complete = () => {
    ensureStarted(null);
    closeOpenBlocks();
    if (!usageSent && !usageDirty) {
      // No upstream usage at all: estimate it, flagged, so compaction keeps working.
      out.push({ type: "usage", ...estimatedUsage(ctx, outputChars) });
    }
    flushUsage();
    const stop = { type: "stop", reason: stopFromMessages(stopReason) };
    if (nonEmpty(stopSequence)) stop.stopSequence = stopSequence;
    out.push(stop);
    closed = true;
  };

  const drain = () => out.splice(0);

  const handlers = {
    message_start(json) {
      ensureStarted(json.message);
      addUsage(json.message?.usage);
    },
    content_block_start(json) {
      ensureStarted(null);
      startBlock(json.index, json.content_block);
    },
    content_block_delta(json) {
      deltaBlock(json.index, json.delta);
    },
    content_block_stop(json) {
      stopBlock(json.index);
    },
    message_delta(json) {
      ensureStarted(null);
      if (nonEmpty(json.delta?.stop_reason)) stopReason = json.delta.stop_reason;
      if (nonEmpty(json.delta?.stop_sequence)) stopSequence = json.delta.stop_sequence;
      addUsage(json.usage);
      flushUsage();
    },
    message_stop() {
      complete();
    },
    error(json) {
      fail(json);
    },
  };

  return {
    get closed() {
      return closed;
    },
    /** One parsed event payload; the SSE event name falls back to `data.type`. */
    event(name, json) {
      if (closed) return [];
      if (!isObject(json)) {
        fail(json);
        return drain();
      }
      const type = name === "error" || json.type === "error" ? "error" : json.type;
      if (Object.hasOwn(handlers, type)) handlers[type](json); // ping/unknown ignored
      return drain();
    },
    error(body) {
      if (!closed) fail(body);
      return drain();
    },
    /** End of input without `message_stop`: truncated, no stop event. */
    end() {
      if (!closed) closeOpenBlocks();
      closed = true;
      return drain();
    },
    message(json) {
      ensureStarted(json);
      json.content.forEach((content, index) => {
        startBlock(index, content);
        stopBlock(index);
      });
      stopReason = json.stop_reason;
      stopSequence = json.stop_sequence;
      addUsage(json.usage);
      complete();
      return drain();
    },
  };
}

/** IR events for a Messages SSE stream (`{ event, data }` items from sse.js). */
export async function* parseMessagesStream(sseEvents, ctx) {
  const state = createMessagesState(ctx);
  for await (const { event, data } of sseEvents) {
    const parsed = parseData(data);
    if (parsed.ok) yield* state.event(event, parsed.value);
    else yield* state.error(data);
    if (state.closed) return;
  }
  yield* state.end();
}

/** IR events for a non-streaming Messages response body (a Message or an error body). */
export function parseMessagesResponse(json, ctx) {
  const state = createMessagesState(ctx);
  if (!isObject(json) || json.type === "error" || !Array.isArray(json.content)) {
    return state.error(json);
  }
  return state.message(json);
}
