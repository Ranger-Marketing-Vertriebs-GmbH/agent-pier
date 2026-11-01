import http from "node:http";

// A deterministic OpenAI-compatible model for the native Hermes contracts (taken from
// the Hermes runtime spike, docs/research/hermes-runtime-spike.md), served in the test
// process on a loopback port: no account, no network. The last user message decides:
// - "RUN: <command>" asks for the `terminal` tool with that command;
// - "CALL: <tool> <json arguments>" asks for any tool with those arguments;
// - a tool result is answered "TOOL_DONE: <result>";
// - "SLOW" streams the echo one word every `slowMs`, then 40 more ticks;
// - anything else is answered "ECHO: <message>".
const text = (content) =>
  typeof content === "string"
    ? content
    : (content || []).map((part) => part?.text || "").join("");

function answer(body) {
  const messages = body.messages || [];
  const last = messages[messages.length - 1] || {};
  if (last.role === "tool")
    return { reply: `TOOL_DONE: ${text(last.content).slice(0, 80)}` };
  const said = text(last.content);
  const call = said.match(/CALL: (\S+) (.*)$/m);
  if (call)
    return {
      tool: {
        id: `call_${Date.now()}`,
        type: "function",
        function: { name: call[1], arguments: call[2] },
      },
    };
  const run = said.match(/RUN: (.*)$/m);
  if (run)
    return {
      tool: {
        id: `call_${Date.now()}`,
        type: "function",
        function: { name: "terminal", arguments: JSON.stringify({ command: run[1] }) },
      },
    };
  return { reply: `ECHO: ${said.slice(-120)}`, slow: /SLOW/.test(said) };
}

/**
 * Starts the model; resolves `{ baseUrl, requests, close() }`. Each request records
 * its `url`, `body` and `headers`; each answer reports `promptTokens` prompt tokens
 * (default 10). `rejectStreamOptions` refuses a streamed request that asks for usage
 * (`stream_options`) with a 400 naming the field, as strict endpoints do (an endpoint
 * whose Chat Completions options turn streamUsage off).
 */
export async function startFakeModel({
  slowMs = 500,
  promptTokens = 10,
  rejectStreamOptions = false,
} = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", async () => {
      if (req.url.endsWith("/models")) {
        res.setHeader("content-type", "application/json");
        return res.end(
          JSON.stringify({ object: "list", data: [{ id: "fake-1", object: "model" }] }),
        );
      }
      let body = {};
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        /* An unreadable request is answered like an empty one. */
      }
      requests.push({ url: req.url, body, headers: { ...req.headers } });
      if (rejectStreamOptions && body.stream && body.stream_options) {
        res.writeHead(400, { "content-type": "application/json" });
        return res.end(
          JSON.stringify({
            error: { message: "Unrecognized request argument: stream_options" },
          }),
        );
      }
      const { reply, tool, slow } = answer(body);
      const model = body.model || "fake-1";
      const usage = {
        prompt_tokens: promptTokens,
        completion_tokens: 5,
        total_tokens: promptTokens + 5,
      };
      if (!body.stream) {
        res.setHeader("content-type", "application/json");
        return res.end(
          JSON.stringify({
            id: "c1",
            object: "chat.completion",
            created: 1,
            model,
            choices: [
              {
                index: 0,
                finish_reason: tool ? "tool_calls" : "stop",
                message: {
                  role: "assistant",
                  content: reply ?? null,
                  tool_calls: tool && [tool],
                },
              },
            ],
            usage,
          }),
        );
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const base = { id: "c1", object: "chat.completion.chunk", created: 1, model };
      const send = (chunk) =>
        res.write(`data: ${JSON.stringify({ ...base, ...chunk })}\n\n`);
      if (tool) {
        send({
          choices: [
            {
              index: 0,
              delta: { role: "assistant", tool_calls: [{ index: 0, ...tool }] },
            },
          ],
        });
        send({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
      } else {
        const parts = slow
          ? reply.split(" ").concat(Array(40).fill(" tick"))
          : reply.match(/.{1,8}/gs) || [""];
        for (const part of parts) {
          if (res.destroyed) return;
          send({ choices: [{ index: 0, delta: { content: part } }] });
          if (slow) await new Promise((resolve) => setTimeout(resolve, slowMs));
        }
        send({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      }
      send({ choices: [], usage });
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/**
 * The model for one test: `{ url, requests }`, closed after the test. `requests`
 * records each chat call as `{ url, body }`.
 */
export async function hermesFakeModel(t, options) {
  const model = await startFakeModel(options);
  t.after(() => model.close());
  return { url: model.baseUrl, requests: model.requests };
}
