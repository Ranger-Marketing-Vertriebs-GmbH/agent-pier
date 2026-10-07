// Canned upstream answers for capture-cli-requests.mjs: just enough of each protocol to
// drive Claude Code and Codex through one tool round trip.

const PATCH = "*** Begin Patch\n*** Add File: hello.txt\n+hello\n*** End Patch\n";

const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

function hasMessagesToolResult(body) {
  return (body.messages ?? []).some(
    (message) =>
      Array.isArray(message.content) &&
      message.content.some((block) => block.type === "tool_result"),
  );
}

function messagesTool(plan, tools) {
  if (plan === "mcp") return tools.find((tool) => tool.name?.startsWith("mcp__"));
  return tools.find((tool) => tool.name === "Bash");
}

export function messagesStream(body, plan) {
  const tool =
    plan !== "text" && body.tools?.length && !hasMessagesToolResult(body)
      ? messagesTool(plan, body.tools)
      : undefined;
  const usage = { input_tokens: 12, output_tokens: 1 };
  const parts = [
    sse("message_start", {
      type: "message_start",
      message: {
        id: "msg_fixture_1",
        type: "message",
        role: "assistant",
        model: body.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage,
      },
    }),
  ];
  const input = tool?.name === "Bash" ? { command: "ls", description: "List files" } : {};
  if (tool && plan === "mcp") input.topic = "adapters";
  const block = tool
    ? { type: "tool_use", id: "toolu_fixture_1", name: tool.name, input: {} }
    : { type: "text", text: "" };
  parts.push(
    sse("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: block,
    }),
  );
  const delta = tool
    ? { type: "input_json_delta", partial_json: JSON.stringify(input) }
    : { type: "text_delta", text: "Fixture answer." };
  parts.push(
    sse("content_block_delta", { type: "content_block_delta", index: 0, delta }),
  );
  parts.push(sse("content_block_stop", { type: "content_block_stop", index: 0 }));
  parts.push(
    sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null },
      usage: { output_tokens: 8 },
    }),
  );
  parts.push(sse("message_stop", { type: "message_stop" }));
  return parts.join("");
}

function hasResponsesToolOutput(body) {
  return (body.input ?? []).some((item) =>
    ["function_call_output", "custom_tool_call_output"].includes(item.type),
  );
}

function responsesCall(plan, tools) {
  if (plan === "custom") {
    return {
      type: "custom_tool_call",
      id: "ctc_fixture_1",
      status: "completed",
      call_id: "call_fixture_patch",
      name: "apply_patch",
      input: PATCH,
    };
  }
  const call = {
    type: "function_call",
    id: "fc_fixture_1",
    status: "completed",
    call_id: "call_fixture_1",
    name: "exec_command",
    arguments: JSON.stringify({ cmd: "ls" }),
  };
  if (plan !== "mcp") return call;
  const namespace = tools.find(
    (tool) => tool.type === "namespace" && tool.name.includes("fixture"),
  );
  if (!namespace) return call;
  return {
    ...call,
    name: namespace.tools[0].name,
    namespace: namespace.name,
    arguments: JSON.stringify({ topic: "adapters" }),
  };
}

function responsesItemEvents(item, index) {
  const events = [];
  const added =
    item.type === "message"
      ? { ...item, status: "in_progress", content: [] }
      : item.type === "reasoning"
        ? { ...item, summary: [] }
        : item.type === "function_call"
          ? { ...item, status: "in_progress", arguments: "" }
          : { ...item, status: "in_progress", input: "" };
  const base = { item_id: item.id, output_index: index };
  events.push(["response.output_item.added", { output_index: index, item: added }]);
  if (item.type === "message") {
    events.push([
      "response.output_text.delta",
      { ...base, content_index: 0, delta: item.content[0].text },
    ]);
  } else if (item.type === "reasoning") {
    events.push([
      "response.reasoning_summary_part.added",
      { ...base, summary_index: 0, part: { type: "summary_text", text: "" } },
    ]);
    events.push([
      "response.reasoning_summary_text.delta",
      { ...base, summary_index: 0, delta: item.summary[0].text },
    ]);
    events.push([
      "response.reasoning_summary_text.done",
      { ...base, summary_index: 0, text: item.summary[0].text },
    ]);
  } else if (item.type === "function_call") {
    events.push([
      "response.function_call_arguments.delta",
      { ...base, delta: item.arguments },
    ]);
  } else {
    events.push([
      "response.custom_tool_call_input.delta",
      { ...base, call_id: item.call_id, delta: item.input },
    ]);
  }
  events.push(["response.output_item.done", { output_index: index, item }]);
  return events;
}

export function responsesStream(body, plan, { reasoning = false } = {}) {
  const id = "resp_fixture_1";
  const output = [];
  if (reasoning) {
    output.push({
      type: "reasoning",
      id: "rs_fixture_1",
      summary: [{ type: "summary_text", text: "Plan the answer." }],
      encrypted_content: "fixture-encrypted-reasoning",
    });
  }
  if (plan !== "text" && body.tools?.length && !hasResponsesToolOutput(body)) {
    output.push(responsesCall(plan, body.tools));
  } else {
    output.push({
      type: "message",
      id: "msg_fixture_1",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "Fixture answer.", annotations: [] }],
    });
  }
  const response = {
    id,
    object: "response",
    model: body.model,
    status: "in_progress",
    output: [],
  };
  const events = [["response.created", { response }]];
  output.forEach((item, index) => events.push(...responsesItemEvents(item, index)));
  const usage = {
    input_tokens: 20,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 5,
    output_tokens_details: { reasoning_tokens: reasoning ? 3 : 0 },
    total_tokens: 25,
  };
  events.push([
    "response.completed",
    { response: { ...response, status: "completed", output, usage } },
  ]);
  return events
    .map(([type, data], sequence) =>
      sse(type, { type, sequence_number: sequence, ...data }),
    )
    .join("");
}
