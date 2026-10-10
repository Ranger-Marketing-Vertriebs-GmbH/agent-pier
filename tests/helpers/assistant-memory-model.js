import http from "node:http";

// Exercise the native tool loop, not a model's ability to choose or recall facts.
export async function assistantMemoryModel() {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(404);
      return res.end();
    }
    let bytes = "";
    for await (const part of req) bytes += part;
    const input = JSON.parse(bytes);
    requests.push(input);
    const useTool =
      input.tools?.some((tool) => tool.function?.name === "memory_search") &&
      input.messages.findLastIndex((m) => m.role === "user") >
        input.messages.findLastIndex((m) => m.role === "tool");
    res.writeHead(200, { "content-type": "text/event-stream" });
    const emit = (delta, finish_reason = null) =>
      res.write(
        `data: ${JSON.stringify({
          id: "memory-contract",
          object: "chat.completion.chunk",
          model: input.model,
          choices: [{ index: 0, delta, finish_reason }],
        })}\n\n`,
      );
    if (useTool)
      emit({
        tool_calls: [
          {
            index: 0,
            id: "memory-search-contract",
            type: "function",
            function: {
              name: "memory_search",
              arguments: JSON.stringify({ query: "quartz", maxResults: 12 }),
            },
          },
        ],
      });
    else emit({ content: "Memory check complete." });
    emit({}, useTool ? "tool_calls" : "stop");
    res.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    requests,
    url: `http://127.0.0.1:${server.address().port}/v1`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}
