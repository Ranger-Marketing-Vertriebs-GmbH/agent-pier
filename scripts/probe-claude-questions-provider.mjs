import http from "node:http";

export const questions = [
  {
    header: "Components",
    question: "Which components should be included?",
    options: [
      { label: "API", description: "Include the service." },
      { label: "Web", description: "Include the interface." },
      { label: "CLI", description: "Include the terminal." },
    ],
    multiSelect: true,
  },
  {
    header: "Destination",
    question: "Where should the result be saved?",
    options: [
      { label: "Local", description: "Save locally." },
      { label: "Remote", description: "Save remotely." },
    ],
    multiSelect: false,
  },
];

/** A credential-free provider that only emits AskUserQuestion, never executable tools. */
export async function createQuestionProvider() {
  const results = [];
  let occurrence = 0;
  const server = http.createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    if (request.url.includes("count_tokens")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"input_tokens":10}');
      return;
    }
    const last = body.messages?.at(-1);
    const result = Array.isArray(last?.content)
      ? last.content.find((part) => part.type === "tool_result")
      : null;
    const prompt =
      typeof last?.content === "string"
        ? last.content
        : last?.content?.map((part) => part.text || "").join(" ");
    const asking = !result && prompt?.includes("AP_QUESTION_PROBE");
    if (result) results.push(result);
    response.writeHead(200, { "content-type": "text/event-stream" });
    const emit = (type, data = {}) =>
      response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    emit("message_start", {
      message: {
        id: `msg_probe_${occurrence}`,
        type: "message",
        role: "assistant",
        content: [],
        model: "claude-sonnet-4-6",
        stop_reason: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    });
    emit("content_block_start", {
      index: 0,
      content_block: asking
        ? {
            type: "tool_use",
            id: `question_${++occurrence}`,
            name: "AskUserQuestion",
            input: {},
          }
        : { type: "text", text: "" },
    });
    emit("content_block_delta", {
      index: 0,
      delta: asking
        ? { type: "input_json_delta", partial_json: JSON.stringify({ questions }) }
        : { type: "text_delta", text: "Question probe complete." },
    });
    emit("content_block_stop", { index: 0 });
    emit("message_delta", {
      delta: { stop_reason: asking ? "tool_use" : "end_turn", stop_sequence: null },
      usage: { output_tokens: 5 },
    });
    emit("message_stop");
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    results,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  };
}
