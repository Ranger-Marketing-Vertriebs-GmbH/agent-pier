// Shared setup for the translator direction tests (tests/integration/protocol-adapter-*).

import { createTranslator } from "../../server/features/protocol-adapter/translate.js";
import { collect, fromChunks, loadFixture } from "./protocol-adapter.js";

export const REQ = Object.freeze({ requestId: "req_test" });
export const SECRET = "sk-upstream-secret-0123456789abcdef";
export const MODEL = Object.freeze({
  modelId: "upstream-model",
  contextTokens: 131072,
  outputTokens: null,
  images: true,
});
export const DIRECTIONS = Object.freeze([
  { client: "messages", upstream: "responses" },
  { client: "messages", upstream: "chat" },
  { client: "responses", upstream: "messages" },
  { client: "responses", upstream: "chat" },
]);
export const CLIENT_DIRS = Object.freeze({
  messages: "clients/claude-code",
  responses: "clients/codex",
});

export function translator(client, upstream, overrides = {}) {
  return createTranslator({
    client,
    upstream,
    model: MODEL,
    capabilities: {},
    thinkTagExtraction: false,
    sessionKey: "session-1",
    secrets: [SECRET],
    ...overrides,
  });
}

/** Deterministic PRNG (mulberry32) so random chunk splits are reproducible per seed. */
export function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Splits text at random boundaries (1–40 characters per chunk). */
export function randomSplit(text, seed) {
  const next = random(seed);
  const chunks = [];
  let offset = 0;
  while (offset < text.length) {
    const size = 1 + Math.floor(next() * 40);
    chunks.push(text.slice(offset, offset + size));
    offset += size;
  }
  return chunks;
}

/** Client request body of a recorded fixture. */
export const clientBody = (path) => structuredClone(loadFixture(path).body);
export const clientHeaders = (path) => structuredClone(loadFixture(path).headers);

/** Builds a request and translates an upstream SSE text through its exchange. */
export async function roundTrip(
  instance,
  body,
  upstreamText,
  { seed = 1, headers, requestId = "req_test" } = {},
) {
  const built = instance.buildUpstream(body, headers ?? {}, {
    requestId,
    now: 1791331200000,
  });
  if (!built.ok) throw new Error(`build failed: ${JSON.stringify(built.error.body)}`);
  const chunks = seed === 0 ? [upstreamText] : randomSplit(upstreamText, seed);
  const frames = await collect(built.exchange.translateStream(fromChunks(chunks)));
  return { built, text: frames.join("") };
}

// --- synthetic upstream streams --------------------------------------------------------

const event = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
const data = (payload) => `data: ${JSON.stringify(payload)}\n\n`;

/** Messages stream: thinking (signed) then one tool_use. */
export function messagesThinkingToolStream({ thinking, signature, id, name, input }) {
  const json = JSON.stringify(input);
  return [
    event("message_start", {
      type: "message_start",
      message: {
        id: "msg_up_1",
        type: "message",
        role: "assistant",
        model: "claude-up",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    }),
    event("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "", signature: "" },
    }),
    event("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking },
    }),
    event("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature },
    }),
    event("content_block_stop", { type: "content_block_stop", index: 0 }),
    event("content_block_start", {
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id, name, input: {} },
    }),
    event("content_block_delta", {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: json },
    }),
    event("content_block_stop", { type: "content_block_stop", index: 1 }),
    event("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 20 },
    }),
    event("message_stop", { type: "message_stop" }),
  ].join("");
}

const chunk = (delta, finish = null) =>
  data({
    id: "chatcmpl-up",
    object: "chat.completion.chunk",
    model: "chat-up",
    choices: [{ index: 0, delta, finish_reason: finish }],
  });

/** Chat stream: optional reasoning_content, then one tool call with whole arguments. */
export function chatToolStream({ reasoning, id, name, args }) {
  return [
    chunk({ role: "assistant", content: null }),
    ...(reasoning ? [chunk({ reasoning_content: reasoning })] : []),
    chunk({
      tool_calls: [
        { index: 0, id, type: "function", function: { name, arguments: args } },
      ],
    }),
    chunk({}, "tool_calls"),
    "data: [DONE]\n\n",
  ].join("");
}

/** Responses stream: one reasoning item (summary + encrypted_content), one tool call. */
export function responsesReasoningToolStream({ summary, encrypted, call }) {
  const shell = { id: "resp_up", object: "response", model: "gpt-up", output: [] };
  const reasoning = {
    type: "reasoning",
    id: "rs_up",
    summary: [{ type: "summary_text", text: summary }],
    encrypted_content: encrypted,
  };
  const tool = { type: "function_call", id: "fc_up", status: "completed", ...call };
  let sequence = 0;
  const ev = (type, payload) =>
    event(type, { type, sequence_number: sequence++, ...payload });
  return [
    ev("response.created", { response: { ...shell, status: "in_progress" } }),
    ev("response.output_item.added", {
      output_index: 0,
      item: { ...reasoning, summary: [], encrypted_content: null },
    }),
    ev("response.reasoning_summary_text.delta", {
      item_id: "rs_up",
      output_index: 0,
      summary_index: 0,
      delta: summary,
    }),
    ev("response.output_item.done", { output_index: 0, item: reasoning }),
    ev("response.output_item.added", {
      output_index: 1,
      item: { ...tool, status: "in_progress", arguments: "" },
    }),
    ev("response.function_call_arguments.delta", {
      item_id: "fc_up",
      output_index: 1,
      delta: call.arguments,
    }),
    ev("response.output_item.done", { output_index: 1, item: tool }),
    ev("response.completed", {
      response: {
        ...shell,
        status: "completed",
        output: [reasoning, tool],
        usage: {
          input_tokens: 50,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 20,
          output_tokens_details: { reasoning_tokens: 10 },
          total_tokens: 70,
        },
      },
    }),
  ].join("");
}
