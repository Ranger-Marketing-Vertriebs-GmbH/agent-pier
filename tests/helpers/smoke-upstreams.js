import { scriptedUpstream, sse, json } from "./scripted-upstream.js";

/** Text the smoke file holds; turn 2 expects it in the tool result. */
export const SMOKE_FILE_CONTENT = "SMOKE-FILE-CONTENT";
export const SMOKE_ANSWER = "SMOKE-OK";
export const TITLE = "TITLE";
const ENCRYPTED = "gAAAAABsmokeEncryptedReasoningContent0123456789==";
const SIGNATURE = "EqQBCkYIBxgCKkBsmokeSignature0123456789abcdefghijklmnop==";
const REASONING = "Read the smoke file first.";

const frames = (events) =>
  events
    .map(([event, data]) =>
      event ? `event: ${event}\ndata: ${JSON.stringify(data)}\n\n` : `data: ${data}\n\n`,
    )
    .join("");

// --- Responses (shapes of upstreams/responses/{text,reasoning-summary,function-calls}.sse)
const response = (status, output = [], usage) => ({
  id: "resp_smoke",
  object: "response",
  created_at: 1791331200,
  model: "qwen3",
  status,
  output,
  ...(usage ? { usage } : {}),
});
const responsesUsage = {
  input_tokens: 40,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens: 12,
  output_tokens_details: { reasoning_tokens: 4 },
  total_tokens: 52,
};
function responsesStream(items) {
  let n = 0;
  const ev = (type, data) => [type, { type, sequence_number: n++, ...data }];
  const done = [];
  const events = [
    ev("response.created", { response: response("in_progress") }),
    ev("response.in_progress", { response: response("in_progress") }),
  ];
  items.forEach((item, output_index) => {
    const at = { output_index };
    if (item.type === "reasoning") {
      const summary = { type: "summary_text", text: item.text };
      const base = { type: "reasoning", id: "rs_smoke", encrypted_content: ENCRYPTED };
      const part = { item_id: "rs_smoke", ...at, summary_index: 0 };
      events.push(
        ev("response.output_item.added", { ...at, item: { ...base, summary: [] } }),
        ev("response.reasoning_summary_part.added", {
          ...part,
          part: { type: "summary_text", text: "" },
        }),
        ev("response.reasoning_summary_text.delta", { ...part, delta: item.text }),
        ev("response.reasoning_summary_text.done", { ...part, text: item.text }),
        ev("response.reasoning_summary_part.done", { ...part, part: summary }),
      );
      done.push({ ...base, summary: [summary] });
    } else if (item.type === "function_call") {
      const base = { type: "function_call", id: "fc_smoke", call_id: "call_smoke" };
      const full = {
        ...base,
        status: "completed",
        name: item.name,
        arguments: item.args,
      };
      const ref = { item_id: "fc_smoke", ...at };
      events.push(
        ev("response.output_item.added", {
          ...at,
          item: { ...base, status: "in_progress", name: item.name, arguments: "" },
        }),
        ...(item.args
          ? [ev("response.function_call_arguments.delta", { ...ref, delta: item.args })]
          : []),
        ev("response.function_call_arguments.done", { ...ref, arguments: item.args }),
      );
      done.push(full);
    } else {
      const base = { type: "message", id: "msg_smoke", role: "assistant" };
      const text = { type: "output_text", text: item.text, annotations: [] };
      const ref = { item_id: "msg_smoke", ...at, content_index: 0 };
      events.push(
        ev("response.output_item.added", {
          ...at,
          item: { ...base, status: "in_progress", content: [] },
        }),
        ev("response.content_part.added", { ...ref, part: { ...text, text: "" } }),
        ev("response.output_text.delta", { ...ref, delta: item.text }),
        ev("response.output_text.done", { ...ref, text: item.text }),
        ev("response.content_part.done", { ...ref, part: text }),
      );
      done.push({ ...base, status: "completed", content: [text] });
    }
    events.push(ev("response.output_item.done", { ...at, item: done.at(-1) }));
  });
  events.push(
    ev("response.completed", { response: response("completed", done, responsesUsage) }),
  );
  return frames(events);
}

// --- Chat (shapes of upstreams/chat/{text,reasoning-content,parallel-tool-calls}.sse)
function chatStream(deltas, finish) {
  const chunk = (delta, finish_reason = null) => [
    null,
    JSON.stringify({
      id: "chatcmpl-smoke",
      object: "chat.completion.chunk",
      created: 1791331200,
      model: "qwen3",
      choices: [{ index: 0, delta, logprobs: null, finish_reason }],
    }),
  ];
  return frames([
    chunk({ role: "assistant", content: null }),
    ...deltas.map((d) => chunk(d)),
    chunk({}, finish),
    [null, "[DONE]"],
  ]);
}

// --- Messages (shapes of upstreams/messages/{text,thinking-text,parallel-tool-use}.sse)
function messagesStream(blocks, stopReason) {
  const events = [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: "msg_smoke",
          type: "message",
          role: "assistant",
          model: "qwen3",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 25, output_tokens: 1 },
        },
      },
    ],
  ];
  const delta = (index, d) => [
    "content_block_delta",
    { type: "content_block_delta", index, delta: d },
  ];
  blocks.forEach((block, index) => {
    const start = (content_block) => [
      "content_block_start",
      { type: "content_block_start", index, content_block },
    ];
    if (block.type === "thinking")
      events.push(
        start({ type: "thinking", thinking: "", signature: "" }),
        delta(index, { type: "thinking_delta", thinking: block.text }),
        delta(index, { type: "signature_delta", signature: SIGNATURE }),
      );
    else if (block.type === "tool_use")
      events.push(
        start({ type: "tool_use", id: "toolu_smoke", name: block.name, input: {} }),
        ...(block.args
          ? [delta(index, { type: "input_json_delta", partial_json: block.args })]
          : []),
      );
    else
      events.push(
        start({ type: "text", text: "" }),
        delta(index, { type: "text_delta", text: block.text }),
      );
    events.push(["content_block_stop", { type: "content_block_stop", index }]);
  });
  events.push(
    [
      "message_delta",
      {
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: 30 },
      },
    ],
    ["message_stop", { type: "message_stop" }],
  );
  return frames(events);
}

