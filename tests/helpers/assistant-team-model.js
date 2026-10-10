import http from "node:http";
export async function assistantTeamModel() {
  const requests = [],
    held = [];
  let maxConcurrent = 0,
    holdChildren = false;
  const reply = (res, delta, tool = false) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const item of [
      { choices: [{ index: 0, delta, finish_reason: null }] },
      {
        choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      },
    ])
      res.write(
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture-model", ...item })}\n\n`,
      );
    res.end("data: [DONE]\n\n");
  };
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    const lastUser = body.messages.findLastIndex((m) => m.role === "user"),
      text = JSON.stringify(body.messages[lastUser]?.content || "");
    if (text.includes("TEAM_CHILD_") && !text.includes("Summarize")) {
      held.push(res);
      maxConcurrent = Math.max(maxConcurrent, held.length);
      if (held.length === 4 && !holdChildren)
        for (const response of held.splice(0))
          reply(response, { content: "A bounded member result." });
      return;
    }
    if (
      text.includes("TEAM_PARENT") &&
      lastUser > body.messages.findLastIndex((m) => m.role === "tool")
    ) {
      reply(
        res,
        {
          tool_calls: [
            {
              index: 0,
              id: "team-proposal",
              type: "function",
              function: {
                name: "agentpier_team_propose",
                arguments: JSON.stringify({
                  objective: "Review fixture project",
                  members: Array.from({ length: 4 }, (_, n) => ({
                    name: `Reviewer ${n}`,
                    role: "Review",
                    assignment: `TEAM_CHILD_${n}: review this area briefly.`,
                  })),
                }),
              },
            },
          ],
        },
        true,
      );
    } else
      reply(res, {
        content: text.includes("Summarize")
          ? "Four member reports summarized."
          : "Team proposal received.",
      });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    requests,
    holdChildren() {
      holdChildren = true;
    },
    get maxConcurrent() {
      return maxConcurrent;
    },
    resolve: () => ({
      providerId: "fixture",
      modelRef: "fixture/fixture-model",
      provider: {
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        api: "openai-completions",
        apiKey: "fixture-key",
        models: [
          { id: "fixture-model", name: "Fixture", contextWindow: 32768, maxTokens: 4096 },
        ],
      },
      release() {},
    }),
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(r);
      }),
  };
}
