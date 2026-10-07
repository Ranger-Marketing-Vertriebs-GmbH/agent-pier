// Chat Completions upstream: turns streamed chunks or a complete response into IR events.

import { encodeCarrier } from "./carrier.js";
import { classifyUpstreamError } from "./errors.js";
import { fallbackCallId, isObject, modelName, nonEmpty, parseData } from "./shared.js";
import { estimatedUsage, stopFromChat, usageFromOpenAI } from "./mapping.js";

const OPEN_TAG = "<think>";
const CLOSE_TAG = "</think>";

/** Length of the longest suffix of `text` that is a proper prefix of `tag`. */
function heldPrefix(text, tag) {
  for (let length = Math.min(text.length, tag.length - 1); length > 0; length -= 1) {
    if (tag.startsWith(text.slice(-length))) return length;
  }
  return 0;
}

/**
 * Splits content into reasoning and text when it opens with `<think>` (leading whitespace
 * allowed). Only that first block is extracted; later tags are left as text. Tags split
 * across chunks are held back until they can be decided.
 */
function createThinkSplitter(emitReasoning, emitText) {
  let mode = "probe";
  let held = "";
  let trimNext = false;

  const emit = (kind, text) => {
    let value = text;
    if (trimNext) {
      value = value.replace(/^\s+/, "");
      if (value === "") return;
      trimNext = false;
    }
    if (value === "") return;
    if (kind === "reasoning") emitReasoning(value);
    else emitText(value);
  };

  const think = (text) => {
    const at = text.indexOf(CLOSE_TAG);
    if (at !== -1) {
      emit("reasoning", text.slice(0, at));
      mode = "text";
      trimNext = true;
      emit("text", text.slice(at + CLOSE_TAG.length));
      return;
    }
    const keep = heldPrefix(text, CLOSE_TAG);
    emit("reasoning", text.slice(0, text.length - keep));
    held = text.slice(text.length - keep);
  };

  const probe = (text) => {
    const trimmed = text.replace(/^\s+/, "");
    if (trimmed.startsWith(OPEN_TAG)) {
      mode = "think";
      trimNext = true;
      think(trimmed.slice(OPEN_TAG.length));
    } else if (OPEN_TAG.startsWith(trimmed)) {
      held = text;
    } else {
      mode = "text";
      emit("text", text);
    }
  };

  return {
    push(text) {
      const input = held + text;
      held = "";
      if (mode === "probe") probe(input);
      else if (mode === "think") think(input);
      else emit("text", input);
    },
    flush() {
      const rest = held;
      held = "";
      if (rest === "") return;
      if (mode === "think") emit("reasoning", rest);
      else {
        trimNext = false;
        emitText(rest);
      }
    },
  };
}

/** Argument fragments are strings; servers that send a parsed object get it serialized. */
function argumentsText(value) {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  return JSON.stringify(value);
}

function usageEvent(usage) {
  const prompt = usage.prompt_tokens_details ?? {};
  const completion = usage.completion_tokens_details ?? {};
  return {
    type: "usage",
    ...usageFromOpenAI({
      prompt: usage.prompt_tokens,
      completion: usage.completion_tokens,
      cached: prompt.cached_tokens,
      cacheWrite: prompt.cache_write_tokens,
      reasoning: completion.reasoning_tokens,
    }),
  };
}

