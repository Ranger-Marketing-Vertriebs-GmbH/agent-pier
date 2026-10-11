import http from "node:http";
// By default the model calls `session_status` once; `tool` names another tool (with its
// arguments) to call once instead, when that tool is offered. `tool` may also be a
// function of the request returning such a call, or null for a plain reply.
export async function assistantModelServer({
  tool = { name: "session_status", arguments: {} },
} = {}) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let bytes = "";
    for await (const part of req) bytes += part;
    const input = JSON.parse(bytes);
    requests.push(input);
    if (input.messages?.some((m) => JSON.stringify(m.content).includes("HOLD_FOR_CRASH")))
      return;
    const call = typeof tool === "function" ? tool(input) : tool;
    const useTool =
      !!call &&
      input.tools?.some((t) => t.function?.name === call.name) &&
      !input.messages.some((m) => m.role === "tool");
    res.writeHead(200, { "content-type": "text/event-stream" });
    const delta = useTool
      ? {
          tool_calls: [
            {
              index: 0,
              id: `${call.name}-call`,
              type: "function",
              function: { name: call.name, arguments: JSON.stringify(call.arguments) },
            },
          ],
        }
      : { content: "A useful assistant reply." };
    res.write(
      `data: ${JSON.stringify({ id: "fixture-chat", object: "chat.completion.chunk", model: "fixture-model", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
    );
    res.write(
      `data: ${JSON.stringify({ id: "fixture-chat", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: useTool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })}\n\n`,
    );
    res.end("data: [DONE]\n\n");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    requests,
    url: `http://127.0.0.1:${server.address().port}/v1`,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(r);
      }),
  };
}
