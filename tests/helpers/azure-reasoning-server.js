import http from "node:http";

// A model server that answers like an Azure OpenAI v1 resource with a reasoning
// deployment (AGENTPIER-425): Chat Completions refuses function tools together with
// `reasoning_effort` and points to Responses, which accepts both. It takes its key in
// the `api-key` header only and runs one `session_status` tool loop on either API.
export const AZURE_TOOLS_REFUSAL =
  "Function tools with reasoning_effort are not supported for gpt-6.2-sol in " +
  "/v1/chat/completions. Please use /v1/responses instead.";

const sse = (res, events) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of events) res.write(event);
  res.end();
};

// Whether the last user turn still waits for its tool call.
const toolTurn = (items, isUser, isResult) =>
  items.findLastIndex(isUser) > items.findLastIndex(isResult);

function chatCompletions(res, input) {
  const useTool =
    input.tools?.some((tool) => tool.function?.name === "session_status") &&
    toolTurn(
      input.messages,
      (m) => m.role === "user",
      (m) => m.role === "tool",
    );
  const chunk = (delta, finish_reason = null) =>
    `data: ${JSON.stringify({
      id: "azure-chat",
      object: "chat.completion.chunk",
      model: input.model,
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`;
  sse(res, [
    useTool
      ? chunk({
          tool_calls: [
            {
              index: 0,
              id: "azure-status",
              type: "function",
              function: { name: "session_status", arguments: "{}" },
            },
          ],
        })
      : chunk({ content: "Azure contract complete." }),
    chunk({}, useTool ? "tool_calls" : "stop"),
    "data: [DONE]\n\n",
  ]);
}

function responses(res, input) {
  const items = Array.isArray(input.input) ? input.input : [];
  const useTool =
    input.tools?.some((tool) => tool.name === "session_status") &&
    toolTurn(
      items,
      (item) => item.role === "user",
      (item) => item.type === "function_call_output",
    );
  const id = `resp_${Date.now()}`;
  const item = useTool
    ? {
        id: "fc_azure_status",
        type: "function_call",
        call_id: "call_azure_status",
        name: "session_status",
        arguments: "{}",
        status: "completed",
      }
    : {
        id: "msg_azure",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [
          { type: "output_text", text: "Azure contract complete.", annotations: [] },
        ],
      };
  const events = [
    { type: "response.created", response: { id, status: "in_progress", output: [] } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: useTool
        ? { ...item, arguments: "", status: "in_progress" }
        : { ...item, status: "in_progress", content: [] },
    },
    useTool
      ? {
          type: "response.function_call_arguments.delta",
          output_index: 0,
          item_id: item.id,
          delta: "{}",
        }
      : {
          type: "response.output_text.delta",
          output_index: 0,
          content_index: 0,
          item_id: item.id,
          delta: "Azure contract complete.",
        },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id,
        status: "completed",
        output: [item],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
    },
  ];
  sse(
    res,
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`),
  );
}

export async function azureReasoningServer({ apiKey, deployment = "gpt-6.2-sol" }) {
  const requests = [];
  const refuse = (res, status, message, param = null) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        error: { message, type: "invalid_request_error", param, code: null },
      }),
    );
  };
  const server = http.createServer(async (req, res) => {
    // Startup may probe model discovery; the configured inventory suffices.
    if (req.method !== "POST") return refuse(res, 404, "Not found.");
    let bytes = "";
    for await (const part of req) bytes += part;
    const input = JSON.parse(bytes);
    requests.push({ url: req.url, headers: req.headers, input });
    if (req.headers["api-key"] !== apiKey)
      return refuse(res, 401, "Access denied due to invalid subscription key.");
    if (input.model !== deployment)
      return refuse(res, 404, "The API deployment for this resource does not exist.");
    if (req.url === "/openai/v1/chat/completions") {
      if (input.tools?.length && input.reasoning_effort !== undefined)
        return refuse(res, 400, AZURE_TOOLS_REFUSAL, "reasoning_effort");
      if (input.max_tokens !== undefined)
        return refuse(res, 400, "Use 'max_completion_tokens' instead.", "max_tokens");
      return chatCompletions(res, input);
    }
    if (req.url === "/openai/v1/responses") return responses(res, input);
    return refuse(res, 404, "Resource not found.");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    requests,
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}