/** Synchronous state machine shared by the stream and the non-streaming parser. */
function createChatState(ctx) {
  const out = [];
  const replay = ctx.capabilities?.reasoningReplay === true;
  let started = false;
  let nextIndex = 0;
  let current = null; // open reasoning or text block
  const calls = new Map(); // chat tool index → call state
  let finishReason = null;
  let sawToolCalls = false;
  let usageSeen = false;
  let outputChars = 0;
  let closed = false;
  let streamId = "chatcmpl";
  let heldSpace = "";

  const ensureStarted = (chunk) => {
    if (started) return;
    started = true;
    if (nonEmpty(chunk?.id)) streamId = chunk.id;
    out.push({
      type: "start",
      id: streamId,
      model: nonEmpty(chunk?.model) ? chunk.model : modelName(ctx.model),
    });
  };

  const closeCurrent = () => {
    if (!current) return;
    if (current.kind === "reasoning" && replay && current.text !== "") {
      out.push({
        type: "reasoningCarrier",
        index: current.index,
        carrier: encodeCarrier("chat", current.text),
      });
    }
    out.push({ type: "blockStop", index: current.index });
    current = null;
  };

  const appendBlock = (kind, value) => {
    let text = value;
    if (kind === "text" && current?.kind !== "text") {
      // A text block opens only for visible text; leading whitespace waits for it.
      text = heldSpace + text;
      heldSpace = "";
      if (text.trim() === "") {
        heldSpace = text;
        return;
      }
    }
    if (text === "") return;
    if (current?.kind !== kind) {
      closeCurrent();
      current = { kind, index: nextIndex++, text: "" };
      out.push({ type: "blockStart", index: current.index, kind });
    }
    outputChars += text.length;
    if (kind === "reasoning") current.text += text;
    out.push(
      kind === "text"
        ? { type: "textDelta", index: current.index, text }
        : { type: "reasoningDelta", index: current.index, text },
    );
  };

  const splitter = ctx.thinkTagExtraction
    ? createThinkSplitter(
        (text) => appendBlock("reasoning", text),
        (text) => appendBlock("text", text),
      )
    : null;

  const startCall = (call) => {
    splitter?.flush(); // held content belongs before the call, never inside it
    heldSpace = "";
    closeCurrent();
    call.index = nextIndex++;
    const restored = ctx.names.fromUpstream(call.name);
    const toolCall = {
      id: ctx.ids.fromUpstream(call.id),
      name: restored.name,
      kind: "function",
    };
    if (restored.namespace !== undefined) toolCall.namespace = restored.namespace;
    out.push({ type: "blockStart", index: call.index, kind: "toolCall", toolCall });
    outputChars += call.name.length;
  };

  const callFragment = (call, fragment) => {
    if (fragment === "") return;
    outputChars += fragment.length;
    out.push({ type: "toolInputDelta", index: call.index, fragment });
  };

  const idKeys = new Map();
  let lastKey = 0;
  let highestKey = -1;
  /** Index-less entries (some servers) are told apart by id, else continue the last call. */
  const callKey = (entry, position) => {
    if (Number.isInteger(entry.index)) return entry.index;
    if (nonEmpty(entry.id)) {
      if (!idKeys.has(entry.id)) {
        idKeys.set(entry.id, calls.size === 0 ? position : highestKey + 1);
      }
      lastKey = idKeys.get(entry.id);
    } else if (calls.size === 0) lastKey = position;
    return lastKey;
  };

  const toolDelta = (entry, position) => {
    sawToolCalls = true;
    const key = callKey(entry, position);
    let call = calls.get(key);
    if (!call) {
      call = { id: null, name: null, index: null, pending: "" };
      calls.set(key, call);
      highestKey = Math.max(highestKey, key);
    }
    if (!call.id && nonEmpty(entry.id)) call.id = entry.id;
    if (!call.name && nonEmpty(entry.function?.name)) call.name = entry.function.name;
    const fragment = argumentsText(entry.function?.arguments);
    if (call.index === null) {
      call.pending += fragment;
      if (!call.name) return;
      call.id ??= fallbackCallId(ctx, key);
      startCall(call);
      callFragment(call, call.pending);
      call.pending = "";
    } else callFragment(call, fragment);
  };

  const content = (text) => {
    if (!nonEmpty(text)) return;
    if (splitter) splitter.push(text);
    else appendBlock("text", text);
  };

  const delta = (value) => {
    if (!isObject(value)) return;
    const reasoning = nonEmpty(value.reasoning_content)
      ? value.reasoning_content
      : value.reasoning;
    if (nonEmpty(reasoning)) appendBlock("reasoning", reasoning);
    content(value.content);
    content(value.refusal);
    if (Array.isArray(value.tool_calls)) value.tool_calls.forEach(toolDelta);
  };

  const fail = (body) => {
    out.push({ type: "error", error: classifyUpstreamError({ protocol: "chat", body }) });
    closed = true;
  };

  const finishBlocks = () => {
    splitter?.flush();
    closeCurrent();
    const open = [...calls.entries()].sort(([a], [b]) => a - b);
    for (const [key, call] of open) {
      if (call.index === null) {
        call.id ??= fallbackCallId(ctx, key);
        call.name ??= "";
        startCall(call);
        callFragment(call, call.pending);
      }
      out.push({ type: "blockStop", index: call.index });
    }
    calls.clear();
  };

  const complete = () => {
    ensureStarted(null);
    finishBlocks();
    if (!usageSeen) out.push({ type: "usage", ...estimatedUsage(ctx, outputChars) });
    // Some servers finish tool calls with "stop"; a turn with calls is a tool-use stop.
    let reason = finishReason ? stopFromChat(finishReason) : "end";
    if (reason === "end" && sawToolCalls) reason = "toolUse";
    out.push({ type: "stop", reason });
    closed = true;
  };

  const drain = () => out.splice(0);

  return {
    get closed() {
      return closed;
    },
    /** One parsed chunk (or an error envelope). */
    chunk(json) {
      if (closed) return [];
      if (!isObject(json) || (json.error !== undefined && json.error !== null)) {
        fail(json);
        return drain();
      }
      ensureStarted(json);
      const choice = Array.isArray(json.choices)
        ? (json.choices.find((entry) => (entry?.index ?? 0) === 0) ?? json.choices[0])
        : undefined;
      if (isObject(choice)) {
        delta(choice.delta ?? choice.message);
        if (nonEmpty(choice.finish_reason)) {
          finishReason = choice.finish_reason;
          finishBlocks(); // the choice is over; usage may still follow
        }
      }
      if (isObject(json.usage)) {
        usageSeen = true;
        out.push(usageEvent(json.usage));
      }
      return drain();
    },
    error(body) {
      if (!closed) fail(body);
      return drain();
    },
    /** `[DONE]`: the response is complete even without a finish reason. */
    done() {
      if (!closed) complete();
      return drain();
    },
    /** End of input: complete only when a finish reason was seen, else truncated. */
    end() {
      if (!closed && finishReason) complete();
      else if (!closed) splitter?.flush();
      if (!closed) closeCurrent();
      closed = true;
      return drain();
    },
  };
}

