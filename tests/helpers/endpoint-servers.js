import http from "node:http";

export async function fakeEndpoint(t, routes) {
  const seen = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", async () => {
      const entry = {
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: body ? JSON.parse(body) : null,
      };
      seen.push(entry);
      const handler = routes[`${request.method} ${request.url.split("?")[0]}`];
      if (!handler) {
        response.writeHead(404, { "content-type": "application/json" });
        return response.end(JSON.stringify({ error: "not found" }));
      }
      const result = await handler(entry);
      if (result === "hang") return;
      response.writeHead(result.status || 200, {
        "content-type": "application/json",
        ...(result.headers || {}),
      });
      response.end(
        typeof result.raw === "string" ? result.raw : JSON.stringify(result.json ?? {}),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  return { base: `http://127.0.0.1:${server.address().port}`, seen };
}

const chat = {
  json: {
    id: "c",
    object: "chat.completion",
    choices: [
      { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
    ],
  },
};
const messages = {
  json: {
    id: "m",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
  },
};
const responses = { json: { id: "r", object: "response", output: [] } };
const known =
  (models, ok) =>
  ({ body }) =>
    models.includes(body.model)
      ? ok
      : { status: 404, json: { error: "model not found" } };

export const ollamaRoutes = (models = ["qwen3:8b", "llama3:8b"]) => ({
  "GET /v1/models": () => ({
    json: { object: "list", data: models.map((id) => ({ id, object: "model" })) },
  }),
  "GET /api/tags": () => ({
    json: { models: models.map((name) => ({ name, model: name })) },
  }),
  "POST /api/show": ({ body }) =>
    body.model === "qwen3:8b"
      ? {
          json: {
            parameters: 'temperature 0.6\nnum_ctx 40960\nstop "<|im_end|>"',
            model_info: {
              "general.architecture": "qwen3",
              "qwen3.context_length": 262144,
            },
          },
        }
      : {
          json: {
            parameters: "",
            model_info: {
              "general.architecture": "llama",
              "llama.context_length": 131072,
            },
          },
        },
  "POST /v1/messages": known(models, messages),
  "POST /v1/responses": known(models, responses),
  "POST /v1/chat/completions": known(models, chat),
});

export const llamaRoutes = ({ router = false } = {}) => ({
  "GET /v1/models": () => ({
    json: {
      data: router
        ? [{ id: "coder" }, { id: "small" }]
        : [{ id: "/models/coder-q4.gguf" }, { id: "coder" }],
    },
  }),
  "GET /props": ({ url }) => {
    const model = new URL(url, "http://x").searchParams.get("model");
    if (router && !model) return { status: 400, json: {} };
    return {
      json: { default_generation_settings: { n_ctx: model === "small" ? 8192 : 32768 } },
    };
  },
  "POST /v1/chat/completions": () => chat,
});

export const azureRoutes = (key) => ({
  "GET /openai/v1/models": ({ headers }) =>
    headers["api-key"] === key
      ? { json: { data: [{ id: "gpt-4.1" }] } }
      : { status: 401, json: {} },
  "POST /openai/v1/responses": ({ headers, body }) =>
    headers["api-key"] !== key
      ? { status: 401, json: {} }
      : body.model === "my-deploy"
        ? responses
        : { status: 404, json: { error: { code: "DeploymentNotFound" } } },
  "POST /openai/v1/chat/completions": ({ headers, body }) =>
    headers["api-key"] !== key
      ? { status: 401, json: {} }
      : body.model === "my-deploy"
        ? { status: 400, json: { error: "use max_completion_tokens" } }
        : { status: 404, json: {} },
});
