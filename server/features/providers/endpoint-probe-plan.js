const trim = (url) => String(url || "").replace(/\/+$/, "");

/** Base request per protocol of the connection test (shared with the capability probe). */
export function probes(endpoint, model) {
  const ask = [{ role: "user", content: "ok" }];
  return {
    messages: endpoint.anthropicBaseUrl && {
      url: `${trim(endpoint.anthropicBaseUrl)}/v1/messages`,
      body: { model, max_tokens: 1, messages: ask },
      headers: { "anthropic-version": "2023-06-01" },
    },
    responses: {
      url: `${trim(endpoint.openaiBaseUrl)}/responses`,
      body: { model, input: "ok", max_output_tokens: 16 },
    },
    chatCompletions: {
      url: `${trim(endpoint.openaiBaseUrl)}/chat/completions`,
      body: { model, max_tokens: 1, messages: ask },
    },
  };
}