/** IR events for a Chat Completions SSE stream (`{ event, data }` items from sse.js). */
export async function* parseChatStream(sseEvents, ctx) {
  const state = createChatState(ctx);
  for await (const { event, data } of sseEvents) {
    if (data.trim() === "[DONE]") {
      yield* state.done();
      return;
    }
    const parsed = parseData(data);
    if (!parsed.ok) yield* state.error(data);
    else if (event === "error") yield* state.error(parsed.value);
    else yield* state.chunk(parsed.value);
    if (state.closed) return;
  }
  yield* state.end();
}

/** IR events for a non-streaming Chat Completions response body. */
export function parseChatResponse(json, ctx) {
  const state = createChatState(ctx);
  const failed = json?.error !== undefined && json?.error !== null;
  if (!isObject(json) || failed || !Array.isArray(json.choices)) {
    return state.error(json);
  }
  const choices = json.choices.map((choice) => {
    const message = isObject(choice?.message) ? choice.message : {};
    const toolCalls = Array.isArray(message.tool_calls)
      ? message.tool_calls.map((call, index) => ({ index, ...call }))
      : undefined;
    return {
      ...choice,
      delta: { ...message, tool_calls: toolCalls },
      message: undefined,
    };
  });
  return [...state.chunk({ ...json, choices }), ...state.done()];
}
