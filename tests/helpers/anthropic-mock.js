import http from "node:http";

/**
 * A local stand-in for the Anthropic Messages API, enough for Claude Code to run
 * turns without an account. A prompt containing SLOW streams its reply over
 * `slowMs` per word; one containing BGRUN asks for a background Bash command.
 */
export async function anthropicMock({ slowMs = 4000 } = {}) {
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    if (!req.url.startsWith("/v1/messages")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end("{}");
    }
    if (req.url.includes("count_tokens")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ input_tokens: 10 }));
    }
    let request = {};
    try {
      request = JSON.parse(body);
    } catch {}
    const message = {
      id: "msg_mock",
      type: "message",
      role: "assistant",
      model: request.model || "claude-sonnet-4-5",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0 },
    };
    const text = "Hello from the mock.";
    if (!request.stream) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(
        JSON.stringify({
          ...message,
          content: [{ type: "text", text }],
          stop_reason: "end_turn",
        }),
      );
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (event, data) =>
      res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
    const last = JSON.stringify(request.messages?.at(-1) || "");
    send("message_start", { message });
    if (last.includes("BGRUN") && !last.includes("tool_result")) {
      send("content_block_start", {
        index: 0,
        content_block: {
          type: "tool_use",
          id: `toolu_${Date.now()}`,
          name: "Bash",
          input: {},
        },
      });
      send("content_block_delta", {
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify({
            command: "sleep 4",
            description: "Sleep in background",
            run_in_background: true,
          }),
        },
      });
      send("content_block_stop", { index: 0 });
      send("message_delta", {
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 5 },
      });
      send("message_stop", {});
      return res.end();
    }
    send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    for (const word of text.split(" ")) {
      if (last.includes("SLOW"))
        await new Promise((resolve) => setTimeout(resolve, slowMs));
      if (res.destroyed) return;
      send("content_block_delta", {
        index: 0,
        delta: { type: "text_delta", text: `${word} ` },
      });
    }
    send("content_block_stop", { index: 0 });
    send("message_delta", {
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 5 },
    });
    send("message_stop", {});
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}
