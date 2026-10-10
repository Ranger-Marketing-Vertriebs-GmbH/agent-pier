import http from "node:http";
export async function assistantRoutineModel() {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    if (req.method === "GET") {
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
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const [delta, finish_reason] of [
      [{ content: "A useful assistant reply." }, null],
      [{}, "stop"],
    ]) {
      res.write(
        `data: ${JSON.stringify({ id: "routine-fixture", object: "chat.completion.chunk", model: "fixture-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
      );
    }
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