const STREAMS = {
  responses: {
    text: (text) => responsesStream([{ type: "message", text }]),
    call: (name, args) =>
      responsesStream([
        { type: "reasoning", text: REASONING },
        { type: "function_call", name, args },
      ]),
  },
  chatCompletions: {
    text: (text) => chatStream([{ content: text }], "stop"),
    call: (name, args) =>
      chatStream(
        [
          { reasoning_content: REASONING },
          {
            tool_calls: [
              {
                index: 0,
                id: "call_smoke",
                type: "function",
                function: { name, arguments: "" },
              },
            ],
          },
          // An empty argument text sends no argument delta at all (fact R6).
          ...(args
            ? [{ tool_calls: [{ index: 0, function: { arguments: args } }] }]
            : []),
        ],
        "tool_calls",
      ),
  },
  messages: {
    text: (text) => messagesStream([{ type: "text", text }], "end_turn"),
    call: (name, args) =>
      messagesStream(
        [
          { type: "thinking", text: REASONING },
          { type: "tool_use", name, args },
        ],
        "tool_use",
      ),
  },
};

const toolNames = (tools) => tools.map((tool) => tool.function?.name ?? tool.name);

/** Tool results, assistant carrier replay and history of one translated request. */
function inspect(protocol, body) {
  if (protocol === "responses") {
    const input = Array.isArray(body.input) ? body.input : [];
    return {
      results: input.filter((i) => i.type === "function_call_output"),
      carrier: input.some(
        (i) => i.type === "reasoning" && i.encrypted_content === ENCRYPTED,
      ),
    };
  }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (protocol === "chatCompletions")
    return {
      results: messages.filter((m) => m.role === "tool"),
      carrier: messages.some((m) => m.role === "assistant" && m.reasoning_content),
    };
  const blocks = messages.flatMap((m) =>
    Array.isArray(m.content) ? m.content.map((b) => ({ ...b, role: m.role })) : [],
  );
  return {
    results: blocks.filter((b) => b.type === "tool_result"),
    carrier: blocks.some(
      (b) => b.role === "assistant" && b.type === "thinking" && b.signature === SIGNATURE,
    ),
  };
}

/**
 * Scripted upstream for one smoke direction. Requests without tools (OpenCode's title
 * generator, Claude Code side requests) get a plain streamed `TITLE` and are not turns.
 * The first tool-bearing request without a tool result gets a streamed reasoning carrier
 * plus a call to `toolName` with `toolInput`; a request with the tool result gets
 * `SMOKE-OK` when the result matches `expectResult`. Every mismatch answers 500 with a
 * `smoke:` message, recorded in `problems`, so the CLI and the test both fail loudly.
 */
export async function smokeUpstream(
  t,
  protocol,
  { toolName, toolInput, expectResult = SMOKE_FILE_CONTENT },
) {
  const stream = STREAMS[protocol];
  if (!stream) throw new TypeError(`smokeUpstream: unknown protocol ${protocol}`);
  const args = Object.keys(toolInput).length ? JSON.stringify(toolInput) : "";
  const state = {
    turns: 0,
    calls: 0,
    problems: [],
    carrier: null,
    results: [],
    schema: null,
  };
  const fail = (response, message) => {
    state.problems.push(message);
    json(response, 500, { error: { type: "server_error", message } });
  };
  const up = await scriptedUpstream(t, (entry, response) => {
    const body = entry.body && typeof entry.body === "object" ? entry.body : {};
    const tools = Array.isArray(body.tools) ? body.tools : [];
    if (!tools.length) return sse(response, stream.text(TITLE));
    state.turns += 1;
    const names = toolNames(tools);
    entry.toolNames = names;
    const { results, carrier } = inspect(protocol, body);
    if (!results.length) {
      if (state.calls > 0)
        return fail(response, `smoke: turn ${state.turns} carries no tool result`);
      if (!names.includes(toolName))
        return fail(
          response,
          `smoke: the CLI offers no tool named ${toolName} (offered: ${names.join(", ")})`,
        );
      state.calls += 1;
      const offered = tools[names.indexOf(toolName)];
      state.schema =
        offered.function?.parameters ?? offered.parameters ?? offered.input_schema;
      return sse(response, stream.call(toolName, args));
    }
    const text = JSON.stringify(results);
    state.results.push(text);
    state.carrier = carrier;
    if (expectResult && !text.includes(expectResult))
      return fail(response, `smoke: the tool result lacks ${expectResult}: ${text}`);
    return sse(response, stream.text(SMOKE_ANSWER));
  });
  return {
    base: up.base,
    seen: up.seen,
    turns: () => state.turns,
    problems: state.problems,
    results: state.results,
    /** Whether turn 2 replayed turn 1's reasoning carrier (null before turn 2). */
    carrier: () => state.carrier,
    /** JSON schema of `toolName` as the CLI offered it in turn 1. */
    schema: () => state.schema,
  };
}
