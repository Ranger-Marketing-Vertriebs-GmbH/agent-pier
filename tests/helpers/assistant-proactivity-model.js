import http from "node:http";

/**
 * An OpenAI-compatible model double for the proactivity contracts. It answers with
 * `model.reply`; while `model.searchQuery` is set, a turn that offers memory_search
 * first searches for it, exercising the native recall tool loop.
 */
export async function proactivityModel() {
  const requests = [];
  const model = { requests, reply: "A useful assistant reply.", searchQuery: null };
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(
        JSON.stringify({
          object: "list",
          data: [{ id: "fixture-model", object: "model" }],
        }),
      );
    }
    let bytes = "";
    for await (const part of req) bytes += part;
    const input = JSON.parse(bytes || "{}");
    requests.push(input);
    const search =
      model.searchQuery &&
      input.tools?.some((tool) => tool.function?.name === "memory_search") &&
      input.messages.findLastIndex((m) => m.role === "user") >
        input.messages.findLastIndex((m) => m.role === "tool");
    res.writeHead(200, { "content-type": "text/event-stream" });
    const emit = (delta, finish_reason = null) =>
      res.write(
        `data: ${JSON.stringify({
          id: "proactivity-contract",
          object: "chat.completion.chunk",
          model: input.model,
          choices: [{ index: 0, delta, finish_reason }],
        })}\n\n`,
      );
    if (search)
      emit({
        tool_calls: [
          {
            index: 0,
            id: `memory-search-${requests.length}`,
            type: "function",
            function: {
              name: "memory_search",
              arguments: JSON.stringify({ query: model.searchQuery, maxResults: 12 }),
            },
          },
        ],
      });
    else emit({ content: model.reply });
    emit({}, search ? "tool_calls" : "stop");
    res.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return Object.assign(model, {
    url: `http://127.0.0.1:${server.address().port}/v1`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  });
}

/** The provider lease AssistantConfig resolves for every fixture agent. */
export const fixtureModels = (model) => ({
  resolve: () => ({
    providerId: "fixture",
    modelRef: "fixture/fixture-model",
    provider: {
      baseUrl: model.url,
      api: "openai-completions",
      apiKey: "fixture-key",
      models: [
        { id: "fixture-model", name: "Fixture", contextWindow: 32768, maxTokens: 4096 },
      ],
    },
    release() {},
  }),
});
