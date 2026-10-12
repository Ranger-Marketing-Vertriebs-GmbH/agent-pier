import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";

/**
 * An OpenAI-compatible model double for the proactivity contracts. `model.reply`
 * is the answer, or a function of the request returning `{ text, delayMs }` or
 * `{ tool: { name, arguments } }`, so a turn can be told apart (a check-in, a slow
 * owner turn), held open or made to call a tool.
 */
export async function proactivityModel() {
  const requests = [];
  const model = { requests, reply: "A useful assistant reply." };
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
    const answer =
      typeof model.reply === "function" ? model.reply(input) : { text: model.reply };
    if (answer.delayMs) await delay(answer.delayMs);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const call = answer.tool && {
      tool_calls: [
        {
          index: 0,
          id: `call-${requests.length}`,
          type: "function",
          function: {
            name: answer.tool.name,
            arguments: JSON.stringify(answer.tool.arguments),
          },
        },
      ],
    };
    for (const [delta, finish_reason] of [
      [call || { content: answer.text }, null],
      [{}, call ? "tool_calls" : "stop"],
    ])
      res.write(
        `data: ${JSON.stringify({
          id: "proactivity-contract",
          object: "chat.completion.chunk",
          model: input.model,
          choices: [{ index: 0, delta, finish_reason }],
        })}\n\n`,
      );
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
