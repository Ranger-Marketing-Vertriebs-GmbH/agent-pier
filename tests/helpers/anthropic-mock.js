import http from "node:http";

/**
 * A local stand-in for the Anthropic Messages API, enough for Claude Code to run
 * turns without an account. A prompt containing SLOW streams its reply over
 * `slowMs` per word; one containing BGRUN asks for a background Bash command, and
 * one containing PLANEXIT plans like Claude does in plan mode: it writes `plan` to the
 * plan file that plan mode's reminder names, then calls ExitPlanMode without
 * arguments. `requests` keeps every streamed request body for the test to read.
 */
const planFile = (messages) =>
  JSON.stringify(messages).match(/create your plan at ([^\s"\\]+\.md)/)?.[1];

function toolCall(request, plan) {
  const messages = request.messages ?? [];
  const last = JSON.stringify(messages.at(-1) || "");
  const answered = last.includes("tool_result");
  if (last.includes("BGRUN") && !answered)
    return {
      name: "Bash",
      input: {
        command: "sleep 4",
        description: "Sleep in background",
        run_in_background: true,
      },
    };
  if (!JSON.stringify(messages).includes("PLANEXIT")) return null;
  if (last.includes("PLANEXIT") && !answered) {
    const file = planFile(messages);
    return file
      ? { name: "Write", input: { file_path: file, content: plan } }
      : { name: "ExitPlanMode", input: { plan } };
  }
  const exited = messages.some(
    (entry) =>
      Array.isArray(entry.content) &&
      entry.content.some(
        (block) => block.type === "tool_use" && block.name === "ExitPlanMode",
      ),
  );
  return answered && !exited ? { name: "ExitPlanMode", input: {} } : null;
}

export async function anthropicMock({
  slowMs = 4000,
  plan = "# Plan\n\n1. Write the file",
} = {}) {
  const requests = [];
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
    requests.push(request);
    const slow = JSON.stringify(request.messages?.at(-1) || "").includes("SLOW");
    send("message_start", { message });
    const call = toolCall(request, plan);
    if (call) {
      send("content_block_start", {
        index: 0,
        content_block: {
          type: "tool_use",
          id: `toolu_${Date.now()}`,
          name: call.name,
          input: {},
        },
      });
      send("content_block_delta", {
        index: 0,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input) },
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
      if (slow) await new Promise((resolve) => setTimeout(resolve, slowMs));
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
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}
