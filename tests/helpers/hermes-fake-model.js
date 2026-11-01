import http from "node:http";

const text = (content) =>
  typeof content === "string"
    ? content
    : (content || []).map((part) => part.text || "").join("");

/**
 * A deterministic OpenAI-compatible model on loopback for native Hermes contracts:
 * `/v1/models` lists `fake-1`, and every chat completion (streamed or not) answers
 * `ECHO: <last user text>`. No credentials; `requests` records each call's path.
 */
export async function hermesFakeModel(t) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requests.push(req.url);
      if (req.url.endsWith("/models")) {
        res.setHeader("content-type", "application/json");
        return res.end(
          JSON.stringify({ object: "list", data: [{ id: "fake-1", object: "model" }] }),
        );
      }
      let request = {};
      try {
        request = JSON.parse(body || "{}");
      } catch {
        /* An empty answer below. */
      }
      const users = (request.messages || []).filter((message) => message.role === "user");
      const reply = `ECHO: ${text(users.at(-1)?.content).slice(-120)}`;
      const base = { id: "c1", created: 1, model: request.model || "fake-1" };
      const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
      if (!request.stream) {
        res.setHeader("content-type", "application/json");
        return res.end(
          JSON.stringify({
            ...base,
            object: "chat.completion",
            choices: [
              {
                index: 0,
                finish_reason: "stop",
                message: { role: "assistant", content: reply },
              },
            ],
            usage,
          }),
        );
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (chunk) =>
        res.write(
          `data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", ...chunk })}\n\n`,
        );
      send({ choices: [{ index: 0, delta: { role: "assistant", content: reply } }] });
      send({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      send({ choices: [], usage });
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}/v1`, requests };
}
