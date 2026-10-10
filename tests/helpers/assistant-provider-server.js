import http from "node:http";
export async function assistantProviderServer() {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    // Startup may probe model discovery; explicit configured inventory suffices.
    if (req.method !== "POST") {
      res.writeHead(404);
      res.end();
      return;
    }
    let bytes = "";
    for await (const part of req) bytes += part;
    const input = JSON.parse(bytes);
    requests.push({ url: req.url, headers: req.headers, input });
    const useTool =
      input.tools?.some((tool) => tool.function?.name === "session_status") &&
      input.messages.findLastIndex((message) => message.role === "user") >
        input.messages.findLastIndex((message) => message.role === "tool");
    res.writeHead(200, { "content-type": "text/event-stream" });
    const emit = (delta, finish_reason = null) =>
      res.write(
        `data: ${JSON.stringify({
          id: "provider-contract",
          object: "chat.completion.chunk",
          model: input.model,
          choices: [{ index: 0, delta, finish_reason }],
        })}\n\n`,
      );
    if (useTool) {
      emit({
        tool_calls: [
          {
            index: 0,
            id: "provider-status",
            type: "function",
            function: { name: "session_status", arguments: "{" },
          },
        ],
      });
      emit({ tool_calls: [{ index: 0, function: { arguments: "}" } }] });
    } else {
      emit({ content: "Provider " });
      emit({ content: "contract complete." });
    }
    emit({}, useTool ? "tool_calls" : "stop");
    res.end("data: [DONE]\n\n");
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
